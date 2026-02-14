"""
FastAPI server for Loki Mode Dashboard.

Provides REST API and WebSocket endpoints for dashboard functionality.
"""

import asyncio
import json
import logging
import os
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path as _Path
from typing import Any, Optional
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
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
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
)
from . import registry
from . import auth
from . import audit
from . import secrets as secrets_mod
from . import telemetry as _telemetry

try:
    from . import __version__ as _version
except ImportError:
    _version = "5.39.0"

# ---------------------------------------------------------------------------
# TLS Configuration (optional - disabled by default)
# Set both LOKI_TLS_CERT and LOKI_TLS_KEY to enable HTTPS
# ---------------------------------------------------------------------------
LOKI_TLS_CERT = os.environ.get("LOKI_TLS_CERT", "")  # Path to PEM certificate
LOKI_TLS_KEY = os.environ.get("LOKI_TLS_KEY", "")    # Path to PEM private key

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

    def check(self, key: str) -> bool:
        now = time.time()
        # Prune old timestamps for this key
        self._calls[key] = [t for t in self._calls[key] if now - t < self._window]

        # Remove keys with empty timestamp lists
        empty_keys = [k for k, v in self._calls.items() if not v]
        for k in empty_keys:
            del self._calls[k]

        # Evict oldest keys if max_keys exceeded
        if len(self._calls) > self._max_keys:
            # Sort by oldest timestamp, remove oldest keys
            sorted_keys = sorted(
                self._calls.items(),
                key=lambda x: min(x[1]) if x[1] else 0
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

# Set up logging
logger = logging.getLogger(__name__)


# Pydantic schemas for API
class ProjectCreate(BaseModel):
    """Schema for creating a project."""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    prd_path: Optional[str] = None


class ProjectUpdate(BaseModel):
    """Schema for updating a project."""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    prd_path: Optional[str] = None
    status: Optional[str] = None


class ProjectResponse(BaseModel):
    """Schema for project response."""
    id: int
    name: str
    description: Optional[str]
    prd_path: Optional[str]
    status: str
    created_at: datetime
    updated_at: datetime
    task_count: int = 0
    completed_task_count: int = 0

    class Config:
        from_attributes = True


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


class TaskMove(BaseModel):
    """Schema for moving a task."""
    status: TaskStatus
    position: int


class TaskResponse(BaseModel):
    """Schema for task response."""
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

    class Config:
        from_attributes = True


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


# WebSocket connection manager
class ConnectionManager:
    """Manages WebSocket connections for real-time updates."""

    MAX_CONNECTIONS = int(os.environ.get("LOKI_MAX_WS_CONNECTIONS", "100"))

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        """Accept a new WebSocket connection."""
        if len(self.active_connections) >= self.MAX_CONNECTIONS:
            await websocket.accept()
            await websocket.close(code=1013, reason="Connection limit reached. Try again later.")
            logger.warning(f"WebSocket connection rejected: limit of {self.MAX_CONNECTIONS} reached")
            return
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        """Remove a WebSocket connection."""
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict[str, Any]) -> None:
        """Broadcast a message to all connected clients."""
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception as e:
                logger.debug(f"WebSocket send failed, client disconnected: {e}")
                disconnected.append(connection)
        # Clean up disconnected clients
        for conn in disconnected:
            self.disconnect(conn)

    async def send_personal(self, websocket: WebSocket, message: dict[str, Any]) -> None:
        """Send a message to a specific client."""
        try:
            await websocket.send_json(message)
        except Exception as e:
            logger.debug(f"WebSocket personal send failed: {e}")
            self.disconnect(websocket)


manager = ConnectionManager()
start_time = datetime.now(timezone.utc)


async def _orphan_watchdog():
    """Background task that shuts down dashboard if the parent session dies.

    When the session process is killed (SIGKILL), the cleanup trap never runs
    and the dashboard is left orphaned. This watchdog checks the session PID
    every 30 seconds and initiates shutdown if the session is gone.
    """
    loki_dir = _get_loki_dir()
    pid_file = loki_dir / "loki.pid"
    # Wait 60s before first check to let session fully start
    await asyncio.sleep(60)
    while True:
        try:
            if pid_file.exists():
                pid = int(pid_file.read_text().strip())
                try:
                    os.kill(pid, 0)  # Check if process exists
                except OSError:
                    # Session PID is dead -- we're orphaned
                    logger.warning(
                        "Session PID %d is gone. Dashboard shutting down to avoid orphan.", pid
                    )
                    # Clean up our own PID file
                    dash_pid = loki_dir / "dashboard" / "dashboard.pid"
                    dash_pid.unlink(missing_ok=True)
                    # Give a moment for any in-flight requests
                    await asyncio.sleep(2)
                    os._exit(0)
            # If PID file doesn't exist and we've been running >2 min, also shut down
            elif time.time() - _dashboard_start_time > 120:
                logger.warning("No session PID file found. Dashboard shutting down.")
                os._exit(0)
        except (ValueError, OSError):
            pass
        await asyncio.sleep(30)


