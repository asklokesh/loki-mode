"""Purple Lab - Standalone product backend for Loki Mode.

A Replit-like web UI where users input PRDs and watch agents work.
Separate from the dashboard (which monitors existing sessions).
Purple Lab IS the product -- it starts and manages loki sessions.

Runs on port 57375 (dashboard uses 57374).
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, Optional

try:
    import pexpect
    HAS_PEXPECT = True
except ImportError:
    HAS_PEXPECT = False

import logging
import threading

from datetime import datetime
from fastapi import Body, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
import shlex

from pydantic import BaseModel, field_validator

logger = logging.getLogger("purple-lab")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HOST = os.environ.get("PURPLE_LAB_HOST", "127.0.0.1")
PORT = int(os.environ.get("PURPLE_LAB_PORT", "57375"))
MAX_WS_CLIENTS = int(os.environ.get("PURPLE_LAB_MAX_WS_CLIENTS", "50"))
MAX_TERMINAL_PTYS = int(os.environ.get("PURPLE_LAB_MAX_TERMINALS", "20"))

# Resolve paths
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
LOKI_CLI = PROJECT_ROOT / "autonomy" / "loki"
DIST_DIR = SCRIPT_DIR / "dist"

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application startup and shutdown lifecycle."""
    # -- Startup --
    try:
        from models import init_db
        db_url = os.environ.get("DATABASE_URL")
        if db_url:
            await init_db(db_url)
            logger.info("Database initialized")
        else:
            logger.info("No DATABASE_URL set -- running in local mode (no auth, file-based storage)")
    except ImportError:
        logger.info("Database models not available -- running in local mode")
    except Exception as exc:
        logger.warning("Database initialization failed: %s -- falling back to local mode", exc)

    yield

    # -- Shutdown --
    # Stop all file watchers
    file_watcher.stop_all()

    # Stop all dev servers
    await dev_server_manager.stop_all()

    # Clean up all terminal PTYs
    for _sid, _pty in list(_terminal_ptys.items()):
        try:
            if _pty.isalive():
                _pty.close(force=True)
        except Exception:
            pass
    _terminal_ptys.clear()
    _terminal_ws_clients.clear()


app = FastAPI(title="Purple Lab", docs_url=None, redoc_url=None, lifespan=lifespan)

_default_cors_origins = [
    f"http://127.0.0.1:{PORT}",
    f"http://localhost:{PORT}",
]
_cors_env = os.environ.get("PURPLE_LAB_CORS_ORIGINS", "")
_cors_origins = (
    [o.strip() for o in _cors_env.split(",") if o.strip()]
    if _cors_env
    else _default_cors_origins
)

if "*" in _cors_origins:
    logger.warning("CORS wildcard '*' detected -- restricting to localhost for security")
    _cors_origins = _default_cors_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With", "Accept"],
)

# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------


class SessionState:
    """Tracks the active loki session."""

    def __init__(self) -> None:
        self.process: Optional[subprocess.Popen] = None
        self.running = False
        self.paused = False
        self.provider = ""
        self.prd_text = ""
        self.project_dir = ""
        self.start_time: float = 0
        self.log_lines: list[str] = []
        self.log_lines_total: int = 0  # absolute count of all lines ever appended
        self.ws_clients: set[WebSocket] = set()
        self._reader_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    async def cleanup(self) -> None:
        """Cancel reader task and close process pipes."""
        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()
            try:
                await asyncio.wait_for(self._reader_task, timeout=3)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass
        self._reader_task = None

        if self.process:
            try:
                if self.process.stdout:
                    self.process.stdout.close()
            except Exception:
                pass

    def reset(self) -> None:
        self.process = None
        self.running = False
        self.paused = False
        self.provider = ""
        self.prd_text = ""
        self.project_dir = ""
        self.start_time = 0
        self.log_lines = []
        self.log_lines_total = 0


def _kill_tracked_child_processes() -> None:
    """Kill all tracked child processes and their process groups."""
    tracked = _get_tracked_child_pids()
    if not tracked:
        return

    # SIGTERM to process groups first
    for pid in tracked:
        try:
            pgid = os.getpgid(pid)
            os.killpg(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                os.kill(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                pass

    # Wait briefly for graceful shutdown
    time.sleep(2)

    # SIGKILL anything still running
    for pid in tracked:
        try:
            os.kill(pid, 0)  # Check if still alive
            try:
                pgid = os.getpgid(pid)
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass  # Already dead

    _clear_tracked_pids()


session = SessionState()

# Terminal PTY instances keyed by session_id
_terminal_ptys: Dict[str, "pexpect.spawn"] = {}

# Track PIDs of sessions started by Purple Lab (not by external loki CLI)
_PURPLE_LAB_PIDS_FILE = SCRIPT_DIR.parent / ".loki" / "purple-lab" / "child-pids.json"


def _track_child_pid(pid: int) -> None:
    """Record a PID started by Purple Lab so loki web stop can clean it up.

    Uses fcntl.flock for atomic read-modify-write to prevent race conditions.
    """
    import fcntl
    _PURPLE_LAB_PIDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(_PURPLE_LAB_PIDS_FILE), os.O_RDWR | os.O_CREAT)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        f = os.fdopen(fd, "r+")
        try:
            content = f.read()
            pids = json.loads(content) if content.strip() else []
        except (json.JSONDecodeError, ValueError):
            pids = []
        if pid not in pids:
            pids.append(pid)
        f.seek(0)
        f.truncate()
        f.write(json.dumps(pids))
        f.flush()
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    else:
        f.close()  # also releases lock and closes fd


def _untrack_child_pid(pid: int) -> None:
    """Remove a PID from tracking after it exits.

    Uses fcntl.flock for atomic read-modify-write.
    """
    import fcntl
    if not _PURPLE_LAB_PIDS_FILE.exists():
        return
    try:
        fd = os.open(str(_PURPLE_LAB_PIDS_FILE), os.O_RDWR)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX)
            f = os.fdopen(fd, "r+")
            try:
                content = f.read()
                pids = json.loads(content) if content.strip() else []
            except (json.JSONDecodeError, ValueError):
                pids = []
            pids = [p for p in pids if p != pid]
            f.seek(0)
            f.truncate()
            f.write(json.dumps(pids))
            f.flush()
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            raise
        else:
            f.close()
    except (json.JSONDecodeError, OSError):
        pass


