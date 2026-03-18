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
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:57375", "http://localhost:57375"],
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

    def reset(self) -> None:
        self.process = None
        self.running = False
        self.provider = ""
        self.prd_text = ""
        self.project_dir = ""
        self.start_time = 0
        self.log_lines = []


session = SessionState()

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class StartRequest(BaseModel):
    prd: str
    provider: str = "claude"
    projectDir: Optional[str] = None


class StopResponse(BaseModel):
    stopped: bool
    message: str

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _loki_dir() -> Path:
    """Return the .loki/ directory for the current session project."""
    if session.project_dir:
        return Path(session.project_dir) / ".loki"
    return Path.home() / ".loki"


def _safe_resolve(base: Path, requested: str) -> Optional[Path]:
    """Resolve a path ensuring it stays within base (path traversal protection)."""
    try:
        resolved = (base / requested).resolve()
        base_resolved = base.resolve()
        if str(resolved).startswith(str(base_resolved)):
            return resolved
    except (ValueError, OSError):
        pass
    return None


async def _broadcast(msg: dict) -> None:
    """Send a JSON message to all connected WebSocket clients."""
    data = json.dumps(msg)
    dead: list[WebSocket] = []
    for ws in session.ws_clients:
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

    loop = asyncio.get_event_loop()

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
# API endpoints
# ---------------------------------------------------------------------------


@app.post("/api/session/start")
async def start_session(req: StartRequest) -> JSONResponse:
    """Start a new loki session with the given PRD."""
    if session.running:
        return JSONResponse(
            status_code=409,
            content={"error": "A session is already running. Stop it first."},
        )

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
    cmd = [
        str(LOKI_CLI),
        "start",
        "--provider", req.provider,
        prd_path,
    ]

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            cwd=project_dir,
            env={**os.environ, "LOKI_DIR": os.path.join(project_dir, ".loki")},
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
    if not session.running or session.process is None:
        return JSONResponse(content={"stopped": False, "message": "No session running"})

    try:
        # Send SIGTERM, then SIGKILL after 5s
        session.process.terminate()
        try:
            session.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            session.process.kill()
            session.process.wait(timeout=3)
    except Exception:
        pass

    session.running = False
    await _broadcast({"type": "session_end", "data": {"message": "Session stopped by user"}})

    return JSONResponse(content={"stopped": True, "message": "Session stopped"})


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
            return JSONResponse(content={"content": f"[File too large: {size} bytes]"})
        content = resolved.read_text(errors="replace")
    except (OSError, UnicodeDecodeError) as e:
        return JSONResponse(content={"content": f"[Cannot read file: {e}]"})

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


@app.get("/api/templates")
async def get_templates() -> JSONResponse:
    """List available PRD templates."""
    templates_dir = PROJECT_ROOT / "templates"
    if not templates_dir.is_dir():
        return JSONResponse(content=[])

    templates = []
    for f in sorted(templates_dir.glob("*.md")):
        name = f.stem.replace("-", " ").replace("_", " ").title()
        templates.append({"name": name, "filename": f.name})
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
# WebSocket
# ---------------------------------------------------------------------------


async def _push_state_to_client(ws: WebSocket) -> None:
    """Background task: push state snapshots to a single WebSocket client.

    Pushes every 2s when a session is running, every 30s when idle.
    """
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

        # Build logs payload (last 50 lines)
        recent = session.log_lines[-50:] if session.log_lines else []
        logs_payload = []
        for line in recent:
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

    try:
        while True:
            # Keep connection alive; handle client messages if needed
            data = await ws.receive_text()
            # Could handle commands here (e.g., stop session)
            try:
                msg = json.loads(data)
                if msg.get("type") == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        pass
    finally:
        push_task.cancel()
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