_dashboard_start_time = time.time()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup
    await init_db()
    _telemetry.send_telemetry("dashboard_start")
    # Start orphan watchdog
    watchdog_task = asyncio.create_task(_orphan_watchdog())
    yield
    # Shutdown
    watchdog_task.cancel()
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
if _cors_raw.strip() == "*":
    logger.warning(
        "LOKI_DASHBOARD_CORS is set to '*' -- all origins are allowed. "
        "This is insecure for production deployments."
    )
_cors_origins = _cors_raw.split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins if o.strip()],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Requested-With"],
)

# Static file serving is configured at the end of the file (after all API routes)


# Health endpoint
@app.get("/health")
async def health_check() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "healthy", "service": "loki-dashboard"}


# Status endpoint - reads from .loki/ flat files (primary) + DB (fallback)
@app.get("/api/status", response_model=StatusResponse)
async def get_status() -> StatusResponse:
    """Get system status from .loki/ session files."""
    loki_dir = _get_loki_dir()
    uptime = (datetime.now(timezone.utc) - start_time).total_seconds()

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
    version = "unknown"

    # Read VERSION file
    dashboard_dir = os.path.dirname(__file__)
    project_root = os.path.dirname(dashboard_dir)
    version_file = os.path.join(project_root, "VERSION")
    if os.path.isfile(version_file):
        try:
            with open(version_file) as vf:
                version = vf.read().strip()
        except (OSError, IOError) as e:
            logger.warning(f"Failed to read VERSION file: {e}")

    # Read dashboard state
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
            phase = state.get("phase", "")
            iteration = state.get("iteration", 0)
            complexity = state.get("complexity", "standard")
            mode = state.get("mode", "")
            running_agents = len(state.get("agents", []))

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
    if not running and session_file.exists():
        try:
            sd = json.loads(session_file.read_text())
            if sd.get("status") == "running":
                running = True
        except (json.JSONDecodeError, KeyError):
            pass

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

    return StatusResponse(
        status=status,
        version=version,
        uptime_seconds=uptime,
        active_sessions=1 if running else 0,
        running_agents=running_agents,
        pending_tasks=pending_tasks,
        database_connected=True,
        phase=phase,
        iteration=iteration,
        complexity=complexity,
        mode=mode,
        provider=provider,
        current_task=current_task,
    )


# Project endpoints
@app.get("/api/projects", response_model=list[ProjectResponse])
async def list_projects(
    status: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
) -> list[ProjectResponse]:
    """List all projects."""
    query = select(Project).options(selectinload(Project.tasks))
    if status:
        query = query.where(Project.status == status)
    query = query.order_by(Project.created_at.desc())

    result = await db.execute(query)
    projects = result.scalars().all()

    response = []
    for project in projects:
        task_count = len(project.tasks)
        completed_count = len([t for t in project.tasks if t.status == TaskStatus.DONE])
        response.append(
            ProjectResponse(
                id=project.id,
                name=project.name,
                description=project.description,
                prd_path=project.prd_path,
                status=project.status,
                created_at=project.created_at,
                updated_at=project.updated_at,
                task_count=task_count,
                completed_task_count=completed_count,
            )
        )
    return response