def _get_tracked_child_pids() -> list[int]:
    """Get all PIDs started by Purple Lab."""
    if not _PURPLE_LAB_PIDS_FILE.exists():
        return []
    try:
        return json.loads(_PURPLE_LAB_PIDS_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return []


def _clear_tracked_pids() -> None:
    """Clear all tracked PIDs."""
    try:
        _PURPLE_LAB_PIDS_FILE.unlink(missing_ok=True)
    except OSError:
        pass

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class StartRequest(BaseModel):
    prd: str
    provider: str = "claude"
    projectDir: Optional[str] = None
    mode: Optional[str] = None  # "quick" for quick mode


class QuickStartRequest(BaseModel):
    prompt: str
    provider: str = "claude"


class StopResponse(BaseModel):
    stopped: bool
    message: str


_MAX_PRD_BYTES = 1_048_576  # 1 MB


class PlanRequest(BaseModel):
    prd: str
    provider: str = "claude"


class ReportRequest(BaseModel):
    format: str = "markdown"  # "html" | "markdown"


class ProviderSetRequest(BaseModel):
    provider: str


class OnboardRequest(BaseModel):
    path: str


class FileWriteRequest(BaseModel):
    path: str
    content: str = ""


class DirectoryCreateRequest(BaseModel):
    path: str


class FileDeleteRequest(BaseModel):
    path: str


class ChatRequest(BaseModel):
    message: str
    mode: str = "quick"  # "quick" or "standard"


class SecretRequest(BaseModel):
    key: str
    value: str


class DevServerStartRequest(BaseModel):
    command: Optional[str] = None

    @field_validator("command")
    @classmethod
    def validate_command(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        dangerous = set(';|`$(){}<>\n\r')
        if any(c in dangerous for c in v):
            raise ValueError("Command contains disallowed shell characters")
        return v.strip()


# ---------------------------------------------------------------------------
# File Watcher (watchdog-based, broadcasts changes via WebSocket)
# ---------------------------------------------------------------------------

try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler, FileSystemEvent
    HAS_WATCHDOG = True
except ImportError:
    HAS_WATCHDOG = False
    Observer = None  # type: ignore[misc,assignment]
    FileSystemEventHandler = object  # type: ignore[misc,assignment]

# Patterns to ignore when watching for file changes
_WATCH_IGNORE_DIRS = {".loki", "node_modules", ".git", "__pycache__", ".next", ".nuxt", "dist", "build", ".cache"}
_WATCH_IGNORE_EXTENSIONS = {".pyc", ".pyo", ".swp", ".swo", ".swn", ".tmp", ".DS_Store"}


class FileChangeHandler(FileSystemEventHandler):  # type: ignore[misc]
    """Collects file system events and broadcasts them after a debounce window."""

    def __init__(self, project_dir: str, broadcast_fn, loop: asyncio.AbstractEventLoop):
        super().__init__()
        self.project_dir = project_dir
        self.broadcast_fn = broadcast_fn
        self.loop = loop
        self._lock = threading.Lock()
        self._pending: list[dict] = []
        self._debounce_handle: Optional[asyncio.TimerHandle] = None

    def _should_ignore(self, path: str) -> bool:
        """Return True if this path should be ignored."""
        parts = Path(path).parts
        for part in parts:
            if part in _WATCH_IGNORE_DIRS:
                return True
        name = os.path.basename(path)
        if name in _WATCH_IGNORE_EXTENSIONS:
            return True
        _, ext = os.path.splitext(name)
        if ext in _WATCH_IGNORE_EXTENSIONS:
            return True
        return False

    def on_any_event(self, event) -> None:  # type: ignore[override]
        if event.is_directory and event.event_type not in ("created", "deleted", "moved"):
            return
        src = getattr(event, "src_path", "")
        if not src or self._should_ignore(src):
            return

        with self._lock:
            self._pending.append({
                "path": src,
                "event_type": event.event_type,
            })

        # Schedule debounced broadcast on the asyncio event loop
        try:
            self.loop.call_soon_threadsafe(self._schedule_broadcast)
        except RuntimeError:
            pass  # loop closed

    def _schedule_broadcast(self) -> None:
        """Schedule the broadcast after 200ms of quiet."""
        if self._debounce_handle is not None:
            self._debounce_handle.cancel()
        self._debounce_handle = self.loop.call_later(0.2, self._fire_broadcast)

    def _fire_broadcast(self) -> None:
        """Collect pending changes and broadcast them."""
        with self._lock:
            changes = self._pending[:]
            self._pending.clear()
        self._debounce_handle = None

        if not changes:
            return

        # Deduplicate by path, keeping the last event type
        seen: dict[str, str] = {}
        for c in changes:
            seen[c["path"]] = c["event_type"]

        raw_paths = list(seen.keys())
        event_types = [seen[p] for p in raw_paths]

        # Strip project dir prefix to get relative paths for the frontend
        prefix = self.project_dir.rstrip("/") + "/"
        paths = [p[len(prefix):] if p.startswith(prefix) else p for p in raw_paths]

        asyncio.ensure_future(self.broadcast_fn({
            "type": "file_changed",
            "data": {"paths": paths, "event_types": event_types},
        }))


class FileWatcher:
    """Manages watchdog observers for project directories."""

    def __init__(self) -> None:
        self._observers: Dict[str, "Observer"] = {}  # type: ignore[type-arg]

    def start(self, key: str, project_dir: str, broadcast_fn, loop: asyncio.AbstractEventLoop) -> bool:
        """Start watching a project directory. Returns True if started."""
        if not HAS_WATCHDOG:
            logger.info("watchdog not installed -- file watcher disabled")
            return False

        if key in self._observers:
            self.stop(key)

        if not os.path.isdir(project_dir):
            return False

        handler = FileChangeHandler(project_dir, broadcast_fn, loop)
        observer = Observer()
        observer.schedule(handler, project_dir, recursive=True)
        observer.daemon = True
        observer.start()
        self._observers[key] = observer
        logger.info("File watcher started for %s", project_dir)
        return True

    def stop(self, key: str) -> None:
        """Stop watching."""
        observer = self._observers.pop(key, None)
        if observer is not None:
            observer.stop()
            observer.join(timeout=3)
            logger.info("File watcher stopped for key=%s", key)

    def stop_all(self) -> None:
        """Stop all watchers."""
        for key in list(self._observers):
            self.stop(key)


file_watcher = FileWatcher()


# ---------------------------------------------------------------------------
# Dev Server Manager
# ---------------------------------------------------------------------------


class DevServerManager:
    """Manages dev server processes per session."""

    _PORT_PATTERNS = [
        # Vite: "  Local:   http://localhost:5173/"
        re.compile(r"Local:\s+https?://localhost:(\d+)"),
        # Next.js: "  - Local: http://localhost:3000"
        re.compile(r"-\s+Local:\s+https?://localhost:(\d+)"),
        # Django: "Starting development server at http://127.0.0.1:8000/"
        re.compile(r"server\s+at\s+https?://127\.0\.0\.1:(\d+)", re.IGNORECASE),
        # Flask: " * Running on http://127.0.0.1:5000"
        re.compile(r"Running\s+on\s+https?://127\.0\.0\.1:(\d+)"),
        # Go: "Listening on :8080"
        re.compile(r"(?:listening|serving)\s+on\s+:(\d+)", re.IGNORECASE),
        # Spring Boot/Tomcat: "Tomcat started on port(s): 8080"
        re.compile(r"Tomcat\s+started\s+on\s+port\(s\):\s*(\d+)", re.IGNORECASE),
        # Rails: "Listening on http://0.0.0.0:3000"
        re.compile(r"Listening\s+on\s+https?://0\.0\.0\.0:(\d+)", re.IGNORECASE),
        # Laravel: "Server running on [http://127.0.0.1:8000]"
        re.compile(r"Server\s+running\s+on\s+\[https?://127\.0\.0\.1:(\d+)\]", re.IGNORECASE),
        # Phoenix: "Running MyApp.Endpoint with Bandit at http://localhost:4000"
        re.compile(r"Running\s+\S+\.Endpoint\s+.*?https?://localhost:(\d+)", re.IGNORECASE),
        # Generic "listening on port 3000" or "on port 3000"
        re.compile(r"listening\s+on\s+(?:port\s+)?(\d+)", re.IGNORECASE),
        re.compile(r"on\s+port\s+(\d+)", re.IGNORECASE),
        # "listening on port 3000" / "running on port 3000" / "started on port 3000" / "serving on port 3000"
        re.compile(r"(?:listening|running|started|serving)\s+(?:on\s+)?port\s+(\d+)", re.IGNORECASE),
        # Vite ready message: "ready in 300ms -- http://localhost:5173/"
        re.compile(r"ready\s+in\s+\d+m?s.*localhost:(\d+)"),
        # Generic URL patterns (last resort -- broad matches)
        re.compile(r"https?://0\.0\.0\.0:(\d+)"),
        re.compile(r"https?://127\.0\.0\.1:(\d+)"),
        re.compile(r"https?://localhost:(\d+)"),
    ]

    def __init__(self) -> None:
        self.servers: Dict[str, dict] = {}
        self._portless_available: Optional[bool] = None
        self._portless_proxy_started = False

    def _has_portless(self) -> bool:
        """Check if portless CLI is installed (cached)."""
        if self._portless_available is None:
            try:
                subprocess.run(
                    ["portless", "--version"],
                    capture_output=True, timeout=5,
                )
                self._portless_available = True
            except (FileNotFoundError, subprocess.TimeoutExpired):
                self._portless_available = False
        return self._portless_available

    def _portless_app_name(self, session_id: str) -> str:
        """Generate a deterministic short app name from session_id."""
        clean = re.sub(r"[^a-zA-Z0-9]", "", session_id)
        return f"lab-{clean[:6].lower()}"

    async def _ensure_portless_proxy(self) -> bool:
        """Start the portless proxy if not already running.

        Returns True if the proxy is available, False otherwise.
        """
        if self._portless_proxy_started:
            return True
        # Check if port 1355 is already listening
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(1)
        try:
            s.connect(("127.0.0.1", 1355))
            s.close()
            self._portless_proxy_started = True
            return True
        except (ConnectionRefusedError, OSError):
            s.close()
        # Try to start the proxy
        try:
            subprocess.Popen(
                ["portless", "proxy", "start"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
            )
            # Give it a moment to start (async to avoid blocking the event loop)
            await asyncio.sleep(1)
            self._portless_proxy_started = True
            return True
        except (FileNotFoundError, OSError):
            return False

    async def detect_dev_command(self, project_dir: str) -> Optional[dict]:
        """Detect the dev command from project files."""
        root = Path(project_dir)
        if not root.is_dir():
            return None

        # Docker Compose is the preferred way to run projects (isolated, no port conflicts)
        for compose_file in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
            if (root / compose_file).exists():
                # Check that Docker is actually available
                try:
                    subprocess.run(["docker", "--version"], capture_output=True, timeout=5)
                except (FileNotFoundError, subprocess.TimeoutExpired):
                    break  # Docker not installed -- fall through to other detection
                # Parse compose file to detect exposed port and enumerate services
                port = 3000  # default
                services_info: list = []
                try:
                    import yaml
                    with open(root / compose_file) as f:
                        compose = yaml.safe_load(f)
                    if compose and "services" in compose:
                        for svc_name, svc in compose["services"].items():
                            svc_ports: list = []
                            for p in svc.get("ports", []):
                                p_str = str(p)
                                if ":" in p_str:
                                    parts = p_str.split(":")
                                    try:
                                        host_port = int(parts[-2].split("-")[0])
                                        svc_ports.append(host_port)
                                    except (ValueError, IndexError):
                                        continue
                            services_info.append({
                                "name": svc_name,
                                "ports": svc_ports,
                                "image": svc.get("image"),
                                "has_build": "build" in svc,
                            })
                        # Use smart resolution to pick the user-facing service
                        _primary_name, port = self._resolve_primary_service(services_info)
                        if _primary_name is None:
                            # Fallback: first service with any port
                            for svc_entry in services_info:
                                if svc_entry["ports"]:
                                    port = svc_entry["ports"][0]
                                    break
                except ImportError:
                    # yaml not available -- fall back to regex parsing
                    try:
                        content = (root / compose_file).read_text()
                        port_match = re.search(r'"?(\d+):(\d+)"?', content)
                        if port_match:
                            port = int(port_match.group(1))
                        # Extract service names via regex
                        for m in re.finditer(r'^  (\w[\w-]*):\s*$', content, re.MULTILINE):
                            services_info.append({"name": m.group(1), "ports": []})
                    except Exception:
                        pass
                except Exception:
                    pass
                result_dict: dict = {
                    "command": f"docker compose -f {compose_file} up --build",
                    "expected_port": port,
                    "framework": "docker",
                }
                if services_info:
                    result_dict["services"] = services_info
                return result_dict

        # -- Full-stack project detection (frontend + backend in subdirectories) --
        frontend_dir_names = ["frontend", "client", "web", "app", "ui", "web-app", "webapp"]
        backend_dir_names = ["backend", "server", "api", "service"]

        frontend_dir: Optional[Path] = None
        backend_dir: Optional[Path] = None

        for d in frontend_dir_names:
            candidate = root / d
            if candidate.is_dir():
                # Verify it is actually a frontend (has package.json or index.html)
                if (candidate / "package.json").exists() or (candidate / "index.html").exists():
                    frontend_dir = candidate
                    break

        for d in backend_dir_names:
            candidate = root / d
            if candidate.is_dir():
                has_py = any(candidate.glob("*.py"))
                has_pkg = (candidate / "package.json").exists()
                has_go = (candidate / "go.mod").exists()
                has_requirements = (candidate / "requirements.txt").exists()
                has_cargo = (candidate / "Cargo.toml").exists()
                if has_py or has_pkg or has_go or has_requirements or has_cargo:
                    backend_dir = candidate
                    break

        if frontend_dir and backend_dir:
            # Detect frontend framework and command
            fe_cmd = "npm run dev"
            fe_port = 3000
            fe_framework = "node"
            fe_pkg = frontend_dir / "package.json"
            if fe_pkg.exists():
                try:
                    pkg = json.loads(fe_pkg.read_text(errors="replace"))
                    fe_scripts = pkg.get("scripts", {})
                    fe_deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
                    if "next" in fe_deps:
                        fe_framework = "next"
                        fe_port = 3000
                        fe_cmd = "npm run dev"
                    elif "vite" in fe_deps:
                        fe_framework = "vite"
                        fe_port = 5173
                        fe_cmd = "npm run dev"
                    elif "dev" in fe_scripts:
                        fe_cmd = "npm run dev"
                    elif "start" in fe_scripts:
                        fe_cmd = "npm start"
                except Exception:
                    pass
            elif (frontend_dir / "index.html").exists():
                fe_framework = "static"
                fe_cmd = "python3 -m http.server 3000"
                fe_port = 3000

            # Detect backend framework and command
            be_cmd: Optional[str] = None
            be_port = 8000
            be_framework = "unknown"

            if (backend_dir / "manage.py").exists():
                be_cmd = "python manage.py runserver"
                be_port = 8000
                be_framework = "django"
            else:
                for py_entry in ("app.py", "main.py", "server.py"):
                    py_file = backend_dir / py_entry
                    if py_file.exists():
                        try:
                            src = py_file.read_text(errors="replace")[:4096]
                            if "fastapi" in src.lower() or "FastAPI" in src:
                                module = py_entry[:-3]
                                be_cmd = f"uvicorn {module}:app --reload --port 8000"
                                be_port = 8000
                                be_framework = "fastapi"
                                break
                            if "flask" in src.lower() or "Flask" in src:
                                be_cmd = "flask run --port 5000"
                                be_port = 5000
                                be_framework = "flask"
                                break
                        except OSError:
                            pass
                if be_cmd is None and (backend_dir / "package.json").exists():
                    try:
                        be_pkg = json.loads((backend_dir / "package.json").read_text(errors="replace"))
                        be_scripts = be_pkg.get("scripts", {})
                        be_deps = {**be_pkg.get("dependencies", {}), **be_pkg.get("devDependencies", {})}
                        if "express" in be_deps:
                            be_framework = "express"
                        else:
                            be_framework = "node"
                        be_port = 3001
                        if "dev" in be_scripts:
                            be_cmd = "npm run dev"
                        elif "start" in be_scripts:
                            be_cmd = "npm start"
                    except Exception:
                        pass
                if be_cmd is None and (backend_dir / "go.mod").exists():
                    be_cmd = "go run ."
                    be_port = 8080
                    be_framework = "go"
                if be_cmd is None and (backend_dir / "requirements.txt").exists():
                    # Generic Python backend with requirements.txt
                    for py_entry in ("app.py", "main.py", "server.py", "run.py"):
                        if (backend_dir / py_entry).exists():
                            be_cmd = f"python {py_entry}"
                            be_port = 8000
                            be_framework = "python"
                            break

            if be_cmd:
                return {
                    "framework": "full-stack",
                    "command": f"cd {backend_dir.name} && {be_cmd}",
                    "frontend_command": f"cd {frontend_dir.name} && {fe_cmd}",
                    "expected_port": fe_port,
                    "backend_port": be_port,
                    "multi_service": True,
                    "frontend_dir": str(frontend_dir),
                    "backend_dir": str(backend_dir),
                    "frontend_framework": fe_framework,
                    "backend_framework": be_framework,
                }

        pkg_json = root / "package.json"
        if pkg_json.exists():
            try:
                pkg = json.loads(pkg_json.read_text())
                scripts = pkg.get("scripts", {})
                deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
                # Check for Expo/React Native
                if "expo" in deps:
                    return {"command": "npx expo start", "expected_port": 8081, "framework": "expo"}
                if "dev" in scripts:
                    # Check Next.js BEFORE Vite -- Next.js projects may also have vite as a dep
                    if "next" in deps:
                        fw = "next"
                        port = 3000
                    elif "vite" in deps:
                        fw = "vite"
                        port = 5173
                    else:
                        fw = "node"
                        port = 3000
                    return {"command": "npm run dev", "expected_port": port, "framework": fw}
                if "start" in scripts:
                    fw = "next" if "next" in deps else "react" if "react" in deps else "node"
                    return {"command": "npm start", "expected_port": 3000, "framework": fw}
                if "serve" in scripts:
                    return {"command": "npm run serve", "expected_port": 3000, "framework": "node"}
            except (json.JSONDecodeError, OSError):
                pass

        makefile = root / "Makefile"
        if makefile.exists():
            try:
                content = makefile.read_text()
                for target in ("dev", "run", "serve"):
                    if re.search(rf"^{target}\s*:", content, re.MULTILINE):
                        return {"command": f"make {target}", "expected_port": 8000, "framework": "make"}
            except OSError:
                pass

        if (root / "manage.py").exists():
            return {"command": "python manage.py runserver", "expected_port": 8000, "framework": "django"}

        for py_entry in ("app.py", "main.py", "server.py"):
            py_file = root / py_entry
            if py_file.exists():
                try:
                    with open(py_file, "r", errors="replace") as f:
                        src = f.read(4096)
                    if "fastapi" in src.lower() or "FastAPI" in src:
                        module = py_entry[:-3]
                        return {"command": f"uvicorn {module}:app --reload --port 8000",
                                "expected_port": 8000, "framework": "fastapi"}
                    if "flask" in src.lower() or "Flask" in src:
                        return {"command": "flask run --port 5000",
                                "expected_port": 5000, "framework": "flask"}
                except OSError:
                    pass

        if (root / "go.mod").exists():
            return {"command": "go run .", "expected_port": 8080, "framework": "go"}
        if (root / "Cargo.toml").exists():
            return {"command": "cargo run", "expected_port": 8080, "framework": "rust"}

        # Java/Spring Boot -- Maven
        if (root / "pom.xml").exists():
            if (root / "mvnw").exists():
                return {"command": "./mvnw spring-boot:run", "expected_port": 8080, "framework": "spring"}
            return {"command": "mvn spring-boot:run", "expected_port": 8080, "framework": "spring"}

        # Java/Spring Boot -- Gradle
        if (root / "build.gradle").exists() or (root / "build.gradle.kts").exists():
            if (root / "gradlew").exists():
                return {"command": "./gradlew bootRun", "expected_port": 8080, "framework": "spring"}
            return {"command": "gradle bootRun", "expected_port": 8080, "framework": "spring"}

        # Ruby on Rails
        if (root / "Gemfile").exists() and (root / "config" / "routes.rb").exists():
            return {"command": "bundle exec rails server", "expected_port": 3000, "framework": "rails"}

        # PHP/Laravel
        if (root / "artisan").exists():
            return {"command": "php artisan serve", "expected_port": 8000, "framework": "laravel"}

        # Elixir/Phoenix
        if (root / "mix.exs").exists() and (root / "lib").is_dir():
            return {"command": "mix phx.server", "expected_port": 4000, "framework": "phoenix"}

        # Swift/Vapor
        if (root / "Package.swift").exists():
            return {"command": "swift run", "expected_port": 8080, "framework": "swift"}

        # Static HTML (no framework -- serve with Python)
        if (root / "index.html").exists():
            return {"command": "python3 -m http.server 8000", "expected_port": 8000, "framework": "static"}

        return None

    def _parse_port(self, output: str) -> Optional[int]:
        """Parse port from dev server stdout."""
        for pattern in self._PORT_PATTERNS:
            m = pattern.search(output)
            if m:
                port = int(m.group(1))
                if 1024 <= port <= 65535:
                    return port
        return None

    def _resolve_primary_service(self, services_info: list[dict]) -> tuple[Optional[str], int]:
        """Determine the primary user-facing service from Docker Compose services."""
        frontend_names = {"frontend", "web", "client", "app", "ui", "next", "vite", "nginx"}
        frontend_ports = {3000, 5173, 8080, 4200, 5000, 4000}

        # Priority 1: Service name matches frontend patterns
        for svc in services_info:
            if svc["name"].lower() in frontend_names and svc.get("ports"):
                return svc["name"], svc["ports"][0]

        # Priority 2: Service has a frontend-typical port
        for svc in services_info:
            for p in svc.get("ports", []):
                if p in frontend_ports:
                    return svc["name"], p

        # Priority 3: Custom-built service (has build, no standard image like postgres/redis)
        infra_images = {"postgres", "redis", "mongo", "mysql", "rabbitmq", "memcached", "elasticsearch"}
        for svc in services_info:
            img = (svc.get("image") or "").split(":")[0].split("/")[-1].lower()
            if svc.get("has_build") and img not in infra_images and svc.get("ports"):
                return svc["name"], svc["ports"][0]

        # Fallback: first service with any port
        for svc in services_info:
            if svc.get("ports"):
                return svc["name"], svc["ports"][0]

        return None, 3000

    def _install_pip_deps(self, project_path: Path, build_env: dict) -> None:
        """Install pip dependencies into a project venv (creates one if needed)."""
        if not (project_path / "requirements.txt").exists():
            return
        venv_dir = None
        for venv_name in ("venv", ".venv", "env"):
            candidate = project_path / venv_name
            if candidate.is_dir() and (candidate / "bin" / "pip").exists():
                venv_dir = candidate
                break
        if venv_dir is None:
            try:
                subprocess.run(
                    [sys.executable, "-m", "venv", str(project_path / "venv")],
                    capture_output=True, timeout=60,
                )
                venv_dir = project_path / "venv"
            except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
                logger.warning("venv creation failed: %s", exc)
        pip_executable = str(venv_dir / "bin" / "pip") if venv_dir else "pip"
        try:
            subprocess.run(
                [pip_executable, "install", "-r", "requirements.txt"],
                cwd=str(project_path),
                capture_output=True,
                timeout=120,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
            logger.warning("pip install failed: %s", exc)

    async def start(self, session_id: str, project_dir: str, command: Optional[str] = None) -> dict:
        """Start dev server. Auto-detect command if not provided."""
        if session_id in self.servers:
            await self.stop(session_id)

        # Try to detect dev command -- check root first, then subdirectories
        detected = await self.detect_dev_command(project_dir)
        actual_dir = project_dir
        if not detected:
            # Check immediate subdirectories for a project with package.json
            root = Path(project_dir)
            if root.is_dir():
                for subdir in sorted(root.iterdir()):
                    if subdir.is_dir() and not subdir.name.startswith('.'):
                        sub_detected = await self.detect_dev_command(str(subdir))
                        if sub_detected:
                            detected = sub_detected
                            actual_dir = str(subdir)
                            break
        if not command and not detected:
            return {"status": "error", "message": "No dev command detected. Provide one explicitly."}

        cmd_str = command or (detected["command"] if detected else "")
        expected_port = detected["expected_port"] if detected else 3000
        framework = detected["framework"] if detected else "unknown"
        is_multi_service = detected.get("multi_service", False) if detected else False

        build_env = {**os.environ}
        build_env.update(_load_secrets())

        # -- Multi-service full-stack startup --
        if is_multi_service and not command:
            be_dir = detected.get("backend_dir", actual_dir)
            fe_dir = detected.get("frontend_dir", actual_dir)
            be_cmd_str = detected.get("command", "")
            fe_cmd_str = detected.get("frontend_command", "")
            be_port = detected.get("backend_port", 8000)
            fe_port = detected.get("expected_port", 3000)

            # Install deps in both directories
            for svc_dir_str in (be_dir, fe_dir):
                svc_path = Path(svc_dir_str)
                if (svc_path / "package.json").exists() and not (svc_path / "node_modules").exists():
                    try:
                        subprocess.run(["npm", "install"], cwd=svc_dir_str, capture_output=True, timeout=120, env=build_env)
                    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
                        logger.warning("npm install failed in %s: %s", svc_dir_str, exc)
                if (svc_path / "requirements.txt").exists():
                    self._install_pip_deps(svc_path, build_env)

            popen_kwargs = (
                {"start_new_session": True} if sys.platform != "win32"
                else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
            )

            # Start backend process (uses shell=True because command contains 'cd ...')
            try:
                be_proc = subprocess.Popen(
                    be_cmd_str, shell=True,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                    text=True, cwd=actual_dir, env=build_env, **popen_kwargs,
                )
            except Exception as e:
                return {"status": "error", "message": f"Failed to start backend: {e}"}
            _track_child_pid(be_proc.pid)

            # Start frontend process
            try:
                fe_proc = subprocess.Popen(
                    fe_cmd_str, shell=True,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                    text=True, cwd=actual_dir, env=build_env, **popen_kwargs,
                )
            except Exception as e:
                # Kill backend if frontend fails to start
                try:
                    be_proc.terminate()
                except (ProcessLookupError, PermissionError, OSError):
                    pass
                _untrack_child_pid(be_proc.pid)
                return {"status": "error", "message": f"Failed to start frontend: {e}"}
            _track_child_pid(fe_proc.pid)

            server_info: dict = {
                "process": fe_proc,  # Primary process is frontend (user-facing)
                "backend_process": be_proc,
                "port": None,
                "expected_port": fe_port,
                "backend_port": be_port,
                "command": fe_cmd_str,
                "original_command": cmd_str,
                "framework": framework,
                "status": "starting",
                "pid": fe_proc.pid,
                "backend_pid": be_proc.pid,
                "project_dir": project_dir,
                "output_lines": [],
                "backend_output_lines": [],
                "multi_service": True,
                "frontend_framework": detected.get("frontend_framework", "unknown"),
                "backend_framework": detected.get("backend_framework", "unknown"),
                "frontend_dir": fe_dir,
                "backend_dir": be_dir,
                "use_portless": False,
                "portless_app_name": None,
            }
            self.servers[session_id] = server_info

            asyncio.create_task(self._monitor_output(session_id))
            asyncio.create_task(self._monitor_backend_output(session_id))
            asyncio.create_task(self._continuous_log_monitor(session_id))

            # Wait for either frontend or backend port (up to 30s)
            for _ in range(60):
                await asyncio.sleep(0.5)
                info = self.servers.get(session_id)
                if not info:
                    return {"status": "error", "message": "Server entry disappeared"}
                if info["status"] == "error":
                    return {
                        "status": "error",
                        "message": "Dev server crashed",
                        "output": info["output_lines"][-10:] if info["output_lines"] else [],
                    }
                if info["port"] is not None:
                    health_ok = await self._health_check(info["port"])
                    if health_ok:
                        info["status"] = "running"
                        services = [
                            {
                                "name": "frontend",
                                "framework": info.get("frontend_framework", "unknown"),
                                "port": fe_port,
                                "status": "running",
                            },
                            {
                                "name": "backend",
                                "framework": info.get("backend_framework", "unknown"),
                                "port": be_port,
                                "status": "running" if be_proc.poll() is None else "error",
                            },
                        ]
                        return {
                            "status": "running",
                            "port": info["port"],
                            "command": fe_cmd_str,
                            "pid": fe_proc.pid,
                            "url": f"/proxy/{session_id}/",
                            "multi_service": True,
                            "framework": "full-stack",
                            "services": services,
                        }

            # Timeout -- report whatever state we have
            if fe_proc.poll() is not None and be_proc.poll() is not None:
                server_info["status"] = "error"
                return {
                    "status": "error",
                    "message": "Both frontend and backend exited before port was detected",
                    "output": server_info["output_lines"][-10:],
                }

            # Fallback to expected port
            health_ok = await self._health_check(fe_port)
            if health_ok:
                server_info["port"] = fe_port
                server_info["status"] = "running"
                return {
                    "status": "running",
                    "port": fe_port,
                    "command": fe_cmd_str,
                    "pid": fe_proc.pid,
                    "url": f"/proxy/{session_id}/",
                    "multi_service": True,
                    "framework": "full-stack",
                }

            server_info["status"] = "starting"
            server_info["port"] = fe_port
            return {
                "status": "starting",
                "message": "Server started but port not yet confirmed",
                "port": fe_port,
                "command": fe_cmd_str,
                "pid": fe_proc.pid,
                "url": f"/proxy/{session_id}/",
                "multi_service": True,
                "framework": "full-stack",
            }

        # -- Single-service startup (original path) --

        # Auto-install dependencies before starting the dev server
        actual_path = Path(actual_dir)
        needs_npm = (actual_path / "package.json").exists() and not (actual_path / "node_modules").exists()
        needs_pip = (actual_path / "requirements.txt").exists() and not (actual_path / "venv").exists()

        if needs_npm:
            try:
                subprocess.run(
                    ["npm", "install"],
                    cwd=actual_dir,
                    capture_output=True,
                    timeout=120,
                    env=build_env,
                )
            except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
                logger.warning("npm install failed: %s", exc)

        if needs_pip:
            self._install_pip_deps(actual_path, build_env)

        # Check if portless is available and proxy is running
        use_portless = False
        portless_app_name = None
        if self._has_portless() and await self._ensure_portless_proxy():
            portless_app_name = self._portless_app_name(session_id)
            use_portless = True

        # Build command as list (no shell=True needed)
        if use_portless and portless_app_name:
            cmd_parts = ["portless", portless_app_name] + shlex.split(cmd_str)
        else:
            cmd_parts = shlex.split(cmd_str)

        try:
            proc = subprocess.Popen(
                cmd_parts,
                shell=False,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                cwd=actual_dir,
                env=build_env,
                **({"start_new_session": True} if sys.platform != "win32"
                   else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}),
            )
        except Exception as e:
            return {"status": "error", "message": f"Failed to start: {e}"}

        _track_child_pid(proc.pid)

        effective_cmd = " ".join(cmd_parts)
        server_info = {
            "process": proc,
            "port": None,
            "expected_port": expected_port,
            "command": effective_cmd,
            "original_command": cmd_str,
            "framework": framework,
            "status": "starting",
            "pid": proc.pid,
            "project_dir": project_dir,
            "output_lines": [],
            "use_portless": use_portless,
            "portless_app_name": portless_app_name,
        }
        self.servers[session_id] = server_info

        asyncio.create_task(self._monitor_output(session_id))
        asyncio.create_task(self._continuous_log_monitor(session_id))

        # For Docker projects, also start the service health monitor
        if framework == "docker":
            asyncio.create_task(self._monitor_docker_services(session_id))

        # Wait for port detection (up to 30s)
        for _ in range(60):
            await asyncio.sleep(0.5)
            info = self.servers.get(session_id)
            if not info:
                return {"status": "error", "message": "Server entry disappeared"}
            if info["status"] == "error":
                return {
                    "status": "error",
                    "message": "Dev server crashed",
                    "output": info["output_lines"][-10:] if info["output_lines"] else [],
                }
            if info["port"] is not None:
                # For portless, also verify the portless proxy can reach the app
                check_port = info["port"]
                health_ok = await self._health_check(check_port)
                if health_ok:
                    info["status"] = "running"
                    result = {
                        "status": "running",
                        "port": info["port"],
                        "command": effective_cmd,
                        "pid": proc.pid,
                        "url": f"/proxy/{session_id}/",
                    }
                    if use_portless and portless_app_name:
                        result["portless_url"] = f"http://{portless_app_name}.localhost:1355/"
                        result["port"] = 1355
                    return result

        if proc.poll() is not None:
            server_info["status"] = "error"
            return {
                "status": "error",
                "message": "Dev server exited before port was detected",
                "output": server_info["output_lines"][-10:],
            }

        health_ok = await self._health_check(expected_port)
        if health_ok:
            server_info["port"] = expected_port
            server_info["status"] = "running"
            result = {
                "status": "running",
                "port": expected_port,
                "command": effective_cmd,
                "pid": proc.pid,
                "url": f"/proxy/{session_id}/",
            }
            if use_portless and portless_app_name:
                result["portless_url"] = f"http://{portless_app_name}.localhost:1355/"
                result["port"] = 1355
            return result

        server_info["status"] = "starting"
        server_info["port"] = expected_port
        result = {
            "status": "starting",
            "message": "Server started but port not yet confirmed",
            "port": expected_port,
            "command": effective_cmd,
            "pid": proc.pid,
            "url": f"/proxy/{session_id}/",
        }
        if use_portless and portless_app_name:
            result["portless_url"] = f"http://{portless_app_name}.localhost:1355/"
            result["port"] = 1355
        return result

    async def _monitor_output(self, session_id: str) -> None:
        """Background task: read dev server stdout and detect port."""
        info = self.servers.get(session_id)
        if not info:
            return
        proc = info["process"]
        loop = asyncio.get_running_loop()
        try:
            while proc.poll() is None:
                line = await loop.run_in_executor(None, proc.stdout.readline)
                if not line:
                    break
                text = line.rstrip("\n")
                info["output_lines"].append(text)
                if len(info["output_lines"]) > 200:
                    info["output_lines"] = info["output_lines"][-200:]
                detected_port = self._parse_port(text)
                if detected_port:
                    info["port"] = detected_port
                    # Transition from "starting" to "running" when port is detected
                    if info.get("status") == "starting":
                        info["status"] = "running"
        except Exception:
            logger.error("Dev server monitor failed for session %s", session_id, exc_info=True)
        finally:
            # Process exited -- mark as error if it was still starting or running
            if info.get("status") in ("starting", "running"):
                info["status"] = "error"
                # Auto-fix with exponential backoff and circuit breaker
                attempts = info.get("auto_fix_attempts", 0)
                now = time.time()
                timestamps = info.get("auto_fix_timestamps", [])
                recent = [t for t in timestamps if now - t < 300]

                if len(recent) >= 3:
                    info["auto_fix_status"] = "circuit breaker open (3 failures in 5 min)"
                    logger.warning("Auto-fix circuit breaker open for session %s", session_id)
                elif attempts < 3:
                    # BUG-V63-009: Prevent dual monitors from racing to auto-fix
                    if not info.get("_auto_fixing"):
                        info["_auto_fixing"] = True
                        info["auto_fix_attempts"] = attempts + 1
                        timestamps.append(now)
                        info["auto_fix_timestamps"] = timestamps
                        backoff_seconds = 5 * (3 ** attempts)
                        error_context = "\n".join(info.get("output_lines", [])[-30:])

                        async def _delayed_auto_fix():
                            try:
                                await asyncio.sleep(backoff_seconds)
                                await self._auto_fix(session_id, error_context)
                            finally:
                                _info = self.servers.get(session_id)
                                if _info:
                                    _info["_auto_fixing"] = False

                        try:
                            task = asyncio.ensure_future(_delayed_auto_fix())
                            info["_auto_fix_task"] = task
                        except Exception:
                            info["_auto_fixing"] = False
                            logger.warning("Failed to schedule auto-fix for session %s", session_id, exc_info=True)

    async def _monitor_backend_output(self, session_id: str) -> None:
        """Background task: read backend dev server stdout for multi-service setups."""
        info = self.servers.get(session_id)
        if not info or not info.get("multi_service"):
            return
        be_proc = info.get("backend_process")
        if not be_proc or not be_proc.stdout:
            return
        loop = asyncio.get_running_loop()
        try:
            while be_proc.poll() is None:
                line = await loop.run_in_executor(None, be_proc.stdout.readline)
                if not line:
                    break
                text = line.rstrip("\n")
                be_lines = info.get("backend_output_lines", [])
                be_lines.append(text)
                if len(be_lines) > 200:
                    be_lines = be_lines[-200:]
                info["backend_output_lines"] = be_lines
                # Also detect backend port from output
                detected_port = self._parse_port(text)
                if detected_port:
                    info["backend_port"] = detected_port
        except Exception:
            logger.error("Backend monitor failed for session %s", session_id, exc_info=True)
        finally:
            if be_proc.poll() is not None and info.get("status") in ("starting", "running"):
                # Only mark error if frontend is also dead
                fe_proc = info.get("process")
                if fe_proc and fe_proc.poll() is not None:
                    info["status"] = "error"

    async def _continuous_log_monitor(self, session_id: str) -> None:
        """Continuously monitor dev server output for errors and auto-fix.

        This runs alongside _monitor_output and watches for error patterns
        in the accumulated log lines. When errors are detected while the
        process is still running (not yet crashed), it triggers the AI
        provider to diagnose and fix the issue proactively.
        """
        info = self.servers.get(session_id)
        if not info:
            return

        last_error_check: float = 0
        error_cooldown = 30  # Don't check more than every 30 seconds

        while True:
            info = self.servers.get(session_id)
            if not info:
                break

            await asyncio.sleep(5)

            now = time.time()
            if now - last_error_check < error_cooldown:
                continue

            # Check recent output for error indicators
            recent_lines = info.get("output_lines", [])[-30:]
            if not recent_lines:
                continue

            recent_text = "\n".join(recent_lines)

            # Look for error indicators in the output
            error_indicators = [
                "Error:", "ERROR", "FATAL", "error:", "failed",
                "TypeError:", "SyntaxError:", "ModuleNotFoundError:",
                "Cannot find module", "ENOENT", "EACCES", "EADDRINUSE",
                "Connection refused", "Build failed", "Compilation failed",
                "npm ERR!", "pip install failed",
            ]

            has_error = any(indicator in recent_text for indicator in error_indicators)

            # Also check if the process exited
            proc = info.get("process")
            process_dead = proc and proc.poll() is not None

            if not has_error and not process_dead:
                continue

            last_error_check = now

            # Don't fix if already fixing (either from this monitor or _auto_fix)
            if info.get("_auto_fixing"):
                continue

            # Don't fix if the _monitor_output auto-fix already handled it
            # (process exited = _monitor_output triggers _auto_fix, skip here)
            if process_dead:
                continue

            project_dir = info.get("project_dir", ".")

            logger.info("Error detected in dev server output for session %s, triggering AI fix", session_id)

            # Broadcast to frontend that we are auto-fixing
            try:
                await _broadcast({
                    "type": "auto_fix",
                    "data": {
                        "session_id": session_id,
                        "status": "detecting",
                        "message": "Error detected in dev server output. AI is analyzing...",
                    }
                })
            except Exception:
                pass

            # Gather context and trigger fix
            info["_auto_fixing"] = True
            try:
                # Get Docker context if applicable
                docker_ctx: dict = {}
                if info.get("framework") == "docker":
                    try:
                        docker_ctx = await _gather_docker_context(Path(project_dir))
                    except Exception:
                        pass

                # Build AI prompt with full context
                compose_content = ""
                compose_file = Path(project_dir) / "docker-compose.yml"
                if not compose_file.exists():
                    compose_file = Path(project_dir) / "docker-compose.yaml"
                if compose_file.exists():
                    try:
                        compose_content = compose_file.read_text(errors="replace")[:5000]
                    except OSError:
                        pass

                error_lines = "\n".join(info.get("output_lines", [])[-50:])

                fix_prompt = (
                    "The dev server has errors. Analyze and fix them.\n\n"
                    f"DEV SERVER OUTPUT (last 50 lines):\n{error_lines[:3000]}\n"
                )
                if docker_ctx:
                    svc_status = docker_ctx.get("service_status", [])
                    if svc_status:
                        fix_prompt += f"\nDOCKER SERVICE STATUS: {json.dumps(svc_status)}\n"
                if compose_content:
                    fix_prompt += f"\nDOCKER-COMPOSE.YML:\n{compose_content}\n"
                fix_prompt += (
                    f"\nPROJECT DIRECTORY: {project_dir}\n\n"
                    "INSTRUCTIONS:\n"
                    "1. Analyze the error in the output above\n"
                    "2. Fix the root cause (edit code, config, Dockerfile, etc.)\n"
                    "3. The system will automatically restart/rebuild after your fix\n"
                    "4. Make the fix work on any platform"
                )

                # Trigger AI fix
                loki = _find_loki_cli()
                if loki:
                    fix_env = {**os.environ, **_load_secrets()}
                    fix_env["LOKI_MAX_ITERATIONS"] = "5"
                    fix_env["LOKI_AUTO_FIX"] = "true"

                    await asyncio.to_thread(
                        subprocess.run,
                        [loki, "quick", fix_prompt],
                        capture_output=True, text=True, cwd=project_dir, timeout=300,
                        env=fix_env,
                    )

                    # Rebuild if Docker
                    if info.get("framework") == "docker":
                        await asyncio.to_thread(
                            subprocess.run,
                            ["docker", "compose", "up", "-d", "--build", "--no-deps"],
                            capture_output=True, cwd=project_dir, timeout=120,
                        )

                    # Broadcast fix complete
                    try:
                        await _broadcast({
                            "type": "auto_fix",
                            "data": {
                                "session_id": session_id,
                                "status": "completed",
                                "message": "AI fix applied. Rebuilding...",
                            }
                        })
                    except Exception:
                        pass
            except Exception as e:
                logger.error("Continuous log monitor fix failed: %s", e)
            finally:
                # Re-fetch info in case it was replaced during the fix
                info = self.servers.get(session_id)
                if info:
                    info["_auto_fixing"] = False

    async def _auto_fix(self, session_id: str, error_context: str) -> None:
        """Auto-fix a crashed dev server by invoking loki quick with the error."""
        info = self.servers.get(session_id)
        if not info:
            return

        attempt = info.get("auto_fix_attempts", 1)
        # Preserve auto_fix_attempts across stop/start to maintain circuit breaker
        saved_attempts = info.get("auto_fix_attempts", 0)
        info["auto_fix_status"] = f"fixing (attempt {attempt}/3)"
        logger.info("Auto-fix attempt %d/3 for session %s", attempt, session_id)

        # Find the project directory for this session
        target = _find_session_dir(session_id)
        if target is None:
            info["auto_fix_status"] = "failed (session not found)"
            return

        loki = _find_loki_cli()
        if loki is None:
            info["auto_fix_status"] = "failed (loki CLI not found)"
            return

        fix_message = (
            f"The dev server crashed. Fix the error and ensure the app starts correctly.\n\n"
            f"DEV SERVER ERROR OUTPUT:\n{error_context}"
        )

        # Enrich with Docker context if applicable
        if info.get("framework") == "docker":
            try:
                docker_ctx = await _gather_docker_context(target)
                if docker_ctx.get("failing_services"):
                    fix_message += "\n\nDOCKER SERVICE STATUS:\n" + json.dumps(docker_ctx["service_status"], indent=2)
                    for svc_name, svc_logs in docker_ctx.get("service_logs", {}).items():
                        if svc_name != "_combined":
                            fix_message += f"\n\nFAILING SERVICE '{svc_name}' LOGS:\n{svc_logs}"
                    diagnoses = _diagnose_errors("\n".join(docker_ctx.get("service_logs", {}).values()))
                    if diagnoses:
                        fix_message += "\n\nAUTO-DIAGNOSIS:\n" + "\n".join(
                            f"- {d['diagnosis']}: {d['suggestion']}" for d in diagnoses)
                if docker_ctx.get("project_structure"):
                    fix_message += "\n\nPROJECT FILES:\n" + docker_ctx["project_structure"]
            except Exception:
                logger.debug("Docker context gathering for auto-fix failed", exc_info=True)

        # Save original command, framework, and multi_service flag before stop() removes the info dict
        cmd = info.get("original_command")
        is_multi_service = info.get("multi_service", False)
        framework = info.get("framework")

        try:
            auto_fix_env = {**os.environ}
            auto_fix_env.update(_load_secrets())
            result = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: subprocess.run(
                    [loki, "quick", fix_message],
                    cwd=str(target),
                    capture_output=True,
                    text=True,
                    timeout=300,
                    env=auto_fix_env,
                    start_new_session=True,
                ),
            )
            if result.returncode == 0:
                logger.info("Auto-fix succeeded for session %s, restarting dev server", session_id)
                # For Docker projects, rebuild images before restarting
                # (fix may have changed Dockerfile, package.json, requirements.txt, etc.)
                if framework == "docker":
                    await asyncio.to_thread(
                        subprocess.run,
                        ["docker", "compose", "up", "-d", "--build", "--no-deps"],
                        capture_output=True, cwd=str(target), timeout=120
                    )
                # Restart the dev server
                await self.stop(session_id)
                await asyncio.sleep(1)
                # BUG-V63-008: For multi-service sessions, omit command= to re-enter
                # the multi-service detection path in start()
                if is_multi_service:
                    await self.start(session_id, str(target))
                else:
                    await self.start(session_id, str(target), command=cmd)
                # Transfer circuit breaker state to the new info dict
                new_info = self.servers.get(session_id)
                if new_info:
                    new_info["auto_fix_attempts"] = saved_attempts
                    new_info["auto_fix_status"] = "fixed, restarting..."
            else:
                # info may be stale after stop, but we only read from it here
                info["auto_fix_status"] = f"fix attempt {attempt} failed"
                logger.warning("Auto-fix attempt %d failed for session %s", attempt, session_id)
        except Exception as e:
            info["auto_fix_status"] = f"fix error: {str(e)[:100]}"
            logger.error("Auto-fix error for session %s: %s", session_id, e)

    async def _health_check(self, port: int, retries: int = 3) -> bool:
        """Check if a port is responding to TCP connections."""
        import socket
        loop = asyncio.get_running_loop()
        for _ in range(retries):
            try:
                def check() -> bool:
                    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    s.settimeout(1)
                    try:
                        s.connect(("127.0.0.1", port))
                        return True
                    except (ConnectionRefusedError, OSError):
                        return False
                    finally:
                        s.close()
                if await loop.run_in_executor(None, check):
                    return True
            except Exception:
                pass
            await asyncio.sleep(0.5)
        return False

    async def stop(self, session_id: str) -> dict:
        """Stop dev server for session."""
        info = self.servers.pop(session_id, None)
        if not info:
            return {"stopped": False, "message": "No dev server running"}

        # Cancel any pending auto-fix task
        fix_task = info.get("_auto_fix_task")
        if fix_task and not fix_task.done():
            fix_task.cancel()

        # Cancel any tracked Docker service fix tasks (BUG-V64-003)
        for task in info.get("_fix_tasks", {}).values():
            if not task.done():
                task.cancel()

        # For Docker containers, run docker compose down
        if info.get("framework") == "docker":
            try:
                project_dir = info.get("project_dir", ".")
                # Find the compose file used in the original command
                compose_cmd = info.get("original_command", "")
                compose_args = ["docker", "compose", "down", "--remove-orphans"]
                # Extract -f flag from original command if present
                f_match = re.search(r'-f\s+(\S+)', compose_cmd)
                if f_match:
                    compose_args = ["docker", "compose", "-f", f_match.group(1), "down", "--remove-orphans"]
                subprocess.run(
                    compose_args,
                    cwd=project_dir,
                    capture_output=True, timeout=30,
                )
            except (ProcessLookupError, PermissionError, OSError):
                pass

        proc = info["process"]
        if proc.poll() is None:
            if sys.platform != "win32":
                try:
                    pgid = os.getpgid(proc.pid)
                    os.killpg(pgid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError, OSError):
                    try:
                        proc.terminate()
                    except (ProcessLookupError, PermissionError, OSError):
                        pass
            else:
                try:
                    proc.terminate()
                except (ProcessLookupError, PermissionError, OSError):
                    pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if sys.platform != "win32":
                    try:
                        pgid = os.getpgid(proc.pid)
                        os.killpg(pgid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError, OSError):
                        try:
                            proc.kill()
                        except (ProcessLookupError, PermissionError, OSError):
                            pass
                else:
                    try:
                        proc.kill()
                    except (ProcessLookupError, PermissionError, OSError):
                        pass

        _untrack_child_pid(proc.pid)

        # For multi-service setups, also kill the backend process
        be_proc = info.get("backend_process")
        if be_proc:
            if be_proc.poll() is None:
                if sys.platform != "win32":
                    try:
                        pgid = os.getpgid(be_proc.pid)
                        os.killpg(pgid, signal.SIGTERM)
                    except (ProcessLookupError, PermissionError, OSError):
                        try:
                            be_proc.terminate()
                        except (ProcessLookupError, PermissionError, OSError):
                            pass
                else:
                    try:
                        be_proc.terminate()
                    except (ProcessLookupError, PermissionError, OSError):
                        pass
                try:
                    be_proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        be_proc.kill()
                    except (ProcessLookupError, PermissionError, OSError):
                        pass
            _untrack_child_pid(be_proc.pid)

        return {"stopped": True, "message": "Dev server stopped"}

    async def status(self, session_id: str) -> dict:
        """Get dev server status."""
        info = self.servers.get(session_id)
        if not info:
            return {
                "running": False,
                "status": "stopped",
                "port": None,
                "command": None,
                "pid": None,
                "url": None,
                "framework": None,
                "output": [],
            }

        proc = info["process"]
        alive = proc.poll() is None
        if not alive and info["status"] in ("running", "starting"):
            info["status"] = "error"

        result = {
            "running": alive and info["status"] == "running",
            "status": info["status"],
            "port": info.get("port"),
            "command": info.get("command"),
            "pid": proc.pid if alive else None,
            "url": f"/proxy/{session_id}/" if info.get("port") and alive else None,
            "framework": info.get("framework"),
            "output": info.get("output_lines", [])[-20:],
            "auto_fix_status": info.get("auto_fix_status"),
            "auto_fix_attempts": info.get("auto_fix_attempts", 0),
        }

        # Multi-service status reporting
        if info.get("multi_service"):
            be_proc = info.get("backend_process")
            be_alive = be_proc.poll() is None if be_proc else False
            result["multi_service"] = True
            result["framework"] = "full-stack"
            result["services"] = [
                {
                    "name": "frontend",
                    "framework": info.get("frontend_framework", "unknown"),
                    "port": info.get("expected_port"),
                    "status": "running" if alive else "error",
                },
                {
                    "name": "backend",
                    "framework": info.get("backend_framework", "unknown"),
                    "port": info.get("backend_port"),
                    "status": "running" if be_alive else "error",
                },
            ]
            result["backend_output"] = info.get("backend_output_lines", [])[-20:]

        if info.get("use_portless") and info.get("portless_app_name"):
            app_name = info["portless_app_name"]
            result["portless_url"] = f"http://{app_name}.localhost:1355/"
            if alive:
                result["port"] = 1355
        return result

    async def _monitor_docker_services(self, session_id: str) -> None:
        """Background loop: poll Docker Compose services, auto-fix failures."""
        info = self.servers.get(session_id)
        if not info:
            return

        project_dir = Path(info.get("project_dir", "."))
        info["docker_service_health"] = {}

        while True:
            info = self.servers.get(session_id)
            if not info or not info.get("process") or info["process"].poll() is not None:
                break
            await asyncio.sleep(10)
            # Re-check after sleep in case server was stopped
            info = self.servers.get(session_id)
            if not info or not info.get("process") or info["process"].poll() is not None:
                break

            try:
                docker_ctx = await _gather_docker_context(project_dir)
            except Exception:
                continue

            # Update service health
            for svc in docker_ctx.get("service_status", []):
                name = svc["name"]
                prev = info["docker_service_health"].get(name, {})
                svc_health: dict = {
                    "name": name,
                    "status": svc["state"],
                    "exit_code": svc.get("exit_code", 0),
                    "restarts": prev.get("restarts", 0),
                    "fix_attempts": prev.get("fix_attempts", 0),
                    "fix_timestamps": prev.get("fix_timestamps", []),
                }

                # Detect new failure
                was_running = prev.get("status") in ("running", None)
                now_failed = svc["state"] in ("exited", "dead")

                # Detect services that need fixing:
                # 1. was_running and now_failed: service transitioned from running to exited
                # 2. Persistently failed: service is exited AND has never been successfully fixed
                #    (fix_attempts == 0 or fix_status != "fixed")
                persistently_failed = (
                    now_failed
                    and prev.get("fix_status") != "fixed"
                    and prev.get("status") in ("exited", "dead", None)
                )

                if (was_running and now_failed) or persistently_failed:
                    svc_health["restarts"] = prev.get("restarts", 0) + 1
                    logger.warning("Docker service '%s' failed (exit %s)", name, svc.get("exit_code"))

                    # Circuit breaker: max 3 fixes per service per 10 min
                    now = time.time()
                    recent_fixes = [t for t in svc_health["fix_timestamps"] if now - t < 600]

                    if len(recent_fixes) < 3:
                        # BUG-V63-009: Prevent dual monitors from racing to auto-fix
                        if info.get("_auto_fixing"):
                            svc_health["fix_status"] = "fix_in_progress"
                            info["docker_service_health"][name] = svc_health
                            continue

                        # BUG-V64-004: Skip if a fix task is already running for this service
                        existing_task = info.get("_fix_tasks", {}).get(name)
                        if existing_task and not existing_task.done():
                            svc_health["fix_status"] = "fix_in_progress"
                            info["docker_service_health"][name] = svc_health
                            continue  # Skip, previous fix still running

                        info["_auto_fixing"] = True
                        svc_logs = docker_ctx.get("service_logs", {}).get(name, "")

                        # Read compose file for AI context
                        compose_content = ""
                        compose_file = project_dir / "docker-compose.yml"
                        if not compose_file.exists():
                            compose_file = project_dir / "docker-compose.yaml"
                        if compose_file.exists():
                            try:
                                compose_content = compose_file.read_text(errors="replace")[:5000]
                            except OSError:
                                pass

                        # Read service Dockerfile for AI context
                        dockerfile_content = ""
                        for df_path in [project_dir / name / "Dockerfile", project_dir / "Dockerfile"]:
                            if df_path.exists():
                                try:
                                    dockerfile_content = df_path.read_text(errors="replace")[:3000]
                                    break
                                except OSError:
                                    pass

                        fix_prompt = f"""You are debugging a Docker Compose service that has failed.

SERVICE: {name}
STATUS: exited/dead (exit code {svc.get('exit_code', 1)})

DOCKER COMPOSE LOGS (last 50 lines):
{svc_logs[:3000]}

DOCKER-COMPOSE.YML:
{compose_content}
"""
                        if dockerfile_content:
                            fix_prompt += f"\nDOCKERFILE ({name}/Dockerfile):\n{dockerfile_content}\n"

                        fix_prompt += """
INSTRUCTIONS:
1. Analyze the error in the logs above
2. Identify the root cause
3. Fix the issue by editing the necessary files (docker-compose.yml, Dockerfile, source code, package.json, requirements.txt, etc.)
4. Make sure the fix works on any platform (Docker Desktop, Linux, Docker-in-Docker, Kubernetes)
5. Do NOT just restart -- actually fix the underlying code/config problem
6. After fixing, the system will rebuild with 'docker compose up --build'
7. Common issues: named volumes for node_modules (use anonymous), missing dependencies, port conflicts, wrong commands"""

                        svc_health["fix_attempts"] += 1
                        svc_health["fix_timestamps"] = recent_fixes + [now]
                        svc_health["fix_status"] = "fixing"

                        # BUG-V64-003: Track fix tasks so they can be cancelled on stop
                        if "_fix_tasks" not in info:
                            info["_fix_tasks"] = {}
                        task = asyncio.ensure_future(self._auto_fix_service(session_id, name, fix_prompt))
                        info["_fix_tasks"][name] = task
                    else:
                        svc_health["fix_status"] = "circuit_breaker_open"

                info["docker_service_health"][name] = svc_health

            # Broadcast service health via WebSocket
            try:
                await _broadcast({
                    "type": "service_health",
                    "data": {
                        "session_id": session_id,
                        "services": list(info["docker_service_health"].values()),
                    }
                })
            except Exception:
                pass

    async def _auto_fix_service(self, session_id: str, service_name: str, fix_prompt: str) -> None:
        """Run targeted fix for a specific Docker service."""
        info = self.servers.get(session_id)
        if not info:
            return
        project_dir = info.get("project_dir", ".")
        loki = _find_loki_cli()
        if not loki:
            info["_auto_fixing"] = False
            return

        try:
            fix_env = {**os.environ, **_load_secrets()}
            fix_env["LOKI_MAX_ITERATIONS"] = "5"  # More iterations for complex Docker fixes

            proc = await asyncio.to_thread(
                subprocess.run,
                [loki, "quick", fix_prompt],
                capture_output=True, text=True, cwd=project_dir, timeout=300,
                env=fix_env
            )

            # Rebuild the image (fix may have changed Dockerfile or package.json)
            # --no-deps prevents restarting healthy services, --build rebuilds with the fix
            await asyncio.to_thread(
                subprocess.run,
                ["docker", "compose", "up", "-d", "--build", "--no-deps", service_name],
                capture_output=True, cwd=project_dir, timeout=120
            )

            # Wait for service to stabilize after rebuild
            await asyncio.sleep(10)

            # Verify the fix actually worked
            fix_worked = False
            try:
                verify_proc = await asyncio.to_thread(
                    subprocess.run,
                    ["docker", "compose", "ps", "-a", "--format", "json"],
                    capture_output=True, text=True, cwd=project_dir, timeout=10
                )
                if verify_proc.returncode == 0 and verify_proc.stdout.strip():
                    raw = verify_proc.stdout.strip()
                    try:
                        parsed = json.loads(raw)
                        if not isinstance(parsed, list):
                            parsed = [parsed]
                    except json.JSONDecodeError:
                        parsed = []
                        for line in raw.split("\n"):
                            if line.strip():
                                try:
                                    parsed.append(json.loads(line))
                                except json.JSONDecodeError:
                                    pass
                    for svc in parsed:
                        if isinstance(svc, dict) and svc.get("Name", svc.get("name", "")) == service_name:
                            state = svc.get("State", svc.get("state", ""))
                            fix_worked = state == "running"
                            break
            except Exception:
                logger.debug("Post-fix verification failed for service '%s'", service_name, exc_info=True)

            # Determine final fix status
            if proc.returncode == 0 and fix_worked:
                final_status = "fixed"
            elif proc.returncode == 0 and not fix_worked:
                final_status = "fix_failed"
                logger.warning("loki quick succeeded but service '%s' still not running", service_name)
            else:
                final_status = "fix_failed"

            # BUG-V64-005: Re-fetch from live info dict to avoid writing to detached dict
            info = self.servers.get(session_id)
            if info and "docker_service_health" in info and service_name in info["docker_service_health"]:
                info["docker_service_health"][service_name]["fix_status"] = final_status
        except Exception as exc:
            logger.error("Auto-fix for service '%s' failed: %s", service_name, exc)
            # BUG-V64-005: Re-fetch from live info dict
            info = self.servers.get(session_id)
            if info and "docker_service_health" in info and service_name in info["docker_service_health"]:
                info["docker_service_health"][service_name]["fix_status"] = "fix_failed"
        finally:
            # BUG-V63-009: Clear the auto-fixing lock
            info = self.servers.get(session_id)
            if info:
                info["_auto_fixing"] = False

    async def stop_all(self) -> None:
        """Stop all dev servers (used on shutdown)."""
        for sid in list(self.servers.keys()):
            await self.stop(sid)


dev_server_manager = DevServerManager()


# ---------------------------------------------------------------------------
# Docker context gathering and error diagnosis
# ---------------------------------------------------------------------------


_docker_context_cache: dict[str, tuple[float, dict]] = {}


async def _gather_docker_context(project_dir: Path) -> dict:
    """Gather Docker Compose service status, logs, and project context."""
    cache_key = str(project_dir)
    now = time.time()
    cached = _docker_context_cache.get(cache_key)
    if cached and now - cached[0] < 30:
        return cached[1]

    loop = asyncio.get_running_loop()
    result: dict = {"service_status": [], "failing_services": [], "service_logs": {},
                    "project_structure": "", "env_keys": []}

    # Get service status via docker compose ps
    try:
        ps_proc = await loop.run_in_executor(None, lambda: subprocess.run(
            ["docker", "compose", "ps", "-a", "--format", "json"],
            capture_output=True, text=True, cwd=str(project_dir), timeout=10
        ))
        if ps_proc.returncode == 0 and ps_proc.stdout.strip():
            raw = ps_proc.stdout.strip()
            # Handle both NDJSON (one object per line) and JSON array formats
            # Docker Compose v2.21+ returns a JSON array instead of NDJSON
            services_data: list = []
            try:
                parsed = json.loads(raw)
                if isinstance(parsed, list):
                    services_data = parsed
                else:
                    services_data = [parsed]
            except json.JSONDecodeError:
                # NDJSON format - one JSON object per line
                for line in raw.split("\n"):
                    if line.strip():
                        try:
                            services_data.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
            for svc in services_data:
                if not isinstance(svc, dict):
                    continue
                status_entry = {
                    "name": svc.get("Service", svc.get("Name", "unknown")),
                    "state": svc.get("State", "unknown"),
                    "status": svc.get("Status", ""),
                    "exit_code": svc.get("ExitCode", 0),
                }
                result["service_status"].append(status_entry)
                if status_entry["state"] in ("exited", "dead", "restarting"):
                    result["failing_services"].append(status_entry["name"])
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    # Get logs for failing services
    for svc_name in result["failing_services"]:
        try:
            log_proc = await loop.run_in_executor(None, lambda sn=svc_name: subprocess.run(
                ["docker", "compose", "logs", "--tail", "50", sn],
                capture_output=True, text=True, cwd=str(project_dir), timeout=15
            ))
            if log_proc.stdout:
                result["service_logs"][svc_name] = log_proc.stdout[-3000:]  # Cap at 3KB
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass

    # If no specific failures, get combined logs tail
    if not result["failing_services"]:
        try:
            log_proc = await loop.run_in_executor(None, lambda: subprocess.run(
                ["docker", "compose", "logs", "--tail", "30"],
                capture_output=True, text=True, cwd=str(project_dir), timeout=15
            ))
            if log_proc.stdout:
                result["service_logs"]["_combined"] = log_proc.stdout[-3000:]
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            pass

    # Project structure
    try:
        ls_proc = await loop.run_in_executor(None, lambda: subprocess.run(
            ["find", ".", "-maxdepth", "2", "-type", "f", "(",
             "-name", "*.py", "-o", "-name", "*.ts",
             "-o", "-name", "*.tsx", "-o", "-name", "*.js", "-o", "-name", "package.json",
             "-o", "-name", "requirements.txt", "-o", "-name", "Dockerfile",
             "-o", "-name", "docker-compose.yml", "-o", "-name", "*.env", ")"],
            capture_output=True, text=True, cwd=str(project_dir), timeout=5
        ))
        result["project_structure"] = ls_proc.stdout[:2000] if ls_proc.stdout else ""
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        pass

    # Env variable names (not values)
    env_file = project_dir / ".env"
    if env_file.exists():
        try:
            for line in env_file.read_text(errors="replace").split("\n"):
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    result["env_keys"].append(line.split("=", 1)[0])
        except OSError:
            pass

    _docker_context_cache[cache_key] = (time.time(), result)
    return result


def _diagnose_errors(logs: str) -> list[dict]:
    """Pattern-match common errors in Docker/service logs and return diagnoses."""
    diagnoses: list[dict] = []
    patterns = [
        (r"ModuleNotFoundError: No module named ['\"](\w+)['\"]",
         lambda m: {"pattern": "missing_python_dep", "diagnosis": f"Missing Python dependency: {m.group(1)}",
                     "suggestion": f"Add '{m.group(1)}' to requirements.txt and rebuild"}),
        (r"Cannot find module ['\"]([^'\"]+)['\"]|ERR_MODULE_NOT_FOUND",
         lambda m: {"pattern": "missing_node_dep", "diagnosis": "Missing Node.js module",
                     "suggestion": "Run 'npm install' in the service directory"}),
        (r"ECONNREFUSED.*:(\d+)|connection refused.*:(\d+)",
         lambda m: {"pattern": "connection_refused",
                     "diagnosis": f"Connection refused on port {m.group(1) or m.group(2)}",
                     "suggestion": "A dependent service may not be ready. Add retry logic or health check wait."}),
        (r"address already in use|EADDRINUSE",
         lambda m: {"pattern": "port_conflict", "diagnosis": "Port already in use",
                     "suggestion": "Another process is using the port. Change the port or stop the conflicting process."}),
        (r"SyntaxError: (.+)",
         lambda m: {"pattern": "syntax_error", "diagnosis": f"Syntax error: {m.group(1)[:100]}",
                     "suggestion": "Fix the syntax error in the indicated file and line."}),
        (r"FATAL:.*password authentication failed",
         lambda m: {"pattern": "db_auth", "diagnosis": "Database authentication failed",
                     "suggestion": "Check DATABASE_URL credentials match the postgres service environment."}),
        (r"error.*returned a non-zero code: (\d+)",
         lambda m: {"pattern": "build_failure", "diagnosis": f"Docker build failed (exit code {m.group(1)})",
                     "suggestion": "Check the Dockerfile for errors. Common: missing system dependencies."}),
        (r"npm ERR!|npm error",
         lambda m: {"pattern": "npm_error", "diagnosis": "npm encountered an error",
                     "suggestion": "Check package.json for invalid dependencies or run 'npm install' manually."}),
        (r"ENOTEMPTY.*node_modules|rename.*node_modules.*ENOTEMPTY",
         lambda m: {"pattern": "node_modules_volume_conflict", "diagnosis": "Docker volume conflict with node_modules",
                     "suggestion": "Replace named volume with anonymous volume in docker-compose.yml: use '- /app/node_modules' instead of '- name:/app/node_modules'. Then run 'docker compose down -v && docker compose up --build'."}),
        (r"EACCES.*permission denied|EPERM.*operation not permitted",
         lambda m: {"pattern": "permission_denied", "diagnosis": "File permission error in container",
                     "suggestion": "Check Dockerfile USER directive and volume mount permissions. May need 'chown' in Dockerfile."}),
    ]
    seen: set[str] = set()
    for pattern, handler in patterns:
        for match in re.finditer(pattern, logs, re.IGNORECASE):
            diag = handler(match)
            key = diag["pattern"]
            if key not in seen:
                seen.add(key)
                diagnoses.append(diag)
    return diagnoses


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _loki_dir() -> Path:
    """Return the .loki/ directory for the current session project."""
    if session.project_dir:
        return Path(session.project_dir) / ".loki"
    return Path.home() / ".loki"


def _safe_resolve(base: Path, requested: str) -> Optional[Path]:
    """Resolve a path ensuring it stays within base (path traversal protection).

    Uses os.path.commonpath to avoid the startswith prefix collision where
    /tmp/proj would incorrectly pass a check against /tmp/projother.
    Also rejects symlinks that escape the base directory.
    """
    try:
        resolved = (base / requested).resolve()
        base_resolved = base.resolve()
        # Ensure resolved is strictly inside base_resolved
        resolved.relative_to(base_resolved)
        # Reject if any component is a symlink pointing outside base
        check = base_resolved
        for part in resolved.relative_to(base_resolved).parts:
            check = check / part
            if check.is_symlink():
                link_target = check.resolve()
                link_target.relative_to(base_resolved)  # raises ValueError if outside
        return resolved
    except (ValueError, OSError):
        pass
    return None


def _find_session_dir(session_id: str) -> Optional[Path]:
    """Find a session's project directory by ID."""
    search_dirs = [
        Path.home() / "purple-lab-projects",
        Path.home() / ".loki-sessions",
        Path.home() / ".loki" / "sessions",
    ]
    for base_dir in search_dirs:
        candidate = base_dir / session_id
        if candidate.is_dir():
            return candidate
    return None


async def _broadcast(msg: dict) -> None:
    """Send a JSON message to all connected WebSocket clients."""
    data = json.dumps(msg)
    dead: list[WebSocket] = []
    for ws in list(session.ws_clients):
        try:
            await ws.send_text(data)
        except Exception:
            logger.debug("WebSocket send failed for client", exc_info=True)
            dead.append(ws)
    for ws in dead:
        session.ws_clients.discard(ws)


async def _read_process_output() -> None:
    """Background task: read loki stdout/stderr and broadcast lines."""
    proc = session.process
    if proc is None or proc.stdout is None:
        return

    loop = asyncio.get_running_loop()

    try:
        while session.running and proc.poll() is None:
            line = await loop.run_in_executor(None, proc.stdout.readline)
            if not line:
                break
            text = line.rstrip("\n")
            session.log_lines.append(text)
            session.log_lines_total += 1
            # Keep last 5000 lines
            if len(session.log_lines) > 5000:
                session.log_lines = session.log_lines[-5000:]
            await _broadcast({
                "type": "log",
                "data": {"line": text, "timestamp": time.strftime("%H:%M:%S")},
            })
    except Exception:
        logger.error("Process output reader failed", exc_info=True)
    finally:
        # Process ended -- acquire lock before mutating state
        async with session._lock:
            session.running = False
        await _broadcast({"type": "session_end", "data": {"message": "Session ended"}})


def _build_file_tree(root: Path, max_depth: int = 8, _depth: int = 0) -> list[dict]:
    """Recursively build a file tree from a directory.

    max_depth is set to 8 to support monorepo structures like
    packages/frontend/src/components/ui/Button.tsx (6 levels deep).
    """
    if _depth >= max_depth or not root.is_dir():
        return []

    entries = []
    try:
        items = sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        return []

    # Limit children per directory to prevent memory issues on very large projects
    MAX_CHILDREN = 500
    child_count = 0

    for item in items:
        # Skip hidden dirs and common noise
        if item.name.startswith("."):
            continue
        if item.name in ("node_modules", "__pycache__", ".git", "venv", ".venv",
                         "vendor", ".turbo", ".nx", "coverage", ".parcel-cache"):
            continue

        child_count += 1
        if child_count > MAX_CHILDREN:
            entries.append({
                "name": f"... ({len(list(root.iterdir())) - MAX_CHILDREN} more items)",
                "path": str(root.relative_to(root)) + "/...",
                "type": "file",
                "size": 0,
            })
            break

        node: dict = {"name": item.name, "path": str(item.relative_to(root))}
        if item.is_dir():
            node["type"] = "directory"
            node["children"] = _build_file_tree(item, max_depth, _depth + 1)
        else:
            node["type"] = "file"
            try:
                node["size"] = item.stat().st_size
            except OSError:
                node["size"] = 0
        entries.append(node)
    return entries


# ---------------------------------------------------------------------------
# Secrets management (plaintext -- this is a local dev tool, not a vault)
# ---------------------------------------------------------------------------

_SECRETS_FILE = SCRIPT_DIR.parent / ".loki" / "purple-lab" / "secrets.json"


def _load_secrets() -> dict[str, str]:
    """Load secrets from disk, decrypting values if encryption is configured."""
    try:
        from crypto import decrypt_value, encryption_available
    except ImportError:
        # crypto module not available -- return raw secrets or empty dict
        if _SECRETS_FILE.exists():
            try:
                data = json.loads(_SECRETS_FILE.read_text())
                if isinstance(data, dict):
                    return data
            except (json.JSONDecodeError, OSError):
                pass
        return {}
    if _SECRETS_FILE.exists():
        try:
            data = json.loads(_SECRETS_FILE.read_text())
            if isinstance(data, dict):
                if encryption_available():
                    return {k: decrypt_value(v) for k, v in data.items()}
                return data
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_secrets(secrets: dict[str, str]) -> None:
    """Save secrets to disk, encrypting values if PURPLE_LAB_SECRET_KEY is set."""
    from crypto import encrypt_value, encryption_available
    _SECRETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    if encryption_available():
        encrypted = {k: encrypt_value(v) for k, v in secrets.items()}
        _SECRETS_FILE.write_text(json.dumps(encrypted, indent=2))
    else:
        _SECRETS_FILE.write_text(json.dumps(secrets, indent=2))


# ---------------------------------------------------------------------------
# Chat task tracking (non-blocking chat via polling)
# ---------------------------------------------------------------------------


class ChatTask:
    def __init__(self) -> None:
        self.id = str(uuid.uuid4())[:8]
        self.output_lines: list[str] = []
        self.complete = False
        self.returncode: int = -1
        self.files_changed: list[str] = []
        self.process: Optional[subprocess.Popen] = None
        self.cancelled = False
        self.created_at: float = time.time()


_chat_tasks: dict[str, ChatTask] = {}
_CHAT_TASK_MAX_AGE = 600  # Seconds to keep completed tasks before cleanup
_CHAT_TASK_MAX_COUNT = 100  # Max tasks to keep in memory


def _cleanup_chat_tasks() -> None:
    """Remove completed tasks older than _CHAT_TASK_MAX_AGE, or oldest if over limit."""
    now = time.time()
    # Remove old completed tasks
    expired = [
        tid for tid, t in _chat_tasks.items()
        if t.complete and (now - t.created_at) > _CHAT_TASK_MAX_AGE
    ]
    for tid in expired:
        del _chat_tasks[tid]
    # If still over limit, remove oldest completed tasks
    if len(_chat_tasks) > _CHAT_TASK_MAX_COUNT:
        completed = sorted(
            [(tid, t) for tid, t in _chat_tasks.items() if t.complete],
            key=lambda x: x[1].created_at,
        )
        while len(_chat_tasks) > _CHAT_TASK_MAX_COUNT and completed:
            tid, _ = completed.pop(0)
            del _chat_tasks[tid]

# ---------------------------------------------------------------------------
# API endpoints
# ---------------------------------------------------------------------------


@app.post("/api/session/start")
async def start_session(req: StartRequest) -> JSONResponse:
    """Start a new loki session with the given PRD."""
    if len(req.prd.encode()) > _MAX_PRD_BYTES:
        return JSONResponse(status_code=400, content={"error": "PRD exceeds 1 MB limit"})

    async with session._lock:
        if session.running:
            return JSONResponse(
                status_code=409,
                content={"error": "A session is already running. Stop it first."},
            )

        # Clean up any stale reader task from previous session
        await session.cleanup()

        # Determine project directory
        project_dir = req.projectDir
        if not project_dir:
            project_dir = os.path.join(Path.home(), "purple-lab-projects", f"project-{int(time.time() * 1000)}")
        os.makedirs(project_dir, exist_ok=True)

        # Write PRD to a temp file in the project dir
        prd_path = os.path.join(project_dir, "PRD.md")
        with open(prd_path, "w") as f:
            f.write(req.prd)

        # Build the loki start command
        if req.mode == "quick":
            # Extract first non-blank line as the task description
            first_line = next((l.strip() for l in req.prd.splitlines() if l.strip()), req.prd[:200])
            cmd = [
                str(LOKI_CLI),
                "quick",
                first_line,
            ]
        else:
            cmd = [
                str(LOKI_CLI),
                "start",
                "--provider", req.provider,
                prd_path,
            ]

        try:
            # Load secrets and inject as env vars
            build_env = {**os.environ, "LOKI_DIR": os.path.join(project_dir, ".loki")}
            build_env.update(_load_secrets())

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                cwd=project_dir,
                env=build_env,
                **({"start_new_session": True} if sys.platform != "win32"
                   else {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}),
            )
        except FileNotFoundError:
            return JSONResponse(
                status_code=500,
                content={"error": f"loki CLI not found at {LOKI_CLI}"},
            )
        except Exception as e:
            return JSONResponse(
                status_code=500,
                content={"error": f"Failed to start session: {e}"},
            )

        # Update session state
        session.reset()
        session.process = proc
        session.running = True
        session.provider = req.provider
        session.prd_text = req.prd
        session.project_dir = project_dir
        session.start_time = time.time()

        # Track this PID so loki web stop knows it's ours
        _track_child_pid(proc.pid)

        # Start background output reader
        session._reader_task = asyncio.create_task(_read_process_output())

        # Start file watcher for the project directory
        file_watcher.start(
            "session",
            project_dir,
            _broadcast,
            asyncio.get_running_loop(),
        )

    await _broadcast({"type": "session_start", "data": {
        "provider": req.provider,
        "projectDir": project_dir,
        "pid": proc.pid,
    }})

    return JSONResponse(content={
        "started": True,
        "pid": proc.pid,
        "projectDir": project_dir,
        "provider": req.provider,
    })


@app.post("/api/session/quick-start")
async def quick_start_session(req: QuickStartRequest) -> JSONResponse:
    """Start a build from a one-line prompt. Auto-generates PRD and starts immediately."""
    prompt = req.prompt.strip()
    if not prompt:
        return JSONResponse(status_code=400, content={"error": "Prompt required"})
    if len(prompt.encode()) > _MAX_PRD_BYTES:
        return JSONResponse(status_code=400, content={"error": "Prompt exceeds size limit"})

    # Auto-generate a PRD from the one-liner
    prd_content = f"""# {prompt}

## Overview
{prompt}

## Requirements
- Implement the feature described above
- Create a clean, modern UI
- Include proper error handling
- Write tests where applicable
- Include Dockerfile and docker-compose.yml for containerized deployment

## Tech Stack
- Choose appropriate technologies based on the requirements
- Use modern frameworks and best practices

## Success Criteria
- The application works as described
- Clean, maintainable code
- Runs via docker compose up
"""

    # Delegate to start_session with the generated PRD
    start_req = StartRequest(prd=prd_content, provider=req.provider)
    result = await start_session(start_req)

    # Unwrap the JSONResponse to add session_id
    body = json.loads(result.body.decode())
    if body.get("started"):
        project_dir = body.get("projectDir", "")
        session_id = os.path.basename(project_dir)
        body["session_id"] = session_id
        body["project_dir"] = project_dir

    return JSONResponse(status_code=result.status_code, content=body)


@app.post("/api/session/stop")
async def stop_session() -> JSONResponse:
    """Stop the current loki session."""
    async with session._lock:
        if not session.running or session.process is None:
            return JSONResponse(content={"stopped": False, "message": "No session running"})

        proc = session.process

        # 1. Mark stopped first so reader task loop exits
        session.running = False

        # 2. Cancel reader task before killing process
        await session.cleanup()

        # 3. Kill the process group (catches child processes too)
        if sys.platform != "win32":
            try:
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    proc.terminate()
                except Exception:
                    pass
        else:
            try:
                subprocess.call(["taskkill", "/F", "/T", "/PID", str(proc.pid)])
            except Exception:
                try:
                    proc.terminate()
                except Exception:
                    pass

        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            if sys.platform != "win32":
                try:
                    pgid = os.getpgid(proc.pid)
                    os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    try:
                        proc.kill()
                    except Exception:
                        pass
            else:
                try:
                    proc.kill()
                except Exception:
                    pass
            try:
                proc.wait(timeout=3)
            except Exception:
                pass

        # Stop file watcher
        file_watcher.stop("session")

        # Stop dev server if running for this session
        # (The current active session uses "session" as its key for file_watcher
        # but dev servers are keyed by session_id from the URL. Stop all to be safe.)
        await dev_server_manager.stop_all()

        # Clean up any terminal PTYs
        for sid, pty in list(_terminal_ptys.items()):
            try:
                if pty.isalive():
                    pty.close(force=True)
            except Exception:
                pass
        _terminal_ptys.clear()
        _terminal_ws_clients.clear()
        _terminal_reader_tasks.clear()

        # Kill any orphaned loki-run processes for this project
        if session.project_dir:
            await asyncio.get_running_loop().run_in_executor(
                None, _kill_tracked_child_processes
            )

        await _broadcast({"type": "session_end", "data": {"message": "Session stopped by user"}})

        # Reset session state so it can be reused
        session.reset()

    return JSONResponse(content={"stopped": True, "message": "Session stopped"})


@app.get("/api/session/status")
async def get_status() -> JSONResponse:
    """Get current session status."""
    # Check if process is still alive (read-only -- do not mutate session.running
    # here; that is handled by _read_process_output under the lock)
    is_running = session.running
    if session.process and is_running:
        if session.process.poll() is not None:
            is_running = False

    # Try to read .loki state files for richer status
    loki_dir = _loki_dir()
    phase = "idle"
    iteration = 0
    complexity = "standard"
    current_task = ""
    pending_tasks = 0
    max_iterations = 0
    cost_usd = 0.0

    state_file = loki_dir / "state" / "session.json"
    if state_file.exists():
        try:
            with open(state_file) as f:
                state = json.load(f)
            phase = state.get("phase", phase)
            iteration = state.get("iteration", iteration)
            complexity = state.get("complexity", complexity)
            current_task = state.get("current_task", current_task)
            pending_tasks = state.get("pending_tasks", pending_tasks)
            # Extract cost from tokens object if present
            tokens = state.get("tokens")
            if isinstance(tokens, dict):
                cost_usd = float(tokens.get("cost_usd", 0) or 0)
        except (json.JSONDecodeError, OSError):
            pass

    # Read max_iterations from autonomy state
    autonomy_state = loki_dir / "autonomy-state.json"
    if autonomy_state.exists():
        try:
            with open(autonomy_state) as f:
                astate = json.load(f)
            max_iterations = int(astate.get("maxIterations", 0) or 0)
        except (json.JSONDecodeError, OSError, ValueError):
            pass

    # Fall back: read LOKI_MAX_ITERATIONS env or config
    if max_iterations <= 0:
        config_file = loki_dir / "config.yaml"
        if config_file.exists():
            try:
                with open(config_file) as f:
                    for line in f:
                        if "max_iterations" in line:
                            parts = line.split(":")
                            if len(parts) >= 2:
                                max_iterations = int(parts[-1].strip())
                                break
            except (OSError, ValueError):
                pass
    if max_iterations <= 0:
        max_iterations = int(os.environ.get("LOKI_MAX_ITERATIONS", "10"))

    uptime = time.time() - session.start_time if is_running else 0

    return JSONResponse(content={
        "running": is_running,
        "paused": session.paused,
        "phase": phase,
        "iteration": iteration,
        "complexity": complexity,
        "mode": "autonomous",
        "provider": session.provider,
        "current_task": current_task,
        "pending_tasks": pending_tasks,
        "running_agents": 0,
        "uptime": round(uptime),
        "version": "",
        "pid": str(session.process.pid) if session.process else "",
        "projectDir": session.project_dir,
        "max_iterations": max_iterations,
        "cost": round(cost_usd, 4),
        "start_time": session.start_time if session.start_time > 0 else 0,
    })


@app.get("/api/session/logs")
async def get_logs(lines: int = 200) -> JSONResponse:
    """Get recent log lines."""
    recent = session.log_lines[-lines:] if session.log_lines else []
    entries = []
    for line in recent:
        level = "info"
        lower = line.lower()
        if "error" in lower or "fail" in lower:
            level = "error"
        elif "warn" in lower:
            level = "warning"
        elif "debug" in lower:
            level = "debug"
        entries.append({
            "timestamp": "",
            "level": level,
            "message": line,
            "source": "loki",
        })
    return JSONResponse(content=entries)


@app.get("/api/session/agents")
async def get_agents() -> JSONResponse:
    """Get agent status from .loki state."""
    loki_dir = _loki_dir()
    agents_file = loki_dir / "state" / "agents.json"
    if agents_file.exists():
        try:
            with open(agents_file) as f:
                agents = json.load(f)
            if isinstance(agents, list):
                return JSONResponse(content=agents)
        except (json.JSONDecodeError, OSError):
            pass
    return JSONResponse(content=[])


@app.get("/api/session/files")
async def get_files() -> JSONResponse:
    """Get the project file tree."""
    if not session.project_dir:
        return JSONResponse(content=[])

    root = Path(session.project_dir)
    if not root.is_dir():
        return JSONResponse(content=[])

    tree = _build_file_tree(root)
    return JSONResponse(content=tree)


@app.get("/api/session/files/content")
async def get_file_content(path: str = "") -> JSONResponse:
    """Get file content with path traversal protection."""
    if not session.project_dir or not path:
        return JSONResponse(status_code=400, content={"error": "No active session or path"})

    base = Path(session.project_dir).resolve()
    resolved = _safe_resolve(base, path)
    if resolved is None or not resolved.is_file():
        return JSONResponse(status_code=404, content={"error": "File not found"})

    # Limit file size to 1MB
    try:
        size = resolved.stat().st_size
        if size > 1_048_576:
            return JSONResponse(
                status_code=413,
                content={"error": f"File too large ({size:,} bytes, limit 1MB)"},
            )
        content = resolved.read_text(errors="replace")
    except OSError as e:
        return JSONResponse(
            status_code=500,
            content={"error": f"Cannot read file: {e}"},
        )
    except UnicodeDecodeError as e:
        return JSONResponse(
            status_code=422,
            content={"error": f"Binary or unreadable file: {e}"},
        )

    return JSONResponse(content={"content": content})


@app.get("/api/session/memory")
async def get_memory() -> JSONResponse:
    """Get memory summary from .loki state."""
    loki_dir = _loki_dir()
    memory_dir = loki_dir / "memory"
    if not memory_dir.is_dir():
        return JSONResponse(content={
            "episodic_count": 0,
            "semantic_count": 0,
            "skill_count": 0,
            "total_tokens": 0,
            "last_consolidation": None,
        })

    episodic = len(list((memory_dir / "episodic").glob("*.json"))) if (memory_dir / "episodic").is_dir() else 0
    semantic = len(list((memory_dir / "semantic").glob("*.json"))) if (memory_dir / "semantic").is_dir() else 0
    skills = len(list((memory_dir / "skills").glob("*.json"))) if (memory_dir / "skills").is_dir() else 0

    return JSONResponse(content={
        "episodic_count": episodic,
        "semantic_count": semantic,
        "skill_count": skills,
        "total_tokens": 0,
        "last_consolidation": None,
    })


@app.get("/api/session/checklist")
async def get_checklist() -> JSONResponse:
    """Get quality gates checklist from .loki state."""
    loki_dir = _loki_dir()
    checklist_file = loki_dir / "state" / "checklist.json"
    if checklist_file.exists():
        try:
            with open(checklist_file) as f:
                data = json.load(f)
            return JSONResponse(content=data)
        except (json.JSONDecodeError, OSError):
            pass
    return JSONResponse(content={
        "total": 0, "passed": 0, "failed": 0, "skipped": 0, "pending": 0, "items": [],
    })


@app.get("/api/session/prd-prefill")
async def get_prd_prefill() -> JSONResponse:
    """Return PRD content from PURPLE_LAB_PRD env var (set by CLI --prd flag)."""
    content = os.environ.get("PURPLE_LAB_PRD")
    return JSONResponse(content={"content": content})


@app.post("/api/session/pause")
async def pause_session() -> JSONResponse:
    """Pause the current loki session by sending SIGUSR1."""
    if not session.running or session.process is None:
        return JSONResponse(content={"paused": False, "message": "No session running"})
    try:
        os.kill(session.process.pid, signal.SIGUSR1)
    except ProcessLookupError:
        return JSONResponse(content={"paused": False, "message": "Process not found"})
    except Exception as e:
        return JSONResponse(content={"paused": False, "message": str(e)})
    session.paused = True
    await _broadcast({"type": "session_paused", "data": {}})
    return JSONResponse(content={"paused": True})


@app.post("/api/session/resume")
async def resume_session() -> JSONResponse:
    """Resume the current loki session by sending SIGUSR2."""
    if not session.running or session.process is None:
        return JSONResponse(content={"resumed": False, "message": "No session running"})
    try:
        os.kill(session.process.pid, signal.SIGUSR2)
    except ProcessLookupError:
        return JSONResponse(content={"resumed": False, "message": "Process not found"})
    except Exception as e:
        return JSONResponse(content={"resumed": False, "message": str(e)})
    session.paused = False
    await _broadcast({"type": "session_resumed", "data": {}})
    return JSONResponse(content={"resumed": True})


@app.get("/api/templates")
async def get_templates() -> JSONResponse:
    """List available PRD templates with description and category."""
    templates_dir = PROJECT_ROOT / "templates"
    if not templates_dir.is_dir():
        return JSONResponse(content=[])

    # Category mapping from filename
    _category_map = {
        'static-landing-page': 'Website', 'blog-platform': 'Website', 'e-commerce': 'Website',
        'full-stack-demo': 'Website', 'dashboard': 'Website',
        'rest-api': 'API', 'rest-api-auth': 'API', 'api-only': 'API', 'microservice': 'API',
        'cli-tool': 'CLI', 'npm-library': 'CLI',
        'discord-bot': 'Bot', 'slack-bot': 'Bot', 'ai-chatbot': 'Bot',
        'data-pipeline': 'Data', 'web-scraper': 'Data',
    }

    templates = []
    for f in sorted(templates_dir.glob("*.md")):
        name = f.stem.replace("-", " ").replace("_", " ").title()
        # Extract description: first non-heading, non-blank paragraph
        description = ""
        try:
            text = f.read_text(errors="replace")
            for line in text.splitlines():
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                description = stripped[:200]
                break
        except OSError:
            pass
        category = _category_map.get(f.stem, "Other")
        templates.append({
            "name": name,
            "filename": f.name,
            "description": description,
            "category": category,
        })
    return JSONResponse(content=templates)


@app.get("/api/templates/{filename}")
async def get_template_content(filename: str) -> JSONResponse:
    """Get a specific template's content."""
    templates_dir = PROJECT_ROOT / "templates"
    resolved = _safe_resolve(templates_dir, filename)
    if resolved is None or not resolved.is_file():
        return JSONResponse(status_code=404, content={"error": "Template not found"})

    try:
        content = resolved.read_text()
    except OSError:
        return JSONResponse(status_code=500, content={"error": "Cannot read template"})

    return JSONResponse(content={"name": filename, "content": content})


# ---------------------------------------------------------------------------
# New GTM endpoints: plan, report, share, provider, metrics, history, onboard
# ---------------------------------------------------------------------------

def _find_loki_cli() -> Optional[str]:
    """Locate the loki CLI binary reliably."""
    import shutil
    # 1. Known project-local path
    if LOKI_CLI.exists():
        return str(LOKI_CLI)
    # 2. shutil.which on PATH
    found = shutil.which("loki")
    if found:
        return found
    return None


def _run_loki_cmd(args: list, cwd: Optional[str] = None, timeout: int = 60) -> tuple[int, str]:
    """Run a loki CLI command and return (returncode, combined output).

    Uses list form -- never shell=True with user input.
    On timeout, the subprocess is explicitly killed to avoid orphaned processes.
    """
    loki = _find_loki_cli()
    if loki is None:
        return (1, "loki CLI not found")
    full_cmd = [loki] + args
    try:
        proc = subprocess.Popen(
            full_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            cwd=cwd or session.project_dir or str(Path.home()),
            env={**os.environ},
        )
        try:
            stdout, _ = proc.communicate(timeout=timeout)
            return (proc.returncode, stdout or "")
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            return (1, "Command timed out")
    except Exception as e:
        return (1, str(e))


@app.post("/api/session/plan")
async def plan_session(req: PlanRequest) -> JSONResponse:
    """Run loki plan dry-run analysis and return structured result."""
    if len(req.prd.encode()) > _MAX_PRD_BYTES:
        return JSONResponse(status_code=400, content={"error": "PRD exceeds 1 MB limit"})
    import tempfile
    with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
        f.write(req.prd)
        prd_tmp = f.name
    try:
        rc, output = await asyncio.get_running_loop().run_in_executor(
            None, lambda: _run_loki_cmd(["plan", prd_tmp], timeout=90)
        )
    finally:
        try:
            os.unlink(prd_tmp)
        except OSError:
            pass

    # Try to parse structured JSON from output first (loki plan may emit JSON blocks)
    _log = logging.getLogger("purple-lab.plan")

    complexity = "standard"
    cost_estimate = "unknown"
    iterations = 5
    phases: list[str] = []
    parsed = False

    # Look for any JSON object containing plan-related keys (supports nested braces)
    json_match = re.search(r'\{[^{}]*"complexity"[^{}]*\}', output, re.DOTALL)
    if not json_match:
        json_match = re.search(r'\{[^{}]*"iterations"[^{}]*\}', output, re.DOTALL)
    if json_match:
        try:
            data = json.loads(json_match.group(0))
            if isinstance(data.get("complexity"), dict):
                complexity = data["complexity"].get("tier", "standard")
            elif isinstance(data.get("complexity"), str):
                complexity = data["complexity"]
            if isinstance(data.get("cost"), dict):
                total = data["cost"].get("total_usd") or data["cost"].get("total", 0)
                try:
                    cost_estimate = f"${float(total):.2f}"
                except (ValueError, TypeError):
                    _log.warning("Could not parse cost value: %r", total)
            elif isinstance(data.get("cost_estimate"), str):
                cost_estimate = data["cost_estimate"]
            if isinstance(data.get("iterations"), dict):
                iterations = data["iterations"].get("estimated", 5)
            elif isinstance(data.get("iterations"), (int, float)):
                iterations = int(data["iterations"])
            if isinstance(data.get("execution_plan"), list):
                phases = [p.get("focus", "") for p in data["execution_plan"] if isinstance(p, dict) and p.get("focus")]
            elif isinstance(data.get("phases"), list):
                phases = [p for p in data["phases"] if isinstance(p, str)]
            parsed = True
        except (json.JSONDecodeError, TypeError, KeyError) as exc:
            _log.warning("JSON plan block found but failed to parse: %s", exc)

    # Fallback: line-by-line text parsing with tighter patterns
    if not parsed:
        _log.info("No JSON plan block found, falling back to text parsing")
        for line in output.splitlines():
            stripped = re.sub(r'\x1b\[[0-9;]*m', '', line)  # strip ANSI codes
            lower = stripped.lower().strip()
            if not lower:
                continue
            # Complexity detection: match "complexity: standard" or "Complexity Tier: complex" etc.
            if re.search(r'complexity\s*(?:tier)?\s*[:=]', lower):
                for val in ("simple", "standard", "complex", "expert"):
                    if re.search(rf'\b{val}\b', lower):
                        complexity = val
                        break
            # Cost parsing: look for dollar amounts in cost/estimate lines
            if ("cost" in lower or "estimate" in lower) and "$" in stripped:
                m = re.search(r"\$[\d,]+\.?\d*", stripped)
                if m:
                    cost_estimate = m.group(0)
            # Iteration count
            if re.search(r'iterations?\s*[:=]\s*\d+', lower):
                m = re.search(r'iterations?\s*[:=]\s*(\d+)', lower)
                if m:
                    iterations = int(m.group(1))
            # Phase/step lines
            if re.match(r'^\s*(phase|step)\s+\d', lower):
                for phase_name in ("planning", "implementation", "testing", "review", "deployment"):
                    if re.search(rf'\b{phase_name}\b', lower) and phase_name not in phases:
                        phases.append(phase_name)

    if not parsed and not phases:
        _log.info("Plan parse produced no phases from output (%d chars)", len(output))

    return JSONResponse(content={
        "complexity": complexity,
        "cost_estimate": cost_estimate,
        "iterations": iterations,
        "phases": phases if phases else ["planning", "implementation", "testing"],
        "output_text": output,
        "returncode": rc,
    })


@app.post("/api/session/report")
async def generate_report(req: ReportRequest) -> JSONResponse:
    """Run loki report and return content."""
    fmt = req.format if req.format in ("html", "markdown") else "markdown"
    rc, output = await asyncio.get_running_loop().run_in_executor(
        None, lambda: _run_loki_cmd(["report", "--format", fmt], timeout=60)
    )
    return JSONResponse(content={
        "content": output,
        "format": fmt,
        "returncode": rc,
    })


@app.post("/api/session/share")
async def share_session() -> JSONResponse:
    """Run loki share and return Gist URL."""
    rc, output = await asyncio.get_running_loop().run_in_executor(
        None, lambda: _run_loki_cmd(["share"], timeout=60)
    )
    # Try to extract URL from output
    url_match = re.search(r"https://gist\.github\.com/\S+", output)
    url = url_match.group(0) if url_match else ""
    return JSONResponse(content={
        "url": url,
        "output": output,
        "returncode": rc,
    })


@app.get("/api/provider/current")
async def get_provider() -> JSONResponse:
    """Return current provider and model from session state or config."""
    provider = session.provider or os.environ.get("LOKI_PROVIDER", "claude")
    # Try to read from config
    config_file = Path.home() / ".loki" / "config.json"
    model = ""
    if config_file.exists():
        try:
            with open(config_file) as f:
                cfg = json.load(f)
            provider = cfg.get("provider", provider)
            model = cfg.get("model", model)
        except (json.JSONDecodeError, OSError):
            pass
    return JSONResponse(content={"provider": provider, "model": model})


@app.post("/api/provider/set")
async def set_provider(req: ProviderSetRequest) -> JSONResponse:
    """Set the default provider for future sessions."""
    allowed = {"claude", "codex", "gemini"}
    if req.provider not in allowed:
        return JSONResponse(
            status_code=400,
            content={"error": f"Invalid provider. Must be one of: {', '.join(sorted(allowed))}"},
        )
    # Persist to config
    config_dir = Path.home() / ".loki"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_file = config_dir / "config.json"
    cfg: dict = {}
    if config_file.exists():
        try:
            with open(config_file) as f:
                cfg = json.load(f)
        except (json.JSONDecodeError, OSError):
            cfg = {}
    cfg["provider"] = req.provider
    with open(config_file, "w") as f:
        json.dump(cfg, f, indent=2)
    # Update session state if not running
    if not session.running:
        session.provider = req.provider
    return JSONResponse(content={"provider": req.provider, "set": True})


@app.get("/api/session/metrics")
async def get_metrics() -> JSONResponse:
    """Run loki metrics --json and return parsed output."""
    rc, output = await asyncio.get_running_loop().run_in_executor(
        None, lambda: _run_loki_cmd(["metrics", "--json"], timeout=30)
    )
    # Try JSON parse
    try:
        data = json.loads(output)
        return JSONResponse(content=data)
    except (json.JSONDecodeError, ValueError):
        pass
    # Fallback: parse key metrics from text output
    metrics: dict = {
        "iterations": 0,
        "quality_gate_pass_rate": 0.0,
        "time_elapsed": "",
        "tokens_used": 0,
        "output_text": output,
    }
    for line in output.splitlines():
        if "iteration" in line.lower():
            m = re.search(r"(\d+)", line)
            if m:
                metrics["iterations"] = int(m.group(1))
        if "pass rate" in line.lower() or "pass_rate" in line.lower():
            m = re.search(r"([\d.]+)%?", line)
            if m:
                metrics["quality_gate_pass_rate"] = float(m.group(1))
        if "token" in line.lower():
            m = re.search(r"(\d+)", line)
            if m:
                metrics["tokens_used"] = int(m.group(1))
    return JSONResponse(content=metrics)


def _infer_session_status(entry: Path) -> str:
    """Infer session status from project directory contents."""
    # 1. Check .loki/state/session.json for explicit phase
    state_file = entry / ".loki" / "state" / "session.json"
    if state_file.exists():
        try:
            with open(state_file) as f:
                st = json.load(f)
            phase = st.get("phase", "")
            if phase and phase != "idle":
                # Verify the session is actually still running by checking
                # if session.json was modified recently (within last 5 min)
                try:
                    mtime = state_file.stat().st_mtime
                    if time.time() - mtime > 300:  # 5 minutes stale
                        return "completed"  # Process died, mark as completed
                except OSError:
                    pass
                return phase
        except (json.JSONDecodeError, OSError):
            pass

    # 2. Check .loki/autonomy-state.json (run.sh writes this)
    for state_name in ("autonomy-state.json", ".loki/autonomy-state.json"):
        sf = entry / state_name
        if sf.exists():
            try:
                with open(sf) as f:
                    st = json.load(f)
                if st.get("completed") or st.get("status") == "completed":
                    return "completed"
                if st.get("status"):
                    status_val = st["status"]
                    # If status indicates active work, verify freshness
                    if status_val in ("running", "in_progress", "planning"):
                        try:
                            mtime = sf.stat().st_mtime
                            if time.time() - mtime > 300:  # 5 minutes stale
                                return "completed"
                        except OSError:
                            pass
                    return status_val
            except (json.JSONDecodeError, OSError):
                pass

    # 3. Infer from file contents
    files = set()
    try:
        files = {f.name for f in entry.iterdir() if not f.name.startswith(".")}
    except OSError:
        pass

    source_extensions = {".js", ".ts", ".tsx", ".py", ".html", ".css", ".go", ".rs", ".java", ".rb"}
    has_source = any(
        (entry / f).suffix in source_extensions
        for f in files
        if (entry / f).is_file()
    )
    has_prd = "PRD.md" in files or "prd.md" in files

    if has_source:
        return "completed"
    if has_prd and len(files) <= 2:
        return "started"
    if has_prd:
        return "in_progress"

    return "empty"


@app.get("/api/sessions/history")
async def get_sessions_history() -> JSONResponse:
    """Return list of past loki sessions from ~/purple-lab-projects/ etc."""
    history: list[dict] = []
    search_dirs = [
        Path.home() / "purple-lab-projects",
        Path.home() / ".loki-sessions",
        Path.home() / ".loki" / "sessions",
    ]
    for base_dir in search_dirs:
        if not base_dir.is_dir():
            continue
        for entry in sorted(base_dir.iterdir(), reverse=True)[:20]:
            if not entry.is_dir():
                continue
            session_info: dict = {
                "id": entry.name,
                "path": str(entry),
                "date": "",
                "prd_snippet": "",
                "status": _infer_session_status(entry),
            }
            # Read timestamp from directory mtime
            try:
                mtime = entry.stat().st_mtime
                session_info["date"] = time.strftime("%Y-%m-%d %H:%M", time.localtime(mtime))
            except OSError:
                pass
            # Try to read PRD
            for prd_name in ("PRD.md", "prd.md", ".loki/prd.md"):
                prd_file = entry / prd_name
                if prd_file.exists():
                    try:
                        text = prd_file.read_text(errors="replace")
                        lines = [l.strip() for l in text.splitlines() if l.strip()]
                        session_info["prd_snippet"] = lines[0][:120] if lines else ""
                    except OSError:
                        pass
                    break
            # Count project files for progress indication
            try:
                file_count = sum(1 for f in entry.rglob("*") if f.is_file()
                                 and ".git" not in f.parts and "node_modules" not in f.parts
                                 and "__pycache__" not in f.parts)
                session_info["file_count"] = file_count
            except OSError:
                session_info["file_count"] = 0

            history.append(session_info)
    return JSONResponse(content=history)


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> JSONResponse:
    """Delete a session and all its files, processes, and state."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})

    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    # Prevent deleting the currently active session directory
    if session.project_dir and Path(session.project_dir).resolve() == target.resolve():
        return JSONResponse(status_code=409, content={"error": "Cannot delete the currently active session. Stop it first."})

    # 1. Stop Docker containers for this project (before stopping dev server)
    try:
        for compose_file in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
            if (target / compose_file).exists():
                subprocess.run(
                    ["docker", "compose", "-f", str(target / compose_file), "down", "--volumes", "--remove-orphans"],
                    cwd=str(target), capture_output=True, timeout=30,
                )
                break
    except Exception:
        pass

    # 2. Stop dev server if running
    if session_id in dev_server_manager.servers:
        await dev_server_manager.stop(session_id)

    # 4. Stop file watcher if running
    file_watcher.stop(session_id)

    # 5. Close terminal PTY if open
    pty = _terminal_ptys.get(session_id)
    if pty:
        try:
            pty.close()
        except Exception:
            pass
        _terminal_ptys.pop(session_id, None)

    # 6. Delete project directory (including node_modules, .loki, everything)
    import shutil
    try:
        shutil.rmtree(str(target))
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to delete: {e}"})

    return JSONResponse(content={"deleted": True, "path": str(target)})


@app.get("/api/sessions/{session_id}")
async def get_session_detail(session_id: str) -> JSONResponse:
    """Get details of a past session for read-only viewing."""
    # Validate session_id format (prevent path traversal)
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})

    search_dirs = [
        Path.home() / "purple-lab-projects",
        Path.home() / ".loki-sessions",
        Path.home() / ".loki" / "sessions",
    ]
    target: Optional[Path] = None
    for base_dir in search_dirs:
        candidate = base_dir / session_id
        if candidate.is_dir():
            target = candidate
            break

    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    # Read PRD
    prd_content = ""
    for prd_name in ("PRD.md", "prd.md", ".loki/prd.md"):
        prd_file = target / prd_name
        if prd_file.exists():
            try:
                prd_content = prd_file.read_text(errors="replace")
            except OSError:
                pass
            break

    # Build file tree
    files = _build_file_tree(target)

    # Read logs if available
    log_lines: list[str] = []
    for log_name in (".loki/logs/session.log", ".loki/session.log", "loki.log"):
        log_file = target / log_name
        if log_file.exists():
            try:
                text = log_file.read_text(errors="replace")
                log_lines = text.splitlines()[-200:]
            except OSError:
                pass
            break

    # Status
    status = _infer_session_status(target)

    return JSONResponse(content={
        "id": session_id,
        "path": str(target),
        "status": status,
        "prd": prd_content,
        "files": files,
        "logs": log_lines,
    })


@app.get("/api/sessions/{session_id}/file")
async def get_session_file(session_id: str, path: str = "") -> JSONResponse:
    """Get file content from a past session with path traversal protection."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id) or not path:
        return JSONResponse(status_code=400, content={"error": "Invalid session ID or path"})

    search_dirs = [
        Path.home() / "purple-lab-projects",
        Path.home() / ".loki-sessions",
        Path.home() / ".loki" / "sessions",
    ]
    target: Optional[Path] = None
    for base_dir in search_dirs:
        candidate = base_dir / session_id
        if candidate.is_dir():
            target = candidate
            break

    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    base = target.resolve()
    resolved = _safe_resolve(base, path)
    if resolved is None or not resolved.is_file():
        return JSONResponse(status_code=404, content={"error": "File not found"})

    try:
        size = resolved.stat().st_size
        if size > 1_048_576:
            return JSONResponse(content={"content": f"[File too large: {size:,} bytes]"})
        content = resolved.read_text(errors="replace")
    except (OSError, UnicodeDecodeError) as e:
        return JSONResponse(content={"content": f"[Cannot read file: {e}]"})

    return JSONResponse(content={"content": content})


@app.get("/api/sessions/{session_id}/preview/{file_path:path}")
async def preview_session_file(session_id: str, file_path: str = "index.html") -> FileResponse:
    """Serve a file from a past session's project directory with correct MIME type.

    This enables live preview of built projects -- HTML files can load their
    relative CSS, JS, and image assets correctly.
    """
    import mimetypes
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})

    search_dirs = [
        Path.home() / "purple-lab-projects",
        Path.home() / ".loki-sessions",
        Path.home() / ".loki" / "sessions",
    ]
    target: Optional[Path] = None
    for base_dir in search_dirs:
        candidate = base_dir / session_id
        if candidate.is_dir():
            target = candidate
            break

    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    if not file_path:
        file_path = "index.html"

    resolved = _safe_resolve(target, file_path)
    if resolved is None or not resolved.is_file():
        return JSONResponse(status_code=404, content={"error": "File not found"})

    # Determine MIME type
    mime_type, _ = mimetypes.guess_type(str(resolved))
    if mime_type is None:
        mime_type = "application/octet-stream"

    return FileResponse(str(resolved), media_type=mime_type)


