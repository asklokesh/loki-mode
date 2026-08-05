"""
State Synchronization for Loki Mode Collaboration

Implements operational transformation (OT) based conflict resolution
for concurrent edits to shared state.
"""

import asyncio
import copy
import hashlib
import json
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple


class OperationType(str, Enum):
    """Types of operations that can be applied to state."""
    SET = "set"           # Set a value at a path
    DELETE = "delete"     # Delete a value at a path
    INSERT = "insert"     # Insert into a list at index
    REMOVE = "remove"     # Remove from a list at index
    MOVE = "move"         # Move list item from one index to another
    INCREMENT = "increment"  # Increment a numeric value
    APPEND = "append"     # Append to a list or string


@dataclass
class Operation:
    """
    Represents a single operation on shared state.

    Uses path-based addressing for nested data structures.
    Path is a list of keys/indices: ["tasks", 0, "status"]
    """
    type: OperationType
    path: List[Any]  # Path to the target value
    value: Any = None  # Value for SET, INSERT, APPEND, INCREMENT amount
    index: Optional[int] = None  # For INSERT, REMOVE, MOVE
    dest_index: Optional[int] = None  # For MOVE
    id: str = ""
    timestamp: str = ""
    user_id: str = ""
    version: int = 0  # Lamport timestamp for ordering

    def __post_init__(self):
        if not self.id:
            self.id = str(uuid.uuid4())[:8]
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": self.type.value if isinstance(self.type, OperationType) else self.type,
            "path": self.path,
            "value": self.value,
            "index": self.index,
            "dest_index": self.dest_index,
            "id": self.id,
            "timestamp": self.timestamp,
            "user_id": self.user_id,
            "version": self.version,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Operation":
        """Create from dictionary."""
        return cls(
            type=OperationType(data["type"]) if data.get("type") else OperationType.SET,
            path=data.get("path", []),
            value=data.get("value"),
            index=data.get("index"),
            dest_index=data.get("dest_index"),
            id=data.get("id", ""),
            timestamp=data.get("timestamp", ""),
            user_id=data.get("user_id", ""),
            version=data.get("version", 0),
        )


class SyncEventType(str, Enum):
    """Types of synchronization events."""
    OPERATION_APPLIED = "operation_applied"
    OPERATION_REJECTED = "operation_rejected"
    STATE_SYNCED = "state_synced"
    CONFLICT_RESOLVED = "conflict_resolved"
    VERSION_MISMATCH = "version_mismatch"


@dataclass
class SyncEvent:
    """Represents a synchronization event."""
    type: SyncEventType
    operation_id: Optional[str] = None
    timestamp: str = ""
    payload: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "type": self.type.value if isinstance(self.type, SyncEventType) else self.type,
            "operation_id": self.operation_id,
            "timestamp": self.timestamp,
            "payload": self.payload,
        }


# Type alias for sync callbacks
SyncCallback = Callable[[SyncEvent], None]


