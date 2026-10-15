"""
Loki Mode session-control helpers

Shared helpers for the dashboard: session status, atomic JSON writes, skill-dir
discovery and the browser-mutation Origin check. The HTTP control routes live
in dashboard/server.py (the only dashboard app).
"""

import fcntl
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

from fastapi import Request
from pydantic import BaseModel


def _normalized_http_origin(value: str) -> tuple[str, str, int] | None:
    """Return a comparable browser origin, or ``None`` when malformed.

    Origin is scheme + host + effective port. Paths, credentials, queries and
    fragments are never valid in an Origin header. Normalising default ports
    makes ``https://host`` and ``https://host:443`` equivalent without doing
    loose prefix/suffix matching on attacker-controlled text.
    """
    try:
        parsed = urlsplit(value.strip())
        if (
            parsed.scheme.lower() not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            return None
        port = parsed.port
    except (TypeError, ValueError):
        return None
    if port is None:
        port = 443 if parsed.scheme.lower() == "https" else 80
    return parsed.scheme.lower(), parsed.hostname.lower(), port


def browser_mutation_origin_allowed(
    request: Request, allowed_origins: list[str]
) -> bool:
    """Allow non-browser clients, same-origin pages and explicit CORS origins.

    CORS controls whether a browser may *read* a response; it does not stop a
    simple cross-origin POST from being sent. State-changing routes therefore
    need their own check. Browsers always attach Origin to cross-origin fetches,
    while CLI/SDK/local health clients commonly omit it, so absence preserves
    the existing local-first API. A present malformed or unrelated origin is
    refused before route code can touch disk or processes.
    """
    supplied = request.headers.get("origin")
    if supplied is None:
        return True
    if "*" in allowed_origins:
        return True
    supplied_origin = _normalized_http_origin(supplied)
    if supplied_origin is None:
        return False
    request_origin = _normalized_http_origin(str(request.base_url))
    if supplied_origin == request_origin:
        return True
    return any(
        supplied_origin == _normalized_http_origin(candidate)
        for candidate in allowed_origins
    )

# Configuration
LOKI_DIR = Path(os.environ.get("LOKI_DIR", ".loki"))
STATE_DIR = LOKI_DIR / "state"
LOG_DIR = LOKI_DIR / "logs"
EVENTS_FILE = LOKI_DIR / "events.jsonl"

# Find skill directory
def find_skill_dir() -> Path:
    explicit = os.environ.get("LOKI_SKILL_DIR", "").strip()
    if explicit:
        configured = Path(explicit).expanduser().resolve()
        if ((configured / "SKILL.md").exists()
                and (configured / "autonomy" / "run.sh").exists()):
            return configured
        raise RuntimeError(f"LOKI_SKILL_DIR is not a Loki source tree: {configured}")

    # os.getcwd() RAISES FileNotFoundError when the working directory has been
    # deleted out from under the process. That is not hypothetical: a dashboard
    # started inside a temp workspace keeps running after the workspace is
    # cleaned up, and then EVERY endpoint that resolves a path 500s at once --
    # observed as ~60 simultaneous 500s including /api/status, whose handler
    # touches almost nothing. A long-lived server must survive losing its cwd.
    def _cwd_or_none() -> "Path | None":
        try:
            return Path.cwd()
        except OSError:
            return None

    candidates = [
        Path.home() / ".claude" / "skills" / "loki-mode",
        Path(__file__).parent.parent,
        _cwd_or_none(),
    ]
    for candidate in candidates:
        if candidate is None:
            continue
        try:
            if ((candidate / "SKILL.md").exists()
                    and (candidate / "autonomy" / "run.sh").exists()):
                return candidate
        except OSError:
            continue

    # The fallback must not be the one path that can still raise. When the cwd
    # is gone, resolve to this file's own tree -- it is on disk by definition,
    # since we are executing out of it.
    return _cwd_or_none() or Path(__file__).resolve().parent.parent

SKILL_DIR = find_skill_dir()
RUN_SH = SKILL_DIR / "autonomy" / "run.sh"


def _cwd_or_skill_dir() -> Path:
    """The cwd, or the skill tree when the cwd has been deleted.

    Used where a real directory is required (subprocess cwd=), as opposed to
    the confinement check in validate(), which must fail closed instead.
    """
    try:
        return Path.cwd()
    except OSError:
        return SKILL_DIR

# Ensure directories exist.
# Best-effort at IMPORT time. LOKI_DIR defaults to the relative path ".loki",
# so when the working directory has been deleted these mkdirs raise
# FileNotFoundError and the whole module fails to import -- which takes the
# entire dashboard down rather than the one feature that needs the directory.
# Whoever actually writes into these paths still surfaces its own error.
for _startup_dir in (STATE_DIR, LOG_DIR):
    try:
        _startup_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass

# Utility: atomic write with optional file locking
def atomic_write_json(file_path: Path, data: dict, use_lock: bool = True):
    """
    Atomically write JSON data to a file to prevent TOCTOU race conditions.
    Uses temporary file + os.rename() for atomicity.
    Optionally uses fcntl.flock on a dedicated lock file for mutual exclusion.
    """
    try:
        lock_fd = -1
        lock_path = str(file_path) + ".lock"

        # Acquire exclusive lock on a dedicated lock file if requested.
        # This ensures all writers to the same target contend on the same
        # lock, unlike the previous approach which locked the temp file
        # (each caller got its own temp file so the lock was a no-op).
        if use_lock:
            try:
                lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o644)
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
            except (OSError, AttributeError):
                # flock not available on this platform - continue without lock
                if lock_fd >= 0:
                    os.close(lock_fd)
                lock_fd = -1

        try:
            # Write to temporary file in same directory (for atomic rename)
            temp_fd, temp_path = tempfile.mkstemp(
                dir=file_path.parent,
                prefix=f".{file_path.name}.",
                suffix=".tmp"
            )

            try:
                with os.fdopen(temp_fd, 'w') as f:
                    json.dump(data, f, indent=2)
                    f.flush()
                    os.fsync(f.fileno())

                # Atomic rename
                os.rename(temp_path, file_path)

            except Exception:
                # Clean up temp file on error
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
                raise

        finally:
            # Release the lock file (close releases flock automatically)
            if lock_fd >= 0:
                try:
                    os.close(lock_fd)
                except OSError:
                    pass

    except Exception as e:
        raise RuntimeError(f"Failed to write {file_path}: {e}")


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
        except (json.JSONDecodeError, OSError, KeyError):
            # Partial JSON from concurrent write -- treat as unavailable
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
        except (json.JSONDecodeError, OSError, KeyError):
            # Partial JSON from concurrent write -- treat as unavailable
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
        except (json.JSONDecodeError, OSError, KeyError):
            # Partial JSON from concurrent write -- treat as unavailable
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