@app.put("/api/sessions/{session_id}/file")
async def save_session_file(session_id: str, req: FileWriteRequest) -> JSONResponse:
    """Save or update file content in a session's project directory."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    if not req.path:
        return JSONResponse(status_code=400, content={"error": "Path is required"})
    if len(req.content.encode("utf-8", errors="replace")) > 1_048_576:
        return JSONResponse(status_code=413, content={"error": "Content exceeds 1 MB limit"})

    search_dirs = [
        Path.home() / "purple-lab-projects",
        Path.home() / ".loki-sessions",
        Path.home() / ".loki" / "sessions",
    ]
    target: Optional[Path] = None
    for base_dir in search_dirs:
        candidate = base_dir / session_id
        if candidate.is_dir():
            target = candidate
            break

    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    base = target.resolve()
    resolved = _safe_resolve(base, req.path)
    if resolved is None:
        return JSONResponse(status_code=400, content={"error": "Invalid path (traversal blocked)"})

    # Atomic write: write to .tmp then rename
    tmp_path = resolved.with_suffix(resolved.suffix + ".tmp")
    try:
        tmp_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path.write_text(req.content, encoding="utf-8")
        tmp_path.rename(resolved)
    except OSError as e:
        # Clean up temp file on failure
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        return JSONResponse(status_code=500, content={"error": f"Failed to write file: {e}"})

    return JSONResponse(content={"saved": True, "path": req.path})


@app.post("/api/sessions/{session_id}/file")
async def create_session_file(session_id: str, req: FileWriteRequest) -> JSONResponse:
    """Create a new file in a session's project directory."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    if not req.path:
        return JSONResponse(status_code=400, content={"error": "Path is required"})

    search_dirs = [
        Path.home() / "purple-lab-projects",
        Path.home() / ".loki-sessions",
        Path.home() / ".loki" / "sessions",
    ]
    target: Optional[Path] = None
    for base_dir in search_dirs:
        candidate = base_dir / session_id
        if candidate.is_dir():
            target = candidate
            break

    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    base = target.resolve()
    resolved = _safe_resolve(base, req.path)
    if resolved is None:
        return JSONResponse(status_code=400, content={"error": "Invalid path (traversal blocked)"})

    if resolved.exists():
        return JSONResponse(status_code=409, content={"error": "File already exists"})

    try:
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text(req.content, encoding="utf-8")
    except OSError as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to create file: {e}"})

    return JSONResponse(content={"created": True, "path": req.path})


