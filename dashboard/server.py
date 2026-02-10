"""
FastAPI server for Loki Mode Dashboard.

Provides REST API and WebSocket endpoints for dashboard functionality.
"""

import asyncio
import json
import logging
import os
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
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
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

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        """Accept a new WebSocket connection."""
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
start_time = datetime.now()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup
    await init_db()
    yield
    # Shutdown
    await close_db()


# Create FastAPI app
app = FastAPI(
    title="Loki Mode Dashboard API",
    description="REST API for Loki Mode project and task management",
    version="0.1.0",
    lifespan=lifespan,
)

# Add CORS middleware - allow_origins=* is safe because server binds to
# 127.0.0.1 by default. Set LOKI_DASHBOARD_HOST to override if LAN access needed.
_cors_origins = os.environ.get("CORS_ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
    uptime = (datetime.now() - start_time).total_seconds()

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


@app.put("/api/projects/{project_id}", response_model=ProjectResponse)
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


@app.delete("/api/projects/{project_id}", status_code=204)
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
) -> None:
    """Delete a project."""
    result = await db.execute(
        select(Project).where(Project.id == project_id)
    )
    project = result.scalar_one_or_none()

    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

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


@app.put("/api/tasks/{task_id}", response_model=TaskResponse)
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
        update_data["completed_at"] = datetime.now()

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


@app.delete("/api/tasks/{task_id}", status_code=204)
async def delete_task(
    task_id: int,
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
    await db.delete(task)

    # Broadcast update
    await manager.broadcast({
        "type": "task_deleted",
        "data": {"id": task_id, "project_id": project_id},
    })


@app.post("/api/tasks/{task_id}/move", response_model=TaskResponse)
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
        task.completed_at = datetime.now()
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
    """WebSocket endpoint for real-time updates."""
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


@app.delete("/api/registry/projects/{identifier}", status_code=204)
async def unregister_project(identifier: str):
    """Remove a project from the registry."""
    if not registry.unregister_project(identifier):
        raise HTTPException(status_code=404, detail="Project not found in registry")


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
async def discover_projects(max_depth: int = 3):
    """Discover projects with .loki directories."""
    discovered = registry.discover_projects(max_depth=max_depth)
    return discovered


@app.post("/api/registry/sync", response_model=SyncResponse)
async def sync_registry():
    """Sync the registry with discovered projects."""
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
        "audit_enabled": audit.is_audit_enabled(),
        "enterprise_mode": auth.is_enterprise_mode() or audit.is_audit_enabled(),
    }


# Token management endpoints (only active when LOKI_ENTERPRISE_AUTH=true)
class TokenCreateRequest(BaseModel):
    """Schema for creating a token."""
    name: str = Field(..., min_length=1, max_length=255, description="Human-readable token name")
    scopes: Optional[list[str]] = Field(None, description="Permission scopes (default: ['*'] for all)")
    expires_days: Optional[int] = Field(None, gt=0, description="Days until expiration (must be positive)")


class TokenResponse(BaseModel):
    """Schema for token response."""
    id: str
    name: str
    scopes: list[str]
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


@app.delete("/api/enterprise/tokens/{identifier}")
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


