"""
Loki Mode Session Control API

FastAPI-based session control endpoints for the Loki Mode dashboard.
Provides start/stop/pause/resume functionality and real-time status updates.

Usage:
    uvicorn dashboard.control:app --host 0.0.0.0 --port 57374
    # Or run with the CLI:
    loki dashboard start
"""

import asyncio
import fcntl
import json
import os
import signal
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

# Configuration
LOKI_DIR = Path(os.environ.get("LOKI_DIR", ".loki"))
STATE_DIR = LOKI_DIR / "state"
LOG_DIR = LOKI_DIR / "logs"
EVENTS_FILE = LOKI_DIR / "events.jsonl"

# Find skill directory
def find_skill_dir() -> Path:
    candidates = [
        Path.home() / ".claude" / "skills" / "loki-mode",
        Path(__file__).parent.parent,
        Path.cwd()
    ]
    for candidate in candidates:
        if (candidate / "SKILL.md").exists() and (candidate / "autonomy" / "run.sh").exists():
            return candidate
    return Path.cwd()

SKILL_DIR = find_skill_dir()
RUN_SH = SKILL_DIR / "autonomy" / "run.sh"

# Ensure directories exist
STATE_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)

# Utility: atomic write with optional file locking
def atomic_write_json(file_path: Path, data: dict, use_lock: bool = True):
    """
    Atomically write JSON data to a file to prevent TOCTOU race conditions.
    Uses temporary file + os.rename() for atomicity.
    Optionally uses fcntl.flock for additional safety.
    """
    try:
        # Write to temporary file in same directory (for atomic rename)
        temp_fd, temp_path = tempfile.mkstemp(
            dir=file_path.parent,
            prefix=f".{file_path.name}.",
            suffix=".tmp"
        )

        try:
            with os.fdopen(temp_fd, 'w') as f:
                # Acquire exclusive lock if requested
                if use_lock:
                    try:
                        fcntl.flock(f.fileno(), fcntl.LOCK_EX)
                    except (OSError, AttributeError):
                        # flock not available on this platform - continue without lock
                        pass

                # Write data
                json.dump(data, f, indent=2)
                f.flush()
                os.fsync(f.fileno())

                # Release lock (happens automatically on close, but explicit is clearer)
                if use_lock:
                    try:
                        fcntl.flock(f.fileno(), fcntl.LOCK_UN)
                    except (OSError, AttributeError):
                        pass

            # Atomic rename
            os.rename(temp_path, file_path)

        except Exception:
            # Clean up temp file on error
            try:
                os.unlink(temp_path)
            except OSError:
                pass
            raise

    except Exception as e:
        raise RuntimeError(f"Failed to write {file_path}: {e}")

# FastAPI app
app = FastAPI(
    title="Loki Mode Control API",
    description="Session control endpoints for Loki Mode dashboard",
    version="1.0.0"
)

# CORS middleware for dashboard frontend - restricted to localhost by default.
# Set LOKI_DASHBOARD_CORS to override (comma-separated origins).
_cors_default = "http://localhost:57374,http://127.0.0.1:57374"
_cors_origins = os.environ.get("LOKI_DASHBOARD_CORS", _cors_default).split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Request/Response models
class StartRequest(BaseModel):
    """Request body for starting a Loki Mode session."""
    prd: Optional[str] = None
    provider: str = "claude"
    parallel: bool = False
    background: bool = True

    def validate_provider(self) -> None:
        """Validate provider is from allowed list."""
        allowed_providers = ["claude", "codex", "gemini", "cline", "aider"]
        if self.provider not in allowed_providers:
            raise ValueError(f"Invalid provider: {self.provider}. Must be one of: {', '.join(allowed_providers)}")

    def validate_prd_path(self) -> None:
        """Validate PRD path is safe and exists."""
        if not self.prd:
            return

        # Check for path traversal sequences
        if ".." in self.prd:
            raise ValueError("PRD path contains path traversal sequence (..)")

        # Resolve to absolute path and verify it exists
        prd_path = Path(self.prd).resolve()
        if not prd_path.exists():
            raise ValueError(f"PRD file does not exist: {self.prd}")

        # Verify it's a file, not a directory
        if not prd_path.is_file():
            raise ValueError(f"PRD path is not a file: {self.prd}")

        # Verify path resolves within CWD or a reasonable parent
        cwd = Path.cwd().resolve()
        try:
            prd_path.relative_to(cwd)
        except ValueError:
            # Not within CWD - check if it's within user's home or project directory
            home = Path.home().resolve()
            try:
                prd_path.relative_to(home)
            except ValueError:
                raise ValueError(f"PRD path is outside allowed directories: {self.prd}")


