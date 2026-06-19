"""
REST API Routes for Loki Mode Collaboration

Provides HTTP endpoints for collaboration features.
"""

import asyncio
import json
import logging
from typing import Any, Dict, List, Optional

from .presence import (
    PresenceManager,
    User,
    UserStatus,
    ClientType,
    CursorPosition,
    get_presence_manager,
)
from .sync import (
    StateSync,
    Operation,
    OperationType,
    get_state_sync,
)
from .websocket import (
    CollabWebSocketManager,
    get_collab_ws_manager,
)

logger = logging.getLogger(__name__)


def create_collab_routes(app):
    """
    Create and register collaboration API routes.

    Call this function after creating your FastAPI app to add collab endpoints.

    Args:
        app: FastAPI application instance
    """
    from fastapi import (
        Depends,
        HTTPException,
        WebSocket,
        WebSocketDisconnect,
        Query,
    )
    from pydantic import BaseModel, ConfigDict, Field

    # Reuse the dashboard's scope auth so the collab REST routes are gated the
    # same way as the rest of the dashboard when enterprise auth / OIDC is on.
    # require_scope is a no-op (allows through) when auth is OFF, so local
    # default-mode behavior is unchanged. Reads require "read"; state-changing
    # routes (join/leave/cursor/status/heartbeat/operation/sync) require
    # "control", mirroring the /ws/collab gate. Imported the same way server.py
    # loads auth; if unavailable, fall back to a no-op so collab still loads.
    try:
        from dashboard import auth as _auth

        _read = Depends(_auth.require_scope("read"))
        _control = Depends(_auth.require_scope("control"))
    except Exception:  # noqa: BLE001 - collab must still register without auth
        def _noop_dep():
            return True

        _read = Depends(_noop_dep)
        _control = Depends(_noop_dep)

    # Pydantic schemas
    class JoinRequest(BaseModel):
        """Request to join a collaboration session."""
        name: str = Field(..., min_length=1, max_length=100)
        client_type: str = Field(default="api")
        metadata: Optional[Dict[str, Any]] = None

    class JoinResponse(BaseModel):
        """Response after joining a session."""
        user_id: str
        name: str
        client_type: str
        color: str
        joined_at: str

    class CursorUpdate(BaseModel):
        """Cursor position update."""
        file_path: str
        line: int
        column: int
        selection_start: Optional[List[int]] = None
        selection_end: Optional[List[int]] = None

    class StatusUpdate(BaseModel):
        """User status update."""
        status: str

    class OperationRequest(BaseModel):
        """State operation request."""
        type: str
        path: List[Any]
        value: Optional[Any] = None
        index: Optional[int] = None
        dest_index: Optional[int] = None

    class SyncRequest(BaseModel):
        """State sync request."""
        state: Dict[str, Any]
        version: int

    class UserResponse(BaseModel):
        """User information response."""
        model_config = ConfigDict(from_attributes=True)

        id: str
        name: str
        client_type: str
        status: str
        color: str
        joined_at: str
        current_file: Optional[str]

    class PresenceSummary(BaseModel):
        """Presence summary response."""
        total_users: int
        by_client_type: Dict[str, List[str]]
        by_file: Dict[str, List[str]]
        users: List[Dict[str, Any]]

    # Get manager instances
    presence = get_presence_manager()
    sync = get_state_sync()
    ws_manager = get_collab_ws_manager()

    # ==========================================================================
    # Presence Endpoints
    # ==========================================================================

    @app.post("/api/collab/join", response_model=JoinResponse, tags=["collab"], dependencies=[_control])
    async def join_session(request: JoinRequest) -> JoinResponse:
        """
        Join the collaboration session.

        Creates a new user presence entry and returns user info including
        an assigned user ID and color for cursor display.
        """
        try:
            client_type = ClientType(request.client_type)
        except ValueError:
            client_type = ClientType.API

        user = presence.join(
            name=request.name,
            client_type=client_type,
            metadata=request.metadata or {},
        )

        return JoinResponse(
            user_id=user.id,
            name=user.name,
            client_type=user.client_type.value,
            color=user.color,
            joined_at=user.joined_at,
        )

    @app.post("/api/collab/leave", status_code=204, tags=["collab"], dependencies=[_control])
    async def leave_session(user_id: str = Query(...)) -> None:
        """
        Leave the collaboration session.

        Removes the user from presence tracking.
        """
        if not presence.leave(user_id):
            raise HTTPException(status_code=404, detail="User not found")

    @app.get("/api/collab/users", response_model=List[UserResponse], tags=["collab"], dependencies=[_read])
    async def get_active_users(
        include_offline: bool = Query(False),
        client_type: Optional[str] = Query(None),
    ) -> List[UserResponse]:
        """
        Get all active users in the collaboration session.

        Args:
            include_offline: Include users with stale heartbeats
            client_type: Filter by client type (cli, dashboard, vscode, api, mcp)
        """
        ct = None
        if client_type:
            try:
                ct = ClientType(client_type)
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid client_type: {client_type}")

        users = presence.get_users(include_offline=include_offline, client_type=ct)

        return [
            UserResponse(
                id=u.id,
                name=u.name,
                client_type=u.client_type.value if isinstance(u.client_type, ClientType) else u.client_type,
                status=u.status.value if isinstance(u.status, UserStatus) else u.status,
                color=u.color,
                joined_at=u.joined_at,
                current_file=u.current_file,
            )
            for u in users
        ]

    @app.get("/api/collab/users/{user_id}", response_model=UserResponse, tags=["collab"], dependencies=[_read])
    async def get_user(user_id: str) -> UserResponse:
        """Get a specific user by ID."""
        user = presence.get_user(user_id)
        if not user:
            raise HTTPException(status_code=404, detail="User not found")

        return UserResponse(
            id=user.id,
            name=user.name,
            client_type=user.client_type.value if isinstance(user.client_type, ClientType) else user.client_type,
            status=user.status.value if isinstance(user.status, UserStatus) else user.status,
            color=user.color,
            joined_at=user.joined_at,
            current_file=user.current_file,
        )

    @app.post("/api/collab/users/{user_id}/heartbeat", status_code=204, tags=["collab"], dependencies=[_control])
    async def send_heartbeat(user_id: str) -> None:
        """
        Send a heartbeat to keep the user active.

        Should be called periodically (every 10-15 seconds) to prevent
        automatic offline detection.
        """
        if not presence.heartbeat(user_id):
            raise HTTPException(status_code=404, detail="User not found")

    @app.post("/api/collab/users/{user_id}/cursor", status_code=204, tags=["collab"], dependencies=[_control])
    async def update_cursor(user_id: str, cursor: CursorUpdate) -> None:
        """Update user's cursor position."""
        pos = CursorPosition(
            file_path=cursor.file_path,
            line=cursor.line,
            column=cursor.column,
            selection_start=tuple(cursor.selection_start) if cursor.selection_start else None,
            selection_end=tuple(cursor.selection_end) if cursor.selection_end else None,
        )

        if not presence.update_cursor(user_id, pos):
            raise HTTPException(status_code=404, detail="User not found")

    @app.post("/api/collab/users/{user_id}/status", status_code=204, tags=["collab"], dependencies=[_control])
    async def update_status(user_id: str, status_update: StatusUpdate) -> None:
        """Update user's status (online, away, busy, offline)."""
        try:
            status = UserStatus(status_update.status)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid status: {status_update.status}")

        if not presence.update_status(user_id, status):
            raise HTTPException(status_code=404, detail="User not found")

    @app.get("/api/collab/presence", response_model=PresenceSummary, tags=["collab"], dependencies=[_read])
    async def get_presence_summary() -> PresenceSummary:
        """Get a summary of current presence state."""
        summary = presence.get_presence_summary()
        return PresenceSummary(**summary)

    @app.get("/api/collab/file/{file_path:path}", response_model=List[UserResponse], tags=["collab"], dependencies=[_read])
    async def get_users_in_file(file_path: str) -> List[UserResponse]:
        """Get all users currently viewing a specific file."""
        users = presence.get_users_in_file(file_path)

        return [
            UserResponse(
                id=u.id,
                name=u.name,
                client_type=u.client_type.value if isinstance(u.client_type, ClientType) else u.client_type,
                status=u.status.value if isinstance(u.status, UserStatus) else u.status,
                color=u.color,
                joined_at=u.joined_at,
                current_file=u.current_file,
            )
            for u in users
        ]

    # ==========================================================================
    # State Sync Endpoints
    # ==========================================================================

    @app.get("/api/collab/state", tags=["collab"], dependencies=[_read])
    async def get_state() -> Dict[str, Any]:
        """Get the current shared state."""
        return {
            "state": sync.get_state(),
            "version": sync.get_version(),
            "hash": sync.get_state_hash(),
        }

    @app.get("/api/collab/state/value", tags=["collab"], dependencies=[_read])
    async def get_state_value(path: str = Query(...)) -> Dict[str, Any]:
        """
        Get a value at a specific path in the state.

        Path is dot-separated: "tasks.0.status"
        """
        # Parse path
        path_parts = []
        for part in path.split("."):
            try:
                path_parts.append(int(part))
            except ValueError:
                path_parts.append(part)

        found, value = sync.get_value(path_parts)
        if not found:
            raise HTTPException(status_code=404, detail=f"Path not found: {path}")

        return {"path": path, "value": value}

    @app.post("/api/collab/operation", tags=["collab"], dependencies=[_control])
    async def apply_operation(
        operation: OperationRequest,
        user_id: str = Query(...),
    ) -> Dict[str, Any]:
        """
        Apply an operation to the shared state.

        Operation types:
        - set: Set a value at path
        - delete: Delete value at path
        - insert: Insert into list at index
        - remove: Remove from list at index
        - move: Move list item
        - increment: Increment numeric value
        - append: Append to list or string
        """
        try:
            op_type = OperationType(operation.type)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid operation type: {operation.type}")

        op = Operation(
            type=op_type,
            path=operation.path,
            value=operation.value,
            index=operation.index,
            dest_index=operation.dest_index,
            user_id=user_id,
        )

        success, event = sync.apply_operation(op)

        if not success:
            raise HTTPException(status_code=400, detail="Failed to apply operation")

        # Broadcast to WebSocket clients
        await ws_manager.broadcast({
            "type": "operation",
            "operation": op.to_dict(),
            "user_id": user_id,
        }, exclude_user=user_id)

        return {
            "success": True,
            "operation_id": op.id,
            "version": sync.get_version(),
        }

    @app.post("/api/collab/sync", tags=["collab"], dependencies=[_control])
    async def sync_state(request: SyncRequest) -> Dict[str, Any]:
        """
        Synchronize with a full state snapshot.

        Used for initial sync or recovery from desync.
        """
        merged_state, event = sync.sync_state(request.state, request.version)

        return {
            "state": merged_state,
            "version": sync.get_version(),
            "hash": sync.get_state_hash(),
        }

    @app.get("/api/collab/history", tags=["collab"], dependencies=[_read])
    async def get_operation_history(
        since_version: Optional[int] = Query(None),
        limit: int = Query(100, le=1000),
    ) -> Dict[str, Any]:
        """Get operation history."""
        operations = sync.get_history(since_version=since_version, limit=limit)

        return {
            "operations": [op.to_dict() for op in operations],
            "current_version": sync.get_version(),
        }

    # ==========================================================================
    # WebSocket Endpoint
    # ==========================================================================

    @app.websocket("/ws/collab")
    async def collab_websocket(
        websocket: WebSocket,
        user_id: Optional[str] = Query(None),
        session_id: str = Query("default"),
    ) -> None:
        """
        WebSocket endpoint for real-time collaboration.

        Provides:
        - User presence updates
        - Cursor position sharing
        - State change broadcasting
        - Operation synchronization
        """
        connection = await ws_manager.connect(websocket, user_id, session_id)

        try:
            # Send initial state
            await connection.send({
                "type": "connected",
                "user_id": connection.user_id,
                "session_id": session_id,
                "users": [u.to_dict() for u in presence.get_users()],
                "state": sync.get_state(),
                "version": sync.get_version(),
            })

            # Handle messages
            while True:
                try:
                    data = await asyncio.wait_for(
                        websocket.receive_text(),
                        timeout=30.0
                    )

                    try:
                        message = json.loads(data)
                        response = await ws_manager.handle_message(connection, message)
                        if response:
                            await connection.send(response)
                    except json.JSONDecodeError:
                        await connection.send({
                            "type": "error",
                            "message": "Invalid JSON"
                        })

                except asyncio.TimeoutError:
                    # Send keepalive
                    await connection.send({"type": "ping"})

        except WebSocketDisconnect:
            pass
        except Exception as e:
            logger.error(f"WebSocket error for {connection.user_id}: {e}")
        finally:
            await ws_manager.disconnect(connection.user_id)

    # ==========================================================================
    # Status Endpoint
    # ==========================================================================

    @app.get("/api/collab/status", tags=["collab"], dependencies=[_read])
    async def get_collab_status() -> Dict[str, Any]:
        """Get collaboration system status."""
        return {
            "active_users": len(presence.get_users()),
            "websocket_connections": ws_manager.get_connection_count(),
            "state_version": sync.get_version(),
            "state_hash": sync.get_state_hash(),
        }

    logger.info("Collaboration API routes registered")
