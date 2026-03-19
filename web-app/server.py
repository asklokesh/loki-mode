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


session = SessionState()

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
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                cwd=project_dir,
                env={**os.environ, "LOKI_DIR": os.path.join(project_dir, ".loki")},
                start_new_session=True,  # create new process group for clean kill
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
    async with session._lock:
        if not session.running or session.process is None:
            return JSONResponse(content={"stopped": False, "message": "No session running"})

        proc = session.process

        # 1. Mark stopped first so reader task loop exits
        session.running = False

        # 2. Cancel reader task before killing process
        await session.cleanup()

        # 3. Kill the process group (catches child processes too)
        try:
            pgid = os.getpgid(proc.pid)
            os.killpg(pgid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            # Fallback: kill the process directly
            try:
                proc.terminate()
            except Exception:
                pass

        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                pgid = os.getpgid(proc.pid)
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    proc.kill()
                except Exception:
                    pass
            try:
                proc.wait(timeout=3)
            except Exception:
                pass

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
    """
    loki = _find_loki_cli()
    if loki is None:
        return (1, "loki CLI not found")
    full_cmd = [loki] + args
    try:
        result = subprocess.run(
            full_cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            cwd=cwd or session.project_dir or str(Path.home()),
            timeout=timeout,
            env={**os.environ},
        )
        return (result.returncode, result.stdout or "")
    except subprocess.TimeoutExpired:
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

    # Parse output for structured fields
    complexity = "standard"
    cost_estimate = "unknown"
    iterations = 5
    phases: list[str] = []

    for line in output.splitlines():
        lower = line.lower()
        if "complexity" in lower:
            for val in ("simple", "standard", "complex", "expert"):
                if val in lower:
                    complexity = val
                    break
        if "cost" in lower and ("$" in line or "usd" in lower):
            import re
            m = re.search(r"\$[\d.,]+", line)
            if m:
                cost_estimate = m.group(0)
        if "iteration" in lower:
            import re
            m = re.search(r"(\d+)", line)
            if m:
                iterations = int(m.group(1))
        # Detect phase lines
        for phase in ("planning", "implementation", "testing", "review", "deployment"):
            if phase in lower and phase not in phases:
                phases.append(phase)

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
    if not re.match(r"^[a-zA-Z0-9_-]+$", session_id):
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


@app.post("/api/session/onboard")
async def onboard_session(req: OnboardRequest) -> JSONResponse:
    """Run loki onboard on a path and return CLAUDE.md content."""
    # Path traversal protection: must be absolute, exist, and within home directory
    try:
        target = Path(req.path).resolve()
    except (ValueError, OSError):
        return JSONResponse(status_code=400, content={"error": "Invalid path"})
    home = Path.home().resolve()
    if not str(target).startswith(str(home)):
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