class StatusResponse(BaseModel):
    """Current session status."""
    state: str
    pid: Optional[int] = None
    statusText: str = ""
    currentPhase: str = ""
    currentTask: str = ""
    pendingTasks: int = 0
    provider: str = "claude"
    version: str = "unknown"
    lokiDir: str = ""
    iteration: int = 0
    complexity: str = "standard"
    timestamp: str


class ControlResponse(BaseModel):
    """Generic control operation response."""
    success: bool
    message: str
    pid: Optional[int] = None


# Utility functions
def read_file_safe(filepath: Path) -> str:
    """Read file contents safely, returning empty string on error."""
    try:
        return filepath.read_text().strip()
    except Exception:
        return ""


def is_process_running(pid: int) -> bool:
    """Check if a process with given PID is running."""
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def get_version() -> str:
    """Get Loki Mode version from VERSION file."""
    version_file = SKILL_DIR / "VERSION"
    return read_file_safe(version_file) or "unknown"


def emit_event(event_type: str, data: dict) -> None:
    """Emit an event to the events.jsonl file.

    Uses same format as run.sh emit_event_json() for consistency:
    {"timestamp": "...", "type": "...", "data": {...}}
    """
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "type": event_type,
        "data": data
    }
    EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(EVENTS_FILE, "a") as f:
        f.write(json.dumps(event) + "\n")


def get_status() -> StatusResponse:
    """Get current session status."""
    pid_file = LOKI_DIR / "loki.pid"
    status_file = LOKI_DIR / "STATUS.txt"
    pause_file = LOKI_DIR / "PAUSE"
    stop_file = LOKI_DIR / "STOP"
    dashboard_state_file = LOKI_DIR / "dashboard-state.json"

    # Get PID and check if running
    pid_str = read_file_safe(pid_file)
    pid = int(pid_str) if pid_str.isdigit() else None
    running = is_process_running(pid) if pid else False

    # Check for skill-invoked sessions (no PID, but session.json exists)
    session_file = LOKI_DIR / "session.json"
    if not running and session_file.exists():
        try:
            session_data = json.loads(session_file.read_text())
            if session_data.get("status") == "running":
                # Staleness check: treat as stopped if older than 6 hours
                started_at = session_data.get("startedAt", "")
                if started_at:
                    try:
                        start_time_parsed = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
                        age_hours = (datetime.now(timezone.utc) - start_time_parsed).total_seconds() / 3600
                        if age_hours > 6:
                            session_data["status"] = "stopped"
                            atomic_write_json(session_file, session_data, use_lock=True)
                        else:
                            running = True
                    except (ValueError, TypeError):
                        running = True
                else:
                    running = True
        except (json.JSONDecodeError, KeyError):
            pass

    # Determine state
    state = "stopped"
    if running:
        if pause_file.exists():
            state = "paused"
        elif stop_file.exists():
            state = "stopping"
        else:
            state = "running"

    # Read status text
    status_text = read_file_safe(status_file)

    # Read dashboard state for additional info
    current_phase = ""
    current_task = ""
    pending_tasks = 0
    provider = "claude"
    iteration = 0
    complexity = "standard"

    if dashboard_state_file.exists():
        try:
            dashboard_state = json.loads(dashboard_state_file.read_text())
            current_phase = dashboard_state.get("phase", "")
            iteration = dashboard_state.get("iteration", 0)
            complexity = dashboard_state.get("complexity", "standard")

            # Get pending tasks count
            tasks = dashboard_state.get("tasks", {})
            pending = tasks.get("pending", [])
            if isinstance(pending, list):
                pending_tasks = len(pending)
            elif isinstance(pending, dict):
                pending_tasks = len(pending.get("tasks", []))
        except (json.JSONDecodeError, KeyError):
            pass

    # Read provider from state
    provider_file = STATE_DIR / "provider"
    if provider_file.exists():
        provider = read_file_safe(provider_file) or "claude"

    # Read orchestrator state for current task
    orch_file = STATE_DIR / "orchestrator.json"
    if orch_file.exists():
        try:
            orch = json.loads(orch_file.read_text())
            current_task = orch.get("currentTask", "")
        except (json.JSONDecodeError, KeyError):
            pass

    return StatusResponse(
        state=state,
        pid=pid,
        statusText=status_text,
        currentPhase=current_phase,
        currentTask=current_task,
        pendingTasks=pending_tasks,
        provider=provider,
        version=get_version(),
        lokiDir=str(LOKI_DIR.absolute()),
        iteration=iteration,
        complexity=complexity,
        timestamp=datetime.now(timezone.utc).isoformat()
    )