class OperationalTransform:
    """
    Implements operational transformation for concurrent operations.

    OT ensures that concurrent operations from different users result in
    the same final state regardless of the order they are received.
    """

    @staticmethod
    def transform_pair(
        op1: Operation,
        op2: Operation,
        priority_to_first: bool = True
    ) -> Tuple[Operation, Operation]:
        """
        Transform two concurrent operations so they can be applied in either order.

        Args:
            op1: First operation
            op2: Second operation
            priority_to_first: If true, op1 takes priority in conflicts

        Returns:
            Tuple of (transformed_op1, transformed_op2)
        """
        # Clone operations to avoid modifying originals
        t_op1 = Operation.from_dict(op1.to_dict())
        t_op2 = Operation.from_dict(op2.to_dict())

        # Check if operations target the same path
        if not OperationalTransform._paths_overlap(op1.path, op2.path):
            # Independent operations, no transformation needed
            return t_op1, t_op2

        # Handle list operations
        if op1.type in (OperationType.INSERT, OperationType.REMOVE) and \
           op2.type in (OperationType.INSERT, OperationType.REMOVE):
            return OperationalTransform._transform_list_ops(t_op1, t_op2, priority_to_first)

        # Handle SET conflicts
        if op1.type == OperationType.SET and op2.type == OperationType.SET:
            if op1.path == op2.path:
                # Same path, one wins based on priority
                if priority_to_first:
                    # op1 wins, op2 becomes no-op (keeps op1's value)
                    t_op2.value = t_op1.value
                else:
                    t_op1.value = t_op2.value

        # Handle DELETE conflicts
        if op1.type == OperationType.DELETE and op2.type == OperationType.DELETE:
            if op1.path == op2.path:
                # Both deleting same thing, one becomes no-op
                pass  # Both are equivalent

        # Handle SET vs DELETE
        if op1.type == OperationType.SET and op2.type == OperationType.DELETE:
            if op1.path == op2.path:
                if priority_to_first:
                    # SET wins, DELETE becomes no-op
                    t_op2.type = OperationType.SET
                    t_op2.value = op1.value
                # else DELETE wins, SET becomes no-op

        if op1.type == OperationType.DELETE and op2.type == OperationType.SET:
            if op1.path == op2.path:
                if not priority_to_first:
                    t_op1.type = OperationType.SET
                    t_op1.value = op2.value

        return t_op1, t_op2

    @staticmethod
    def _paths_overlap(path1: List[Any], path2: List[Any]) -> bool:
        """Check if two paths overlap (one is prefix of other or they're equal)."""
        min_len = min(len(path1), len(path2))
        if min_len == 0:
            return True  # Root path overlaps with everything
        return path1[:min_len] == path2[:min_len]

    @staticmethod
    def _transform_list_ops(
        op1: Operation,
        op2: Operation,
        priority_to_first: bool
    ) -> Tuple[Operation, Operation]:
        """Transform list insert/remove operations."""
        # Get the common list path
        if op1.path[:-1] != op2.path[:-1]:
            return op1, op2  # Different lists

        idx1 = op1.index if op1.index is not None else op1.path[-1]
        idx2 = op2.index if op2.index is not None else op2.path[-1]

        if op1.type == OperationType.INSERT and op2.type == OperationType.INSERT:
            # Both inserting
            if idx1 <= idx2:
                op2.index = idx2 + 1 if op2.index is not None else None
                if op2.index is None:
                    op2.path = op2.path[:-1] + [idx2 + 1]
            elif idx2 < idx1:
                op1.index = idx1 + 1 if op1.index is not None else None
                if op1.index is None:
                    op1.path = op1.path[:-1] + [idx1 + 1]

        elif op1.type == OperationType.REMOVE and op2.type == OperationType.REMOVE:
            # Both removing
            if idx1 < idx2:
                op2.index = idx2 - 1 if op2.index is not None else None
                if op2.index is None:
                    op2.path = op2.path[:-1] + [idx2 - 1]
            elif idx2 < idx1:
                op1.index = idx1 - 1 if op1.index is not None else None
                if op1.index is None:
                    op1.path = op1.path[:-1] + [idx1 - 1]

        elif op1.type == OperationType.INSERT and op2.type == OperationType.REMOVE:
            if idx1 <= idx2:
                op2.index = idx2 + 1 if op2.index is not None else None
            elif idx2 < idx1:
                op1.index = idx1 - 1 if op1.index is not None else None

        elif op1.type == OperationType.REMOVE and op2.type == OperationType.INSERT:
            if idx1 < idx2:
                op2.index = idx2 - 1 if op2.index is not None else None
            elif idx2 <= idx1:
                op1.index = idx1 + 1 if op1.index is not None else None

        return op1, op2