@app.post("/api/projects", response_model=ProjectResponse, status_code=201)
async def create_project(
    project: ProjectCreate,
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    """Create a new project."""
    db_project = Project(
        name=project.name,
        description=project.description,
        prd_path=project.prd_path,
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
        created_at=db_project.created_at,
        updated_at=db_project.updated_at,
        task_count=0,
        completed_task_count=0,
    )


@app.get("/api/projects/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    """Get a project by ID."""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.tasks))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    task_count = len(project.tasks)
    completed_count = len([t for t in project.tasks if t.status == TaskStatus.DONE])

    return ProjectResponse(
        id=project.id,
        name=project.name,
        description=project.description,
        prd_path=project.prd_path,
        status=project.status,
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
) -> ProjectResponse:
    """Update a project."""
    result = await db.execute(
        select(Project)
        .options(selectinload(Project.tasks))
        .where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

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
) -> None:
    """Delete a project."""
    result = await db.execute(
        select(Project).where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

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


# Task endpoints - reads from .loki/dashboard-state.json
@app.get("/api/tasks")
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
                    all_tasks.append({
                        "id": task_id,
                        "title": task.get("title", payload.get("action", task.get("type", "Task"))),
                        "description": payload.get("description", ""),
                        "status": mapped_status,
                        "priority": payload.get("priority", "medium"),
                        "type": task.get("type", "task"),
                        "position": i,
                    })
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
                    items = json.loads(fpath.read_text())
                    if isinstance(items, list):
                        for i, item in enumerate(items):
                            if isinstance(item, dict):
                                tid = item.get("id", f"q-{q_status}-{i}")
                                # Skip if already in all_tasks
                                if any(t["id"] == tid for t in all_tasks):
                                    continue
                                all_tasks.append({
                                    "id": tid,
                                    "title": item.get("title", item.get("action", "Task")),
                                    "description": item.get("description", ""),
                                    "status": q_status,
                                    "priority": item.get("priority", "medium"),
                                    "type": item.get("type", "task"),
                                    "position": i,
                                })
                except (json.JSONDecodeError, KeyError):
                    pass

    # Apply status filter if provided
    if status:
        all_tasks = [t for t in all_tasks if t["status"] == status]

    return all_tasks


@app.post("/api/tasks", response_model=TaskResponse, status_code=201)
async def create_task(
    task: TaskCreate,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    """Create a new task."""
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
        if not result.scalar_one_or_none():
            raise HTTPException(
                status_code=400,
                detail="Parent task not found or belongs to different project"
            )

    db_task = Task(
        project_id=task.project_id,
        title=task.title,
        description=task.description,
        status=task.status,
        priority=task.priority,
        position=task.position,
        parent_task_id=task.parent_task_id,
        estimated_duration=task.estimated_duration,
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

    return TaskResponse.model_validate(db_task)


@app.get("/api/tasks/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    """Get a task by ID."""
    result = await db.execute(
        select(Task).where(Task.id == task_id)
    )
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    return TaskResponse.model_validate(task)


@app.put("/api/tasks/{task_id}", response_model=TaskResponse, dependencies=[Depends(auth.require_scope("control"))])
async def update_task(
    task_id: int,
    task_update: TaskUpdate,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    """Update a task."""
    result = await db.execute(
        select(Task).where(Task.id == task_id)
    )
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    update_data = task_update.model_dump(exclude_unset=True)

    # Handle status change to completed
    if "status" in update_data and update_data["status"] == TaskStatus.DONE:
        update_data["completed_at"] = datetime.now(timezone.utc)

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

    return TaskResponse.model_validate(task)


@app.delete("/api/tasks/{task_id}", status_code=204, dependencies=[Depends(auth.require_scope("control"))])
async def delete_task(
    task_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a task."""
    result = await db.execute(
        select(Task).where(Task.id == task_id)
    )
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

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


@app.post("/api/tasks/{task_id}/move", response_model=TaskResponse, dependencies=[Depends(auth.require_scope("control"))])
async def move_task(
    task_id: int,
    move: TaskMove,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    """Move a task to a new status/position (for Kanban drag-and-drop)."""
    result = await db.execute(
        select(Task).where(Task.id == task_id)
    )
    task = result.scalar_one_or_none()

    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    old_status = task.status
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

    return TaskResponse.model_validate(task)


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

    # Rate limit WebSocket connections by IP
    client_ip = websocket.client.host if websocket.client else "unknown"
    if not _read_limiter.check(f"ws_{client_ip}"):
        await websocket.close(code=1008)  # Policy Violation
        return

    if auth.is_enterprise_mode() or auth.is_oidc_mode():
        ws_token: Optional[str] = websocket.query_params.get("token")
        if not ws_token:
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
            await websocket.close(code=1008)  # Policy Violation
            return

    await manager.connect(websocket)
    try:
        # Send initial connection confirmation
        await manager.send_personal(websocket, {
            "type": "connected",
            "data": {"message": "Connected to Loki Dashboard"},
        })

        # Keep connection alive and handle incoming messages
        while True:
            try:
                data = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=30.0  # Ping every 30 seconds
                )
                # Handle incoming messages (e.g., subscriptions)
                try:
                    message = json.loads(data)
                    if message.get("type") == "ping":
                        await manager.send_personal(websocket, {"type": "pong"})
                    elif message.get("type") == "subscribe":
                        # Could implement channel subscriptions here
                        await manager.send_personal(websocket, {
                            "type": "subscribed",
                            "data": message.get("data", {}),
                        })
                except json.JSONDecodeError as e:
                    logger.debug(f"WebSocket received invalid JSON: {e}")
            except asyncio.TimeoutError:
                # Send keepalive ping
                await manager.send_personal(websocket, {"type": "ping"})

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
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


@app.get("/api/registry/projects", response_model=list[RegisteredProjectResponse])
async def list_registered_projects(include_inactive: bool = False):
    """List all registered projects."""
    projects = registry.list_projects(include_inactive=include_inactive)
    return projects


@app.post("/api/registry/projects", response_model=RegisteredProjectResponse, status_code=201)
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


@app.get("/api/registry/projects/{identifier}", response_model=RegisteredProjectResponse)
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


@app.get("/api/registry/projects/{identifier}/health", response_model=HealthResponse)
async def get_project_health(identifier: str):
    """Check the health of a registered project."""
    health = registry.check_project_health(identifier)
    if health["status"] == "not_found":
        raise HTTPException(status_code=404, detail="Project not found in registry")
    return health


@app.post("/api/registry/projects/{identifier}/access")
async def update_project_access(identifier: str):
    """Update the last accessed timestamp for a project."""
    project = registry.update_last_accessed(identifier)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found in registry")
    return project


@app.get("/api/registry/discover", response_model=list[DiscoverResponse])
async def discover_projects(max_depth: int = Query(default=3, ge=1, le=10)):
    """Discover projects with .loki directories."""
    max_depth = min(max_depth, 10)
    discovered = registry.discover_projects(max_depth=max_depth)
    return discovered


@app.post("/api/registry/sync", response_model=SyncResponse)
async def sync_registry():
    """Sync the registry with discovered projects."""
    if not _read_limiter.check("registry_sync"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    result = registry.sync_registry_with_discovery()
    return {
        "added": result["added"],
        "updated": result["updated"],
        "missing": result["missing"],
        "total": result["total"],
    }


@app.get("/api/registry/tasks")
async def get_cross_project_tasks(project_ids: Optional[str] = None):
    """Get tasks from multiple projects for unified view."""
    ids = project_ids.split(",") if project_ids else None
    tasks = registry.get_cross_project_tasks(ids)
    return tasks


@app.get("/api/registry/learnings")
async def get_cross_project_learnings():
    """Get learnings from the global learnings database."""
    learnings = registry.get_cross_project_learnings()
    return learnings


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


@app.post("/api/enterprise/tokens", response_model=TokenResponse, status_code=201)
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


@app.get("/api/enterprise/tokens", response_model=list[TokenResponse])
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


@app.get("/api/enterprise/audit")
async def query_audit_logs(
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    action: Optional[str] = None,
    resource_type: Optional[str] = None,
    resource_id: Optional[str] = None,
    limit: int = 100,
    offset: int = 0,
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


@app.get("/api/enterprise/audit/summary")
async def get_audit_summary(days: int = 7):
    """Get audit activity summary."""
    if not audit.is_audit_enabled():
        raise HTTPException(
            status_code=403,
            detail="Audit logging is disabled. Remove LOKI_AUDIT_DISABLED or set LOKI_ENTERPRISE_AUDIT=true"
        )

    return audit.get_audit_summary(days=days)


# =============================================================================
# File-based Session Endpoints (reads from .loki/ flat files)
# =============================================================================

def _get_loki_dir() -> _Path:
    """Get LOKI_DIR, refreshing from env on each call for consistency."""
    return _Path(os.environ.get("LOKI_DIR", ".loki"))


_SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_-]+$')


def _sanitize_agent_id(agent_id: str) -> str:
    """Validate agent_id contains only safe characters for file paths."""
    if not agent_id or len(agent_id) > 128 or ".." in agent_id or not _SAFE_ID_RE.match(agent_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid agent_id: must be 1-128 chars of alphanumeric, hyphens, and underscores",
        )
    return agent_id

@app.get("/api/memory/summary")
async def get_memory_summary():
    """Get memory system summary from .loki/memory/."""
    memory_dir = _get_loki_dir() / "memory"
    summary = {
        "episodic": {"count": 0, "latestDate": None},
        "semantic": {"patterns": 0, "antiPatterns": 0},
        "procedural": {"skills": 0},
        "tokenEconomics": {"discoveryTokens": 0, "readTokens": 0, "savingsPercent": 0},
    }

    # Count episodic memories
    ep_dir = memory_dir / "episodic"
    if ep_dir.exists():
        episodes = sorted(ep_dir.glob("*.json"))
        summary["episodic"]["count"] = len(episodes)
        if episodes:
            try:
                latest = json.loads(episodes[-1].read_text())
                summary["episodic"]["latestDate"] = latest.get("timestamp", "")
            except Exception:
                pass

    # Count semantic patterns
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

    # Count skills
    skills_dir = memory_dir / "skills"
    if skills_dir.exists():
        summary["procedural"]["skills"] = len(list(skills_dir.glob("*.json")))

    # Token economics
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


@app.get("/api/memory/episodes")
async def list_episodes(limit: int = 50):
    """List episodic memory entries."""
    ep_dir = _get_loki_dir() / "memory" / "episodic"
    episodes = []
    if ep_dir.exists():
        files = sorted(ep_dir.glob("*.json"), reverse=True)[:limit]
        for f in files:
            try:
                episodes.append(json.loads(f.read_text()))
            except Exception:
                pass
    return episodes


@app.get("/api/memory/episodes/{episode_id}")
async def get_episode(episode_id: str):
    """Get a specific episodic memory entry."""
    ep_dir = _get_loki_dir() / "memory" / "episodic"
    if not ep_dir.exists():
        raise HTTPException(status_code=404, detail="Episode not found")
    # Try direct filename match
    for f in ep_dir.glob("*.json"):
        try:
            data = json.loads(f.read_text())
            if data.get("id") == episode_id or f.stem == episode_id:
                return data
        except Exception:
            pass
    raise HTTPException(status_code=404, detail="Episode not found")


@app.get("/api/memory/patterns")
async def list_patterns():
    """List semantic patterns."""
    sem_dir = _get_loki_dir() / "memory" / "semantic"
    patterns_file = sem_dir / "patterns.json"
    if patterns_file.exists():
        try:
            data = json.loads(patterns_file.read_text())
            return data if isinstance(data, list) else data.get("patterns", [])
        except Exception:
            pass
    return []


@app.get("/api/memory/patterns/{pattern_id}")
async def get_pattern(pattern_id: str):
    """Get a specific semantic pattern."""
    patterns = await list_patterns()
    for p in patterns:
        if p.get("id") == pattern_id:
            return p
    raise HTTPException(status_code=404, detail="Pattern not found")


@app.get("/api/memory/skills")
async def list_skills():
    """List procedural skills."""
    skills_dir = _get_loki_dir() / "memory" / "skills"
    skills = []
    if skills_dir.exists():
        for f in sorted(skills_dir.glob("*.json")):
            try:
                skills.append(json.loads(f.read_text()))
            except Exception:
                pass
    return skills


@app.get("/api/memory/skills/{skill_id}")
async def get_skill(skill_id: str):
    """Get a specific procedural skill."""
    skills_dir = _get_loki_dir() / "memory" / "skills"
    if not skills_dir.exists():
        raise HTTPException(status_code=404, detail="Skill not found")
    for f in skills_dir.glob("*.json"):
        try:
            data = json.loads(f.read_text())
            if data.get("id") == skill_id or f.stem == skill_id:
                return data
        except Exception:
            pass
    raise HTTPException(status_code=404, detail="Skill not found")


@app.get("/api/memory/economics")
async def get_token_economics():
    """Get token usage economics."""
    econ_file = _get_loki_dir() / "memory" / "token_economics.json"
    if econ_file.exists():
        try:
            return json.loads(econ_file.read_text())
        except Exception:
            pass
    return {"discoveryTokens": 0, "readTokens": 0, "savingsPercent": 0}


@app.post("/api/memory/consolidate", dependencies=[Depends(auth.require_scope("control"))])
async def consolidate_memory(hours: int = 24):
    """Trigger memory consolidation (stub - returns current state)."""
    return {"status": "ok", "message": f"Consolidation for last {hours}h", "consolidated": 0, "patternsCreated": 0, "patternsMerged": 0, "episodesProcessed": 0}


@app.post("/api/memory/retrieve")
async def retrieve_memory(query: dict = None):
    """Search memories by query."""
    return {"results": [], "query": query}


@app.get("/api/memory/index")
async def get_memory_index():
    """Get memory index (Layer 1 - lightweight discovery)."""
    index_file = _get_loki_dir() / "memory" / "index.json"
    if index_file.exists():
        try:
            return json.loads(index_file.read_text())
        except Exception:
            pass
    return {"topics": [], "lastUpdated": None}


@app.get("/api/memory/timeline")
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


# Learning/metrics endpoints


def _read_learning_signals(signal_type: Optional[str] = None, limit: int = 50) -> list:
    """Read learning signals from .loki/learning/signals/*.json files.

    Learning signals are written as individual JSON files by the learning emitter
    (learning/emitter.py). Each file contains a single signal object with fields:
    id, type, source, action, timestamp, confidence, outcome, data, context.
    """
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


@app.get("/api/learning/metrics")
async def get_learning_metrics(
    timeRange: str = "7d",
    signalType: Optional[str] = None,
    source: Optional[str] = None,
):
    """Get learning metrics from events, metrics files, and learning signals."""
    events = _read_events(timeRange)

    # Also read from learning signals directory
    all_signals = _read_learning_signals(limit=10000)

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

    # Calculate average confidence across both sources
    total_conf = sum(e.get("data", {}).get("confidence", 0) for e in events)
    total_conf += sum(s.get("confidence", 0) for s in all_signals)

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


@app.get("/api/learning/trends")
async def get_learning_trends(
    timeRange: str = "7d",
    signalType: Optional[str] = None,
    source: Optional[str] = None,
):
    """Get learning trend data."""
    events = _read_events(timeRange)
    # Group by hour for trend data
    by_hour: dict = {}
    for e in events:
        ts = e.get("timestamp", "")[:13]  # YYYY-MM-DDTHH
        by_hour[ts] = by_hour.get(ts, 0) + 1

    data_points = [{"label": k, "count": v} for k, v in sorted(by_hour.items())]
    max_val = max((d["count"] for d in data_points), default=0)

    return {"dataPoints": data_points, "maxValue": max_val, "period": timeRange}


@app.get("/api/learning/signals")
async def get_learning_signals(
    timeRange: str = "7d",
    signalType: Optional[str] = None,
    source: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
):
    """Get raw learning signals from both events.jsonl and learning signals directory."""
    events = _read_events(timeRange)
    if signalType:
        events = [e for e in events if e.get("type") == signalType]
    if source:
        events = [e for e in events if e.get("data", {}).get("source") == source]

    # Also read from learning signals directory
    file_signals = _read_learning_signals(signal_type=signalType, limit=10000)
    if source:
        file_signals = [s for s in file_signals if s.get("source") == source]

    # Merge and sort by timestamp (newest first)
    combined = events + file_signals
    combined.sort(key=lambda s: s.get("timestamp", ""), reverse=True)
    return combined[offset:offset + limit]


@app.get("/api/learning/aggregation")
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
    success_signals = _read_learning_signals(signal_type="success_pattern", limit=500)
    tool_signals = _read_learning_signals(signal_type="tool_efficiency", limit=500)
    error_signals = _read_learning_signals(signal_type="error_pattern", limit=500)
    pref_signals = _read_learning_signals(signal_type="user_preference", limit=500)

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
async def trigger_aggregation():
    """Aggregate learning signals from events.jsonl into structured metrics."""
    if not _read_limiter.check("learning_aggregate"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    events_file = _get_loki_dir() / "events.jsonl"
    preferences: dict = {}
    error_patterns: dict = {}
    success_patterns: dict = {}
    tool_stats: dict = {}  # tool_name -> {"count": N, "total_ms": N, "successes": N}

    if events_file.exists():
        try:
            for raw_line in events_file.read_text().strip().split("\n"):
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


@app.get("/api/learning/preferences")
async def get_learning_preferences(limit: int = 50):
    """Get aggregated user preferences from events and learning signals directory."""
    events = _read_events("30d")
    prefs = [e for e in events if e.get("type") == "user_preference"]
    # Also read from learning signals directory
    file_prefs = _read_learning_signals(signal_type="user_preference", limit=limit)
    combined = prefs + file_prefs
    combined.sort(key=lambda s: s.get("timestamp", ""), reverse=True)
    return combined[:limit]


@app.get("/api/learning/errors")
async def get_learning_errors(limit: int = 50):
    """Get aggregated error patterns from events and learning signals directory."""
    events = _read_events("30d")
    errors = [e for e in events if e.get("type") == "error_pattern"]
    # Also read from learning signals directory
    file_errors = _read_learning_signals(signal_type="error_pattern", limit=limit)
    combined = errors + file_errors
    combined.sort(key=lambda s: s.get("timestamp", ""), reverse=True)
    return combined[:limit]


@app.get("/api/learning/success")
async def get_learning_success(limit: int = 50):
    """Get aggregated success patterns from events and learning signals directory."""
    events = _read_events("30d")
    successes = [e for e in events if e.get("type") == "success_pattern"]
    # Also read from learning signals directory
    file_successes = _read_learning_signals(signal_type="success_pattern", limit=limit)
    combined = successes + file_successes
    combined.sort(key=lambda s: s.get("timestamp", ""), reverse=True)
    return combined[:limit]


@app.get("/api/learning/tools")
async def get_tool_efficiency(limit: int = 50):
    """Get tool efficiency rankings from events and learning signals directory."""
    events = _read_events("30d")
    tools = [e for e in events if e.get("type") == "tool_efficiency"]
    # Also read from learning signals directory
    file_tools = _read_learning_signals(signal_type="tool_efficiency", limit=limit)
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


def _read_events(time_range: str = "7d", max_events: int = 10000) -> list:
    """Read events from .loki/events.jsonl with time filter and size limits."""
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
    pause_file = _get_loki_dir() / "PAUSE"
    pause_file.parent.mkdir(parents=True, exist_ok=True)
    pause_file.write_text(datetime.now(timezone.utc).isoformat())
    return {"success": True, "message": "Session paused"}


@app.post("/api/control/resume", dependencies=[Depends(auth.require_scope("control"))])
async def resume_session():
    """Resume a paused session by removing PAUSE/STOP files."""
    if not _control_limiter.check("control"):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    for fname in ["PAUSE", "STOP"]:
        fpath = _get_loki_dir() / fname
        try:
            fpath.unlink(missing_ok=True)
        except Exception:
            pass
    return {"success": True, "message": "Session resumed"}


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

    # Try to kill the process
    pid_file = _get_loki_dir() / "loki.pid"
    if pid_file.exists():
        try:
            pid = int(pid_file.read_text().strip())
            os.kill(pid, 15)  # SIGTERM
        except (ValueError, OSError, ProcessLookupError):
            pass

    # Mark session.json as stopped
    session_file = _get_loki_dir() / "session.json"
    if session_file.exists():
        try:
            sd = json.loads(session_file.read_text())
            sd["status"] = "stopped"
            session_file.write_text(json.dumps(sd))
        except Exception:
            pass

    return {"success": True, "message": "Stop signal sent"}


# =============================================================================
# Cost Visibility API
# =============================================================================

# Static fallback pricing per million tokens (USD) - updated 2026-02-07
# At runtime, overridden by .loki/pricing.json if available
_DEFAULT_PRICING = {
    # Claude (Anthropic)
    "opus":   {"input": 5.00, "output": 25.00},
    "sonnet": {"input": 3.00, "output": 15.00},
    "haiku":  {"input": 1.00, "output": 5.00},
    # OpenAI Codex
    "gpt-5.3-codex": {"input": 1.50, "output": 12.00},
    # Google Gemini
    "gemini-3-pro":  {"input": 1.25, "output": 10.00},
    "gemini-3-flash": {"input": 0.10, "output": 0.40},
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
    return input_cost + output_cost


@app.get("/api/cost")
async def get_cost():
    """Get cost visibility data from .loki/metrics/efficiency/ and budget.json."""
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

    # Read efficiency files (one JSON file per iteration/task)
    if efficiency_dir.exists():
        for eff_file in sorted(efficiency_dir.glob("*.json")):
            try:
                data = json.loads(eff_file.read_text())

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
            except (json.JSONDecodeError, KeyError, TypeError):
                pass

    # Fallback: read from context tracking if efficiency files have no token data
    if total_input == 0 and total_output == 0:
        ctx_file = loki_dir / "context" / "tracking.json"
        if ctx_file.exists():
            try:
                ctx = json.loads(ctx_file.read_text())
                totals = ctx.get("totals", {})
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
            except (json.JSONDecodeError, KeyError):
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
        "estimated_cost_usd": round(estimated_cost, 4),
        "by_phase": by_phase,
        "by_model": {k: {
            "input_tokens": v["input_tokens"],
            "output_tokens": v["output_tokens"],
            "cost_usd": round(v["cost_usd"], 4),
        } for k, v in by_model.items()},
        "budget_limit": budget_limit,
        "budget_used": round(budget_used, 4) if budget_limit is not None else None,
        "budget_remaining": round(budget_remaining, 4) if budget_remaining is not None else None,
    }


@app.get("/api/budget")
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

    remaining = None
    if budget_limit is not None:
        remaining = max(0.0, float(budget_limit) - float(budget_used))

    return {
        "budget_limit": float(budget_limit) if budget_limit is not None else None,
        "current_cost": round(float(budget_used), 4),
        "exceeded": exceeded,
        "exceeded_at": exceeded_at,
        "remaining": round(remaining, 4) if remaining is not None else None,
    }


# =============================================================================
# Pricing API
# =============================================================================

_PROVIDER_LABELS = {
    "opus": "Opus 4.6",
    "sonnet": "Sonnet 4.5",
    "haiku": "Haiku 4.5",
    "gpt-5.3-codex": "GPT-5.3 Codex",
    "gemini-3-pro": "Gemini 3 Pro",
    "gemini-3-flash": "Gemini 3 Flash",
}

_MODEL_PROVIDERS = {
    "opus": "claude",
    "sonnet": "claude",
    "haiku": "claude",
    "gpt-5.3-codex": "codex",
    "gemini-3-pro": "gemini",
    "gemini-3-flash": "gemini",
}


@app.get("/api/pricing")
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
        models[model_key] = {
            "input": rates["input"],
            "output": rates["output"],
            "label": _PROVIDER_LABELS.get(model_key, model_key),
            "provider": _MODEL_PROVIDERS.get(model_key, "unknown"),
        }

    return {
        "provider": provider,
        "updated": "2026-02-07",
        "source": "static",
        "models": models,
    }


# =============================================================================
# Completion Council API (v5.25.0)
# =============================================================================

@app.get("/api/council/state")
async def get_council_state():
    """Get current Completion Council state."""
    state_file = _get_loki_dir() / "council" / "state.json"
    if state_file.exists():
        try:
            return json.loads(state_file.read_text())
        except Exception:
            pass
    return {"enabled": False, "total_votes": 0, "verdicts": []}


@app.get("/api/council/verdicts")
async def get_council_verdicts(limit: int = 20):
    """Get council vote history (decision log)."""
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


@app.get("/api/council/convergence")
async def get_council_convergence():
    """Get convergence tracking data for visualization."""
    convergence_file = _get_loki_dir() / "council" / "convergence.log"
    data_points = []
    if convergence_file.exists():
        try:
            for line in convergence_file.read_text().strip().split("\n"):
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
            pass
    return {"dataPoints": data_points}


@app.get("/api/council/report")
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


# =============================================================================
# Context Window Tracking API (v5.40.0)
# =============================================================================

@app.get("/api/context")
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

@app.get("/api/notifications")
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


@app.get("/api/notifications/triggers")
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


@app.get("/api/checkpoints")
async def list_checkpoints(limit: int = Query(default=20, ge=1, le=200)):
    """List recent checkpoints from index.jsonl."""
    loki_dir = _get_loki_dir()
    index_file = loki_dir / "state" / "checkpoints" / "index.jsonl"
    checkpoints = []

    if index_file.exists():
        try:
            for line in index_file.read_text().strip().split("\n"):
                if line.strip():
                    try:
                        checkpoints.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
        except Exception:
            pass

    # Return most recent first, limited
    checkpoints.reverse()
    return checkpoints[:limit]


@app.get("/api/checkpoints/{checkpoint_id}")
async def get_checkpoint(checkpoint_id: str):
    """Get checkpoint details by ID."""
    checkpoint_id = _sanitize_checkpoint_id(checkpoint_id)
    loki_dir = _get_loki_dir()
    metadata_file = loki_dir / "state" / "checkpoints" / checkpoint_id / "metadata.json"

    if not metadata_file.exists():
        raise HTTPException(status_code=404, detail="Checkpoint not found")

    try:
        return json.loads(metadata_file.read_text())
    except (json.JSONDecodeError, IOError) as e:
        raise HTTPException(status_code=500, detail=f"Failed to read checkpoint: {e}")


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

    # Capture git SHA
    git_sha = ""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5,
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

    # Copy queue directory if present
    queue_src = loki_dir / "queue"
    if queue_src.exists():
        try:
            shutil.copytree(str(queue_src), str(checkpoint_dir / "queue"), dirs_exist_ok=True)
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


# =============================================================================
# Agent Management API (v5.25.0)
# =============================================================================

@app.get("/api/agents")
async def get_agents(token: Optional[dict] = Depends(auth.get_current_token)):
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


@app.get("/api/logs")
async def get_logs(lines: int = 100, token: Optional[dict] = Depends(auth.get_current_token)):
    """Get recent log entries from session log files."""
    log_dir = _get_loki_dir() / "logs"
    entries = []

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
                content = log_file.read_text()
                for raw_line in content.strip().split("\n")[-lines:]:
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
                        "message": message,
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


@app.get("/api/github/status")
async def get_github_status(token: Optional[dict] = Depends(auth.get_current_token)):
    """Get GitHub integration status and configuration."""
    loki_dir = _get_loki_dir()
    result: dict[str, Any] = {
        "import_enabled": os.environ.get("LOKI_GITHUB_IMPORT", "false") == "true",
        "sync_enabled": os.environ.get("LOKI_GITHUB_SYNC", "false") == "true",
        "pr_enabled": os.environ.get("LOKI_GITHUB_PR", "false") == "true",
        "labels_filter": os.environ.get("LOKI_GITHUB_LABELS", ""),
        "milestone_filter": os.environ.get("LOKI_GITHUB_MILESTONE", ""),
        "limit": int(os.environ.get("LOKI_GITHUB_LIMIT", "100")),
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
        url = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True, text=True, timeout=5,
            cwd=str(loki_dir.parent) if loki_dir.name == ".loki" else None
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


@app.get("/api/github/tasks")
async def get_github_tasks(token: Optional[dict] = Depends(auth.get_current_token)):
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


@app.get("/api/github/sync-log")
async def get_github_sync_log(
    limit: int = Query(default=50, ge=1, le=500),
    token: Optional[dict] = Depends(auth.get_current_token)
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


@app.get("/api/health/processes")
async def get_process_health(token: Optional[dict] = Depends(auth.get_current_token)):
    """Get health status of all loki processes (dashboard, session, agents)."""
    result: dict[str, Any] = {"dashboard": None, "session": None, "agents": []}

    loki_dir = _get_loki_dir()

    # Dashboard PID
    dpid_file = loki_dir / "dashboard" / "dashboard.pid"
    if dpid_file.exists():
        try:
            dpid = int(dpid_file.read_text().strip())
            try:
                os.kill(dpid, 0)
                result["dashboard"] = {"pid": dpid, "status": "alive"}
            except OSError:
                result["dashboard"] = {"pid": dpid, "status": "dead"}
        except (ValueError, OSError):
            pass

    # Session PID
    spid_file = loki_dir / "loki.pid"
    if spid_file.exists():
        try:
            spid = int(spid_file.read_text().strip())
            try:
                os.kill(spid, 0)
                result["session"] = {"pid": spid, "status": "alive"}
            except OSError:
                result["session"] = {"pid": spid, "status": "dead"}
        except (ValueError, OSError):
            pass

    # Agent PIDs
    agents_file = loki_dir / "state" / "agents.json"
    if agents_file.exists():
        try:
            agents = json.loads(agents_file.read_text())
            for agent in agents:
                pid = agent.get("pid")
                status = "unknown"
                if pid:
                    try:
                        os.kill(int(pid), 0)
                        status = "alive"
                    except (OSError, ValueError):
                        status = "dead"
                result["agents"].append({
                    "id": agent.get("id", ""),
                    "name": agent.get("name", ""),
                    "pid": pid,
                    "status": status,
                })
        except Exception:
            pass

    watchdog_enabled = os.environ.get("LOKI_WATCHDOG", "false").lower() == "true"
    result["watchdog_enabled"] = watchdog_enabled

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
    max_iterations = int(os.environ.get("LOKI_MAX_ITERATIONS", "1000"))
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
                    cost = data.get("cost_usd")
                    if cost is not None:
                        estimated_cost += float(cost)
                    else:
                        inp = data.get("input_tokens", 0)
                        out = data.get("output_tokens", 0)
                        estimated_cost += _calculate_model_cost(
                            data.get("model", "sonnet").lower(), inp, out
                        )
                except (json.JSONDecodeError, KeyError, TypeError):
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

# Serve favicon.svg from static directory
@app.get("/favicon.svg", include_in_schema=False)
async def serve_favicon():
    """Serve the dashboard favicon."""
    if STATIC_DIR:
        favicon_path = os.path.join(STATIC_DIR, "favicon.svg")
        if os.path.isfile(favicon_path):
            return FileResponse(favicon_path, media_type="image/svg+xml")
    return Response(status_code=404)


# Serve index.html or standalone HTML for root
@app.get("/", include_in_schema=False)
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

    # Return helpful error message
    return HTMLResponse(
        content="""
        <html>
        <head><title>Loki Dashboard</title></head>
        <body style="font-family: system-ui; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1>Dashboard Frontend Not Found</h1>
            <p>The dashboard API is running, but the frontend files were not found.</p>
            <p>To fix this, run:</p>
            <pre style="background: #f5f5f5; padding: 15px; border-radius: 5px;">cd dashboard-ui && npm run build</pre>
            <p><strong>API Endpoints:</strong></p>
            <ul>
                <li><a href="/health">/health</a> - Health check</li>
                <li><a href="/docs">/docs</a> - API documentation</li>
            </ul>
        </body>
        </html>
        """,
        status_code=200
    )


def run_server(host: str = None, port: int = None) -> None:
    """Run the dashboard server."""
    import uvicorn
    if host is None:
        # Default to localhost-only for security
        host = os.environ.get("LOKI_DASHBOARD_HOST", "127.0.0.1")
    if port is None:
        port = int(os.environ.get("LOKI_DASHBOARD_PORT", "57374"))

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
    run_server()