# API Endpoints
@app.get("/api/control/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "ok", "version": get_version()}


@app.get("/api/control/status", response_model=StatusResponse)
async def get_session_status():
    """Get current session status."""
    return get_status()


@app.post("/api/control/start", response_model=ControlResponse)
async def start_session(request: StartRequest):
    """
    Start a Loki Mode session.

    Args:
        request: Start request with PRD path, provider, and options

    Returns:
        ControlResponse with success status and PID
    """
    # Validate input
    try:
        request.validate_provider()
        request.validate_prd_path()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Check if already running
    status = get_status()
    if status.state == "running":
        raise HTTPException(
            status_code=409,
            detail=f"Session already running with PID {status.pid}"
        )

    # Verify run.sh exists
    if not RUN_SH.exists():
        raise HTTPException(
            status_code=500,
            detail=f"run.sh not found at {RUN_SH}"
        )

    # Build command arguments
    args = [str(RUN_SH), "--provider", request.provider]
    if request.parallel:
        args.append("--parallel")
    if request.background:
        args.append("--bg")
    if request.prd:
        args.append(request.prd)

    try:
        # Start the process
        process = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            cwd=str(Path.cwd())
        )

        # Save provider for status tracking
        (STATE_DIR / "provider").write_text(request.provider)

        # Emit start event
        emit_event("session_start", {
            "pid": process.pid,
            "provider": request.provider,
            "prd": request.prd,
            "parallel": request.parallel
        })

        return ControlResponse(
            success=True,
            message=f"Session started with provider {request.provider}",
            pid=process.pid
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/control/stop", response_model=ControlResponse)
async def stop_session():
    """
    Stop the current Loki Mode session.

    Creates a STOP file to signal graceful shutdown and attempts
    to terminate the process directly.
    """
    stop_file = LOKI_DIR / "STOP"
    pid_file = LOKI_DIR / "loki.pid"

    # Create STOP file for graceful shutdown
    stop_file.parent.mkdir(parents=True, exist_ok=True)
    stop_file.write_text(datetime.now(timezone.utc).isoformat())

    # Also try to terminate process directly
    pid_str = read_file_safe(pid_file)
    pid = None
    if pid_str.isdigit():
        pid = int(pid_str)
        if is_process_running(pid):
            try:
                os.kill(pid, signal.SIGTERM)
            except (OSError, ProcessLookupError):
                pass

    # Mark session.json as stopped (skill-invoked sessions)
    session_file = LOKI_DIR / "session.json"
    if session_file.exists():
        try:
            # Read current session data
            session_data = json.loads(session_file.read_text())
            session_data["status"] = "stopped"

            # Atomic write with file locking to prevent race conditions
            atomic_write_json(session_file, session_data, use_lock=True)
        except (json.JSONDecodeError, KeyError, RuntimeError):
            pass

    # Emit stop event
    emit_event("session_stop", {"pid": pid, "reason": "user_request"})

    return ControlResponse(
        success=True,
        message="Stop signal sent",
        pid=pid
    )


@app.post("/api/control/pause", response_model=ControlResponse)
async def pause_session():
    """
    Pause the current Loki Mode session.

    Creates a PAUSE file that signals the runner to pause
    after completing the current task.
    """
    pause_file = LOKI_DIR / "PAUSE"

    # Create PAUSE file
    pause_file.parent.mkdir(parents=True, exist_ok=True)
    pause_file.write_text(datetime.now(timezone.utc).isoformat())

    # Get current PID for response
    pid_file = LOKI_DIR / "loki.pid"
    pid_str = read_file_safe(pid_file)
    pid = int(pid_str) if pid_str.isdigit() else None

    # Emit pause event
    emit_event("session_pause", {"pid": pid})

    return ControlResponse(
        success=True,
        message="Pause signal sent - session will pause after current task",
        pid=pid
    )


@app.post("/api/control/resume", response_model=ControlResponse)
async def resume_session():
    """
    Resume a paused Loki Mode session.

    Removes the PAUSE and STOP files to allow the session to continue.
    """
    pause_file = LOKI_DIR / "PAUSE"
    stop_file = LOKI_DIR / "STOP"

    # Remove control files
    try:
        pause_file.unlink(missing_ok=True)
    except Exception:
        pass

    try:
        stop_file.unlink(missing_ok=True)
    except Exception:
        pass

    # Get current PID for response
    pid_file = LOKI_DIR / "loki.pid"
    pid_str = read_file_safe(pid_file)
    pid = int(pid_str) if pid_str.isdigit() else None

    # Emit resume event
    emit_event("session_resume", {"pid": pid})

    return ControlResponse(
        success=True,
        message="Session resumed",
        pid=pid
    )


@app.get("/api/control/events")
async def stream_events():
    """
    Stream events as Server-Sent Events (SSE).

    Provides real-time updates to the dashboard frontend.
    """
    async def event_generator():
        # Send initial status
        status = get_status()
        yield f"data: {json.dumps(status.model_dump())}\n\n"

        # Track file position for incremental reads
        last_position = 0
        if EVENTS_FILE.exists():
            last_position = EVENTS_FILE.stat().st_size

        # Stream updates
        while True:
            # Send status update every 2 seconds
            status = get_status()
            yield f"event: status\ndata: {json.dumps(status.model_dump())}\n\n"

            # Check for new events
            if EVENTS_FILE.exists():
                current_size = EVENTS_FILE.stat().st_size
                if current_size > last_position:
                    with open(EVENTS_FILE, "r") as f:
                        f.seek(last_position)
                        for line in f:
                            line = line.strip()
                            if line:
                                yield f"event: log\ndata: {line}\n\n"
                    last_position = current_size

            await asyncio_sleep(2)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive"
        }
    )


@app.get("/api/control/logs")
async def get_logs(lines: int = 50):
    """
    Get recent log lines from the session log.

    Args:
        lines: Number of lines to return (default 50, max 10000)
    """
    lines = min(max(lines, 1), 10000)
    log_file = LOG_DIR / "session.log"

    if not log_file.exists():
        return {"logs": [], "total": 0}

    content = log_file.read_text()
    all_lines = [line for line in content.split("\n") if line.strip()]
    recent_lines = all_lines[-lines:]

    return {"logs": recent_lines, "total": len(all_lines)}


# Helper for async sleep
async def asyncio_sleep(seconds: float):
    """Async sleep helper."""
    await asyncio.sleep(seconds)


# Run with uvicorn if executed directly
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("LOKI_DASHBOARD_PORT", "57374"))
    host = os.environ.get("LOKI_DASHBOARD_HOST", "127.0.0.1")
    uvicorn.run(app, host=host, port=port)