@app.delete("/api/sessions/{session_id}/file")
async def delete_session_file(session_id: str, req: FileDeleteRequest) -> JSONResponse:
    """Delete a file from a session's project directory."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    if not req.path:
        return JSONResponse(status_code=400, content={"error": "Path is required"})

    search_dirs = [
        Path.home() / "purple-lab-projects",
        Path.home() / ".loki-sessions",
        Path.home() / ".loki" / "sessions",
    ]
    target: Optional[Path] = None
    for base_dir in search_dirs:
        candidate = base_dir / session_id
        if candidate.is_dir():
            target = candidate
            break

    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    base = target.resolve()
    resolved = _safe_resolve(base, req.path)
    if resolved is None:
        return JSONResponse(status_code=400, content={"error": "Invalid path (traversal blocked)"})

    if not resolved.exists():
        return JSONResponse(status_code=404, content={"error": "File not found"})

    if resolved.is_dir():
        return JSONResponse(status_code=400, content={"error": "Cannot delete directories, only files"})

    try:
        resolved.unlink()
    except OSError as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to delete file: {e}"})

    return JSONResponse(content={"deleted": True, "path": req.path})


@app.post("/api/sessions/{session_id}/directory")
async def create_session_directory(session_id: str, req: DirectoryCreateRequest) -> JSONResponse:
    """Create a directory in a session's project directory."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    if not req.path:
        return JSONResponse(status_code=400, content={"error": "Path is required"})

    search_dirs = [
        Path.home() / "purple-lab-projects",
        Path.home() / ".loki-sessions",
        Path.home() / ".loki" / "sessions",
    ]
    target: Optional[Path] = None
    for base_dir in search_dirs:
        candidate = base_dir / session_id
        if candidate.is_dir():
            target = candidate
            break

    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    base = target.resolve()
    resolved = _safe_resolve(base, req.path)
    if resolved is None:
        return JSONResponse(status_code=400, content={"error": "Invalid path (traversal blocked)"})

    if resolved.exists():
        return JSONResponse(status_code=409, content={"error": "Path already exists"})

    try:
        resolved.mkdir(parents=True, exist_ok=False)
    except FileExistsError:
        return JSONResponse(status_code=409, content={"error": "Directory already exists"})
    except OSError as e:
        return JSONResponse(status_code=500, content={"error": f"Failed to create directory: {e}"})

    return JSONResponse(content={"created": True, "path": req.path})


