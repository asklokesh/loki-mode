"""Purple Lab - Standalone product backend for Loki Mode.

A Replit-like web UI where users input PRDs and watch agents work.
Separate from the dashboard (which monitors existing sessions).
Purple Lab IS the product -- it starts and manages loki sessions.

Runs on port 57375 (dashboard uses 57374).
"""
from __future__ import annotations

import asyncio
import inspect
import json
import os
import re
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import Body, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

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

app = FastAPI(title="Purple Lab", docs_url=None, redoc_url=None)

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
        if item.name.startswith(".") and item.name not in (".loki",):
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
    """Load secrets from disk."""
    if _SECRETS_FILE.exists():
        try:
            data = json.loads(_SECRETS_FILE.read_text())
            if isinstance(data, dict):
                return data
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_secrets(secrets: dict[str, str]) -> None:
    """Save secrets to disk. WARNING: stored in plaintext."""
    _SECRETS_FILE.parent.mkdir(parents=True, exist_ok=True)
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


_chat_tasks: dict[str, ChatTask] = {}

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

        # Kill any orphaned loki-run processes for this project
        if session.project_dir:
            await asyncio.get_running_loop().run_in_executor(
                None, _kill_tracked_child_processes
            )

        await _broadcast({"type": "session_end", "data": {"message": "Session stopped by user"}})

        return JSONResponse(content={"stopped": True, "message": "Session stopped"})


@app.on_event("shutdown")
async def shutdown_event():
    """Clean up any running session when Purple Lab shuts down."""
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
            None, _kill_orphan_loki_processes, project_dir
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
    import json as _json
    import logging as _logging
    import re as _re

    _log = _logging.getLogger("purple-lab.plan")

    complexity = "standard"
    cost_estimate = "unknown"
    iterations = 5
    phases: list[str] = []
    parsed = False

    # Look for any JSON object containing plan-related keys (supports nested braces)
    json_match = _re.search(r'\{[^{}]*"complexity"[^{}]*\}', output, _re.DOTALL)
    if not json_match:
        json_match = _re.search(r'\{[^{}]*"iterations"[^{}]*\}', output, _re.DOTALL)
    if json_match:
        try:
            data = _json.loads(json_match.group(0))
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
        except (_json.JSONDecodeError, TypeError, KeyError) as exc:
            _log.warning("JSON plan block found but failed to parse: %s", exc)

    # Fallback: line-by-line text parsing with tighter patterns
    if not parsed:
        _log.info("No JSON plan block found, falling back to text parsing")
        for line in output.splitlines():
            stripped = _re.sub(r'\x1b\[[0-9;]*m', '', line)  # strip ANSI codes
            lower = stripped.lower().strip()
            if not lower:
                continue
            # Complexity detection: match "complexity: standard" or "Complexity Tier: complex" etc.
            if _re.search(r'complexity\s*(?:tier)?\s*[:=]', lower):
                for val in ("simple", "standard", "complex", "expert"):
                    if _re.search(rf'\b{val}\b', lower):
                        complexity = val
                        break
            # Cost parsing: look for dollar amounts in cost/estimate lines
            if ("cost" in lower or "estimate" in lower) and "$" in stripped:
                m = _re.search(r"\$[\d,]+\.?\d*", stripped)
                if m:
                    cost_estimate = m.group(0)
            # Iteration count
            if _re.search(r'iterations?\s*[:=]\s*\d+', lower):
                m = _re.search(r'iterations?\s*[:=]\s*(\d+)', lower)
                if m:
                    iterations = int(m.group(1))
            # Phase/step lines
            if _re.match(r'^\s*(phase|step)\s+\d', lower):
                for phase_name in ("planning", "implementation", "testing", "review", "deployment"):
                    if _re.search(rf'\b{phase_name}\b', lower) and phase_name not in phases:
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
    import re
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
    import re
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
                    return st["status"]
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


