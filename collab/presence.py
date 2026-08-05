"""
Presence Manager for Loki Mode Collaboration

Tracks active users, handles heartbeats, and manages join/leave notifications.
"""

import asyncio
import json
import threading
import time
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set


class UserStatus(str, Enum):
    """User status enumeration."""
    ONLINE = "online"
    AWAY = "away"
    BUSY = "busy"
    OFFLINE = "offline"


class ClientType(str, Enum):
    """Client type enumeration."""
    CLI = "cli"
    DASHBOARD = "dashboard"
    VSCODE = "vscode"
    API = "api"
    MCP = "mcp"


@dataclass
class CursorPosition:
    """Represents a cursor position in a file."""
    file_path: str
    line: int
    column: int
    selection_start: Optional[tuple] = None  # (line, column)
    selection_end: Optional[tuple] = None    # (line, column)

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "file_path": self.file_path,
            "line": self.line,
            "column": self.column,
            "selection_start": self.selection_start,
            "selection_end": self.selection_end,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CursorPosition":
        """Create from dictionary."""
        return cls(
            file_path=data["file_path"],
            line=data["line"],
            column=data["column"],
            selection_start=tuple(data["selection_start"]) if data.get("selection_start") else None,
            selection_end=tuple(data["selection_end"]) if data.get("selection_end") else None,
        )


@dataclass
class User:
    """Represents an active user in the collaboration session."""
    id: str
    name: str
    client_type: ClientType
    status: UserStatus = UserStatus.ONLINE
    color: str = ""  # Assigned color for cursor/selection display
    joined_at: str = ""
    last_heartbeat: str = ""
    cursor: Optional[CursorPosition] = None
    current_file: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not self.joined_at:
            self.joined_at = datetime.now(timezone.utc).isoformat()
        if not self.last_heartbeat:
            self.last_heartbeat = self.joined_at
        if not self.color:
            # Assign a color based on user ID hash
            colors = [
                "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
                "#FFEAA7", "#DDA0DD", "#98D8C8", "#F7DC6F",
                "#BB8FCE", "#85C1E9", "#F8B500", "#00CED1",
            ]
            self.color = colors[hash(self.id) % len(colors)]

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "name": self.name,
            "client_type": self.client_type.value if isinstance(self.client_type, ClientType) else self.client_type,
            "status": self.status.value if isinstance(self.status, UserStatus) else self.status,
            "color": self.color,
            "joined_at": self.joined_at,
            "last_heartbeat": self.last_heartbeat,
            "cursor": self.cursor.to_dict() if self.cursor else None,
            "current_file": self.current_file,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "User":
        """Create from dictionary."""
        cursor = None
        if data.get("cursor"):
            cursor = CursorPosition.from_dict(data["cursor"])

        return cls(
            id=data["id"],
            name=data["name"],
            client_type=ClientType(data["client_type"]) if data.get("client_type") else ClientType.CLI,
            status=UserStatus(data["status"]) if data.get("status") else UserStatus.ONLINE,
            color=data.get("color", ""),
            joined_at=data.get("joined_at", ""),
            last_heartbeat=data.get("last_heartbeat", ""),
            cursor=cursor,
            current_file=data.get("current_file"),
            metadata=data.get("metadata", {}),
        )


class PresenceEventType(str, Enum):
    """Types of presence events."""
    USER_JOINED = "user_joined"
    USER_LEFT = "user_left"
    USER_UPDATED = "user_updated"
    CURSOR_MOVED = "cursor_moved"
    FILE_OPENED = "file_opened"
    STATUS_CHANGED = "status_changed"


@dataclass
class PresenceEvent:
    """Represents a presence-related event."""
    type: PresenceEventType
    user_id: str
    timestamp: str = ""
    payload: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": self.type.value if isinstance(self.type, PresenceEventType) else self.type,
            "user_id": self.user_id,
            "timestamp": self.timestamp,
            "payload": self.payload,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PresenceEvent":
        """Create from dictionary."""
        return cls(
            type=PresenceEventType(data["type"]) if data.get("type") else PresenceEventType.USER_UPDATED,
            user_id=data["user_id"],
            timestamp=data.get("timestamp", ""),
            payload=data.get("payload", {}),
        )


# Type alias for presence callbacks
PresenceCallback = Callable[[PresenceEvent], None]