@app.post("/api/session/onboard")
async def onboard_session(req: OnboardRequest) -> JSONResponse:
    """Run loki onboard on a path and return CLAUDE.md content."""
    # Path traversal protection: must be absolute, exist, and within home directory
    try:
        target = Path(req.path).resolve()
    except (ValueError, OSError):
        return JSONResponse(status_code=400, content={"error": "Invalid path"})
    home = Path.home().resolve()
    try:
        target.relative_to(home)
    except ValueError:
        return JSONResponse(status_code=400, content={"error": "Path must be within your home directory"})
    if not target.exists():
        return JSONResponse(status_code=400, content={"error": "Path does not exist"})
    if not target.is_dir():
        return JSONResponse(status_code=400, content={"error": "Path must be a directory"})

    rc, output = await asyncio.get_running_loop().run_in_executor(
        None, lambda: _run_loki_cmd(["onboard", str(target)], cwd=str(target), timeout=120)
    )
    # Try to read generated CLAUDE.md
    claude_md = target / "CLAUDE.md"
    claude_content = ""
    if claude_md.exists():
        try:
            claude_content = claude_md.read_text(errors="replace")
        except OSError:
            pass
    return JSONResponse(content={
        "output": output,
        "claude_md": claude_content,
        "returncode": rc,
    })