# Audit log endpoints (only active when LOKI_ENTERPRISE_AUDIT=true)
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
            detail="Enterprise audit logging not enabled. Set LOKI_ENTERPRISE_AUDIT=true"
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
    """Get audit activity summary (enterprise only)."""
    if not audit.is_audit_enabled():
        raise HTTPException(
            status_code=403,
            detail="Enterprise audit logging not enabled"
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
    if not agent_id or ".." in agent_id or not _SAFE_ID_RE.match(agent_id):
        raise HTTPException(
            status_code=400,
            detail="Invalid agent_id: must contain only alphanumeric characters, hyphens, and underscores",
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


@app.post("/api/memory/consolidate")
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
@app.get("/api/learning/metrics")
async def get_learning_metrics(
    timeRange: str = "7d",
    signalType: Optional[str] = None,
    source: Optional[str] = None,
):
    """Get learning metrics from events and metrics files."""
    events = _read_events(timeRange)

    # Filter by type and source
    if signalType:
        events = [e for e in events if e.get("data", {}).get("type") == signalType]
    if source:
        events = [e for e in events if e.get("data", {}).get("source") == source]

    # Count by type
    by_type: dict = {}
    by_source: dict = {}
    for e in events:
        t = e.get("type", "unknown")
        by_type[t] = by_type.get(t, 0) + 1
        s = e.get("data", {}).get("source", "unknown")
        by_source[s] = by_source.get(s, 0) + 1

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
        "totalSignals": len(events),
        "signalsByType": by_type,
        "signalsBySource": by_source,
        "avgConfidence": round(sum(e.get("data", {}).get("confidence", 0) for e in events) / max(len(events), 1), 4),
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
    """Get raw learning signals."""
    events = _read_events(timeRange)
    if signalType:
        events = [e for e in events if e.get("type") == signalType]
    if source:
        events = [e for e in events if e.get("data", {}).get("source") == source]
    return events[offset:offset + limit]


@app.get("/api/learning/aggregation")
async def get_learning_aggregation():
    """Get latest learning aggregation result."""
    agg_file = _get_loki_dir() / "metrics" / "aggregation.json"
    if agg_file.exists():
        try:
            return json.loads(agg_file.read_text())
        except Exception:
            pass
    return {"preferences": [], "error_patterns": [], "success_patterns": [], "tool_efficiencies": []}


@app.post("/api/learning/aggregate")
async def trigger_aggregation():
    """Aggregate learning signals from events.jsonl into structured metrics."""
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
    """Get aggregated user preferences."""
    events = _read_events("30d")
    prefs = [e for e in events if e.get("type") == "user_preference"]
    return prefs[:limit]


@app.get("/api/learning/errors")
async def get_learning_errors(limit: int = 50):
    """Get aggregated error patterns."""
    events = _read_events("30d")
    errors = [e for e in events if e.get("type") == "error_pattern"]
    return errors[:limit]


@app.get("/api/learning/success")
async def get_learning_success(limit: int = 50):
    """Get aggregated success patterns."""
    events = _read_events("30d")
    successes = [e for e in events if e.get("type") == "success_pattern"]
    return successes[:limit]


@app.get("/api/learning/tools")
async def get_tool_efficiency(limit: int = 50):
    """Get tool efficiency rankings."""
    events = _read_events("30d")
    tools = [e for e in events if e.get("type") == "tool_efficiency"]
    return tools[:limit]


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


def _read_events(time_range: str = "7d") -> list:
    """Read events from .loki/events.jsonl with time filter."""
    events_file = _get_loki_dir() / "events.jsonl"
    if not events_file.exists():
        return []

    cutoff = _parse_time_range(time_range)
    events = []
    try:
        for line in events_file.read_text().strip().split("\n"):
            if line.strip():
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
@app.post("/api/control/pause")
async def pause_session():
    """Pause the current session by creating PAUSE file."""
    pause_file = _get_loki_dir() / "PAUSE"
    pause_file.parent.mkdir(parents=True, exist_ok=True)
    pause_file.write_text(datetime.now().isoformat())
    return {"success": True, "message": "Session paused"}


@app.post("/api/control/resume")
async def resume_session():
    """Resume a paused session by removing PAUSE/STOP files."""
    for fname in ["PAUSE", "STOP"]:
        fpath = _get_loki_dir() / fname
        try:
            fpath.unlink(missing_ok=True)
        except Exception:
            pass
    return {"success": True, "message": "Session resumed"}


@app.post("/api/control/stop")
async def stop_session():
    """Stop the session by creating STOP file and sending SIGTERM."""
    stop_file = _get_loki_dir() / "STOP"
    stop_file.parent.mkdir(parents=True, exist_ok=True)
    stop_file.write_text(datetime.now().isoformat())

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

    # Also check dashboard-state.json for token data if efficiency dir is empty
    if total_input == 0 and total_output == 0:
        state_file = loki_dir / "dashboard-state.json"
        if state_file.exists():
            try:
                state = json.loads(state_file.read_text())
                tokens = state.get("tokens", {})
                total_input = tokens.get("input", 0)
                total_output = tokens.get("output", 0)
                model = state.get("model", "sonnet").lower()
                if total_input > 0 or total_output > 0:
                    estimated_cost = _calculate_model_cost(model, total_input, total_output)
                    if model not in by_model:
                        by_model[model] = {
                            "input_tokens": total_input,
                            "output_tokens": total_output,
                            "cost_usd": estimated_cost,
                        }
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


@app.post("/api/council/force-review")
async def force_council_review():
    """Force an immediate council review (writes signal file)."""
    signal_dir = _get_loki_dir() / "signals"
    signal_dir.mkdir(parents=True, exist_ok=True)
    (signal_dir / "COUNCIL_REVIEW_REQUESTED").write_text(
        datetime.now().isoformat()
    )
    return {"success": True, "message": "Council review requested"}


# =============================================================================
# Agent Management API (v5.25.0)
# =============================================================================

@app.get("/api/agents")
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


@app.post("/api/agents/{agent_id}/kill")
async def kill_agent(agent_id: str):
    """Kill a specific agent by ID."""
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


@app.post("/api/agents/{agent_id}/pause")
async def pause_agent(agent_id: str):
    """Pause a specific agent by writing a pause signal."""
    agent_id = _sanitize_agent_id(agent_id)
    signal_dir = _get_loki_dir() / "signals"
    signal_dir.mkdir(parents=True, exist_ok=True)
    (signal_dir / f"PAUSE_AGENT_{agent_id}").write_text(
        datetime.now().isoformat()
    )
    return {"success": True, "message": f"Pause signal sent to agent {agent_id}"}


@app.post("/api/agents/{agent_id}/resume")
async def resume_agent(agent_id: str):
    """Resume a paused agent."""
    agent_id = _sanitize_agent_id(agent_id)
    signal_file = _get_loki_dir() / "signals" / f"PAUSE_AGENT_{agent_id}"
    try:
        signal_file.unlink(missing_ok=True)
    except Exception:
        pass
    return {"success": True, "message": f"Resume signal sent to agent {agent_id}"}


@app.get("/api/logs")
async def get_logs(lines: int = 100):
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
                file_mtime = datetime.fromtimestamp(log_file.stat().st_mtime).strftime(
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
        # Default to localhost-only; CORS * is safe since not exposed to LAN
        host = os.environ.get("LOKI_DASHBOARD_HOST", "127.0.0.1")
    if port is None:
        port = int(os.environ.get("LOKI_DASHBOARD_PORT", "57374"))
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    run_server()
