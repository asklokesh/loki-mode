"""
FastAPI server for Loki Mode Dashboard.

Provides REST API and WebSocket endpoints for dashboard functionality.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import threading
import time
from collections import defaultdict
from dataclasses import asdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path as _Path
from typing import Any, Literal, Optional
import re

from fastapi import (
    Depends,
    FastAPI,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .database import close_db, get_db, init_db
from .models import (
    Agent,
    AgentStatus,
    Project,
    Session,
    SessionStatus,
    Task,
    TaskPriority,
    TaskStatus,
    Tenant,
)
from . import registry
from . import auth
from . import audit
from . import app_secrets as secrets_mod
from . import telemetry as _telemetry
from .control import atomic_write_json, find_skill_dir, is_process_running
from .activity_logger import get_activity_logger
from .api_v2 import (
    TenantContext,
    _enforce_project_tenant,
    resolve_tenant_context,
)

try:
    from . import __version__ as _version
except ImportError:
    _version = "5.58.1"

# ---------------------------------------------------------------------------
# TLS Configuration (optional - disabled by default)
# Set both LOKI_TLS_CERT and LOKI_TLS_KEY to enable HTTPS
# ---------------------------------------------------------------------------
LOKI_TLS_CERT = os.environ.get("LOKI_TLS_CERT", "")  # Path to PEM certificate
LOKI_TLS_KEY = os.environ.get("LOKI_TLS_KEY", "")    # Path to PEM private key


def _safe_int_env(name: str, default: int) -> int:
    """Read an integer from an environment variable, returning *default* on bad values."""
    try:
        return int(os.environ.get(name, str(default)))
    except (ValueError, TypeError):
        return default


def _safe_json_read(path: _Path, default: Any = None) -> Any:
    """Read a JSON file with retry on partial/corrupt data from concurrent writes."""
    for attempt in range(2):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
            return json.loads(text)
        except json.JSONDecodeError:
            if attempt == 0:
                time.sleep(0.1)
                continue
            return default
        except (OSError, IOError):
            return default
    return default


def _safe_read_text(path: _Path) -> str:
    """Read a text file with UTF-8 encoding, replacing non-UTF-8 bytes.

    Returns empty string on any I/O or encoding error (truly safe).
    """
    try:
        return _Path(path).read_text(encoding="utf-8", errors="replace")
    except (OSError, IOError, ValueError):
        return ""


# ---------------------------------------------------------------------------
# Simple in-memory rate limiter for control endpoints
# ---------------------------------------------------------------------------

class _RateLimiter:
    """Simple in-memory rate limiter for control endpoints."""

    def __init__(self, max_calls: int = 10, window_seconds: int = 60, max_keys: int = 10000):
        self._max_calls = max_calls
        self._window = window_seconds
        self._max_keys = max_keys
        self._calls: dict[str, list[float]] = defaultdict(list)
        # Sync route handlers (plain `def`) run in Starlette's threadpool, so
        # check() can be entered by several threads at once against this one
        # shared instance. Without a guard, one thread iterating self._calls
        # (the empty-key prune or the LRU-eviction sort) while another inserts
        # or deletes a key raises "dictionary changed size during iteration",
        # which surfaces to the caller as a 500 on a trivial rate-limit guard.
        # The lock is held only around the in-memory bookkeeping (no I/O, no
        # await), so contention is negligible and it cannot deadlock async
        # callers that reach this via run_in_threadpool.
        self._lock = threading.Lock()

    def check(self, key: str) -> bool:
        now = time.time()
        with self._lock:
            # Prune old timestamps for this key
            self._calls[key] = [t for t in self._calls[key] if now - t < self._window]

            # Remove keys with empty timestamp lists
            empty_keys = [k for k, v in self._calls.items() if not v]
            for k in empty_keys:
                del self._calls[k]

            # Evict least-recently-accessed keys if max_keys exceeded
            if len(self._calls) > self._max_keys:
                # Sort by last-access time (most recent timestamp), evict least recent
                sorted_keys = sorted(
                    self._calls.items(),
                    key=lambda x: max(x[1]) if x[1] else 0
                )
                keys_to_remove = len(self._calls) - self._max_keys
                for k, _ in sorted_keys[:keys_to_remove]:
                    del self._calls[k]

            if len(self._calls[key]) >= self._max_calls:
                return False
            self._calls[key].append(now)
            return True


_control_limiter = _RateLimiter(max_calls=10, window_seconds=60)
_read_limiter = _RateLimiter(max_calls=60, window_seconds=60)


def _rate_key(base: str, request: Optional[Request]) -> str:
    """Build a per-client rate-limit key.

    Static literal keys make the read limiter a single global cap: one client
    can exhaust the window for everyone else. Mirror the /ws path, which keys
    by client.host, so the cap is enforced per client. Falls back to the bare
    base key when the client address is unavailable (preserving prior
    behaviour rather than failing open).
    """
    host = None
    if request is not None and request.client is not None:
        host = request.client.host
    return f"{base}_{host}" if host else base

# Set up logging
logger = logging.getLogger(__name__)


# Pydantic schemas for API
def _sanitize_text_field(value: str) -> str:
    """Strip/reject control characters from text fields."""
    import unicodedata
    # Remove control characters (except common whitespace like space)
    cleaned = "".join(
        ch for ch in value if unicodedata.category(ch)[0] != "C" or ch in (" ",)
    )
    cleaned = cleaned.strip()
    if not cleaned:
        raise ValueError("Field must not be empty after removing control characters")
    return cleaned


def _decode_task_json_list(raw: Optional[str]) -> list:
    """Decode a JSON-encoded list column on the Task model.

    v7.5.12 enrichment columns (acceptance_criteria, notes, logs) are stored
    as JSON-encoded text. Returns [] for NULL / empty / malformed values so
    the API response is always shape-stable.
    """
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []


def _encode_task_json_list(value: Any) -> Optional[str]:
    """Encode a list (or list-of-pydantic-models) as JSON for storage.

    Pydantic models are dumped via .model_dump(mode='json') so nested
    datetimes serialize as ISO strings. Plain dicts go through a
    datetime-aware encoder fallback (PUT requests reach here as dicts
    via model_dump(exclude_unset=True), which leaves datetimes raw).
    Returns None for empty/None input so we don't write empty strings
    into the column.
    """
    if value is None:
        return None
    if not isinstance(value, list) or not value:
        return None
    out = []
    for item in value:
        if hasattr(item, "model_dump"):
            out.append(item.model_dump(mode="json"))
        else:
            out.append(item)
    return json.dumps(out, default=_json_default)


def _json_default(obj: Any) -> Any:
    """JSON encoder fallback for datetime / date objects."""
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def _task_response_from_db(task: Any) -> "TaskResponse":
    """Build a TaskResponse from a Task ORM row, decoding JSON columns."""
    payload = {
        "id": task.id,
        "project_id": task.project_id,
        "title": task.title,
        "description": task.description,
        "status": task.status,
        "priority": task.priority,
        "position": task.position,
        "assigned_agent_id": task.assigned_agent_id,
        "parent_task_id": task.parent_task_id,
        "estimated_duration": task.estimated_duration,
        "actual_duration": task.actual_duration,
        "created_at": task.created_at,
        "updated_at": task.updated_at,
        "completed_at": task.completed_at,
        "acceptance_criteria": _decode_task_json_list(
            getattr(task, "acceptance_criteria", None)
        ),
        "notes": _decode_task_json_list(getattr(task, "notes", None)),
        "logs": _decode_task_json_list(getattr(task, "logs", None)),
    }
    return TaskResponse.model_validate(payload)


class ProjectCreate(BaseModel):
    """Schema for creating a project."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    prd_path: Optional[str] = None
    tenant_id: int = Field(..., gt=0, description="Tenant ID (required, must be positive)")

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        return _sanitize_text_field(v)


class ProjectUpdate(BaseModel):
    """Schema for updating a project."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    prd_path: Optional[str] = None
    status: Optional[Literal["active", "archived", "completed", "paused"]] = None


class ProjectResponse(BaseModel):
    """Schema for project response."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    description: Optional[str]
    prd_path: Optional[str]
    status: str
    tenant_id: int
    created_at: datetime
    updated_at: datetime
    task_count: int = 0
    completed_task_count: int = 0


class TaskNote(BaseModel):
    """A single note attached to a task (v7.5.12)."""
    timestamp: datetime
    author: str = "system"
    body: str


class TaskLog(BaseModel):
    """A single log entry attached to a task (v7.5.12).

    Written by the runner after each RARV phase (REASON, ACT, REFLECT,
    VERIFY) so the dashboard can show per-iteration progress.
    """
    timestamp: datetime
    iteration: Optional[int] = None
    level: str = "info"  # info | warn | error
    phase: Optional[str] = None  # REASON | ACT | REFLECT | VERIFY | ...
    message: str


class TaskCreate(BaseModel):
    """Schema for creating a task."""
    project_id: int
    title: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    status: TaskStatus = TaskStatus.PENDING
    priority: TaskPriority = TaskPriority.MEDIUM
    position: int = 0
    parent_task_id: Optional[int] = None
    estimated_duration: Optional[int] = None
    # v7.5.12 enrichment (additive, all optional, default to empty list).
    acceptance_criteria: list[str] = Field(default_factory=list)
    notes: list[TaskNote] = Field(default_factory=list)
    logs: list[TaskLog] = Field(default_factory=list)

    @field_validator("title")
    @classmethod
    def validate_title(cls, v: str) -> str:
        return _sanitize_text_field(v)


class TaskUpdate(BaseModel):
    """Schema for updating a task."""
    title: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    status: Optional[TaskStatus] = None
    priority: Optional[TaskPriority] = None
    position: Optional[int] = None
    assigned_agent_id: Optional[int] = None
    estimated_duration: Optional[int] = None
    actual_duration: Optional[int] = None
    # v7.5.12 enrichment. Clients PUT a full replacement list when supplied;
    # omitted fields are left untouched (Pydantic exclude_unset semantics).
    acceptance_criteria: Optional[list[str]] = None
    notes: Optional[list[TaskNote]] = None
    logs: Optional[list[TaskLog]] = None


class TaskMove(BaseModel):
    """Schema for moving a task."""
    status: TaskStatus
    position: int


class TaskResponse(BaseModel):
    """Schema for task response."""
    model_config = ConfigDict(from_attributes=True)

    id: int
    project_id: int
    title: str
    description: Optional[str]
    status: TaskStatus
    priority: TaskPriority
    position: int
    assigned_agent_id: Optional[int]
    parent_task_id: Optional[int]
    estimated_duration: Optional[int]
    actual_duration: Optional[int]
    created_at: datetime
    updated_at: datetime
    completed_at: Optional[datetime]
    # v7.5.12 enrichment. Always present in the response (default to []) so
    # frontend code can rely on the shape; legacy DB rows with NULL columns
    # surface as empty lists via _decode_task_json_list().
    acceptance_criteria: list[str] = Field(default_factory=list)
    notes: list[TaskNote] = Field(default_factory=list)
    logs: list[TaskLog] = Field(default_factory=list)


class SessionInfo(BaseModel):
    """Info about a single running session."""
    session_id: str
    pid: int
    status: str = "running"
    log_file: str = ""


class StatusResponse(BaseModel):
    """Schema for system status response."""
    status: str
    version: str
    uptime_seconds: float
    active_sessions: int = 0
    running_agents: int = 0
    pending_tasks: int = 0
    database_connected: bool = True
    # File-based session fields
    phase: str = ""
    iteration: int = 0
    complexity: str = "standard"
    mode: str = ""
    provider: str = "claude"
    current_task: str = ""
    # v7.34.0 Phase 1: the deterministic per-run Claude session UUID derived from
    # the trust-run-id (read from .loki/state/claude-session.json). Surfaced so a
    # user can correlate the run with its Claude session JSONL (in ~/.claude/projects). Empty when
    # the run predates this field or no claude session was stamped.
    claude_session_id: str = ""
    # Session-continuity Phase 2 (#165): the active session-continuity layer for
    # the current run, read from claude-session.json. "stamp" = Phase 1
    # correlation-only (v7.34); "resume" = LOKI_RESUME_SESSION recovery resume.
    # Empty when the run predates this field or no claude session was stamped.
    claude_session_mode: str = ""
    # Track-1 (S1): the trust run_id (the proof key, format
    # run-<ts>-<pid>-<rand>) of the run in THIS engine's resolved .loki dir, read
    # from .loki/state/trust-run-id. Lets a caller correlate the run with its
    # proof/receipt without parsing the pid. Empty when no run has minted one
    # yet, or the run predates the field. NOTE for hosted callers: this reflects
    # the engine's GLOBAL/cwd .loki (_get_loki_dir), so for a build started with a
    # distinct workspace param it does NOT track that workspace's run -- read
    # <workspace>/.loki/state/trust-run-id directly for the per-workspace build.
    current_run_id: str = ""
    # Concurrent sessions (v6.4.0)
    sessions: list[SessionInfo] = []


# WebSocket connection manager
class ConnectionManager:
    """Manages WebSocket connections for real-time updates."""

    try:
        MAX_CONNECTIONS = int(os.environ.get("LOKI_MAX_WS_CONNECTIONS", "100"))
    except (ValueError, TypeError):
        MAX_CONNECTIONS = 100

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> bool:
        """Accept a new WebSocket connection. Returns False if rejected."""
        if len(self.active_connections) >= self.MAX_CONNECTIONS:
            await websocket.accept()
            await websocket.close(code=1013, reason="Connection limit reached. Try again later.")
            logger.warning(f"WebSocket connection rejected: limit of {self.MAX_CONNECTIONS} reached")
            return False
        await websocket.accept()
        self.active_connections.append(websocket)
        return True

    def disconnect(self, websocket: WebSocket) -> None:
        """Remove a WebSocket connection."""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    # Per-client send timeout (seconds). A client that does not stop reading
    # fills its TCP send buffer; without a bound the await blocks indefinitely
    # and one stalled client would freeze the whole fan-out (and the 2s
    # _push_loki_state_loop) for every other client. Drop the slow client
    # instead of blocking everyone.
    SEND_TIMEOUT_SECONDS = 5.0

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Broadcast a message to all connected clients.

        Sends run concurrently with a per-client timeout so a single stalled
        or dead client is dropped rather than blocking the fan-out.
        """
        connections = list(self.active_connections)
        if not connections:
            return

        async def _send(conn: WebSocket) -> bool:
            try:
                await asyncio.wait_for(
                    conn.send_json(message), timeout=self.SEND_TIMEOUT_SECONDS
                )
                return True
            except asyncio.TimeoutError:
                logger.debug("WebSocket send timed out, dropping slow client")
                return False
            except Exception as e:
                logger.debug(f"WebSocket send failed, client disconnected: {e}")
                return False

        results = await asyncio.gather(*(_send(c) for c in connections))
        # Clean up clients that timed out or errored.
        for conn, ok in zip(connections, results):
            if not ok:
                self.disconnect(conn)

    async def send_personal(self, websocket: WebSocket, message: dict[str, Any]) -> None:
        """Send a message to a specific client."""
        try:
            await asyncio.wait_for(
                websocket.send_json(message), timeout=self.SEND_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            logger.debug("WebSocket personal send timed out, dropping slow client")
            self.disconnect(websocket)
        except Exception as e:
            logger.debug(f"WebSocket personal send failed: {e}")
            self.disconnect(websocket)


manager = ConnectionManager()
start_time = datetime.now(timezone.utc)


_dashboard_start_time = time.time()


async def _push_loki_state_loop() -> None:
    """Background loop: push .loki/ state changes to all WebSocket clients.

    Reads dashboard-state.json every 2s when running (30s when idle) and
    broadcasts a state_update message so clients don't rely solely on polling.

    When dashboard-state.json is absent (skill-invoked sessions), reads state
    from session.json + orchestrator.json + queue files instead.
    """
    last_mtime: float = 0.0
    _last_skill_hash: str = ""  # Track skill-session state changes
    _last_budget_status: str = ""  # Track budget-status transitions (R3)
    _last_trust_signature: str = ""  # Track trust-trajectory changes (R4)
    while True:
        try:
            if not manager.active_connections:
                await asyncio.sleep(5)
                continue

            loki_dir = _get_loki_dir()
            state_file = loki_dir / "dashboard-state.json"
            _session_file = loki_dir / "session.json"

            # R3 anti-surprise-cost: proactively push a budget_status message
            # when spend crosses a threshold (ok -> warn -> exceeded), so a user
            # who is not watching the terminal sees the 80% warning in any open
            # dashboard page BEFORE the hard stop at 100%. Reuses the existing
            # WebSocket broadcast path (manager.broadcast); no second channel.
            # Sent on transition (independent of the dashboard-state.json mtime
            # gate) because budget can cross 80% while that file is unchanged.
            try:
                _budget = _compute_budget_snapshot(loki_dir)
                _bstatus = _budget.get("status", "none")
                if _bstatus in ("warn", "exceeded") and _bstatus != _last_budget_status:
                    await manager.broadcast({
                        "type": "budget_status",
                        "data": _budget,
                    })
                # Track every status so a return to ok/none re-arms the warn push.
                _last_budget_status = _bstatus
            except (OSError, ValueError, KeyError):
                pass

            # R4 visible trust trajectory: proactively push a trust_update when
            # the trajectory's improving/regressing tally changes (e.g. a new
            # run just landed a council pass), so an open dashboard reflects the
            # earned-autonomy trend without a manual refresh. Mirrors the R3
            # budget_status transition push; reuses manager.broadcast (no second
            # channel). Signature gates the push so we only broadcast on change.
            try:
                _tmod = _load_trust_module()
                if _tmod is not None:
                    _traj = _tmod.compute_trajectory(str(loki_dir))
                    _sig = "%d:%d:%d" % (
                        _traj.get("runs_count", 0),
                        _traj.get("improving_count", 0),
                        _traj.get("regressing_count", 0),
                    )
                    if _sig != _last_trust_signature:
                        await manager.broadcast({
                            "type": "trust_update",
                            "data": _traj,
                        })
                    _last_trust_signature = _sig
            except (OSError, ValueError, KeyError):
                pass

            _broadcast_sent = False

            if state_file.exists():
                try:
                    mtime = state_file.stat().st_mtime
                except OSError:
                    mtime = 0.0

                # Only broadcast if file changed
                if mtime != last_mtime:
                    last_mtime = mtime
                    try:
                        raw = _safe_json_read(state_file, {})
                        # Transform to StatusResponse-compatible format
                        # BUG-NEW-001: Validate agent PIDs (match get_status behavior)
                        agents_list = raw.get("agents", [])
                        running_agents = 0
                        if isinstance(agents_list, list):
                            for _agent in agents_list:
                                _apid = _agent.get("pid") if isinstance(_agent, dict) else None
                                if _apid:
                                    try:
                                        os.kill(int(_apid), 0)
                                        running_agents += 1
                                    except (OSError, ValueError, TypeError):
                                        pass
                                else:
                                    running_agents += 1  # No PID field -- count as running (legacy)
                        tasks = raw.get("tasks", {})
                        pending = tasks.get("pending", [])
                        in_prog = tasks.get("inProgress", [])
                        # BUG-NEW-006: Cross-check PID to avoid broadcasting
                        # stale "running" status when process has crashed
                        _pid_alive = False
                        _ws_pid_file = loki_dir / "loki.pid"
                        if _ws_pid_file.exists():
                            try:
                                _ws_pid = int(_ws_pid_file.read_text().strip())
                                os.kill(_ws_pid, 0)
                                _pid_alive = True
                            except (ValueError, OSError, ProcessLookupError):
                                pass

                        # Also check session.json for skill sessions
                        if not _pid_alive and _session_file.exists():
                            try:
                                _sd = _safe_json_read(_session_file, {})
                                if _sd.get("status") == "running":
                                    _pid_alive = True
                            except (json.JSONDecodeError, KeyError):
                                pass

                        status_str = raw.get("mode", "autonomous")
                        if not _pid_alive:
                            status_str = "stopped"
                        elif status_str == "paused":
                            status_str = "paused"
                        elif status_str in ("stopped", ""):
                            status_str = "stopped"
                        else:
                            status_str = "running"

                        payload = {
                            "status": status_str,
                            "phase": raw.get("phase", ""),
                            "iteration": raw.get("iteration", 0),
                            "complexity": raw.get("complexity", "standard"),
                            "mode": raw.get("mode", ""),
                            "provider": raw.get("provider", "claude"),
                            "running_agents": running_agents,
                            "pending_tasks": len(pending) if isinstance(pending, list) else 0,
                            "current_task": in_prog[0].get("payload", {}).get("action", "") if isinstance(in_prog, list) and in_prog else "",
                            # Version reflects the RUNNING engine, not the project's
                            # stored state. raw.get("version") is whatever engine
                            # last wrote dashboard-state.json for THIS project (can
                            # be an old version, e.g. a project first built under
                            # 7.7.29), which made the displayed version flip between
                            # this stale value and the live one from the fallback
                            # path below. Always use the live engine version.
                            "version": _version,
                        }
                        await manager.broadcast({
                            "type": "status_update",
                            "data": payload,
                        })
                        _broadcast_sent = True
                    except (json.JSONDecodeError, OSError, KeyError):
                        pass

            # Skill-session fallback: when dashboard-state.json is missing,
            # read state from session.json + orchestrator.json + queue files
            if not _broadcast_sent and _session_file.exists():
                try:
                    _sd = _safe_json_read(_session_file, {})
                    if _sd.get("status") == "running":
                        # Validate freshness (5 min staleness threshold)
                        _sk_ts = _sd.get("updatedAt") or _sd.get("startedAt", "")
                        _sk_fresh = True
                        if _sk_ts:
                            try:
                                _sk_dt = datetime.fromisoformat(
                                    _sk_ts.replace("Z", "+00:00")
                                )
                                if _sk_dt.tzinfo is None:
                                    _sk_dt = _sk_dt.replace(tzinfo=timezone.utc)
                                if (datetime.now(timezone.utc) - _sk_dt).total_seconds() > 300:
                                    _sk_fresh = False
                            except (ValueError, AttributeError):
                                pass
                        else:
                            try:
                                if time.time() - _session_file.stat().st_mtime > 300:
                                    _sk_fresh = False
                            except OSError:
                                pass

                        if _sk_fresh:
                            # Version reflects the running engine (single source of
                            # truth), the same value the dashboard-state path uses
                            # above, so the displayed version never flips.
                            _sk_version = _version

                            # Read orchestrator state
                            _sk_phase = ""
                            _sk_iteration = 0
                            _sk_complexity = "standard"
                            _orch_f = loki_dir / "state" / "orchestrator.json"
                            if _orch_f.exists():
                                try:
                                    _orch = _safe_json_read(_orch_f, {})
                                    _sk_phase = _orch.get("currentPhase", "") or ""
                                    _sk_iteration = _orch.get("iteration", 0)
                                    _sk_complexity = _orch.get("complexity", "standard") or "standard"
                                except (json.JSONDecodeError, KeyError):
                                    pass

                            # Read pending tasks
                            _sk_pending = 0
                            _sk_current_task = ""
                            _pf = loki_dir / "queue" / "pending.json"
                            if _pf.exists():
                                try:
                                    _pd = _safe_json_read(_pf, [])
                                    _pt = _pd.get("tasks", _pd) if isinstance(_pd, dict) else _pd
                                    if isinstance(_pt, list):
                                        _sk_pending = len(_pt)
                                except (json.JSONDecodeError, KeyError, AttributeError):
                                    pass

                            _ipf = loki_dir / "queue" / "in-progress.json"
                            if _ipf.exists():
                                try:
                                    _ipd = _safe_json_read(_ipf, [])
                                    _ipt = _ipd.get("tasks", _ipd) if isinstance(_ipd, dict) else _ipd
                                    if isinstance(_ipt, list) and _ipt:
                                        _f = _ipt[0]
                                        if isinstance(_f, dict):
                                            _sk_current_task = (
                                                _f.get("title", "")
                                                or _f.get("payload", {}).get("action", "")
                                                or _f.get("id", "")
                                            )
                                except (json.JSONDecodeError, KeyError, AttributeError):
                                    pass

                            if not _sk_current_task:
                                _ctf = loki_dir / "queue" / "current-task.json"
                                if _ctf.exists():
                                    try:
                                        _ct = _safe_json_read(_ctf, {})
                                        if isinstance(_ct, dict):
                                            _sk_current_task = (
                                                _ct.get("title", "")
                                                or _ct.get("payload", {}).get("action", "")
                                                or _ct.get("id", "")
                                            )
                                    except (json.JSONDecodeError, KeyError, AttributeError):
                                        pass

                            # Build a change hash to avoid redundant broadcasts
                            _sk_hash = f"{_sk_phase}:{_sk_iteration}:{_sk_pending}:{_sk_current_task}"
                            if _sk_hash != _last_skill_hash:
                                _last_skill_hash = _sk_hash
                                payload = {
                                    "status": "running",
                                    "phase": _sk_phase,
                                    "iteration": _sk_iteration,
                                    "complexity": _sk_complexity,
                                    "mode": "autonomous",
                                    "provider": _sd.get("provider", "claude"),
                                    "running_agents": 0,
                                    "pending_tasks": _sk_pending,
                                    "current_task": _sk_current_task,
                                    "version": _sk_version,
                                }
                                await manager.broadcast({
                                    "type": "status_update",
                                    "data": payload,
                                })
                                _broadcast_sent = True
                except (json.JSONDecodeError, OSError, KeyError):
                    pass

            # Poll faster when a session is running
            pid_file = loki_dir / "loki.pid"
            is_running = False
            if pid_file.exists():
                try:
                    pid = int(pid_file.read_text().strip())
                    os.kill(pid, 0)
                    is_running = True
                except (ValueError, OSError, ProcessLookupError):
                    pass

            # Also consider skill sessions as "running" for poll interval
            if not is_running and _session_file.exists():
                try:
                    _sd2 = _safe_json_read(_session_file, {})
                    if _sd2.get("status") == "running":
                        is_running = True
                except (json.JSONDecodeError, KeyError):
                    pass

            await asyncio.sleep(2.0 if is_running else 30.0)
        except asyncio.CancelledError:
            return
        except Exception:
            await asyncio.sleep(5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup
    try:
        await init_db()
        app.state.db_available = True
    except Exception as exc:
        logger.error("Database init failed: %s -- DB routes will return 503", exc)
        app.state.db_available = False
    _telemetry.send_telemetry("dashboard_start")
    push_task = asyncio.create_task(_push_loki_state_loop())
    yield
    # Shutdown
    push_task.cancel()
    try:
        await push_task
    except (asyncio.CancelledError, Exception):
        pass
    await close_db()


# Create FastAPI app
app = FastAPI(
    title="Loki Mode Dashboard API",
    description="REST API for Loki Mode project and task management",
    version=_version,
    lifespan=lifespan,
)

# Add CORS middleware - restricted to localhost by default.
# Set LOKI_DASHBOARD_CORS to override (comma-separated origins).
_cors_default = "http://localhost:57374,http://127.0.0.1:57374"
_cors_raw = os.environ.get("LOKI_DASHBOARD_CORS", _cors_default)
_cors_origins = [o.strip() for o in _cors_raw.split(",") if o.strip()]
if "*" in _cors_origins or _cors_raw.strip() == "*":
    if os.environ.get("LOKI_ENV") == "production":
        raise RuntimeError(
            "Wildcard CORS ('*') is not allowed in production. "
            "Set LOKI_DASHBOARD_CORS to a specific origin list, "
            "or set LOKI_ENV != production."
        )
    logger.warning(
        "LOKI_DASHBOARD_CORS is set to '*' -- all origins are allowed. "
        "This is insecure for production deployments."
    )
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
)

# Static file serving is configured at the end of the file (after all API routes)

# Mount V2 API router
from .api_v2 import router as api_v2_router
app.include_router(api_v2_router)

# Phase Merge-4: Mount Purple Lab FastAPI app under /lab/ so it appears as a
# sidebar entry in Dashboard. Same `app` is also wrapped by `standalone_app`
# in web-app/server.py for `loki web` (port 57375). One source of truth, no
# duplicated UIs. Import is best-effort: if web-app is missing (e.g. partial
# install) the dashboard still starts; /lab/* returns 404 with a clear hint.
class _MountAuthGuard:
    """ASGI wrapper that enforces the dashboard's scope auth at a mount boundary.

    Starlette does NOT propagate the parent app's route dependencies to a
    mounted sub-app, so without this wrapper the Purple Lab routes (including
    file write/delete and a process-spawn endpoint in web-app/server.py) are
    reachable UNAUTHENTICATED when enterprise auth is enabled. This wrapper
    runs the same token validation as the dashboard's own require_scope("read")
    dependency before delegating to the sub-app.

    When enterprise auth (and OIDC) are OFF, get_current_token returns None and
    has_scope is never reached: the request passes through unchanged, so local
    default-mode behavior is identical to an unguarded mount.
    """

    def __init__(self, app, required_scope: str = "read") -> None:
        self._app = app
        self._required_scope = required_scope

    @staticmethod
    def _validate_ws_token(token_str: "str | None") -> "dict | None":
        # Mirror the HTTP get_current_token order: try OIDC first for a non-loki_
        # token (JWTs do not carry the loki_ prefix), then fall back to loki token
        # auth. This keeps WS auth consistent with the HTTP path so an OIDC-only
        # deployment can authenticate WS clients too (not just loki_ tokens).
        if not token_str:
            return None
        if auth.is_oidc_mode() and not token_str.startswith("loki_"):
            oidc_info = auth.validate_oidc_token(token_str)
            if oidc_info:
                return oidc_info
        if auth.is_enterprise_mode():
            return auth.validate_token(token_str)
        return None

    @staticmethod
    def _ws_token_from_scope(scope) -> "str | None":
        # A browser WebSocket cannot set an Authorization header, so accept the
        # token either from an Authorization: Bearer header (programmatic clients)
        # or from a ?token= / ?access_token= query parameter (browser clients),
        # matching how scoped WS clients pass credentials elsewhere.
        for raw_name, raw_val in scope.get("headers", []) or []:
            if raw_name == b"authorization":
                val = raw_val.decode("latin-1", "ignore")
                if val.lower().startswith("bearer "):
                    return val[7:].strip() or None
                return val.strip() or None
        from urllib.parse import parse_qs
        qs = scope.get("query_string", b"") or b""
        params = parse_qs(qs.decode("latin-1", "ignore"))
        for key in ("token", "access_token"):
            if params.get(key):
                return params[key][0] or None
        return None

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] == "lifespan":
            # Lifespan has no client request; nothing to authenticate.
            await self._app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            # The Purple Lab sub-app exposes WebSocket endpoints (a PTY terminal
            # and an HMR proxy). Starlette does not run the parent auth on them,
            # so without this branch /lab/ws/* would be reachable unauthenticated
            # when enterprise auth is on (a PTY login shell with no auth). Validate
            # the same scoped token as the HTTP path; on failure close the
            # handshake with policy-violation 1008 BEFORE delegating to the sub-app.
            if not auth.is_enterprise_mode() and not auth.is_oidc_mode():
                await self._app(scope, receive, send)
                return
            token_str = self._ws_token_from_scope(scope)
            token_info = self._validate_ws_token(token_str)
            if token_info is None or not auth.has_scope(token_info, self._required_scope):
                # ASGI websocket reject: accept-then-close is the portable way to
                # surface a policy violation to the client before any sub-app code
                # runs. 1008 = policy violation.
                await send({"type": "websocket.close", "code": 1008})
                return
            await self._app(scope, receive, send)
            return
        from starlette.requests import Request as _StarletteRequest
        request = _StarletteRequest(scope, receive)
        # Reuse the exact dashboard auth path: get_current_token is a no-op
        # (returns None) when auth is disabled, raises 401 on missing/bad
        # credentials when enabled.
        try:
            credentials = await auth.security(request)
            token_info = await auth.get_current_token(request, credentials)
        except HTTPException as exc:
            await JSONResponse(
                {"detail": exc.detail},
                status_code=exc.status_code,
                headers=exc.headers,
            )(scope, receive, send)
            return
        # token_info is None only when auth is disabled -> allow through.
        if token_info is not None and not auth.has_scope(token_info, self._required_scope):
            await JSONResponse(
                {"detail": f"Insufficient permissions. Required scope: {self._required_scope}"},
                status_code=403,
            )(scope, receive, send)
            return
        await self._app(scope, receive, send)


_PURPLE_LAB_MOUNTED = False
try:
    import sys as _sys
    from pathlib import Path as _Path
    _webapp_dir = _Path(__file__).resolve().parent.parent / "web-app"
    if str(_webapp_dir) not in _sys.path:
        _sys.path.insert(0, str(_webapp_dir))
    import server as _purple_lab_server  # type: ignore[import-not-found]
    # Gate the mount so /lab/* requires the same scoped token as the dashboard's
    # own endpoints when enterprise auth is on (no-op when auth is off).
    app.mount("/lab", _MountAuthGuard(_purple_lab_server.app, "read"))
    _PURPLE_LAB_MOUNTED = True
    logger.info("Purple Lab mounted at /lab/ (Phase Merge-4)")
except Exception as _e:  # noqa: BLE001
    logger.warning("Purple Lab NOT mounted (Phase Merge-4): %s -- /lab/ will 404", _e)


# Health endpoint
@app.get("/health")
async def health_check() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "healthy", "service": "loki-dashboard"}


# Provider model catalog endpoint
# Reads providers/model_catalog.json (single source of truth) and exposes it
# to the web app so model dropdowns / defaults stay in sync without a frontend
# rebuild on every model release. Falls back to a minimal hardcoded structure
# if the catalog file is missing (degraded but functional).
@app.get("/api/providers/models")
async def get_provider_models() -> dict:
    """Return the canonical provider/model catalog."""
    candidates = [
        _Path(__file__).resolve().parent.parent / "providers" / "model_catalog.json",
        _Path("providers/model_catalog.json"),
    ]
    for path in candidates:
        if path.exists():
            try:
                with path.open("r", encoding="utf-8") as fh:
                    return json.load(fh)
            except (json.JSONDecodeError, OSError):
                continue
    # Degraded fallback so the dashboard never breaks if catalog is missing
    return {
        "schema_version": 1,
        "providers": {
            "claude": {
                "latest_planning": "claude-opus-4-7",
                "latest_development": "claude-opus-4-7",
                "latest_fast": "claude-sonnet-4-6",
                "models": [],
            }
        },
        "_fallback": True,
    }


# A2A Agent Card - advertises agent capabilities per the A2A spec
@app.get("/.well-known/agent.json", include_in_schema=False)
async def agent_card() -> dict:
    """A2A Agent Card served at /.well-known/agent.json."""
    return {
        "name": "Loki Mode",
        "version": _version,
        "description": "Multi-agent autonomous system by Autonomi. Takes PRD to fully deployed product with minimal human intervention.",
        "url": "https://www.autonomi.dev/",
        "capabilities": {
            "agents": 41,
            "swarms": 8,
            "quality_gates": 8,
            "providers": ["claude", "codex", "cline", "aider"],
            "streaming": True,
            "pushNotifications": False,
            "stateTransitionHistory": True,
        },
        "skills": [
            {"id": "prd-to-product", "name": "PRD to Product", "description": "Takes a PRD and builds a fully deployed product"},
            {"id": "code-review", "name": "Code Review", "description": "Multi-reviewer parallel code review with anti-sycophancy"},
            {"id": "testing", "name": "Testing", "description": "Comprehensive test generation and execution"},
            {"id": "deployment", "name": "Deployment", "description": "Production deployment with verification"},
        ],
        "protocols": {
            "a2a": "0.1",
            "mcp": "1.0",
        },
        "endpoints": {
            "health": "/health",
            "status": "/api/status",
            "openapi": "/openapi.json",
            "metrics": "/metrics",
            "websocket": "/ws",
        },
        "enterprise": {
            "multi_tenant": True,
            "rbac": True,
            "audit_log": True,
            "sso": auth.is_oidc_mode(),
        },
        "authentication": {
            "schemes": ["bearer", "api-key"],
        },
        "defaultInputModes": ["text/plain", "application/json"],
        "defaultOutputModes": ["text/plain", "application/json"],
    }


# Status endpoint - reads from .loki/ flat files (primary) + DB (fallback)
@app.get("/api/status", response_model=StatusResponse, dependencies=[Depends(auth.require_scope("read"))])
async def get_status() -> StatusResponse:
    """Get system status from .loki/ session files."""
    loki_dir = _get_loki_dir()
    uptime = (datetime.now(timezone.utc) - start_time).total_seconds()

    # Version reflects the running engine (single source of truth: the package
    # __version__, same value every status path uses) so the displayed version is
    # always the live engine, never a stale per-project value.
    version = _version

    # If .loki/ directory doesn't exist, return idle status immediately
    if not loki_dir.is_dir():
        return StatusResponse(
            status="idle",
            version=version,
            uptime_seconds=uptime,
        )

    # Read dashboard-state.json (written by run.sh every 2 seconds)
    state_file = loki_dir / "dashboard-state.json"
    pid_file = loki_dir / "loki.pid"
    pause_file = loki_dir / "PAUSE"
    session_file = loki_dir / "session.json"

    phase = ""
    iteration = 0
    complexity = "standard"
    mode = ""
    provider = "claude"
    current_task = ""
    pending_tasks = 0
    running_agents = 0

    # v7.34.0 Phase 1: the deterministic per-run Claude session UUID, written at
    # run-start by run.sh (correlation-only). Best-effort read; empty when the
    # file is absent (run predates the field, or a non-claude provider).
    claude_session_id = ""
    claude_session_mode = ""
    claude_session_file = loki_dir / "state" / "claude-session.json"
    if claude_session_file.exists():
        try:
            _cs = _safe_json_read(claude_session_file, {})
            # Guard against a syntactically-valid non-object JSON (array, string,
            # number) that would make .get() raise AttributeError, AND a
            # non-string VALUE that would fail StatusResponse's str validation
            # (both -> 500). The normal writer (run.sh) always emits an object
            # with a string uuid, so this only triggers on external file
            # corruption, but /api/status must never 500 on it.
            if isinstance(_cs, dict):
                _v = _cs.get("claude_session_uuid", "")
                claude_session_id = _v if isinstance(_v, str) else ""
                # Phase 2 (#165): "stamp" (Phase 1 correlation-only) or "resume"
                # (LOKI_RESUME_SESSION recovery resume). Empty when the run
                # predates the field. Same non-string guard as the uuid.
                _m = _cs.get("mode", "")
                claude_session_mode = _m if isinstance(_m, str) else ""
        except (json.JSONDecodeError, OSError, KeyError, AttributeError):
            pass

    # Track-1 (S1): the trust run_id (proof key) for the run in this resolved
    # .loki dir. Best-effort read; empty when no run has minted one yet. Lets a
    # caller correlate the run with its proof without parsing the pid.
    current_run_id = ""
    trust_run_id_file = loki_dir / "state" / "trust-run-id"
    if trust_run_id_file.exists():
        try:
            _rid = trust_run_id_file.read_text(encoding="utf-8").strip()
            current_run_id = _rid if isinstance(_rid, str) else ""
        except OSError:
            pass

    # Read dashboard state (with retry for concurrent writes)
    _has_dashboard_state = False
    if state_file.exists():
        try:
            state = _safe_json_read(state_file, {})
            if state:
                _has_dashboard_state = True
            phase = state.get("phase", "")
            iteration = state.get("iteration", 0)
            complexity = state.get("complexity", "standard")
            mode = state.get("mode", "")
            # Count only agents with alive PIDs (not raw array length)
            agents_list = state.get("agents", [])
            running_agents = 0
            for agent in agents_list:
                agent_pid = agent.get("pid")
                if agent_pid:
                    try:
                        os.kill(int(agent_pid), 0)
                        running_agents += 1
                    except (OSError, ValueError, TypeError):
                        pass
                else:
                    # No PID field -- count as running (legacy data)
                    running_agents += 1

            tasks = state.get("tasks", {})
            pending_tasks = len(tasks.get("pending", []))
            in_progress = tasks.get("inProgress", [])
            if in_progress:
                current_task = in_progress[0].get("payload", {}).get("action", "")
        except (json.JSONDecodeError, KeyError):
            pass

    # Determine running state from PID + control files
    running = False
    pid_str = ""
    if pid_file.exists():
        try:
            pid_str = pid_file.read_text().strip()
            pid = int(pid_str)
            os.kill(pid, 0)
            running = True
        except (ValueError, OSError, ProcessLookupError):
            pass

    # Also check session.json for skill-invoked sessions
    _skill_session = False
    if not running and session_file.exists():
        try:
            sd = _safe_json_read(session_file, {})
            if sd.get("status") == "running":
                # Validate freshness: session.json must have been updated within
                # the last 5 minutes to be considered active (skill agents update
                # it each turn).  Fall back to file mtime if no timestamp field.
                _session_fresh = True
                _session_ts = sd.get("updatedAt") or sd.get("startedAt", "")
                if _session_ts:
                    try:
                        _sdt = datetime.fromisoformat(
                            _session_ts.replace("Z", "+00:00")
                        )
                        if _sdt.tzinfo is None:
                            _sdt = _sdt.replace(tzinfo=timezone.utc)
                        _age = (datetime.now(timezone.utc) - _sdt).total_seconds()
                        if _age > 300:
                            _session_fresh = False
                    except (ValueError, AttributeError):
                        pass
                else:
                    # No timestamp -- check file mtime
                    try:
                        _mtime = session_file.stat().st_mtime
                        _age = time.time() - _mtime
                        if _age > 300:
                            _session_fresh = False
                    except OSError:
                        pass

                if _session_fresh:
                    running = True
                    _skill_session = True
                    # Pull provider from session.json if available
                    _sp = sd.get("provider", "")
                    if _sp:
                        provider = _sp
        except (json.JSONDecodeError, KeyError):
            pass

    # When running as a skill (no dashboard-state.json), read state from
    # the orchestrator and queue files that the skill agent writes directly.
    if _skill_session and not _has_dashboard_state:
        orch_file = loki_dir / "state" / "orchestrator.json"
        if orch_file.exists():
            try:
                orch = _safe_json_read(orch_file, {})
                phase = orch.get("currentPhase", phase) or phase
                iteration = orch.get("iteration", iteration)
                complexity = orch.get("complexity", complexity) or complexity
                _metrics = orch.get("metrics", {})
                if isinstance(_metrics, dict):
                    _tc = _metrics.get("tasksCompleted", 0)
                    _tf = _metrics.get("tasksFailed", 0)
                    if isinstance(_tc, (int, float)):
                        pass  # available for future use
            except (json.JSONDecodeError, KeyError):
                pass

        # Read pending task count from queue files
        _q_pending = loki_dir / "queue" / "pending.json"
        if _q_pending.exists():
            try:
                _qd = _safe_json_read(_q_pending, [])
                _tasks = _qd.get("tasks", _qd) if isinstance(_qd, dict) else _qd
                if isinstance(_tasks, list):
                    pending_tasks = len(_tasks)
            except (json.JSONDecodeError, KeyError, AttributeError):
                pass

        # Read current task from in-progress queue
        _q_inprog = loki_dir / "queue" / "in-progress.json"
        if _q_inprog.exists():
            try:
                _ipd = _safe_json_read(_q_inprog, [])
                _ip_tasks = _ipd.get("tasks", _ipd) if isinstance(_ipd, dict) else _ipd
                if isinstance(_ip_tasks, list) and _ip_tasks:
                    _first = _ip_tasks[0]
                    if isinstance(_first, dict):
                        current_task = (
                            _first.get("title", "")
                            or _first.get("payload", {}).get("action", "")
                            or _first.get("id", "")
                        )
            except (json.JSONDecodeError, KeyError, AttributeError):
                pass

        # Read current-task.json (skill agents write this when claiming a task)
        _q_current = loki_dir / "queue" / "current-task.json"
        if not current_task and _q_current.exists():
            try:
                _ct = _safe_json_read(_q_current, {})
                if isinstance(_ct, dict):
                    current_task = (
                        _ct.get("title", "")
                        or _ct.get("payload", {}).get("action", "")
                        or _ct.get("id", "")
                    )
            except (json.JSONDecodeError, KeyError, AttributeError):
                pass

        # Skill sessions are autonomous by definition
        if not mode:
            mode = "autonomous"

    # Determine status string
    if not running:
        status = "stopped"
    elif pause_file.exists():
        status = "paused"
    elif mode:
        status = mode  # "autonomous"
    else:
        status = "running"

    # Read provider from state
    provider_file = loki_dir / "state" / "provider"
    if provider_file.exists():
        try:
            provider = provider_file.read_text().strip() or "claude"
        except Exception:
            pass

    # Discover all running sessions (v6.4.0 - concurrent session support)
    active_session_list: list[SessionInfo] = []

    # Global session
    if running:
        try:
            _global_pid = int(pid_str) if pid_str else 0
        except (ValueError, TypeError):
            _global_pid = 0
        active_session_list.append(SessionInfo(
            session_id="global",
            pid=_global_pid,
            status=status,
        ))

    # Per-session PIDs under .loki/sessions/<id>/
    sessions_dir = loki_dir / "sessions"
    if sessions_dir.is_dir():
        for session_path in sessions_dir.iterdir():
            if not session_path.is_dir():
                continue
            sid = session_path.name
            spid_file = session_path / "loki.pid"
            if spid_file.exists():
                try:
                    spid_str = spid_file.read_text().strip()
                    spid = int(spid_str)
                    os.kill(spid, 0)
                    # Find log file if available
                    log_path = ""
                    log_candidate = loki_dir / "logs" / f"run-{sid}.log"
                    if log_candidate.exists():
                        log_path = str(log_candidate)
                    active_session_list.append(SessionInfo(
                        session_id=sid,
                        pid=spid,
                        status="running",
                        log_file=log_path,
                    ))
                except (ValueError, OSError, ProcessLookupError):
                    pass

    # Legacy run-*.pid files
    for rpf in loki_dir.glob("run-*.pid"):
        sid = rpf.stem.removeprefix("run-")
        # Skip if already found in sessions/
        if any(s.session_id == sid for s in active_session_list):
            continue
        try:
            rpid = int(rpf.read_text().strip())
            os.kill(rpid, 0)
            log_path = ""
            log_candidate = loki_dir / "logs" / f"run-{sid}.log"
            if log_candidate.exists():
                log_path = str(log_candidate)
            active_session_list.append(SessionInfo(
                session_id=sid,
                pid=rpid,
                status="running",
                log_file=log_path,
            ))
        except (ValueError, OSError, ProcessLookupError):
            pass

    total_active = len(active_session_list)

    return StatusResponse(
        status=status,
        version=version,
        uptime_seconds=uptime,
        active_sessions=total_active,
        running_agents=running_agents,
        pending_tasks=pending_tasks,
        database_connected=True,
        phase=phase,
        iteration=iteration,
        complexity=complexity,
        mode=mode,
        provider=provider,
        current_task=current_task,
        claude_session_id=claude_session_id,
        claude_session_mode=claude_session_mode,
        current_run_id=current_run_id,
        sessions=active_session_list,
    )


# Project endpoints
@app.get("/api/projects", response_model=list[ProjectResponse], dependencies=[Depends(auth.require_scope("read"))])
async def list_projects(
    status: Optional[str] = Query(None),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
) -> list[ProjectResponse]:
    """List projects with pagination. Does not eager-load tasks for efficiency.

    Tenant isolation (P3-7): a non-admin authenticated caller only sees
    projects belonging to their declared tenant (X-Loki-Tenant-ID). A global
    admin and single-user local mode (auth disabled) see all projects.
    """
    try:
        from sqlalchemy import func as sa_func

        query = select(Project)
        if status:
            query = query.where(Project.status == status)
        if not tenant_ctx.is_global_admin and tenant_ctx.auth_enabled:
            # Pin to the caller's tenant. A None tenant_id yields no matches,
            # which is the correct fail-closed behaviour for a scoped caller
            # that did not declare a tenant.
            query = query.where(Project.tenant_id == tenant_ctx.tenant_id)
        query = query.order_by(Project.created_at.desc()).offset(offset).limit(limit)

        result = await db.execute(query)
        projects = result.scalars().all()

        # Batch-fetch task counts instead of N+1 eager loading
        project_ids = [p.id for p in projects]
        response = []
        if project_ids:
            count_query = (
                select(
                    Task.project_id,
                    sa_func.count().label("total"),
                    sa_func.count().filter(Task.status == TaskStatus.DONE).label("done"),
                )
                .where(Task.project_id.in_(project_ids))
                .group_by(Task.project_id)
            )
            count_result = await db.execute(count_query)
            counts = {row.project_id: (row.total, row.done) for row in count_result}
        else:
            counts = {}

        for project in projects:
            total, done = counts.get(project.id, (0, 0))
            response.append(
                ProjectResponse(
                    id=project.id,
                    name=project.name,
                    description=project.description,
                    prd_path=project.prd_path,
                    status=project.status,
                    tenant_id=project.tenant_id,
                    created_at=project.created_at,
                    updated_at=project.updated_at,
                    task_count=total,
                    completed_task_count=done,
                )
            )
        return response
    except Exception as exc:
        logger.error("Failed to list projects: %s", exc, exc_info=True)
        raise HTTPException(status_code=500, detail="Database query failed") from exc


@app.post("/api/projects", response_model=ProjectResponse, status_code=201, dependencies=[Depends(auth.require_scope("control"))])
async def create_project(
    project: ProjectCreate,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
) -> ProjectResponse:
    """Create a new project.

    Tenant isolation (P3-7): a non-admin caller may only create projects in
    their own declared tenant; targeting another tenant returns 403.
    """
    tenant_ctx.enforce(project.tenant_id)
    # Validate tenant exists
    tenant_result = await db.execute(
        select(Tenant).where(Tenant.id == project.tenant_id)
    )
    if not tenant_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Tenant not found")

    db_project = Project(
        name=project.name,
        description=project.description,
        prd_path=project.prd_path,
        tenant_id=project.tenant_id,
    )
    db.add(db_project)
    await db.flush()
    await db.refresh(db_project)

    # Broadcast update
    await manager.broadcast({
        "type": "project_created",
        "data": {"id": db_project.id, "name": db_project.name},
    })

    return ProjectResponse(
        id=db_project.id,
        name=db_project.name,
        description=db_project.description,
        prd_path=db_project.prd_path,
        status=db_project.status,
        tenant_id=db_project.tenant_id,
        created_at=db_project.created_at,
        updated_at=db_project.updated_at,
        task_count=0,
        completed_task_count=0,
    )


@app.get("/api/projects/{project_id}", response_model=ProjectResponse, dependencies=[Depends(auth.require_scope("read"))])
async def get_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
) -> ProjectResponse:
    """Get a project by ID, scoped to the caller's tenant boundary."""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.tasks))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    tenant_ctx.enforce(project.tenant_id)

    task_count = len(project.tasks)
    completed_count = len([t for t in project.tasks if t.status == TaskStatus.DONE])

    return ProjectResponse(
        id=project.id,
        name=project.name,
        description=project.description,
        prd_path=project.prd_path,
        status=project.status,
        tenant_id=project.tenant_id,
        created_at=project.created_at,
        updated_at=project.updated_at,
        task_count=task_count,
        completed_task_count=completed_count,
    )


@app.put("/api/projects/{project_id}", response_model=ProjectResponse, dependencies=[Depends(auth.require_scope("control"))])
async def update_project(
    project_id: int,
    project_update: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
) -> ProjectResponse:
    """Update a project, scoped to the caller's tenant boundary."""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.tasks))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    tenant_ctx.enforce(project.tenant_id)

    update_data = project_update.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(project, field, value)

    await db.flush()
    await db.refresh(project)

    # Broadcast update
    await manager.broadcast({
        "type": "project_updated",
        "data": {"id": project.id, "name": project.name},
    })

    task_count = len(project.tasks)
    completed_count = len([t for t in project.tasks if t.status == TaskStatus.DONE])

    return ProjectResponse(
        id=project.id,
        name=project.name,
        description=project.description,
        prd_path=project.prd_path,
        status=project.status,
        tenant_id=project.tenant_id,
        created_at=project.created_at,
        updated_at=project.updated_at,
        task_count=task_count,
        completed_task_count=completed_count,
    )


@app.delete("/api/projects/{project_id}", status_code=204, dependencies=[Depends(auth.require_scope("control"))])
async def delete_project(
    project_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
) -> None:
    """Delete a project, scoped to the caller's tenant boundary."""
    result = await db.execute(
        select(Project).where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    tenant_ctx.enforce(project.tenant_id)

    audit.log_event(
        action="delete",
        resource_type="project",
        resource_id=str(project_id),
        details={"name": project.name},
        ip_address=request.client.host if request.client else None,
    )

    await db.delete(project)

    # Broadcast update
    await manager.broadcast({
        "type": "project_deleted",
        "data": {"id": project_id},
    })


def _parse_task_markdown(content: str, task_id: str) -> dict:
    """Parse a markdown task file into a structured task dict."""

    task = {
        "id": task_id,
        "title": task_id,
        "description": "",
        "status": "pending",
        "priority": "medium",
        "type": "task",
        "position": 0,
        "specification": "",
        "acceptance_criteria": [],
        "context_files": [],
        "metadata": {},
    }

    lines = content.split("\n")

    # Extract title from first heading
    for line in lines:
        if line.startswith("# "):
            task["title"] = line[2:].strip()
            break

    # Parse sections
    current_section = None
    section_lines = []

    for line in lines:
        if line.startswith("## "):
            # Save previous section
            if current_section:
                _apply_task_section(task, current_section, section_lines)
            current_section = line[3:].strip().lower()
            section_lines = []
        elif current_section is not None:
            section_lines.append(line)

    # Save last section
    if current_section:
        _apply_task_section(task, current_section, section_lines)

    # Store full markdown for detail view
    task["full_content"] = content

    return task


def _apply_task_section(task: dict, section: str, lines: list):
    """Apply parsed markdown section to task dict."""
    text = "\n".join(lines).strip()

    if section == "metadata":
        for line in lines:
            line = line.strip()
            if line.startswith("- "):
                parts = line[2:].split(":", 1)
                if len(parts) == 2:
                    key = parts[0].strip().lower().replace(" ", "_")
                    val = parts[1].strip()
                    task["metadata"][key] = val
                    if key == "priority":
                        task["priority"] = val.lower()
                    elif key == "team":
                        task["type"] = val
    elif section == "specification":
        task["specification"] = text
        if not task["description"]:
            # Use first paragraph as description
            for para in text.split("\n\n"):
                if para.strip():
                    task["description"] = para.strip()[:200]
                    break
    elif section in ("acceptance criteria", "acceptance_criteria"):
        criteria = []
        for line in lines:
            line = line.strip()
            if line and (line[0].isdigit() or line.startswith("- ")):
                # Strip leading number/bullet
                clean = line.lstrip("0123456789.-) ").strip()
                if clean:
                    criteria.append(clean)
        task["acceptance_criteria"] = criteria
    elif section in ("context files", "context files to read", "context_files"):
        files = []
        for line in lines:
            line = line.strip()
            if line.startswith("- "):
                files.append(line[2:].strip())
        task["context_files"] = files


# Task endpoints - reads from .loki/dashboard-state.json
@app.get("/api/tasks", dependencies=[Depends(auth.require_scope("read"))])
async def list_tasks(
    project_id: Optional[int] = Query(None),
    status: Optional[str] = Query(None),
):
    """List tasks from session state files."""
    loki_dir = _get_loki_dir()
    state_file = loki_dir / "dashboard-state.json"
    all_tasks = []

    # Read from dashboard-state.json (written by run.sh)
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
            task_groups = state.get("tasks", {})

            status_map = {
                "pending": "pending",
                "inProgress": "in_progress",
                "review": "review",
                "completed": "done",
                "failed": "done",
            }

            for group_key, mapped_status in status_map.items():
                for i, task in enumerate(task_groups.get(group_key, [])):
                    task_id = task.get("id", f"{group_key}-{i}")
                    payload = task.get("payload", {})
                    # v7.7.32: read enrichment fields from the TOP LEVEL of the
                    # task object (where run.sh writes them), falling back to
                    # payload only for legacy entries. Previously description was
                    # read solely from payload.description, so iteration tasks
                    # (which carry a top-level description + acceptance_criteria)
                    # rendered an empty modal. Pass through the same enrichment
                    # fields the queue-file path emits so the detail modal is
                    # populated regardless of which source wins.
                    task_entry = {
                        "id": task_id,
                        "title": task.get("title", payload.get("action", task.get("type", "Task"))),
                        "description": task.get("description", payload.get("description", "")),
                        "status": mapped_status,
                        "priority": task.get("priority", payload.get("priority", "medium")),
                        "type": task.get("type", "task"),
                        "position": i,
                    }
                    for _f in ("acceptance_criteria", "notes", "logs", "user_story",
                               "project", "source", "specification", "provider",
                               "startedAt", "full_content"):
                        _v = task.get(_f)
                        if _v not in (None, "", [], {}):
                            task_entry[_f] = _v
                    all_tasks.append(task_entry)
        except (json.JSONDecodeError, KeyError):
            pass

    # Also read from queue files for more detail
    queue_dir = loki_dir / "queue"
    if queue_dir.exists():
        for queue_file, q_status in [
            ("pending.json", "pending"),
            ("in-progress.json", "in_progress"),
            ("completed.json", "done"),
            ("failed.json", "done"),
            ("dead-letter.json", "done"),
        ]:
            fpath = queue_dir / queue_file
            if fpath.exists():
                try:
                    raw_items = json.loads(fpath.read_text())
                    # BUG-NEW-002: Support both array [...] and object {"tasks": [...]} formats
                    # (matches run.sh load_queue_tasks which supports both)
                    if isinstance(raw_items, dict):
                        items = raw_items.get("tasks", [])
                    elif isinstance(raw_items, list):
                        items = raw_items
                    else:
                        items = []
                    if isinstance(items, list):
                        for i, item in enumerate(items):
                            if isinstance(item, dict):
                                tid = item.get("id", f"q-{q_status}-{i}")
                                # Skip if already in all_tasks
                                if any(t["id"] == tid for t in all_tasks):
                                    continue
                                task_entry = {
                                    "id": tid,
                                    "title": item.get("title", item.get("action", "Task")),
                                    "description": item.get("description", ""),
                                    "status": q_status,
                                    "priority": item.get("priority", "medium"),
                                    "type": item.get("type", "task"),
                                    "position": i,
                                }
                                if item.get("acceptance_criteria"):
                                    task_entry["acceptance_criteria"] = item["acceptance_criteria"]
                                if item.get("user_story"):
                                    task_entry["user_story"] = item["user_story"]
                                if item.get("project"):
                                    task_entry["project"] = item["project"]
                                if item.get("source"):
                                    task_entry["source"] = item["source"]
                                # v7.5.12: pass-through enrichment fields so
                                # the dashboard can render notes + per-phase logs.
                                if isinstance(item.get("notes"), list):
                                    task_entry["notes"] = item["notes"]
                                if isinstance(item.get("logs"), list):
                                    task_entry["logs"] = item["logs"]
                                all_tasks.append(task_entry)
                except (json.JSONDecodeError, KeyError):
                    pass

        # Read markdown task files from queue subdirectories
        for subdir, q_status in [
            ("pending", "pending"),
            ("active", "in_progress"),
            ("review", "review"),
            ("done", "done"),
        ]:
            dir_path = queue_dir / subdir
            if not dir_path.is_dir():
                continue
            for md_file in sorted(dir_path.glob("*.md")):
                tid = md_file.stem
                if any(t["id"] == tid for t in all_tasks):
                    continue
                try:
                    content = md_file.read_text(errors="replace")
                    parsed = _parse_task_markdown(content, tid)
                    parsed["status"] = q_status
                    parsed["position"] = len([t for t in all_tasks if t["status"] == q_status])
                    all_tasks.append(parsed)
                except Exception:
                    pass

    # Apply project_id filter if provided
    if project_id is not None:
        all_tasks = [t for t in all_tasks if t.get("project_id") == project_id]

    # Apply status filter if provided
    if status:
        all_tasks = [t for t in all_tasks if t["status"] == status]

    return all_tasks


@app.post("/api/tasks", response_model=TaskResponse, status_code=201, dependencies=[Depends(auth.require_scope("control"))])
async def create_task(
    task: TaskCreate,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
) -> TaskResponse:
    """Create a new task, scoped to the caller's tenant boundary."""
    # Enforce the tenant boundary on the target project (also 404s if missing).
    await _enforce_project_tenant(db, tenant_ctx, task.project_id)
    # Verify project exists
    result = await db.execute(
        select(Project).where(Project.id == task.project_id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Project not found")

    # Validate parent task if specified
    if task.parent_task_id:
        result = await db.execute(
            select(Task).where(
                Task.id == task.parent_task_id,
                Task.project_id == task.project_id
            )
        )
        parent = result.scalar_one_or_none()
        if not parent:
            raise HTTPException(
                status_code=400,
                detail="Parent task not found or belongs to different project"
            )

        # Detect circular reference: walk parent chain
        visited = set()
        current_parent_id = task.parent_task_id
        while current_parent_id is not None:
            if current_parent_id in visited:
                raise HTTPException(
                    status_code=422,
                    detail="Circular reference detected in parent task chain"
                )
            visited.add(current_parent_id)
            parent_result = await db.execute(
                select(Task.parent_task_id).where(Task.id == current_parent_id)
            )
            row = parent_result.scalar_one_or_none()
            current_parent_id = row if row else None

    db_task = Task(
        project_id=task.project_id,
        title=task.title,
        description=task.description,
        status=task.status,
        priority=task.priority,
        position=task.position,
        parent_task_id=task.parent_task_id,
        estimated_duration=task.estimated_duration,
        acceptance_criteria=_encode_task_json_list(task.acceptance_criteria),
        notes=_encode_task_json_list(task.notes),
        logs=_encode_task_json_list(task.logs),
    )
    db.add(db_task)
    await db.flush()
    await db.refresh(db_task)

    # Broadcast update
    await manager.broadcast({
        "type": "task_created",
        "data": {
            "id": db_task.id,
            "project_id": db_task.project_id,
            "title": db_task.title,
            "status": db_task.status.value,
        },
    })

    return _task_response_from_db(db_task)


@app.get("/api/tasks/{task_id}", response_model=TaskResponse, dependencies=[Depends(auth.require_scope("read"))])
async def get_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
) -> TaskResponse:
    """Get a task by ID, scoped to the caller's tenant boundary."""
    result = await db.execute(
        select(Task).where(Task.id == task_id)
    )
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    await _enforce_project_tenant(db, tenant_ctx, task.project_id)

    return _task_response_from_db(task)


@app.put("/api/tasks/{task_id}", response_model=TaskResponse, dependencies=[Depends(auth.require_scope("control"))])
async def update_task(
    task_id: int,
    task_update: TaskUpdate,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
) -> TaskResponse:
    """Update a task, scoped to the caller's tenant boundary."""
    result = await db.execute(
        select(Task).where(Task.id == task_id)
    )
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    await _enforce_project_tenant(db, tenant_ctx, task.project_id)

    update_data = task_update.model_dump(exclude_unset=True)

    # Handle status change to/from completed
    if "status" in update_data:
        if update_data["status"] == TaskStatus.DONE:
            update_data["completed_at"] = datetime.now(timezone.utc)
        else:
            update_data["completed_at"] = None

    # v7.5.12: encode enrichment list columns as JSON before persisting.
    for _enrich_col in ("acceptance_criteria", "notes", "logs"):
        if _enrich_col in update_data:
            update_data[_enrich_col] = _encode_task_json_list(update_data[_enrich_col])

    for field, value in update_data.items():
        setattr(task, field, value)

    await db.flush()
    await db.refresh(task)

    # Broadcast update
    await manager.broadcast({
        "type": "task_updated",
        "data": {
            "id": task.id,
            "project_id": task.project_id,
            "title": task.title,
            "status": task.status.value,
        },
    })

    return _task_response_from_db(task)


@app.delete("/api/tasks/{task_id}", status_code=204, dependencies=[Depends(auth.require_scope("control"))])
async def delete_task(
    task_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
) -> None:
    """Delete a task, scoped to the caller's tenant boundary."""
    result = await db.execute(
        select(Task).where(Task.id == task_id)
    )
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    await _enforce_project_tenant(db, tenant_ctx, task.project_id)

    project_id = task.project_id

    audit.log_event(
        action="delete",
        resource_type="task",
        resource_id=str(task_id),
        details={"project_id": project_id, "title": task.title},
        ip_address=request.client.host if request.client else None,
    )

    await db.delete(task)

    # Broadcast update
    await manager.broadcast({
        "type": "task_deleted",
        "data": {"id": task_id, "project_id": project_id},
    })


# Valid status transitions for task state machine
_TASK_STATE_MACHINE: dict[TaskStatus, set[TaskStatus]] = {
    TaskStatus.BACKLOG: {TaskStatus.PENDING},
    TaskStatus.PENDING: {TaskStatus.IN_PROGRESS},
    TaskStatus.IN_PROGRESS: {TaskStatus.REVIEW, TaskStatus.DONE},
    TaskStatus.REVIEW: {TaskStatus.DONE, TaskStatus.IN_PROGRESS},
    TaskStatus.DONE: {TaskStatus.IN_PROGRESS, TaskStatus.REVIEW},
}


@app.post("/api/tasks/{task_id}/move", response_model=TaskResponse, dependencies=[Depends(auth.require_scope("control"))])
async def move_task(
    task_id: int,
    move: TaskMove,
    db: AsyncSession = Depends(get_db),
    tenant_ctx: TenantContext = Depends(resolve_tenant_context),
) -> TaskResponse:
    """Move a task to a new status/position (for Kanban drag-and-drop).

    Scoped to the caller's tenant boundary.
    """
    result = await db.execute(
        select(Task).where(Task.id == task_id)
    )
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    await _enforce_project_tenant(db, tenant_ctx, task.project_id)

    old_status = task.status

    # Validate status transition
    if move.status != old_status:
        allowed = _TASK_STATE_MACHINE.get(old_status, set())
        if move.status not in allowed:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid status transition: {old_status.value} -> {move.status.value}. "
                       f"Allowed transitions from {old_status.value}: "
                       f"{', '.join(s.value for s in allowed) if allowed else 'none'}",
            )

    task.status = move.status
    task.position = move.position

    # Set completed_at if moving to completed
    if move.status == TaskStatus.DONE and old_status != TaskStatus.DONE:
        task.completed_at = datetime.now(timezone.utc)
    elif move.status != TaskStatus.DONE:
        task.completed_at = None

    await db.flush()
    await db.refresh(task)

    # Broadcast update
    await manager.broadcast({
        "type": "task_moved",
        "data": {
            "id": task.id,
            "project_id": task.project_id,
            "title": task.title,
            "old_status": old_status.value,
            "new_status": task.status.value,
            "position": task.position,
        },
    })

    return _task_response_from_db(task)


# WebSocket endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """WebSocket endpoint for real-time updates.

    When enterprise auth or OIDC is enabled, a valid token must be passed
    as a query parameter: ``/ws?token=loki_xxx`` (or a JWT for OIDC).
    Browsers cannot send Authorization headers on WebSocket upgrade
    requests, so query-parameter auth is the standard approach.
    """
    # --- WebSocket authentication gate ---
    # NOTE: Query-parameter auth is used because browsers cannot send
    # Authorization headers on WS upgrade. Tokens may appear in reverse
    # proxy access logs -- configure log sanitization for /ws in production.
    # FastAPI Depends() is not supported on @app.websocket() routes.

    # Rate limit WebSocket connections by IP (use unique key when client info unavailable)
    import uuid as _uuid
    client_ip = websocket.client.host if websocket.client else f"ws-{_uuid.uuid4().hex}"
    if not _read_limiter.check(f"ws_{client_ip}"):
        await websocket.accept()
        await websocket.close(code=1008)  # Policy Violation
        return

    if auth.is_enterprise_mode() or auth.is_oidc_mode():
        ws_token: Optional[str] = websocket.query_params.get("token")
        if not ws_token:
            await websocket.accept()
            await websocket.close(code=1008)  # Policy Violation
            return

        token_info: Optional[dict] = None
        # Try OIDC first for JWT-style tokens
        if auth.is_oidc_mode() and not ws_token.startswith("loki_"):
            token_info = auth.validate_oidc_token(ws_token)
        # Fall back to enterprise token auth
        if token_info is None and auth.is_enterprise_mode():
            token_info = auth.validate_token(ws_token)

        if token_info is None:
            await websocket.accept()
            await websocket.close(code=1008)  # Policy Violation
            return

    connected = await manager.connect(websocket)
    if not connected:
        return
    try:
        # Send initial connection confirmation
        await manager.send_personal(websocket, {
            "type": "connected",
            "data": {"message": "Connected to Loki Dashboard"},
        })

        # Keep connection alive and handle incoming messages.
        # Close idle connections after ~60s of no response to pings.
        missed_pongs = 0
        while True:
            try:
                data = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=30.0  # Ping every 30 seconds of silence
                )
                missed_pongs = 0  # any message resets idle counter
                try:
                    message = json.loads(data)
                    if message.get("type") == "ping":
                        await manager.send_personal(websocket, {"type": "pong"})
                    elif message.get("type") == "pong":
                        pass  # client responded to our ping
                    elif message.get("type") == "subscribe":
                        await manager.send_personal(websocket, {
                            "type": "subscribed",
                            "data": message.get("data", {}),
                        })
                except json.JSONDecodeError as e:
                    logger.debug(f"WebSocket received invalid JSON: {e}")
            except asyncio.TimeoutError:
                missed_pongs += 1
                if missed_pongs >= 2:
                    # Two consecutive pings with no reply -- close idle connection
                    logger.info("Closing idle WebSocket (no pong response)")
                    break
                try:
                    await manager.send_personal(websocket, {"type": "ping"})
                except Exception:
                    break

    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        manager.disconnect(websocket)


# =============================================================================
# Cross-Project Registry API
# =============================================================================

class RegisteredProjectResponse(BaseModel):
    """Schema for registered project response."""
    id: str
    path: str
    name: str
    alias: Optional[str]
    registered_at: str
    updated_at: str
    last_accessed: Optional[str]
    has_loki_dir: bool
    status: str


class RegisterProjectRequest(BaseModel):
    """Schema for registering a project."""
    path: str
    name: Optional[str] = None
    alias: Optional[str] = None


class DiscoverResponse(BaseModel):
    """Schema for discovery response."""
    path: str
    name: str
    has_state: bool
    has_prd: bool


class SyncResponse(BaseModel):
    """Schema for sync response."""
    added: int
    updated: int
    missing: int
    total: int


class HealthResponse(BaseModel):
    """Schema for project health response."""
    status: str
    checks: dict


@app.get("/api/registry/projects", response_model=list[RegisteredProjectResponse], dependencies=[Depends(auth.require_scope("read"))])
async def list_registered_projects(include_inactive: bool = False):
    """List all registered projects."""
    projects = registry.list_projects(include_inactive=include_inactive)
    return projects


@app.post("/api/registry/projects", response_model=RegisteredProjectResponse, status_code=201, dependencies=[Depends(auth.require_scope("control"))])
async def register_project(request: RegisterProjectRequest):
    """Register a new project."""
    try:
        project = registry.register_project(
            path=request.path,
            name=request.name,
            alias=request.alias,
        )
        return project
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/registry/projects/{identifier}", response_model=RegisteredProjectResponse, dependencies=[Depends(auth.require_scope("read"))])
async def get_registered_project(identifier: str):
    """Get a registered project by ID, path, or alias."""
    project = registry.get_project(identifier)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found in registry")
    return project


@app.delete("/api/registry/projects/{identifier}", status_code=204, dependencies=[Depends(auth.require_scope("control"))])
async def unregister_project(identifier: str, request: Request):
    """Remove a project from the registry."""
    if not registry.unregister_project(identifier):
        raise HTTPException(status_code=404, detail="Project not found in registry")

    audit.log_event(
        action="delete",
        resource_type="registry_project",
        resource_id=identifier,
        ip_address=request.client.host if request.client else None,
    )


@app.get("/api/registry/projects/{identifier}/health", response_model=HealthResponse, dependencies=[Depends(auth.require_scope("read"))])
async def get_project_health(identifier: str):
    """Check the health of a registered project."""
    health = registry.check_project_health(identifier)
    if health["status"] == "not_found":
        raise HTTPException(status_code=404, detail="Project not found in registry")
    return health


@app.post("/api/registry/projects/{identifier}/access", dependencies=[Depends(auth.require_scope("control"))])
async def update_project_access(identifier: str):
    """Update the last accessed timestamp for a project."""
    project = registry.update_last_accessed(identifier)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found in registry")
    return project


@app.get("/api/registry/discover", response_model=list[DiscoverResponse], dependencies=[Depends(auth.require_scope("read"))])
async def discover_projects(max_depth: int = Query(default=3, ge=1, le=10)):
    """Discover projects with .loki directories."""
    max_depth = min(max_depth, 10)
    discovered = registry.discover_projects(max_depth=max_depth)
    return discovered


@app.post("/api/registry/sync", response_model=SyncResponse, dependencies=[Depends(auth.require_scope("control"))])
async def sync_registry():
    """Sync the registry with discovered projects."""
    if not _read_limiter.check("registry_sync"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    try:
        loop = asyncio.get_running_loop()
        result = await asyncio.wait_for(
            loop.run_in_executor(None, registry.sync_registry_with_discovery),
            timeout=30.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Registry sync timed out after 30 seconds")
    return {
        "added": result["added"],
        "updated": result["updated"],
        "missing": result["missing"],
        "total": result["total"],
    }


@app.get("/api/registry/tasks", dependencies=[Depends(auth.require_scope("read"))])
async def get_cross_project_tasks(project_ids: Optional[str] = None):
    """Get tasks from multiple projects for unified view."""
    ids = project_ids.split(",") if project_ids else None
    tasks = registry.get_cross_project_tasks(ids)
    return tasks


@app.get("/api/registry/learnings", dependencies=[Depends(auth.require_scope("read"))])
async def get_cross_project_learnings():
    """Get learnings from the global learnings database."""
    learnings = registry.get_cross_project_learnings()
    return learnings


# =============================================================================
# Fleet Observability (v1: poll the shared metadata store)
# =============================================================================
#
# HONEST SCOPE: these endpoints aggregate the data `loki start` already writes
# -- the machine-global registry (~/.loki/dashboard/projects.json) plus each
# project's own .loki/ state files. There is NO controller, CRD, or Kubernetes
# Job-watcher; a real operator watching Jobs is future work. One registered
# project maps to one fleet "run" (its current / most-recent build), which is
# the granularity the registry tracks. Cancel reuses the same STOP-file + pid
# teardown as the per-project switcher Stop. Retry is intentionally NOT exposed
# here: there is no clean cross-project re-launch primitive in the registry
# path (the original spec source lives only in each project's CWD), so retry is
# a follow-up.


class FleetRunResponse(BaseModel):
    """One fleet run = one registered project's current/most-recent build."""
    id: Optional[str] = None
    name: str
    path: str
    status: str
    running: bool
    phase: str = ""
    iteration: int = 0
    cost_usd: float = 0.0
    started_at: Optional[str] = None
    duration_seconds: Optional[int] = None
    port: Optional[int] = None


class FleetSummaryResponse(BaseModel):
    """Fleet-wide totals across all registered projects."""
    total_runs: int
    running_runs: int
    stopped_runs: int
    total_cost_usd: float


@app.get(
    "/api/fleet/runs",
    response_model=list[FleetRunResponse],
    dependencies=[Depends(auth.require_scope("read"))],
)
async def list_fleet_runs(include_inactive: bool = True):
    """List all builds across every registered project (fleet view).

    v1 polls the shared metadata store (registry + per-project .loki/ state);
    it is not a controller. Never raises: registry problems degrade to [].
    """
    if not _read_limiter.check("fleet_runs"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    return await asyncio.to_thread(registry.get_fleet_runs, include_inactive)


@app.get(
    "/api/fleet/summary",
    response_model=FleetSummaryResponse,
    dependencies=[Depends(auth.require_scope("read"))],
)
async def get_fleet_summary(include_inactive: bool = True):
    """Fleet-wide totals (counts + summed cost) across registered projects."""
    if not _read_limiter.check("fleet_summary"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    return await asyncio.to_thread(registry.get_fleet_summary, include_inactive)


@app.get(
    "/api/fleet/runs/{identifier}",
    response_model=FleetRunResponse,
    dependencies=[Depends(auth.require_scope("read"))],
)
async def get_fleet_run(identifier: str):
    """Get a single fleet run by registry id / path / alias.

    Resolves the identifier through the registry (never a caller-supplied
    arbitrary path), then returns that project's current build snapshot.
    """
    project = await asyncio.to_thread(registry.get_project, identifier)
    if not project:
        raise HTTPException(status_code=404, detail="Run not found in fleet")
    pid = project.get("pid")
    running = registry._pid_alive(pid)
    snap = registry._read_project_run_snapshot(project.get("path", ""))
    duration_seconds = None
    started_at = snap.get("started_at")
    if started_at:
        try:
            st = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
            if st.tzinfo is None:
                st = st.replace(tzinfo=timezone.utc)
            duration_seconds = max(
                0, int((datetime.now(timezone.utc) - st).total_seconds())
            )
        except (ValueError, TypeError):
            duration_seconds = None
    path = project.get("path", "")
    return FleetRunResponse(
        id=project.get("id"),
        name=project.get("name") or (os.path.basename(path) if path else "project"),
        path=path,
        status="running" if running else (project.get("status") or "unknown"),
        running=running,
        phase=snap.get("phase", ""),
        iteration=snap.get("iteration", 0),
        cost_usd=snap.get("cost_usd", 0.0),
        started_at=started_at,
        duration_seconds=duration_seconds,
        port=project.get("port"),
    )


# =============================================================================
# Active Project Focus (for AI Chat / cross-directory usage)
# =============================================================================

class FocusRequest(BaseModel):
    """Schema for setting the active project directory."""
    project_dir: str


# Mid-flight model switching: the allowlist of aliases a live run may switch to.
# MUST stay identical to the read-side allowlist in run.sh (the override file is
# fed straight into `claude --model`). Fable is the top-tier advisory model at
# 2x Opus cost; the UI shows that. `None`/empty clears the override.
_SESSION_MODEL_ALLOWLIST = ("haiku", "sonnet", "opus", "fable")

# Start-time execution-model + advisor-model allowlist. Deliberately NARROWER
# than _SESSION_MODEL_ALLOWLIST: fable is excluded on BOTH the start-time model
# picker and the advisor knob. Fable is a 2x-Opus advisory-only model and is not
# available as a Claude API dispatch model (the runner collapses it to opus), so
# offering it as a start-time execution model or advisor judge would be a cost/
# behavior surprise. The mid-run POST /api/session/model path keeps fable (that
# allowlist is unchanged) because it is an explicit live-run control.
_START_MODEL_ALLOWLIST = ("haiku", "sonnet", "opus")


def _normalize_start_model(raw: str | None) -> str:
    """Normalize a start-time model / advisor alias (haiku|sonnet|opus, no fable).

    Same trim + lowercase + exact-match rule as _normalize_session_model, but on
    the narrower _START_MODEL_ALLOWLIST. Returns "" for absent/invalid/fable so
    callers can treat empty as "no selection" (engine uses its own default).
    """
    val = (raw or "").strip().lower()
    return val if val in _START_MODEL_ALLOWLIST else ""


class SessionModelRequest(BaseModel):
    """Schema for setting (or clearing) the live run's model override."""
    # Disable Pydantic's protected "model_" namespace so a field literally named
    # "model" does not emit a warning.
    model_config = ConfigDict(protected_namespaces=())
    model: str | None = None


@app.post("/api/focus", dependencies=[Depends(auth.require_scope("control"))])
async def set_focus(request: FocusRequest):
    """Set the active project directory for .loki/ resolution.

    When the dashboard runs in one CWD but a session (e.g. AI Chat) runs
    in a different project directory, call this endpoint so the dashboard
    reads .loki/ from the correct location.
    """
    global _active_project_dir
    project_dir = request.project_dir.strip()
    if not project_dir:
        raise HTTPException(status_code=400, detail="project_dir must not be empty")
    p = _Path(project_dir).resolve()
    if not p.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory does not exist: {project_dir}")
    # Require the target directory to contain a .loki/ subdirectory to prevent
    # pointing the dashboard at arbitrary filesystem locations.
    if not (p / ".loki").is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"Directory does not contain a .loki/ subdirectory: {project_dir}"
        )
    _active_project_dir = str(p)
    return {"project_dir": _active_project_dir, "loki_dir": str(_get_loki_dir())}


@app.get("/api/focus", dependencies=[Depends(auth.require_scope("read"))])
async def get_focus():
    """Get the currently focused project directory."""
    return {
        "project_dir": _active_project_dir,
        "loki_dir": str(_get_loki_dir()),
    }


@app.delete("/api/focus", dependencies=[Depends(auth.require_scope("control"))])
async def clear_focus():
    """Clear the active project directory override (revert to CWD-based resolution)."""
    global _active_project_dir
    _active_project_dir = None
    return {"project_dir": None, "loki_dir": str(_get_loki_dir())}


def _model_override_path() -> _Path:
    """Project-scoped path to the mid-flight model override file."""
    return _get_loki_dir() / "state" / "model-override"


def _normalize_session_model(raw: str | None) -> str:
    """Canonical model-alias normalization shared with run.sh + the estimator.

    Trim, lowercase, and accept ONLY an exact allowlisted alias. A value with
    interior whitespace (e.g. "fab le") normalizes to "" and is rejected, so the
    dashboard, the runner, and the estimator agree on what a value means.
    """
    val = (raw or "").strip().lower()
    return val if val in _SESSION_MODEL_ALLOWLIST else ""


# Session-pin allowlist is BROADER than the override-file allowlist above.
# run.sh's session-pin case (run.sh:12331) accepts the four model aliases AND
# the three raw tier names (planning|development|fast) -- documented at
# skills/model-selection.md:8. The OVERRIDE file / POST path keeps the narrow
# _SESSION_MODEL_ALLOWLIST because that value is fed straight to `claude
# --model`, where tier names are not valid. The session pin is a tier route, so
# tier names ARE valid pins.
_SESSION_PIN_ALLOWLIST = _SESSION_MODEL_ALLOWLIST + ("planning", "development", "fast")


def _normalize_session_pin(raw: str | None) -> str:
    """Normalize a LOKI_SESSION_MODEL pin value (aliases + raw tier names).

    Mirrors run.sh's session-pin case: trim + lowercase, accept the four model
    aliases and the three tier names. Interior whitespace is preserved (so
    "fab le" stays junk and falls through to the default tier, exactly like the
    runner's "*" arm). Use this for the session-pin (no-override) derivation;
    use _normalize_session_model for the override-file / POST path.
    """
    val = (raw or "").strip().lower()
    return val if val in _SESSION_PIN_ALLOWLIST else ""


# Provider-config model resolution mirror.
#
# SYNC: This is a byte-faithful python port of the claude provider's tier->model
# resolution in providers/claude.sh (CLAUDE_DEFAULT_FAST / CLAUDE_DEFAULT_DEVELOPMENT
# and the PROVIDER_MODEL_FAST / PROVIDER_MODEL_DEVELOPMENT resolution chains,
# claude.sh:55-67) plus loki_apply_max_tier_clamp (claude.sh:318). The same port
# also lives in the `loki plan` estimator (autonomy/loki, _provider_model_fast /
# _provider_model_development / _loki_clamp_alias). All three readers MUST agree;
# the agreement is locked by the parity test in tests/test-model-override.sh
# ("resolver parity matrix") and the cross-route tests in test-plan-command.sh.
# If you change resolution here, change it in claude.sh AND autonomy/loki, and
# re-run those tests. The `or` chains mirror bash `:-` empty-string-fallthrough;
# allow_haiku uses an exact "true" match to mirror bash `[ "$x" = "true" ]`.
def _allow_haiku() -> bool:
    return (os.environ.get("LOKI_ALLOW_HAIKU", "false") or "false") == "true"


def _provider_model_fast() -> str:
    # claude.sh:67 -> LOKI_CLAUDE_MODEL_FAST > LOKI_MODEL_FAST > haiku-aware default.
    return (
        os.environ.get("LOKI_CLAUDE_MODEL_FAST")
        or os.environ.get("LOKI_MODEL_FAST")
        or ("haiku" if _allow_haiku() else "sonnet")
    )


def _provider_model_development() -> str:
    # claude.sh:61 -> LOKI_CLAUDE_MODEL_DEVELOPMENT > LOKI_MODEL_DEVELOPMENT > default.
    # v7.104.0: CLAUDE_DEFAULT_DEVELOPMENT is now "sonnet" (was opus) on BOTH the
    # stock and the LOKI_ALLOW_HAIKU path (claude.sh:61,65), so the default is
    # unconditionally sonnet. Keeping this mirror in sync with the sibling
    # claude.sh change is what stops GET /api/session/model reporting opus on the
    # default path while the run actually dispatches sonnet.
    return (
        os.environ.get("LOKI_CLAUDE_MODEL_DEVELOPMENT")
        or os.environ.get("LOKI_MODEL_DEVELOPMENT")
        or "sonnet"
    )


def _provider_model_planning() -> str:
    # claude.sh:60 -> LOKI_CLAUDE_MODEL_PLANNING > LOKI_MODEL_PLANNING > default.
    # v7.104.0: CLAUDE_DEFAULT_PLANNING is now "sonnet" (was opus) -- Sonnet 5 is
    # the default execution model. LOKI_ALLOW_HAIKU does not change planning.
    return (
        os.environ.get("LOKI_CLAUDE_MODEL_PLANNING")
        or os.environ.get("LOKI_MODEL_PLANNING")
        or "sonnet"
    )


def _clamp_to_max_tier(alias: str) -> str:
    """Apply the operator LOKI_MAX_TIER ceiling to a model alias.

    Mirrors providers/claude.sh loki_apply_max_tier_clamp EXACTLY (resolving the
    clamp result through the SAME provider config the runner uses): a haiku cap
    pins everything to PROVIDER_MODEL_FAST (sonnet by default, haiku when
    LOKI_ALLOW_HAIKU=true), and a sonnet cap resolves fable down to
    PROVIDER_MODEL_DEVELOPMENT (opus by default, sonnet when LOKI_ALLOW_HAIKU=true).
    The LOKI_CLAUDE_MODEL_FAST/DEVELOPMENT and LOKI_MODEL_FAST/DEVELOPMENT env
    overrides are honored too. So the dashboard's reported `effective` model agrees
    byte-for-byte with the model the run will dispatch when a cost ceiling is set.

    This is invoked with alias as both model and tier (the override-path
    convention), matching the run.sh mid-flight override clamp.
    """
    max_tier = (os.environ.get("LOKI_MAX_TIER") or "").strip().lower()
    if not max_tier:
        return alias
    if max_tier == "haiku":
        return _provider_model_fast()
    if max_tier == "sonnet":
        # The runner's sonnet arm downgrades iff tier/model is planning or fable;
        # called with alias as both, that reduces to "downgrade iff alias==fable".
        return _provider_model_development() if alias == "fable" else alias
    if max_tier == "opus":
        return "opus" if alias == "fable" else alias
    return alias


def _resolve_session_pin(alias: str) -> str:
    """Resolve a session-pin alias the way the runner's NO-OVERRIDE path does.

    The runner does NOT feed a session pin straight to --model. It maps the alias
    to an abstract TIER (run.sh:12331 -- sonnet->development, haiku->fast,
    fable->fable; opus is special-cased below) and resolves that tier through
    resolve_model_for_tier (claude.sh:353), then applies
    loki_apply_max_tier_clamp(model, REAL_tier). v7.104.0: with the Sonnet-5
    default (PROVIDER_MODEL_DEVELOPMENT=sonnet on stock config), a 'sonnet' SESSION
    pin now dispatches SONNET via the development tier -- matching a 'sonnet'
    OVERRIDE file. An 'opus' SESSION pin is special-cased to dispatch opus directly
    (no tier resolves to opus post-flip), clamped by LOKI_MAX_TIER. Use this for
    the no-override `default`/`effective` derivation so the dashboard reports the
    model the run actually dispatches on the default path.

    SYNC: byte-faithful with run.sh's session-pin case + claude.sh
    resolve_model_for_tier + loki_apply_max_tier_clamp, and with the estimator's
    _resolve_session_pin in autonomy/loki. Locked by the session-pin parity matrix
    in tests/test-model-override.sh.
    """
    _alias_norm = (alias or "").strip().lower()
    # v7.104.0 opus-pin fix: mirror run.sh + estimator. Post the Sonnet-5 default
    # flip, NO tier resolves to opus, so an opus SESSION pin must dispatch opus
    # directly (not route through planning->sonnet), clamped by LOKI_MAX_TIER.
    # sonnet/haiku pins stay on the tier route (ALLOW_HAIKU gate preserved).
    if _alias_norm == "opus":
        _mt = (os.environ.get("LOKI_MAX_TIER") or "").strip().lower()
        if not _mt:
            return "opus"
        if _mt == "haiku":
            return _provider_model_fast()
        if _mt == "sonnet":
            return _provider_model_development()
        return "opus"
    pin_tier = {
        "sonnet": "development",
        "haiku": "fast",
        "fable": "fable",
        # Raw tier-name pins (run.sh:12336 passthrough arm) map to their own
        # tier, NOT through the alias table. pin=fast -> fast tier ->
        # PROVIDER_MODEL_FAST, matching the runner's dispatch instead of
        # collapsing onto development.
        "planning": "planning",
        "development": "development",
        "fast": "fast",
    }.get(_alias_norm, "development")
    if pin_tier == "planning":
        model = _provider_model_planning()
    elif pin_tier == "fast":
        model = _provider_model_fast()
    elif pin_tier == "fable":
        # fable unavailable, collapse to opus. Claude Fable 5 is not available at
        # the Claude API ("use Opus 4.8"); the runner dispatches opus for a fable
        # pin (claude.sh resolve_model_for_tier, run.sh dispatch backstop), and
        # the estimator quotes opus. The dashboard effective model agrees so the
        # session-pin parity matrix stays green (v7.39.1).
        model = "opus"
    else:  # development (and the unknown-alias '*' fallthrough)
        model = _provider_model_development()
    max_tier = (os.environ.get("LOKI_MAX_TIER") or "").strip().lower()
    if not max_tier:
        return model
    if max_tier == "haiku":
        return _provider_model_fast()
    if max_tier == "sonnet":
        # claude.sh sonnet-cap downgrades planning/fable tiers (or a fable model)
        # to PROVIDER_MODEL_DEVELOPMENT; development/fast pass through.
        if pin_tier in ("planning", "fable") or model == "fable":
            return _provider_model_development()
        return model
    if max_tier == "opus":
        return "opus" if model == "fable" else model
    return model


@app.get("/api/session/model", dependencies=[Depends(auth.require_scope("read"))])
async def get_session_model():
    """Report the live run's model override and the effective default.

    `override` is the alias currently written to .loki/state/model-override
    (None when no override is active). `default` is the session pin alias the run
    falls back to when there is no override (LOKI_SESSION_MODEL or "sonnet").
    `effective` is the model the next iteration will actually DISPATCH, resolved
    on the SAME route the runner uses for the active case, so the dashboard never
    reports a model that differs from what the run runs:

      - OVERRIDE active: the runner feeds the alias straight to --model via
        loki_apply_max_tier_clamp(alias, alias). `effective` = _clamp_to_max_tier
        (the override-path clamp). A "sonnet" override dispatches sonnet.
      - NO override (session pin): the runner maps the pin through a tier
        (sonnet->development, haiku->fast; opus special-cased to opus) and
        resolves the tier through PROVIDER_MODEL_* (then the cost-ceiling clamp).
        `effective` = _resolve_session_pin. v7.104.0: a "sonnet" pin dispatches
        SONNET (development tier -> PROVIDER_MODEL_DEVELOPMENT=sonnet on stock
        config); an "opus" pin dispatches opus (special-cased, clamped).

    Both routes resolve through the SAME provider config the runner uses
    (LOKI_ALLOW_HAIKU plus the LOKI_CLAUDE_MODEL_PLANNING/FAST/DEVELOPMENT and
    LOKI_MODEL_* overrides) and the SAME LOKI_MAX_TIER ceiling, mirroring
    providers/claude.sh byte-for-byte. The agreement (estimator == dashboard ==
    runner) on BOTH routes -- including the no-override stock path -- is locked by
    the cross-route cases and the session-pin parity matrix in
    tests/test-model-override.sh. (Before task 568 the no-override path applied the
    override-path clamp to the pin, so a stock "sonnet" pin reported "sonnet" while
    the run dispatched opus; that gap is now closed.)

    KNOWN LIMITATION (cross-process env divergence): the resolution reads
    LOKI_MAX_TIER, LOKI_ALLOW_HAIKU, LOKI_SESSION_MODEL and the model-override env
    vars from the DASHBOARD process's environment, which is usually a different
    process than the live run. So if the run was launched with a different
    environment than the dashboard, the no-override `default`/`effective` may not
    reflect the run's real pinned tier or ceiling (e.g. a run launched with
    LOKI_SESSION_MODEL=opus while the dashboard's env has no pin still reads the
    default here). The override case reads the run's own state file, so its alias
    is always accurate and the resolution is exact whenever the dashboard shares
    the run's environment.
    """
    override = None
    try:
        p = _model_override_path()
        if p.is_file():
            override = _normalize_session_model(p.read_text()) or None
    except OSError:
        override = None
    # Session pin accepts tier names too (run.sh:12336), so use the broader
    # session-pin normalizer here (NOT the narrow override allowlist).
    default = _normalize_session_pin(os.environ.get("LOKI_SESSION_MODEL")) or "sonnet"
    # Resolve on the route the runner will actually take: override-path clamp when
    # an override file is present, session-pin tier route otherwise. This closes
    # the task-568 stock-path gap (a "sonnet" pin dispatches opus).
    if override is not None:
        effective = _clamp_to_max_tier(override)
    else:
        effective = _resolve_session_pin(default)
    # fable unavailable, collapse to opus (final dispatch backstop, mirrors run.sh
    # and the estimator). The override-path clamp leaves an uncapped fable override
    # as "fable", but the runner dispatches opus for it; the session-pin route is
    # already collapsed inside _resolve_session_pin. Apply the same collapse here so
    # the reported effective model agrees with dispatch on BOTH routes (v7.39.1).
    if effective == "fable":
        effective = "opus"
    return {
        "override": override,
        "default": default,
        "effective": effective,
        "allowed": list(_SESSION_MODEL_ALLOWLIST),
    }


@app.post("/api/session/model", dependencies=[Depends(auth.require_scope("control"))])
async def set_session_model(request: SessionModelRequest):
    """Set (or clear) the model a live Loki run uses, applied from the NEXT
    iteration boundary.

    The run reads .loki/state/model-override at the top of each iteration, so a
    switch takes effect when the current iteration finishes and the next
    `claude -p` is spawned (the model is fixed per invocation). The override
    applies to the CURRENT run only: the runner clears a leftover override at the
    start of a fresh run, so a switch does not persist into future runs. Body
    {"model": null} or {"model": ""} clears the override and reverts to the tier
    mapping. The value is allowlist-validated server-side because the file is fed
    straight into `claude --model`; arbitrary strings are rejected.

    The `effective` field reports the model the next iteration will actually use
    after the LOKI_MAX_TIER cost ceiling is applied (e.g. a fable override under
    a sonnet ceiling reports the clamped model), so the response never claims a
    model the run would clamp down. `clamped` is True when the ceiling reduced
    the requested model.
    """
    requested_raw = (request.model or "").strip().lower()
    override_path = _model_override_path()
    if requested_raw == "":
        # Clear the override; revert to tier mapping.
        try:
            if override_path.exists():
                override_path.unlink()
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Could not clear override: {exc}")
        return {"model": None, "effective": "next_iteration", "clamped": False}
    model = _normalize_session_model(requested_raw)
    if not model:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid model '{request.model}'. Allowed: {', '.join(_SESSION_MODEL_ALLOWLIST)}",
        )
    try:
        override_path.parent.mkdir(parents=True, exist_ok=True)
        override_path.write_text(model + "\n")
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not write override: {exc}")
    effective = _clamp_to_max_tier(model)
    # `clamped` reflects ONLY the LOKI_MAX_TIER cost ceiling, computed before the
    # fable->opus collapse below (the collapse is model unavailability, not a cost
    # clamp, so it must not flip `clamped`).
    clamped = effective != model
    # fable unavailable, collapse to opus (final dispatch backstop, mirrors run.sh
    # and the estimator). An uncapped fable override clamps to "fable" above but the
    # runner dispatches opus for it, so report opus as the effective model (v7.39.1).
    if effective == "fable":
        effective = "opus"
    return {"model": model, "effective": effective, "clamped": clamped}


@app.get("/api/running-projects", dependencies=[Depends(auth.require_scope("read"))])
async def list_running_projects():
    """List registered projects enriched with live status for the dashboard
    project switcher (v7.7.29 multi-project support).

    NOTE: deliberately NOT under /api/projects/* because /api/projects/{id}
    (int path param) would shadow a /api/projects/running literal and 422.

    Returns every registered project (from ~/.loki/dashboard/projects.json,
    populated by `loki start`), each annotated with:
      - running: whether the recorded orchestrator pid is still alive
      - is_active: whether it is the currently focused project
    Live-vs-stale is derived from pid liveness, which is robust even when a
    session is hard-killed (no exit hook fires). Never raises: registry
    problems degrade to an empty list.

    Registry hygiene (project switcher): the registry records every cwd ever
    seen by `loki start` and never garbage-collects, so the switcher list grows
    without bound and shows paths that no longer exist on disk. This endpoint:
      - opportunistically prunes registry entries whose path is gone AND which
        are not running (registry.prune_missing_projects), keeping the on-disk
        store small. Running projects are never pruned.
      - returns a CLEAN list: a project is included only if its path still
        exists on disk OR it is currently running (or is the active project).
      - sorts by last_accessed desc (most relevant first) and caps the list
        defensively, but never drops a running or the active project.
    """
    out = []
    try:
        projects = registry.list_projects(include_inactive=True)
    except Exception:
        projects = []
    active = _active_project_dir

    def _is_active(path: str) -> bool:
        # Compare via realpath: /api/focus resolves symlinks (e.g. macOS
        # /tmp -> /private/tmp) while the registry stores abspath, so a plain
        # abspath compare would never match a focused symlinked project.
        if not (active and path):
            return False
        try:
            return os.path.realpath(active) == os.path.realpath(path)
        except OSError:
            return os.path.abspath(active) == os.path.abspath(path)

    running_ids = set()
    for p in projects:
        path = p.get("path", "")
        pid = p.get("pid")
        running = False
        has_pid = isinstance(pid, int) and pid > 0
        if has_pid:
            try:
                os.kill(pid, 0)
                running = True  # signal 0 delivered -> pid alive
            except PermissionError:
                running = True  # pid exists but owned by another user
            except (ProcessLookupError, OSError):
                running = False  # ESRCH -> dead
        # session.json is only a FALLBACK for legacy sessions with no recorded
        # pid. v7.7.31: when a pid IS recorded but dead, that pid is
        # authoritative -- the orchestrator is gone, so do NOT let a stale
        # session.json (status still "running" after a hard kill / crash) flip
        # this back to running. Otherwise the switcher shows a dead session as
        # running and the Stop button targets a dead pid. Only consult
        # session.json when no pid was ever recorded.
        if not running and not has_pid and path:
            try:
                sess = _Path(path) / ".loki" / "session.json"
                if sess.is_file():
                    import json as _json
                    s = _json.loads(sess.read_text())
                    running = s.get("status") == "running"
            except Exception:
                pass
        path_exists = bool(path) and os.path.isdir(path)
        is_active = _is_active(path)
        if running:
            running_ids.add(p.get("id"))
        # CLEAN list: include only projects whose path still exists, or which
        # are running, or which are the active project. A dead path that is not
        # running is excluded (and pruned from the store below).
        if not (path_exists or running or is_active):
            continue
        out.append({
            "id": p.get("id"),
            "name": p.get("name") or (os.path.basename(path) if path else "project"),
            "path": path,
            "port": p.get("port"),
            "status": p.get("status"),
            "running": running,
            "is_active": is_active,
            "_last_accessed": p.get("last_accessed") or p.get("registered_at") or "",
        })

    # Opportunistically garbage-collect dead entries from the on-disk registry
    # so it never grows without bound. Running projects (by id, plus any with a
    # live recorded pid inside the helper) are retained even if the disk check
    # is racy. Best-effort: a prune failure must not break the listing.
    try:
        registry.prune_missing_projects(running_ids=running_ids)
    except Exception:
        pass

    # Most relevant first: last_accessed desc. Cap defensively, but never hide a
    # running or active project (partition them out before the cap).
    _SWITCHER_CAP = 50
    out.sort(key=lambda r: r.get("_last_accessed", ""), reverse=True)
    if len(out) > _SWITCHER_CAP:
        pinned = [r for r in out if r["running"] or r["is_active"]]
        rest = [r for r in out if not (r["running"] or r["is_active"])]
        out = pinned + rest[: max(0, _SWITCHER_CAP - len(pinned))]
    # Drop the internal sort key from the response shape.
    for r in out:
        r.pop("_last_accessed", None)
    return {"projects": out, "active_project_dir": active}


class StartBuildRequest(BaseModel):
    """Schema for starting a build from a spec via the dashboard.

    Absorbs the browser PRD-input capability: the caller supplies a spec as
    inline text (prd_text -- a one-line brief or a full PRD) OR as a path to an
    existing spec file (prd_path). Exactly one is required. provider is
    optional and validated against the supported provider list.
    """
    # prd_text is capped at 1 MiB: a real PRD is well under this, and the cap
    # bounds disk-fill / oversized-spawn from browser input (pydantic returns
    # 422 on overflow before any file write or subprocess spawn).
    prd_text: Optional[str] = Field(default=None, max_length=1_048_576)
    prd_path: Optional[str] = None
    provider: str = "claude"
    parallel: bool = False
    # Track-1 (S1): an OPTIONAL per-build workspace directory. When present and
    # path-guarded, the build runs against THIS dir (its own cwd + .loki) instead
    # of the engine's own project dir, so a hosted caller (the SaaS BFF) can run a
    # build outside the engine repo without polluting it. When OMITTED, behavior
    # is byte-identical to before this field existed (the global project dir).
    # The path is path-guarded against ALLOWED_WORKSPACE_ROOTS (see
    # _validate_workspace) -- it is NOT a free-form filesystem write target.
    workspace: Optional[str] = None
    # Start-time execution model (haiku|sonnet|opus; fable NOT accepted). When a
    # valid alias is supplied, the run is pinned to EXACTLY that model for every
    # iteration via the LOKI_CLAUDE_MODEL_{PLANNING,DEVELOPMENT,FAST} env triple
    # (see start_build). Absent/invalid -> no pin, the engine uses its own
    # default (Sonnet 5 as of v7.104.0). This is an EXACT-model pin, NOT the
    # session-pin tier route: it does not remap through tiers, so an "opus" pick
    # dispatches opus (the tier route would resolve opus->planning->sonnet on the
    # v7.104.0 stock config and thus lie). The mid-flight .loki/state/model-override
    # file is NOT usable at start time (run.sh clears it at ITERATION_COUNT==0 as a
    # deliberate session-scope reset, run.sh:15623), which is why start-time uses
    # env, not the override file.
    model: Optional[str] = None
    # Advisor / reviewer model (opt-in Opus judge). haiku|sonnet|opus; fable NOT
    # accepted. Exported as LOKI_ADVISOR_MODEL into the run env; run.sh reads it at
    # the reviewer-dispatch site (run.sh:10199) to pin the code-review judge while
    # execution stays on the chosen/default execution model. Absent/invalid -> no
    # advisor pin (reviewers use the account default).
    advisor_model: Optional[str] = None

    def validate_provider(self) -> None:
        """Validate provider is from the supported list.

        Mirrors providers/loader.sh SUPPORTED_PROVIDERS so the dashboard
        rejects providers the runtime rejects. gemini was deprecated in
        v7.5.18 (runtime removed); accepting it here let the dashboard
        report a false "Build started" while run.sh killed the child on the
        deprecation guard.
        """
        allowed = ["claude", "codex", "cline", "aider"]
        if self.provider not in allowed:
            raise ValueError(
                f"Invalid provider: {self.provider}. "
                f"Must be one of: {', '.join(allowed)}"
            )


def _validate_prd_path(raw_path: str, project_dir: _Path) -> _Path:
    """Path-guard a caller-supplied PRD path.

    Ports the proven traversal-safety logic from
    dashboard/control.py:StartRequest.validate_prd_path, but anchors the
    allowed roots to the resolved target project directory (the active
    dashboard project) plus the user's home, rather than the dashboard
    process CWD. Returns the resolved, verified path. Raises ValueError on
    any unsafe / nonexistent / non-file path.
    """
    # Reject literal traversal sequences before any resolution.
    if ".." in raw_path:
        raise ValueError("PRD path contains path traversal sequence (..)")

    prd_path = _Path(raw_path).expanduser().resolve()

    if not prd_path.exists():
        raise ValueError(f"PRD file does not exist: {raw_path}")
    if not prd_path.is_file():
        raise ValueError(f"PRD path is not a file: {raw_path}")

    # Must resolve within the target project dir or the user's home. This is
    # the post-resolution containment check: even a symlink that escaped the
    # no-".." check is caught here because relative_to is computed on the
    # fully-resolved real path.
    roots = [project_dir.resolve(), _Path.home().resolve()]
    for root in roots:
        try:
            prd_path.relative_to(root)
            return prd_path
        except ValueError:
            continue
    raise ValueError(f"PRD path is outside allowed directories: {raw_path}")


def _allowed_workspace_roots() -> list[_Path]:
    """Resolved roots a caller-supplied workspace may live under (Track-1 S1).

    Configured via LOKI_WORKSPACE_ROOTS (os.pathsep-separated absolute dirs).
    Each entry is expanded and resolved; nonexistent / non-absolute / relative
    entries are dropped (a misconfigured root must NOT silently widen the guard
    to the CWD). When the env var is unset or yields no valid root, the list is
    empty and _validate_workspace rejects every workspace -- the feature is
    opt-in by configuration, fail-closed by default.

    This is deliberately NARROWER than the PRD-path roots ([project_dir, home]):
    a build cwd runs an autonomous agent, so its root must be an explicitly
    operator-allowed location (e.g. the BFF's ENGINE_WORKSPACE_ROOT, default
    /workspaces), never the engine repo or the whole home directory.
    """
    raw = os.environ.get("LOKI_WORKSPACE_ROOTS", "").strip()
    if not raw:
        return []
    roots: list[_Path] = []
    for entry in raw.split(os.pathsep):
        entry = entry.strip()
        if not entry:
            continue
        candidate = _Path(entry).expanduser()
        if not candidate.is_absolute():
            continue
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if resolved.is_dir():
            roots.append(resolved)
    return roots


def _validate_workspace(raw_path: str) -> _Path:
    """Path-guard a caller-supplied per-build workspace dir (Track-1 S1).

    Unlike _validate_prd_path, the workspace need NOT exist yet (the BFF passes
    <ENGINE_WORKSPACE_ROOT>/<buildId>, created on first build); this guard
    normalizes a possibly-nonexistent path and verifies CONTAINMENT under one of
    LOKI_WORKSPACE_ROOTS, then the caller mkdirs it. Returns the resolved,
    verified, absolute workspace path. Raises ValueError on any unsafe path.

    Guard order:
      1. Reject literal ".." traversal sequences before any resolution.
      2. Require an absolute input (a relative path would resolve against the
         dashboard CWD -- never an intended workspace).
      3. resolve() (follows symlinks on existing parents) then assert the real
         path is under an allowed root -- catches a symlinked parent that
         escaped the no-".." check.
    """
    if not raw_path or not raw_path.strip():
        raise ValueError("workspace must be a non-empty path")
    raw_path = raw_path.strip()
    if ".." in raw_path:
        raise ValueError("workspace contains path traversal sequence (..)")

    candidate = _Path(raw_path).expanduser()
    if not candidate.is_absolute():
        raise ValueError("workspace must be an absolute path")

    try:
        ws = candidate.resolve()
    except OSError as e:
        raise ValueError(f"workspace path could not be resolved: {e}")

    roots = _allowed_workspace_roots()
    if not roots:
        raise ValueError(
            "workspace param is not enabled: set LOKI_WORKSPACE_ROOTS to one or "
            "more absolute directories before passing a workspace"
        )
    for root in roots:
        try:
            ws.relative_to(root)
            return ws
        except ValueError:
            continue
    raise ValueError(f"workspace is outside allowed roots: {raw_path}")


def _write_spec_text(prd_text: str, project_dir: _Path) -> _Path:
    """Persist an inline spec to .loki/specs/ and return its path.

    The browser one-line-brief / PRD-textarea flow lands here. The file is
    written inside the target project's .loki/specs so it is contained and
    auditable; run.sh is then started against that file path.
    """
    specs_dir = project_dir / ".loki" / "specs"
    specs_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    spec_file = specs_dir / f"dashboard-spec-{stamp}.md"
    spec_file.write_text(prd_text, encoding="utf-8")
    return spec_file


def _project_run_active(loki_dir: _Path) -> Optional[int]:
    """Single-flight check: return the live orchestrator PID if a run is active
    in this project, else None.

    Honest: checks loki.pid (process alive) first, then session.json
    status=running with a 6h staleness window (mirrors control.get_status), so
    a crashed run that left a stale session.json does not block a fresh start.
    """
    pid_file = loki_dir / "loki.pid"
    pid_str = _safe_read_text(pid_file).strip()
    if pid_str.isdigit():
        pid = int(pid_str)
        if is_process_running(pid):
            return pid

    session_file = loki_dir / "session.json"
    if session_file.exists():
        try:
            sd = json.loads(session_file.read_text())
            if sd.get("status") == "running":
                started_at = sd.get("startedAt", "")
                if started_at:
                    try:
                        st = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
                        age_h = (datetime.now(timezone.utc) - st).total_seconds() / 3600
                        if age_h <= 6:
                            return -1  # running per session.json, no usable pid
                    except (ValueError, TypeError):
                        return -1
                else:
                    return -1
        except (json.JSONDecodeError, OSError, KeyError):
            pass
    return None


@app.post("/api/control/start", dependencies=[Depends(auth.require_scope("control"))])
async def start_build(request: Request, body: StartBuildRequest):
    """Start a Loki Mode build from a spec, kicked off from the browser.

    Absorbs the one unique browser capability: PRD-input to kick off a build.
    Accepts a spec as inline text (prd_text) OR as a path (prd_path), validates
    and path-guards it, writes inline text into .loki/specs/, then spawns
    `run.sh` against the resolved spec via subprocess (same mechanism the
    standalone control app uses).

    Single-flight: refuses with 409 if a run is already active in the target
    project.
    """
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    # Validate provider.
    try:
        body.validate_provider()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # Exactly one spec source.
    has_text = bool(body.prd_text and body.prd_text.strip())
    has_path = bool(body.prd_path and body.prd_path.strip())
    if has_text == has_path:
        raise HTTPException(
            status_code=400,
            detail="Provide exactly one of prd_text or prd_path",
        )

    # Resolve the target project directory. When the caller supplies a
    # path-guarded workspace (Track-1 S1), the build runs against THAT dir (its
    # own cwd + .loki) so a hosted caller can build outside the engine repo.
    # When omitted, behavior is byte-identical to before: the active dashboard
    # project (the engine's own _get_loki_dir).
    workspace_dir: Optional[_Path] = None
    if body.workspace and body.workspace.strip():
        try:
            workspace_dir = _validate_workspace(body.workspace)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    if workspace_dir is not None:
        # The build's project dir IS the workspace; its .loki lives inside it.
        # Create it now so single-flight + spec-write below operate on the real
        # build dir (the BFF passes <root>/<buildId>, absent on first build).
        try:
            workspace_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise HTTPException(
                status_code=500, detail=f"Could not create workspace: {e}"
            )
        project_dir = workspace_dir
        loki_dir = workspace_dir / ".loki"
    else:
        loki_dir = _get_loki_dir()
        project_dir = loki_dir.parent if loki_dir.name == ".loki" else _Path.cwd()
        project_dir = project_dir.resolve()

    # Single-flight: refuse if a run is already active in this project.
    active_pid = _project_run_active(loki_dir)
    if active_pid is not None:
        detail = "A build is already running in this project"
        if active_pid > 0:
            detail += f" (PID {active_pid})"
        raise HTTPException(status_code=409, detail=detail)

    # Resolve the spec to a concrete, path-guarded file.
    try:
        if has_path:
            spec_file = _validate_prd_path(body.prd_path.strip(), project_dir)
        else:
            spec_file = _write_spec_text(body.prd_text, project_dir)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not write spec: {e}")

    # Locate run.sh (same resolver the standalone control app uses).
    skill_dir = find_skill_dir()
    run_sh = skill_dir / "autonomy" / "run.sh"
    if not run_sh.exists():
        raise HTTPException(status_code=500, detail=f"run.sh not found at {run_sh}")

    # Build args: mirror control.py:start_session (provider, optional parallel,
    # background, then the spec path).
    args = [str(run_sh), "--provider", body.provider]
    if body.parallel:
        args.append("--parallel")
    args.append("--bg")
    args.append(str(spec_file))

    # When a workspace is given, pass an explicit env that PINS run.sh to the
    # workspace. cwd alone is not enough: `loki` exports LOKI_DIR (default
    # .loki) into the dashboard process, and run.sh resolves its workspace as
    # ${LOKI_DIR:-${LOKI_TARGET_DIR:-$(pwd)}/.loki} -- an inherited LOKI_DIR
    # would override the workspace cwd and the build would write into the
    # engine's own .loki. Setting both LOKI_DIR and LOKI_TARGET_DIR makes the
    # workspace authoritative. When no workspace is given, env=None (inherit) so
    # behavior is byte-identical to before this feature.
    # Normalize the optional start-time execution model + advisor model here so we
    # know whether we need a custom env at all. Both are narrowed to
    # haiku|sonnet|opus (no fable); invalid/absent -> "" -> no pin.
    start_model = _normalize_start_model(body.model)
    advisor_model = _normalize_start_model(body.advisor_model)

    # Build a custom env only when we actually need to change something
    # (workspace pin, start-time model pin, or advisor pin). When nothing is set,
    # env stays None (inherit) so behavior is byte-identical to before.
    popen_env = None
    if workspace_dir is not None or start_model or advisor_model:
        popen_env = dict(os.environ)
    if workspace_dir is not None:
        popen_env["LOKI_TARGET_DIR"] = str(workspace_dir)
        popen_env["LOKI_DIR"] = str(loki_dir)
    if start_model:
        # EXACT-model pin (not the session-pin tier route): set all three tier
        # models to the chosen alias so resolve_model_for_tier returns the alias
        # for every tier and every iteration dispatches exactly the picked model.
        # This is the honest start-time equivalent of the mid-flight override
        # file, which run.sh clears at iteration 0. LOKI_SESSION_MODEL is set too
        # for internal coherence (the run's own tier accounting/logging), but the
        # env triple is the load-bearing dispatch-honesty mechanism: on the
        # v7.104.0 stock config the session pin alone would remap opus->planning->
        # sonnet and haiku->fast->sonnet, dispatching sonnet for both.
        popen_env["LOKI_CLAUDE_MODEL_PLANNING"] = start_model
        popen_env["LOKI_CLAUDE_MODEL_DEVELOPMENT"] = start_model
        popen_env["LOKI_CLAUDE_MODEL_FAST"] = start_model
        popen_env["LOKI_SESSION_MODEL"] = start_model
    if advisor_model:
        # Opt-in Opus (or other) judge for code review; execution model unchanged.
        popen_env["LOKI_ADVISOR_MODEL"] = advisor_model
    try:
        process = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            cwd=str(project_dir),
            env=popen_env,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise HTTPException(status_code=500, detail=f"Failed to start build: {e}")

    # Liveness check: a provider that dies on a startup guard (e.g. an
    # unsupported provider, a missing CLI, or a preflight failure in run.sh)
    # would otherwise let us report a false "Build started". Poll briefly and
    # surface an honest error if the child exits immediately.
    early_exit = None
    for _ in range(3):
        await asyncio.sleep(0.1)
        early_exit = process.poll()
        if early_exit is not None:
            break
    if early_exit is not None and early_exit != 0:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Build process exited immediately (code {early_exit}). "
                f"The '{body.provider}' provider or run.sh preflight may have "
                f"rejected the request."
            ),
        )

    # Persist provider for status tracking (same as control.py).
    try:
        state_dir = loki_dir / "state"
        state_dir.mkdir(parents=True, exist_ok=True)
        (state_dir / "provider").write_text(body.provider)
    except OSError:
        pass

    audit.log_event(
        action="start",
        resource_type="session",
        details={
            "source": "dashboard",
            "provider": body.provider,
            "spec": str(spec_file),
            "pid": process.pid,
            # Empty string when no pin was requested (engine uses its default).
            "model": start_model,
            "advisor_model": advisor_model,
        },
        ip_address=request.client.host if request.client else None,
    )

    # Best-effort: surface the trust run_id (the proof key) so the caller can
    # correlate this build to its Evidence Receipt without parsing the pid.
    # run.sh mints it into <loki_dir>/state/trust-run-id at run-start; the 0.3s
    # liveness poll above usually does NOT outlast the mint, so this is often
    # null at start time. It is RELIABLY derivable later by the caller, which
    # owns the workspace path: read <workspace>/.loki/state/trust-run-id (or the
    # newest proof under <workspace>/.loki). Null here is expected, not an error.
    run_id = ""
    try:
        rid_file = loki_dir / "state" / "trust-run-id"
        if rid_file.is_file():
            run_id = rid_file.read_text(encoding="utf-8").strip()
    except OSError:
        pass

    return {
        "success": True,
        "message": f"Build started with provider {body.provider}",
        "pid": process.pid,
        "spec": str(spec_file),
        "provider": body.provider,
        # The workspace this build runs in (echoed back; empty == engine's own
        # project dir, today's default). The caller derives the proof path from
        # this: <workspace>/.loki/state/trust-run-id.
        "workspace": str(workspace_dir) if workspace_dir is not None else "",
        # The trust run_id if already minted, else "" (see note above). When "",
        # derive it from the workspace's .loki/state/trust-run-id.
        "run_id": run_id,
        # The pinned execution + advisor models (empty == engine default). Echoed
        # so the UI can confirm what the run was actually pinned to.
        "model": start_model,
        "advisor_model": advisor_model,
    }


class RunningProjectStopRequest(BaseModel):
    """Schema for stopping a specific registered project from the switcher.

    Exactly one of id or project_dir must be provided. id is preferred;
    project_dir is accepted for symmetry with /api/focus. The provided value
    is resolved through the dashboard registry, so an arbitrary filesystem
    path is never used directly as a write target.
    """
    id: Optional[str] = None
    project_dir: Optional[str] = None


@app.post("/api/running-projects/stop", dependencies=[Depends(auth.require_scope("control"))])
async def stop_running_project(request: Request, body: RunningProjectStopRequest):
    """Stop a specific registered project (v7.7.30 per-project switcher stop).

    Resolves the project via the dashboard registry (by id or path), writes a
    STOP file into that project's .loki for a clean runner teardown, then runs
    the graceful SIGTERM -> poll-5s -> SIGKILL dance against the recorded
    orchestrator pid (not the dashboard's own _get_loki_dir). Marks the
    project's session.json and registry entry stopped so the switcher reflects
    it immediately.

    Security: the STOP file is only ever written to the path already stored in
    the registry for the resolved id, never to a caller-supplied path.
    """
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    identifier = (body.id or body.project_dir or "").strip()
    if not identifier:
        raise HTTPException(status_code=400, detail="id or project_dir is required")

    project = registry.get_project(identifier)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    project_id = project.get("id")
    audit.log_event(
        action="stop",
        resource_type="session",
        details={"source": "api", "project_id": project_id},
        ip_address=request.client.host if request.client else None,
    )

    # Validate the registry-stored path is a real dir containing .loki before
    # writing into it. Mirrors the /api/focus guard. If invalid we still mark
    # the project stopped but skip the STOP-file write.
    path = project.get("path", "")
    loki_dir = None
    if path:
        p = _Path(path)
        if p.is_dir() and (p / ".loki").is_dir():
            loki_dir = p / ".loki"

    pid = project.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        # No host pid. Two sub-cases:
        #  - A `loki docker` project registers with pid=None but may still be
        #    actively building inside a container. Its runner polls .loki/STOP
        #    (bind-mounted to the host path), so writing STOP here actually
        #    stops the containerized build -- this is the unified-dashboard Stop
        #    parity for Docker projects (the container pid is meaningless on the
        #    host, so os.kill is not an option).
        #  - A genuinely stopped project: the STOP write is harmless.
        # Write STOP when we resolved a real .loki dir, then reconcile.
        stop_signaled = False
        if loki_dir is not None:
            try:
                (loki_dir / "STOP").write_text(datetime.now(timezone.utc).isoformat())
                stop_signaled = True
            except OSError:
                pass
        registry.mark_project_stopped(project_id)
        _resp = {
            "success": True,
            "project_id": project_id,
            "stopped": stop_signaled,
            "already_stopped": not stop_signaled,
        }
        _resp.update(_dashboard_teardown_after_project_stop(path))
        return _resp

    # Write the STOP file so the runner's own cleanup STOP-branch fires for a
    # clean teardown. Only into the registry-resolved .loki dir.
    if loki_dir is not None:
        try:
            (loki_dir / "STOP").write_text(datetime.now(timezone.utc).isoformat())
        except OSError:
            pass

    # Graceful dance against the recorded orchestrator pid.
    stopped = False
    try:
        os.kill(pid, 15)  # SIGTERM
        for _ in range(10):
            await asyncio.sleep(0.5)
            try:
                os.kill(pid, 0)  # Check if still alive
            except OSError:
                stopped = True
                break
        if not stopped:
            try:
                os.kill(pid, 9)  # SIGKILL
                stopped = True
            except (OSError, ProcessLookupError):
                stopped = True
    except (ValueError, OSError, ProcessLookupError):
        # pid already dead or unsignalable -- treat as stopped.
        stopped = True

    # v7.7.33: the registry pid can be stale (a crashed/restarted session leaves
    # an orphaned loki-run-*.sh under a new pid). Reap any orchestrator whose CWD
    # is this project's dir so a stale pid cannot yield a false "stopped". Scoped
    # by cwd to this project only.
    if loki_dir is not None:
        proj_dir = loki_dir.parent
        # v7.7.34: group-kill first (atomic; reaps the orphan-prone agent child),
        # then the cwd+sentinel reaper as backstop.
        _pgid2 = _read_pgid(loki_dir)
        if _pgid2 is not None:
            await asyncio.to_thread(_killpg_project, _pgid2, _collect_protected_pids(loki_dir))
        found_any, all_gone = await asyncio.to_thread(
            _reap_orchestrators_until_clear, proj_dir, str(proj_dir))
        if found_any:
            stopped = all_gone
        elif not all_gone:
            stopped = False

    # Mark session.json stopped in that project's .loki.
    if loki_dir is not None:
        session_file = loki_dir / "session.json"
        if session_file.exists():
            try:
                sd = json.loads(session_file.read_text())
                sd["status"] = "stopped"
                atomic_write_json(session_file, sd, use_lock=True)
            except Exception:
                pass

    registry.mark_project_stopped(project_id)

    _resp = {
        "success": True,
        "project_id": project_id,
        "stopped": stopped,
        "already_stopped": False,
    }
    _resp.update(_dashboard_teardown_after_project_stop(path))
    return _resp


def _recover_spec_source(path: str) -> Optional[_Path]:
    """Find a re-launchable spec source inside a registry-stored project path.

    Retry re-runs `loki start` from a project's own working directory, so the
    spec must already live there. This never accepts a caller-supplied path: the
    project path comes from the registry and only well-known in-tree locations
    are probed. Returns the first existing spec as an absolute Path, or None when
    nothing re-launchable is found (the caller then refuses honestly rather than
    spawning a run that would no-op).

    Probe order (highest fidelity first):
      1. A hand-authored PRD in the project root or docs/ (PRD.md, prd.md,
         docs/PRD.md, docs/prd.md) -- the same set check_project_health uses.
      2. A previously generated PRD (.loki/generated-prd.md / .json) written by
         a prior no-PRD codebase-analysis run.
      3. The most recent dashboard inline spec (.loki/specs/*.md) written by the
         browser PRD-input flow.
    """
    if not path:
        return None
    try:
        base = _Path(path)
    except (TypeError, ValueError):
        return None
    if not base.is_dir():
        return None

    # 1. Hand-authored PRD.
    for rel in ("PRD.md", "prd.md", "docs/PRD.md", "docs/prd.md"):
        candidate = base / rel
        if candidate.is_file():
            return candidate.resolve()

    loki_dir = base / ".loki"

    # 2. Previously generated PRD.
    for rel in ("generated-prd.md", "generated-prd.json"):
        candidate = loki_dir / rel
        if candidate.is_file():
            return candidate.resolve()

    # 3. Most recent dashboard inline spec.
    specs_dir = loki_dir / "specs"
    if specs_dir.is_dir():
        try:
            specs = sorted(
                (s for s in specs_dir.glob("*.md") if s.is_file()),
                key=lambda s: s.stat().st_mtime,
                reverse=True,
            )
        except OSError:
            specs = []
        if specs:
            return specs[0].resolve()

    return None


@app.post(
    "/api/fleet/runs/{identifier}/retry",
    dependencies=[Depends(auth.require_scope("control"))],
)
async def retry_fleet_run(request: Request, identifier: str):
    """Re-launch ONE finished/failed build in the fleet view.

    Resolves the run via the registry (by id / path / alias), exactly like
    cancel_fleet_run, so the caller identifier is NEVER treated as a filesystem
    path. Retry re-runs `loki start` (via run.sh) from the project's own stored
    working directory against a spec source recovered from that directory.

    Guards:
      - Refuses with 409 if the project is currently running (live pid probe or a
        fresh session.json), so a retry never double-launches an active build.
      - Refuses with 409 if no re-launchable spec source exists in the project
        directory (an honest refusal: retry needs the original spec or working
        dir; we do not fabricate a launch that would no-op).

    On success the runner re-registers the project as running with its own pid
    (loki_register_running_project in run.sh); we also flip the registry status
    to running immediately so the fleet view reflects the relaunch without
    waiting for the runner's first registry write.
    """
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    project = registry.get_project(identifier)
    if not project:
        raise HTTPException(status_code=404, detail="Run not found in fleet")

    project_id = project.get("id")
    audit.log_event(
        action="retry",
        resource_type="fleet_run",
        details={"source": "api", "project_id": project_id},
        ip_address=request.client.host if request.client else None,
    )

    # Only ever operate on the registry-stored path (never the identifier).
    path = project.get("path", "")
    if not path:
        raise HTTPException(
            status_code=409,
            detail="Project has no recorded working directory; retry needs the original working dir",
        )
    proj_dir = _Path(path)
    if not proj_dir.is_dir():
        raise HTTPException(
            status_code=409,
            detail=f"Project directory no longer exists: {path}",
        )
    proj_dir = proj_dir.resolve()
    loki_dir = proj_dir / ".loki"

    # Recover a re-launchable spec from the project's own directory FIRST (before
    # the claim, so we can refuse honestly without holding the lock). Honest
    # refusal when nothing usable is present (no fabricated no-op launch).
    spec_file = await asyncio.to_thread(_recover_spec_source, str(proj_dir))
    if spec_file is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "No re-launchable spec found in the project directory. Retry "
                "needs the original spec (PRD.md, .loki/generated-prd.md, or a "
                "prior dashboard spec) or the original working dir."
            ),
        )

    # Locate run.sh (same resolver start_build uses).
    skill_dir = find_skill_dir()
    run_sh = skill_dir / "autonomy" / "run.sh"
    if not run_sh.exists():
        raise HTTPException(status_code=500, detail=f"run.sh not found at {run_sh}")

    # Atomic check-and-CLAIM (closes the double-launch TOCTOU). Two concurrent
    # retry calls on the same stopped project must not both spawn. Under the
    # registry lock we re-read the live entry, refuse if it is running (pid alive,
    # the project's own session staleness window, or already "launching" -- a
    # sibling that just claimed it), else stamp status="launching" + save. The
    # lock + persisted "launching" marker make the window indivisible: the second
    # caller sees "launching" and is refused before it can spawn.
    _live_pid = project.get("pid")
    if registry._pid_alive(_live_pid):
        raise HTTPException(
            status_code=409,
            detail="Project is currently running; cancel it before retrying",
        )
    if loki_dir.is_dir() and _project_run_active(loki_dir) is not None:
        raise HTTPException(
            status_code=409,
            detail="A build is already running in this project",
        )
    with registry._registry_lock():
        reg = registry._load_registry()
        entry = reg.get("projects", {}).get(project_id)
        if entry is not None:
            cur_status = entry.get("status")
            cur_pid = entry.get("pid")
            if cur_status == "launching" or registry._pid_alive(cur_pid):
                raise HTTPException(
                    status_code=409,
                    detail="A retry for this project is already in progress",
                )
            entry["status"] = "launching"
            entry["updated_at"] = datetime.now(timezone.utc).isoformat()
            registry._save_registry(reg)

    # Re-launch from the project's own CWD, mirroring start_build's spawn.
    args = [str(run_sh), "--bg", str(spec_file)]
    try:
        process = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
            cwd=str(proj_dir),
        )
    except (OSError, subprocess.SubprocessError) as e:
        # Release the "launching" claim so a failed spawn does not wedge the
        # project (else every future retry would be refused as in-progress).
        try:
            with registry._registry_lock():
                reg = registry._load_registry()
                entry = reg.get("projects", {}).get(project_id)
                if entry is not None and entry.get("status") == "launching":
                    entry["status"] = "stopped"
                    entry["updated_at"] = datetime.now(timezone.utc).isoformat()
                    registry._save_registry(reg)
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to retry build: {e}")

    # Flip the registry status to running immediately. The runner also
    # re-registers with its own pid on startup, but updating here gives the
    # fleet view an instant, accurate reflection of the relaunch. The
    # load->mutate->save runs under the registry lock so it does not lost-update
    # against the runner's concurrent re-registration.
    try:
        with registry._registry_lock():
            reg = registry._load_registry()
            if project_id in reg.get("projects", {}):
                reg["projects"][project_id]["status"] = "running"
                reg["projects"][project_id]["pid"] = process.pid
                reg["projects"][project_id]["updated_at"] = datetime.now(
                    timezone.utc
                ).isoformat()
                registry._save_registry(reg)
    except Exception:
        pass

    return {
        "success": True,
        "project_id": project_id,
        "retried": True,
        "pid": process.pid,
        "spec": str(spec_file),
    }


@app.post(
    "/api/fleet/runs/{identifier}/cancel",
    dependencies=[Depends(auth.require_scope("control"))],
)
async def cancel_fleet_run(request: Request, identifier: str):
    """Cancel ONE build in the fleet view.

    Resolves the run via the registry (by id / path / alias), then runs the
    same teardown the per-project switcher Stop uses: write a STOP file into the
    registry-resolved .loki dir (the only path ever written -- never a
    caller-supplied one) for a clean runner exit, SIGTERM->poll->SIGKILL the
    recorded orchestrator pid, group-kill + cwd-scoped reap as backstop, then
    mark the registry/session stopped.

    Retry (re-launch) is exposed separately at
    POST /api/fleet/runs/{identifier}/retry, which re-runs `loki start` from
    the registry-stored project directory against a spec recovered from that
    directory (refuses honestly when none exists).
    """
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    project = registry.get_project(identifier)
    if not project:
        raise HTTPException(status_code=404, detail="Run not found in fleet")

    project_id = project.get("id")
    audit.log_event(
        action="cancel",
        resource_type="fleet_run",
        details={"source": "api", "project_id": project_id},
        ip_address=request.client.host if request.client else None,
    )

    # Only ever operate on the registry-stored path.
    path = project.get("path", "")
    loki_dir = None
    if path:
        p = _Path(path)
        if p.is_dir() and (p / ".loki").is_dir():
            loki_dir = p / ".loki"

    # STOP file: clean runner teardown (also stops a containerized `loki docker`
    # build polling the bind-mounted .loki/STOP).
    stop_signaled = False
    if loki_dir is not None:
        try:
            (loki_dir / "STOP").write_text(datetime.now(timezone.utc).isoformat())
            stop_signaled = True
        except OSError:
            pass

    pid = project.get("pid")
    stopped = False
    # Ownership guard (hardening): only direct-kill the registry pid if it is STILL
    # a process whose cwd is this project's path. A stale pid reused by an unrelated
    # host process after a crash must NOT be SIGKILLed. If ownership cannot be
    # confirmed, skip the direct kill and let the cwd-scoped reaper below handle it.
    if isinstance(pid, int) and pid > 0:
        _owned = True
        try:
            _cwd = _pid_cwd(pid)
            if _cwd is not None and path:
                _owned = os.path.realpath(_cwd) == os.path.realpath(path)
        except Exception:
            _owned = True  # best-effort: if we cannot tell, preserve prior behavior
        if not _owned:
            pid = None  # do not direct-kill a pid that is not this project's
    if isinstance(pid, int) and pid > 0:
        try:
            os.kill(pid, 15)  # SIGTERM
            for _ in range(10):
                await asyncio.sleep(0.5)
                try:
                    os.kill(pid, 0)
                except OSError:
                    stopped = True
                    break
            if not stopped:
                try:
                    os.kill(pid, 9)  # SIGKILL
                    stopped = True
                except (OSError, ProcessLookupError):
                    stopped = True
        except (ValueError, OSError, ProcessLookupError):
            stopped = True
    else:
        # No host pid (genuinely stopped, or a docker build): the STOP write is
        # the cancel signal. Treat a successful STOP write as cancelled.
        stopped = stop_signaled

    # Group-kill + cwd-scoped reaper backstop against a stale pid.
    if loki_dir is not None:
        proj_dir = loki_dir.parent
        _pgid = _read_pgid(loki_dir)
        if _pgid is not None:
            await asyncio.to_thread(
                _killpg_project, _pgid, _collect_protected_pids(loki_dir)
            )
        found_any, all_gone = await asyncio.to_thread(
            _reap_orchestrators_until_clear, proj_dir, str(proj_dir)
        )
        if found_any:
            stopped = all_gone

        # Mark session.json stopped.
        session_file = loki_dir / "session.json"
        if session_file.exists():
            try:
                sd = json.loads(session_file.read_text())
                sd["status"] = "stopped"
                atomic_write_json(session_file, sd, use_lock=True)
            except Exception:
                pass

    registry.mark_project_stopped(project_id)

    return {
        "success": True,
        "project_id": project_id,
        "cancelled": stopped,
        "stop_signaled": stop_signaled,
    }


# =============================================================================
# Enterprise Features (Optional - enabled via environment variables)
# =============================================================================

@app.get("/api/enterprise/status")
async def get_enterprise_status():
    """Check which enterprise features are enabled."""
    return {
        "auth_enabled": auth.is_enterprise_mode(),
        "oidc_enabled": auth.is_oidc_mode(),
        "audit_enabled": audit.is_audit_enabled(),
        "enterprise_mode": auth.is_enterprise_mode() or auth.is_oidc_mode() or audit.is_audit_enabled(),
    }


@app.get("/api/auth/info")
async def get_auth_info():
    """Get authentication configuration info (public endpoint).

    Returns which auth methods are available so clients can determine
    how to authenticate (token-based, OIDC/SSO, or anonymous).
    """
    return {
        "token_auth_enabled": auth.ENTERPRISE_AUTH_ENABLED,
        "oidc_enabled": auth.OIDC_ENABLED,
        "oidc_issuer": auth.OIDC_ISSUER if auth.OIDC_ENABLED else None,
        "oidc_client_id": auth.OIDC_CLIENT_ID if auth.OIDC_ENABLED else None,
    }


# Token management endpoints (only active when LOKI_ENTERPRISE_AUTH=true)
class TokenCreateRequest(BaseModel):
    """Schema for creating a token."""
    name: str = Field(..., min_length=1, max_length=255, description="Human-readable token name")
    scopes: Optional[Any] = Field(None, description="Permission scopes (default: ['*'] for all)")  # list[str], Any for Python 3.8
    expires_days: Optional[int] = Field(None, gt=0, description="Days until expiration (must be positive)")


class TokenResponse(BaseModel):
    """Schema for token response."""
    id: str
    name: str
    scopes: Any  # list[str], Any for Python 3.8
    created_at: str
    expires_at: Optional[str]
    last_used: Optional[str]
    revoked: bool
    token: Optional[str] = None  # Only on creation


@app.post("/api/enterprise/tokens", response_model=TokenResponse, status_code=201, dependencies=[Depends(auth.require_scope("admin"))])
async def create_token(request: TokenCreateRequest):
    """
    Generate a new API token (enterprise only).

    The raw token is only returned once on creation - save it securely.
    """
    if not _read_limiter.check("token_create"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    if not auth.is_enterprise_mode():
        raise HTTPException(
            status_code=403,
            detail="Enterprise authentication not enabled. Set LOKI_ENTERPRISE_AUTH=true"
        )

    try:
        token_data = auth.generate_token(
            name=request.name,
            scopes=request.scopes,
            expires_days=request.expires_days,
        )

        # Audit log
        audit.log_event(
            action="create",
            resource_type="token",
            resource_id=token_data["id"],
            details={"name": request.name, "scopes": request.scopes},
        )

        return token_data
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/enterprise/tokens", response_model=list[TokenResponse], dependencies=[Depends(auth.require_scope("admin"))])
async def list_tokens(include_revoked: bool = False):
    """List all API tokens (enterprise only)."""
    if not auth.is_enterprise_mode():
        raise HTTPException(
            status_code=403,
            detail="Enterprise authentication not enabled"
        )

    return auth.list_tokens(include_revoked=include_revoked)


@app.delete("/api/enterprise/tokens/{identifier}", dependencies=[Depends(auth.require_scope("admin"))])
async def revoke_token(identifier: str, permanent: bool = False):
    """
    Revoke or delete a token (enterprise only).

    Args:
        identifier: Token ID or name
        permanent: If true, permanently delete instead of revoke
    """
    if not auth.is_enterprise_mode():
        raise HTTPException(
            status_code=403,
            detail="Enterprise authentication not enabled"
        )

    if permanent:
        success = auth.delete_token(identifier)
        action = "delete"
    else:
        success = auth.revoke_token(identifier)
        action = "revoke"

    if not success:
        raise HTTPException(status_code=404, detail="Token not found")

    # Audit log
    audit.log_event(
        action=action,
        resource_type="token",
        resource_id=identifier,
    )

    return {"status": "ok", "action": action, "identifier": identifier}


# Audit log endpoints (enabled by default, disable with LOKI_AUDIT_DISABLED=true)
class AuditQueryParams(BaseModel):
    """Query parameters for audit logs."""
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    action: Optional[str] = None
    resource_type: Optional[str] = None
    resource_id: Optional[str] = None
    user_id: Optional[str] = None
    success: Optional[bool] = None
    limit: int = 100
    offset: int = 0


@app.get("/api/enterprise/audit", dependencies=[Depends(auth.require_scope("audit"))])
async def query_audit_logs(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    action: Optional[str] = None,
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    limit: int = Query(default=100, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    """
    Query audit logs (enterprise only).

    Date format: YYYY-MM-DD
    """
    if not audit.is_audit_enabled():
        raise HTTPException(
            status_code=403,
            detail="Audit logging is disabled. Remove LOKI_AUDIT_DISABLED or set LOKI_ENTERPRISE_AUDIT=true"
        )

    return audit.query_logs(
        start_date=start_date,
        end_date=end_date,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        limit=limit,
        offset=offset,
    )


@app.get("/api/enterprise/audit/summary", dependencies=[Depends(auth.require_scope("audit"))])
async def get_audit_summary(days: int = 7):
    """Get audit activity summary."""
    if not audit.is_audit_enabled():
        raise HTTPException(
            status_code=403,
            detail="Audit logging is disabled. Remove LOKI_AUDIT_DISABLED or set LOKI_ENTERPRISE_AUDIT=true"
        )

    return audit.get_audit_summary(days=days)


# Continuous compliance surface (P3-11).
#
# Exposes the agent audit chain's compliance posture as an always-available
# live endpoint. There is NO background scheduler in this surface (that is
# infra, out of scope): the report is regenerated from the CURRENT audit
# state on every request, so the endpoint is "continuous" in the sense that
# it always reflects live state -- never a stale cached snapshot.
#
# The report is produced by the authoritative Node compliance engine
# (src/audit/index.js, the single source of truth for SOC2/ISO/GDPR control
# mappings) via its `report` CLI shim, so the Python surface never
# reimplements (and never drifts from) the mapping logic. The chain it reads
# is the JS AGENT chain at <project>/.loki/audit/audit.jsonl -- a different
# chain from the Python dashboard chain that /api/enterprise/audit serves
# (the two are reconciled by the cross-link verifier, not merged), so this
# endpoint deliberately does NOT gate on audit.is_audit_enabled() (that flag
# governs the Python chain). When the agent chain has no entries the report
# is returned honestly with totalAuditEntries == 0; no fabricated pass.
_COMPLIANCE_TYPES = ("soc2", "iso27001", "gdpr")


@app.get("/api/compliance", dependencies=[Depends(auth.require_scope("audit"))])
def get_compliance_status(request: Request, report_type: str = Query("soc2", alias="type")):
    """Live compliance status for the active project's agent audit chain.

    Auth/tenant scoping: requires the `audit` scope (same gate as the
    /api/enterprise/audit family). The data is filesystem state scoped to
    the active project via _get_loki_dir(), exactly like the other
    .loki-backed read endpoints; there is no DB tenant_id on a JSONL file
    to enforce against.

    Query: ?type=soc2|iso27001|gdpr (default soc2).

    Returns the compliance report JSON regenerated from CURRENT audit
    state on every call. If no audit data has been recorded the report is
    honestly empty (totalAuditEntries == 0), not a fabricated compliant
    verdict. If the Node engine is unavailable, returns an honest
    available:false payload (HTTP 200) rather than masquerading as "no
    compliance".
    """
    if not _read_limiter.check(_rate_key("compliance", request)):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    if report_type not in _COMPLIANCE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid type: {report_type}. Must be one of {list(_COMPLIANCE_TYPES)}",
        )

    import shutil

    # The agent audit chain lives under <project>/.loki/audit; _get_loki_dir()
    # returns the .loki dir, so the project root is its parent.
    project_dir = str(_get_loki_dir().parent.resolve())
    repo_root = _Path(__file__).resolve().parent.parent
    index_js = repo_root / "src" / "audit" / "index.js"

    node_bin = shutil.which("node")
    if node_bin is None or not index_js.exists():
        return {
            "available": False,
            "reason": (
                "Node runtime not found"
                if node_bin is None
                else f"compliance engine not found at {index_js}"
            ),
            "reportType": report_type,
            "projectDir": project_dir,
            "report": None,
        }

    try:
        proc = subprocess.run(
            [node_bin, str(index_js), "report", report_type, project_dir],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return {
            "available": False,
            "reason": f"compliance engine invocation failed: {exc}",
            "reportType": report_type,
            "projectDir": project_dir,
            "report": None,
        }

    if proc.returncode != 0:
        return {
            "available": False,
            "reason": (proc.stderr or "compliance engine returned non-zero").strip()[:500],
            "reportType": report_type,
            "projectDir": project_dir,
            "report": None,
        }

    try:
        report = json.loads(proc.stdout.strip())
    except json.JSONDecodeError:
        return {
            "available": False,
            "reason": "compliance engine produced non-JSON output",
            "reportType": report_type,
            "projectDir": project_dir,
            "report": None,
        }

    return {
        "available": True,
        "reportType": report_type,
        "projectDir": project_dir,
        "report": report,
    }


# =============================================================================
# File-based Session Endpoints (reads from .loki/ flat files)
# =============================================================================

# Active project directory override (set via API or run.sh notification)
# When set, _get_loki_dir() resolves .loki/ relative to this path instead of CWD.
_active_project_dir: Optional[str] = None

# M4 (v7.90.1): was this dashboard auto-started by a run (`loki start` ->
# run.sh start_dashboard), or started deliberately by the user
# (`loki dashboard start`)? Captured ONCE at import from the environment marker
# that ONLY the auto-start path sets. Used to decide whether the dashboard may
# shut ITSELF down after its Stop button stops the last active run: an
# auto-started dashboard self-exits (it came up with the run, so it should go
# down with the last run), while a user-started dashboard is left up and only
# surfaces a non-destructive notice. Frozen at startup so a later child process
# inheriting/clearing the var cannot flip the decision.
_DASHBOARD_AUTOSTARTED: bool = os.environ.get("LOKI_DASHBOARD_AUTOSTARTED") == "1"


def _get_loki_dir() -> _Path:
    """Get LOKI_DIR, refreshing from env on each call for consistency.

    Resolution order:
    1. _active_project_dir (set via /api/focus API for cross-directory projects)
       -- takes priority because it is a runtime signal pointing to the actual
       active project, whereas LOKI_DIR is a stale startup-time value (typically
       the relative string ".loki" inherited from the CLI).
    2. LOKI_DIR env var (only when it is an absolute path, to avoid resolving
       a relative path against the dashboard's CWD which is usually wrong)
    3. .loki/ in current working directory
    4. ~/.loki/ as global fallback
    """
    # Check API-set project directory first (runtime override from /api/focus
    # or from Purple Lab / AI Chat starting a session in a different directory)
    if _active_project_dir:
        project_loki = _Path(_active_project_dir) / ".loki"
        if project_loki.is_dir():
            return project_loki

    env_dir = os.environ.get("LOKI_DIR")
    if env_dir and _Path(env_dir).is_absolute():
        return _Path(env_dir)

    # Check CWD first
    cwd_loki = _Path.cwd() / ".loki"
    if cwd_loki.is_dir():
        return cwd_loki

    # Check home directory fallback
    home_loki = _Path.home() / ".loki"
    if home_loki.is_dir():
        return home_loki

    # Default: relative .loki/ (will be created when session starts)
    return _Path(".loki")


def _find_orchestrator_pids_for_dir(project_dir: _Path) -> list[int]:
    """Find live Loki orchestrator PIDs whose working directory IS project_dir.

    v7.7.33: the dashboard Stop button used to signal only loki.pid. When that
    pid file was stale (e.g. a crashed/restarted session left an orphaned
    `bash /tmp/loki-run-XXXXXX.sh` reparented to init under a NEW pid), Stop
    killed nothing live yet reported "stopped". The orchestrator temp-script
    name carries no project identity, so we map orchestrator -> project by the
    process CWD, which is reliably the project directory.

    Strictly scoped: returns ONLY pids whose cwd resolves to project_dir, so a
    stop on one project never reaps another folder's runner. Best-effort: on any
    enumeration failure returns an empty list (callers still signal loki.pid).
    """
    pids: list[int] = []
    try:
        target = os.path.realpath(str(project_dir))
    except OSError:
        return pids

    # Enumerate candidate orchestrator processes (the loki-run-*.sh temp script).
    # Anchor the pattern to the real temp-dir path prefix (mktemp writes the
    # runner to $TMPDIR or /tmp), so an unrelated process that merely mentions a
    # "loki-run-*.sh" string in its argv is far less likely to match. The cwd
    # equality check below is the authoritative scope guard regardless.
    # pgrep enumeration can transiently miss a live process (kernel proc-list
    # timing under load), which would let a still-running orphan slip past the
    # post-kill survivor check and yield a false "stopped". Union a few quick
    # passes to make the enumeration resilient. The cwd filter below still
    # guarantees scope correctness for whatever is enumerated.
    import time as _time
    # Two candidate patterns, BOTH cwd-filtered below (cwd is the authoritative
    # scope guard):
    #   1. /loki-run-*.sh  -- the orchestrator temp script.
    #   2. [LOKI-AUTONOMY-AGENT]  -- the sentinel Loki injects as the first line
    #      of the agent's --append-system-prompt (v7.7.34). This matches the
    #      claude/codex/aider AGENT process, which has no "loki-run" in its argv
    #      and (critically) survives as an orphan (PPID 1) when the orchestrator
    #      is killed -- the cause of "dashboard says stopped but it keeps
    #      running". An interactive provider session never carries this sentinel,
    #      so it is never matched.
    _patterns = [r"/loki-run-[^/ ]*\.sh", r"\[LOKI-AUTONOMY-AGENT\]"]
    candidate_set: set[int] = set()
    enumerated = False
    for _attempt in range(3):
        for _pat in _patterns:
            try:
                out = subprocess.run(
                    ["pgrep", "-f", _pat],
                    capture_output=True, text=True, timeout=5,
                )
                enumerated = True
                for line in out.stdout.split():
                    try:
                        candidate_set.add(int(line))
                    except ValueError:
                        pass
            except (OSError, subprocess.SubprocessError):
                pass
        if _attempt < 2:
            _time.sleep(0.15)
    if not enumerated:
        return pids
    candidates = list(candidate_set)

    for pid in candidates:
        if _pid_is_gone(pid):
            continue  # skip zombies / already-reaped
        cwd = _pid_cwd(pid)
        if cwd and os.path.realpath(cwd) == target:
            pids.append(pid)
    return pids


def _pid_cwd(pid: int) -> Optional[str]:
    """Return a process's current working directory, or None.

    Linux: read /proc/<pid>/cwd. macOS/BSD: fall back to `lsof -a -p <pid> -d cwd`.
    Best-effort and exception-safe; never raises.
    """
    # Linux fast path
    proc_cwd = f"/proc/{pid}/cwd"
    try:
        if os.path.isdir(f"/proc/{pid}"):
            return os.readlink(proc_cwd)
    except OSError:
        pass
    # macOS / BSD: lsof
    try:
        out = subprocess.run(
            ["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
            capture_output=True, text=True, timeout=5,
        )
        for line in out.stdout.splitlines():
            if line.startswith("n"):
                return line[1:]
    except (OSError, subprocess.SubprocessError):
        pass
    return None


def _read_pgid(loki_dir: _Path) -> Optional[int]:
    """Read the orchestrator process-group id recorded at .loki/loki.pgid (or the
    per-session variant). Returns a valid pgid (>1) or None. Never raises."""
    for name in ("loki.pgid", "run.pgid"):
        f = loki_dir / name
        try:
            if f.exists():
                v = int(f.read_text().strip())
                if v > 1:
                    return v
        except (ValueError, OSError):
            pass
    # per-session pgid files
    try:
        sess_dir = loki_dir / "sessions"
        if sess_dir.is_dir():
            for sd in sess_dir.iterdir():
                pf = sd / "loki.pgid"
                if pf.exists():
                    v = int(pf.read_text().strip())
                    if v > 1:
                        return v
    except (ValueError, OSError):
        pass
    return None


def _collect_protected_pids(loki_dir: _Path) -> set:
    """Pids that must NOT be killed by a group stop: the dashboard, app-runner,
    and anything registered under .loki/pids/ (filename is the pid). Plus this
    server process. Best-effort; never raises."""
    protected = {os.getpid()}
    try:
        protected.add(os.getppid())
    except OSError:
        pass
    try:
        pids_dir = loki_dir / "pids"
        if pids_dir.is_dir():
            for f in pids_dir.glob("*.json"):
                try:
                    protected.add(int(f.stem))
                except ValueError:
                    pass
    except OSError:
        pass
    # the standalone dashboard pid file
    for cand in (loki_dir / "dashboard" / "dashboard.pid",
                 _Path.home() / ".loki" / "dashboard" / "dashboard.pid"):
        try:
            if cand.exists():
                protected.add(int(cand.read_text().strip()))
        except (ValueError, OSError):
            pass
    return protected


def _killpg_project(pgid: Optional[int], protected_pids: Optional[set] = None) -> bool:
    """Atomically stop a project's whole process tree by signaling its process
    GROUP: SIGTERM, wait up to 5s, then SIGKILL. This is the v7.7.34 fix for the
    orphaned-agent bug -- killing only the orchestrator pid let the agent child
    reparent to init and keep running; a group kill reaps the orchestrator, the
    agent, and every monitor at once with no orphan window.

    Guards (CRITICAL): refuse to signal an absent/0/1 pgid or this server's OWN
    process group (never commit suicide). If any protected pid (e.g. the shared
    dashboard registered in .loki/pids) shares the target pgid, fall back to
    per-pid kills of the group members EXCLUDING the protected pids, so the
    dashboard is never taken down. Best-effort; never raises. Returns True if a
    group signal (or scoped fallback) was issued."""
    import signal as _signal
    import time as _time
    if not isinstance(pgid, int) or pgid <= 1:
        return False
    try:
        if pgid == os.getpgrp():
            return False  # never kill our own group
    except OSError:
        pass
    protected = protected_pids or set()

    def _group_members(g: int) -> list:
        try:
            out = subprocess.run(["ps", "-axo", "pid=,pgid="],
                                 capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return []
        members = []
        for line in out.stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2:
                try:
                    pid_i, pgid_i = int(parts[0]), int(parts[1])
                except ValueError:
                    continue
                if pgid_i == g:
                    members.append(pid_i)
        return members

    members = _group_members(pgid)
    conflict = any(p in protected for p in members)

    if conflict:
        # A protected pid (dashboard/app-runner) shares this group. Do NOT blast
        # the whole group; signal only the non-protected members per-pid.
        targets = [p for p in members if p not in protected and p != os.getpid()]
        for sig in (_signal.SIGTERM,):
            for p in targets:
                try:
                    os.kill(p, sig)
                except OSError:
                    pass
        _time.sleep(2.0)
        for p in targets:
            try:
                os.kill(p, _signal.SIGKILL)
            except OSError:
                pass
        return True

    # Clean case: signal the whole group.
    try:
        os.killpg(pgid, _signal.SIGTERM)
    except (OSError, ProcessLookupError):
        return True  # group already gone
    for _ in range(10):
        _time.sleep(0.5)
        if not _group_members(pgid):
            return True
    try:
        os.killpg(pgid, _signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass
    return True


def _reap_orchestrators_until_clear(project_dir: _Path, expected_cwd: str,
                                    rounds: int = 6) -> tuple[bool, bool]:
    """Find and terminate orchestrators for project_dir, looping until the
    project is clear across a confirming re-scan. Returns (found_any, all_gone).

    Robust against transient pgrep enumeration misses: a single find-then-scan
    could miss a live orphan and falsely report it gone. We repeat find+kill and
    require TWO consecutive empty scans before declaring all_gone, so a one-off
    enumeration miss cannot yield a false "stopped". Runs in a worker thread (the
    caller wraps it in asyncio.to_thread) so the blocking kills do not stall the
    event loop. Strictly cwd-scoped via _find_orchestrator_pids_for_dir.
    """
    import time as _time
    found_any = False
    consecutive_empty = 0
    for _round in range(rounds):
        found = _find_orchestrator_pids_for_dir(project_dir)
        if found:
            found_any = True
            consecutive_empty = 0
            for opid in found:
                _terminate_pid(opid, expected_cwd=expected_cwd)
        else:
            consecutive_empty += 1
            if consecutive_empty >= 2:
                return (found_any, True)  # clear, confirmed twice
            _time.sleep(0.2)  # brief pause before the confirming re-scan
    # Exhausted rounds: report gone only if the final scan is empty.
    return (found_any, not _find_orchestrator_pids_for_dir(project_dir))


def _other_runs_alive(exclude_path: Optional[str] = None) -> bool:
    """True if ANY registered project OTHER than exclude_path still has a live
    orchestrator pid. Mirrors run.sh's CLEAR/KEEP check (and cmd_stop's): a
    project counts as alive only when its recorded pid is still running. The
    just-stopped project must already be marked stopped in the registry (its pid
    set to None by mark_project_stopped) before this is called, so it is not
    self-counted; exclude_path is an extra belt-and-suspenders guard by realpath.
    Best-effort: any registry/probe error degrades to True (KEEP) so we NEVER
    tear the dashboard down on uncertain information.
    """
    try:
        exclude_real = None
        if exclude_path:
            try:
                exclude_real = os.path.realpath(exclude_path)
            except OSError:
                exclude_real = os.path.abspath(exclude_path)
        for p in registry.list_projects(include_inactive=True):
            path = p.get("path", "")
            if exclude_real and path:
                try:
                    if os.path.realpath(path) == exclude_real:
                        continue
                except OSError:
                    if os.path.abspath(path) == exclude_real:
                        continue
            pid = p.get("pid")
            if isinstance(pid, int) and pid > 0 and not _pid_is_gone(pid):
                return True
        return False
    except Exception:
        # Unknown -> assume something is still running so we never wrongly kill
        # the dashboard.
        return True


def _self_shutdown_after_response(delay_s: float = 1.0) -> None:
    """Gracefully shut THIS dashboard server down shortly after the current HTTP
    response has been sent. Used only after the dashboard's own Stop button stops
    the LAST active run and only when this dashboard was auto-started (M4).

    Why a delayed background thread (not an inline exit): the Stop request is
    still in flight when this is decided. We must let FastAPI/uvicorn finish
    writing the response (so the UI gets its JSON) before the process goes away.
    A short-delay daemon thread sends SIGTERM to our OWN pid, which uvicorn
    handles as a graceful shutdown (runs the lifespan teardown). This sidesteps
    the fragile path where the dashboard relied on the orchestrator's cleanup
    trap to kill it -- a path that a SIGKILL of the orchestrator (after the 5s
    window) or a uvicorn graceful-shutdown deadlock could bypass, leaving the
    dashboard lingering (the reported M4 bug). Best-effort; never raises into
    the request.
    """
    import signal as _signal

    def _kill_self() -> None:
        try:
            time.sleep(max(0.0, delay_s))
        except Exception:
            pass
        try:
            logger.info(
                "Auto-started dashboard: last active run stopped and no other "
                "run is alive; shutting self down (pid=%s).", os.getpid())
        except Exception:
            pass
        try:
            os.kill(os.getpid(), _signal.SIGTERM)
        except OSError:
            # Last resort: hard-exit this process only (never touches others).
            os._exit(0)

    try:
        threading.Thread(target=_kill_self, name="loki-dash-selfstop",
                         daemon=True).start()
    except Exception:
        # If we cannot even spawn the thread, do nothing: a lingering dashboard
        # is strictly safer than any broader action.
        pass


def _dashboard_teardown_after_project_stop(stopped_path: Optional[str]) -> dict:
    """Decide what happens to THIS dashboard after a per-project Stop, and return
    fields to merge into the Stop response (M4).

    Rules (conservative; never touches any process but this server's own):
      - If another registered run is still alive -> KEEP: do nothing, the
        dashboard stays up because other projects still need it.
      - If no other run is alive (CLEAR) and this dashboard was AUTO-STARTED by a
        run -> schedule a graceful self-shutdown after the response is sent. It
        came up with a run, so it goes down with the last run.
      - If CLEAR but the dashboard was started DELIBERATELY by the user
        (`loki dashboard start`) -> do NOT self-kill; return a non-destructive
        notice so the UI can tell the user how to stop it (loki dashboard stop).

    Returns one of:
      {"dashboard": "kept"}                              # other runs alive
      {"dashboard": "stopping", ...}                     # auto-started + CLEAR
      {"dashboard": "idle", "notice": "...", ...}        # user-started + CLEAR
    """
    try:
        if _other_runs_alive(exclude_path=stopped_path):
            return {"dashboard": "kept"}
        if _DASHBOARD_AUTOSTARTED:
            _self_shutdown_after_response()
            return {
                "dashboard": "stopping",
                "dashboard_autostarted": True,
            }
        return {
            "dashboard": "idle",
            "dashboard_autostarted": False,
            "notice": ("No active runs. This dashboard was started manually; "
                       "stop it with: loki dashboard stop"),
        }
    except Exception:
        # Any failure in the decision must never break the Stop response, and
        # must never kill the dashboard on uncertain info.
        return {"dashboard": "kept"}


def _pid_is_gone(pid: int) -> bool:
    """True if pid no longer exists OR is a zombie/defunct (effectively dead,
    just not yet reaped by its parent). os.kill(pid,0) succeeds on a zombie, so
    we additionally consult `ps` for the process state. Never raises."""
    try:
        os.kill(pid, 0)
    except OSError:
        return True  # no such process
    # alive per signal-0; check for zombie state (Z / defunct). Note: os.kill
    # above proved the pid exists, so EMPTY ps output is a transient race, NOT a
    # reap -- do not treat it as gone (that would falsely report a live
    # orchestrator stopped). Only an explicit Z/zombie state counts as gone.
    try:
        out = subprocess.run(["ps", "-o", "state=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=5)
        st = out.stdout.strip()
        if st.startswith("Z"):
            return True  # zombie / defunct -- effectively dead
    except (OSError, subprocess.SubprocessError):
        pass
    return False


def _terminate_pid(pid: int, timeout_s: float = 5.0,
                   expected_cwd: Optional[str] = None) -> bool:
    """SIGTERM a pid, wait up to timeout_s, then SIGKILL. Return True if it is
    gone afterward. Reaps direct children first (pkill -P) so the provider/app
    child does not outlive the orchestrator. A zombie counts as gone.
    Best-effort, never raises.

    If expected_cwd is given, re-verify the pid's cwd still matches it right
    before signaling (TOCTOU guard against pid reuse between enumeration and
    kill). If it no longer matches, do nothing and report the pid gone."""
    import time as _time
    if expected_cwd is not None:
        cwd = _pid_cwd(pid)
        # Only skip the kill when the cwd POSITIVELY differs (true pid reuse).
        # A failed/transient cwd lookup (cwd is None) must NOT cancel the kill:
        # the pid came from a cwd-matched enumeration moments ago, and treating a
        # transient lookup miss as "recycled" would skip killing a live
        # orchestrator and falsely report it stopped.
        if cwd:
            try:
                if os.path.realpath(cwd) != os.path.realpath(expected_cwd):
                    return True  # pid recycled to a different cwd -- do not kill
            except OSError:
                pass  # fall through and kill the originally-matched pid
    try:
        # reap children first so a wedged child cannot keep the tree alive
        subprocess.run(["pkill", "-TERM", "-P", str(pid)],
                       capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        os.kill(pid, 15)
    except (ProcessLookupError, OSError):
        return True  # already gone
    deadline = timeout_s
    while deadline > 0:
        _time.sleep(0.5)
        deadline -= 0.5
        if _pid_is_gone(pid):
            return True
    # still alive -> SIGKILL the tree
    try:
        subprocess.run(["pkill", "-9", "-P", str(pid)],
                       capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        os.kill(pid, 9)
    except (ProcessLookupError, OSError):
        return True
    _time.sleep(0.3)
    return _pid_is_gone(pid)


_SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_-]+$')


def _sanitize_agent_id(agent_id: str) -> str:
    """Validate agent_id contains only safe characters for file paths."""
    if not agent_id or len(agent_id) > 128 or ".." in agent_id or not _SAFE_ID_RE.match(agent_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid agent_id: must be 1-128 chars of alphanumeric, hyphens, and underscores",
        )
    return agent_id

@app.get("/api/memory/summary", dependencies=[Depends(auth.require_scope("read"))])
async def get_memory_summary():
    """Get memory system summary from .loki/memory/."""
    # Try SQLite backend first for accurate counts.
    # NOTE: _get_memory_storage() returns a SQLiteMemoryStorage object whenever the
    # module imports, even if no .db file exists yet. On a JSON-backed project that
    # yields all-zero stats, so we must NOT return here on empty counts -- otherwise
    # the JSON file fallback below never runs and the dashboard shows 0 episodes/
    # patterns/skills even though they exist on disk. Only trust SQLite when it
    # actually reports data; otherwise fall through to the JSON counts.
    storage = _get_memory_storage()
    if storage is not None:
        try:
            stats = storage.get_stats()
            total = (
                stats.get("episode_count", 0)
                + stats.get("pattern_count", 0)
                + stats.get("skill_count", 0)
            )
            if total > 0:
                summary = {
                    "episodic": {"count": stats.get("episode_count", 0), "latestDate": None},
                    "semantic": {"patterns": stats.get("pattern_count", 0), "antiPatterns": 0},
                    "procedural": {"skills": stats.get("skill_count", 0)},
                    "backend": "sqlite",
                }
                # Get latest episode date
                episode_ids = storage.list_episodes(limit=1)
                if episode_ids:
                    ep = storage.load_episode(episode_ids[0])
                    if ep:
                        summary["episodic"]["latestDate"] = ep.get("timestamp", "")
                # Token economics from JSON (not in SQLite)
                econ_file = _get_loki_dir() / "memory" / "token_economics.json"
                if econ_file.exists():
                    try:
                        econ = json.loads(econ_file.read_text())
                        summary["tokenEconomics"] = {
                            "discoveryTokens": econ.get("discoveryTokens", 0),
                            "readTokens": econ.get("readTokens", 0),
                            "savingsPercent": econ.get("savingsPercent", 0),
                        }
                    except Exception:
                        summary["tokenEconomics"] = {"discoveryTokens": 0, "readTokens": 0, "savingsPercent": 0}
                else:
                    summary["tokenEconomics"] = {"discoveryTokens": 0, "readTokens": 0, "savingsPercent": 0}
                return summary
        except Exception:
            pass

    # Fallback to JSON file-based counts
    memory_dir = _get_loki_dir() / "memory"
    summary = {
        "episodic": {"count": 0, "latestDate": None},
        "semantic": {"patterns": 0, "antiPatterns": 0},
        "procedural": {"skills": 0},
        "tokenEconomics": {"discoveryTokens": 0, "readTokens": 0, "savingsPercent": 0},
        "backend": "json",
    }

    ep_dir = memory_dir / "episodic"
    if ep_dir.exists():
        # Episodes are stored under dated subdirectories (episodic/YYYY-MM-DD/*.json),
        # so a flat glob("*.json") finds nothing. Recurse, and ignore .lock files.
        episodes = sorted(
            p for p in ep_dir.rglob("*.json") if not p.name.endswith(".lock")
        )
        summary["episodic"]["count"] = len(episodes)
        if episodes:
            try:
                latest = json.loads(episodes[-1].read_text())
                summary["episodic"]["latestDate"] = latest.get("timestamp", "")
            except Exception:
                pass

    sem_dir = memory_dir / "semantic"
    patterns_file = sem_dir / "patterns.json"
    anti_file = sem_dir / "anti-patterns.json"
    if patterns_file.exists():
        try:
            p = json.loads(patterns_file.read_text())
            summary["semantic"]["patterns"] = len(p) if isinstance(p, list) else len(p.get("patterns", []))
        except Exception:
            pass
    if anti_file.exists():
        try:
            a = json.loads(anti_file.read_text())
            summary["semantic"]["antiPatterns"] = len(a) if isinstance(a, list) else len(a.get("patterns", []))
        except Exception:
            pass

    skills_dir = memory_dir / "skills"
    if skills_dir.exists():
        summary["procedural"]["skills"] = len(
            [p for p in skills_dir.rglob("*.json") if not p.name.endswith(".lock")]
        )

    econ_file = memory_dir / "token_economics.json"
    if econ_file.exists():
        try:
            econ = json.loads(econ_file.read_text())
            summary["tokenEconomics"] = {
                "discoveryTokens": econ.get("discoveryTokens", 0),
                "readTokens": econ.get("readTokens", 0),
                "savingsPercent": econ.get("savingsPercent", 0),
            }
        except Exception:
            pass

    return summary


@app.get("/api/memory/episodes", dependencies=[Depends(auth.require_scope("read"))])
async def list_episodes(limit: int = Query(default=50, ge=1, le=1000)):
    """List episodic memory entries."""
    # Both backends below are blocking (SQLite queries / a glob+read loop over
    # many JSON files) and only build a local list, so offload the whole read
    # off the event loop to keep status + WS heartbeat responsive.
    def _load_episodes() -> list:
        # Try SQLite backend first
        storage = _get_memory_storage()
        if storage is not None:
            try:
                ids = storage.list_episodes(limit=limit)
                episodes = []
                for eid in ids:
                    ep = storage.load_episode(eid)
                    if ep:
                        episodes.append(ep)
                return episodes
            except Exception:
                pass

        # Fallback to JSON files -- use heapq to avoid sorting all files
        import heapq
        ep_dir = _get_loki_dir() / "memory" / "episodic"
        episodes = []
        if ep_dir.exists():
            all_files = ep_dir.glob("*.json")
            # nlargest by filename (timestamps sort lexicographically) avoids full sort
            files = heapq.nlargest(limit, all_files, key=lambda f: f.name)
            for f in files:
                try:
                    episodes.append(json.loads(f.read_text()))
                except Exception:
                    pass
        return episodes

    return await asyncio.to_thread(_load_episodes)


@app.get("/api/memory/episodes/{episode_id}", dependencies=[Depends(auth.require_scope("read"))])
async def get_episode(episode_id: str):
    """Get a specific episodic memory entry."""
    # Try SQLite first
    storage = _get_memory_storage()
    if storage is not None:
        try:
            ep = storage.load_episode(episode_id)
            if ep:
                return ep
        except Exception:
            pass

    # Fallback to JSON files
    loki_dir = _get_loki_dir()
    ep_dir = loki_dir / "memory" / "episodic"
    if not ep_dir.exists():
        raise HTTPException(status_code=404, detail="Episode not found")
    real_loki = os.path.realpath(str(loki_dir))
    for f in ep_dir.glob("*.json"):
        resolved = os.path.realpath(f)
        if not resolved.startswith(real_loki + os.sep) and resolved != real_loki:
            raise HTTPException(status_code=403, detail="Access denied")
        try:
            data = json.loads(f.read_text())
            if data.get("id") == episode_id or f.stem == episode_id:
                return data
        except Exception:
            pass
    raise HTTPException(status_code=404, detail="Episode not found")


@app.get("/api/memory/patterns", dependencies=[Depends(auth.require_scope("read"))])
async def list_patterns():
    """List semantic patterns."""
    # Try SQLite first
    storage = _get_memory_storage()
    if storage is not None:
        try:
            ids = storage.list_patterns()
            patterns = []
            for pid in ids:
                p = storage.load_pattern(pid)
                if p:
                    patterns.append(p)
            return patterns
        except Exception:
            pass

    # Fallback to JSON
    sem_dir = _get_loki_dir() / "memory" / "semantic"
    patterns_file = sem_dir / "patterns.json"
    if patterns_file.exists():
        try:
            data = json.loads(patterns_file.read_text())
            return data if isinstance(data, list) else data.get("patterns", [])
        except Exception:
            pass
    return []


@app.get("/api/memory/patterns/{pattern_id}", dependencies=[Depends(auth.require_scope("read"))])
async def get_pattern(pattern_id: str):
    """Get a specific semantic pattern."""
    patterns = await list_patterns()
    for p in patterns:
        if p.get("id") == pattern_id:
            return p
    raise HTTPException(status_code=404, detail="Pattern not found")


@app.get("/api/memory/skills", dependencies=[Depends(auth.require_scope("read"))])
async def list_skills():
    """List procedural skills."""
    # Blocking SQLite query / glob+read loop; offload the whole read so the
    # event loop (status + WS heartbeat) stays responsive.
    def _load_skills() -> list:
        # Try SQLite first
        storage = _get_memory_storage()
        if storage is not None:
            try:
                ids = storage.list_skills()
                skills = []
                for sid in ids:
                    s = storage.load_skill(sid)
                    if s:
                        skills.append(s)
                return skills
            except Exception:
                pass

        # Fallback to JSON
        skills_dir = _get_loki_dir() / "memory" / "skills"
        skills = []
        if skills_dir.exists():
            for f in sorted(skills_dir.glob("*.json")):
                try:
                    skills.append(json.loads(f.read_text()))
                except Exception:
                    pass
        return skills

    return await asyncio.to_thread(_load_skills)


@app.get("/api/memory/skills/{skill_id}", dependencies=[Depends(auth.require_scope("read"))])
async def get_skill(skill_id: str):
    """Get a specific procedural skill."""
    loki_dir = _get_loki_dir()
    skills_dir = loki_dir / "memory" / "skills"
    if not skills_dir.exists():
        raise HTTPException(status_code=404, detail="Skill not found")
    real_loki = os.path.realpath(str(loki_dir))
    for f in skills_dir.glob("*.json"):
        resolved = os.path.realpath(f)
        if not resolved.startswith(real_loki + os.sep) and resolved != real_loki:
            raise HTTPException(status_code=403, detail="Access denied")
        try:
            data = json.loads(f.read_text())
            if data.get("id") == skill_id or f.stem == skill_id:
                return data
        except Exception:
            pass
    raise HTTPException(status_code=404, detail="Skill not found")


@app.get("/api/memory/economics", dependencies=[Depends(auth.require_scope("read"))])
async def get_token_economics():
    """Get token usage economics (v7.7.21: normalized + hit_rate + top_patterns).

    Excellence bar 5: per-retrieval cost + hit rate + top patterns visible.
    Reads token_economics.json (written by memory.token_economics.save())
    which has shape {session_id, metrics:{discovery_tokens, read_tokens,
    cache_hits, cache_misses, ...}, ratio, savings_percent}. Computes a
    cache hit_rate + surfaces the most-accessed episodes/patterns. The
    pre-v7.7.21 endpoint returned camelCase keys that did not match the
    snake_case file; the `raw` field preserves the original document for
    backward compat while the top-level fields are normalized.
    """
    loki_dir = _get_loki_dir()
    econ_file = loki_dir / "memory" / "token_economics.json"
    raw = {}
    if econ_file.exists():
        try:
            raw = json.loads(econ_file.read_text())
        except Exception:
            raw = {}

    metrics = raw.get("metrics", {}) if isinstance(raw, dict) else {}
    cache_hits = int(metrics.get("cache_hits", 0) or 0)
    cache_misses = int(metrics.get("cache_misses", 0) or 0)
    cache_total = cache_hits + cache_misses
    hit_rate = round(cache_hits / cache_total, 4) if cache_total > 0 else 0.0
    discovery_tokens = int(metrics.get("discovery_tokens", 0) or 0)
    read_tokens = int(metrics.get("read_tokens", 0) or 0)

    # Top-accessed memories: scan episodic + semantic, rank by access_count
    # then importance.
    # v7.7.21 council fix (Opus 1 + Opus 2):
    #   - os.walk(followlinks=False) instead of recursive glob: does NOT
    #     descend symlinked dirs (prevents traversal/exfil + DoS-amplify
    #     via a symlink to a huge tree).
    #   - realpath containment: every candidate file must resolve to a
    #     path under mem_root (mirrors the sibling get_skill endpoint).
    #   - hard cap on files SCANNED (not just surfaced): stop after
    #     MAX_SCAN files per subdir so a large store cannot make this
    #     request unboundedly slow even with the 30s auto-refresh.
    top_patterns = []
    try:
        import os as _os
        mem_root = (loki_dir / "memory").resolve()
        MAX_SCAN = 300
        candidates = []
        for sub in ("episodic", "semantic"):
            sub_root = mem_root / sub
            if not sub_root.is_dir():
                continue
            scanned = 0
            stop = False
            for dirpath, dirnames, filenames in _os.walk(str(sub_root), followlinks=False):
                if stop:
                    break
                for fn in filenames:
                    if not fn.endswith(".json"):
                        continue
                    fp = _os.path.join(dirpath, fn)
                    # Containment: resolved path must stay under mem_root.
                    try:
                        rp = _os.path.realpath(fp)
                        if _os.path.commonpath([rp, str(mem_root)]) != str(mem_root):
                            continue
                    except (OSError, ValueError):
                        continue
                    try:
                        with open(fp) as fh:
                            d = json.load(fh)
                        candidates.append({
                            "id": d.get("id", ""),
                            "kind": sub,
                            "access_count": int(d.get("access_count", 0) or 0),
                            "importance": float(d.get("importance", 0.0) or 0.0),
                            "summary": str(
                                d.get("summary")
                                or d.get("pattern")
                                or d.get("context", {}).get("goal", "")
                            )[:160],
                        })
                    except Exception:
                        continue
                    scanned += 1
                    if scanned >= MAX_SCAN:
                        stop = True
                        break
        candidates.sort(key=lambda c: (c["access_count"], c["importance"]), reverse=True)
        top_patterns = candidates[:10]
    except Exception:
        top_patterns = []

    return {
        "session_id": raw.get("session_id"),
        "discovery_tokens": discovery_tokens,
        "read_tokens": read_tokens,
        "total_tokens": discovery_tokens + read_tokens,
        "cache_hits": cache_hits,
        "cache_misses": cache_misses,
        "hit_rate": hit_rate,
        "ratio": raw.get("ratio", 0.0),
        "savings_percent": raw.get("savings_percent", 0.0),
        "top_patterns": top_patterns,
        # Backward-compat aliases (pre-v7.7.21 camelCase consumers)
        "discoveryTokens": discovery_tokens,
        "readTokens": read_tokens,
        "savingsPercent": raw.get("savings_percent", 0.0),
        "raw": raw,
    }


@app.post("/api/memory/consolidate", dependencies=[Depends(auth.require_scope("control"))])
async def consolidate_memory(hours: int = 24):
    """Run the real episodic-to-semantic consolidation pipeline."""
    memory_dir = _get_loki_dir() / "memory"
    try:
        import sys as _sys
        project_root = str(_Path(__file__).resolve().parent.parent)
        if project_root not in _sys.path:
            _sys.path.insert(0, project_root)
        from memory.storage import MemoryStorage
        from memory.consolidation import ConsolidationPipeline
        storage = MemoryStorage(str(memory_dir))
        pipeline = ConsolidationPipeline(storage=storage, base_path=str(memory_dir))
        result = pipeline.consolidate(since_hours=hours)
        d = result.to_dict()
        return {
            "status": "ok",
            "message": f"Consolidated episodes from the last {hours}h",
            "consolidated": d.get("patterns_created", 0) + d.get("patterns_merged", 0),
            "patternsCreated": d.get("patterns_created", 0),
            "patternsMerged": d.get("patterns_merged", 0),
            "antiPatternsCreated": d.get("anti_patterns_created", 0),
            "episodesProcessed": d.get("episodes_processed", 0),
            "durationSeconds": round(d.get("duration_seconds", 0.0), 3),
        }
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Consolidation unavailable: {e}")


@app.post("/api/memory/retrieve", dependencies=[Depends(auth.require_scope("control"))])
async def retrieve_memory(query: dict = None):
    """Task-aware retrieval against the real memory engine.

    Body: {"goal": str, "phase"?: str, "task_type"?: str, "top_k"?: int}.
    """
    query = query or {}
    goal = (query.get("goal") or query.get("q") or "").strip()
    if not goal:
        return {"results": [], "query": query, "message": "provide a 'goal' to retrieve against"}
    top_k = int(query.get("top_k", 5))
    top_k = max(1, min(top_k, 50))
    memory_dir = _get_loki_dir() / "memory"
    try:
        import sys as _sys
        project_root = str(_Path(__file__).resolve().parent.parent)
        if project_root not in _sys.path:
            _sys.path.insert(0, project_root)
        from memory.storage import MemoryStorage
        from memory.retrieval import MemoryRetrieval
        retriever = MemoryRetrieval(MemoryStorage(str(memory_dir)))
        context = {"goal": goal, "phase": query.get("phase", "development")}
        if query.get("task_type"):
            context["task_type"] = query["task_type"]
        results = retriever.retrieve_task_aware(context, top_k=top_k, token_budget=query.get("token_budget"))
        return {"results": results, "query": {"goal": goal, "top_k": top_k}, "count": len(results)}
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Retrieval unavailable: {e}")


@app.get("/api/memory/index", dependencies=[Depends(auth.require_scope("read"))])
async def get_memory_index():
    """Get memory index (Layer 1 - lightweight discovery)."""
    index_file = _get_loki_dir() / "memory" / "index.json"
    if index_file.exists():
        try:
            return json.loads(index_file.read_text())
        except Exception:
            pass
    return {"topics": [], "lastUpdated": None}


@app.get("/api/memory/timeline", dependencies=[Depends(auth.require_scope("read"))])
async def get_memory_timeline():
    """Get memory timeline (Layer 2 - progressive disclosure)."""
    timeline_file = _get_loki_dir() / "memory" / "timeline.json"
    if timeline_file.exists():
        try:
            return json.loads(timeline_file.read_text())
        except Exception:
            pass
    # Build from episodic memories if no timeline file
    episodes = await list_episodes(limit=100)
    return {"entries": episodes, "lastUpdated": None}


# ---------------------------------------------------------------------------
# Memory File Browser (v7.6.0) - generic drill-down into .loki/memory/
# ---------------------------------------------------------------------------
# Exposes raw episodic/learnings/ledgers/handoffs files plus root-level
# notes (decisions.md, mistakes.md, patterns.md, investigation-*.md, etc.)
# so the dashboard can let users click through what the agent has stored.
#
# Safety: type is a whitelisted enum; path is validated by resolving against
# the memory directory and rejecting anything outside it (also rejects
# absolute paths and ".." segments before resolution).

_MEMORY_FILE_TYPES = {
    "episodic": "episodic",
    "learnings": "learnings",
    "ledgers": "ledgers",
    "handoffs": "handoffs",
    "semantic": "semantic",
    "skills": "skills",
    "root": "",  # files directly under .loki/memory/
}

_MEMORY_FILE_MAX_BYTES = 2 * 1024 * 1024  # 2 MiB cap per file read


def _safe_memory_path(rel_path: str) -> _Path:
    """Resolve rel_path under .loki/memory/ and reject traversal attempts.

    Raises HTTPException(400) on bad input, HTTPException(403) on traversal.
    """
    if not rel_path or not isinstance(rel_path, str):
        raise HTTPException(status_code=400, detail="path required")
    # Reject NULs and absolute paths up front
    if "\x00" in rel_path or rel_path.startswith("/") or rel_path.startswith("\\"):
        raise HTTPException(status_code=400, detail="invalid path")
    # Reject explicit traversal segments before touching the filesystem
    parts = rel_path.replace("\\", "/").split("/")
    if any(p == ".." for p in parts):
        raise HTTPException(status_code=403, detail="path traversal blocked")
    memory_dir = _get_loki_dir() / "memory"
    try:
        real_memory = os.path.realpath(str(memory_dir))
    except Exception:
        raise HTTPException(status_code=500, detail="memory dir unavailable")
    candidate = memory_dir / rel_path
    try:
        resolved = os.path.realpath(str(candidate))
    except Exception:
        raise HTTPException(status_code=400, detail="invalid path")
    # Must live strictly under real_memory (not be it, not escape via symlink)
    if not (resolved == real_memory or resolved.startswith(real_memory + os.sep)):
        raise HTTPException(status_code=403, detail="path outside memory dir")
    return _Path(resolved)


@app.get("/api/memory/files", dependencies=[Depends(auth.require_scope("read"))])
async def list_memory_files(
    type: str = Query(default="root", description="One of: episodic, learnings, ledgers, handoffs, semantic, skills, root"),
    limit: int = Query(default=500, ge=1, le=2000),
):
    """List files under a memory subdirectory.

    Returns: {type, dir, files: [{path, name, size, modified, kind}]}
    `path` is relative to .loki/memory/ and safe to pass back to /api/memory/file.
    """
    if type not in _MEMORY_FILE_TYPES:
        raise HTTPException(status_code=400, detail=f"unknown type; expected one of {sorted(_MEMORY_FILE_TYPES)}")
    sub = _MEMORY_FILE_TYPES[type]
    memory_dir = _get_loki_dir() / "memory"
    target_dir = memory_dir / sub if sub else memory_dir
    if not target_dir.exists():
        return {"type": type, "dir": str(target_dir), "files": []}

    real_memory = os.path.realpath(str(memory_dir))
    entries: list[dict[str, Any]] = []

    if type == "root":
        # Only files directly under .loki/memory/ (don't descend into subdirs)
        iterator = (p for p in target_dir.iterdir() if p.is_file())
    elif type == "episodic":
        # Episodic is organized by date subdirectory; walk one level.
        def _ep_iter():
            for child in target_dir.iterdir():
                if child.is_file():
                    yield child
                elif child.is_dir():
                    for f in child.iterdir():
                        if f.is_file():
                            yield f
        iterator = _ep_iter()
    else:
        # Flat directory listing (learnings, ledgers, handoffs, semantic, skills)
        iterator = (p for p in target_dir.rglob("*") if p.is_file())

    for f in iterator:
        try:
            resolved = os.path.realpath(str(f))
            if not resolved.startswith(real_memory + os.sep):
                continue  # skip symlinks escaping the memory dir
            rel = os.path.relpath(resolved, real_memory)
            st = f.stat()
            entries.append({
                "path": rel,
                "name": f.name,
                "size": st.st_size,
                "modified": st.st_mtime,
                "kind": f.suffix.lstrip(".").lower() or "txt",
            })
        except Exception:
            continue
        if len(entries) >= limit:
            break

    # Newest first
    entries.sort(key=lambda e: e["modified"], reverse=True)
    return {"type": type, "dir": str(target_dir), "files": entries}


@app.get("/api/memory/file", dependencies=[Depends(auth.require_scope("read"))])
async def get_memory_file(
    path: str = Query(..., min_length=1, max_length=512, description="Path relative to .loki/memory/"),
):
    """Read a single file under .loki/memory/ with strict path-traversal guards.

    Returns: {path, name, size, modified, kind, content, truncated}
    JSON files are returned with content as a string; the caller can JSON.parse.
    """
    target = _safe_memory_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="file not found")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="not a file")
    try:
        st = target.stat()
    except Exception:
        raise HTTPException(status_code=500, detail="stat failed")
    truncated = st.st_size > _MEMORY_FILE_MAX_BYTES

    def _read_memory_blob() -> bytes:
        # Up to a 2 MiB blocking read; offloaded so the single-worker event
        # loop (and /api/status + WS heartbeat) stays responsive.
        with open(target, "rb") as fh:
            return fh.read(_MEMORY_FILE_MAX_BYTES) if truncated else fh.read()

    try:
        raw = await asyncio.to_thread(_read_memory_blob)
        # Decode as UTF-8 with replacement so we never 500 on a stray byte.
        content = raw.decode("utf-8", errors="replace")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"read failed: {e}")
    return {
        "path": path,
        "name": target.name,
        "size": st.st_size,
        "modified": st.st_mtime,
        "kind": target.suffix.lstrip(".").lower() or "txt",
        "content": content,
        "truncated": truncated,
    }


# ---------------------------------------------------------------------------
# Memory Search & Stats (v6.15.0) - SQLite FTS5 powered
# ---------------------------------------------------------------------------

def _get_memory_storage():
    """Get the best available memory storage backend (SQLite preferred)."""
    memory_dir = _get_loki_dir() / "memory"
    base_path = str(memory_dir)
    try:
        import sys
        project_root = str(_Path(__file__).resolve().parent.parent)
        if project_root not in sys.path:
            sys.path.insert(0, project_root)
        from memory.sqlite_storage import SQLiteMemoryStorage
        return SQLiteMemoryStorage(base_path=base_path)
    except Exception:
        return None


@app.get("/api/memory/search", dependencies=[Depends(auth.require_scope("read"))])
async def search_memory(
    q: str = Query(..., min_length=1, max_length=500, description="Search query"),
    collection: str = Query(default="all", pattern="^(episodes|patterns|skills|all)$"),
    limit: int = Query(default=20, ge=1, le=100),
):
    """Full-text search across memory using FTS5."""
    storage = _get_memory_storage()
    if storage is None:
        return {"results": [], "message": "SQLite memory backend not available"}

    try:
        results = storage.search_fts(q, collection=collection, limit=limit)
        compact = []
        for r in results:
            entry = {
                "id": r.get("id", ""),
                "type": r.get("_type", "unknown"),
                "summary": (
                    r.get("goal", "") or
                    r.get("pattern", "") or
                    r.get("description", "") or
                    r.get("name", "")
                )[:300],
                "score": round(r.get("_score", 0), 3),
            }
            if r.get("outcome"):
                entry["outcome"] = r["outcome"]
            if r.get("category"):
                entry["category"] = r["category"]
            if r.get("timestamp"):
                entry["timestamp"] = r["timestamp"]
            compact.append(entry)
        return {"results": compact, "count": len(compact), "query": q, "collection": collection}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Search failed: {e}")


@app.get("/api/memory/stats", dependencies=[Depends(auth.require_scope("read"))])
async def get_memory_stats():
    """Get memory system statistics (counts, size, backend info)."""
    # SQLite stats query or a directory-walk over many JSON files; both block,
    # so offload off the event loop.
    def _compute_stats() -> dict:
        storage = _get_memory_storage()
        if storage is not None:
            try:
                return storage.get_stats()
            except Exception:
                pass

        # Fallback: compute stats from JSON files
        memory_dir = _get_loki_dir() / "memory"
        ep_count = 0
        ep_dir = memory_dir / "episodic"
        if ep_dir.exists():
            for d in ep_dir.iterdir():
                if d.is_dir():
                    ep_count += len(list(d.glob("*.json")))
                elif d.suffix == ".json":
                    ep_count += 1

        pat_count = 0
        patterns_file = memory_dir / "semantic" / "patterns.json"
        if patterns_file.exists():
            try:
                data = json.loads(patterns_file.read_text())
                pat_count = len(data) if isinstance(data, list) else len(data.get("patterns", []))
            except Exception:
                pass

        skill_count = 0
        skills_dir = memory_dir / "skills"
        if skills_dir.exists():
            skill_count = len(list(skills_dir.glob("*.json")))

        return {
            "backend": "json",
            "episode_count": ep_count,
            "pattern_count": pat_count,
            "skill_count": skill_count,
        }

    return await asyncio.to_thread(_compute_stats)


# Learning/metrics endpoints


def _read_learning_signals(signal_type: Optional[str] = None, limit: int = 50) -> list:
    """Read learning signals from .loki/learning/signals/*.json files.

    Learning signals are written as individual JSON files by the learning emitter
    (learning/emitter.py). Each file contains a single signal object with fields:
    id, type, source, action, timestamp, confidence, outcome, data, context.
    """
    limit = min(limit, 1000)
    signals_dir = _get_loki_dir() / "learning" / "signals"
    if not signals_dir.exists() or not signals_dir.is_dir():
        return []

    signals = []
    try:
        for fpath in signals_dir.glob("*.json"):
            try:
                raw = fpath.read_text()
                if not raw.strip():
                    continue
                sig = json.loads(raw)
                if signal_type and sig.get("type") != signal_type:
                    continue
                signals.append(sig)
            except (json.JSONDecodeError, OSError):
                continue
    except OSError:
        return []

    # Sort by timestamp descending (newest first)
    signals.sort(key=lambda s: s.get("timestamp", ""), reverse=True)
    return signals[:limit]


@app.get("/api/learning/metrics", dependencies=[Depends(auth.require_scope("read"))])
async def get_learning_metrics(
    timeRange: str = Query("7d", pattern=r"^\d{1,4}[hdm]$"),
    signalType: Optional[str] = None,
    source: Optional[str] = None,
):
    """Get learning metrics from events, metrics files, and learning signals."""
    events = await asyncio.to_thread(_read_events, timeRange)

    # Also read from learning signals directory
    all_signals = await asyncio.to_thread(_read_learning_signals, limit=10000)

    # Filter by type and source
    if signalType:
        events = [e for e in events if e.get("data", {}).get("type") == signalType]
        all_signals = [s for s in all_signals if s.get("type") == signalType]
    if source:
        events = [e for e in events if e.get("data", {}).get("source") == source]
        all_signals = [s for s in all_signals if s.get("source") == source]

    # Count by type from events.jsonl
    by_type: dict = {}
    by_source: dict = {}
    for e in events:
        t = e.get("type", "unknown")
        by_type[t] = by_type.get(t, 0) + 1
        s = e.get("data", {}).get("source", "unknown")
        by_source[s] = by_source.get(s, 0) + 1

    # Merge counts from learning signals directory
    for s in all_signals:
        t = s.get("type", "unknown")
        by_type[t] = by_type.get(t, 0) + 1
        src = s.get("source", "unknown")
        by_source[src] = by_source.get(src, 0) + 1

    total_count = len(events) + len(all_signals)

    # Calculate average confidence across both sources. Coerce values to float
    # because some legacy events/signals stored confidence as a string, which
    # made sum() raise TypeError: unsupported operand type(s) for +: 'int' and 'str'.
    # B-7 fix (v7.6.1): silently skip non-numeric confidence values.
    def _as_num(v: object) -> float:
        if isinstance(v, (int, float)):
            return float(v)
        try:
            return float(v) if v is not None else 0.0
        except (TypeError, ValueError):
            return 0.0

    total_conf = sum(_as_num(e.get("data", {}).get("confidence", 0)) for e in events)
    total_conf += sum(_as_num(s.get("confidence", 0)) for s in all_signals)

    # Load aggregation data from file if available
    aggregation = {
        "preferences": [],
        "error_patterns": [],
        "success_patterns": [],
        "tool_efficiencies": [],
    }
    agg_file = _get_loki_dir() / "metrics" / "aggregation.json"
    if agg_file.exists():
        try:
            agg_data = json.loads(agg_file.read_text())
            aggregation["preferences"] = agg_data.get("preferences", [])
            aggregation["error_patterns"] = agg_data.get("error_patterns", [])
            aggregation["success_patterns"] = agg_data.get("success_patterns", [])
            aggregation["tool_efficiencies"] = agg_data.get("tool_efficiencies", [])
        except Exception:
            pass

    return {
        "totalSignals": total_count,
        "signalsByType": by_type,
        "signalsBySource": by_source,
        "avgConfidence": round(total_conf / max(total_count, 1), 4),
        "aggregation": aggregation,
    }


@app.get("/api/learning/trends", dependencies=[Depends(auth.require_scope("read"))])
async def get_learning_trends(
    timeRange: str = Query("7d", pattern=r"^\d{1,4}[hdm]$"),
    signalType: Optional[str] = None,
    source: Optional[str] = None,
):
    """Get learning trend data."""
    events = await asyncio.to_thread(_read_events, timeRange)
    # Group by hour for trend data
    by_hour: dict = {}
    for e in events:
        ts = e.get("timestamp", "")[:13]  # YYYY-MM-DDTHH
        by_hour[ts] = by_hour.get(ts, 0) + 1

    data_points = [{"label": k, "count": v} for k, v in sorted(by_hour.items())]
    max_val = max((d["count"] for d in data_points), default=0)

    return {"dataPoints": data_points, "maxValue": max_val, "period": timeRange}


@app.get("/api/learning/signals", dependencies=[Depends(auth.require_scope("read"))])
async def get_learning_signals(
    timeRange: str = Query("7d", pattern=r"^\d{1,4}[hdm]$"),
    signalType: Optional[str] = None,
    source: Optional[str] = None,
    limit: int = Query(default=50, ge=1, le=1000),
    offset: int = Query(default=0, ge=0),
):
    """Get raw learning signals from both events.jsonl and learning signals directory."""
    events = await asyncio.to_thread(_read_events, timeRange)
    if signalType:
        events = [e for e in events if e.get("type") == signalType]
    if source:
        events = [e for e in events if e.get("data", {}).get("source") == source]

    # Also read from learning signals directory
    file_signals = await asyncio.to_thread(_read_learning_signals, signal_type=signalType, limit=10000)
    if source:
        file_signals = [s for s in file_signals if s.get("source") == source]

    # Merge and sort by timestamp (newest first)
    combined = events + file_signals
    combined.sort(key=lambda s: s.get("timestamp", ""), reverse=True)
    return combined[offset:offset + limit]


@app.get("/api/learning/aggregation", dependencies=[Depends(auth.require_scope("read"))])
async def get_learning_aggregation():
    """Get latest learning aggregation result, merging file-based aggregation with live signals."""
    result = {"preferences": [], "error_patterns": [], "success_patterns": [], "tool_efficiencies": []}

    # Load pre-computed aggregation from file if available
    agg_file = _get_loki_dir() / "metrics" / "aggregation.json"
    if agg_file.exists():
        try:
            result = json.loads(agg_file.read_text())
        except Exception:
            pass

    # Supplement with live data from learning signals directory
    success_signals = await asyncio.to_thread(_read_learning_signals, signal_type="success_pattern", limit=500)
    tool_signals = await asyncio.to_thread(_read_learning_signals, signal_type="tool_efficiency", limit=500)
    error_signals = await asyncio.to_thread(_read_learning_signals, signal_type="error_pattern", limit=500)
    pref_signals = await asyncio.to_thread(_read_learning_signals, signal_type="user_preference", limit=500)

    # Merge success patterns from signals if aggregation file had none
    if not result.get("success_patterns") and success_signals:
        pattern_counts: dict = {}
        for s in success_signals:
            name = s.get("data", {}).get("pattern_name", s.get("action", "unknown"))
            pattern_counts[name] = pattern_counts.get(name, 0) + 1
        result["success_patterns"] = [
            {"pattern_name": k, "frequency": v, "confidence": min(1.0, v / 10)}
            for k, v in sorted(pattern_counts.items(), key=lambda x: -x[1])
        ]

    # Merge tool efficiencies from signals if aggregation file had none
    if not result.get("tool_efficiencies") and tool_signals:
        tool_stats: dict = {}
        for s in tool_signals:
            data = s.get("data", {})
            tool_name = data.get("tool_name", s.get("action", "unknown"))
            if tool_name not in tool_stats:
                tool_stats[tool_name] = {"count": 0, "total_ms": 0, "successes": 0}
            tool_stats[tool_name]["count"] += 1
            tool_stats[tool_name]["total_ms"] += data.get("duration_ms", 0)
            if data.get("success", s.get("outcome") == "success"):
                tool_stats[tool_name]["successes"] += 1
        result["tool_efficiencies"] = []
        for tname, stats in sorted(tool_stats.items(), key=lambda x: -x[1]["count"]):
            avg_ms = stats["total_ms"] / stats["count"] if stats["count"] else 0
            sr = round(stats["successes"] / stats["count"], 4) if stats["count"] else 0
            result["tool_efficiencies"].append({
                "tool_name": tname, "efficiency_score": sr,
                "count": stats["count"], "avg_execution_time_ms": round(avg_ms, 2),
                "success_rate": sr,
            })

    # Merge error patterns from signals if aggregation file had none
    if not result.get("error_patterns") and error_signals:
        error_counts: dict = {}
        for s in error_signals:
            etype = s.get("data", {}).get("error_type", s.get("action", "unknown"))
            error_counts[etype] = error_counts.get(etype, 0) + 1
        result["error_patterns"] = [
            {"error_type": k, "resolution_rate": 0.0, "frequency": v, "confidence": min(1.0, v / 10)}
            for k, v in sorted(error_counts.items(), key=lambda x: -x[1])
        ]

    # Merge preferences from signals if aggregation file had none
    if not result.get("preferences") and pref_signals:
        pref_counts: dict = {}
        for s in pref_signals:
            key = s.get("data", {}).get("preference_key", s.get("action", "unknown"))
            pref_counts[key] = pref_counts.get(key, 0) + 1
        result["preferences"] = [
            {"preference_key": k, "preferred_value": k, "frequency": v, "confidence": min(1.0, v / 10)}
            for k, v in sorted(pref_counts.items(), key=lambda x: -x[1])
        ]

    # Add signal counts summary
    result["signal_counts"] = {
        "success_patterns": len(success_signals),
        "tool_efficiency": len(tool_signals),
        "error_patterns": len(error_signals),
        "user_preferences": len(pref_signals),
    }

    return result


@app.post("/api/learning/aggregate", dependencies=[Depends(auth.require_scope("control"))])
async def trigger_aggregation(request: Request):
    """Aggregate learning signals from events.jsonl into structured metrics."""
    if not _read_limiter.check(_rate_key("learning_aggregate", request)):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    # Reads up to 10 MB of events.jsonl, parses every line, then writes the
    # aggregation.json metrics file. All blocking, all on local state +
    # filesystem (no shared in-memory state), so offload the whole computation
    # to a thread to keep the event loop (status + WS heartbeat) responsive.
    return await asyncio.to_thread(_compute_learning_aggregation)


def _compute_learning_aggregation() -> dict:
    events_file = _get_loki_dir() / "events.jsonl"
    preferences: dict = {}
    error_patterns: dict = {}
    success_patterns: dict = {}
    tool_stats: dict = {}  # tool_name -> {"count": N, "total_ms": N, "successes": N}

    if events_file.exists():
        try:
            # Guard against unbounded reads: if file > 10 MB, read only the tail
            _MAX_EVENTS_BYTES = 10 * 1024 * 1024  # 10 MB
            _fsize = events_file.stat().st_size
            if _fsize > _MAX_EVENTS_BYTES:
                with open(events_file, "rb") as _fh:
                    _fh.seek(-_MAX_EVENTS_BYTES, 2)
                    _fh.readline()  # discard partial first line
                    _raw_text = _fh.read().decode("utf-8", errors="replace")
            else:
                _raw_text = events_file.read_text()
            for raw_line in _raw_text.strip().split("\n"):
                if not raw_line.strip():
                    continue
                try:
                    event = json.loads(raw_line)
                except json.JSONDecodeError:
                    continue

                if event.get("type") != "learning_signal":
                    continue

                signal_type = event.get("signal_type", "")
                data = event.get("data", {})

                if signal_type == "preference":
                    key = data.get("preference_key", "unknown")
                    preferences[key] = preferences.get(key, 0) + 1

                elif signal_type == "error":
                    etype = data.get("error_type", "unknown")
                    error_patterns[etype] = error_patterns.get(etype, 0) + 1

                elif signal_type == "success":
                    pname = data.get("pattern_name", "unknown")
                    success_patterns[pname] = success_patterns.get(pname, 0) + 1

                elif signal_type == "tool_usage":
                    tool_name = data.get("tool_name", "unknown")
                    duration = data.get("duration_ms", 0)
                    success = data.get("success", False)
                    if tool_name not in tool_stats:
                        tool_stats[tool_name] = {"count": 0, "total_ms": 0, "successes": 0}
                    tool_stats[tool_name]["count"] += 1
                    tool_stats[tool_name]["total_ms"] += duration
                    if success:
                        tool_stats[tool_name]["successes"] += 1
        except Exception:
            pass

    # Build structured result
    pref_list = [{"preference_key": k, "preferred_value": k, "frequency": v, "confidence": min(1.0, v / 10)} for k, v in sorted(preferences.items(), key=lambda x: -x[1])]
    error_list = [{"error_type": k, "resolution_rate": 0.0, "frequency": v, "confidence": min(1.0, v / 10)} for k, v in sorted(error_patterns.items(), key=lambda x: -x[1])]
    success_list = [{"pattern_name": k, "avg_duration_seconds": 0, "frequency": v, "confidence": min(1.0, v / 10)} for k, v in sorted(success_patterns.items(), key=lambda x: -x[1])]
    tool_list = []
    for tname, stats in sorted(tool_stats.items(), key=lambda x: -x[1]["count"]):
        avg_ms = stats["total_ms"] / stats["count"] if stats["count"] else 0
        sr = round(stats["successes"] / stats["count"], 4) if stats["count"] else 0
        tool_list.append({
            "tool_name": tname,
            "efficiency_score": sr,
            "count": stats["count"],
            "avg_execution_time_ms": round(avg_ms, 2),
            "success_rate": sr,
        })

    result = {
        "preferences": pref_list,
        "error_patterns": error_list,
        "success_patterns": success_list,
        "tool_efficiencies": tool_list,
        "aggregated_at": datetime.now(timezone.utc).isoformat(),
    }

    # Write to metrics directory
    metrics_dir = _get_loki_dir() / "metrics"
    metrics_dir.mkdir(parents=True, exist_ok=True)
    try:
        (metrics_dir / "aggregation.json").write_text(json.dumps(result, indent=2))
    except Exception:
        pass

    return result


@app.get("/api/learning/preferences", dependencies=[Depends(auth.require_scope("read"))])
async def get_learning_preferences(limit: int = Query(default=50, ge=1, le=1000)):
    """Get aggregated user preferences from events and learning signals directory."""
    events = await asyncio.to_thread(_read_events, "30d")
    prefs = [e for e in events if e.get("type") == "user_preference"]
    # Also read from learning signals directory
    file_prefs = await asyncio.to_thread(_read_learning_signals, signal_type="user_preference", limit=limit)
    combined = prefs + file_prefs
    combined.sort(key=lambda s: s.get("timestamp", ""), reverse=True)
    return combined[:limit]


@app.get("/api/learning/errors", dependencies=[Depends(auth.require_scope("read"))])
async def get_learning_errors(limit: int = Query(default=50, ge=1, le=1000)):
    """Get aggregated error patterns from events and learning signals directory."""
    events = await asyncio.to_thread(_read_events, "30d")
    errors = [e for e in events if e.get("type") == "error_pattern"]
    # Also read from learning signals directory
    file_errors = await asyncio.to_thread(_read_learning_signals, signal_type="error_pattern", limit=limit)
    combined = errors + file_errors
    combined.sort(key=lambda s: s.get("timestamp", ""), reverse=True)
    return combined[:limit]


@app.get("/api/learning/success", dependencies=[Depends(auth.require_scope("read"))])
async def get_learning_success(limit: int = Query(default=50, ge=1, le=1000)):
    """Get aggregated success patterns from events and learning signals directory."""
    events = await asyncio.to_thread(_read_events, "30d")
    successes = [e for e in events if e.get("type") == "success_pattern"]
    # Also read from learning signals directory
    file_successes = await asyncio.to_thread(_read_learning_signals, signal_type="success_pattern", limit=limit)
    combined = successes + file_successes
    combined.sort(key=lambda s: s.get("timestamp", ""), reverse=True)
    return combined[:limit]


@app.get("/api/learning/tools", dependencies=[Depends(auth.require_scope("read"))])
async def get_tool_efficiency(limit: int = Query(default=50, ge=1, le=1000)):
    """Get tool efficiency rankings from events and learning signals directory."""
    events = await asyncio.to_thread(_read_events, "30d")
    tools = [e for e in events if e.get("type") == "tool_efficiency"]
    # Also read from learning signals directory
    file_tools = await asyncio.to_thread(_read_learning_signals, signal_type="tool_efficiency", limit=limit)
    combined = tools + file_tools
    combined.sort(key=lambda s: s.get("timestamp", ""), reverse=True)
    return combined[:limit]


def _parse_time_range(time_range: str) -> Optional[datetime]:
    """Parse a time range string (e.g., '1h', '24h', '7d') into a cutoff datetime."""
    match = re.match(r'^(\d+)([hdm])$', time_range)
    if not match:
        return None
    value, unit = int(match.group(1)), match.group(2)
    if unit == 'h':
        delta = timedelta(hours=value)
    elif unit == 'd':
        delta = timedelta(days=value)
    elif unit == 'm':
        delta = timedelta(minutes=value)
    else:
        return None
    return datetime.now(timezone.utc) - delta


def _read_events(time_range: str = "7d", max_events: int = 10000, type_prefix: Optional[str] = None) -> list:
    """Read events from .loki/events.jsonl with time filter and size limits.

    Args:
        time_range: e.g. "7d", "24h", "30m". Events older than the cutoff are dropped.
        max_events: hard cap on the number of returned events.
        type_prefix: when set (non-empty), only return events whose ``type`` field
            starts with this prefix. Backward compatible: when None or empty,
            no type filtering is applied. Used by v7.5.22 Phase D for filtering
            ``claude_hook_*`` events without adding a new endpoint.
    """
    events_file = _get_loki_dir() / "events.jsonl"
    if not events_file.exists():
        return []

    cutoff = _parse_time_range(time_range)
    events = []
    max_file_size = 10 * 1024 * 1024  # 10MB

    try:
        file_size = events_file.stat().st_size

        # If file > 10MB, seek to last 10MB
        with open(events_file, 'r') as f:
            if file_size > max_file_size:
                f.seek(max(0, file_size - max_file_size))
                # Skip partial first line after seek
                f.readline()

            for line in f:
                if len(events) >= max_events:
                    break

                line = line.strip()
                if not line:
                    continue

                try:
                    event = json.loads(line)
                    # Filter by time_range if cutoff was parsed successfully
                    if cutoff and "timestamp" in event:
                        try:
                            ts = datetime.fromisoformat(
                                event["timestamp"].replace("Z", "+00:00")
                            )
                            if ts < cutoff:
                                continue
                        except (ValueError, TypeError):
                            pass  # Keep events with unparseable timestamps
                    # Optional type-prefix filter (v7.5.22 Phase D).
                    if type_prefix:
                        if not str(event.get("type", "")).startswith(type_prefix):
                            continue
                    events.append(event)
                except json.JSONDecodeError:
                    pass
    except Exception:
        pass
    return events


# Session control endpoints (proxy to control.py functions)
@app.post("/api/control/pause", dependencies=[Depends(auth.require_scope("control"))])
async def pause_session():
    """Pause the current session by creating PAUSE file."""
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    loki_dir = _get_loki_dir()
    pid_file = loki_dir / "loki.pid"

    # Verify loki process is running before attempting pause
    process_running = False
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            os.kill(pid, 0)  # Signal 0: check existence without killing
            process_running = True
        except (ValueError, OSError, ProcessLookupError):
            pass

    pause_file = loki_dir / "PAUSE"
    pause_file.parent.mkdir(parents=True, exist_ok=True)
    pause_file.write_text(datetime.now(timezone.utc).isoformat())

    if not process_running:
        return JSONResponse(
            status_code=503,
            content={"success": False, "message": "Session process is not running; pause signal may have no effect"},
        )

    # Verify process is still alive after writing the PAUSE file.
    # Give the process a moment to notice the signal, then confirm it
    # has not exited unexpectedly.
    await asyncio.sleep(0.5)
    try:
        os.kill(pid, 0)
        return {"success": True, "message": "Session paused", "process_verified": True}
    except OSError:
        return JSONResponse(
            status_code=503,
            content={"success": False, "message": "Session process exited unexpectedly after pause signal"},
        )


@app.post("/api/control/resume", dependencies=[Depends(auth.require_scope("control"))])
async def resume_session():
    """Resume a paused session by removing PAUSE/STOP files."""
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    loki_dir = _get_loki_dir()
    pid_file = loki_dir / "loki.pid"

    # Verify loki process is running before attempting resume
    process_running = False
    pid = 0
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            os.kill(pid, 0)  # Signal 0: check existence without killing
            process_running = True
        except (ValueError, OSError, ProcessLookupError):
            pass

    if not process_running:
        # Still remove the files for cleanup, but return 503
        for fname in ["PAUSE", "STOP"]:
            fpath = loki_dir / fname
            try:
                fpath.unlink(missing_ok=True)
            except Exception:
                pass
        return JSONResponse(
            status_code=503,
            content={"success": False, "message": "Session did not respond to resume signal"},
        )

    for fname in ["PAUSE", "STOP"]:
        fpath = loki_dir / fname
        try:
            fpath.unlink(missing_ok=True)
        except Exception:
            pass

    # Poll up to 5s to verify the process is still running and acknowledged the resume
    for _ in range(10):
        try:
            os.kill(pid, 0)
            if not (loki_dir / "PAUSE").exists():
                return {"success": True, "message": "Session resumed", "process_verified": True}
        except OSError:
            return JSONResponse(
                status_code=503,
                content={"success": False, "message": "Session did not respond to resume signal"},
            )
        await asyncio.sleep(0.5)

    return JSONResponse(
        status_code=503,
        content={"success": False, "message": "Session did not respond to resume signal"},
    )


@app.post("/api/control/stop", dependencies=[Depends(auth.require_scope("control"))])
async def stop_session(request: Request):
    """Stop the session by creating STOP file and sending SIGTERM."""
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    audit.log_event(
        action="stop",
        resource_type="session",
        details={"source": "api"},
        ip_address=request.client.host if request.client else None,
    )

    stop_file = _get_loki_dir() / "STOP"
    stop_file.parent.mkdir(parents=True, exist_ok=True)
    stop_file.write_text(datetime.now(timezone.utc).isoformat())

    # BUG-ST-004: Send SIGTERM and wait for process to actually exit
    pid_file = _get_loki_dir() / "loki.pid"
    process_stopped = False
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            os.kill(pid, 15)  # SIGTERM
            # Wait up to 5s for graceful shutdown
            for _ in range(10):
                await asyncio.sleep(0.5)
                try:
                    os.kill(pid, 0)  # Check if still alive
                except OSError:
                    process_stopped = True
                    break
            if not process_stopped:
                # Process didn't exit gracefully, send SIGKILL
                try:
                    os.kill(pid, 9)
                    process_stopped = True
                except (OSError, ProcessLookupError):
                    process_stopped = True
        except (ValueError, OSError, ProcessLookupError):
            process_stopped = True

    # v7.7.33: loki.pid alone is not authoritative. If it was stale (a crashed
    # or restarted session can leave an orphaned `loki-run-*.sh` under a new pid
    # reparented to init), the kill above is a no-op yet reports "stopped" while
    # the real orchestrator keeps running. Reap any orchestrator process whose
    # CWD is THIS project's directory. Strictly scoped by cwd, so a stop on one
    # project never touches another folder's runner.
    # v7.7.34: group-kill is the PRIMARY, atomic teardown. Signal the
    # orchestrator's whole process group so the agent child (which reparents to
    # init when only the orchestrator pid is killed) dies WITH it. Protected pids
    # (dashboard/app-runner) are spared. The cwd+sentinel reaper below is the
    # backstop for already-orphaned agents from pre-v7.7.34 sessions.
    _loki_dir_for_pg = _get_loki_dir()
    _pgid = _read_pgid(_loki_dir_for_pg)
    _protected = _collect_protected_pids(_loki_dir_for_pg)
    if _pgid is not None:
        await asyncio.to_thread(_killpg_project, _pgid, _protected)
    project_dir = _get_loki_dir().parent
    _proj = str(project_dir)
    found_any, all_gone = await asyncio.to_thread(
        _reap_orchestrators_until_clear, project_dir, _proj)
    # The orchestrator-survivor scan is authoritative over loki.pid. If any
    # orchestrator for this project was ever found, report stopped only when none
    # survive. If we found one (stale-pid case), the real outcome wins over the
    # loki.pid false positive. If the scan kept finding survivors, report not
    # stopped even if loki.pid claimed success.
    if found_any:
        process_stopped = all_gone
    elif not all_gone:
        process_stopped = False

    # Mark session.json as stopped
    session_file = _get_loki_dir() / "session.json"
    if session_file.exists():
        try:
            sd = json.loads(session_file.read_text())
            sd["status"] = "stopped"
            atomic_write_json(session_file, sd, use_lock=True)
        except Exception:
            pass

    # BUG-NEW-005: Clean up orphaned per-iteration temp files left by killed process
    logs_dir = _get_loki_dir() / "logs"
    if logs_dir.exists():
        import glob as _glob_mod
        for orphan in _glob_mod.glob(str(logs_dir / "iter-output-*")):
            try:
                os.unlink(orphan)
            except OSError:
                pass

    return {
        "success": True,
        "message": "Session stopped" if process_stopped else "Stop signal sent",
        "process_stopped": process_stopped,
    }


# =============================================================================
# Cost Visibility API
# =============================================================================

# Static fallback pricing per million tokens (USD) - updated 2026-02-07
# At runtime, overridden by .loki/pricing.json if available
_DEFAULT_PRICING = {
    # Claude (Anthropic)
    # Fable 5 is the top-tier advisory model at exactly 2x Opus per token.
    "fable":  {"input": 10.00, "output": 50.00},
    "claude-fable-5": {"input": 10.00, "output": 50.00},
    "opus":   {"input": 5.00, "output": 25.00},
    "sonnet": {"input": 3.00, "output": 15.00},
    "haiku":  {"input": 1.00, "output": 5.00},
    # OpenAI Codex
    "gpt-5.3-codex": {"input": 1.50, "output": 12.00},
}

# Active pricing - starts with defaults, updated from .loki/pricing.json
_MODEL_PRICING = dict(_DEFAULT_PRICING)


def _load_pricing_from_file() -> dict:
    """Load pricing from .loki/pricing.json if available."""
    loki_dir = _get_loki_dir()
    pricing_file = loki_dir / "pricing.json"
    if pricing_file.exists():
        try:
            data = json.loads(pricing_file.read_text())
            models = data.get("models", {})
            if models:
                return models
        except (json.JSONDecodeError, IOError):
            pass
    return {}


def _get_model_pricing() -> dict:
    """Get current model pricing, preferring .loki/pricing.json over defaults."""
    file_pricing = _load_pricing_from_file()
    if file_pricing:
        merged = dict(_DEFAULT_PRICING)
        merged.update(file_pricing)
        return merged
    return _MODEL_PRICING


def _calculate_model_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Calculate USD cost for a model's token usage."""
    pricing_table = _get_model_pricing()
    pricing = pricing_table.get(model.lower(), pricing_table.get("sonnet", {}))
    input_cost = (input_tokens / 1_000_000) * pricing.get("input", 3.00)
    output_cost = (output_tokens / 1_000_000) * pricing.get("output", 15.00)
    return round(input_cost + output_cost, 6)


@app.get("/api/cost", dependencies=[Depends(auth.require_scope("read"))])
async def get_cost():
    """Get cost visibility data from .loki/metrics/efficiency/ and budget.json.

    The computation globs + reads every per-iteration efficiency JSON file
    (a blocking multi-file read loop building only local aggregates), so it is
    offloaded to a thread to keep the event loop responsive.
    """
    return await asyncio.to_thread(_compute_cost_snapshot)


def _compute_cost_snapshot() -> dict:
    loki_dir = _get_loki_dir()
    efficiency_dir = loki_dir / "metrics" / "efficiency"
    budget_file = loki_dir / "metrics" / "budget.json"

    total_input = 0
    total_output = 0
    estimated_cost = 0.0
    by_phase: dict = {}
    by_model: dict = {}
    budget_limit = None
    budget_used = 0.0
    budget_remaining = None

    # Read efficiency files (one JSON file per iteration/task).
    # Use the iteration-*.json pattern so this reader sees the same
    # authoritative file set as _compute_budget_snapshot and
    # _compute_cost_timeline (both glob iteration-*.json, mirroring
    # check_budget_limit in run.sh). A bare *.json would also pick up
    # non-iteration JSON in the dir and make the three cost readers disagree.
    if efficiency_dir.exists():
        for eff_file in sorted(efficiency_dir.glob("iteration-*.json")):
            try:
                data = json.loads(eff_file.read_text())
                # A corrupt/truncated efficiency file can parse to a non-object
                # (list / null / scalar); data.get(...) would then raise
                # AttributeError. Skip such files rather than 500 the endpoint.
                if not isinstance(data, dict):
                    continue

                inp = data.get("input_tokens", 0)
                out = data.get("output_tokens", 0)
                model = data.get("model", "sonnet").lower()
                phase = data.get("phase", "unknown")

                total_input += inp
                total_output += out

                cost = data.get("cost_usd")
                if cost is None:
                    cost = _calculate_model_cost(model, inp, out)
                estimated_cost += cost

                # Aggregate by phase
                if phase not in by_phase:
                    by_phase[phase] = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
                by_phase[phase]["input_tokens"] += inp
                by_phase[phase]["output_tokens"] += out
                by_phase[phase]["cost_usd"] += cost

                # Aggregate by model
                if model not in by_model:
                    by_model[model] = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
                by_model[model]["input_tokens"] += inp
                by_model[model]["output_tokens"] += out
                by_model[model]["cost_usd"] += cost
            except (json.JSONDecodeError, KeyError, TypeError, AttributeError):
                pass

    # Fallback: read from context tracking if efficiency files have no token data
    if total_input == 0 and total_output == 0:
        ctx_file = loki_dir / "context" / "tracking.json"
        if ctx_file.exists():
            try:
                ctx = json.loads(ctx_file.read_text())
                # A corrupt/truncated tracking.json can parse to a non-object;
                # ctx.get(...) would then raise AttributeError. Skip it.
                if not isinstance(ctx, dict):
                    ctx = {}
                totals = ctx.get("totals", {})
                if not isinstance(totals, dict):
                    totals = {}
                total_input = totals.get("total_input", 0)
                total_output = totals.get("total_output", 0)
                if total_input > 0 or total_output > 0:
                    estimated_cost = totals.get("total_cost_usd", 0.0)
                    # Rebuild by_model and by_phase from per_iteration data
                    for it in ctx.get("per_iteration", []):
                        inp = it.get("input_tokens", 0)
                        out = it.get("output_tokens", 0)
                        cost = it.get("cost_usd", 0)
                        model = ctx.get("provider", "sonnet").lower()
                        if model not in by_model:
                            by_model[model] = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
                        by_model[model]["input_tokens"] += inp
                        by_model[model]["output_tokens"] += out
                        by_model[model]["cost_usd"] += cost
            except (json.JSONDecodeError, KeyError, TypeError, AttributeError):
                pass

    # Read budget configuration
    if budget_file.exists():
        try:
            budget_data = json.loads(budget_file.read_text())
            budget_limit = budget_data.get("limit")
            if budget_limit is not None:
                budget_used = estimated_cost
                budget_remaining = max(0.0, budget_limit - budget_used)
        except (json.JSONDecodeError, KeyError):
            pass

    return {
        "total_input_tokens": total_input,
        "total_output_tokens": total_output,
        "estimated_cost_usd": round(estimated_cost, 6),
        "by_phase": {k: {
            "input_tokens": v["input_tokens"],
            "output_tokens": v["output_tokens"],
            "cost_usd": round(v["cost_usd"], 6),
        } for k, v in by_phase.items()},
        "by_model": {k: {
            "input_tokens": v["input_tokens"],
            "output_tokens": v["output_tokens"],
            "cost_usd": round(v["cost_usd"], 6),
        } for k, v in by_model.items()},
        "budget_limit": budget_limit,
        "budget_used": round(budget_used, 6) if budget_limit is not None else None,
        "budget_remaining": round(budget_remaining, 6) if budget_remaining is not None else None,
    }


@app.get("/api/budget", dependencies=[Depends(auth.require_scope("read"))])
async def get_budget():
    """Get current budget status from .loki/metrics/budget.json and cost data."""
    loki_dir = _get_loki_dir()
    budget_file = loki_dir / "metrics" / "budget.json"
    signals_dir = loki_dir / "signals"

    # Read budget configuration
    budget_limit = None
    budget_used = 0.0
    exceeded = False
    exceeded_at = None

    if budget_file.exists():
        try:
            budget_data = json.loads(budget_file.read_text())
            budget_limit = budget_data.get("limit") or budget_data.get("budget_limit")
            budget_used = budget_data.get("budget_used", 0.0)
            exceeded = budget_data.get("exceeded", False)
            exceeded_at = budget_data.get("exceeded_at")
        except (json.JSONDecodeError, KeyError):
            pass

    # Also check env var for limit if not in file
    if budget_limit is None:
        env_limit = os.environ.get("LOKI_BUDGET_LIMIT", "")
        if env_limit:
            try:
                budget_limit = float(env_limit)
            except ValueError:
                pass

    # Check for budget exceeded signal
    signal_file = signals_dir / "BUDGET_EXCEEDED"
    if signal_file.exists():
        exceeded = True
        if exceeded_at is None:
            try:
                sig_data = json.loads(signal_file.read_text())
                exceeded_at = sig_data.get("timestamp")
            except (json.JSONDecodeError, KeyError):
                pass

    # Coerce defensively: a budget.json with a non-numeric budget_used/limit
    # (e.g. "n/a", null, a list) parses as valid JSON but would crash float()
    # with ValueError/TypeError. Treat non-numeric values as 0.0 / None so the
    # endpoint returns a clean payload instead of a 500.
    def _to_float(value, default=0.0):
        try:
            return float(value)
        except (ValueError, TypeError):
            return default

    budget_limit_f = _to_float(budget_limit, None) if budget_limit is not None else None
    budget_used_f = _to_float(budget_used, 0.0)

    # current_cost must reflect real live spend, not the static budget.json
    # field which only updates when run.sh persists it. The same divergence
    # made the widget show $0 mid-run while /api/cost summed real spend.
    # Derive from _compute_budget_snapshot (sums live efficiency records,
    # the single source of truth shared with /api/cost/timeline and the WS
    # push); keep budget.json's value only as a fallback when no live spend
    # has been recorded yet.
    try:
        snapshot = _compute_budget_snapshot(loki_dir)
        live_used = snapshot.get("used")
        if isinstance(live_used, (int, float)) and live_used > 0:
            budget_used_f = float(live_used)
        if budget_limit_f is None and snapshot.get("limit") is not None:
            budget_limit_f = _to_float(snapshot.get("limit"), None)
    except Exception:
        # Never let the live computation break the endpoint; fall back to the
        # static budget.json value already loaded above.
        pass

    remaining = None
    if budget_limit_f is not None:
        remaining = max(0.0, budget_limit_f - budget_used_f)

    return {
        "budget_limit": budget_limit_f,
        "current_cost": round(budget_used_f, 4),
        "exceeded": exceeded,
        "exceeded_at": exceeded_at,
        "remaining": round(remaining, 4) if remaining is not None else None,
    }


# Budget warn threshold: surface a "warn" status before the hard cap so users
# are not surprised by a bill. Matches the runtime warn in run.sh
# check_budget_limit() and budget.ts (warn at 80%, hard-stop at 100%).
_BUDGET_WARN_FRACTION = 0.80


def _budget_status(used: float, limit: Optional[float]) -> str:
    """Classify budget usage. Read-time only; no state mutation.

    Returns one of: "none" (no limit set), "ok" (<80%), "warn" (>=80% and
    <100%), "exceeded" (>=100%). The warn band is the anti-surprise wedge:
    the user sees it BEFORE the hard cap pauses the run.
    """
    if limit is None or limit <= 0:
        return "none"
    if used >= limit:
        return "exceeded"
    if used >= _BUDGET_WARN_FRACTION * limit:
        return "warn"
    return "ok"


def _compute_budget_snapshot(loki_dir: _Path) -> dict:
    """Read-time budget snapshot shared by /api/cost/timeline and the WS push.

    Single source of truth so the proactive WebSocket broadcast and the pull
    endpoint never disagree. "used" is the current run's spend (sum of the live
    .loki/metrics/efficiency/iteration-*.json records, mirroring
    check_budget_limit in run.sh). The cap comes from budget.json, falling back
    to the LOKI_BUDGET_LIMIT env var. No state is mutated.
    """
    efficiency_dir = loki_dir / "metrics" / "efficiency"
    budget_file = loki_dir / "metrics" / "budget.json"

    current_total = 0.0
    if efficiency_dir.exists():
        for eff_file in sorted(efficiency_dir.glob("iteration-*.json")):
            data = _safe_json_read(eff_file, default=None)
            if not isinstance(data, dict):
                continue
            inp = data.get("input_tokens", 0) or 0
            out = data.get("output_tokens", 0) or 0
            model = str(data.get("model", "sonnet")).lower()
            cost = data.get("cost_usd")
            if cost is None:
                cost = _calculate_model_cost(model, inp, out)
            else:
                try:
                    cost = float(cost)
                except (TypeError, ValueError):
                    cost = 0.0
            current_total += cost

    budget_limit = None
    if budget_file.exists():
        bdata = _safe_json_read(budget_file, default=None)
        if isinstance(bdata, dict):
            budget_limit = bdata.get("limit") or bdata.get("budget_limit")
    if budget_limit is None:
        env_limit = os.environ.get("LOKI_BUDGET_LIMIT", "")
        if env_limit:
            try:
                budget_limit = float(env_limit)
            except ValueError:
                budget_limit = None
    if budget_limit is not None:
        try:
            budget_limit = float(budget_limit)
        except (TypeError, ValueError):
            budget_limit = None

    used = round(current_total, 6)
    if budget_limit is not None and budget_limit > 0:
        remaining = max(0.0, budget_limit - used)
        percent_used = round((used / budget_limit) * 100, 2)
    else:
        remaining = None
        percent_used = None
    status = _budget_status(used, budget_limit)

    return {
        "limit": budget_limit,
        "used": used,
        "remaining": round(remaining, 6) if remaining is not None else None,
        "percent_used": percent_used,
        "status": status,
        "warn_threshold_percent": int(_BUDGET_WARN_FRACTION * 100),
        "exceeded": status == "exceeded",
    }


@app.get("/api/cost/timeline", dependencies=[Depends(auth.require_scope("read"))])
async def get_cost_timeline():
    """Cost over time: intra-run per-iteration series + per-run history.

    Two honest series, distinct sources (see docs/R3-COST-OBSERVABILITY-DESIGN.md):
      - current_run: from .loki/metrics/efficiency/iteration-*.json. This dir is
        wiped at the start of every run (run.sh), so it only ever holds the
        CURRENT run's iterations. Used for the intra-run cumulative line.
      - runs: from .loki/proofs/<run_id>/proof.json (persistent, one per run).
        This is the real per-run/per-project "cost over time" history.

    Budget status is computed at read time (no budget.json schema change) and
    classifies into ok/warn/exceeded so the UI can warn at 80% before the cap.
    Cost is never fabricated: when nothing was recorded, cost_recorded is False
    and totals are honestly null rather than a misleading $0.00.

    Globs + reads every efficiency iteration file and every proof.json (a
    blocking multi-file read loop building only local state), so it is offloaded
    to a thread to keep the event loop responsive.
    """
    return await asyncio.to_thread(_compute_cost_timeline)


def _compute_cost_timeline() -> dict:
    loki_dir = _get_loki_dir()
    efficiency_dir = loki_dir / "metrics" / "efficiency"

    # --- current run: per-iteration series from efficiency/ -----------------
    iterations: list = []
    current_total = 0.0
    cost_recorded = False
    if efficiency_dir.exists():
        records = []
        for eff_file in sorted(efficiency_dir.glob("iteration-*.json")):
            data = _safe_json_read(eff_file, default=None)
            if not isinstance(data, dict):
                continue
            records.append(data)
        # Sort by numeric iteration when present, else by filename order.
        def _iter_key(d):
            try:
                return int(d.get("iteration", 0))
            except (TypeError, ValueError):
                return 0
        records.sort(key=_iter_key)
        cumulative = 0.0
        for data in records:
            cost_recorded = True
            inp = data.get("input_tokens", 0) or 0
            out = data.get("output_tokens", 0) or 0
            model = str(data.get("model", "sonnet")).lower()
            cost = data.get("cost_usd")
            if cost is None:
                cost = _calculate_model_cost(model, inp, out)
            else:
                try:
                    cost = float(cost)
                except (TypeError, ValueError):
                    cost = 0.0
            cumulative += cost
            iterations.append({
                "iteration": data.get("iteration"),
                "timestamp": data.get("timestamp"),
                "model": model,
                "phase": data.get("phase", "unknown"),
                "provider": data.get("provider"),
                "input_tokens": inp,
                "output_tokens": out,
                "cost_usd": round(cost, 6),
                "cumulative_usd": round(cumulative, 6),
            })
        current_total = cumulative

    # --- per-run history: from .loki/proofs/*/proof.json --------------------
    runs: list = []
    project_total = 0.0
    proofs_dir = _proofs_dir()
    try:
        entries = sorted(proofs_dir.iterdir())
    except (OSError, FileNotFoundError):
        entries = []
    for entry in entries:
        if not entry.is_dir():
            continue
        data = _safe_json_read(entry / "proof.json", default=None)
        if not isinstance(data, dict):
            continue
        run_cost = (data.get("cost") or {}).get("usd")
        run_cost_num = None
        if run_cost is not None:
            try:
                run_cost_num = float(run_cost)
                project_total += run_cost_num
            except (TypeError, ValueError):
                run_cost_num = None
        runs.append({
            "run_id": data.get("run_id", entry.name),
            "generated_at": data.get("generated_at"),
            "model": (data.get("provider") or {}).get("model"),
            "cost_usd": round(run_cost_num, 6) if run_cost_num is not None else None,
            "files_changed": (data.get("files_changed") or {}).get("count"),
            "final_verdict": (data.get("council") or {}).get("final_verdict"),
        })
    runs.sort(key=lambda x: (x.get("generated_at") or ""), reverse=True)

    # --- budget block (read-time status; no mutation) -----------------------
    # Shared snapshot so the pull endpoint and the proactive WS push agree.
    # Budget "used" is the current run's spend (mirrors check_budget_limit,
    # which sums the live efficiency dir against the cap). The per-project
    # history total is reported separately as project_total_usd.
    budget = _compute_budget_snapshot(loki_dir)

    return {
        "current_run": {
            "iterations": iterations,
            "total_usd": round(current_total, 6) if cost_recorded else None,
            "cost_recorded": cost_recorded,
        },
        "runs": runs,
        "runs_count": len(runs),
        "project_total_usd": round(project_total, 6) if runs else 0.0,
        "budget": budget,
    }


# =============================================================================
# Trust trajectory API (R4): is the agent earning autonomy on THIS repo?
# =============================================================================

_TRUST_MODULE = None  # cached import of autonomy/lib/trust_trajectory.py


def _load_trust_module():
    """Import the shared trust-trajectory derivation (single source of truth).

    The derivation lives in autonomy/lib/trust_trajectory.py so the dashboard
    endpoint, the bash `cmd_trust`, and the test suite all agree. Loaded via
    importlib because autonomy/lib is not an importable package. Cached after
    first load. Returns None if the module cannot be found (degraded mode).
    """
    global _TRUST_MODULE
    if _TRUST_MODULE is not None:
        return _TRUST_MODULE
    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    mod_path = os.path.join(repo_root, "autonomy", "lib", "trust_trajectory.py")
    if not os.path.isfile(mod_path):
        return None
    try:
        import importlib.util as _ilu
        spec = _ilu.spec_from_file_location("trust_trajectory", mod_path)
        if spec is None or spec.loader is None:
            return None
        mod = _ilu.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _TRUST_MODULE = mod
        return mod
    except Exception:
        return None


@app.get("/api/trust/trajectory", dependencies=[Depends(auth.require_scope("read"))])
async def get_trust_trajectory():
    """Per-project trust trajectory derived from proof-of-run history.

    Mirrors /api/cost/timeline: reads the persistent per-run records under
    .loki/proofs/<run_id>/proof.json (the same source R3 cost history uses) and
    derives whether the agent is earning autonomy on THIS repo over time:
    council pass-rate, gate pass-rate, iterations-to-completion, and (when
    recorded) human interventions, each with an up/down/flat direction and an
    `improving` flag that already accounts for per-axis polarity.

    Honest-data rule: with fewer than 2 recorded runs the response is
    insufficient=True and NO direction is fabricated. Every number derives from
    real proof.json values; a missing axis is reported available=False, never a
    misleading zero. No PII leaves the derivation (only run_id, timestamps, and
    derived numeric axes).
    """
    loki_dir = _get_loki_dir()
    mod = _load_trust_module()
    if mod is None:
        return {
            "schema_version": 1,
            "available": False,
            "error": "trust_trajectory module not found",
            "runs_count": 0,
            "insufficient": True,
            "axes": {},
            "series": [],
            "notes": ["trust derivation module unavailable in this install"],
        }
    traj = mod.compute_trajectory(str(loki_dir))
    # Best-effort cache write so other surfaces share one source of truth.
    try:
        mod.write_trajectory_cache(str(loki_dir), traj)
    except Exception:
        pass
    traj["available"] = True
    return traj


# =============================================================================
# Pricing API
# =============================================================================

_PROVIDER_LABELS = {
    # v7.104.0: current model IDs (model_catalog.json): opus=claude-opus-4-8,
    # sonnet=claude-sonnet-5 (the default execution model), haiku=claude-haiku-4-5.
    "opus": "Opus 4.8",
    "sonnet": "Sonnet 5",
    "haiku": "Haiku 4.5",
    "gpt-5.3-codex": "GPT-5.3 Codex",
}

# Display-only pricing notes, keyed by model. These annotate the pricing table in
# the UI WITHOUT changing any computed cost number. The Sonnet 5 launch carries an
# intro price ($2/$10 per MTok through Aug 31 2026), but the cost estimator keeps
# quoting the standard $3/$15 rate: over-estimating the display is the safe
# direction (a bill can only come in lower than quoted, never higher). This note
# tells the user why the quote is conservative during the intro window.
_MODEL_PRICING_NOTES = {
    "sonnet": (
        "Intro pricing: $2 / $10 per MTok through Aug 31 2026. "
        "Estimates use the standard $3 / $15 rate (conservative)."
    ),
}

_MODEL_PROVIDERS = {
    "opus": "claude",
    "sonnet": "claude",
    "haiku": "claude",
    "gpt-5.3-codex": "codex",
    "cline-default": "cline",
    "aider-default": "aider",
}


@app.get("/api/pricing", dependencies=[Depends(auth.require_scope("read"))])
async def get_pricing():
    """Get current model pricing. Reads from .loki/pricing.json if available, falls back to static defaults."""
    loki_dir = _get_loki_dir()
    pricing_file = loki_dir / "pricing.json"

    # Try to read from .loki/pricing.json first
    if pricing_file.exists():
        try:
            data = json.loads(pricing_file.read_text())
            if data.get("models"):
                return data
        except (json.JSONDecodeError, IOError):
            pass

    # Determine active provider
    provider = "claude"
    provider_file = loki_dir / "state" / "provider"
    if provider_file.exists():
        try:
            provider = provider_file.read_text().strip()
        except IOError:
            pass

    # Build response from static defaults
    pricing_table = _get_model_pricing()
    models = {}
    for model_key, rates in pricing_table.items():
        entry = {
            "input": rates["input"],
            "output": rates["output"],
            "label": _PROVIDER_LABELS.get(model_key, model_key),
            "provider": _MODEL_PROVIDERS.get(model_key, "unknown"),
        }
        # Display-only note (e.g. Sonnet 5 intro pricing). Present only when a note
        # exists; the input/output numbers above are unchanged (conservative).
        note = _MODEL_PRICING_NOTES.get(model_key)
        if note:
            entry["note"] = note
        models[model_key] = entry

    return {
        "provider": provider,
        "updated": "2026-02-07",
        "source": "static",
        "models": models,
    }


# =============================================================================
# Completion Council API (v5.25.0)
# =============================================================================

@app.get("/api/council/state", dependencies=[Depends(auth.require_scope("read"))])
async def get_council_state():
    """Get current Completion Council state."""
    state_file = _get_loki_dir() / "council" / "state.json"
    if state_file.exists():
        try:
            return json.loads(state_file.read_text())
        except Exception:
            pass
    return {"enabled": False, "total_votes": 0, "verdicts": []}


@app.get("/api/council/verdicts", dependencies=[Depends(auth.require_scope("read"))])
async def get_council_verdicts(limit: int = Query(default=20, ge=1, le=1000)):
    """Get council vote history (decision log).

    Walks every vote directory and reads its evidence/member/contrarian files
    (a blocking multi-file read loop building only local state), so it is
    offloaded to a thread to keep the event loop responsive.
    """
    def _collect_verdicts() -> dict:
        state_file = _get_loki_dir() / "council" / "state.json"
        verdicts = []
        if state_file.exists():
            try:
                state = json.loads(state_file.read_text())
                verdicts = state.get("verdicts", [])
            except Exception:
                pass

        # Also read individual vote files for detail
        votes_dir = _get_loki_dir() / "council" / "votes"
        detailed_verdicts = []
        if votes_dir.exists():
            for vote_dir in sorted(votes_dir.iterdir(), reverse=True):
                if vote_dir.is_dir():
                    verdict_detail = {"iteration": vote_dir.name}
                    # Read evidence
                    evidence_file = vote_dir / "evidence.md"
                    if evidence_file.exists():
                        try:
                            verdict_detail["evidence_preview"] = evidence_file.read_text()[:500]
                        except Exception:
                            verdict_detail["evidence_preview"] = ""
                    # Read member votes
                    members = []
                    for member_file in sorted(vote_dir.glob("member-*.txt")):
                        try:
                            content = member_file.read_text().strip()
                            members.append({
                                "member": member_file.stem,
                                "content": content
                            })
                        except Exception:
                            pass
                    verdict_detail["members"] = members
                    # Read contrarian
                    contrarian_file = vote_dir / "contrarian.txt"
                    if contrarian_file.exists():
                        verdict_detail["contrarian"] = contrarian_file.read_text().strip()
                    detailed_verdicts.append(verdict_detail)
                    if len(detailed_verdicts) >= limit:
                        break

        return {"verdicts": verdicts, "details": detailed_verdicts}

    return await asyncio.to_thread(_collect_verdicts)


@app.get("/api/council/convergence", dependencies=[Depends(auth.require_scope("read"))])
async def get_council_convergence():
    """Get convergence tracking data for visualization."""
    convergence_file = _get_loki_dir() / "council" / "convergence.log"
    data_points = []
    if convergence_file.exists():
        for line in convergence_file.read_text().strip().split("\n"):
            try:
                parts = line.split("|")
                if len(parts) >= 5:
                    data_points.append({
                        "timestamp": parts[0],
                        "iteration": int(parts[1]),
                        "files_changed": int(parts[2]),
                        "no_change_streak": int(parts[3]),
                        "done_signals": int(parts[4]),
                    })
            except Exception:
                continue
    return {"dataPoints": data_points}


@app.get("/api/council/report", dependencies=[Depends(auth.require_scope("read"))])
async def get_council_report():
    """Get the final council completion report."""
    report_file = _get_loki_dir() / "council" / "report.md"
    if report_file.exists():
        return {"report": report_file.read_text()}
    return {"report": None}


@app.post("/api/council/force-review", dependencies=[Depends(auth.require_scope("control"))])
async def force_council_review():
    """Force an immediate council review (writes signal file)."""
    signal_dir = _get_loki_dir() / "signals"
    signal_dir.mkdir(parents=True, exist_ok=True)
    (signal_dir / "COUNCIL_REVIEW_REQUESTED").write_text(
        datetime.now(timezone.utc).isoformat()
    )
    return {"success": True, "message": "Council review requested"}


@app.get("/api/council/transcripts", dependencies=[Depends(auth.require_scope("read"))])
async def get_council_transcripts(
    limit: int = Query(default=20, ge=1, le=200),
    since: Optional[str] = Query(default=None),
    iter_min: Optional[int] = Query(default=None, ge=0),
    type_prefix: Optional[str] = Query(default=None),
):
    """List council transcript records, sorted descending by iteration number.

    Query params:
      limit       int, default=20, max=200
      since       ISO8601 string (optional), filter to transcripts after this time
      iter_min    int (optional), filter to iteration >= N
      type_prefix str (optional), v7.5.22 Phase D. When set, the response also
                  includes a ``hook_events`` array of matching .loki/events.jsonl
                  entries whose ``type`` starts with this prefix (e.g.
                  ``claude_hook_``). Unset -> behavior unchanged.
    """
    # Validate query params before any early-return so invalid inputs always get 400.
    since_dt = None
    if since:
        try:
            since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid 'since' timestamp format; expected ISO8601")

    transcripts_dir = _get_loki_dir() / "council" / "transcripts"
    if not transcripts_dir.exists():
        response: dict = {"transcripts": [], "total": 0, "latest_id": None}
        if type_prefix:
            response["hook_events"] = await asyncio.to_thread(_read_events, type_prefix=type_prefix)
        return response

    def _collect_transcript_records() -> list:
        # Globs + reads up to `limit` (<=200) JSON transcript files; a blocking
        # multi-file read loop offloaded so the event loop stays responsive.
        out: list = []
        for f in sorted(transcripts_dir.glob("iter-*.json"), reverse=True):
            try:
                rec = json.loads(f.read_text())
            except Exception:
                logger.warning("Skipping corrupt council transcript file: %s", f.name)
                continue
            if not isinstance(rec, dict):
                logger.warning("Skipping non-object council transcript file: %s", f.name)
                continue
            if not isinstance(rec.get("iteration_id"), str):
                logger.warning("Skipping transcript missing iteration_id field: %s", f.name)
                continue
            if since_dt is not None:
                ts_str = rec.get("timestamp", "")
                try:
                    ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                except (ValueError, AttributeError):
                    continue
                if ts <= since_dt:
                    continue
            if iter_min is not None and rec.get("iteration", 0) < iter_min:
                continue
            out.append(rec)
            if len(out) >= limit:
                break
        return out

    records = await asyncio.to_thread(_collect_transcript_records)

    response = {
        "transcripts": records,
        "total": len(records),
        "latest_id": records[0].get("iteration_id") if records else None,
    }
    # v7.5.22 Phase D: opt-in hook-event passthrough via _read_events filter.
    if type_prefix:
        response["hook_events"] = await asyncio.to_thread(_read_events, type_prefix=type_prefix)
    return response


@app.get("/api/council/transcripts/{iteration_id}", dependencies=[Depends(auth.require_scope("read"))])
async def get_council_transcript(iteration_id: str):
    """Fetch a single council transcript by iteration_id.

    Returns the record body or 404 if not found.
    Path traversal attempts (containing '/' or '..') are rejected with 404.
    """
    # Reject path traversal: iteration_id must be a plain filename component.
    if "/" in iteration_id or "\\" in iteration_id or ".." in iteration_id:
        raise HTTPException(status_code=404, detail="Transcript not found")
    transcript_file = _get_loki_dir() / "council" / "transcripts" / f"{iteration_id}.json"
    if not transcript_file.exists():
        raise HTTPException(status_code=404, detail="Transcript not found")
    try:
        rec = json.loads(transcript_file.read_text())
    except Exception:
        raise HTTPException(
            status_code=410,
            detail=f"Transcript file for {iteration_id} is corrupt; admin should inspect or remove it",
        )
    if not isinstance(rec, dict):
        raise HTTPException(
            status_code=410,
            detail=f"Transcript file for {iteration_id} is corrupt; admin should inspect or remove it",
        )
    return rec


# =============================================================================
# Context Window Tracking API (v5.40.0)
# =============================================================================

@app.get("/api/context", dependencies=[Depends(auth.require_scope("read"))])
async def get_context():
    """Get context window tracking data from .loki/context/tracking.json."""
    loki_dir = _get_loki_dir()
    tracking_file = loki_dir / "context" / "tracking.json"

    if not tracking_file.exists():
        return {
            "session_id": "",
            "updated_at": "",
            "current": {
                "input_tokens": 0, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_creation_tokens": 0,
                "total_tokens": 0, "context_window_pct": 0.0,
                "estimated_cost_usd": 0.0,
            },
            "compactions": [],
            "per_iteration": [],
            "totals": {
                "total_input": 0, "total_output": 0,
                "total_cost_usd": 0.0, "compaction_count": 0,
                "iterations_tracked": 0,
            },
        }

    try:
        return json.loads(tracking_file.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("Failed to read context tracking: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to read context tracking data")


# =============================================================================
# Notification Trigger API (v5.40.0)
# =============================================================================

@app.get("/api/notifications", dependencies=[Depends(auth.require_scope("read"))])
async def get_notifications(
    severity: Optional[str] = Query(None, pattern="^(critical|warning|info)$"),
    unread_only: bool = Query(False),
):
    """Get notification list from .loki/notifications/active.json."""
    loki_dir = _get_loki_dir()
    active_file = loki_dir / "notifications" / "active.json"

    if not active_file.exists():
        return {
            "notifications": [],
            "summary": {"total": 0, "unacknowledged": 0, "critical": 0, "warning": 0, "info": 0},
        }

    try:
        data = json.loads(active_file.read_text())
    except (json.JSONDecodeError, OSError):
        return {
            "notifications": [],
            "summary": {"total": 0, "unacknowledged": 0, "critical": 0, "warning": 0, "info": 0},
        }

    notifications = data.get("notifications", [])

    # Apply filters
    if severity:
        notifications = [n for n in notifications if n.get("severity") == severity]
    if unread_only:
        notifications = [n for n in notifications if not n.get("acknowledged", False)]

    return {
        "notifications": notifications,
        "summary": data.get("summary", {}),
    }


@app.get("/api/notifications/triggers", dependencies=[Depends(auth.require_scope("read"))])
async def get_notification_triggers():
    """Get notification trigger configuration from .loki/notifications/triggers.json."""
    loki_dir = _get_loki_dir()
    triggers_file = loki_dir / "notifications" / "triggers.json"

    if not triggers_file.exists():
        return {"triggers": []}

    try:
        return json.loads(triggers_file.read_text())
    except (json.JSONDecodeError, OSError):
        return {"triggers": []}


@app.put("/api/notifications/triggers", dependencies=[Depends(auth.require_scope("control"))])
async def update_notification_triggers(request: Request):
    """Update notification trigger configuration."""
    loki_dir = _get_loki_dir()
    notif_dir = loki_dir / "notifications"
    notif_dir.mkdir(parents=True, exist_ok=True)
    triggers_file = notif_dir / "triggers.json"

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    triggers = body.get("triggers")
    if not isinstance(triggers, list):
        raise HTTPException(status_code=400, detail="Body must contain a 'triggers' array")

    # Validate each trigger has required fields
    for t in triggers:
        if not isinstance(t, dict) or not t.get("id") or not t.get("type"):
            raise HTTPException(status_code=400, detail="Each trigger must have 'id' and 'type'")

    tmp_file = triggers_file.with_suffix(".tmp")
    tmp_file.write_text(json.dumps({"triggers": triggers}, indent=2))
    tmp_file.rename(triggers_file)

    return {"success": True, "count": len(triggers)}


@app.post("/api/notifications/{notification_id}/acknowledge", dependencies=[Depends(auth.require_scope("control"))])
async def acknowledge_notification(notification_id: str):
    """Mark a notification as acknowledged."""
    loki_dir = _get_loki_dir()
    active_file = loki_dir / "notifications" / "active.json"

    if not active_file.exists():
        raise HTTPException(status_code=404, detail="No notifications found")

    try:
        data = json.loads(active_file.read_text())
    except (json.JSONDecodeError, OSError):
        raise HTTPException(status_code=500, detail="Failed to read notifications")

    notifications = data.get("notifications", [])
    found = False
    for n in notifications:
        if n.get("id") == notification_id:
            n["acknowledged"] = True
            found = True
            break

    if not found:
        raise HTTPException(status_code=404, detail=f"Notification {notification_id} not found")

    # Recalculate summary
    unacked = sum(1 for n in notifications if not n.get("acknowledged", False))
    critical = sum(1 for n in notifications if n.get("severity") == "critical" and not n.get("acknowledged"))
    warning = sum(1 for n in notifications if n.get("severity") == "warning" and not n.get("acknowledged"))
    info = sum(1 for n in notifications if n.get("severity") == "info" and not n.get("acknowledged"))

    data["notifications"] = notifications
    data["summary"] = {
        "total": len(notifications),
        "unacknowledged": unacked,
        "critical": critical,
        "warning": warning,
        "info": info,
    }

    tmp_file = active_file.with_suffix(".tmp")
    tmp_file.write_text(json.dumps(data, indent=2))
    tmp_file.rename(active_file)

    return {"success": True, "notification_id": notification_id}


# =============================================================================
# Checkpoint API (v5.34.0)
# =============================================================================

class CheckpointCreate(BaseModel):
    """Schema for creating a checkpoint."""
    message: Optional[str] = Field(None, max_length=500, description="Optional description for the checkpoint")


def _sanitize_checkpoint_id(checkpoint_id: str) -> str:
    """Validate checkpoint_id contains only safe characters for file paths."""
    if not checkpoint_id or len(checkpoint_id) > 128 or ".." in checkpoint_id or not _SAFE_ID_RE.match(checkpoint_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid checkpoint_id: must be 1-128 chars of alphanumeric, hyphens, and underscores",
        )
    return checkpoint_id


@app.get("/api/checkpoints", dependencies=[Depends(auth.require_scope("read"))])
async def list_checkpoints(limit: int = Query(default=20, ge=1, le=200)):
    """List recent checkpoints from index.jsonl, enriched with metadata when available.

    Reads index.jsonl plus a metadata.json and a recursive rglob() file count
    per checkpoint (a blocking multi-file walk building only local state), so
    it is offloaded to a thread to keep the event loop responsive.
    """
    return await asyncio.to_thread(_collect_checkpoints, limit)


def _collect_checkpoints(limit: int) -> list:
    loki_dir = _get_loki_dir()
    index_file = loki_dir / "state" / "checkpoints" / "index.jsonl"
    checkpoints_dir = loki_dir / "state" / "checkpoints"
    checkpoints = []

    if index_file.exists():
        try:
            for line in index_file.read_text().strip().split("\n"):
                if line.strip():
                    try:
                        raw = json.loads(line)
                        # Normalize field names from run.sh index format
                        # Index writes: {id, ts, iter, task, sha}
                        # Frontend expects: {id, created_at, git_sha, message, iteration, ...}
                        cp = {
                            "id": raw.get("id", ""),
                            "created_at": raw.get("ts", raw.get("created_at", raw.get("timestamp", ""))),
                            "git_sha": raw.get("sha", raw.get("git_sha", "")),
                            "message": raw.get("task", raw.get("message", raw.get("task_description", ""))),
                            "iteration": raw.get("iter", raw.get("iteration")),
                        }
                        # Sanitize checkpoint id before using in path construction
                        cp_id = cp["id"]
                        if not cp_id or not _SAFE_ID_RE.match(cp_id):
                            continue
                        # Enrich from metadata.json if available
                        meta_file = checkpoints_dir / cp_id / "metadata.json"
                        if meta_file.exists():
                            try:
                                meta = json.loads(meta_file.read_text())
                                cp["git_branch"] = meta.get("git_branch", "")
                                cp["provider"] = meta.get("provider", "")
                                cp["phase"] = meta.get("phase", "")
                                # Count files in checkpoint dir
                                cp_dir = checkpoints_dir / cp_id
                                cp["files_count"] = sum(1 for f in cp_dir.rglob("*") if f.is_file() and f.name != "metadata.json")
                                if not cp["message"]:
                                    cp["message"] = meta.get("task_description", "")
                                if not cp["git_sha"]:
                                    cp["git_sha"] = meta.get("git_sha", "")
                                if not cp["created_at"]:
                                    cp["created_at"] = meta.get("timestamp", "")
                            except (json.JSONDecodeError, IOError):
                                pass
                        checkpoints.append(cp)
                    except json.JSONDecodeError:
                        pass
        except Exception:
            pass

    # Return most recent first, limited
    checkpoints.reverse()
    return checkpoints[:limit]


@app.get("/api/checkpoints/{checkpoint_id}", dependencies=[Depends(auth.require_scope("read"))])
async def get_checkpoint(checkpoint_id: str):
    """Get checkpoint details by ID."""
    checkpoint_id = _sanitize_checkpoint_id(checkpoint_id)
    loki_dir = _get_loki_dir()
    metadata_file = loki_dir / "state" / "checkpoints" / checkpoint_id / "metadata.json"

    if not metadata_file.exists():
        raise HTTPException(status_code=404, detail="Checkpoint not found")

    try:
        return json.loads(metadata_file.read_text())
    except (json.JSONDecodeError, IOError):
        raise HTTPException(status_code=500, detail="Failed to read checkpoint data")


@app.post("/api/checkpoints", status_code=201, dependencies=[Depends(auth.require_scope("control"))])
async def create_checkpoint(body: CheckpointCreate = None):
    """Create a new checkpoint capturing current state."""
    import subprocess
    import shutil

    loki_dir = _get_loki_dir()
    checkpoints_dir = loki_dir / "state" / "checkpoints"
    checkpoints_dir.mkdir(parents=True, exist_ok=True)

    # Generate checkpoint ID from timestamp
    now = datetime.now(timezone.utc)
    checkpoint_id = now.strftime("chk-%Y%m%d-%H%M%S")

    # Create checkpoint directory
    checkpoint_dir = checkpoints_dir / checkpoint_id
    checkpoint_dir.mkdir(parents=True, exist_ok=True)

    # Capture git SHA. Pass cwd= the active project root so the recorded
    # git_sha belongs to the project being checkpointed, not whatever directory
    # the dashboard process happens to run from (correctness bug for
    # multi-project dashboards). Offload to a thread so the blocking git call
    # does not stall the single-worker uvicorn event loop.
    git_sha = ""
    git_cwd = str(loki_dir.parent) if loki_dir.name == ".loki" else None
    try:
        result = await asyncio.to_thread(
            lambda: subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True, text=True, timeout=5,
                cwd=git_cwd,
            )
        )
        if result.returncode == 0:
            git_sha = result.stdout.strip()
    except Exception:
        pass

    # Copy key state files into checkpoint
    state_files = [
        "dashboard-state.json",
        "session.json",
    ]
    for fname in state_files:
        src = loki_dir / fname
        if src.exists():
            try:
                shutil.copy2(str(src), str(checkpoint_dir / fname))
            except Exception:
                pass

    # Copy queue directory if present. Offload to a thread: a large queue tree
    # would otherwise block the single-worker uvicorn event loop.
    queue_src = loki_dir / "queue"
    if queue_src.exists():
        try:
            await asyncio.to_thread(
                shutil.copytree,
                str(queue_src), str(checkpoint_dir / "queue"), dirs_exist_ok=True,
            )
        except Exception:
            pass

    # Build metadata
    message = ""
    if body and body.message:
        message = body.message

    metadata = {
        "id": checkpoint_id,
        "created_at": now.isoformat(),
        "git_sha": git_sha,
        "message": message,
        "files": [f.name for f in checkpoint_dir.iterdir() if f.is_file()],
    }

    # Write metadata.json
    (checkpoint_dir / "metadata.json").write_text(json.dumps(metadata, indent=2))

    # Append to index.jsonl
    index_file = checkpoints_dir / "index.jsonl"
    with open(str(index_file), "a") as f:
        f.write(json.dumps(metadata) + "\n")

    # Retention policy: keep last 50 checkpoints
    MAX_CHECKPOINTS = 50
    all_dirs = sorted(
        [d for d in checkpoints_dir.iterdir() if d.is_dir()],
        key=lambda d: d.name,
    )
    while len(all_dirs) > MAX_CHECKPOINTS:
        oldest = all_dirs.pop(0)
        shutil.rmtree(str(oldest), ignore_errors=True)

    return metadata


@app.post(
    "/api/checkpoints/{checkpoint_id}/rollback",
    dependencies=[Depends(auth.require_scope("control"))],
)
async def rollback_checkpoint(checkpoint_id: str):
    """Restore .loki/ state from a checkpoint (R6: un-deads the dashboard
    rollback button, which already POSTed here).

    Safety:
    - require_scope("control"): destructive, so it needs the control scope.
    - _sanitize_checkpoint_id: blocks path traversal.
    - Re-undoability invariant: a forced pre-rollback snapshot of current state
      is captured BEFORE overwriting, so the human can undo the undo. The
      pre_rollback_snapshot id is returned in the response so the caller can
      surface it to the user.
    - Glob-restore: copies back whatever files the checkpoint dir contains, so it
      works regardless of which writer (run.sh / loki / dashboard) created it.
    """
    import shutil

    checkpoint_id = _sanitize_checkpoint_id(checkpoint_id)
    loki_dir = _get_loki_dir()
    checkpoints_dir = loki_dir / "state" / "checkpoints"
    cp_dir = checkpoints_dir / checkpoint_id

    if not cp_dir.is_dir():
        raise HTTPException(status_code=404, detail="Checkpoint not found")

    # 1. Forced pre-rollback snapshot of current state (re-undoability).
    now = datetime.now(timezone.utc)
    pre_id = now.strftime("rb-pre-%Y%m%d-%H%M%S")
    pre_dir = checkpoints_dir / pre_id
    pre_dir.mkdir(parents=True, exist_ok=True)
    for name in ("session.json", "dashboard-state.json", "CONTINUITY.md", "autonomy-state.json"):
        src = loki_dir / name
        if src.exists() and src.is_file():
            try:
                shutil.copy2(str(src), str(pre_dir / name))
            except Exception:
                pass
    for dname in ("state", "queue"):
        src = loki_dir / dname
        if src.exists() and src.is_dir():
            try:
                # Offload the (potentially large) directory copy off the event loop.
                await asyncio.to_thread(
                    shutil.copytree,
                    str(src), str(pre_dir / dname), dirs_exist_ok=True,
                )
            except Exception:
                pass
    pre_meta = {
        "id": pre_id,
        "created_at": now.isoformat(),
        "message": f"pre-rollback snapshot (before restoring {checkpoint_id})",
        "created_by": "dashboard rollback",
    }
    try:
        (pre_dir / "metadata.json").write_text(json.dumps(pre_meta, indent=2))
        with open(str(checkpoints_dir / "index.jsonl"), "a") as f:
            f.write(json.dumps(pre_meta) + "\n")
    except Exception:
        pass

    # 2. Glob-restore the checkpoint contents back into .loki/.
    # IMPORTANT: never rmtree a destination dir wholesale -- the checkpoint store
    # itself lives under .loki/state/checkpoints/, so deleting .loki/state/ would
    # destroy every checkpoint (including the one being restored AND the
    # pre-rollback snapshot we just made). Merge directories with dirs_exist_ok
    # so the checkpoints store survives.
    restored = 0
    errors = []
    for item in cp_dir.iterdir():
        if item.name in ("metadata.json", "worktree-snapshot.txt"):
            continue
        dest = loki_dir / item.name
        try:
            if item.is_dir():
                # Offload the (potentially large) directory copy off the event loop.
                await asyncio.to_thread(
                    shutil.copytree,
                    str(item), str(dest), dirs_exist_ok=True,
                )
            else:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(str(item), str(dest))
            restored += 1
        except Exception as e:  # noqa: BLE001 -- report, do not abort other files
            errors.append(f"{item.name}: {e}")

    return {
        "id": checkpoint_id,
        "restored": restored,
        "pre_rollback_snapshot": pre_id,
        "errors": errors,
        "message": (
            f"Restored {restored} item(s) from {checkpoint_id}. "
            f"Prior state saved as {pre_id} (undo this rollback by restoring it)."
        ),
    }


# =============================================================================
# Agent Management API (v5.25.0)
# =============================================================================

@app.get("/api/agents", dependencies=[Depends(auth.require_scope("read"))])
async def get_agents():
    """Get all active and recent agents."""
    agents_file = _get_loki_dir() / "state" / "agents.json"
    agents = []
    if agents_file.exists():
        try:
            agents = json.loads(agents_file.read_text())
        except Exception:
            pass

    # Enrich with process status
    for agent in agents:
        pid = agent.get("pid")
        if pid:
            try:
                os.kill(int(pid), 0)  # Check if process exists
                agent["alive"] = True
            except (OSError, ValueError):
                agent["alive"] = False
        else:
            agent["alive"] = False

    # Fallback: read agents from dashboard-state.json if agents.json is empty
    if not agents:
        state_file = _get_loki_dir() / "dashboard-state.json"
        if state_file.exists():
            try:
                state = json.loads(state_file.read_text())
                state_agents = state.get("agents", [])
                for sa in state_agents:
                    if isinstance(sa, dict):
                        agents.append({
                            "id": sa.get("id", sa.get("name", "unknown")),
                            "name": sa.get("name", ""),
                            "type": sa.get("type", ""),
                            "pid": sa.get("pid"),
                            "task": sa.get("task", ""),
                            "status": sa.get("status", "unknown"),
                            "alive": False,
                        })
                # Check process status for fallback agents too
                for agent in agents:
                    pid = agent.get("pid")
                    if pid:
                        try:
                            os.kill(int(pid), 0)
                            agent["alive"] = True
                        except (OSError, ValueError):
                            agent["alive"] = False
            except Exception:
                pass

    return agents


@app.post("/api/agents/{agent_id}/kill", dependencies=[Depends(auth.require_scope("control"))])
async def kill_agent(agent_id: str, request: Request):
    """Kill a specific agent by ID."""
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    agent_id = _sanitize_agent_id(agent_id)

    audit.log_event(
        action="kill",
        resource_type="agent",
        resource_id=agent_id,
        details={"source": "api"},
        ip_address=request.client.host if request.client else None,
    )
    agents_file = _get_loki_dir() / "state" / "agents.json"
    if not agents_file.exists():
        raise HTTPException(404, "No agents file found")

    try:
        agents = json.loads(agents_file.read_text())
    except Exception:
        raise HTTPException(500, "Failed to read agents file")

    target = None
    for agent in agents:
        if agent.get("id") == agent_id or agent.get("name") == agent_id:
            target = agent
            break

    if not target:
        raise HTTPException(404, f"Agent {agent_id} not found")

    pid = target.get("pid")
    if not pid:
        raise HTTPException(
            status_code=404, detail=f"Agent {agent_id} has no PID"
        )
    try:
        os.kill(int(pid), 15)  # SIGTERM
        target["status"] = "terminated"
        agents_file.write_text(json.dumps(agents, indent=2))
        return {"success": True, "message": f"Agent {agent_id} terminated"}
    except ProcessLookupError:
        raise HTTPException(
            status_code=404,
            detail=f"Process {pid} not found for agent {agent_id}",
        )
    except PermissionError as e:
        raise HTTPException(
            status_code=500, detail=f"Permission denied killing agent: {e}"
        )
    except OSError as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to kill agent: {e}"
        )


@app.post("/api/agents/{agent_id}/pause", dependencies=[Depends(auth.require_scope("control"))])
async def pause_agent(agent_id: str):
    """Pause a specific agent by writing a pause signal."""
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    agent_id = _sanitize_agent_id(agent_id)
    signal_dir = _get_loki_dir() / "signals"
    signal_dir.mkdir(parents=True, exist_ok=True)
    (signal_dir / f"PAUSE_AGENT_{agent_id}").write_text(
        datetime.now(timezone.utc).isoformat()
    )
    return {"success": True, "message": f"Pause signal sent to agent {agent_id}"}


@app.post("/api/agents/{agent_id}/resume", dependencies=[Depends(auth.require_scope("control"))])
async def resume_agent(agent_id: str):
    """Resume a paused agent."""
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    agent_id = _sanitize_agent_id(agent_id)
    signal_file = _get_loki_dir() / "signals" / f"PAUSE_AGENT_{agent_id}"
    try:
        signal_file.unlink(missing_ok=True)
    except Exception:
        pass
    return {"success": True, "message": f"Resume signal sent to agent {agent_id}"}


@app.get("/api/logs", dependencies=[Depends(auth.require_scope("read"))])
async def get_logs(lines: int = Query(default=100, ge=1, le=10000)):
    """Get recent log entries from session log files (redacted)."""
    log_dir = _get_loki_dir() / "logs"
    entries = []

    # Session logs (.loki/logs/*.log) are written raw by run.sh and can contain
    # secrets an agent/tool echoed to stdout (sk-ant-, ghp_, Bearer, AWS keys).
    # Redact every returned message exactly like the /api/app-runner/logs and
    # /errors endpoints do. The response shape is unchanged; only the message
    # content passes through the redactor.
    _redact = _get_log_redactor()

    # Regex for full timestamp: [2026-02-07T01:32:00] [INFO] msg  or  2026-02-07 01:32:00 INFO msg
    _LOG_TS_FULL = re.compile(
        r'^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\]?\s*\[?(\w+)\]?\s*(.*)'
    )
    # Regex for time-only: 01:32:00 INFO msg
    _LOG_TS_SHORT = re.compile(
        r'^(\d{2}:\d{2}:\d{2})\s+(\w+)\s+(.*)'
    )
    # Map common level strings to normalized lowercase
    _LEVEL_MAP = {
        "info": "info",
        "error": "error",
        "warn": "warning",
        "warning": "warning",
        "debug": "debug",
        "critical": "critical",
        "fatal": "critical",
        "trace": "debug",
    }

    if log_dir.exists():
        # Read the most recent log file
        log_files = sorted(log_dir.glob("*.log"), key=lambda f: f.stat().st_mtime, reverse=True)
        for log_file in log_files[:1]:
            try:
                # Use file mtime as fallback timestamp
                file_mtime = datetime.fromtimestamp(log_file.stat().st_mtime, tz=timezone.utc).strftime(
                    "%Y-%m-%dT%H:%M:%S"
                )
                # Read only the tail to avoid loading huge files into memory.
                # The up-to-1MB blocking read is offloaded to a thread so the
                # single-worker event loop (status + WS heartbeat) stays free.
                def _read_log_tail(lf_path=log_file, n=lines) -> list[str]:
                    with open(lf_path, "rb") as lf:
                        lf.seek(0, 2)
                        file_size = lf.tell()
                        read_size = min(file_size, 1024 * 1024)
                        lf.seek(max(0, file_size - read_size))
                        return lf.read().decode("utf-8", errors="replace").strip().split("\n")[-n:]
                try:
                    tail_lines = await asyncio.to_thread(_read_log_tail)
                except (OSError, UnicodeDecodeError):
                    tail_lines = []
                for raw_line in tail_lines:
                    timestamp = ""
                    level = "info"
                    message = raw_line

                    # Try full timestamp pattern first
                    m = _LOG_TS_FULL.match(raw_line)
                    if m:
                        timestamp = m.group(1).replace(" ", "T")
                        level = _LEVEL_MAP.get(m.group(2).lower(), "info")
                        message = m.group(3)
                    else:
                        # Try short time-only pattern
                        m = _LOG_TS_SHORT.match(raw_line)
                        if m:
                            timestamp = m.group(1)
                            level = _LEVEL_MAP.get(m.group(2).lower(), "info")
                            message = m.group(3)

                    # Fallback: use file modification time if no timestamp parsed
                    if not timestamp:
                        timestamp = file_mtime

                    entries.append({
                        "message": _redact(message),
                        "level": level,
                        "timestamp": timestamp,
                    })
            except Exception:
                pass

    return entries


# =============================================================================
# Collaboration API (Real-time multi-user support)
# =============================================================================

try:
    from collab.api import create_collab_routes
    create_collab_routes(app)
    logger.info("Collaboration API routes enabled")
except ImportError as e:
    logger.debug(f"Collaboration module not available: {e}")


class _CollabWsAuthMiddleware:
    """ASGI middleware that auth-gates the native /ws/collab WebSocket.

    The collaboration module registers @app.websocket("/ws/collab") inside
    create_collab_routes() and performs NO token validation: it accepts any
    connection and trusts a client-supplied ?user_id=. With enterprise auth or
    OIDC enabled this native WS is therefore reachable UNAUTHENTICATED, exposing
    user presence, shared state, and operation sync to any client. The dashboard
    cannot rely on route dependencies for WebSockets (FastAPI Depends() is not
    supported on @app.websocket routes), so this middleware validates the token
    on the /ws/collab handshake before the route runs, mirroring the native /ws
    gate and the _MountAuthGuard WS logic.

    Scope: the collab WS handle_message path applies state operations (writes)
    via ws_manager.handle_message -> sync.apply_operation, so a valid but
    read-only token must not be admitted. This requires the "control" scope to
    match the _MountAuthGuard WS scope-check pattern (a valid token alone is not
    enough), so a read-only token is closed 1008 even though it authenticates.

    When enterprise auth and OIDC are both OFF this is a pass-through, so local
    default-mode behavior is unchanged. Non-websocket scopes and other websocket
    paths (the native /ws self-guards in-route) are passed through untouched.
    Added via app.add_middleware(), so app stays a FastAPI instance and all
    later route registrations are unaffected.
    """

    def __init__(self, app) -> None:
        self._app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "websocket" or scope.get("path") != "/ws/collab":
            await self._app(scope, receive, send)
            return
        if not auth.is_enterprise_mode() and not auth.is_oidc_mode():
            await self._app(scope, receive, send)
            return
        token_str = _MountAuthGuard._ws_token_from_scope(scope)
        token_info = _MountAuthGuard._validate_ws_token(token_str)
        if token_info is None or not auth.has_scope(token_info, "control"):
            # Accept-then-close is the portable ASGI way to surface a policy
            # violation to the client before any route code runs. 1008 = policy
            # violation, matching the native /ws and _MountAuthGuard behavior.
            # "control" (not just a valid token) is required because the collab
            # WS path performs state writes; a read-only token is rejected here.
            await send({"type": "websocket.accept"})
            await send({"type": "websocket.close", "code": 1008})
            return
        await self._app(scope, receive, send)


# Gate the /ws/collab handshake before the unauthenticated collab route runs.
# Registered as middleware so app remains a FastAPI instance (route decorators
# below keep working).
app.add_middleware(_CollabWsAuthMiddleware)


# =============================================================================
# Secrets / Credential Status
# =============================================================================

@app.get("/api/secrets/status", dependencies=[Depends(auth.require_scope("admin"))])
async def get_secrets_status():
    """Get API key status (masked, validation, source). Admin only."""
    result = secrets_mod.load_secrets()
    rotated = secrets_mod.check_rotation(
        str(_get_loki_dir() / "state" / "key-fingerprints.json")
    )
    return {
        "keys": result,
        "rotated_since_last_check": rotated,
    }


# =============================================================================
# GitHub Integration API (v5.41.0)
# =============================================================================


@app.get("/api/github/status", dependencies=[Depends(auth.require_scope("read"))])
async def get_github_status():
    """Get GitHub integration status and configuration."""
    loki_dir = _get_loki_dir()
    result: dict[str, Any] = {
        "import_enabled": os.environ.get("LOKI_GITHUB_IMPORT", "false") == "true",
        "sync_enabled": os.environ.get("LOKI_GITHUB_SYNC", "false") == "true",
        "pr_enabled": os.environ.get("LOKI_GITHUB_PR", "false") == "true",
        "labels_filter": os.environ.get("LOKI_GITHUB_LABELS", ""),
        "milestone_filter": os.environ.get("LOKI_GITHUB_MILESTONE", ""),
        "limit": _safe_int_env("LOKI_GITHUB_LIMIT", 100),
        "imported_tasks": 0,
        "synced_updates": 0,
        "repo": None,
    }

    # Count imported GitHub tasks from pending queue
    pending_file = loki_dir / "queue" / "pending.json"
    if pending_file.exists():
        try:
            data = json.loads(pending_file.read_text())
            tasks = data.get("tasks", data) if isinstance(data, dict) else data
            result["imported_tasks"] = sum(1 for t in tasks if t.get("source") == "github")
        except Exception:
            pass

    # Count sync log entries
    sync_log = loki_dir / "github" / "synced.log"
    if sync_log.exists():
        try:
            result["synced_updates"] = sum(1 for _ in sync_log.open())
        except Exception:
            pass

    # Detect repo from git
    try:
        import subprocess
        # Offload the blocking git call so it does not stall the single-worker
        # uvicorn event loop.
        url = await asyncio.to_thread(
            lambda: subprocess.run(
                ["git", "remote", "get-url", "origin"],
                capture_output=True, text=True, timeout=5,
                cwd=str(loki_dir.parent) if loki_dir.name == ".loki" else None,
            )
        )
        if url.returncode == 0:
            repo = url.stdout.strip()
            # Parse owner/repo from URL
            for prefix in ["https://github.com/", "git@github.com:"]:
                if repo.startswith(prefix):
                    repo = repo[len(prefix):]
                    break
            result["repo"] = repo.removesuffix(".git")
    except Exception:
        pass

    return result


@app.get("/api/github/tasks", dependencies=[Depends(auth.require_scope("read"))])
async def get_github_tasks():
    """Get all GitHub-sourced tasks and their sync status."""
    loki_dir = _get_loki_dir()
    tasks: list[dict] = []

    # Collect GitHub tasks from all queues
    for queue_name in ["pending", "in-progress", "completed", "failed"]:
        queue_file = loki_dir / "queue" / f"{queue_name}.json"
        if queue_file.exists():
            try:
                data = json.loads(queue_file.read_text())
                items = data.get("tasks", data) if isinstance(data, dict) else data
                for t in items:
                    if t.get("source") == "github" or str(t.get("id", "")).startswith("github-"):
                        t["queue"] = queue_name
                        tasks.append(t)
            except Exception:
                pass

    # Load sync log to annotate sync status
    synced: set[str] = set()
    sync_log = loki_dir / "github" / "synced.log"
    if sync_log.exists():
        try:
            synced = set(sync_log.read_text().strip().splitlines())
        except Exception:
            pass

    for t in tasks:
        issue_num = str(t.get("github_issue", ""))
        if not issue_num:
            issue_num = str(t.get("id", "")).replace("github-", "")
        t["synced_statuses"] = [
            s.split(":")[1] for s in synced if s.startswith(f"{issue_num}:")
        ]

    return {"tasks": tasks, "total": len(tasks)}


@app.get("/api/github/sync-log", dependencies=[Depends(auth.require_scope("read"))])
async def get_github_sync_log(
    limit: int = Query(default=50, ge=1, le=500),
):
    """Get the GitHub sync log (status updates sent to issues)."""
    loki_dir = _get_loki_dir()
    sync_log = loki_dir / "github" / "synced.log"
    entries: list[dict] = []

    if sync_log.exists():
        try:
            lines = sync_log.read_text().strip().splitlines()
            for line in lines[-limit:]:
                parts = line.split(":", 1)
                if len(parts) == 2:
                    entries.append({"issue": parts[0], "status": parts[1]})
        except Exception:
            pass

    return {"entries": entries, "total": len(entries)}


# =============================================================================
# Process Health / Watchdog API
# =============================================================================


def _resolve_process_state(pid: Optional[int], last_status: str = "",
                           started: str = "", heartbeat: str = "",
                           stale_threshold: int = 30) -> dict[str, Any]:
    """Resolve process state with honest labels.

    States:
      RUNNING   - PID alive AND heartbeat < stale_threshold seconds
      STALE     - PID alive BUT no heartbeat update in > stale_threshold seconds
      COMPLETED - last_status marked done/completed and PID exited
      FAILED    - last_status marked failed OR PID exited non-zero
      CRASHED   - PID dead BUT last_status was 'running'
      UNKNOWN   - No PID, no status, or conflicting data

    Returns dict with: state, pid_alive, started, last_heartbeat, duration_seconds
    """
    now = datetime.now(timezone.utc)
    pid_alive = False
    if pid is not None:
        try:
            os.kill(pid, 0)
            pid_alive = True
        except (OSError, ValueError, TypeError):
            pass

    # Parse timestamps
    started_dt = None
    heartbeat_dt = None
    if started:
        try:
            started_dt = datetime.fromisoformat(started.replace("Z", "+00:00"))
            if started_dt.tzinfo is None:
                started_dt = started_dt.replace(tzinfo=timezone.utc)
        except (ValueError, AttributeError):
            pass

    # PID-reuse guard. os.kill(pid, 0) only proves *some* process owns this
    # numeric pid -- not that it is OUR process. After our process exits the OS
    # can recycle its pid for an unrelated program, and a bare existence probe
    # would then report that stranger as our live run forever. Cross-check the
    # live pid's real OS start time against the recorded `started` reference: a
    # genuine process was launched at or before we recorded it, so a live pid
    # whose start time is comfortably AFTER the reference must be a recycled pid
    # belonging to someone else. Only downgrade on positive evidence (start time
    # readable AND reference parseable); if either is missing we keep the prior
    # best-effort behavior rather than guess, biasing against false downgrades.
    if pid_alive and started_dt is not None:
        pid_start = _pid_start_time(pid)
        if pid_start is not None:
            reference_epoch = started_dt.timestamp()
            if pid_start > reference_epoch + _APP_RUNNER_PID_RECYCLE_MARGIN_SECONDS:
                pid_alive = False
    if heartbeat:
        try:
            heartbeat_dt = datetime.fromisoformat(heartbeat.replace("Z", "+00:00"))
            if heartbeat_dt.tzinfo is None:
                heartbeat_dt = heartbeat_dt.replace(tzinfo=timezone.utc)
        except (ValueError, AttributeError):
            pass

    # Calculate duration
    duration_seconds = None
    if started_dt:
        duration_seconds = round((now - started_dt).total_seconds())

    # Calculate heartbeat age
    heartbeat_age = None
    if heartbeat_dt:
        heartbeat_age = round((now - heartbeat_dt).total_seconds())

    # Resolve state
    normalized = last_status.lower().strip() if last_status else ""
    if pid_alive:
        if heartbeat_age is not None and heartbeat_age > stale_threshold:
            state = "STALE"
        else:
            state = "RUNNING"
    else:
        if normalized in ("done", "completed", "complete", "success"):
            state = "COMPLETED"
        elif normalized in ("failed", "error", "errored"):
            state = "FAILED"
        elif normalized in ("running", "active", "in_progress", "starting"):
            state = "CRASHED"
        elif pid is None:
            state = "UNKNOWN"
        else:
            # PID dead, unknown last status
            state = "CRASHED" if normalized == "" else "UNKNOWN"

    result: dict[str, Any] = {
        "state": state,
        "pid_alive": pid_alive,
    }
    if started:
        result["started"] = started
    if heartbeat:
        result["last_heartbeat"] = heartbeat
    if heartbeat_age is not None:
        result["heartbeat_age_seconds"] = heartbeat_age
    if duration_seconds is not None:
        result["duration_seconds"] = duration_seconds
    return result


@app.get("/api/health/processes", dependencies=[Depends(auth.require_scope("read"))])
async def get_process_health():
    """Get health status of all loki processes (dashboard, session, agents).

    Returns honest state labels: RUNNING, STALE, COMPLETED, FAILED, CRASHED, UNKNOWN.
    Every entry includes timestamps (started, last_heartbeat, duration_seconds).
    """
    result: dict[str, Any] = {"dashboard": None, "session": None, "agents": []}

    loki_dir = _get_loki_dir()
    now_iso = datetime.now(timezone.utc).isoformat()

    # Dashboard PID
    dpid_file = loki_dir / "dashboard" / "dashboard.pid"
    if dpid_file.exists():
        try:
            dpid = int(dpid_file.read_text().strip())
            state_info = _resolve_process_state(dpid, last_status="running")
            result["dashboard"] = {"pid": dpid, **state_info}
        except (ValueError, OSError):
            pass

    # Session PID
    spid_file = loki_dir / "loki.pid"
    if spid_file.exists():
        try:
            spid = int(spid_file.read_text().strip())
            state_info = _resolve_process_state(spid, last_status="running")
            result["session"] = {"pid": spid, **state_info}
        except (ValueError, OSError):
            pass

    # Read dashboard-state.json for heartbeat timestamp
    state_file = loki_dir / "dashboard-state.json"
    state_heartbeat = ""
    if state_file.exists():
        try:
            st = os.stat(state_file)
            state_heartbeat = datetime.fromtimestamp(
                st.st_mtime, tz=timezone.utc
            ).isoformat()
        except OSError:
            pass

    # Agent PIDs
    agents_file = loki_dir / "state" / "agents.json"
    if agents_file.exists():
        try:
            agents = json.loads(agents_file.read_text())
            for agent in agents:
                pid = agent.get("pid")
                pid_int = int(pid) if pid else None
                agent_status = agent.get("status", "")
                agent_started = agent.get("started", "")
                agent_heartbeat = agent.get("heartbeat", state_heartbeat)
                state_info = _resolve_process_state(
                    pid_int,
                    last_status=agent_status,
                    started=agent_started,
                    heartbeat=agent_heartbeat,
                )
                result["agents"].append({
                    "id": agent.get("id", ""),
                    "name": agent.get("name", ""),
                    "pid": pid,
                    **state_info,
                })
        except Exception:
            pass

    # PID registry (central process supervisor)
    pids_dir = loki_dir / "pids"
    registered: list[dict[str, Any]] = []
    if pids_dir.exists():
        for entry_file in sorted(pids_dir.glob("*.json")):
            try:
                pid_str = entry_file.stem
                pid = int(pid_str)
                entry = json.loads(entry_file.read_text())
                entry_started = entry.get("started", "")
                entry_heartbeat = entry.get("heartbeat", "")
                # Use file mtime as heartbeat fallback
                if not entry_heartbeat:
                    try:
                        st = os.stat(entry_file)
                        entry_heartbeat = datetime.fromtimestamp(
                            st.st_mtime, tz=timezone.utc
                        ).isoformat()
                    except OSError:
                        pass
                entry_status = entry.get("status", "running")
                state_info = _resolve_process_state(
                    pid,
                    last_status=entry_status,
                    started=entry_started,
                    heartbeat=entry_heartbeat,
                )
                registered.append({
                    "pid": pid,
                    "label": entry.get("label", "unknown"),
                    "ppid": entry.get("ppid"),
                    **state_info,
                })
            except (ValueError, json.JSONDecodeError, OSError):
                continue
    result["registered_processes"] = registered

    watchdog_enabled = os.environ.get("LOKI_WATCHDOG", "false").lower() == "true"
    result["watchdog_enabled"] = watchdog_enabled
    result["checked_at"] = now_iso

    return result


# =============================================================================
# Prometheus / OpenMetrics Endpoint
# =============================================================================


def _build_metrics_text() -> str:
    """Build Prometheus/OpenMetrics format metrics text from .loki/ flat files."""
    lines = []  # type: list[str]  -- comment-style for Python 3.8
    loki_dir = _get_loki_dir()

    # Validate LOKI_DIR exists before attempting to read metrics
    if not loki_dir.is_dir():
        return "# loki_up 0\n"

    # -- Read dashboard-state.json (primary data source) ----------------------
    state: dict = {}
    state_file = loki_dir / "dashboard-state.json"
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
        except (json.JSONDecodeError, OSError):
            pass

    # 1. loki_session_status (gauge) ------------------------------------------
    mode = state.get("mode", "")
    status_val = 0  # stopped
    if mode == "paused":
        status_val = 2
    elif mode in ("autonomous", "running"):
        status_val = 1
    else:
        # Also check PID file
        pid_file = loki_dir / "loki.pid"
        if pid_file.exists():
            try:
                pid = int(pid_file.read_text().strip())
                os.kill(pid, 0)
                status_val = 1
            except (ValueError, OSError, ProcessLookupError):
                pass

    lines.append("# HELP loki_session_status Current session status (0=stopped, 1=running, 2=paused)")
    lines.append("# TYPE loki_session_status gauge")
    lines.append(f"loki_session_status {status_val}")
    lines.append("")

    # 2. loki_iteration_current (gauge) ---------------------------------------
    iteration = state.get("iteration", 0)
    lines.append("# HELP loki_iteration_current Current iteration number")
    lines.append("# TYPE loki_iteration_current gauge")
    lines.append(f"loki_iteration_current {iteration}")
    lines.append("")

    # 3. loki_iteration_max (gauge) -------------------------------------------
    max_iterations = _safe_int_env("LOKI_MAX_ITERATIONS", 1000)
    lines.append("# HELP loki_iteration_max Maximum configured iterations")
    lines.append("# TYPE loki_iteration_max gauge")
    lines.append(f"loki_iteration_max {max_iterations}")
    lines.append("")

    # 4. loki_tasks_total (gauge, label: status) ------------------------------
    tasks = state.get("tasks", {})
    pending_count = len(tasks.get("pending", []))
    in_progress_count = len(tasks.get("inProgress", []))
    completed_count = len(tasks.get("completed", []))
    failed_count = len(tasks.get("failed", []))

    lines.append("# HELP loki_tasks_total Number of tasks by status")
    lines.append("# TYPE loki_tasks_total gauge")
    lines.append(f'loki_tasks_total{{status="pending"}} {pending_count}')
    lines.append(f'loki_tasks_total{{status="in_progress"}} {in_progress_count}')
    lines.append(f'loki_tasks_total{{status="completed"}} {completed_count}')
    lines.append(f'loki_tasks_total{{status="failed"}} {failed_count}')
    lines.append("")

    # 5. loki_agents_active (gauge) -------------------------------------------
    # 6. loki_agents_total (counter) ------------------------------------------
    agents_active = 0
    agents_total = 0
    agents_file = loki_dir / "state" / "agents.json"
    if agents_file.exists():
        try:
            agents_data = json.loads(agents_file.read_text())
            if isinstance(agents_data, list):
                agents_total = len(agents_data)
                agents_active = sum(
                    1 for a in agents_data
                    if isinstance(a, dict) and a.get("status") == "active"
                )
        except (json.JSONDecodeError, OSError):
            pass

    # Fallback to dashboard-state.json agents
    if agents_total == 0:
        state_agents = state.get("agents", [])
        if isinstance(state_agents, list):
            agents_total = len(state_agents)
            agents_active = sum(
                1 for a in state_agents
                if isinstance(a, dict) and a.get("status") == "active"
            )

    lines.append("# HELP loki_agents_active Number of currently active agents")
    lines.append("# TYPE loki_agents_active gauge")
    lines.append(f"loki_agents_active {agents_active}")
    lines.append("")

    lines.append("# HELP loki_agents_total Total number of agents registered")
    lines.append("# TYPE loki_agents_total gauge")
    lines.append(f"loki_agents_total {agents_total}")
    lines.append("")

    # 7. loki_cost_usd (gauge) ------------------------------------------------
    estimated_cost = 0.0
    efficiency_dir = loki_dir / "metrics" / "efficiency"
    if efficiency_dir.exists():
        try:
            for eff_file in efficiency_dir.glob("*.json"):
                try:
                    data = json.loads(eff_file.read_text())
                    # Skip non-object (corrupt/truncated) efficiency files so a
                    # bad file does not 500 the Prometheus scrape.
                    if not isinstance(data, dict):
                        continue
                    cost = data.get("cost_usd")
                    if cost is not None:
                        estimated_cost += float(cost)
                    else:
                        inp = data.get("input_tokens", 0)
                        out = data.get("output_tokens", 0)
                        estimated_cost += _calculate_model_cost(
                            data.get("model", "sonnet").lower(), inp, out
                        )
                except (json.JSONDecodeError, KeyError, TypeError, AttributeError):
                    pass
        except OSError:
            pass

    lines.append("# HELP loki_cost_usd Estimated total cost in USD")
    lines.append("# TYPE loki_cost_usd gauge")
    lines.append(f"loki_cost_usd {round(estimated_cost, 6)}")
    lines.append("")

    # 8. loki_events_total (counter) ------------------------------------------
    events_count = 0
    events_file = loki_dir / "events.jsonl"
    if events_file.exists():
        try:
            content = events_file.read_text()
            events_count = sum(1 for line in content.strip().split("\n") if line.strip())
        except OSError:
            pass

    lines.append("# HELP loki_events_total Total number of events recorded")
    lines.append("# TYPE loki_events_total counter")
    lines.append(f"loki_events_total {events_count}")
    lines.append("")

    # 9. loki_uptime_seconds (gauge) ------------------------------------------
    uptime_seconds = 0.0
    started_at = state.get("startedAt", "")
    if started_at:
        try:
            start_dt = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
            uptime_seconds = (datetime.now(timezone.utc) - start_dt).total_seconds()
            if uptime_seconds < 0:
                uptime_seconds = 0.0
        except (ValueError, TypeError):
            pass

    lines.append("# HELP loki_uptime_seconds Seconds since session started")
    lines.append("# TYPE loki_uptime_seconds gauge")
    lines.append(f"loki_uptime_seconds {round(uptime_seconds, 1)}")
    lines.append("")

    return "\n".join(lines) + "\n"


@app.get("/metrics", response_class=PlainTextResponse)
async def prometheus_metrics():
    """Prometheus/OpenMetrics compatible metrics endpoint."""
    return _build_metrics_text()


# =============================================================================
# PRD Checklist Endpoints (v5.44.0)
# =============================================================================

@app.get("/api/checklist", dependencies=[Depends(auth.require_scope("read"))])
async def get_checklist():
    """Get full PRD checklist with verification status."""
    loki_dir = _get_loki_dir()
    checklist_file = loki_dir / "checklist" / "checklist.json"
    if not checklist_file.exists():
        return {"status": "not_initialized", "categories": [], "summary": {"total": 0, "verified": 0, "failing": 0, "pending": 0}}
    try:
        return json.loads(checklist_file.read_text())
    except (json.JSONDecodeError, OSError):
        return {"status": "error", "categories": [], "summary": {"total": 0, "verified": 0, "failing": 0, "pending": 0}}


@app.get("/api/usage", dependencies=[Depends(auth.require_scope("read"))])
async def get_usage_doc():
    """v7.7.1 F-1 follow-up: return the auto-generated USAGE.md from the
    project root so Dashboard + Lab can surface "how to run / test the app".

    Returns {exists: bool, content: str|None, path: str, size: int, mtime: float}.
    Path-traversal hardened: resolves to PROJECT_ROOT/USAGE.md verbatim, no
    user-controlled path component. Reads up to 256 KiB; truncates with a
    `truncated: true` flag if larger.
    """
    loki_dir = _get_loki_dir()
    project_root = loki_dir.parent
    usage_path = project_root / "USAGE.md"
    out = {
        "exists": False,
        "content": None,
        "path": str(usage_path),
        "size": 0,
        "mtime": 0.0,
        "truncated": False,
    }
    if not usage_path.is_file():
        return out
    try:
        st = usage_path.stat()
        out["exists"] = True
        out["size"] = st.st_size
        out["mtime"] = st.st_mtime
        MAX_BYTES = 256 * 1024  # 256 KiB cap
        if st.st_size > MAX_BYTES:
            out["truncated"] = True
            with usage_path.open("r", encoding="utf-8", errors="replace") as f:
                out["content"] = f.read(MAX_BYTES) + "\n\n... [truncated]"
        else:
            out["content"] = usage_path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        out["error"] = str(e)
    return out


@app.get("/api/checklist/summary", dependencies=[Depends(auth.require_scope("read"))])
async def get_checklist_summary():
    """Get checklist verification summary."""
    loki_dir = _get_loki_dir()
    results_file = loki_dir / "checklist" / "verification-results.json"
    if not results_file.exists():
        return {"status": "not_initialized", "summary": {"total": 0, "verified": 0, "failing": 0, "pending": 0}}
    try:
        return json.loads(results_file.read_text())
    except (json.JSONDecodeError, OSError):
        return {"status": "error", "summary": {"total": 0, "verified": 0, "failing": 0, "pending": 0}}


@app.get("/api/prd-observations", dependencies=[Depends(auth.require_scope("read"))])
async def get_prd_observations():
    """Get PRD quality analysis observations."""
    loki_dir = _get_loki_dir()
    obs_file = loki_dir / "prd-observations.md"
    if not obs_file.exists():
        return PlainTextResponse("No PRD observations available yet.", status_code=200)
    try:
        content = obs_file.read_text()
        return PlainTextResponse(content, status_code=200)
    except OSError:
        return PlainTextResponse("Error reading PRD observations.", status_code=500)


# =============================================================================
# Checklist Waiver Management Endpoints (Phase 4)
# =============================================================================

@app.get("/api/checklist/waivers", dependencies=[Depends(auth.require_scope("read"))])
async def get_checklist_waivers():
    """Get all checklist waivers."""
    waivers_file = _get_loki_dir() / "checklist" / "waivers.json"
    if not waivers_file.exists():
        return {"waivers": []}
    try:
        return json.loads(waivers_file.read_text())
    except (json.JSONDecodeError, IOError):
        return {"waivers": [], "error": "Failed to read waivers file"}


@app.post("/api/checklist/waivers", dependencies=[Depends(auth.require_scope("control"))])
async def add_checklist_waiver(request: Request):
    """Add a waiver for a checklist item."""
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"error": "Invalid JSON"})

    item_id = body.get("item_id")
    reason = body.get("reason")
    if not item_id or not reason:
        return JSONResponse(status_code=400, content={"error": "item_id and reason required"})

    if not isinstance(reason, str) or len(reason) > 1024:
        return JSONResponse(status_code=400, content={"error": "reason must be a string (max 1024 chars)"})

    # Sanitize item_id: non-empty, max 256 chars, no path traversal
    if not isinstance(item_id, str) or len(item_id) > 256 or ".." in item_id or "/" in item_id or "\\" in item_id:
        return JSONResponse(status_code=400, content={"error": "Invalid item_id: must be 1-256 chars, no path traversal characters"})

    waivers_file = _get_loki_dir() / "checklist" / "waivers.json"

    # Load existing
    waivers = {"waivers": []}
    if waivers_file.exists():
        try:
            waivers = json.loads(waivers_file.read_text())
        except (json.JSONDecodeError, IOError):
            pass

    # Check duplicate
    for w in waivers.get("waivers", []):
        if w.get("item_id") == item_id and w.get("active", True):
            return JSONResponse(status_code=409, content={"status": "already_exists", "item_id": item_id})

    # Add waiver
    waiver = {
        "item_id": item_id,
        "reason": reason,
        "waived_by": body.get("waived_by", "dashboard"),
        "waived_at": datetime.now(timezone.utc).isoformat(),
        "active": True
    }
    waivers.setdefault("waivers", []).append(waiver)

    # Ensure directory exists
    waivers_file.parent.mkdir(parents=True, exist_ok=True)

    # Atomic write
    tmp_file = waivers_file.with_suffix(".tmp")
    tmp_file.write_text(json.dumps(waivers, indent=2))
    tmp_file.replace(waivers_file)

    return {"status": "added", "waiver": waiver}


@app.delete("/api/checklist/waivers/{item_id}", dependencies=[Depends(auth.require_scope("control"))])
async def remove_checklist_waiver(item_id: str):
    """Deactivate a waiver for a checklist item."""
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    # Sanitize item_id: non-empty, max 256 chars, no path traversal
    if not item_id or len(item_id) > 256 or ".." in item_id or "/" in item_id or "\\" in item_id:
        raise HTTPException(status_code=400, detail="Invalid item_id: must be 1-256 chars, no path traversal characters")

    waivers_file = _get_loki_dir() / "checklist" / "waivers.json"
    if not waivers_file.exists():
        return JSONResponse(status_code=404, content={"error": "No waivers file"})

    try:
        waivers = json.loads(waivers_file.read_text())
    except (json.JSONDecodeError, IOError):
        return JSONResponse(status_code=500, content={"error": "Failed to read waivers"})

    found = False
    for w in waivers.get("waivers", []):
        if w.get("item_id") == item_id and w.get("active", True):
            w["active"] = False
            found = True

    if not found:
        return JSONResponse(status_code=404, content={"error": f"No active waiver for {item_id}"})

    # Atomic write
    tmp_file = waivers_file.with_suffix(".tmp")
    tmp_file.write_text(json.dumps(waivers, indent=2))
    tmp_file.replace(waivers_file)

    return {"status": "removed", "item_id": item_id}


# =============================================================================
# Council Hard Gate Endpoint (Phase 4)
# =============================================================================

_DEFAULT_QUALITY_GATES = [
    {"name": "Static Analysis", "description": "CodeQL, ESLint/Pylint, type-checker findings on the diff", "status": "pending"},
    {"name": "Test Suite", "description": "Project test runner pass/fail (red blocks)", "status": "pending"},
    {"name": "Blind Code Review", "description": "3-reviewer blind review; Critical/High = BLOCK; Medium/Low advisory", "status": "pending"},
    {"name": "Anti-Sycophancy", "description": "Devil's Advocate re-review on unanimous PASS", "status": "pending"},
    {"name": "Mock Integrity", "description": "Tautological-assertion and mock-ratio detection", "status": "pending"},
    {"name": "Test Mutation", "description": "Assertion-churn (test-fitting) detection", "status": "pending"},
    {"name": "Documentation Coverage", "description": "README presence, docs freshness, API docs for exported symbols", "status": "pending"},
    {"name": "Magic Modules Debate", "description": "Spec-vs-implementation debate on generated modules", "status": "pending"},
]


@app.get("/api/council/gate", dependencies=[Depends(auth.require_scope("read"))])
async def get_council_gate():
    """Get council hard gate status.

    Surfaces TWO independent hard gates, both written to .loki/council/:
      - gate-block.json:     the legacy quality hard gate
      - evidence-block.json: the verified-completion evidence gate (v7.19.1),
                             which blocks STOP unless there is real evidence
                             (nonzero diff vs run-start SHA AND green tests).
    Either being present means completion is blocked. The response keeps the
    legacy top-level shape (blocked/gates) for backward compatibility and adds
    an `evidence` key so the UI can show WHY a verified-completion block fired.
    """
    council_dir = _get_loki_dir() / "council"
    gate_file = council_dir / "gate-block.json"
    evidence_file = council_dir / "evidence-block.json"

    # Legacy quality gate (backward-compatible top level).
    if gate_file.exists():
        try:
            data = json.loads(gate_file.read_text())
            if "gates" not in data:
                data["gates"] = _DEFAULT_QUALITY_GATES
        except (json.JSONDecodeError, IOError):
            data = {"blocked": False, "gates": _DEFAULT_QUALITY_GATES, "error": "Failed to read gate file"}
    else:
        data = {"blocked": False, "gates": _DEFAULT_QUALITY_GATES}

    # Verified-completion evidence gate (additive).
    if evidence_file.exists():
        try:
            evidence = json.loads(evidence_file.read_text())
        except (json.JSONDecodeError, IOError):
            evidence = {"blocked": True, "error": "Failed to read evidence-block file"}
        data["evidence"] = evidence
        # If either gate blocks, the overall status is blocked.
        if evidence.get("blocked"):
            data["blocked"] = True
    else:
        data["evidence"] = {"blocked": False}

    return data


# =============================================================================
# App Runner Endpoints (v5.45.0)
# =============================================================================

# Health checkpoints are written once per autonomous iteration (the app-runner
# watchdog fires from the run.sh iteration loop, not a fixed timer), so a single
# long healthy iteration can legitimately leave last_health.checked_at minutes
# old. The staleness threshold below is therefore deliberately generous and is
# used ONLY when we cannot verify liveness from a real OS pid (e.g. docker
# compose, whose main_pid is a short-lived `up -d` subshell). When a real pid is
# present, pid liveness -- not the timestamp -- is the authoritative signal, so a
# live run is never reported as dead just because a health beat was missed.
_APP_RUNNER_STALE_HEALTH_SECONDS = 600


def _pid_is_alive(pid):
    """Return True if pid refers to a live process, False if it is gone.

    Uses signal 0 (no signal sent, just an existence/permission probe). Guards
    against the pid<=0 footgun: kill(0, 0) targets the caller's own process
    group and would falsely report "alive". A PermissionError means the process
    exists but is owned by another user (still alive). Any other error is
    treated as indeterminate (None) so the caller can fall back safely.
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None


# Margin (seconds) added to the recorded reference time before a live pid is
# judged to be a recycled (different) process. Must comfortably exceed clock
# skew plus the launch-to-first-state-write gap so a genuine app is never
# downgraded. A PID recycled after a crash typically belongs to a process that
# started minutes or hours later, so a generous margin still catches recycles
# while strongly biasing against the far worse false-positive of killing a live
# app's status. See _reconcile_app_runner_liveness.
_APP_RUNNER_PID_RECYCLE_MARGIN_SECONDS = 120


def _pid_start_time(pid):
    """Best-effort wall-clock start time of pid, as epoch seconds, or None.

    Reads `ps -o lstart= -p <pid>`, which is available on both macOS and Linux
    and prints the process start time in local time (e.g. "Sun Jun 14 18:39:15
    2026"). The string is locale-dependent (%a/%b), so any parse failure, empty
    output, or missing process returns None and the caller degrades gracefully
    to its prior behavior. The returned epoch is timezone-correct because the
    naive local timestamp is interpreted in the system's local zone before
    conversion (ps reports local time; never mix it with a UTC value directly).
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    try:
        out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    raw = (out.stdout or "").strip()
    if not raw:
        return None
    try:
        # lstart is local time without a zone; parse naive then attach the
        # local zone so .timestamp() yields a correct epoch regardless of TZ.
        naive = datetime.strptime(raw, "%a %b %d %H:%M:%S %Y")
        local = naive.replace(tzinfo=datetime.now().astimezone().tzinfo)
        return local.timestamp()
    except (ValueError, OverflowError, OSError):
        return None


def _state_reference_epoch(state):
    """Epoch seconds for state.json's recorded reference time, or None.

    Uses `started_at` (rewritten by the app-runner on every state write; it is
    the last-state-write time, not pure launch time). For a genuine process the
    real start time is always <= this value, so it is a safe upper bound to
    compare a live pid's start time against. The value is UTC (Z-suffixed).
    """
    if not isinstance(state, dict):
        return None
    started_at = state.get("started_at")
    if not started_at:
        return None
    try:
        ts = datetime.fromisoformat(str(started_at).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return ts.timestamp()


def _pid_is_recycled(state):
    """True if the recorded main_pid is alive but is a DIFFERENT process now.

    After the recorded app dies, the OS can recycle its numeric pid for an
    unrelated process; os.kill(pid, 0) then reports the stale pid "alive"
    forever and a dead run is never reconciled. We detect this by comparing the
    live pid's real start time against the recorded reference time: a genuine
    process started at or before the reference, so a live pid whose start time
    is comfortably AFTER the reference cannot be the original.

    Returns True only with positive evidence of recycling. Any missing data
    (no recorded reference, start time unavailable) returns False so the caller
    keeps its prior behavior -- best-effort, biased against false positives.
    """
    reference = _state_reference_epoch(state)
    if reference is None:
        return False
    pid_start = _pid_start_time(state.get("main_pid"))
    if pid_start is None:
        return False
    return pid_start > reference + _APP_RUNNER_PID_RECYCLE_MARGIN_SECONDS


def _health_checked_age_seconds(state):
    """Seconds since last_health.checked_at, or None if unparseable/absent."""
    health = state.get("last_health")
    if not isinstance(health, dict):
        return None
    checked_at = health.get("checked_at")
    if not checked_at:
        return None
    try:
        ts = datetime.fromisoformat(str(checked_at).replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - ts).total_seconds()


def _reconcile_app_runner_liveness(state):
    """Correct a frozen state.json so a dead run is not reported as running.

    state.json is written by the app-runner and is not updated once the app or
    the orchestrator dies, so a crashed run leaves status frozen at "running".
    Here we cross-check the recorded main_pid against the real OS before
    returning, and only ever downgrade -- never upgrade -- the status:
      - recorded running/starting + pid genuinely gone   -> "stopped"
      - recorded running/starting + pid "alive" but its real start time is
        after the recorded reference (the OS recycled a dead run's pid for an
        unrelated process)                                -> "stopped"
      - recorded running/starting + pid not verifiable    +
        last_health.checked_at older than the threshold   -> "stale"
    Any failure falls back to the raw recorded status (fail open to the writer's
    own claim rather than fabricating a state). Returns the (possibly modified)
    state dict.
    """
    if not isinstance(state, dict):
        return state
    status = state.get("status")
    if status not in ("running", "starting"):
        return state
    try:
        alive = _pid_is_alive(state.get("main_pid"))
        if alive is False:
            state["status"] = "stopped"
            state["liveness"] = "pid_gone"
            return state
        if alive is True:
            # The numeric pid exists, but os.kill(pid, 0) cannot tell whether it
            # is still the SAME process. After a dead run the OS can recycle the
            # pid; detect that via the process start time so a recycled pid is
            # treated as gone rather than reported "running" forever.
            if _pid_is_recycled(state):
                state["status"] = "stopped"
                state["liveness"] = "pid_recycled"
            return state
        if alive is None:
            # Cannot verify via pid (e.g. compose subshell pid). Fall back to
            # the health-beat freshness with a generous threshold.
            age = _health_checked_age_seconds(state)
            if age is not None and age > _APP_RUNNER_STALE_HEALTH_SECONDS:
                state["status"] = "stale"
                state["liveness"] = "health_stale"
    except Exception:
        # Never let a liveness probe break the status endpoint.
        return state
    return state


# Per-probe TCP connect timeout (seconds) for the single-process port probe.
# Kept short so a stopped/firewalled port fails fast and the status endpoint
# stays responsive for the dashboard's 3-5s pollers.
_APP_RUNNER_PORT_PROBE_TIMEOUT = 1.0


def _port_is_serving(port):
    """True only if a TCP connection to 127.0.0.1:<port> genuinely succeeds.

    Honest by construction: this proves *something* is accepting connections on
    the recorded port right now, never fabricates a result. Any failure (refused,
    timeout, bad port, OS error) returns False so the caller degrades to an
    honest non-running state. Synchronous; the caller offloads it to a worker
    thread so the event loop is never blocked by the connect.
    """
    try:
        port = int(port)
    except (TypeError, ValueError):
        return False
    if port <= 0 or port > 65535:
        return False
    import socket
    for host in ("127.0.0.1", "::1"):
        sock = None
        try:
            family = socket.AF_INET6 if ":" in host else socket.AF_INET
            sock = socket.socket(family, socket.SOCK_STREAM)
            sock.settimeout(_APP_RUNNER_PORT_PROBE_TIMEOUT)
            if sock.connect_ex((host, port)) == 0:
                return True
        except OSError:
            continue
        finally:
            if sock is not None:
                try:
                    sock.close()
                except OSError:
                    pass
    return False


def _dashboard_self_port():
    """The TCP port this dashboard process itself is bound to, or None.

    The user's app can never listen on the port the dashboard already occupies,
    so this is used to exclude a self-hit from the single-process probe (a stale
    recorded port that happens to equal the dashboard's port would otherwise
    probe-succeed against the dashboard and be misreported as the app running).
    Reads LOKI_DASHBOARD_PORT (the same env run_server binds), defaulting to the
    well-known 57374. Returns an int or None.
    """
    try:
        return int(os.environ.get("LOKI_DASHBOARD_PORT", "57374"))
    except (TypeError, ValueError):
        return 57374


def _recorded_app_port(state):
    """Best-effort recorded port for the single-process app, or None.

    Reads the port the app-runner/CLI already recorded for THIS project, never a
    guessed value: first state.json's own `port`, then the app-runner
    detection.json the engine writes (`.loki/app-runner/detection.json`). Returns
    an int in the valid range or None. Pairing the probe to a *recorded* port is
    what keeps the result honest -- we never sweep arbitrary common ports.

    Honesty guards:
      - A docker-compose detection.json is ignored here; a compose stack is the
        compose-discovery path's domain (which verifies the container belongs to
        the project), so feeding its port into the single-process probe would
        risk a false positive against an unrelated local service.
      - The dashboard's own port is never returned, since the user's app cannot
        bind it and a stale recorded value equal to it would self-hit the probe.
    """
    self_port = _dashboard_self_port()

    def _ok(p):
        try:
            p = int(p)
        except (TypeError, ValueError):
            return None
        if not (0 < p <= 65535):
            return None
        if self_port is not None and p == self_port:
            return None
        return p

    if isinstance(state, dict):
        p = _ok(state.get("port"))
        if p is not None:
            return p
    try:
        det_file = _get_loki_dir() / "app-runner" / "detection.json"
        if det_file.is_file():
            det = json.loads(det_file.read_text())
            if isinstance(det, dict) and not det.get("is_docker"):
                p = _ok(det.get("port"))
                if p is not None:
                    return p
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        pass
    return None


def _discover_single_process_app_runner_state(state):
    """Detect a genuinely-running single-process app via a recorded-port probe.

    A SKILL/CLI-built project (e.g. one started with `npm run dev` outside
    app-runner.sh, or whose orchestrator has since exited) leaves a state.json
    with status "stopped"/"stale" and main_pid 0, even while the app itself is
    still serving. The dashboard would then report "not running" for a live app.

    Resolution (all probe-verified, never fabricated):
      - Find the RECORDED port (state.json.port or non-docker detection.json) --
        never a guessed port, and never the dashboard's own port.
      - Probe 127.0.0.1:<port>. Only if the connection genuinely succeeds do we
        synthesize a "running" state using the recorded url/port.
      - Otherwise (no recorded port, or recorded port not reachable) return None;
        the caller keeps the honest reconciled state, which already carries
        positive evidence (the writer's settled "stopped", or a pid_gone /
        recycled / health_stale downgrade). "Unknown" would be less honest than
        that evidence, so we never override it here.

    Synchronous and self-contained; the caller offloads it onto a worker thread.
    Never raises.
    """
    try:
        port = _recorded_app_port(state)
        if not port:
            return None
        if not _port_is_serving(port):
            return None
        url = ""
        if isinstance(state, dict):
            url = state.get("url") or ""
        if not url:
            url = "http://localhost:{}".format(port)
        return {
            "status": "running",
            "url": url,
            "port": int(port),
            "method": (state.get("method") if isinstance(state, dict) else "") or "",
            "source": "probe",
            "externally_managed": True,
            "last_health": {"ok": True},
        }
    except Exception:
        # Fail open: never let the probe break the status endpoint.
        return None


# =============================================================================
# Docker-compose app-runner discovery
#
# When the autonomous agent brings up a docker-compose stack itself (rather than
# via autonomy/app-runner.sh), no .loki/app-runner/state.json is written, so the
# status endpoint reports "not_initialized" / "stopped" even though the app is
# genuinely running. The discovery helper below inspects the live compose stack
# for the project directory and synthesizes an equivalent status so the dashboard
# App Runner panel surfaces the running app and its URL.
#
# Safety contract (all mandatory):
#   - Every docker subprocess.run has an explicit timeout; total work is bounded.
#   - On ANY error (TimeoutExpired/OSError/SubprocessError/parse failure) the
#     helper returns None and the caller falls back to its prior behavior. The
#     handler never raises and never blocks the event loop (it is offloaded via
#     asyncio.to_thread / run_in_threadpool).
#   - A short TTL cache prevents the 3s/5s dashboard pollers from spawning
#     repeated docker invocations.
#   - A URL is never fabricated for a non-running or non-published container.
# =============================================================================

# Common host ports a web service typically publishes, in precedence order.
# Mirrors autonomy/app-runner.sh _identify_compose_web_service (COMMON list).
_COMPOSE_COMMON_WEB_PORTS = ["3000", "8000", "8080", "5000", "4200", "5173", "80"]

# Per-docker-call timeout (seconds). Several calls run in sequence; keep each
# tight so total discovery stays bounded well under the poller interval.
_COMPOSE_DISCOVERY_CMD_TIMEOUT = 3

# TTL (seconds) for the discovery result cache, keyed by resolved project dir.
# The dashboard polls every 3-5s; a 2.5s TTL collapses a burst of concurrent
# pollers onto a single docker probe without making the status feel stale.
_COMPOSE_DISCOVERY_TTL_SECONDS = 2.5

# Cache: {project_dir_str: (expiry_epoch, result_or_None)}. Module-level so it
# survives across requests. Guarded by a lock because to_thread runs the sync
# helper on worker threads that can overlap.
_compose_discovery_cache: dict[str, tuple[float, Optional[dict]]] = {}
_compose_discovery_lock = threading.Lock()


def _parse_docker_json(raw):
    """Parse docker --format json output into a list of dicts, defensively.

    Docker emits either a single JSON array or newline-delimited JSON (one
    object per line), and the shape has varied across docker/compose versions.
    Try a whole-blob parse first; if that fails or does not yield a list, fall
    back to parsing each non-empty line individually. Returns a list of dicts
    (possibly empty). Never raises.
    """
    raw = (raw or "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [x for x in parsed if isinstance(x, dict)]
        if isinstance(parsed, dict):
            return [parsed]
    except (ValueError, TypeError):
        pass
    items = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict):
            items.append(obj)
    return items


def _run_docker_json(args, cwd=None):
    """Run a docker command and return parsed JSON rows, or None on any failure.

    args is the argument list AFTER `docker` (e.g. ["compose", "ps", ...]). Uses
    an explicit per-call timeout and a list argv (no shell). A non-zero exit,
    timeout, missing docker binary, or unparseable output all yield None so the
    caller fails open.
    """
    try:
        proc = subprocess.run(
            ["docker", *args],
            capture_output=True,
            text=True,
            timeout=_COMPOSE_DISCOVERY_CMD_TIMEOUT,
            cwd=str(cwd) if cwd else None,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    return _parse_docker_json(proc.stdout)


def _compose_published_ports(container):
    """Host ports actually published by a running compose container (compose ps).

    `docker compose ps --format json` exposes published ports under the
    "Publishers" list, each like {"PublishedPort": 3000, "TargetPort": 3000,
    "Protocol": "tcp", "URL": "0.0.0.0"}. A PublishedPort of 0 means the port is
    exposed but not published to the host, so it is filtered out. Returns a list
    of host port strings, preserving order. Never raises.
    """
    out = []
    pubs = container.get("Publishers")
    if not isinstance(pubs, list):
        return out
    for p in pubs:
        if not isinstance(p, dict):
            continue
        port = p.get("PublishedPort")
        try:
            port = int(port)
        except (TypeError, ValueError):
            continue
        if port > 0:
            out.append(str(port))
    return out


def _compose_service_labels(svc):
    """Normalize a compose-config service's labels into a dict. Never raises."""
    labels = svc.get("labels") or {}
    if isinstance(labels, dict):
        return labels
    if isinstance(labels, list):
        normalized = {}
        for item in labels:
            if isinstance(item, str) and "=" in item:
                k, v = item.split("=", 1)
                normalized[k] = v
        return normalized
    return {}


def _pick_web_port(ports):
    """From a service's published host ports, pick the one most likely to be HTTP.

    A single service can publish several host ports (e.g. a Spring Boot app that
    exposes 8080 for HTTP and 8081 for the actuator/management endpoint, or a
    stack that maps both a debug and a web port). Blindly taking ports[0] is
    order-dependent and can surface the management/debug port instead of the
    reachable web URL. Prefer the first port that appears in
    _COMPOSE_COMMON_WEB_PORTS precedence order (so 8080 wins over a non-common
    8081), and only fall back to ports[0] when none is a recognized web port.

    This is why Spring Boot's 8080-over-8081 case resolves correctly without
    parsing application.properties / server.port: the runtime published host
    port (from compose ps Publishers) is matched against the known web-port
    family. Returns a port string, or None if ports is empty. Never raises.
    """
    if not ports:
        return None
    for cp in _COMPOSE_COMMON_WEB_PORTS:
        if cp in ports:
            return cp
    return ports[0]


def _identify_compose_web_service(config_services, running_by_service):
    """Pick the primary web service and its published host port.

    Mirrors the precedence in autonomy/app-runner.sh:431-481:
      (1) service labelled loki.primary=true
      (2) service named web/app
      (3) service publishing a common web port (3000/8000/8080/5000/4200/5173/80)
      (4) first service with any published port
    Declared names/labels come from `docker compose config`; the actual runtime
    published port comes from the matching RUNNING container (compose ps), since
    only running, published containers can yield a real URL. Returns
    (service_name, port_str) or (None, None). Never raises.

    When a chosen service publishes MULTIPLE host ports, _pick_web_port selects
    the HTTP one (common web port over a management/debug port) rather than the
    arbitrary first-listed port -- so a Spring Boot service exposing 8080+8081
    surfaces 8080, and a stack whose web service is not first in the compose file
    is still resolved by name (rule 2) or by common-port match (rule 3).

    config_services: dict {service_name: service_config_dict} (may be empty).
    running_by_service: dict {service_name: [published_port_str, ...]} for
        currently-running containers with at least one published host port.
    """
    if not running_by_service:
        return (None, None)

    # (1) label loki.primary=true (declared in compose config)
    for name, svc in (config_services or {}).items():
        if not isinstance(svc, dict):
            continue
        labels = _compose_service_labels(svc)
        if str(labels.get("loki.primary", "")).lower() == "true":
            ports = running_by_service.get(name)
            picked = _pick_web_port(ports)
            if picked:
                return (name, picked)

    # (2) service named web/app
    for cand in ("web", "app"):
        ports = running_by_service.get(cand)
        picked = _pick_web_port(ports)
        if picked:
            return (cand, picked)

    # (3) service publishing a common web port. Iterate services in sorted order
    # so selection is deterministic when more than one service is a candidate.
    for cp in _COMPOSE_COMMON_WEB_PORTS:
        for name in sorted(running_by_service.keys()):
            if cp in running_by_service[name]:
                return (name, cp)

    # (4) first running service with any published port. Sort for determinism;
    # pick that service's HTTP-most port (not necessarily its first-listed one).
    for name in sorted(running_by_service.keys()):
        picked = _pick_web_port(running_by_service[name])
        if picked:
            return (name, picked)

    return (None, None)


def _container_health_state(container):
    """Classify a running compose container into 'running' | 'starting' | None.

    Reads the container State + Health fields from `docker compose ps`:
      - State exited/dead/paused/removing -> None (no live URL to surface)
      - State running + Health healthy or empty (no healthcheck) -> 'running'
      - State running + Health unhealthy/starting -> 'starting' (still surface
        the URL: e.g. a Next.js app whose home renders but whose '/' healthcheck
        fails is reachable and should show as starting, not hidden)
      - State created/restarting -> 'starting'
    Returns the status string or None. Never raises.
    """
    state = str(container.get("State", "")).lower()
    health = str(container.get("Health", "")).lower()
    if state in ("exited", "dead", "paused", "removing"):
        return None
    if state == "running":
        if health in ("", "healthy"):
            return "running"
        # unhealthy or starting healthcheck: reachable, treat as starting.
        return "starting"
    if state in ("created", "restarting"):
        return "starting"
    # Unknown/other states: do not fabricate a running URL.
    return None


def _discover_compose_app_runner_state():
    """Discover a running docker-compose stack for the active project, or None.

    Returns a synthesized app-runner state dict (source=="discovered") when the
    project directory hosts a compose file AND a primary web service is running
    with a published host port. Returns None in every other case (no compose
    file, docker absent, nothing running, no published web port, only
    dead/exited containers, or any error). Synchronous and self-contained; the
    caller offloads it onto a worker thread. Never raises.
    """
    try:
        project_dir = _get_loki_dir().parent.resolve()
    except Exception:
        return None
    cache_key = str(project_dir)

    now = time.monotonic()
    with _compose_discovery_lock:
        cached = _compose_discovery_cache.get(cache_key)
        if cached is not None and cached[0] > now:
            return cached[1]

    result = _discover_compose_app_runner_state_uncached(project_dir)

    with _compose_discovery_lock:
        _compose_discovery_cache[cache_key] = (
            time.monotonic() + _COMPOSE_DISCOVERY_TTL_SECONDS,
            result,
        )
    return result


def _discover_compose_app_runner_state_uncached(project_dir):
    """Uncached body of _discover_compose_app_runner_state. Never raises."""
    try:
        # Step A: a compose file must exist in the project dir, else this is a
        # single-process app and discovery does not apply.
        compose_names = (
            "docker-compose.yml", "docker-compose.yaml",
            "compose.yml", "compose.yaml",
        )
        if not any((project_dir / n).is_file() for n in compose_names):
            return None

        # Step C: running containers for THIS project's compose stack, with the
        # runtime published ports. Run from the project dir so compose resolves
        # the right project. (Step B project matching is implicitly handled by
        # running compose from project_dir; we keep ls/ps from this dir.)
        ps_rows = _run_docker_json(
            ["compose", "ps", "--format", "json"], cwd=project_dir
        )
        if ps_rows is None:
            # docker absent / timeout / error -> fail open.
            return None
        if not ps_rows:
            # No containers for this compose project (not up). Nothing to show.
            return None

        # Map running, published services to their host ports. Track health and
        # the raw container for the primary so we can classify it precisely.
        running_by_service = {}
        container_by_service = {}
        for c in ps_rows:
            service = c.get("Service") or c.get("Name")
            if not service:
                continue
            ports = _compose_published_ports(c)
            if ports:
                running_by_service.setdefault(service, [])
                for p in ports:
                    if p not in running_by_service[service]:
                        running_by_service[service].append(p)
                container_by_service.setdefault(service, c)
        if not running_by_service:
            # Stack is up but nothing publishes a host port: no surfaceable URL.
            return None

        # Step D: declared service config (names/labels) for precedence. Best
        # effort: if config is unavailable we still proceed with ps data alone.
        config_rows = _run_docker_json(
            ["compose", "config", "--format", "json"], cwd=project_dir
        )
        config_services = {}
        if config_rows:
            cfg = config_rows[0]
            svcs = cfg.get("services")
            if isinstance(svcs, dict):
                config_services = svcs

        primary_service, port = _identify_compose_web_service(
            config_services, running_by_service
        )
        if not primary_service or not port:
            return None

        # Step E health classification, from the primary's running container.
        primary_container = container_by_service.get(primary_service)
        if not isinstance(primary_container, dict):
            return None
        health_status = _container_health_state(primary_container)
        if health_status is None:
            # exited/dead/paused/unknown -> do not fabricate a URL.
            return None

        # Step B (best effort): record the compose project name for the panel.
        compose_project = (
            primary_container.get("Project")
            or "".join(ch for ch in project_dir.name.lower() if ch.isalnum())
        )

        health_text = str(primary_container.get("Health", "")).lower()
        health_ok = health_text in ("", "healthy")

        # Step F: synthesize the state dict using the SAME field names the UI and
        # app-runner.sh state.json use (status/url/port/method/last_health), plus
        # discovery-provenance fields the panel safely ignores.
        return {
            "status": health_status,
            "url": "http://localhost:{}".format(port),
            "port": int(port),
            "method": "docker compose (detected)",
            "primary_service": primary_service,
            "compose_project": compose_project,
            "source": "discovered",
            "externally_managed": True,
            "last_health": {"ok": health_ok},
        }
    except Exception:
        # Fail open on anything unexpected; never break the status endpoint.
        return None


@app.get("/api/app-runner/status", dependencies=[Depends(auth.require_scope("read"))])
async def get_app_runner_status():
    """Get app runner current status (with dead-run liveness reconciliation).

    Resolution order:
      1. state.json present AND reconciles to running/starting -> return it (an
         app-runner.sh-managed run is authoritative).
      2. state.json missing OR reconciles to stopped/stale -> attempt
         docker-compose discovery for stacks the autonomous agent launched
         itself; if a running stack is found, return the synthesized state
         (bypassing pid-based liveness reconciliation, which is meaningless for
         externally-launched containers).
      3. otherwise return the existing (possibly reconciled / not_initialized)
         result.
    Discovery runs on a worker thread so its bounded docker calls never block
    the event loop.
    """
    loki_dir = _get_loki_dir()
    state_file = loki_dir / "app-runner" / "state.json"

    if not state_file.exists():
        discovered = await asyncio.to_thread(_discover_compose_app_runner_state)
        if discovered is not None:
            return discovered
        # No state.json at all and no compose stack: there is no recorded port to
        # probe, so the single-process probe can only ever return an honest
        # "unknown" here. Keep returning not_initialized (the project has never
        # had an app-runner record) rather than overstating with "unknown".
        return {"status": "not_initialized"}

    try:
        state = json.loads(state_file.read_text())
    except (json.JSONDecodeError, OSError):
        return {"status": "error"}

    reconciled = _reconcile_app_runner_liveness(state)
    if isinstance(reconciled, dict) and reconciled.get("status") in ("running", "starting"):
        # An app-runner.sh-managed run that is still live is authoritative.
        return reconciled

    # State is missing-live (stopped/stale/other): the agent may have brought up
    # a compose stack outside app-runner.sh. Prefer a live discovered stack.
    discovered = await asyncio.to_thread(_discover_compose_app_runner_state)
    if discovered is not None:
        return discovered

    # Still nothing from compose: a SKILL/CLI-built project may be serving on its
    # recorded port even though no live app-runner.sh process owns it (main_pid 0
    # / orchestrator exited). Probe the RECORDED port and only report running when
    # the port genuinely answers; otherwise keep the honest reconciled state.
    probed = await asyncio.to_thread(_discover_single_process_app_runner_state, state)
    if isinstance(probed, dict) and probed.get("status") == "running":
        return probed
    return reconciled


def _get_log_redactor():
    """Lazily load autonomy/lib/proof_redact.redact_value.

    Lives under autonomy/lib (not on the dashboard import path), so import it
    by path with a graceful fallback. Returns a callable str -> str. On any
    import failure returns a redactor that withholds the line rather than
    leaking raw runtime output (which can contain secrets in stack traces).
    """
    cached = getattr(_get_log_redactor, "_cached", None)
    if cached is not None:
        return cached
    try:
        import importlib.util

        lib_path = _Path(__file__).resolve().parent.parent / "autonomy" / "lib" / "proof_redact.py"
        spec = importlib.util.spec_from_file_location("loki_proof_redact", str(lib_path))
        if spec is None or spec.loader is None:
            raise ImportError("proof_redact spec unavailable")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        try:
            mod.set_context(home=os.path.expanduser("~"), repo_root=str(_project_root()))
        except Exception:
            pass
        redactor = mod.redact_value
    except Exception:
        # Fail closed: withhold rather than leak raw log content.
        def redactor(_s):
            return "[log withheld: redactor unavailable]"
    _get_log_redactor._cached = redactor
    return redactor


@app.get("/api/app-runner/logs", dependencies=[Depends(auth.require_scope("read"))])
async def get_app_runner_logs(lines: int = Query(default=100, ge=1, le=1000)):
    """Get last N lines of app runner logs (redacted)."""
    loki_dir = _get_loki_dir()
    log_file = loki_dir / "app-runner" / "app.log"
    if not log_file.exists():
        return {"lines": []}
    try:
        redact = _get_log_redactor()
        # Reading + redacting the app log is blocking (the log can be large);
        # offload so the event loop (status + WS heartbeat) is not stalled.
        def _read_redacted(p=log_file, n=lines):
            return [redact(ln) for ln in _safe_read_text(p).splitlines()[-n:]]
        out_lines = await asyncio.to_thread(_read_redacted)
        return {"lines": out_lines, "redacted": True}
    except OSError:
        return {"lines": []}


@app.get("/api/app-runner/errors", dependencies=[Depends(auth.require_scope("read"))])
async def get_app_runner_errors(lines: int = Query(default=50, ge=1, le=500)):
    """Get the last N lines of app runner output, redacted, plus crash state.

    Powers the dashboard error banner. Reads .loki/app-runner/app.log (the same
    log the app writes) and the crash/status fields from state.json so the UI
    can decide whether to surface the banner without a second round-trip.
    The error banner is fed exclusively by this server-side endpoint: the
    running app is cross-origin to the dashboard, so the browser cannot read
    runtime errors out of the preview iframe.
    """
    loki_dir = _get_loki_dir()
    app_dir = loki_dir / "app-runner"
    log_file = app_dir / "app.log"
    state_file = app_dir / "state.json"

    status = "not_initialized"
    crash_count = 0
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
            status = state.get("status", "unknown")
            crash_count = int(state.get("crash_count", 0) or 0)
        except (json.JSONDecodeError, OSError, ValueError, TypeError):
            status = "error"

    out_lines = []
    if log_file.exists():
        try:
            redact = _get_log_redactor()
            # Offload the blocking log read + redaction off the event loop.
            def _read_redacted(p=log_file, n=lines):
                return [redact(ln) for ln in _safe_read_text(p).splitlines()[-n:]]
            out_lines = await asyncio.to_thread(_read_redacted)
        except OSError:
            out_lines = []

    return {
        "lines": out_lines,
        "redacted": True,
        "status": status,
        "crash_count": crash_count,
    }


@app.post("/api/control/app-restart", dependencies=[Depends(auth.require_scope("control"))])
async def control_app_restart(request: Request):
    """Signal app runner to restart the application."""
    if not _control_limiter.check(request.client.host if request.client else "unknown"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    loki_dir = _get_loki_dir()
    signal_dir = loki_dir / "app-runner"
    signal_dir.mkdir(parents=True, exist_ok=True)
    signal_file = signal_dir / "restart-signal"
    signal_file.write_text(datetime.now(timezone.utc).isoformat())
    return {"status": "restart_signaled"}


@app.post("/api/control/app-stop", dependencies=[Depends(auth.require_scope("control"))])
async def control_app_stop(request: Request):
    """Signal app runner to stop the application."""
    if not _control_limiter.check(request.client.host if request.client else "unknown"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    loki_dir = _get_loki_dir()
    signal_dir = loki_dir / "app-runner"
    signal_dir.mkdir(parents=True, exist_ok=True)
    signal_file = signal_dir / "stop-signal"
    signal_file.write_text(datetime.now(timezone.utc).isoformat())
    return {"status": "stop_signaled"}


# =============================================================================
# Playwright Verification Endpoints (v5.46.0)
# =============================================================================

@app.get("/api/playwright/results", dependencies=[Depends(auth.require_scope("read"))])
async def get_playwright_results():
    """Get latest Playwright smoke test results."""
    loki_dir = _get_loki_dir()
    results_file = loki_dir / "verification" / "playwright-results.json"
    if not results_file.exists():
        return {"status": "not_run"}
    try:
        return json.loads(results_file.read_text())
    except (json.JSONDecodeError, OSError):
        return {"status": "error"}


@app.get("/api/playwright/screenshot", dependencies=[Depends(auth.require_scope("read"))])
async def get_playwright_screenshot():
    """Get path to latest Playwright screenshot."""
    loki_dir = _get_loki_dir()
    screenshots_dir = loki_dir / "verification" / "screenshots"
    if not screenshots_dir.exists():
        return {"screenshot": None}
    # Get most recent screenshot
    screenshots = sorted(screenshots_dir.glob("*.png"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not screenshots:
        return {"screenshot": None}
    return FileResponse(str(screenshots[0]), media_type="image/png")


# =============================================================================
# Failure Analysis & Prompt Optimization (v5.54.0)
# =============================================================================

_failure_extractor = None
_prompt_optimizer = None


def _get_failure_extractor():
    """Lazy-initialise the shared FailureExtractor instance."""
    global _failure_extractor
    if _failure_extractor is None:
        from .failure_extractor import FailureExtractor
        _failure_extractor = FailureExtractor()
    return _failure_extractor


def _get_prompt_optimizer():
    """Lazy-initialise the shared PromptOptimizer instance."""
    global _prompt_optimizer
    if _prompt_optimizer is None:
        from .prompt_optimizer import PromptOptimizer
        _prompt_optimizer = PromptOptimizer()
    return _prompt_optimizer


@app.get("/api/failures", dependencies=[Depends(auth.require_scope("read"))])
def get_failures(request: Request, sessions: int = 10):
    """Get failure patterns from recent sessions."""
    if sessions < 1 or sessions > 1000:
        raise HTTPException(status_code=400, detail="sessions must be between 1 and 1000")
    if not _read_limiter.check(_rate_key("failures", request)):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    try:
        return _get_failure_extractor().extract(sessions=sessions)
    except Exception as exc:
        logger.error("Failure extraction error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to extract failure patterns")


@app.get("/api/prompt-versions", dependencies=[Depends(auth.require_scope("read"))])
def get_prompt_versions():
    """Get current prompt optimization status."""
    if not _read_limiter.check("prompt_versions"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    try:
        return _get_prompt_optimizer().get_current_version()
    except Exception as exc:
        logger.error("Prompt version read error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to read prompt versions")


@app.post("/api/prompt-optimize", dependencies=[Depends(auth.require_scope("control"))])
def optimize_prompts(sessions: int = 10, dry_run: bool = True):
    """Run prompt optimization from failure analysis."""
    if sessions < 1 or sessions > 1000:
        raise HTTPException(status_code=400, detail="sessions must be between 1 and 1000")
    if not _control_limiter.check("prompt_optimize"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    try:
        return _get_prompt_optimizer().optimize(sessions=sessions, dry_run=dry_run)
    except Exception as exc:
        logger.error("Prompt optimization error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to run prompt optimization")


# =============================================================================
# Static File Serving (Production/Docker)
# =============================================================================
# Must be configured AFTER all API routes to avoid conflicts

from fastapi.responses import FileResponse, HTMLResponse, Response

# Find static files in multiple possible locations
DASHBOARD_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(DASHBOARD_DIR)

# Possible static file locations (in order of preference)
# Resolves correctly regardless of PYTHONPATH, symlinks, or install method
STATIC_LOCATIONS = [
    os.path.join(DASHBOARD_DIR, "static"),           # dashboard/static/ (production)
    os.path.join(PROJECT_ROOT, "dashboard-ui", "dist"),  # dashboard-ui/dist/ (development)
]

# Add LOKI_SKILL_DIR env var fallback (set by loki CLI and run.sh)
_skill_dir = os.environ.get("LOKI_SKILL_DIR", "")
if _skill_dir:
    STATIC_LOCATIONS.append(os.path.join(_skill_dir, "dashboard", "static"))
    STATIC_LOCATIONS.append(os.path.join(_skill_dir, "dashboard-ui", "dist"))

# Add ~/.claude/skills/loki-mode fallback (installed skill location)
_home_skill = os.path.join(os.path.expanduser("~"), ".claude", "skills", "loki-mode")
if os.path.isdir(_home_skill):
    STATIC_LOCATIONS.append(os.path.join(_home_skill, "dashboard", "static"))
    STATIC_LOCATIONS.append(os.path.join(_home_skill, "dashboard-ui", "dist"))

STATIC_DIR = None
for loc in STATIC_LOCATIONS:
    if os.path.isdir(loc):
        STATIC_DIR = loc
        logger.info(f"Static files found at: {loc}")
        break

if STATIC_DIR:
    from fastapi.staticfiles import StaticFiles

    # Check if assets directory exists (built frontend)
    ASSETS_DIR = os.path.join(STATIC_DIR, "assets")
    if os.path.isdir(ASSETS_DIR):
        app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")

# ---------------------------------------------------------------------------
# Activity Logger & Session Diff
# ---------------------------------------------------------------------------

@app.get("/api/activity", dependencies=[Depends(auth.require_scope("read"))])
def get_activity(request: Request, since: Optional[str] = None, limit: int = Query(default=100, ge=1, le=1000)):
    """Get activity log entries, optionally filtered by timestamp."""
    if not _read_limiter.check(_rate_key("activity", request)):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    try:
        activity_logger = get_activity_logger()
        if since:
            entries = activity_logger.query_since(since)
        else:
            # Return all entries from the current log file, up to limit
            entries = activity_logger.query_since("1970-01-01T00:00:00+00:00")
        return entries[-limit:]
    except Exception as exc:
        logger.error("Activity read error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to read activity log")


@app.get("/api/session-diff", dependencies=[Depends(auth.require_scope("read"))])
def get_session_diff(since: Optional[str] = None):
    """Get structured session diff since timestamp. Defaults to last 24h."""
    if not _read_limiter.check("session-diff"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    try:
        activity_logger = get_activity_logger()
        return activity_logger.get_session_diff(since_timestamp=since)
    except Exception as exc:
        logger.error("Session diff error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to compute session diff")


@app.post("/api/activity", dependencies=[Depends(auth.require_scope("control"))])
async def log_activity(entry: dict):
    """Log an activity entry (for internal use by agents)."""
    if not _control_limiter.check("activity-write"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    # Validate required fields
    required = {"entity_type", "entity_id", "action"}
    missing = required - set(entry.keys())
    if missing:
        raise HTTPException(status_code=400, detail=f"Missing required fields: {', '.join(sorted(missing))}")

    activity_logger = get_activity_logger()
    result = activity_logger.log(
        entity_type=entry["entity_type"],
        entity_id=entry["entity_id"],
        action=entry["action"],
        old_value=entry.get("old_value"),
        new_value=entry.get("new_value"),
        session_id=entry.get("session_id"),
    )
    return result


# Serve favicon.svg from static directory
@app.get("/favicon.svg", include_in_schema=False)
async def serve_favicon():
    """Serve the dashboard favicon."""
    if STATIC_DIR:
        favicon_path = os.path.join(STATIC_DIR, "favicon.svg")
        if os.path.isfile(favicon_path):
            return FileResponse(favicon_path, media_type="image/svg+xml")
    return Response(status_code=404)


# Serve the self-contained cost + observability panel (R3). Zero-build
# standalone page that fetches /api/cost/timeline. Mirrors the proofs.html
# pattern: works without the SPA build.
@app.get("/cost", include_in_schema=False, dependencies=[Depends(auth.require_scope("read"))])
async def serve_cost_panel():
    """Serve the standalone cost + observability HTML panel."""
    if STATIC_DIR:
        cost_path = os.path.join(STATIC_DIR, "cost.html")
        if os.path.isfile(cost_path):
            return FileResponse(cost_path, media_type="text/html")
    return Response(status_code=404)


# R4: standalone trust-trajectory page that fetches /api/trust/trajectory.
# Mirrors the cost.html / /cost pattern: works without the SPA build.
@app.get("/trust", include_in_schema=False, dependencies=[Depends(auth.require_scope("read"))])
async def serve_trust_panel():
    """Serve the standalone trust-trajectory HTML panel."""
    if STATIC_DIR:
        trust_path = os.path.join(STATIC_DIR, "trust.html")
        if os.path.isfile(trust_path):
            return FileResponse(trust_path, media_type="text/html")
    return Response(status_code=404)


# Serve index.html or standalone HTML for root
@app.get("/", include_in_schema=False, dependencies=[Depends(auth.require_scope("read"))])
async def serve_index():
    """Serve the frontend SPA or standalone HTML."""
    # Try multiple index file locations
    index_candidates = []
    if STATIC_DIR:
        index_candidates.append(os.path.join(STATIC_DIR, "index.html"))
        index_candidates.append(os.path.join(STATIC_DIR, "loki-dashboard-standalone.html"))

    # Also check dashboard-ui directly for standalone
    standalone_path = os.path.join(PROJECT_ROOT, "dashboard-ui", "dist", "loki-dashboard-standalone.html")
    if standalone_path not in index_candidates:
        index_candidates.append(standalone_path)

    for index_path in index_candidates:
        if os.path.isfile(index_path):
            return FileResponse(index_path, media_type="text/html")

    # Return 503 when frontend files are not found
    return JSONResponse(
        content={
            "error": "dashboard_frontend_not_found",
            "detail": "The dashboard API is running, but the frontend files were not found. "
                      "Run: cd dashboard-ui && npm run build",
            "api_docs": "/docs",
            "health": "/health",
        },
        status_code=503,
    )


# =============================================================================
# Rigour Quality Gate Endpoints
# =============================================================================

_rigour: Optional["RigourIntegration"] = None


def _get_rigour() -> "RigourIntegration":
    """Lazy-initialise the shared RigourIntegration instance."""
    global _rigour
    if _rigour is None:
        from .rigour_integration import RigourIntegration

        data_dir = os.environ.get("LOKI_DATA_DIR", os.path.expanduser("~/.loki"))
        _rigour = RigourIntegration(data_dir=data_dir)
    return _rigour


@app.get("/api/quality-score", dependencies=[Depends(auth.require_scope("read"))])
def get_quality_score(request: Request):
    """Get current quality score from the most recent Rigour scan."""
    if not _read_limiter.check(_rate_key("quality-score", request)):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    try:
        rigour = _get_rigour()
        return rigour.get_score()
    except Exception as exc:
        logger.error("Quality score read error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to read quality score")


@app.get("/api/quality-score/history", dependencies=[Depends(auth.require_scope("read"))])
def get_quality_score_history(limit: int = Query(50, ge=1, le=500)):
    """Get quality score trend over time."""
    if not _read_limiter.check("quality-history"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    try:
        rigour = _get_rigour()
        return rigour.get_score_history(limit=limit)
    except Exception as exc:
        logger.error("Quality history read error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to read quality history")


@app.post("/api/quality-scan", dependencies=[Depends(auth.require_scope("control"))])
async def run_quality_scan(preset: str = Query("default")):
    """Run a Rigour quality scan.

    Preset must be one of: default, healthcare, fintech, government.
    """
    _valid_presets = ("default", "healthcare", "fintech", "government")
    if preset not in _valid_presets:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid preset: {preset}. Must be one of {_valid_presets}",
        )
    if not _control_limiter.check("quality-scan"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    rigour = _get_rigour()
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, rigour.scan, ".", preset)
    return result


@app.get("/api/quality-report", dependencies=[Depends(auth.require_scope("read"))])
def get_quality_report(fmt: str = Query("json", alias="format", pattern="^(json|markdown|html)$")):
    """Get an exportable quality audit report."""
    if not _read_limiter.check("quality-report"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    try:
        rigour = _get_rigour()
        report_str = rigour.export_report(fmt=fmt)
        if fmt == "json":
            try:
                return json.loads(report_str)
            except json.JSONDecodeError:
                return PlainTextResponse(report_str)
        return PlainTextResponse(report_str)
    except Exception as exc:
        logger.error("Quality report error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to generate quality report")


# =============================================================================
# Migration Engine Endpoints
# =============================================================================

_migration_imports = None

_MIGRATION_ID_RE = re.compile(r'^mig_\d{8}_\d{6}_[a-zA-Z0-9_-]+$')


def _validate_migration_id(migration_id: str):
    """Validate migration_id format to prevent path traversal."""
    if not _MIGRATION_ID_RE.match(migration_id):
        raise HTTPException(status_code=400, detail="Invalid migration ID format")


def _get_migration_imports():
    """Lazy-import migration_engine module. Returns (MigrationPipeline, list_migrations) or False."""
    global _migration_imports
    if _migration_imports is None:
        try:
            from dashboard.migration_engine import MigrationPipeline, list_migrations
            _migration_imports = (MigrationPipeline, list_migrations)
        except ImportError:
            _migration_imports = False
    return _migration_imports


def _get_migration_terminal_phase():
    """Return the last phase in the migration PHASE_ORDER (the terminal phase),
    or None if the migration engine is unavailable. Used to let the terminal
    phase be advanced/completed without a successor to_phase (WAVE9 F1)."""
    try:
        from dashboard.migration_engine import PHASE_ORDER
        return PHASE_ORDER[-1] if PHASE_ORDER else None
    except (ImportError, IndexError):
        return None


@app.get("/api/migration/list", dependencies=[Depends(auth.require_scope("read"))])
def list_migrations_endpoint():
    """List all migrations."""
    if not _read_limiter.check("migration-list"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    imports = _get_migration_imports()
    if not imports:
        raise HTTPException(status_code=503, detail="Migration engine not available")
    MigrationPipeline, list_migrations = imports
    try:
        return list_migrations()
    except Exception as exc:
        logger.error("Migration list error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to list migrations")


@app.post("/api/migration/start", dependencies=[Depends(auth.require_scope("control"))])
def start_migration(request_body: dict):
    """Start a new migration.

    Body: {"codebase_path": str, "target": str, "options": dict}
    """
    if not _control_limiter.check("migration-start"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    imports = _get_migration_imports()
    if not imports:
        raise HTTPException(status_code=503, detail="Migration engine not available")
    MigrationPipeline, list_migrations = imports
    codebase_path = request_body.get("codebase_path")
    target = request_body.get("target")
    options = request_body.get("options", {})
    if not codebase_path or not target:
        raise HTTPException(status_code=400, detail="codebase_path and target are required")
    if not isinstance(codebase_path, str) or not isinstance(target, str):
        raise HTTPException(status_code=400, detail="codebase_path and target must be strings")
    if len(target) > 255:
        raise HTTPException(status_code=400, detail="target must be 255 characters or fewer")
    # Check raw input for traversal BEFORE resolving
    if '..' in codebase_path:
        raise HTTPException(status_code=400, detail="Path traversal not allowed")
    codebase_path = os.path.realpath(codebase_path)
    if not os.path.isdir(codebase_path):
        raise HTTPException(status_code=400, detail=f"codebase_path does not exist: {codebase_path}")
    try:
        pipeline = MigrationPipeline(codebase_path=codebase_path, target=target, options=options)
        manifest = pipeline.create_manifest()
        return asdict(manifest)
    except Exception as exc:
        logger.error("Migration start error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to start migration")


@app.get("/api/migration/{migration_id}/status", dependencies=[Depends(auth.require_scope("read"))])
def get_migration_status(migration_id: str):
    """Get migration status and progress."""
    _validate_migration_id(migration_id)
    if not _read_limiter.check("migration-status"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    imports = _get_migration_imports()
    if not imports:
        raise HTTPException(status_code=503, detail="Migration engine not available")
    MigrationPipeline, list_migrations = imports
    try:
        pipeline = MigrationPipeline.load(migration_id)
        return pipeline.get_progress()
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Migration not found: {migration_id}")
    except Exception as exc:
        logger.error("Migration status error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to get migration status")


@app.get("/api/migration/{migration_id}/plan", dependencies=[Depends(auth.require_scope("read"))])
def get_migration_plan(migration_id: str):
    """Get migration plan content."""
    _validate_migration_id(migration_id)
    if not _read_limiter.check("migration-plan"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    imports = _get_migration_imports()
    if not imports:
        raise HTTPException(status_code=503, detail="Migration engine not available")
    MigrationPipeline, list_migrations = imports
    try:
        pipeline = MigrationPipeline.load(migration_id)
        plan = pipeline.load_plan()
        return asdict(plan) if hasattr(plan, '__dataclass_fields__') else plan
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Migration plan not found for: {migration_id}")
    except Exception as exc:
        logger.error("Migration plan error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to get migration plan")


@app.get("/api/migration/{migration_id}/features", dependencies=[Depends(auth.require_scope("read"))])
def get_migration_features(migration_id: str):
    """Get migration feature list."""
    _validate_migration_id(migration_id)
    if not _read_limiter.check("migration-features"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    imports = _get_migration_imports()
    if not imports:
        raise HTTPException(status_code=503, detail="Migration engine not available")
    MigrationPipeline, list_migrations = imports
    try:
        pipeline = MigrationPipeline.load(migration_id)
        features = pipeline.load_features()
        return [asdict(f) for f in features]
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Migration features not found for: {migration_id}")
    except Exception as exc:
        logger.error("Migration features error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to get migration features")


@app.get("/api/migration/{migration_id}/seams", dependencies=[Depends(auth.require_scope("read"))])
def get_migration_seams(migration_id: str):
    """Get detected seams for migration."""
    _validate_migration_id(migration_id)
    if not _read_limiter.check("migration-seams"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    imports = _get_migration_imports()
    if not imports:
        raise HTTPException(status_code=503, detail="Migration engine not available")
    MigrationPipeline, list_migrations = imports
    try:
        pipeline = MigrationPipeline.load(migration_id)
        seams = pipeline.load_seams()
        return [asdict(s) for s in seams]
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Migration seams not found for: {migration_id}")
    except Exception as exc:
        logger.error("Migration seams error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to get migration seams")


@app.post("/api/migration/{migration_id}/advance", dependencies=[Depends(auth.require_scope("control"))])
def advance_migration(migration_id: str, request_body: dict):
    """Advance migration to the next phase.

    Body: {"from_phase": str, "to_phase": str}
    """
    _validate_migration_id(migration_id)
    if not _control_limiter.check("migration-advance"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    imports = _get_migration_imports()
    if not imports:
        raise HTTPException(status_code=503, detail="Migration engine not available")
    MigrationPipeline, list_migrations = imports
    from_phase = request_body.get("from_phase")
    to_phase = request_body.get("to_phase")
    # The terminal phase (the last in PHASE_ORDER, e.g. "verify") has no
    # successor, so check_phase_gate can never pass for it and to_phase is
    # meaningless. Without this carve-out the terminal phase could never be
    # completed via the API, so overall_status could never reach "completed"
    # (WAVE9 migration-F1). For the terminal phase we require only from_phase
    # and skip the gate; advance_phase still validates the phase and the
    # (ValueError, RuntimeError) -> 409 handler below preserves idempotency.
    terminal_phase = _get_migration_terminal_phase()
    is_terminal = terminal_phase is not None and from_phase == terminal_phase
    if not from_phase or (not to_phase and not is_terminal):
        raise HTTPException(status_code=400, detail="from_phase and to_phase are required")
    # Load pipeline and check phase gate before the try/except to let
    # HTTPException and FileNotFoundError propagate naturally.
    try:
        pipeline = MigrationPipeline.load(migration_id)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Migration not found: {migration_id}")
    if not is_terminal:
        passed, reason = pipeline.check_phase_gate(from_phase, to_phase)
        if not passed:
            raise HTTPException(status_code=409, detail=reason)
    try:
        result = pipeline.advance_phase(from_phase)
        return asdict(result) if hasattr(result, '__dataclass_fields__') else result
    except (ValueError, RuntimeError) as exc:
        # advance_phase raises RuntimeError on a failed phase gate or when the
        # phase is not in_progress (e.g. already advanced). These are client
        # contract errors, not server faults: map to 409 like the sibling
        # start_migration_phase endpoint does.
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.error("Migration advance error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to advance migration")


@app.post("/api/migration/{migration_id}/start-phase", dependencies=[Depends(auth.require_scope("control"))])
def start_migration_phase(migration_id: str, request_body: dict):
    """Start a migration phase (transition from pending to in_progress)."""
    _validate_migration_id(migration_id)
    if not _control_limiter.check("migration-start-phase"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    imports = _get_migration_imports()
    if not imports:
        raise HTTPException(status_code=503, detail="Migration engine not available")
    MigrationPipeline, list_migrations = imports
    phase = request_body.get("phase")
    if not phase:
        raise HTTPException(status_code=400, detail="phase is required")
    try:
        pipeline = MigrationPipeline.load(migration_id)
        pipeline.start_phase(phase)
        return {"status": "started", "phase": phase}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"Migration not found: {migration_id}")
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except Exception as exc:
        logger.error("Start phase error: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to start phase")


# ---------------------------------------------------------------------------
# Managed Agents Memory bridge (Phase 5, read-only)
#
# These endpoints expose the contents of .loki/managed/events.ndjson plus a
# thin proxy to beta.memory_stores.memory_versions.list(). All endpoints are
# safe to call when the managed-agents flags are off: they return empty
# lists / {enabled: false} rather than 500s. No endpoint writes to the
# managed store -- the only writer in the codebase remains
# memory/managed_memory/shadow_write.py.
# ---------------------------------------------------------------------------

_MANAGED_EVENTS_TAIL_MAX = 10000  # Safety ceiling on tail reads.


def _managed_events_path() -> _Path:
    """Return the absolute path to .loki/managed/events.ndjson."""
    return _get_loki_dir() / "managed" / "events.ndjson"


def _managed_flags_snapshot() -> dict[str, Any]:
    """Read managed-agents flags without importing the SDK path."""
    parent = os.environ.get("LOKI_MANAGED_AGENTS", "").strip().lower() == "true"
    child = os.environ.get("LOKI_MANAGED_MEMORY", "").strip().lower() == "true"
    try:
        from memory.managed_memory._beta import BETA_HEADER as _beta_header
    except Exception:
        _beta_header = "managed-agents-2026-04-01"
    return {
        "enabled": parent and child,
        "parent_flag": parent,
        "child_flags": {"LOKI_MANAGED_MEMORY": child},
        "beta_header": _beta_header,
    }


def _tail_ndjson(
    path: _Path,
    limit: int,
    since_iso: Optional[str],
    event_type: Optional[str],
) -> list[dict[str, Any]]:
    """
    Return the last *limit* records from an ndjson file, optionally filtered
    by ts >= since_iso and/or type == event_type. The file is streamed line
    by line; malformed lines are skipped rather than raising.
    """
    if not path.exists():
        return []
    try:
        # Read lines (file is small: rotation at 10MB per the writer).
        with open(path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return []

    results: list[dict[str, Any]] = []
    # Scan from newest to oldest so we can early-exit once we have enough.
    for raw in reversed(lines):
        line = raw.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        if event_type and record.get("type") != event_type:
            continue
        if since_iso:
            ts = record.get("ts", "")
            if isinstance(ts, str) and ts < since_iso:
                # ISO-8601 strings sort lexicographically with Z suffix; once
                # we pass the floor we can stop scanning.
                break
        results.append(record)
        if len(results) >= limit:
            break
    # Return in chronological order (oldest first) for UI convenience.
    results.reverse()
    return results


def _last_fallback_ts(events: list[dict[str, Any]]) -> Optional[str]:
    """Return the ts of the most recent managed_agents_fallback event, if any."""
    for rec in reversed(events):
        if rec.get("type") == "managed_agents_fallback":
            ts = rec.get("ts")
            return ts if isinstance(ts, str) else None
    return None


@app.get("/api/managed/events", dependencies=[Depends(auth.require_scope("read"))])
async def get_managed_events(
    limit: int = Query(default=100, ge=1, le=_MANAGED_EVENTS_TAIL_MAX),
    since: Optional[str] = Query(default=None),
    type: Optional[str] = Query(default=None, alias="type"),
):
    """
    Return the tail of .loki/managed/events.ndjson.

    Works regardless of flag state. When the flags are off or the file does
    not exist yet, returns an empty list. Never raises on I/O error.
    """
    try:
        path = _managed_events_path()
        # Tails an ndjson file (rotated at 10MB) via a blocking readlines();
        # offload so the event loop stays responsive.
        records = await asyncio.to_thread(
            _tail_ndjson, path, limit, since, type
        )
        return {
            "events": records,
            "count": len(records),
            "source": str(path),
        }
    except Exception as exc:  # defensive: never 500 on read-only tail.
        logger.warning("managed events tail failed: %s", exc)
        return {"events": [], "count": 0, "error": str(exc)}


@app.get("/api/managed/status", dependencies=[Depends(auth.require_scope("read"))])
async def get_managed_status():
    """
    Return the managed-agents flag snapshot plus last_fallback_ts.

    When flags are off, returns {enabled: false, ...} rather than 503. This
    endpoint is meant to be polled by the UI to decide whether to surface
    the managed-memory panel at all.
    """
    snapshot = _managed_flags_snapshot()
    # last_fallback_ts is best-effort from the local events file.
    try:
        # Blocking ndjson tail read; offload off the event loop.
        events = await asyncio.to_thread(
            _tail_ndjson,
            _managed_events_path(),
            500,
            None,
            "managed_agents_fallback",
        )
        snapshot["last_fallback_ts"] = _last_fallback_ts(events)
    except Exception:
        snapshot["last_fallback_ts"] = None
    return snapshot


@app.get("/api/managed/memory_versions/{memory_id}", dependencies=[Depends(auth.require_scope("read"))])
async def list_managed_memory_versions(memory_id: str):
    """
    Proxy to beta.memory_stores.memory_versions.list(memory_id=...).

    Returns 503 with a helpful JSON body when flags are off or the SDK does
    not expose the expected attribute path. On any SDK / transport error the
    endpoint returns 502 with the error detail -- the managed store owns the
    source of truth, so we do NOT silently return an empty list here.
    """
    # Validate memory_id early so we don't leak path-traversal attempts into
    # the SDK payload. The managed API uses opaque identifiers; alphanumerics,
    # hyphens, underscores only.
    if (
        not memory_id
        or len(memory_id) > 256
        or ".." in memory_id
        or not re.match(r"^[a-zA-Z0-9_\-]+$", memory_id)
    ):
        raise HTTPException(status_code=400, detail="Invalid memory_id")

    snapshot = _managed_flags_snapshot()
    if not snapshot["enabled"]:
        raise HTTPException(
            status_code=503,
            detail=(
                "managed memory disabled: set LOKI_MANAGED_AGENTS=true and "
                "LOKI_MANAGED_MEMORY=true to enable"
            ),
        )

    try:
        from memory.managed_memory import ManagedDisabled
        from memory.managed_memory.client import get_client
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"managed client unavailable: {exc}")

    try:
        client = get_client()
    except ManagedDisabled as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    # Resolve beta.memory_stores.memory_versions.list(...) defensively. Some
    # SDK versions may not expose this path yet; treat missing attributes as
    # 503 (flag state prevents us from guaranteeing anything else).
    try:
        beta = getattr(client._client, "beta", None)  # type: ignore[attr-defined]
        memory_stores = getattr(beta, "memory_stores", None) if beta is not None else None
        memory_versions = (
            getattr(memory_stores, "memory_versions", None)
            if memory_stores is not None
            else None
        )
        list_fn = getattr(memory_versions, "list", None) if memory_versions is not None else None
        if list_fn is None:
            raise HTTPException(
                status_code=503,
                detail="memory_versions.list not available in installed SDK",
            )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"SDK introspection failed: {exc}")

    try:
        result = list_fn(memory_id=memory_id)
    except Exception as exc:
        # Distinguish "not found" from transport errors when we can.
        status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
        if status == 404:
            raise HTTPException(status_code=404, detail=f"memory_id not found: {memory_id}")
        logger.warning("memory_versions.list failed: %s", exc)
        raise HTTPException(status_code=502, detail=f"managed API error: {exc}")

    # Normalize to a list of dicts.
    data = getattr(result, "data", result)
    if data is None:
        data = []
    items: list[dict[str, Any]] = []
    for entry in data:
        if isinstance(entry, dict):
            items.append(entry)
            continue
        to_dict = getattr(entry, "model_dump", None) or getattr(entry, "dict", None)
        if callable(to_dict):
            try:
                items.append(to_dict())
                continue
            except Exception:
                pass
        items.append({"raw": str(entry)})
    return {"memory_id": memory_id, "versions": items, "count": len(items)}


# ---------------------------------------------------------------------------
# Phase 1 artifact endpoints (v7.5.3) -- read-only inspectors.
# ---------------------------------------------------------------------------


@app.get("/api/findings/{iteration}", dependencies=[Depends(auth.require_scope("read"))])
async def get_findings(iteration: int):
    """Read structured code-review findings for a given iteration."""
    base = _get_loki_dir()
    persisted = base / "state" / f"findings-{iteration}.json"
    if persisted.exists():
        data = _safe_json_read(persisted, default=None)
        if data is not None:
            return data
    reviews_dir = base / "quality" / "reviews"
    if reviews_dir.exists():
        candidates = sorted(
            d.name for d in reviews_dir.iterdir()
            if d.is_dir() and d.name.startswith("review-")
            and d.name.endswith(f"-{iteration}")
        )
        if candidates:
            review_dir = reviews_dir / candidates[-1]
            agg = _safe_json_read(review_dir / "aggregate.json", default=None)
            return {
                "iteration": iteration,
                "review_id": agg.get("review_id") if isinstance(agg, dict) else candidates[-1],
                "findings": [],
                "note": "findings-<iter>.json not found; review dir present",
            }
    raise HTTPException(status_code=404,
                        detail=f"No findings for iteration {iteration}")


@app.get("/api/quality/architecture", dependencies=[Depends(auth.require_scope("read"))])
async def get_quality_architecture():
    """Return the sentrux architectural-drift series.

    Globs `.loki/state/findings-sentrux-*.json` (written by the iteration
    loop when LOKI_SENTRUX_GATE=1), sorts by iteration ascending, and
    returns a series suitable for plotting drift over time.

    Per-file JSON parse errors are logged and skipped; the endpoint stays
    200 OK even when no files exist or every file is corrupt.
    """
    base = _get_loki_dir()
    state_dir = base / "state"
    series: list[dict[str, Any]] = []
    if state_dir.exists():
        try:
            paths = list(state_dir.glob("findings-sentrux-*.json"))
        except OSError as exc:
            logger.warning("sentrux: failed to glob %s: %s", state_dir, exc)
            paths = []
        for path in paths:
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
                data = json.loads(text)
            except (OSError, IOError) as exc:
                logger.warning("sentrux: skipping unreadable %s: %s",
                               path.name, exc)
                continue
            except json.JSONDecodeError as exc:
                logger.warning("sentrux: skipping corrupt JSON %s: %s",
                               path.name, exc)
                continue
            if not isinstance(data, dict):
                logger.warning("sentrux: skipping non-object payload in %s",
                               path.name)
                continue
            try:
                iteration = int(data.get("iteration"))
                before = int(data.get("before"))
                after = int(data.get("after"))
            except (TypeError, ValueError) as exc:
                logger.warning("sentrux: skipping %s, bad ints: %s",
                               path.name, exc)
                continue
            verdict = data.get("verdict")
            if verdict not in ("DEGRADED", "OK", "UNKNOWN"):
                verdict = "UNKNOWN"
            timestamp = data.get("timestamp")
            if not isinstance(timestamp, str):
                timestamp = ""
            series.append({
                "iteration": iteration,
                "before": before,
                "after": after,
                "verdict": verdict,
                "timestamp": timestamp,
            })
    series.sort(key=lambda e: e["iteration"])
    current = series[-1]["after"] if series else None
    return {"series": series, "current": current, "samples": len(series)}


@app.get("/api/learnings", dependencies=[Depends(auth.require_scope("read"))])
async def get_learnings(limit: int = 50):
    """Read recent learnings (newest first)."""
    base = _get_loki_dir()
    path = base / "state" / "relevant-learnings.json"
    if not path.exists():
        return {"version": 1, "learnings": [], "total": 0}
    data = _safe_json_read(path, default={})
    if not isinstance(data, dict):
        return {"version": 1, "learnings": [], "total": 0}
    learnings = data.get("learnings", [])
    if not isinstance(learnings, list):
        learnings = []
    limit_clamped = max(1, int(limit)) if isinstance(limit, int) else 50
    sliced = list(reversed(learnings))[:limit_clamped]
    return {"version": data.get("version", 1), "total": len(learnings),
            "learnings": sliced}


@app.get("/api/escalations", dependencies=[Depends(auth.require_scope("read"))])
async def list_escalations():
    """List handoff documents under .loki/escalations/."""
    base = _get_loki_dir()
    esc_dir = base / "escalations"
    if not esc_dir.exists():
        return {"escalations": []}
    items = []
    try:
        for entry in sorted(esc_dir.iterdir(),
                            key=lambda p: p.name, reverse=True):
            if not entry.name.endswith(".md"):
                continue
            try:
                stat = entry.stat()
                items.append({
                    "filename": entry.name,
                    "size_bytes": stat.st_size,
                    "modified_at": (
                        __import__("datetime").datetime
                        .fromtimestamp(stat.st_mtime,
                                       tz=__import__("datetime").timezone.utc)
                        .isoformat()
                    ),
                })
            except OSError:
                continue
    except OSError:
        pass
    return {"escalations": items}


@app.get("/api/escalations/{filename}", dependencies=[Depends(auth.require_scope("read"))])
async def get_escalation(filename: str):
    """Read one handoff document. Path-traversal-safe."""
    if "\\" in filename or filename.startswith("."):
        raise HTTPException(status_code=400, detail="invalid filename")
    if not filename.endswith(".md"):
        raise HTTPException(status_code=400,
                            detail="only .md handoffs are served")
    escalations_dir = str(_get_loki_dir() / "escalations")
    # Resolve symlinks on both sides to catch symlink traversal that the
    # router-level "/" rejection misses (e.g. a symlink whose target
    # escapes the escalations directory).
    target = os.path.realpath(os.path.join(escalations_dir, filename))
    base = os.path.realpath(escalations_dir)
    if not target.startswith(base + os.sep):
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = _Path(target)
    if not path.exists():
        raise HTTPException(status_code=404,
                            detail=f"handoff not found: {filename}")
    try:
        body = _safe_read_text(path)
    except OSError as exc:
        raise HTTPException(status_code=500,
                            detail=f"read failed: {exc}") from exc
    return PlainTextResponse(content=body, media_type="text/markdown")


# ---------------------------------------------------------------------------
# Proof-of-run artifacts (R1, Slice C).
#
# Directory-layout contract with the generator (autonomy/lib/proof-generator.py,
# Slice A): each run's proof lives at
#     <active project>/.loki/proofs/<run_id>/proof.json
#     <active project>/.loki/proofs/<run_id>/index.html
# This assumption is asserted explicitly so it is checkable: if Slice A emits a
# flat layout instead, the /api/proofs routes below return empty / 404 rather
# than reading the wrong files. Run-id segments are sanitized and every resolved
# path is realpath-contained under .loki/proofs (mirrors the escalations route
# guard at the get_escalation handler above).
# ---------------------------------------------------------------------------
def _proofs_dir() -> _Path:
    return _get_loki_dir() / "proofs"


def _safe_proof_run_dir(run_id: str) -> _Path:
    """Resolve and validate a proof run directory, traversal-safe.

    Rejects path separators, NUL, leading dot, and parent references in the
    run_id, then realpath-contains the result under .loki/proofs. Raises
    HTTPException(400) on any rejection.
    """
    if (not run_id or "/" in run_id or "\\" in run_id or "\x00" in run_id
            or run_id.startswith(".") or ".." in run_id):
        raise HTTPException(status_code=400, detail="invalid run id")
    base = os.path.realpath(str(_proofs_dir()))
    target = os.path.realpath(os.path.join(base, run_id))
    if not target.startswith(base + os.sep):
        raise HTTPException(status_code=400, detail="invalid run id")
    return _Path(target)


def _proof_pr_url(run_dir: _Path) -> Optional[str]:
    """Return the PR URL linked to this run, or None.

    Reads the optional <run_dir>/pr.json that the run.sh auto-PR path writes at
    PR-creation time ({"run_id": "...", "pr_url": "..."}). The file is read only
    inside the already-validated run dir (the caller passes either an iterdir()
    entry or a _safe_proof_run_dir result -- never a raw run_id), so there is no
    additional traversal surface. Missing/unreadable/non-dict pr.json or an
    empty/non-string pr_url -> None, never an error. Most proofs have no PR.
    """
    pr_data = _safe_json_read(run_dir / "pr.json", default=None)
    if not isinstance(pr_data, dict):
        return None
    url = pr_data.get("pr_url")
    if isinstance(url, str) and url:
        return url
    return None


@app.get("/api/proofs", dependencies=[Depends(auth.require_scope("read"))])
async def list_proofs():
    """List proof-of-run artifacts for the active project's .loki/proofs/."""
    proofs_dir = _proofs_dir()
    items: list[dict] = []
    try:
        entries = sorted(proofs_dir.iterdir())
    except (OSError, FileNotFoundError):
        return {"proofs": []}
    for entry in entries:
        if not entry.is_dir():
            continue
        proof_json = entry / "proof.json"
        if not proof_json.is_file():
            continue
        data = _safe_json_read(proof_json, default=None)
        if not isinstance(data, dict):
            continue
        # Deterministic honesty headline (single source of truth, same access as
        # proofs_summary's bucketing). Read, never recomputed. The list endpoint
        # surfaces it so the panel can show the verdict without a second fetch.
        honesty = data.get("honesty")
        headline = honesty.get("headline") if isinstance(honesty, dict) else None
        items.append({
            "run_id": data.get("run_id", entry.name),
            "generated_at": data.get("generated_at"),
            "loki_version": data.get("loki_version"),
            "cost_usd": (data.get("cost") or {}).get("usd"),
            "files_changed": (data.get("files_changed") or {}).get("count"),
            "final_verdict": (data.get("council") or {}).get("final_verdict"),
            "headline": headline,
            "pr_url": _proof_pr_url(entry),
            "has_html": (entry / "index.html").is_file(),
        })
    # Newest first when generated_at is present.
    items.sort(key=lambda x: (x.get("generated_at") or ""), reverse=True)
    return {"proofs": items}


@app.get("/api/proofs/summary",
         dependencies=[Depends(auth.require_scope("read"))])
async def proofs_summary():
    """Honest aggregate over the active project's Evidence Receipts.

    Counts are computed ONLY from real proof.json files; nothing is invented.
    The single source of truth for "verified" is the v1.1 deterministic
    honesty.headline (proof-generator.py::_compute_headline), which a forger
    cannot turn green without real exit_code:0 evidence. Buckets:

      verified      -> honesty.headline == "VERIFIED"
      with_gaps     -> honesty.headline == "VERIFIED WITH GAPS"
      not_verified  -> honesty.headline == "NOT VERIFIED"
      unknown       -> no honesty block (schema v1.0 proofs) or any other/
                       missing headline. We refuse to count these as verified
                       because we cannot prove they were.

    Empty or missing proofs dir -> all zeros (200), an honest empty state.
    Mirrors list_proofs' iteration + _safe_json_read so the counts can never
    drift from what the list endpoint shows.
    """
    proofs_dir = _proofs_dir()
    total = verified = with_gaps = not_verified = unknown = 0
    try:
        entries = sorted(proofs_dir.iterdir())
    except (OSError, FileNotFoundError):
        entries = []
    for entry in entries:
        if not entry.is_dir():
            continue
        proof_json = entry / "proof.json"
        if not proof_json.is_file():
            continue
        data = _safe_json_read(proof_json, default=None)
        if not isinstance(data, dict):
            continue
        total += 1
        honesty = data.get("honesty")
        headline = honesty.get("headline") if isinstance(honesty, dict) else None
        if headline == "VERIFIED":
            verified += 1
        elif headline == "VERIFIED WITH GAPS":
            with_gaps += 1
        elif headline == "NOT VERIFIED":
            not_verified += 1
        else:
            unknown += 1
    return {
        "total_receipts": total,
        "verified": verified,
        "with_gaps": with_gaps,
        "not_verified": not_verified,
        "unknown": unknown,
    }


@app.get("/api/proofs/{run_id}", dependencies=[Depends(auth.require_scope("read"))])
async def get_proof(run_id: str):
    """Return the redacted proof.json for one run."""
    run_dir = _safe_proof_run_dir(run_id)
    proof_json = run_dir / "proof.json"
    if not proof_json.is_file():
        raise HTTPException(status_code=404, detail=f"proof not found: {run_id}")
    data = _safe_json_read(proof_json, default=None)
    if not isinstance(data, dict):
        raise HTTPException(status_code=500, detail="proof.json unreadable")
    # Surface the optional PR linkage alongside the proof. The proof.json itself
    # already carries honesty.headline; we only add pr_url so the panel can show
    # "PR #N -> <headline>". Absent pr.json -> pr_url null, never an error.
    data["pr_url"] = _proof_pr_url(run_dir)
    return JSONResponse(content=data)


@app.get("/api/proofs/{run_id}/html", dependencies=[Depends(auth.require_scope("read"))])
async def get_proof_html(run_id: str):
    """Serve the self-contained shareable proof page for one run."""
    run_dir = _safe_proof_run_dir(run_id)
    index_html = run_dir / "index.html"
    if not index_html.is_file():
        raise HTTPException(status_code=404,
                            detail=f"proof page not found: {run_id}")
    return FileResponse(str(index_html), media_type="text/html")


# ---------------------------------------------------------------------------
# Active spec + spec history.
#
# Gives the dashboard honest visibility into WHAT Loki is building from. The
# resolution order mirrors proof-generator.py::_collect_spec so the panel and
# the Evidence Receipt can never disagree about the spec source:
#   1. PRD file  -> session.json prdPath (only when the file still exists)
#   2. one-line brief -> .loki/state/brief.txt
#   3. generated PRD  -> .loki/generated-prd.md
#   4. no spec        -> codebase-analysis
# Issue mode is detected from the latest proof.json's spec.source (a GitHub
# issue URL): issue runs re-dispatch through cmd_run, which synthesizes a PRD,
# so at runtime they look like a generated-prd; the proof carries the real
# issue ref. We never fabricate a type -- when nothing is resolvable we say so.
#
# History is derived from the proofs the Evidence Receipt already writes
# (.loki/proofs/<run_id>/proof.json), newest-first. No new store is invented.
# ---------------------------------------------------------------------------
# Cap on the spec body returned to the dashboard so a huge PRD cannot bloat the
# payload. The panel shows a preview; the full file lives on disk.
_SPEC_CONTENT_CAP = 20000
# Issue URLs (mirrors autonomy/loki's issue-mode detection regex). Matches a
# tracker host followed somewhere by an /issue(s)/ path or a Jira /browse/ key.
_ISSUE_URL_RE = re.compile(
    r"(github\.com|gitlab\.com|atlassian\.net|dev\.azure\.com|"
    r"visualstudio\.com)/.*\b(issues?|browse)/", re.IGNORECASE)


def _spec_source_is_issue(source: str) -> bool:
    """True when a proof spec.source string is a tracker issue reference."""
    if not source:
        return False
    return bool(_ISSUE_URL_RE.search(source))


def _latest_proof(proofs_dir: _Path) -> Optional[dict]:
    """Return the newest proof.json dict for the active project, or None."""
    try:
        entries = sorted(proofs_dir.iterdir())
    except (OSError, FileNotFoundError):
        return None
    newest = None
    newest_key = ""
    for entry in entries:
        if not entry.is_dir():
            continue
        proof_json = entry / "proof.json"
        if not proof_json.is_file():
            continue
        data = _safe_json_read(proof_json, default=None)
        if not isinstance(data, dict):
            continue
        key = data.get("generated_at") or entry.name
        if newest is None or key >= newest_key:
            newest = data
            newest_key = key
    return newest


def _spec_summary(source: str, brief: str) -> str:
    """One-line summary for a history row, derived honestly from the spec.

    Prefers the first non-empty line of the brief; falls back to the source
    basename. Never fabricates -- returns an honest label when nothing exists.
    """
    if brief:
        for line in brief.splitlines():
            line = line.strip().lstrip("#").strip()
            if line:
                return line[:160]
    if source in ("brief", "codebase-analysis", "", None):
        return {"brief": "one-line brief",
                "codebase-analysis": "Codebase analysis (no spec)"}.get(
                    source, "Unknown spec")
    if _spec_source_is_issue(source):
        return source
    return os.path.basename(source) or source


def _classify_proof_spec(spec: dict) -> str:
    """Map a proof.json spec dict to a dashboard spec type, honestly."""
    if not isinstance(spec, dict):
        return "unknown"
    source = (spec.get("source") or "").strip()
    if _spec_source_is_issue(source):
        return "issue"
    if source == "brief":
        return "brief"
    if source == "codebase-analysis":
        return "codebase-analysis"
    if not source:
        return "unknown"
    # A real filesystem path (PRD or generated PRD). A synthesized PRD lives at
    # .loki/generated-prd.md or .loki/brief-prd-*.md; anything else is a user
    # PRD. We report the broad "spec" type and the path so the UI can show it.
    return "spec"


@app.get("/api/spec", dependencies=[Depends(auth.require_scope("read"))])
async def get_active_spec():
    """Return the current run's spec source + content, honestly typed.

    Types: prd | brief | spec | issue | codebase-analysis | none. The `none`
    state is the honest empty state when no run has produced a spec yet. We
    never invent a spec: each branch reads a real file or says it cannot.
    """
    loki_dir = _get_loki_dir()

    # 1. PRD file recorded by the running orchestrator (session.json prdPath).
    #    Only trust it when the file still exists on disk.
    session = _safe_json_read(loki_dir / "session.json", default=None)
    prd_path = ""
    if isinstance(session, dict):
        prd_path = (session.get("prdPath") or "").strip()
    if prd_path:
        p = _Path(prd_path)
        if p.is_file():
            content = _safe_read_text(p)
            return {
                "type": "prd",
                "path": str(p),
                "content": content[:_SPEC_CONTENT_CAP],
                "truncated": len(content) > _SPEC_CONTENT_CAP,
            }

    # 2. one-line brief (zero-config first run). The raw brief is the strongest
    #    honest artifact -- show it verbatim.
    brief_file = loki_dir / "state" / "brief.txt"
    if brief_file.is_file():
        text = _safe_read_text(brief_file).strip()
        if text:
            return {"type": "brief", "text": text[:_SPEC_CONTENT_CAP],
                    "truncated": len(text) > _SPEC_CONTENT_CAP}

    # 3. Issue mode: a brief/PRD run that originated from a tracker issue. The
    #    runtime has only the synthesized PRD, but the latest proof.json carries
    #    the real issue ref + brief. Surface it as an issue when we can prove it.
    latest = _latest_proof(loki_dir / "proofs")
    if isinstance(latest, dict):
        pspec = latest.get("spec")
        if isinstance(pspec, dict):
            src = (pspec.get("source") or "").strip()
            if _spec_source_is_issue(src):
                pbrief = (pspec.get("brief") or "").strip()
                return {
                    "type": "issue",
                    "ref": src,
                    "title": _spec_summary(src, pbrief),
                    "body": pbrief[:_SPEC_CONTENT_CAP],
                    "truncated": len(pbrief) > _SPEC_CONTENT_CAP,
                }

    # 4. Generated PRD (synthesized from a brief, or from codebase analysis).
    for name in ("generated-prd.md",):
        gen = loki_dir / name
        if gen.is_file():
            content = _safe_read_text(gen)
            if content.strip():
                return {
                    "type": "spec",
                    "path": str(gen),
                    "content": content[:_SPEC_CONTENT_CAP],
                    "truncated": len(content) > _SPEC_CONTENT_CAP,
                    "generated": True,
                }

    # 5. Codebase analysis (no explicit spec) -- only claim this when a run has
    #    actually happened (a session or a proof exists). Otherwise honest none.
    has_session = isinstance(session, dict) and bool(session)
    if has_session or latest is not None:
        return {"type": "codebase-analysis"}

    # 6. Nothing yet -- honest empty state, not a fabricated spec.
    return {"type": "none"}


@app.get("/api/spec/history", dependencies=[Depends(auth.require_scope("read"))])
async def get_spec_history():
    """Return past specs/issues/briefs for this codebase, newest-first.

    Derived from the Evidence Receipts (.loki/proofs/<run_id>/proof.json) that
    every run already writes; no separate spec store is invented. Each row:
    {when, type, summary, run_id}. Missing/corrupt proofs are skipped, never
    faked. Empty -> {"history": []} (honest empty state).
    """
    proofs_dir = _get_loki_dir() / "proofs"
    rows: list[dict] = []
    try:
        entries = sorted(proofs_dir.iterdir())
    except (OSError, FileNotFoundError):
        return {"history": []}
    for entry in entries:
        if not entry.is_dir():
            continue
        proof_json = entry / "proof.json"
        if not proof_json.is_file():
            continue
        data = _safe_json_read(proof_json, default=None)
        if not isinstance(data, dict):
            continue
        spec = data.get("spec")
        spec = spec if isinstance(spec, dict) else {}
        source = (spec.get("source") or "").strip()
        rows.append({
            "run_id": data.get("run_id", entry.name),
            "when": data.get("generated_at"),
            "type": _classify_proof_spec(spec),
            "summary": _spec_summary(source, (spec.get("brief") or "").strip()),
        })
    rows.sort(key=lambda x: (x.get("when") or ""), reverse=True)
    return {"history": rows}


# ---------------------------------------------------------------------------
# R5: Auto-wiki + cited codebase Q&A (Loki's DeepWiki).
#
# Surfaces the per-project wiki generated by autonomy/lib/wiki-generator.py
# (stored under <project>/.loki/wiki/) and the grounded `ask` flow
# (autonomy/lib/wiki-ask.py). Citations are file:line and always point at real
# code -- the generator/ask scripts validate every citation against the
# filesystem before emitting it, so the dashboard never shows a fabricated one.
#
# The section param is traversal-safe, mirroring _safe_proof_run_dir: only the
# known section ids are accepted, so no arbitrary path can be read.
# ---------------------------------------------------------------------------
_WIKI_SECTIONS = {"architecture", "modules", "data-flow"}


def _wiki_dir() -> _Path:
    return _get_loki_dir() / "wiki"


def _project_root() -> _Path:
    """Resolve the active project root (.loki's parent)."""
    return _get_loki_dir().parent


@app.get("/api/wiki", dependencies=[Depends(auth.require_scope("read"))])
async def get_wiki():
    """Return the wiki manifest + section list for the active project."""
    wiki_dir = _wiki_dir()
    wiki_json = wiki_dir / "wiki.json"
    if not wiki_json.is_file():
        return {"generated": False, "sections": [],
                "message": "No wiki generated. Run 'loki wiki generate'."}
    data = _safe_json_read(wiki_json, default=None)
    if not isinstance(data, dict):
        raise HTTPException(status_code=500, detail="wiki.json unreadable")
    manifest = _safe_json_read(wiki_dir / "wiki-manifest.json", default={}) or {}
    sections = [
        {"id": s.get("id"), "title": s.get("title"),
         "citation_count": len(s.get("citations") or [])}
        for s in data.get("sections", [])
        if isinstance(s, dict)
    ]
    return {
        "generated": True,
        "project": data.get("project"),
        "generated_at": data.get("generated_at"),
        "file_count": data.get("file_count"),
        "signature": manifest.get("signature"),
        "sections": sections,
    }


@app.get("/api/wiki/{section}", dependencies=[Depends(auth.require_scope("read"))])
async def get_wiki_section(section: str):
    """Return one wiki section (body + validated file:line citations)."""
    if section not in _WIKI_SECTIONS:
        raise HTTPException(status_code=400, detail=f"unknown section: {section}")
    wiki_json = _wiki_dir() / "wiki.json"
    if not wiki_json.is_file():
        # Soft empty state for dashboard consumers on a fresh repo. A hard 404
        # here floods the browser console (the panel and the SPA both poll this)
        # even though "no wiki yet" is an expected, benign state. Mirrors the
        # generated:false contract of GET /api/wiki.
        return JSONResponse(content={
            "generated": False, "id": section, "title": "",
            "body": "", "citations": [],
        })
    data = _safe_json_read(wiki_json, default=None)
    if not isinstance(data, dict):
        raise HTTPException(status_code=500, detail="wiki.json unreadable")
    for s in data.get("sections", []):
        if isinstance(s, dict) and s.get("id") == section:
            return JSONResponse(content=s)
    raise HTTPException(status_code=404, detail=f"section not found: {section}")


class WikiAskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    k: int = Field(default=6, ge=1, le=20)


@app.post("/api/wiki/ask", dependencies=[Depends(auth.require_scope("read"))])
async def post_wiki_ask(req: WikiAskRequest):
    """Grounded, cited codebase Q&A.

    Shells out to autonomy/lib/wiki-ask.py (the single source of truth for the
    grounding + citation-validation contract) and returns its JSON. Every
    citation in the response resolves to a real file:line.
    """
    project_root = _project_root()
    repo_root = _Path(__file__).resolve().parent.parent
    ask_script = repo_root / "autonomy" / "lib" / "wiki-ask.py"
    if not ask_script.is_file():
        raise HTTPException(status_code=503, detail="wiki-ask backend missing")
    try:
        # Offload the blocking subprocess to a thread so the single-worker
        # uvicorn event loop stays responsive (liveness, status, WS heartbeat)
        # while wiki-ask runs (up to 180s). A direct subprocess.run here would
        # freeze the whole server; this read-scoped endpoint is reachable by any
        # reader. Mirrors the await asyncio.to_thread(...) pattern used by the
        # stop endpoints.
        proc = await asyncio.to_thread(
            lambda: subprocess.run(
                ["python3", str(ask_script), "--root", str(project_root),
                 "--question", req.question, "--k", str(req.k), "--json"],
                capture_output=True, text=True, timeout=180,
                cwd=str(project_root),
            )
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise HTTPException(status_code=503, detail=f"wiki ask failed: {e}")
    if proc.returncode == 3:
        return {"question": req.question, "answer": "",
                "citations": [], "note": "no relevant code found"}
    if proc.returncode != 0:
        raise HTTPException(status_code=500,
                            detail=(proc.stderr or "wiki ask error").strip())
    try:
        return JSONResponse(content=json.loads(proc.stdout))
    except json.JSONDecodeError:
        raise HTTPException(status_code=500, detail="wiki ask returned bad JSON")


# ---------------------------------------------------------------------------
# SPA catch-all: serve index.html for any path not matched by API routes
# or static asset mounts.  This lets the dashboard UI handle client-side routing.
# Must be registered LAST so it never shadows an API endpoint.
# ---------------------------------------------------------------------------
@app.get("/{full_path:path}", include_in_schema=False, dependencies=[Depends(auth.require_scope("read"))])
async def serve_spa_catchall(full_path: str):
    """Serve static files or fall back to index.html for SPA routing.

    v7.6.1 B-10 fix: requests under /api/, /lab/api/, or /ws/ that fall through
    here are missing routes, not SPA navigation. Returning index.html (text/html)
    silently masks 404s and breaks JSON clients (the dashboard UI's loki-memory-browser
    pinged /api/learning/metrics expecting JSON and got an HTML SPA on prior
    failures). Return a JSON 404 instead so clients fail loud.
    """
    # API paths that fell through are real 404s, not SPA routes.
    api_like = full_path.startswith("api/") or full_path.startswith("lab/api/") or full_path.startswith("ws/")
    if api_like:
        return JSONResponse(
            status_code=404,
            content={"error": "Not Found", "path": f"/{full_path}"},
        )
    if STATIC_DIR:
        static_root = os.path.realpath(STATIC_DIR)
        # Try to serve the exact file first (e.g. /vite.svg, /manifest.json)
        # Use realpath to prevent path traversal attacks
        candidate = os.path.realpath(os.path.join(STATIC_DIR, full_path))
        if not candidate.startswith(static_root + os.sep) and candidate != static_root:
            return Response(status_code=404)
        if os.path.isfile(candidate):
            return FileResponse(candidate)
        # Fall back to index.html for client-side routes
        index_path = os.path.join(STATIC_DIR, "index.html")
        if os.path.isfile(index_path):
            return FileResponse(index_path, media_type="text/html")
    return Response(status_code=404)


def run_server(host: str = None, port: int = None) -> None:
    """Run the dashboard server."""
    import uvicorn
    if host is None:
        # Default to localhost-only for security
        host = os.environ.get("LOKI_DASHBOARD_HOST", "127.0.0.1")
    if port is None:
        port = _safe_int_env("LOKI_DASHBOARD_PORT", 57374)

    uvicorn_kwargs = {
        "host": host,
        "port": port,
        "log_level": "info",
    }

    # Enable TLS if both cert and key are provided
    if LOKI_TLS_CERT and LOKI_TLS_KEY:
        uvicorn_kwargs["ssl_certfile"] = LOKI_TLS_CERT
        uvicorn_kwargs["ssl_keyfile"] = LOKI_TLS_KEY
        logger.info("TLS enabled: cert=%s key=%s", LOKI_TLS_CERT, LOKI_TLS_KEY)

    uvicorn.run(app, **uvicorn_kwargs)


if __name__ == "__main__":
    # Honor an explicit --port/--host on a direct module launch
    # (python -m dashboard.server --port N). The supported `loki dashboard start`
    # path sets LOKI_DASHBOARD_PORT in the environment and passes NO argv flags,
    # so it is unaffected. Previously --port was silently accepted and discarded,
    # binding the default 57374 and risking a collision with another project's
    # dashboard; now an unknown flag fails loudly via argparse (exit 2).
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m dashboard.server",
        description="Loki Mode dashboard server. The supported launcher is "
        "'loki dashboard start' (which uses LOKI_DASHBOARD_PORT / "
        "LOKI_DASHBOARD_HOST); these flags are for direct module launches.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=None,
        help="Port to bind (default: $LOKI_DASHBOARD_PORT or 57374).",
    )
    parser.add_argument(
        "--host",
        default=None,
        help="Host to bind (default: $LOKI_DASHBOARD_HOST or 127.0.0.1).",
    )
    _args = parser.parse_args()
    run_server(host=_args.host, port=_args.port)
