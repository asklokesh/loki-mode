"""
FastAPI server for Loki Mode Dashboard.

Provides REST API and WebSocket endpoints for dashboard functionality.
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any, Optional

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
    active_sessions: int
    running_agents: int
    pending_tasks: int
    database_connected: bool


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

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Configure appropriately for production
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


# Status endpoint
@app.get("/api/status", response_model=StatusResponse)
async def get_status(db: AsyncSession = Depends(get_db)) -> StatusResponse:
    """Get system status."""
    try:
        # Count active sessions
        result = await db.execute(
            select(Session).where(Session.status == SessionStatus.ACTIVE)
        )
        active_sessions = len(result.scalars().all())

        # Count running agents
        result = await db.execute(
            select(Agent).where(Agent.status == AgentStatus.RUNNING)
        )
        running_agents = len(result.scalars().all())

        # Count pending tasks
        result = await db.execute(
            select(Task).where(Task.status == TaskStatus.PENDING)
        )
        pending_tasks = len(result.scalars().all())

        db_connected = True
    except Exception as e:
        logger.warning(f"Status check database error: {e}")
        active_sessions = 0
        running_agents = 0
        pending_tasks = 0
        db_connected = False

    uptime = (datetime.now() - start_time).total_seconds()

    return StatusResponse(
        status="running",
        version="0.1.0",
        uptime_seconds=uptime,
        active_sessions=active_sessions,
        running_agents=running_agents,
        pending_tasks=pending_tasks,
        database_connected=db_connected,
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


# Task endpoints
@app.get("/api/tasks", response_model=list[TaskResponse])
async def list_tasks(
    project_id: Optional[int] = Query(None),
    status: Optional[TaskStatus] = Query(None),
    priority: Optional[TaskPriority] = Query(None),
    db: AsyncSession = Depends(get_db),
) -> list[TaskResponse]:
    """List tasks with optional filters."""
    query = select(Task)

    if project_id is not None:
        query = query.where(Task.project_id == project_id)
    if status is not None:
        query = query.where(Task.status == status)
    if priority is not None:
        query = query.where(Task.priority == priority)

    query = query.order_by(Task.position, Task.created_at)

    result = await db.execute(query)
    tasks = result.scalars().all()

    return [TaskResponse.model_validate(task) for task in tasks]


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
# Static File Serving (Production/Docker)
# =============================================================================
# Must be configured AFTER all API routes to avoid conflicts

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC_DIR):
    from fastapi.staticfiles import StaticFiles
    from fastapi.responses import FileResponse

    # Check if assets directory exists (built frontend)
    ASSETS_DIR = os.path.join(STATIC_DIR, "assets")
    if os.path.isdir(ASSETS_DIR):
        app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")

    # Serve index.html for root
    @app.get("/", include_in_schema=False)
    async def serve_index():
        """Serve the frontend SPA."""
        index_path = os.path.join(STATIC_DIR, "index.html")
        if os.path.isfile(index_path):
            return FileResponse(index_path)
        raise HTTPException(status_code=404, detail="Frontend not built")


def run_server(host: str = None, port: int = None) -> None:
    """Run the dashboard server."""
    import uvicorn
    if host is None:
        host = os.environ.get("LOKI_DASHBOARD_HOST", "0.0.0.0")
    if port is None:
        port = int(os.environ.get("LOKI_DASHBOARD_PORT", "8420"))
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    run_server()