# ---------------------------------------------------------------------------
# CLI feature endpoints (chat, review, test, explain, export)
# ---------------------------------------------------------------------------


@app.post("/api/sessions/{session_id}/chat")
async def chat_session(session_id: str, req: ChatRequest) -> JSONResponse:
    """Start a chat command (non-blocking). Returns task_id for polling."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    # Clean up old completed tasks to prevent unbounded memory growth
    _cleanup_chat_tasks()
    task = ChatTask()
    _chat_tasks[task.id] = task

    async def run_chat() -> None:
        proc: Optional[subprocess.Popen] = None
        loki = _find_loki_cli()
        if loki is None:
            task.output_lines = ["loki CLI not found"]
            task.returncode = 1
            task.complete = True
            return
        # All chat modes use 'loki quick' with the user's message as the task.
        # This runs claude (or configured provider) in the project directory
        # to make changes based on the user's prompt -- works both during
        # active sessions and post-completion for iterative development.

        # -- Phase 1: Inject project context (dev server errors, gate failures) --
        context_parts = [req.message]

        # Inject dev server errors if the server has crashed
        ds_info = dev_server_manager.servers.get(session_id)
        if ds_info and ds_info.get("status") == "error":
            error_lines = ds_info.get("output_lines", [])[-30:]
            if error_lines:
                context_parts.append(
                    "\n\nDEV SERVER ERROR (fix this):\n" + "\n".join(error_lines)
                )

        # Phase 1.5: Inject Docker Compose context
        ds_info_docker = dev_server_manager.servers.get(session_id)
        if ds_info_docker and ds_info_docker.get("framework") == "docker":
            try:
                docker_ctx = await _gather_docker_context(target)
                if docker_ctx.get("failing_services"):
                    context_parts.append("\n\nDOCKER SERVICE STATUS:\n" + json.dumps(docker_ctx["service_status"], indent=2))
                    for svc_name, svc_logs in docker_ctx.get("service_logs", {}).items():
                        if svc_name != "_combined":
                            context_parts.append(f"\n\nFAILING SERVICE '{svc_name}' LOGS:\n{svc_logs}")
                    diagnoses = _diagnose_errors("\n".join(docker_ctx.get("service_logs", {}).values()))
                    if diagnoses:
                        context_parts.append("\n\nAUTO-DIAGNOSIS:\n" + "\n".join(
                            f"- {d['diagnosis']}: {d['suggestion']}" for d in diagnoses))
                if docker_ctx.get("project_structure"):
                    context_parts.append("\n\nPROJECT FILES:\n" + docker_ctx["project_structure"])
            except Exception:
                logger.debug("Docker context gathering failed", exc_info=True)

        # Inject quality gate failures if any
        gate_file = target / ".loki" / "quality" / "gate-failures.txt"
        if gate_file.exists():
            try:
                gate_text = gate_file.read_text()[:2000]
                if gate_text.strip():
                    context_parts.append(
                        "\n\nQUALITY GATE FAILURES:\n" + gate_text
                    )
            except OSError:
                pass

        full_message = "\n".join(context_parts)

        # Inject Docker Compose requirement into prompts so generated projects
        # always include a docker-compose.yml for containerized execution.
        docker_note = " (IMPORTANT: include a Dockerfile and docker-compose.yml so the app runs in a container via 'docker compose up')"
        docker_instructions_file = SCRIPT_DIR / "docker-instructions.md"
        docker_extra = ""
        if docker_instructions_file.exists():
            try:
                docker_extra = "\n\n" + docker_instructions_file.read_text()
            except OSError:
                pass
        if req.mode == "max":
            # Max mode: full loki start with the message as a PRD
            prd_path = target / ".loki" / "chat-prd.md"
            prd_path.parent.mkdir(parents=True, exist_ok=True)
            prd_content = full_message + "\n\n## Deployment\nMUST include Dockerfile and docker-compose.yml for containerized execution." + docker_extra
            prd_path.write_text(prd_content)
            cmd_args = [loki, "start", "--provider", "claude", str(prd_path)]
        else:
            # Quick and Standard both use 'loki quick' -- fast, focused changes
            cmd_args = [loki, "quick", full_message + docker_note]
        try:
            chat_env = {**os.environ}
            chat_env.update(_load_secrets())
            proc = subprocess.Popen(
                cmd_args,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                cwd=str(target),
                env=chat_env,
                start_new_session=True,
            )
            task.process = proc
            _track_child_pid(proc.pid)
            loop = asyncio.get_running_loop()

            def _read_lines() -> None:
                """Read stdout line-by-line in a thread."""
                assert proc.stdout is not None
                for raw_line in proc.stdout:
                    if task.cancelled:
                        break
                    # Strip ANSI escape codes for clean display
                    clean = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', raw_line.rstrip("\n"))
                    # Filter out noisy tool-use output lines from Claude
                    stripped = clean.strip()
                    if stripped in ("[Tool: Read]", "[Tool: Bash]", "[Tool: Write]",
                                    "[Tool: Edit]", "[Tool: Grep]", "[Tool: Glob]",
                                    "[Result]", "[Thinking]"):
                        continue
                    if not stripped:
                        continue
                    # Skip npm noise lines
                    if any(noise in stripped for noise in ("npm warn", "npm notice", "npm WARN")):
                        continue
                    # Categorize file change lines for structured frontend display
                    if (stripped.startswith("Created ") or stripped.startswith("Modified ") or
                            stripped.startswith("Deleted ") or stripped.startswith("Wrote ")):
                        task.output_lines.append(f"__FILE_CHANGE__{clean}")
                    elif (stripped.startswith("$ ") or stripped.startswith("Running: ")):
                        task.output_lines.append(f"__COMMAND__{clean}")
                    else:
                        task.output_lines.append(clean)
                proc.stdout.close()

            await asyncio.wait_for(
                loop.run_in_executor(None, _read_lines),
                timeout=300,
            )
            proc.wait(timeout=10)
            task.returncode = proc.returncode
        except asyncio.TimeoutError:
            if proc is not None:
                try:
                    pgid = os.getpgid(proc.pid)
                    os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    proc.kill()
                proc.wait()
            task.output_lines.append("Command timed out after 5 minutes")
            task.returncode = 1
        except Exception as e:
            task.output_lines.append(str(e))
            task.returncode = 1
            if proc is not None and proc.poll() is None:
                try:
                    pgid = os.getpgid(proc.pid)
                    os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    proc.kill()
                proc.wait()
        # Detect changed files (both committed and uncommitted)
        try:
            changed = set()
            # Check uncommitted changes (working tree + staged)
            r1 = subprocess.run(
                ["git", "diff", "--name-only"],
                cwd=str(target), capture_output=True, text=True, timeout=10,
            )
            if r1.returncode == 0:
                changed.update(f for f in r1.stdout.strip().splitlines() if f)
            # Check staged changes
            r2 = subprocess.run(
                ["git", "diff", "--name-only", "--cached"],
                cwd=str(target), capture_output=True, text=True, timeout=10,
            )
            if r2.returncode == 0:
                changed.update(f for f in r2.stdout.strip().splitlines() if f)
            # Check recent commit if any
            r3 = subprocess.run(
                ["git", "diff", "--name-only", "HEAD~1"],
                cwd=str(target), capture_output=True, text=True, timeout=10,
            )
            if r3.returncode == 0:
                changed.update(f for f in r3.stdout.strip().splitlines() if f)
            task.files_changed = sorted(changed)
        except Exception:
            pass
        # Untrack the child PID now that the chat process is done
        if proc is not None:
            _untrack_child_pid(proc.pid)
        task.complete = True

    asyncio.create_task(run_chat())

    return JSONResponse(content={
        "task_id": task.id,
        "status": "running",
    })


@app.get("/api/sessions/{session_id}/chat/{task_id}")
async def get_chat_status(session_id: str, task_id: str) -> JSONResponse:
    """Poll chat task status and get partial output."""
    task = _chat_tasks.get(task_id)
    if task is None:
        return JSONResponse(status_code=404, content={"error": "Task not found"})
    return JSONResponse(content={
        "task_id": task.id,
        "status": "complete" if task.complete else "running",
        "output_lines": task.output_lines,
        "returncode": task.returncode,
        "files_changed": task.files_changed,
        "complete": task.complete,
    })


@app.get("/api/sessions/{session_id}/chat/{task_id}/stream")
async def stream_chat(session_id: str, task_id: str, request: Request) -> StreamingResponse:
    """Stream chat task output as Server-Sent Events.

    Sends incremental output lines as they arrive, 10x faster than polling.
    Falls back gracefully -- the polling endpoint remains available.
    """
    task = _chat_tasks.get(task_id)
    _sse_headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    if task is None:
        async def _not_found():
            yield f"event: error\ndata: {json.dumps({'error': 'Task not found'})}\n\n"
        return StreamingResponse(_not_found(), media_type="text/event-stream", headers=_sse_headers)

    async def event_generator():
        last_line = 0
        while True:
            # Check if the client disconnected
            if await request.is_disconnected():
                break

            # Send new lines since last check
            current_count = len(task.output_lines)
            if current_count > last_line:
                for line in task.output_lines[last_line:current_count]:
                    yield f"event: output\ndata: {json.dumps({'line': line})}\n\n"
                last_line = current_count

            # Check if complete -- flush any final lines first
            if task.complete:
                final_count = len(task.output_lines)
                if final_count > last_line:
                    for line in task.output_lines[last_line:final_count]:
                        yield f"event: output\ndata: {json.dumps({'line': line})}\n\n"
                yield f"event: complete\ndata: {json.dumps({'returncode': task.returncode, 'files_changed': task.files_changed})}\n\n"
                break

            await asyncio.sleep(0.1)  # 100ms -- 20x faster than 2s polling

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers=_sse_headers,
    )


@app.post("/api/sessions/{session_id}/chat/{task_id}/cancel")
async def cancel_chat(session_id: str, task_id: str) -> JSONResponse:
    """Cancel a running chat task."""
    task = _chat_tasks.get(task_id)
    if task is None:
        return JSONResponse(status_code=404, content={"error": "Task not found"})
    if task.complete:
        return JSONResponse(content={"cancelled": False, "reason": "Task already complete"})
    task.cancelled = True
    if task.process and task.process.poll() is None:
        try:
            pgid = os.getpgid(task.process.pid)
            os.killpg(pgid, signal.SIGTERM)
            await asyncio.to_thread(task.process.wait, timeout=3)
        except (ProcessLookupError, OSError, subprocess.TimeoutExpired):
            pass
        if task.process.poll() is None:
            try:
                pgid = os.getpgid(task.process.pid)
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                task.process.kill()
            try:
                await asyncio.to_thread(task.process.wait, timeout=5)
            except subprocess.TimeoutExpired:
                pass
    task.output_lines.append("[cancelled by user]")
    task.returncode = 1
    task.complete = True
    return JSONResponse(content={"cancelled": True})


@app.post("/api/sessions/{session_id}/fix")
async def fix_session(session_id: str) -> JSONResponse:
    """Run loki quick with dev server error context to auto-fix crashes."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    # Gather error context from dev server output
    ds_info = dev_server_manager.servers.get(session_id)
    error_lines: list[str] = []
    if ds_info:
        error_lines = ds_info.get("output_lines", [])[-30:]

    if not error_lines:
        return JSONResponse(status_code=400, content={"error": "No dev server error output to fix"})

    error_context = "\n".join(error_lines)
    fix_message = (
        f"The dev server crashed. Fix the error and ensure the app starts correctly.\n\n"
        f"DEV SERVER ERROR OUTPUT:\n{error_context}"
    )

    # Use the chat endpoint flow -- create a task and return task_id
    _cleanup_chat_tasks()
    task = ChatTask()
    _chat_tasks[task.id] = task

    async def run_fix() -> None:
        loki = _find_loki_cli()
        if loki is None:
            task.output_lines = ["loki CLI not found"]
            task.returncode = 1
            task.complete = True
            return
        proc: Optional[subprocess.Popen] = None
        try:
            fix_env = {**os.environ}
            fix_env.update(_load_secrets())
            proc = subprocess.Popen(
                [loki, "quick", fix_message],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                cwd=str(target),
                env=fix_env,
                start_new_session=True,
            )
            task.process = proc
            loop = asyncio.get_running_loop()

            def _read() -> None:
                assert proc.stdout is not None
                for raw_line in proc.stdout:
                    if task.cancelled:
                        break
                    clean = re.sub(r'\x1b\[[0-9;]*[a-zA-Z]', '', raw_line.rstrip("\n"))
                    stripped = clean.strip()
                    if stripped in ("[Tool: Read]", "[Tool: Bash]", "[Tool: Write]",
                                    "[Tool: Edit]", "[Tool: Grep]", "[Tool: Glob]",
                                    "[Result]", "[Thinking]"):
                        continue
                    if not stripped:
                        continue
                    task.output_lines.append(clean)
                proc.stdout.close()

            await asyncio.wait_for(loop.run_in_executor(None, _read), timeout=300)
            proc.wait(timeout=10)
            task.returncode = proc.returncode
        except asyncio.TimeoutError:
            if proc is not None:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    proc.kill()
                proc.wait()
            task.output_lines.append("Fix timed out after 5 minutes")
            task.returncode = 1
        except Exception as e:
            task.output_lines.append(str(e))
            task.returncode = 1
            if proc is not None and proc.poll() is None:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except (ProcessLookupError, OSError):
                    proc.kill()
                proc.wait()
        task.complete = True

    asyncio.create_task(run_fix())

    return JSONResponse(content={
        "task_id": task.id,
        "status": "running",
        "error_context": error_context[:500],
    })


@app.post("/api/sessions/{session_id}/review")
async def review_session(session_id: str) -> JSONResponse:
    """Run loki review on a project."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    rc, output = await asyncio.get_running_loop().run_in_executor(
        None, lambda: _run_loki_cmd(["review", str(target)], cwd=str(target), timeout=120)
    )
    return JSONResponse(content={"output": output, "returncode": rc})


@app.post("/api/sessions/{session_id}/test")
async def test_session(session_id: str) -> JSONResponse:
    """Run loki test on a project."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    rc, output = await asyncio.get_running_loop().run_in_executor(
        None, lambda: _run_loki_cmd(["test", "--dir", str(target)], cwd=str(target), timeout=120)
    )
    return JSONResponse(content={"output": output, "returncode": rc})