class StateSync:
    """
    Manages synchronized shared state across multiple clients.

    Features:
    - Operational transformation for conflict resolution
    - Version tracking with Lamport timestamps
    - Operation history for undo/redo
    - File-based persistence
    - Event broadcasting for real-time updates

    Usage:
        sync = StateSync()

        # Apply local operation
        op = Operation(
            type=OperationType.SET,
            path=["tasks", 0, "status"],
            value="done",
            user_id="alice"
        )
        result = sync.apply_operation(op)

        # Receive remote operation
        sync.apply_remote_operation(remote_op)

        # Subscribe to changes
        sync.subscribe(lambda event: print(f"Synced: {event}"))
    """

    def __init__(
        self,
        loki_dir: Optional[Path] = None,
        max_history: int = 1000,
        enable_persistence: bool = True,
    ):
        """
        Initialize the state synchronizer.

        Args:
            loki_dir: Path to .loki directory
            max_history: Maximum operations to keep in history
            enable_persistence: Enable file-based persistence
        """
        self.loki_dir = Path(loki_dir) if loki_dir else Path(".loki")
        self.max_history = max_history
        self.enable_persistence = enable_persistence

        # Shared state
        self._state: Dict[str, Any] = {}
        self._state_lock = threading.RLock()

        # Version tracking (Lamport timestamp)
        self._version: int = 0

        # Operation history for undo/redo and conflict resolution
        self._history: List[Operation] = []
        self._pending_ops: List[Operation] = []  # Operations waiting for acknowledgment

        # Subscribers
        self._subscribers: List[SyncCallback] = []
        self._subscriber_lock = threading.Lock()
        self._async_subscribers: List[Callable] = []

        # Persistence. Same hazard as PresenceManager: loki_dir is relative by
        # default, so a deleted working directory makes this mkdir raise at
        # import time and takes the whole dashboard down. Degrade to in-memory.
        if self.enable_persistence:
            self._sync_dir = self.loki_dir / "collab" / "sync"
            try:
                self._sync_dir.mkdir(parents=True, exist_ok=True)
            except OSError:
                self.enable_persistence = False
            else:
                self._load_state()

    def _load_state(self) -> None:
        """Load persisted state."""
        state_file = self._sync_dir / "state.json"
        if not state_file.exists():
            return

        try:
            with open(state_file, "r") as f:
                data = json.load(f)
                self._state = data.get("state", {})
                self._version = data.get("version", 0)
        except (json.JSONDecodeError, IOError):
            pass

    def _persist_state(self) -> None:
        """Persist current state."""
        if not self.enable_persistence:
            return

        state_file = self._sync_dir / "state.json"
        try:
            with open(state_file, "w") as f:
                json.dump({
                    "state": self._state,
                    "version": self._version,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }, f, indent=2)
        except IOError:
            pass

    def _emit_event(self, event: SyncEvent) -> None:
        """Emit a sync event to all subscribers."""
        with self._subscriber_lock:
            subscribers = list(self._subscribers)

        for callback in subscribers:
            try:
                callback(event)
            except Exception:
                pass

    def _emit_async_event(self, event: SyncEvent) -> None:
        """Queue async event for WebSocket broadcasting."""
        for callback in self._async_subscribers:
            try:
                asyncio.create_task(callback(event))
            except RuntimeError:
                pass

    def _get_value_at_path(self, path: List[Any]) -> Tuple[bool, Any]:
        """
        Get value at a path in the state.

        Returns:
            Tuple of (found, value)
        """
        current = self._state
        for i, key in enumerate(path):
            if isinstance(current, dict):
                if key not in current:
                    return False, None
                current = current[key]
            elif isinstance(current, list):
                if not isinstance(key, int) or key < 0 or key >= len(current):
                    return False, None
                current = current[key]
            else:
                return False, None
        return True, current

    def _set_value_at_path(self, path: List[Any], value: Any) -> bool:
        """Set value at a path in the state."""
        if not path:
            # Setting root
            if isinstance(value, dict):
                self._state = value
                return True
            return False

        # Navigate to parent
        current = self._state
        for key in path[:-1]:
            if isinstance(current, dict):
                if key not in current:
                    current[key] = {}
                current = current[key]
            elif isinstance(current, list):
                if not isinstance(key, int) or key < 0 or key >= len(current):
                    return False
                current = current[key]
            else:
                return False

        # Set the value
        final_key = path[-1]
        if isinstance(current, dict):
            current[final_key] = value
            return True
        elif isinstance(current, list):
            if isinstance(final_key, int) and 0 <= final_key < len(current):
                current[final_key] = value
                return True
            elif isinstance(final_key, int) and final_key == len(current):
                current.append(value)
                return True

        return False

    def _delete_value_at_path(self, path: List[Any]) -> bool:
        """Delete value at a path in the state."""
        if not path:
            self._state = {}
            return True

        # Navigate to parent
        current = self._state
        for key in path[:-1]:
            if isinstance(current, dict):
                if key not in current:
                    return False
                current = current[key]
            elif isinstance(current, list):
                if not isinstance(key, int) or key < 0 or key >= len(current):
                    return False
                current = current[key]
            else:
                return False

        # Delete the value
        final_key = path[-1]
        if isinstance(current, dict):
            if final_key in current:
                del current[final_key]
                return True
        elif isinstance(current, list):
            if isinstance(final_key, int) and 0 <= final_key < len(current):
                current.pop(final_key)
                return True

        return False

    def _apply_operation_internal(self, op: Operation) -> bool:
        """Apply an operation to the internal state."""
        if op.type == OperationType.SET:
            return self._set_value_at_path(op.path, op.value)

        elif op.type == OperationType.DELETE:
            return self._delete_value_at_path(op.path)

        elif op.type == OperationType.INSERT:
            # Get the list at parent path
            found, target = self._get_value_at_path(op.path)
            if found and isinstance(target, list):
                idx = op.index if op.index is not None else len(target)
                if 0 <= idx <= len(target):
                    target.insert(idx, op.value)
                    return True
            return False

        elif op.type == OperationType.REMOVE:
            found, target = self._get_value_at_path(op.path)
            if found and isinstance(target, list):
                idx = op.index if op.index is not None else len(target) - 1
                if 0 <= idx < len(target):
                    target.pop(idx)
                    return True
            return False

        elif op.type == OperationType.MOVE:
            found, target = self._get_value_at_path(op.path)
            if found and isinstance(target, list):
                if op.index is not None and op.dest_index is not None:
                    if 0 <= op.index < len(target) and 0 <= op.dest_index < len(target):
                        item = target.pop(op.index)
                        target.insert(op.dest_index, item)
                        return True
            return False

        elif op.type == OperationType.INCREMENT:
            found, current = self._get_value_at_path(op.path)
            if found and isinstance(current, (int, float)):
                new_value = current + (op.value or 1)
                return self._set_value_at_path(op.path, new_value)
            return False

        elif op.type == OperationType.APPEND:
            found, current = self._get_value_at_path(op.path)
            if found:
                if isinstance(current, list):
                    current.append(op.value)
                    return True
                elif isinstance(current, str):
                    new_value = current + str(op.value)
                    return self._set_value_at_path(op.path, new_value)
            return False

        return False

    def apply_operation(
        self,
        op: Operation,
        broadcast: bool = True
    ) -> Tuple[bool, SyncEvent]:
        """
        Apply a local operation to the state.

        Args:
            op: Operation to apply
            broadcast: Whether to emit sync event

        Returns:
            Tuple of (success, event)
        """
        with self._state_lock:
            # Increment version
            self._version += 1
            op.version = self._version

            # Apply the operation
            success = self._apply_operation_internal(op)

            if success:
                # Add to history
                self._history.append(op)
                if len(self._history) > self.max_history:
                    self._history = self._history[-self.max_history:]

                # Add to pending for acknowledgment
                self._pending_ops.append(op)

                # Persist
                self._persist_state()

        # Create event
        if success:
            event = SyncEvent(
                type=SyncEventType.OPERATION_APPLIED,
                operation_id=op.id,
                payload={"operation": op.to_dict(), "version": self._version},
            )
        else:
            event = SyncEvent(
                type=SyncEventType.OPERATION_REJECTED,
                operation_id=op.id,
                payload={"operation": op.to_dict(), "reason": "Failed to apply"},
            )

        if broadcast:
            self._emit_event(event)
            self._emit_async_event(event)

        return success, event

    def apply_remote_operation(
        self,
        op: Operation,
        transform_against_pending: bool = True
    ) -> Tuple[bool, SyncEvent]:
        """
        Apply an operation received from a remote client.

        Args:
            op: Remote operation to apply
            transform_against_pending: Transform against pending local operations

        Returns:
            Tuple of (success, event)
        """
        with self._state_lock:
            transformed_op = op

            if transform_against_pending:
                # Transform against pending local operations
                for pending in self._pending_ops:
                    _, transformed_op = OperationalTransform.transform_pair(
                        pending, transformed_op, priority_to_first=True
                    )

            # Apply the transformed operation
            success = self._apply_operation_internal(transformed_op)

            if success:
                # Update version to max of local and remote
                self._version = max(self._version, op.version) + 1

                # Add to history
                self._history.append(transformed_op)
                if len(self._history) > self.max_history:
                    self._history = self._history[-self.max_history:]

                self._persist_state()

        # Create event
        event_type = SyncEventType.OPERATION_APPLIED if success else SyncEventType.OPERATION_REJECTED
        event = SyncEvent(
            type=event_type,
            operation_id=op.id,
            payload={
                "operation": transformed_op.to_dict(),
                "original_operation": op.to_dict(),
                "version": self._version,
            },
        )

        self._emit_event(event)
        self._emit_async_event(event)

        return success, event

    def acknowledge_operation(self, op_id: str) -> bool:
        """
        Acknowledge that a local operation was received by the server.

        Args:
            op_id: ID of the operation to acknowledge

        Returns:
            True if operation was found and acknowledged
        """
        with self._state_lock:
            self._pending_ops = [op for op in self._pending_ops if op.id != op_id]
        return True

    def get_state(self) -> Dict[str, Any]:
        """Get a copy of the current state."""
        with self._state_lock:
            return copy.deepcopy(self._state)

    def get_value(self, path: List[Any]) -> Tuple[bool, Any]:
        """Get a value at a path."""
        with self._state_lock:
            found, value = self._get_value_at_path(path)
            if found:
                return True, copy.deepcopy(value)
            return False, None

    def get_version(self) -> int:
        """Get the current version number."""
        return self._version

    def get_state_hash(self) -> str:
        """Get a hash of the current state for consistency checking."""
        with self._state_lock:
            content = json.dumps(self._state, sort_keys=True, default=str)
            return hashlib.md5(content.encode()).hexdigest()

    def sync_state(
        self,
        remote_state: Dict[str, Any],
        remote_version: int
    ) -> Tuple[Dict[str, Any], SyncEvent]:
        """
        Synchronize with a full state snapshot from remote.

        Used for initial sync or recovery from desync.

        Args:
            remote_state: Full state from remote
            remote_version: Version of remote state

        Returns:
            Tuple of (merged_state, event)
        """
        with self._state_lock:
            if remote_version > self._version:
                # Remote is ahead, take remote state
                self._state = copy.deepcopy(remote_state)
                self._version = remote_version
                self._pending_ops.clear()
                self._persist_state()
            else:
                # Local is ahead or equal, keep local state
                pass

            merged_state = copy.deepcopy(self._state)

        event = SyncEvent(
            type=SyncEventType.STATE_SYNCED,
            payload={
                "version": self._version,
                "state_hash": self.get_state_hash(),
            },
        )

        self._emit_event(event)

        return merged_state, event

    def get_history(
        self,
        since_version: Optional[int] = None,
        limit: int = 100
    ) -> List[Operation]:
        """
        Get operation history.

        Args:
            since_version: Return operations after this version
            limit: Maximum operations to return

        Returns:
            List of operations
        """
        with self._state_lock:
            ops = self._history

            if since_version is not None:
                ops = [op for op in ops if op.version > since_version]

            return ops[-limit:]

    def subscribe(self, callback: SyncCallback) -> Callable[[], None]:
        """Subscribe to sync events."""
        with self._subscriber_lock:
            self._subscribers.append(callback)

        def unsubscribe():
            with self._subscriber_lock:
                if callback in self._subscribers:
                    self._subscribers.remove(callback)

        return unsubscribe

    def subscribe_async(self, callback: Callable) -> Callable[[], None]:
        """Subscribe with an async callback."""
        self._async_subscribers.append(callback)

        def unsubscribe():
            if callback in self._async_subscribers:
                self._async_subscribers.remove(callback)

        return unsubscribe

    def stop(self) -> None:
        """Stop the sync manager and cleanup resources."""
        self._subscribers.clear()
        self._async_subscribers.clear()


# Singleton instance
_default_sync: Optional[StateSync] = None


def get_state_sync(
    loki_dir: Optional[Path] = None,
    **kwargs
) -> StateSync:
    """Get the default state sync instance."""
    global _default_sync

    if _default_sync is None:
        _default_sync = StateSync(loki_dir, **kwargs)

    return _default_sync


def reset_state_sync() -> None:
    """Reset the default state sync (for testing)."""
    global _default_sync

    if _default_sync:
        _default_sync.stop()
        _default_sync = None