class PresenceManager:
    """
    Manages user presence for real-time collaboration.

    Features:
    - Track active users with heartbeat mechanism
    - Automatic offline detection after heartbeat timeout
    - Cursor and selection sharing
    - File-based persistence for cross-process state
    - Event callbacks for presence changes

    Usage:
        manager = PresenceManager()

        # Join as a user
        user = manager.join("alice", ClientType.VSCODE)

        # Update cursor
        manager.update_cursor(user.id, CursorPosition("main.py", 10, 5))

        # Subscribe to events
        manager.subscribe(lambda event: print(f"Event: {event}"))

        # Send heartbeat periodically
        manager.heartbeat(user.id)

        # Leave
        manager.leave(user.id)
    """

    # Default heartbeat timeout (seconds)
    DEFAULT_HEARTBEAT_TIMEOUT = 30.0

    def __init__(
        self,
        loki_dir: Optional[Path] = None,
        heartbeat_timeout: float = DEFAULT_HEARTBEAT_TIMEOUT,
        enable_persistence: bool = True,
    ):
        """
        Initialize the presence manager.

        Args:
            loki_dir: Path to .loki directory. Defaults to ./.loki
            heartbeat_timeout: Seconds before marking user as offline
            enable_persistence: Enable file-based persistence
        """
        self.loki_dir = Path(loki_dir) if loki_dir else Path(".loki")
        self.heartbeat_timeout = heartbeat_timeout
        self.enable_persistence = enable_persistence

        # Active users: user_id -> User
        self._users: Dict[str, User] = {}
        self._users_lock = threading.RLock()

        # Subscribers for presence events
        self._subscribers: List[PresenceCallback] = []
        self._subscriber_lock = threading.Lock()

        # Async subscribers for WebSocket broadcasting
        self._async_subscribers: List[Callable] = []

        # Cleanup thread
        self._cleanup_running = False
        self._cleanup_thread: Optional[threading.Thread] = None

        # Ensure directories exist.
        # loki_dir is relative (".loki") by default, so when the working
        # directory has been deleted this mkdir raises FileNotFoundError. This
        # constructor runs at IMPORT time via create_collab_routes(), so the
        # exception took down the ENTIRE dashboard -- every endpoint 500s,
        # including ones that never touch collab. Presence is an optional
        # feature; losing its directory must disable persistence, not the app.
        if self.enable_persistence:
            self._presence_dir = self.loki_dir / "collab" / "presence"
            try:
                self._presence_dir.mkdir(parents=True, exist_ok=True)
            except OSError:
                self.enable_persistence = False
            else:
                self._load_persisted_users()

    def _load_persisted_users(self) -> None:
        """Load persisted users from disk (for recovery)."""
        presence_file = self._presence_dir / "users.json"
        if not presence_file.exists():
            return

        try:
            with open(presence_file, "r") as f:
                data = json.load(f)
                for user_data in data.get("users", []):
                    user = User.from_dict(user_data)
                    # Only load if heartbeat is recent
                    if self._is_heartbeat_valid(user.last_heartbeat):
                        self._users[user.id] = user
        except (json.JSONDecodeError, IOError):
            pass

    def _persist_users(self) -> None:
        """Persist current users to disk."""
        if not self.enable_persistence:
            return

        presence_file = self._presence_dir / "users.json"
        try:
            with open(presence_file, "w") as f:
                json.dump({
                    "users": [user.to_dict() for user in self._users.values()],
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }, f, indent=2)
        except IOError:
            pass

    def _is_heartbeat_valid(self, heartbeat: str) -> bool:
        """Check if a heartbeat timestamp is within the timeout window."""
        try:
            heartbeat_time = datetime.fromisoformat(heartbeat.replace("Z", "+00:00"))
            now = datetime.now(timezone.utc)
            delta = (now - heartbeat_time).total_seconds()
            return delta < self.heartbeat_timeout
        except (ValueError, TypeError):
            return False

    def _emit_event(self, event: PresenceEvent) -> None:
        """Emit a presence event to all subscribers."""
        with self._subscriber_lock:
            subscribers = list(self._subscribers)

        for callback in subscribers:
            try:
                callback(event)
            except Exception:
                pass  # Don't let one callback break others

    def _emit_async_event(self, event: PresenceEvent) -> None:
        """Queue async event for WebSocket broadcasting."""
        for callback in self._async_subscribers:
            try:
                # Schedule the async callback
                asyncio.create_task(callback(event))
            except RuntimeError:
                # No event loop running, skip async broadcast
                pass

    def join(
        self,
        name: str,
        client_type: ClientType,
        user_id: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> User:
        """
        Join the collaboration session.

        Args:
            name: User display name
            client_type: Type of client (CLI, VS Code, etc.)
            user_id: Optional user ID (generated if not provided)
            metadata: Optional metadata to attach to the user

        Returns:
            User object representing the joined user
        """
        if user_id is None:
            user_id = str(uuid.uuid4())[:8]

        user = User(
            id=user_id,
            name=name,
            client_type=client_type,
            metadata=metadata or {},
        )

        with self._users_lock:
            self._users[user_id] = user
            self._persist_users()

        # Emit join event
        event = PresenceEvent(
            type=PresenceEventType.USER_JOINED,
            user_id=user_id,
            payload={"user": user.to_dict()},
        )
        self._emit_event(event)
        self._emit_async_event(event)

        return user

    def leave(self, user_id: str) -> bool:
        """
        Leave the collaboration session.

        Args:
            user_id: ID of the user leaving

        Returns:
            True if user was found and removed
        """
        with self._users_lock:
            if user_id not in self._users:
                return False

            user = self._users.pop(user_id)
            self._persist_users()

        # Emit leave event
        event = PresenceEvent(
            type=PresenceEventType.USER_LEFT,
            user_id=user_id,
            payload={"user": user.to_dict()},
        )
        self._emit_event(event)
        self._emit_async_event(event)

        return True

    def heartbeat(self, user_id: str) -> bool:
        """
        Update user's last heartbeat timestamp.

        Args:
            user_id: ID of the user

        Returns:
            True if user exists and heartbeat was updated
        """
        with self._users_lock:
            if user_id not in self._users:
                return False

            user = self._users[user_id]
            user.last_heartbeat = datetime.now(timezone.utc).isoformat()

            # If user was marked as offline/away, restore to online
            if user.status == UserStatus.OFFLINE:
                user.status = UserStatus.ONLINE
                self._emit_event(PresenceEvent(
                    type=PresenceEventType.STATUS_CHANGED,
                    user_id=user_id,
                    payload={"status": UserStatus.ONLINE.value},
                ))

            self._persist_users()

        return True

    def update_cursor(self, user_id: str, cursor: CursorPosition) -> bool:
        """
        Update user's cursor position.

        Args:
            user_id: ID of the user
            cursor: New cursor position

        Returns:
            True if user exists and cursor was updated
        """
        with self._users_lock:
            if user_id not in self._users:
                return False

            user = self._users[user_id]
            user.cursor = cursor
            user.current_file = cursor.file_path
            self._persist_users()

        # Emit cursor event
        event = PresenceEvent(
            type=PresenceEventType.CURSOR_MOVED,
            user_id=user_id,
            payload={"cursor": cursor.to_dict()},
        )
        self._emit_event(event)
        self._emit_async_event(event)

        return True

    def update_status(self, user_id: str, status: UserStatus) -> bool:
        """
        Update user's status.

        Args:
            user_id: ID of the user
            status: New status

        Returns:
            True if user exists and status was updated
        """
        with self._users_lock:
            if user_id not in self._users:
                return False

            user = self._users[user_id]
            old_status = user.status
            user.status = status
            self._persist_users()

        if old_status != status:
            event = PresenceEvent(
                type=PresenceEventType.STATUS_CHANGED,
                user_id=user_id,
                payload={"old_status": old_status.value, "status": status.value},
            )
            self._emit_event(event)
            self._emit_async_event(event)

        return True

    def open_file(self, user_id: str, file_path: str) -> bool:
        """
        Record that a user opened a file.

        Args:
            user_id: ID of the user
            file_path: Path to the opened file

        Returns:
            True if user exists and file was recorded
        """
        with self._users_lock:
            if user_id not in self._users:
                return False

            user = self._users[user_id]
            user.current_file = file_path
            self._persist_users()

        event = PresenceEvent(
            type=PresenceEventType.FILE_OPENED,
            user_id=user_id,
            payload={"file_path": file_path},
        )
        self._emit_event(event)
        self._emit_async_event(event)

        return True

    def get_user(self, user_id: str) -> Optional[User]:
        """Get a user by ID."""
        with self._users_lock:
            return self._users.get(user_id)

    def get_users(
        self,
        include_offline: bool = False,
        client_type: Optional[ClientType] = None,
    ) -> List[User]:
        """
        Get all active users.

        Args:
            include_offline: Include users with stale heartbeats
            client_type: Filter by client type

        Returns:
            List of active users
        """
        with self._users_lock:
            users = list(self._users.values())

        result = []
        for user in users:
            # Check heartbeat validity
            if not include_offline and not self._is_heartbeat_valid(user.last_heartbeat):
                continue

            # Filter by client type
            if client_type and user.client_type != client_type:
                continue

            result.append(user)

        return result

    def get_users_in_file(self, file_path: str) -> List[User]:
        """Get all users currently in a specific file."""
        with self._users_lock:
            return [
                user for user in self._users.values()
                if user.current_file == file_path and self._is_heartbeat_valid(user.last_heartbeat)
            ]

    def subscribe(self, callback: PresenceCallback) -> Callable[[], None]:
        """
        Subscribe to presence events.

        Args:
            callback: Function to call on presence events

        Returns:
            Unsubscribe function
        """
        with self._subscriber_lock:
            self._subscribers.append(callback)

        def unsubscribe():
            with self._subscriber_lock:
                if callback in self._subscribers:
                    self._subscribers.remove(callback)

        return unsubscribe

    def subscribe_async(self, callback: Callable) -> Callable[[], None]:
        """
        Subscribe with an async callback for WebSocket broadcasting.

        Args:
            callback: Async function to call on presence events

        Returns:
            Unsubscribe function
        """
        self._async_subscribers.append(callback)

        def unsubscribe():
            if callback in self._async_subscribers:
                self._async_subscribers.remove(callback)

        return unsubscribe

    def start_cleanup_task(self, interval: float = 10.0) -> None:
        """
        Start background task to clean up stale users.

        Args:
            interval: Seconds between cleanup runs
        """
        if self._cleanup_running:
            return

        self._cleanup_running = True

        def cleanup_loop():
            while self._cleanup_running:
                self._cleanup_stale_users()
                time.sleep(interval)

        self._cleanup_thread = threading.Thread(target=cleanup_loop, daemon=True)
        self._cleanup_thread.start()

    def stop_cleanup_task(self) -> None:
        """Stop the background cleanup task."""
        self._cleanup_running = False
        if self._cleanup_thread:
            self._cleanup_thread.join(timeout=2.0)
            self._cleanup_thread = None

    def _cleanup_stale_users(self) -> None:
        """Mark users with stale heartbeats as offline."""
        stale_users = []

        with self._users_lock:
            for user_id, user in self._users.items():
                if not self._is_heartbeat_valid(user.last_heartbeat):
                    if user.status != UserStatus.OFFLINE:
                        stale_users.append(user_id)

            for user_id in stale_users:
                self._users[user_id].status = UserStatus.OFFLINE

            if stale_users:
                self._persist_users()

        # Emit status change events
        for user_id in stale_users:
            event = PresenceEvent(
                type=PresenceEventType.STATUS_CHANGED,
                user_id=user_id,
                payload={"status": UserStatus.OFFLINE.value},
            )
            self._emit_event(event)

    def get_presence_summary(self) -> Dict[str, Any]:
        """Get a summary of current presence state."""
        users = self.get_users(include_offline=False)

        # Group by client type
        by_client_type = {}
        for user in users:
            client = user.client_type.value if isinstance(user.client_type, ClientType) else user.client_type
            if client not in by_client_type:
                by_client_type[client] = []
            by_client_type[client].append(user.name)

        # Group by file
        by_file = {}
        for user in users:
            if user.current_file:
                if user.current_file not in by_file:
                    by_file[user.current_file] = []
                by_file[user.current_file].append(user.name)

        return {
            "total_users": len(users),
            "by_client_type": by_client_type,
            "by_file": by_file,
            "users": [user.to_dict() for user in users],
        }

    def stop(self) -> None:
        """Stop the presence manager and cleanup resources."""
        self.stop_cleanup_task()
        self._subscribers.clear()
        self._async_subscribers.clear()


# Singleton instance
_default_manager: Optional[PresenceManager] = None


def get_presence_manager(
    loki_dir: Optional[Path] = None,
    **kwargs
) -> PresenceManager:
    """Get the default presence manager instance."""
    global _default_manager

    if _default_manager is None:
        _default_manager = PresenceManager(loki_dir, **kwargs)

    return _default_manager


def reset_presence_manager() -> None:
    """Reset the default presence manager (for testing)."""
    global _default_manager

    if _default_manager:
        _default_manager.stop()
        _default_manager = None