@app.post("/api/sessions/{session_id}/explain")
async def explain_session(session_id: str) -> JSONResponse:
    """Run loki explain on a project."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    rc, output = await asyncio.get_running_loop().run_in_executor(
        None, lambda: _run_loki_cmd(["explain", str(target)], cwd=str(target), timeout=120)
    )
    return JSONResponse(content={"output": output, "returncode": rc})


@app.post("/api/sessions/{session_id}/export")
async def export_session(session_id: str) -> JSONResponse:
    """Run loki export json on a project."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    rc, output = await asyncio.get_running_loop().run_in_executor(
        None, lambda: _run_loki_cmd(["export", "json"], cwd=str(target), timeout=60)
    )
    return JSONResponse(content={"output": output, "returncode": rc})


# ---------------------------------------------------------------------------
# Secrets management endpoints
# ---------------------------------------------------------------------------


@app.get("/api/secrets")
async def get_secrets() -> JSONResponse:
    """List secret keys (values masked)."""
    secrets = _load_secrets()
    masked = {k: "***" for k in secrets}
    return JSONResponse(content=masked)


@app.post("/api/secrets")
async def set_secret(req: SecretRequest) -> JSONResponse:
    """Set or update a secret."""
    if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', req.key):
        return JSONResponse(status_code=400, content={"error": "Invalid key. Use ENV_VAR style names."})
    secrets = _load_secrets()
    secrets[req.key] = req.value
    _save_secrets(secrets)
    return JSONResponse(content={"set": True, "key": req.key})


@app.delete("/api/secrets/{key}")
async def delete_secret(key: str) -> JSONResponse:
    """Delete a secret."""
    secrets = _load_secrets()
    if key not in secrets:
        return JSONResponse(status_code=404, content={"error": "Secret not found"})
    del secrets[key]
    _save_secrets(secrets)
    return JSONResponse(content={"deleted": True, "key": key})


# ---------------------------------------------------------------------------
# Preview info (smart project type detection)
# ---------------------------------------------------------------------------


@app.get("/api/sessions/{session_id}/preview-info")
async def get_preview_info(session_id: str) -> JSONResponse:
    """Detect project type and determine the best preview strategy."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    info: dict = {
        "type": "unknown",
        "preview_url": None,
        "entry_file": None,
        "dev_command": None,
        "port": None,
        "description": "No preview available",
    }

    # Detect project type from files (check root and first-level subdirectories)
    files = {f.name for f in target.iterdir() if f.is_file()} if target.is_dir() else set()
    has_package_json = "package.json" in files
    # If package.json not at root, check immediate subdirectories (e.g. project inside a folder)
    project_root = target
    if not has_package_json and target.is_dir():
        for subdir in target.iterdir():
            if subdir.is_dir() and (subdir / "package.json").exists():
                project_root = subdir
                files = {f.name for f in subdir.iterdir() if f.is_file()}
                has_package_json = True
                break
    has_index_html = (
        "index.html" in files
        or (project_root / "public" / "index.html").exists()
        or (project_root / "src" / "index.html").exists()
    )
    has_pyproject = "pyproject.toml" in files or "setup.py" in files or "requirements.txt" in files
    has_go_mod = "go.mod" in files
    has_cargo = "Cargo.toml" in files
    has_dockerfile = "Dockerfile" in files or "docker-compose.yml" in files
    has_pom = "pom.xml" in files
    has_gradle = "build.gradle" in files or "build.gradle.kts" in files
    has_gemfile = "Gemfile" in files
    has_rails_routes = (project_root / "config" / "routes.rb").exists()
    has_artisan = "artisan" in files
    has_mix = "mix.exs" in files
    has_package_swift = "Package.swift" in files

    # Read package.json for more info
    pkg_scripts: dict = {}
    pkg_deps: dict = {}
    if has_package_json:
        try:
            pkg = json.loads((project_root / "package.json").read_text())
            pkg_scripts = pkg.get("scripts", {})
            pkg_deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        except (json.JSONDecodeError, OSError):
            pass

    # Determine project type and preview strategy
    is_expo = "expo" in pkg_deps
    is_react = "react" in pkg_deps or "next" in pkg_deps or "vite" in pkg_deps
    is_express = "express" in pkg_deps or "fastify" in pkg_deps or "koa" in pkg_deps or "hono" in pkg_deps
    is_flask = has_pyproject and any((project_root / f).exists() for f in ["app.py", "main.py", "server.py"])
    is_fastapi = has_pyproject and any(
        "fastapi" in (project_root / f).read_text(errors="replace")
        for f in ["app.py", "main.py", "server.py"]
        if (project_root / f).exists()
    )

    # Docker Compose check -- highest priority (isolated, no port conflicts)
    has_compose = any((project_root / f).exists() for f in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"))

    if has_compose:
        compose_file = next(f for f in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml") if (project_root / f).exists())
        info["type"] = "docker"
        info["dev_command"] = f"docker compose -f {compose_file} up --build"
        info["description"] = "Containerized app -- runs via Docker Compose"
        # Use smart service resolution to find the primary port
        compose_port = 3000
        compose_services: list[dict] = []
        primary_service_name: Optional[str] = None
        try:
            import yaml
            with open(project_root / compose_file) as f:
                compose_data = yaml.safe_load(f)
            if compose_data and "services" in compose_data:
                for svc_name, svc in compose_data["services"].items():
                    svc_ports: list[int] = []
                    for p in svc.get("ports", []):
                        p_str = str(p)
                        if ":" in p_str:
                            parts = p_str.split(":")
                            try:
                                svc_ports.append(int(parts[-2].split("-")[0]))
                            except (ValueError, IndexError):
                                continue
                    compose_services.append({
                        "name": svc_name,
                        "ports": svc_ports,
                        "image": svc.get("image"),
                        "has_build": "build" in svc,
                    })
                primary_service_name, compose_port = dev_server_manager._resolve_primary_service(compose_services)
        except ImportError:
            try:
                content = (project_root / compose_file).read_text()
                port_match = re.search(r'"?(\d+):(\d+)"?', content)
                if port_match:
                    compose_port = int(port_match.group(1))
            except Exception:
                pass
        except Exception:
            pass
        info["port"] = compose_port
        if primary_service_name:
            info["primary_service"] = primary_service_name
        if compose_services:
            info["services"] = compose_services
    elif is_expo:
        info["type"] = "expo"
        info["port"] = 8081
        info["dev_command"] = "npx expo start"
        info["description"] = "Expo/React Native app -- scan QR code with Expo Go"
    elif is_react or (has_package_json and has_index_html):
        info["type"] = "web-app"
        info["entry_file"] = "index.html"
        info["preview_url"] = f"/api/sessions/{session_id}/preview/index.html"
        info["dev_command"] = "npm run dev" if "dev" in pkg_scripts else "npm start" if "start" in pkg_scripts else None
        info["description"] = "Web application -- serves HTML/CSS/JS"
    elif is_express or (has_package_json and ("start" in pkg_scripts or "dev" in pkg_scripts) and not has_index_html):
        # API/server project
        port = 3000  # default
        # Try to detect port from scripts
        start_script = pkg_scripts.get("start", "") + pkg_scripts.get("dev", "")
        port_match = re.search(r"(?:PORT|port)[=: ]*(\d+)", start_script)
        if port_match:
            port = int(port_match.group(1))
        info["type"] = "api"
        info["port"] = port
        info["dev_command"] = "npm run dev" if "dev" in pkg_scripts else "npm start" if "start" in pkg_scripts else None
        info["description"] = f"API server -- runs on port {port}"
        # Check for swagger/openapi
        for swagger_path in ["swagger.json", "openapi.json", "docs", "api-docs"]:
            if (target / swagger_path).exists():
                info["preview_url"] = f"/api/sessions/{session_id}/preview/{swagger_path}"
                break
    elif is_fastapi or is_flask:
        info["type"] = "python-api"
        info["port"] = 8000
        info["dev_command"] = "uvicorn app:app --reload" if is_fastapi else "flask run"
        info["description"] = "Python API server"
    elif has_index_html:
        info["type"] = "static-site"
        info["entry_file"] = "index.html"
        info["preview_url"] = f"/api/sessions/{session_id}/preview/index.html"
        info["description"] = "Static site -- serves HTML directly"
    elif has_package_json and "test" in pkg_scripts:
        info["type"] = "library"
        info["dev_command"] = "npm test"
        info["description"] = "Library/package -- run tests to verify"
    elif has_go_mod:
        info["type"] = "go-app"
        info["dev_command"] = "go run ."
        info["description"] = "Go application"
    elif has_cargo:
        info["type"] = "rust-app"
        info["dev_command"] = "cargo run"
        info["description"] = "Rust application"
    elif has_pom or has_gradle:
        info["type"] = "spring"
        info["port"] = 8080
        if has_pom:
            info["dev_command"] = "./mvnw spring-boot:run" if (project_root / "mvnw").exists() else "mvn spring-boot:run"
        else:
            info["dev_command"] = "./gradlew bootRun" if (project_root / "gradlew").exists() else "gradle bootRun"
        info["description"] = "Java Spring Boot application"
    elif has_gemfile and has_rails_routes:
        info["type"] = "rails"
        info["port"] = 3000
        info["dev_command"] = "bundle exec rails server"
        info["description"] = "Ruby on Rails application"
    elif has_artisan:
        info["type"] = "laravel"
        info["port"] = 8000
        info["dev_command"] = "php artisan serve"
        info["description"] = "PHP Laravel application"
    elif has_mix and (project_root / "lib").is_dir():
        info["type"] = "phoenix"
        info["port"] = 4000
        info["dev_command"] = "mix phx.server"
        info["description"] = "Elixir Phoenix application"
    elif has_package_swift:
        info["type"] = "swift"
        info["port"] = 8080
        info["dev_command"] = "swift run"
        info["description"] = "Swift/Vapor application"
    elif has_dockerfile:
        info["type"] = "containerized"
        info["dev_command"] = "docker compose up"
        info["description"] = "Containerized application"
    elif has_index_html and not has_package_json:
        info["type"] = "static"
        info["port"] = 8000
        info["entry_file"] = "index.html"
        info["preview_url"] = f"/api/sessions/{session_id}/preview/index.html"
        info["dev_command"] = "python3 -m http.server 8000"
        info["description"] = "Static HTML/CSS/JS site"
    else:
        # Check for any README or docs
        found_doc = False
        for doc_file in ["README.md", "readme.md", "README.txt"]:
            if (target / doc_file).exists():
                info["type"] = "project"
                info["entry_file"] = doc_file
                info["preview_url"] = f"/api/sessions/{session_id}/preview/{doc_file}"
                info["description"] = "Project -- showing README"
                found_doc = True
                break
        if not found_doc:
            info["description"] = "Project type not detected -- use the custom command input to start a dev server"

    # Verify the entry file actually exists on disk before returning a preview URL
    if info["entry_file"]:
        entry_path = target / info["entry_file"]
        if not entry_path.exists():
            info["preview_url"] = None
            info["entry_file"] = None

    # Indicate whether AI-driven continuous log monitoring is active for this session
    server_info = dev_server_manager.servers.get(session_id)
    info["ai_detected"] = server_info is not None

    return JSONResponse(content=info)


@app.get("/api/sessions/{session_id}/expo-qr")
async def expo_qr_page(session_id: str) -> Response:
    """Return an HTML page with QR code for Expo Go."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})

    import socket
    # Get LAN IP for physical device access
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        lan_ip = s.getsockname()[0]
        s.close()
    except Exception:
        lan_ip = "localhost"

    server = dev_server_manager.servers.get(session_id)
    port = server["port"] if server and server.get("port") else 8081

    expo_url = f"exp://{lan_ip}:{port}"
    qr_api = f"https://api.qrserver.com/v1/create-qr-code/?size=250x250&data={expo_url}"

    html = f"""<!DOCTYPE html>
<html>
<head><style>
  body {{ font-family: system-ui, sans-serif; display: flex; flex-direction: column;
         align-items: center; justify-content: center; min-height: 100vh; margin: 0;
         background: #1a1a2e; color: #e0e0e0; }}
  .card {{ background: #16213e; border-radius: 16px; padding: 32px; text-align: center;
           box-shadow: 0 8px 32px rgba(0,0,0,0.3); max-width: 400px; }}
  h2 {{ margin: 0 0 8px; color: #fff; font-size: 20px; }}
  p {{ margin: 4px 0; color: #9ca3af; font-size: 14px; }}
  img {{ margin: 16px 0; border-radius: 8px; }}
  .url {{ font-family: monospace; background: #0f3460; padding: 8px 16px; border-radius: 8px;
          font-size: 13px; margin-top: 12px; color: #7c83ff; word-break: break-all; }}
  .instructions {{ margin-top: 16px; text-align: left; font-size: 13px; line-height: 1.6; }}
  .instructions li {{ margin: 4px 0; }}
  .web-link {{ margin-top: 16px; }}
  .web-link a {{ color: #7c83ff; text-decoration: none; font-size: 13px; }}
  .web-link a:hover {{ text-decoration: underline; }}
</style></head>
<body>
  <div class="card">
    <h2>Expo Go</h2>
    <p>Scan with Expo Go on your phone</p>
    <img src="{qr_api}" alt="QR Code" width="200" height="200" />
    <div class="url">{expo_url}</div>
    <div class="instructions">
      <ol>
        <li>Install <b>Expo Go</b> on your phone</li>
        <li>Make sure phone is on the same WiFi network</li>
        <li>Scan the QR code above</li>
      </ol>
    </div>
    <div class="web-link">
      <a href="http://{lan_ip}:{port}" target="_blank">Open web version</a>
    </div>
  </div>
</body>
</html>"""
    from starlette.responses import HTMLResponse
    return HTMLResponse(content=html)


# ---------------------------------------------------------------------------
# Dev server management endpoints
# ---------------------------------------------------------------------------


@app.post("/api/sessions/{session_id}/devserver/start")
async def start_devserver(session_id: str, req: DevServerStartRequest) -> JSONResponse:
    """Start a dev server for a session's project."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})
    try:
        result = await dev_server_manager.start(session_id, str(target), req.command)
    except Exception as e:
        logger.error("Dev server start failed: %s", e)
        result = {"status": "error", "message": str(e)}
    status_code = 200 if result.get("status") != "error" else 400
    return JSONResponse(content=result, status_code=status_code)


@app.post("/api/sessions/{session_id}/devserver/stop")
async def stop_devserver(session_id: str) -> JSONResponse:
    """Stop the dev server for a session."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    result = await dev_server_manager.stop(session_id)
    return JSONResponse(content=result)


@app.get("/api/sessions/{session_id}/devserver/status")
async def get_devserver_status(session_id: str) -> JSONResponse:
    """Get dev server status for a session."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    result = await dev_server_manager.status(session_id)
    return JSONResponse(content=result)


@app.get("/api/sessions/{session_id}/services")
async def get_session_services(session_id: str) -> JSONResponse:
    """Get Docker Compose service list with primary detection."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    # Check if dev server info has cached services
    ds_info = dev_server_manager.servers.get(session_id)
    if ds_info and ds_info.get("docker_service_health"):
        return JSONResponse(content={
            "services": list(ds_info["docker_service_health"].values()),
            "framework": ds_info.get("framework"),
        })

    # Parse compose file directly
    services_info: list[dict] = []
    for compose_file in ("docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"):
        if (target / compose_file).exists():
            try:
                import yaml
                with open(target / compose_file) as f:
                    compose_data = yaml.safe_load(f)
                if compose_data and "services" in compose_data:
                    for svc_name, svc in compose_data["services"].items():
                        svc_ports: list[int] = []
                        for p in svc.get("ports", []):
                            p_str = str(p)
                            if ":" in p_str:
                                parts = p_str.split(":")
                                try:
                                    svc_ports.append(int(parts[-2].split("-")[0]))
                                except (ValueError, IndexError):
                                    continue
                        services_info.append({
                            "name": svc_name,
                            "ports": svc_ports,
                            "image": svc.get("image"),
                            "has_build": "build" in svc,
                        })
            except (ImportError, Exception):
                pass
            break

    primary_name, primary_port = dev_server_manager._resolve_primary_service(services_info)
    for svc in services_info:
        svc["is_primary"] = (svc["name"] == primary_name)

    return JSONResponse(content={
        "services": services_info,
        "primary_service": primary_name,
        "primary_port": primary_port,
    })


@app.get("/api/sessions/{session_id}/devserver/logs")
async def get_devserver_logs(session_id: str, service: Optional[str] = None, tail: int = 50) -> JSONResponse:
    """Get Docker service logs (optionally filtered to one service)."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    ds_info = dev_server_manager.servers.get(session_id)
    if not ds_info:
        return JSONResponse(status_code=404, content={"error": "No dev server running"})

    # If not a Docker project, return buffered output lines
    if ds_info.get("framework") != "docker":
        return JSONResponse(content={
            "logs": ds_info.get("output_lines", [])[-tail:],
            "service": None,
        })

    # Docker project: use docker compose logs
    project_dir = ds_info.get("project_dir", str(target))
    tail = min(tail, 200)  # Cap at 200 lines
    try:
        cmd = ["docker", "compose", "logs", "--tail", str(tail)]
        if service:
            # Validate service name to prevent injection
            if not re.match(r"^[a-zA-Z0-9._-]+$", service):
                return JSONResponse(status_code=400, content={"error": "Invalid service name"})
            cmd.append(service)
        loop = asyncio.get_running_loop()
        log_proc = await loop.run_in_executor(None, lambda: subprocess.run(
            cmd, capture_output=True, text=True, cwd=project_dir, timeout=15
        ))
        logs_text = log_proc.stdout or ""
        # Run diagnosis on the logs
        diagnoses = _diagnose_errors(logs_text)
        return JSONResponse(content={
            "logs": logs_text[-5000:],
            "service": service,
            "diagnoses": diagnoses,
        })
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return JSONResponse(status_code=500, content={"error": f"Failed to get logs: {exc}"})


@app.post("/api/sessions/{session_id}/devserver/restart-service")
async def restart_service(session_id: str, req: dict = Body(...)) -> JSONResponse:
    """Restart a specific Docker Compose service."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})
    ds_info = dev_server_manager.servers.get(session_id)
    if not ds_info:
        return JSONResponse(status_code=404, content={"error": "No dev server running"})
    if ds_info.get("framework") != "docker":
        return JSONResponse(status_code=400, content={"error": "Not a Docker project"})

    service_name = req.get("service")
    if not service_name or not re.match(r"^[a-zA-Z0-9._-]+$", service_name):
        return JSONResponse(status_code=400, content={"error": "Invalid or missing service name"})

    project_dir = ds_info.get("project_dir", ".")
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(None, lambda: subprocess.run(
            ["docker", "compose", "restart", service_name],
            capture_output=True, text=True, cwd=project_dir, timeout=30
        ))
        if result.returncode == 0:
            return JSONResponse(content={"status": "restarted", "service": service_name})
        else:
            return JSONResponse(status_code=500, content={
                "error": f"Restart failed: {result.stderr or result.stdout}",
                "service": service_name,
            })
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as exc:
        return JSONResponse(status_code=500, content={"error": f"Restart failed: {exc}"})


# ---------------------------------------------------------------------------
# HTTP Proxy for dev server preview
# ---------------------------------------------------------------------------


@app.api_route("/proxy/{session_id}/{path:path}",
               methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"])
async def proxy_to_devserver(session_id: str, path: str, request: Request):
    """Proxy requests to the dev server running for this session."""
    try:
        return await _do_proxy(session_id, path, request)
    except Exception as e:
        logger.error("Proxy error for %s/%s: %s", session_id, path, e, exc_info=True)
        return JSONResponse({"error": f"Proxy failed: {e}"}, status_code=502)


async def _do_proxy(session_id: str, path: str, request: Request):
    """Internal proxy implementation.

    Uses streaming to handle large responses without buffering them entirely
    in memory (important for JS bundles, images, etc.).
    """
    import httpx

    server = dev_server_manager.servers.get(session_id)
    if not server or server["status"] != "running" or server.get("port") is None:
        return JSONResponse(
            {"error": "Dev server not running", "hint": "Start the dev server first"},
            status_code=503,
        )

    # Determine target: portless URL or direct port
    if server.get("use_portless") and server.get("portless_app_name"):
        app_name = server["portless_app_name"]
        target_host = f"{app_name}.localhost"
        target_port = 1355
        target_url = f"http://{target_host}:{target_port}/{path}"
    else:
        target_port = server["port"]
        target_host = f"127.0.0.1:{target_port}"
        target_url = f"http://127.0.0.1:{target_port}/{path}"

    if request.url.query:
        target_url += f"?{request.url.query}"

    # Build headers to forward (skip hop-by-hop headers)
    skip_headers = {"host", "connection", "keep-alive", "transfer-encoding",
                    "te", "trailer", "upgrade"}
    fwd_headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in skip_headers
    }
    fwd_headers["host"] = target_host

    body = await request.body()

    # Use a client that is NOT used as a context manager so we can stream
    # the response body without closing the connection prematurely.
    client = httpx.AsyncClient(timeout=60.0, follow_redirects=False)
    try:
        resp = await client.send(
            client.build_request(
                method=request.method,
                url=target_url,
                headers=fwd_headers,
                content=body if body else None,
            ),
            stream=True,
        )
    except httpx.ConnectError:
        await client.aclose()
        return JSONResponse(
            {"error": "Cannot connect to dev server", "port": target_port},
            status_code=502,
        )
    except httpx.TimeoutException:
        await client.aclose()
        return JSONResponse(
            {"error": "Dev server request timed out"},
            status_code=504,
        )
    except Exception as e:
        await client.aclose()
        return JSONResponse(
            {"error": f"Proxy error: {e}"},
            status_code=502,
        )

    # Build response headers, passing through relevant ones
    resp_skip = {"transfer-encoding", "connection", "keep-alive", "content-encoding"}
    resp_headers = {
        k: v for k, v in resp.headers.items()
        if k.lower() not in resp_skip
    }

    async def stream_body():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        content=stream_body(),
        status_code=resp.status_code,
        headers=resp_headers,
    )