@app.get("/api/sessions/{session_id}")
async def get_session_detail(session_id: str) -> JSONResponse:
    """Get details of a past session for read-only viewing."""
    import re
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
    import re
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
    import re
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
    import re
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
    import re
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
    import re
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
    import re
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

    task = ChatTask()
    _chat_tasks[task.id] = task

    async def run_chat() -> None:
        loop = asyncio.get_running_loop()
        if req.mode == "quick":
            cmd_args = ["quick", req.message]
        else:
            cmd_args = ["start", "--provider", "claude", str(target / "PRD.md")]
        rc, output = await loop.run_in_executor(
            None, lambda: _run_loki_cmd(cmd_args, cwd=str(target), timeout=300)
        )
        task.output_lines = output.splitlines()
        task.returncode = rc
        # Detect changed files
        try:
            import subprocess as _sp
            result = _sp.run(
                ["git", "diff", "--name-only", "HEAD~1"],
                cwd=str(target), capture_output=True, text=True, timeout=10
            )
            if result.returncode == 0:
                task.files_changed = [f for f in result.stdout.strip().splitlines() if f]
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


@app.post("/api/sessions/{session_id}/review")
async def review_session(session_id: str) -> JSONResponse:
    """Run loki review on a project."""
    import re
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
    import re
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
    import re
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
    import re
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

    # Detect project type from files
    files = {f.name for f in target.iterdir() if f.is_file()} if target.is_dir() else set()
    has_package_json = "package.json" in files
    has_index_html = (
        "index.html" in files
        or (target / "public" / "index.html").exists()
        or (target / "src" / "index.html").exists()
    )
    has_pyproject = "pyproject.toml" in files or "setup.py" in files or "requirements.txt" in files
    has_go_mod = "go.mod" in files
    has_cargo = "Cargo.toml" in files
    has_dockerfile = "Dockerfile" in files or "docker-compose.yml" in files

    # Read package.json for more info
    pkg_scripts: dict = {}
    pkg_deps: dict = {}
    if has_package_json:
        try:
            pkg = json.loads((target / "package.json").read_text())
            pkg_scripts = pkg.get("scripts", {})
            pkg_deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
        except (json.JSONDecodeError, OSError):
            pass

    # Determine project type and preview strategy
    is_react = "react" in pkg_deps or "next" in pkg_deps or "vite" in pkg_deps
    is_express = "express" in pkg_deps or "fastify" in pkg_deps or "koa" in pkg_deps or "hono" in pkg_deps
    is_flask = has_pyproject and any((target / f).exists() for f in ["app.py", "main.py", "server.py"])
    is_fastapi = has_pyproject and any(
        "fastapi" in (target / f).read_text(errors="replace")
        for f in ["app.py", "main.py", "server.py"]
        if (target / f).exists()
    )

    if is_react or (has_package_json and has_index_html):
        info["type"] = "web-app"
        info["entry_file"] = "index.html"
        info["preview_url"] = f"/api/sessions/{session_id}/preview/index.html"
        info["dev_command"] = pkg_scripts.get("dev") or pkg_scripts.get("start")
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
        info["dev_command"] = pkg_scripts.get("dev") or pkg_scripts.get("start")
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
        info["dev_command"] = pkg_scripts.get("test")
        info["description"] = "Library/package -- run tests to verify"
    elif has_go_mod:
        info["type"] = "go-app"
        info["dev_command"] = "go run ."
        info["description"] = "Go application"
    elif has_cargo:
        info["type"] = "rust-app"
        info["dev_command"] = "cargo run"
        info["description"] = "Rust application"
    elif has_dockerfile:
        info["type"] = "containerized"
        info["dev_command"] = "docker compose up"
        info["description"] = "Containerized application"
    else:
        # Check for any README or docs
        for doc_file in ["README.md", "readme.md", "README.txt"]:
            if (target / doc_file).exists():
                info["type"] = "project"
                info["entry_file"] = doc_file
                info["preview_url"] = f"/api/sessions/{session_id}/preview/{doc_file}"
                info["description"] = "Project -- showing README"
                break

    return JSONResponse(content=info)


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
