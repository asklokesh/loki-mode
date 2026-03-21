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
from pydantic import BaseModel

logger = logging.getLogger("purple-lab")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

HOST = os.environ.get("PURPLE_LAB_HOST", "127.0.0.1")
PORT = int(os.environ.get("PURPLE_LAB_PORT", "57375"))

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

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------


class SessionState:
    """Tracks the active loki session."""

    def __init__(self) -> None:
        self.process: Optional[subprocess.Popen] = None
        self.running = False
        self.provider = ""
        self.prd_text = ""
        self.project_dir = ""
        self.start_time: float = 0
        self.log_lines: list[str] = []
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
        self.provider = ""
        self.prd_text = ""
        self.project_dir = ""
        self.start_time = 0
        self.log_lines = []


def _kill_tracked_child_processes() -> None:
    """Kill only processes that Purple Lab started, not external loki sessions."""
    import subprocess as _sp
    tracked = _get_tracked_child_pids()
    if not tracked:
        return

    for pid in tracked:
        try:
            # Kill the entire process tree (children first, then parent)
            _sp.run(["pkill", "-TERM", "-P", str(pid)],
                     capture_output=True, timeout=5)
            os.kill(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    # Wait briefly then SIGKILL survivors
    import time as _time
    _time.sleep(2)
    for pid in tracked:
        try:
            _sp.run(["pkill", "-9", "-P", str(pid)],
                     capture_output=True, timeout=5)
            os.kill(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass

    _clear_tracked_pids()


session = SessionState()

# Terminal PTY instances keyed by session_id
_terminal_ptys: Dict[str, "pexpect.spawn"] = {}

# Track PIDs of sessions started by Purple Lab (not by external loki CLI)
_PURPLE_LAB_PIDS_FILE = SCRIPT_DIR.parent / ".loki" / "purple-lab" / "child-pids.json"


def _track_child_pid(pid: int) -> None:
    """Record a PID started by Purple Lab so loki web stop can clean it up."""
    _PURPLE_LAB_PIDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    pids: list[int] = []
    if _PURPLE_LAB_PIDS_FILE.exists():
        try:
            pids = json.loads(_PURPLE_LAB_PIDS_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pids = []
    if pid not in pids:
        pids.append(pid)
    _PURPLE_LAB_PIDS_FILE.write_text(json.dumps(pids))


def _untrack_child_pid(pid: int) -> None:
    """Remove a PID from tracking after it exits."""
    if not _PURPLE_LAB_PIDS_FILE.exists():
        return
    try:
        pids = json.loads(_PURPLE_LAB_PIDS_FILE.read_text())
        pids = [p for p in pids if p != pid]
        _PURPLE_LAB_PIDS_FILE.write_text(json.dumps(pids))
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
        if event.is_directory and event.event_type not in ("created", "deleted"):
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
        # "port 3000" standalone
        re.compile(r"port\s+(\d+)", re.IGNORECASE),
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

    def _ensure_portless_proxy(self) -> bool:
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
            # Give it a moment to start
            import time as _time
            _time.sleep(1)
            self._portless_proxy_started = True
            return True
        except (FileNotFoundError, OSError):
            return False

    async def detect_dev_command(self, project_dir: str) -> Optional[dict]:
        """Detect the dev command from project files."""
        root = Path(project_dir)
        if not root.is_dir():
            return None

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
                    port = 5173 if "vite" in deps else 3000
                    fw = "vite" if "vite" in deps else "next" if "next" in deps else "node"
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
                    src = py_file.read_text(errors="replace")
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

        # Auto-install dependencies if needed
        actual_path = Path(actual_dir)
        needs_npm = (actual_path / "package.json").exists() and not (actual_path / "node_modules").exists()
        needs_pip = (actual_path / "requirements.txt").exists() and not (actual_path / "venv").exists()
        if needs_npm:
            # Prepend npm install to the command
            cmd_str = f"npm install && {cmd_str}"
        if needs_pip:
            cmd_str = f"pip install -r requirements.txt && {cmd_str}"

        # Check if portless is available and proxy is running
        use_portless = False
        portless_app_name = None
        if self._has_portless() and self._ensure_portless_proxy():
            portless_app_name = self._portless_app_name(session_id)
            use_portless = True
            # Wrap the command with portless
            effective_cmd = f"portless {portless_app_name} {cmd_str}"
        else:
            effective_cmd = cmd_str

        build_env = {**os.environ}
        build_env.update(_load_secrets())

        try:
            proc = subprocess.Popen(
                effective_cmd,
                shell=True,
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

        server_info: dict = {
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
                if info["port"] is None:
                    detected_port = self._parse_port(text)
                    if detected_port:
                        info["port"] = detected_port
        except Exception:
            pass
        finally:
            # Process exited -- mark as error if it was still starting or running
            if info.get("status") in ("starting", "running"):
                info["status"] = "error"

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

        proc = info["process"]
        if proc.poll() is None:
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
        }
        if info.get("use_portless") and info.get("portless_app_name"):
            app_name = info["portless_app_name"]
            result["portless_url"] = f"http://{app_name}.localhost:1355/"
            if alive:
                result["port"] = 1355
        return result

    async def stop_all(self) -> None:
        """Stop all dev servers (used on shutdown)."""
        for sid in list(self.servers.keys()):
            await self.stop(sid)


dev_server_manager = DevServerManager()


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
            # Keep last 5000 lines
            if len(session.log_lines) > 5000:
                session.log_lines = session.log_lines[-5000:]
            await _broadcast({
                "type": "log",
                "data": {"line": text, "timestamp": time.strftime("%H:%M:%S")},
            })
    except Exception:
        pass
    finally:
        # Process ended
        session.running = False
        await _broadcast({"type": "session_end", "data": {"message": "Session ended"}})


def _build_file_tree(root: Path, max_depth: int = 4, _depth: int = 0) -> list[dict]:
    """Recursively build a file tree from a directory."""
    if _depth >= max_depth or not root.is_dir():
        return []

    entries = []
    try:
        items = sorted(root.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        return []

    for item in items:
        # Skip hidden dirs and common noise
        if item.name.startswith("."):
            continue
        if item.name in ("node_modules", "__pycache__", ".git", "venv", ".venv"):
            continue

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
    from crypto import decrypt_value, encryption_available
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
            project_dir = os.path.join(Path.home(), "purple-lab-projects", f"project-{int(time.time())}")
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

        # Kill any orphaned loki-run processes for this project
        if session.project_dir:
            await asyncio.get_running_loop().run_in_executor(
                None, _kill_tracked_child_processes
            )

        await _broadcast({"type": "session_end", "data": {"message": "Session stopped by user"}})

        return JSONResponse(content={"stopped": True, "message": "Session stopped"})



    if not session.running or session.process is None:
        return

    project_dir = session.project_dir
    session.running = False
    await session.cleanup()

    proc = session.process
    if proc and proc.poll() is None:
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

    # Kill any orphaned loki-run processes for this project
    if project_dir:
        await asyncio.get_running_loop().run_in_executor(
            None, _kill_tracked_child_processes
        )


@app.get("/api/session/status")
async def get_status() -> JSONResponse:
    """Get current session status."""
    # Check if process is still alive
    if session.process and session.running:
        if session.process.poll() is not None:
            session.running = False

    # Try to read .loki state files for richer status
    loki_dir = _loki_dir()
    phase = "idle"
    iteration = 0
    complexity = "standard"
    current_task = ""
    pending_tasks = 0

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
        except (json.JSONDecodeError, OSError):
            pass

    uptime = time.time() - session.start_time if session.running else 0

    return JSONResponse(content={
        "running": session.running,
        "paused": False,
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
        if history:
            break  # Use first directory that has entries
    return JSONResponse(content=history)


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str) -> JSONResponse:
    """Delete a session and all its files, processes, and state."""
    if not re.match(r"^[a-zA-Z0-9._-]+$", session_id):
        return JSONResponse(status_code=400, content={"error": "Invalid session ID"})

    target = _find_session_dir(session_id)
    if target is None:
        return JSONResponse(status_code=404, content={"error": "Session not found"})

    # 1. Stop dev server if running
    if session_id in dev_server_manager.servers:
        await dev_server_manager.stop(session_id)

    # 2. Stop file watcher if running
    file_watcher.stop(session_id)

    # 3. Close terminal PTY if open
    pty = _terminal_ptys.get(session_id)
    if pty:
        try:
            pty.close()
        except Exception:
            pass
        _terminal_ptys.pop(session_id, None)

    # 4. Delete project directory (including node_modules, .loki, everything)
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
        if req.mode == "max":
            # Max mode: full loki start with the message as a PRD
            prd_path = target / ".loki" / "chat-prd.md"
            prd_path.parent.mkdir(parents=True, exist_ok=True)
            prd_path.write_text(req.message)
            cmd_args = [loki, "start", "--provider", "claude", str(prd_path)]
        else:
            # Quick and Standard both use 'loki quick' -- fast, focused changes
            cmd_args = [loki, "quick", req.message]
        try:
            proc = subprocess.Popen(
                cmd_args,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                cwd=str(target),
                env={**os.environ},
                start_new_session=True,
            )
            task.process = proc
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
            task.process.wait(timeout=3)
        except (ProcessLookupError, OSError):
            pass
        if task.process.poll() is None:
            try:
                pgid = os.getpgid(task.process.pid)
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, OSError):
                task.process.kill()
            task.process.wait(timeout=5)
    task.output_lines.append("[cancelled by user]")
    task.returncode = 1
    task.complete = True
    return JSONResponse(content={"cancelled": True})


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

    if is_expo:
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
                        data = await websocket.receive_text()
                        await upstream.send(data)
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
    skip_auth_prefixes = ["/health", "/api/auth/", "/ws", "/proxy/"]
    if any(path.startswith(p) for p in skip_auth_prefixes) or not path.startswith("/api/"):
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
    last_log_index = max(len(session.log_lines) - 100, 0)  # backfill handled on connect
    while True:
        is_running = (
            session.process is not None
            and session.running
            and session.process.poll() is None
        )
        interval = 2.0 if is_running else 30.0

        # Build status payload (same logic as GET /api/session/status)
        loki_dir = _loki_dir()
        phase = "idle"
        iteration = 0
        complexity = "standard"
        current_task = ""
        pending_tasks = 0

        state_file = loki_dir / "state" / "session.json"
        if state_file.exists():
            try:
                with open(state_file) as f:
                    state_data = json.load(f)
                phase = state_data.get("phase", phase)
                iteration = state_data.get("iteration", iteration)
                complexity = state_data.get("complexity", complexity)
                current_task = state_data.get("current_task", current_task)
                pending_tasks = state_data.get("pending_tasks", pending_tasks)
            except (json.JSONDecodeError, OSError):
                pass

        uptime = time.time() - session.start_time if is_running else 0
        status_payload = {
            "running": session.running,
            "paused": False,
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
        }

        # Build agents payload
        agents_payload: list = []
        agents_file = loki_dir / "state" / "agents.json"
        if agents_file.exists():
            try:
                with open(agents_file) as f:
                    agents_data = json.load(f)
                if isinstance(agents_data, list):
                    agents_payload = agents_data
            except (json.JSONDecodeError, OSError):
                pass

        # Build incremental logs payload (only new lines since last push)
        current_len = len(session.log_lines)
        new_lines = session.log_lines[last_log_index:current_len] if current_len > last_log_index else []
        last_log_index = current_len
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
                missed_pongs = 0  # any message resets idle counter
                try:
                    msg = json.loads(data)
                    if msg.get("type") == "ping":
                        await ws.send_text(json.dumps({"type": "pong"}))
                    elif msg.get("type") == "pong":
                        pass  # client responded to our ping
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


@app.websocket("/ws/terminal/{session_id}")
async def terminal_websocket(ws: WebSocket, session_id: str) -> None:
    """Interactive terminal via PTY. Requires pexpect.

    Reuses an existing PTY if one is already alive for this session (e.g. on
    reconnect or second browser tab). Only kills the PTY when the *last*
    WebSocket client for this session disconnects.
    """
    await ws.accept()

    if not HAS_PEXPECT:
        # Try to install pexpect automatically
        import subprocess as _sp
        try:
            _sp.run(
                [sys.executable, "-m", "pip", "install", "--break-system-packages", "pexpect"],
                capture_output=True, timeout=30,
            )
            import pexpect as _pex  # noqa: F811
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

    reader_task = asyncio.create_task(read_pty_output())

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
        pass
    finally:
        reader_task.cancel()
        try:
            await reader_task
        except (asyncio.CancelledError, Exception):
            pass

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

# Mount assets directory if dist exists
if DIST_DIR.is_dir() and (DIST_DIR / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=str(DIST_DIR / "assets")), name="assets")


@app.get("/{full_path:path}")
async def serve_spa(full_path: str) -> FileResponse:
    """Serve the React SPA. All non-API routes return index.html."""
    index = DIST_DIR / "index.html"
    if not index.exists():
        return JSONResponse(
            status_code=503,
            content={"error": "Web app not built. Run: cd web-app && npm run build"},
        )
    # Try to serve static file first
    requested = DIST_DIR / full_path
    if full_path and requested.is_file() and str(requested.resolve()).startswith(str(DIST_DIR.resolve())):
        return FileResponse(str(requested))
    # Fallback to SPA index
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