@app.websocket("/proxy/{session_id}/{path:path}")
async def proxy_websocket(websocket: WebSocket, session_id: str, path: str):
    """Proxy WebSocket connections for HMR (Vite, webpack, etc.).

    Handles any WS path under /proxy/{session_id}/ so that Vite's
    /__vite_hmr, webpack's /ws, and other HMR paths all work.
    """
    import websockets

    server = dev_server_manager.servers.get(session_id)
    if not server or server["status"] != "running" or server.get("port") is None:
        await websocket.close(code=1008, reason="Dev server not running")
        return

    # Determine WebSocket target: portless or direct
    if server.get("use_portless") and server.get("portless_app_name"):
        app_name = server["portless_app_name"]
        ws_url = f"ws://{app_name}.localhost:1355/{path}"
    else:
        target_port = server["port"]
        ws_url = f"ws://127.0.0.1:{target_port}/{path}"

    await websocket.accept()

    try:
        async with websockets.connect(ws_url) as upstream:
            async def client_to_upstream():
                try:
                    while True:
                        msg = await websocket.receive()
                        if msg.get("text") is not None:
                            await upstream.send(msg["text"])
                        elif msg.get("bytes") is not None:
                            await upstream.send(msg["bytes"])
                except (WebSocketDisconnect, Exception):
                    pass

            async def upstream_to_client():
                try:
                    async for msg in upstream:
                        if isinstance(msg, str):
                            await websocket.send_text(msg)
                        elif isinstance(msg, bytes):
                            await websocket.send_bytes(msg)
                except Exception:
                    pass

            await asyncio.gather(
                client_to_upstream(),
                upstream_to_client(),
                return_exceptions=True,
            )
    except Exception:
        pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Authentication middleware
# ---------------------------------------------------------------------------


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Enforce JWT auth when database is configured. Skip for public paths."""
    path = request.url.path
    skip_auth_prefixes = ["/health", "/api/auth/"]
    if any(path.startswith(p) for p in skip_auth_prefixes) or not (
        path.startswith("/api/") or path.startswith("/ws") or path.startswith("/proxy/")
    ):
        return await call_next(request)

    # If no DB configured, skip auth (local mode)
    try:
        from models import async_session_factory
        if async_session_factory is None:
            return await call_next(request)
    except ImportError:
        return await call_next(request)

    # Verify JWT
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)

    try:
        from auth import verify_token
    except ImportError:
        # Auth module not installed but database IS configured -- block the request
        logger.warning("Auth module not available but database is configured -- blocking request")
        return JSONResponse({"error": "Server authentication misconfigured"}, status_code=500)

    token = auth_header.split(" ", 1)[1]
    payload = verify_token(token)
    if not payload:
        return JSONResponse({"error": "Invalid or expired token"}, status_code=401)
    request.state.user = payload

    return await call_next(request)


# ---------------------------------------------------------------------------
# Auth endpoints
# ---------------------------------------------------------------------------


@app.get("/api/auth/me")
async def get_me(request: Request) -> JSONResponse:
    """Get current user info. Returns local_mode=True when no auth configured."""
    try:
        from models import async_session_factory
        if async_session_factory is None:
            return JSONResponse(content={"authenticated": False, "local_mode": True})
    except ImportError:
        return JSONResponse(content={"authenticated": False, "local_mode": True})

    user = getattr(request.state, "user", None)
    if user is None:
        return JSONResponse(content={"authenticated": False, "local_mode": False})
    return JSONResponse(content={"authenticated": True, **user})


@app.get("/api/auth/github/url")
async def github_auth_url() -> JSONResponse:
    """Get GitHub OAuth authorization URL with CSRF state parameter."""
    try:
        from auth import GITHUB_CLIENT_ID, generate_oauth_state
    except ImportError:
        return JSONResponse(status_code=501, content={"error": "Auth module not available"})
    if not GITHUB_CLIENT_ID:
        return JSONResponse(status_code=501, content={"error": "GitHub OAuth not configured"})
    state = generate_oauth_state()
    url = f"https://github.com/login/oauth/authorize?client_id={GITHUB_CLIENT_ID}&scope=user:email&state={state}"
    return JSONResponse(content={"url": url})


@app.post("/api/auth/github/callback")
async def github_callback(body: dict = Body(...)) -> JSONResponse:
    """Handle GitHub OAuth callback -- exchange code for JWT."""
    try:
        from auth import create_access_token, github_oauth_callback, validate_oauth_state
        from models import async_session_factory, User
    except ImportError:
        return JSONResponse(status_code=501, content={"error": "Auth module not available"})

    code = body.get("code")
    state = body.get("state")
    if not code:
        return JSONResponse(status_code=400, content={"error": "Missing code parameter"})
    if not validate_oauth_state(state):
        return JSONResponse(status_code=403, content={"error": "Invalid or expired OAuth state (CSRF check failed)"})

    try:
        user_info = await github_oauth_callback(code)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("GitHub OAuth callback failed: %s", exc)
        return JSONResponse(status_code=502, content={"error": "GitHub authentication failed"})

    # Create or update user in DB if database is configured
    if async_session_factory:
        from sqlalchemy import select
        async with async_session_factory() as db:
            result = await db.execute(
                select(User).where(User.email == user_info["email"])
            )
            db_user = result.scalar_one_or_none()
            if db_user is None:
                db_user = User(
                    email=user_info["email"],
                    name=user_info["name"],
                    avatar_url=user_info.get("avatar_url"),
                    provider="github",
                    provider_id=user_info["provider_id"],
                )
                db.add(db_user)
            else:
                db_user.name = user_info["name"]
                db_user.avatar_url = user_info.get("avatar_url")
                db_user.last_login = datetime.utcnow()
            await db.commit()

    token = create_access_token({
        "sub": user_info["email"],
        "name": user_info["name"],
        "avatar": user_info.get("avatar_url", ""),
    })
    return JSONResponse(content={"token": token, "user": user_info})


@app.get("/api/auth/google/url")
async def google_auth_url() -> JSONResponse:
    """Get Google OAuth authorization URL with CSRF state parameter."""
    try:
        from auth import GOOGLE_CLIENT_ID, generate_oauth_state
    except ImportError:
        return JSONResponse(status_code=501, content={"error": "Auth module not available"})
    if not GOOGLE_CLIENT_ID:
        return JSONResponse(status_code=501, content={"error": "Google OAuth not configured"})
    redirect_uri = os.environ.get("GOOGLE_REDIRECT_URI", f"http://localhost:{PORT}/api/auth/google/callback")
    state = generate_oauth_state()
    url = (
        f"https://accounts.google.com/o/oauth2/v2/auth"
        f"?client_id={GOOGLE_CLIENT_ID}"
        f"&redirect_uri={redirect_uri}"
        f"&response_type=code"
        f"&scope=openid%20email%20profile"
        f"&state={state}"
    )
    return JSONResponse(content={"url": url})


@app.post("/api/auth/google/callback")
async def google_callback(body: dict = Body(...)) -> JSONResponse:
    """Handle Google OAuth callback -- exchange code for JWT."""
    try:
        from auth import create_access_token, google_oauth_callback, validate_oauth_state
        from models import async_session_factory, User
    except ImportError:
        return JSONResponse(status_code=501, content={"error": "Auth module not available"})

    code = body.get("code")
    state = body.get("state")
    if not code:
        return JSONResponse(status_code=400, content={"error": "Missing code parameter"})
    if not validate_oauth_state(state):
        return JSONResponse(status_code=403, content={"error": "Invalid or expired OAuth state (CSRF check failed)"})

    # Use server-controlled redirect_uri -- never trust client-supplied value
    redirect_uri = os.environ.get("GOOGLE_REDIRECT_URI", f"http://localhost:{PORT}/api/auth/google/callback")

    try:
        user_info = await google_oauth_callback(code, redirect_uri)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("Google OAuth callback failed: %s", exc)
        return JSONResponse(status_code=502, content={"error": "Google authentication failed"})

    # Create or update user in DB if database is configured
    if async_session_factory:
        from sqlalchemy import select
        async with async_session_factory() as db:
            result = await db.execute(
                select(User).where(User.email == user_info["email"])
            )
            db_user = result.scalar_one_or_none()
            if db_user is None:
                db_user = User(
                    email=user_info["email"],
                    name=user_info["name"],
                    avatar_url=user_info.get("avatar_url"),
                    provider="google",
                    provider_id=user_info["provider_id"],
                )
                db.add(db_user)
            else:
                db_user.name = user_info["name"]
                db_user.avatar_url = user_info.get("avatar_url")
                db_user.last_login = datetime.utcnow()
            await db.commit()

    token = create_access_token({
        "sub": user_info["email"],
        "name": user_info["name"],
        "avatar": user_info.get("avatar_url", ""),
    })
    return JSONResponse(content={"token": token, "user": user_info})


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------


@app.get("/health")
async def health_check() -> JSONResponse:
    """Health check for load balancers and orchestrators."""
    return JSONResponse(content={"status": "ok", "service": "purple-lab"})


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------


async def _push_state_to_client(ws: WebSocket) -> None:
    """Background task: push state snapshots to a single WebSocket client.

    Pushes every 2s when a session is running, every 30s when idle.
    Sends only incremental log deltas (new lines since last push) instead
    of the full log buffer each time.
    """
    # Track absolute log offset to handle truncation correctly.
    # The buffer holds only the last N lines, but log_lines_total counts all.
    last_abs_index = max(session.log_lines_total - 100, 0)  # backfill handled on connect
    while True:
        is_running = (
            session.process is not None
            and session.running
            and session.process.poll() is None
        )
        interval = 2.0 if is_running else 30.0

        # Build status payload (same logic as GET /api/session/status)
        # Use asyncio.to_thread to avoid blocking the event loop on file I/O
        def _read_state_files():
            loki_dir = _loki_dir()
            _phase = "idle"
            _iteration = 0
            _complexity = "standard"
            _current_task = ""
            _pending_tasks = 0
            _agents = []
            _cost_usd = 0.0
            _max_iterations = 0

            state_file = loki_dir / "state" / "session.json"
            if state_file.exists():
                try:
                    with open(state_file) as f:
                        state_data = json.load(f)
                    _phase = state_data.get("phase", _phase)
                    _iteration = state_data.get("iteration", _iteration)
                    _complexity = state_data.get("complexity", _complexity)
                    _current_task = state_data.get("current_task", _current_task)
                    _pending_tasks = state_data.get("pending_tasks", _pending_tasks)
                    # Extract cost from tokens object if present
                    _tokens = state_data.get("tokens")
                    if isinstance(_tokens, dict):
                        _cost_usd = float(_tokens.get("cost_usd", 0) or 0)
                except (json.JSONDecodeError, OSError):
                    pass

            agents_file = loki_dir / "state" / "agents.json"
            if agents_file.exists():
                try:
                    with open(agents_file) as f:
                        agents_data = json.load(f)
                    if isinstance(agents_data, list):
                        _agents = agents_data
                except (json.JSONDecodeError, OSError):
                    pass

            # Read max_iterations from autonomy state
            autonomy_state = loki_dir / "autonomy-state.json"
            if autonomy_state.exists():
                try:
                    with open(autonomy_state) as f:
                        astate = json.load(f)
                    _max_iterations = int(astate.get("maxIterations", 0) or 0)
                except (json.JSONDecodeError, OSError, ValueError):
                    pass

            if _max_iterations <= 0:
                _max_iterations = int(os.environ.get("LOKI_MAX_ITERATIONS", "10"))

            return _phase, _iteration, _complexity, _current_task, _pending_tasks, _agents, _cost_usd, _max_iterations

        phase, iteration, complexity, current_task, pending_tasks, agents_payload, ws_cost, ws_max_iter = (
            await asyncio.to_thread(_read_state_files)
        )

        uptime = time.time() - session.start_time if is_running else 0
        status_payload = {
            "running": session.running,
            "paused": session.paused,
            "phase": phase,
            "iteration": iteration,
            "complexity": complexity,
            "mode": "autonomous",
            "provider": session.provider,
            "current_task": current_task,
            "pending_tasks": pending_tasks,
            "running_agents": 0,
            "uptime": round(uptime),
            "version": "",
            "pid": str(session.process.pid) if session.process else "",
            "projectDir": session.project_dir,
            "max_iterations": ws_max_iter,
            "cost": round(ws_cost, 4),
            "start_time": session.start_time if session.start_time > 0 else 0,
        }

        # Build incremental logs payload using absolute offset to handle truncation
        total_now = session.log_lines_total
        buf_len = len(session.log_lines)
        buf_start = total_now - buf_len  # absolute index of first item in buffer
        if last_abs_index < buf_start:
            last_abs_index = buf_start  # skip lines that were truncated away
        relative_start = last_abs_index - buf_start
        new_lines = session.log_lines[relative_start:] if relative_start < buf_len else []
        last_abs_index = total_now
        logs_payload = []
        for line in new_lines:
            level = "info"
            lower = line.lower()
            if "error" in lower or "fail" in lower:
                level = "error"
            elif "warn" in lower:
                level = "warning"
            elif "debug" in lower:
                level = "debug"
            logs_payload.append({
                "timestamp": "",
                "level": level,
                "message": line,
                "source": "loki",
            })

        try:
            await ws.send_json({
                "type": "state_update",
                "data": {
                    "status": status_payload,
                    "agents": agents_payload,
                    "logs": logs_payload,
                },
            })
        except Exception:
            # Client disconnected; exit task
            return

        await asyncio.sleep(interval)


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket) -> None:
    """Real-time stream of loki output and events."""
    await ws.accept()
    if len(session.ws_clients) >= MAX_WS_CLIENTS:
        await ws.send_text(json.dumps({"type": "error", "data": {"message": "Too many connections"}}))
        await ws.close(code=1013, reason="Too many connections")
        return
    session.ws_clients.add(ws)

    # Send current state on connect
    await ws.send_text(json.dumps({
        "type": "connected",
        "data": {"running": session.running, "provider": session.provider},
    }))

    # Ensure file watcher is running if session is active (handles page reloads)
    if session.running and session.project_dir and "session" not in file_watcher._observers:
        file_watcher.start("session", session.project_dir, _broadcast, asyncio.get_running_loop())

    # Send recent log lines as backfill
    for line in session.log_lines[-100:]:
        await ws.send_text(json.dumps({
            "type": "log",
            "data": {"line": line, "timestamp": ""},
        }))

    # Start server-push state task for this connection
    push_task = asyncio.create_task(_push_state_to_client(ws))

    missed_pongs = 0
    try:
        while True:
            try:
                data = await asyncio.wait_for(ws.receive_text(), timeout=60.0)
                try:
                    msg = json.loads(data)
                    if msg.get("type") == "ping":
                        await ws.send_text(json.dumps({"type": "pong"}))
                    elif msg.get("type") == "pong":
                        missed_pongs = 0  # only reset on pong-type messages
                except json.JSONDecodeError:
                    pass
            except asyncio.TimeoutError:
                # No message for 60s -- send a ping
                missed_pongs += 1
                if missed_pongs >= 2:
                    # Two consecutive pings with no reply -- close idle connection
                    break
                try:
                    await ws.send_text(json.dumps({"type": "ping"}))
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    finally:
        push_task.cancel()
        try:
            await push_task
        except (asyncio.CancelledError, Exception):
            pass
        session.ws_clients.discard(ws)


# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Terminal PTY WebSocket (interactive shell per session)
# ---------------------------------------------------------------------------

# Track active WebSocket connections per session for multi-tab awareness
_terminal_ws_clients: Dict[str, set] = {}

# Track active PTY reader tasks per session to prevent duplicate readers
_terminal_reader_tasks: Dict[str, asyncio.Task] = {}


@app.websocket("/ws/terminal/{session_id}")
async def terminal_websocket(ws: WebSocket, session_id: str) -> None:
    """Interactive terminal via PTY. Requires pexpect.

    Reuses an existing PTY if one is already alive for this session (e.g. on
    reconnect or second browser tab). Only kills the PTY when the *last*
    WebSocket client for this session disconnects.
    """
    await ws.accept()
    if len(_terminal_ptys) >= MAX_TERMINAL_PTYS and session_id not in _terminal_ptys:
        await ws.send_text(json.dumps({"type": "error", "data": {"message": "Too many terminal sessions"}}))
        await ws.close(code=1013, reason="Too many terminal sessions")
        return

    if not HAS_PEXPECT:
        # Try to install pexpect automatically
        import subprocess as _sp
        try:
            _sp.run(
                [sys.executable, "-m", "pip", "install", "--break-system-packages", "pexpect"],
                capture_output=True, timeout=30,
            )
            import pexpect as _pex  # noqa: F811
            globals()["pexpect"] = _pex
            globals()["HAS_PEXPECT"] = True
        except Exception:
            await ws.send_text(json.dumps({
                "type": "output",
                "data": "\r\n[Error] pexpect is not installed and auto-install failed.\r\n"
                        "Run: pip install pexpect\r\n",
            }))
            # Close with 4000 = "do not retry" custom code
            await ws.close(code=4000, reason="pexpect not installed")
            return

    # ---- Reuse or spawn PTY ------------------------------------------------
    pty = _terminal_ptys.get(session_id)
    spawned_new = False
    if pty is None or not pty.isalive():
        # Determine working directory
        cwd = str(Path.home())
        session_dir = _find_session_dir(session_id)
        if session_dir and session_dir.is_dir():
            cwd = str(session_dir)
        elif session.project_dir and Path(session.project_dir).is_dir():
            cwd = session.project_dir

        # Build environment with secrets injected
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        try:
            secrets = _load_secrets()
            env.update(secrets)
        except Exception:
            pass

        # Prefer user configured shell, fall back to /bin/bash
        user_shell = os.environ.get("SHELL", "/bin/bash")
        if not os.path.isfile(user_shell):
            user_shell = "/bin/bash"

        try:
            pty = pexpect.spawn(
                user_shell,
                args=["--login"],
                encoding="utf-8",
                codec_errors="replace",
                cwd=cwd,
                env=env,
                dimensions=(24, 80),
            )
            pty.setecho(True)
            spawned_new = True
        except Exception as exc:
            await ws.send_text(json.dumps({
                "type": "output",
                "data": f"\r\n[Error] Failed to spawn terminal: {exc}\r\n",
            }))
            await ws.close()
            return

        _terminal_ptys[session_id] = pty

    # ---- Track this WebSocket client ----------------------------------------
    if session_id not in _terminal_ws_clients:
        _terminal_ws_clients[session_id] = set()
    ws_id = id(ws)
    _terminal_ws_clients[session_id].add(ws_id)

    if not spawned_new:
        try:
            await ws.send_text(json.dumps({
                "type": "output",
                "data": "\r\n\x1b[32m-- Reconnected to existing terminal session --\x1b[0m\r\n",
            }))
        except Exception:
            pass

    # ---- Background task: read PTY output and forward to WebSocket ----------
    # Only create one reader per PTY to avoid race conditions when multiple
    # tabs connect to the same terminal session.
    async def read_pty_output() -> None:
        loop = asyncio.get_event_loop()
        while True:
            try:
                data = await loop.run_in_executor(None, _pty_read, pty)
                if data is None:
                    # PTY closed / EOF
                    try:
                        await ws.send_text(json.dumps({
                            "type": "output",
                            "data": "\r\n[Terminal session ended]\r\n",
                        }))
                    except Exception:
                        pass
                    break
                if data:
                    await ws.send_text(json.dumps({
                        "type": "output",
                        "data": data,
                    }))
            except asyncio.CancelledError:
                break
            except Exception:
                break

    existing_reader = _terminal_reader_tasks.get(session_id)
    if existing_reader is not None and not existing_reader.done():
        # A reader already exists for this PTY -- reuse it, don't create another
        reader_task = None
    else:
        reader_task = asyncio.create_task(read_pty_output())
        _terminal_reader_tasks[session_id] = reader_task

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = msg.get("type", "")

            if msg_type == "input":
                data = msg.get("data", "")
                if data and pty.isalive():
                    pty.send(data)

            elif msg_type == "resize":
                cols = msg.get("cols", 80)
                rows = msg.get("rows", 24)
                if pty.isalive():
                    pty.setwinsize(rows, cols)

    except WebSocketDisconnect:
        pass
    except Exception:
        logger.error("Terminal WebSocket error for session %s", session_id, exc_info=True)
    finally:
        if reader_task is not None:
            reader_task.cancel()
            try:
                await reader_task
            except (asyncio.CancelledError, Exception):
                pass
            _terminal_reader_tasks.pop(session_id, None)

        # Untrack this client
        clients = _terminal_ws_clients.get(session_id)
        if clients:
            clients.discard(ws_id)

        # Only kill PTY when the last client disconnects
        remaining = _terminal_ws_clients.get(session_id)
        if not remaining:
            _terminal_ws_clients.pop(session_id, None)
            if pty.isalive():
                pty.close(force=True)
            _terminal_ptys.pop(session_id, None)


def _pty_read(pty: "pexpect.spawn") -> Optional[str]:
    """Blocking read from PTY with batching.

    Uses a longer timeout (0.5s) to avoid busy-looping when idle.
    When data IS available, greedily reads more to batch output
    (up to 32KB per batch to keep latency reasonable).
    Returns None on EOF.
    """
    try:
        data = pty.read_nonblocking(size=4096, timeout=0.5)
        # Greedily read more available data to batch output (e.g. cat large_file)
        total = len(data) if data else 0
        while total < 32768:
            try:
                more = pty.read_nonblocking(size=4096, timeout=0.01)
                if more:
                    data += more
                    total += len(more)
                else:
                    break
            except (pexpect.TIMEOUT, pexpect.EOF, Exception):
                break
        return data
    except pexpect.TIMEOUT:
        return ""
    except pexpect.EOF:
        return None
    except Exception:
        return None



# ---------------------------------------------------------------------------
# Static file serving (built React app)
# ---------------------------------------------------------------------------

@app.get("/{full_path:path}")
async def serve_spa(full_path: str) -> FileResponse:
    """Serve the React SPA and static assets from dist/."""
    index = DIST_DIR / "index.html"
    if not index.exists():
        return JSONResponse(
            status_code=503,
            content={"error": "Web app not built. Run: cd web-app && npm run build"},
        )
    # Serve static files (JS, CSS, images) from dist/
    requested = DIST_DIR / full_path
    if full_path and requested.is_file() and str(requested.resolve()).startswith(str(DIST_DIR.resolve())):
        # Set correct content type
        import mimetypes
        content_type = mimetypes.guess_type(str(requested))[0] or "application/octet-stream"
        return FileResponse(str(requested), media_type=content_type)
    # SPA fallback: return index.html for all non-file routes
    return FileResponse(str(index))


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------


def main() -> None:
    import uvicorn
    host = os.environ.get("PURPLE_LAB_HOST", HOST)
    port = int(os.environ.get("PURPLE_LAB_PORT", str(PORT)))
    print(f"Purple Lab starting on http://{host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info", timeout_keep_alive=30)


if __name__ == "__main__":
    main()
