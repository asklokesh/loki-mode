"""
Centralized State Manager for Loki Mode

Provides unified state management with:
- File-based caching with watchdog for change detection
- Thread-safe operations with file locking
- Event bus integration for broadcasting changes
- Subscription system for reactive updates
- Version history with rollback capability (SYN-015)
"""

import json
import os
import fcntl
import tempfile
import shutil
import threading
import hashlib
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple, Union
from enum import Enum
from contextlib import contextmanager
import uuid
import glob as glob_module

# Try to import watchdog for file monitoring
try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler, FileModifiedEvent, FileCreatedEvent
    HAS_WATCHDOG = True
except ImportError:
    HAS_WATCHDOG = False
    Observer = None
    FileSystemEventHandler = object

# Import event bus for broadcasting
try:
    from events.bus import EventBus, EventType, EventSource, LokiEvent
    HAS_EVENT_BUS = True
except ImportError:
    HAS_EVENT_BUS = False
    EventBus = None


class ManagedFile(str, Enum):
    """Enumeration of managed state files."""
    ORCHESTRATOR = "state/orchestrator.json"
    AUTONOMY = "autonomy-state.json"
    QUEUE_PENDING = "queue/pending.json"
    QUEUE_IN_PROGRESS = "queue/in-progress.json"
    QUEUE_COMPLETED = "queue/completed.json"
    QUEUE_FAILED = "queue/failed.json"
    QUEUE_CURRENT = "queue/current-task.json"
    MEMORY_INDEX = "memory/index.json"
    MEMORY_TIMELINE = "memory/timeline.json"
    DASHBOARD = "dashboard-state.json"
    AGENTS = "state/agents.json"
    RESOURCES = "state/resources.json"


class ConflictStrategy(str, Enum):
    """Conflict resolution strategies for optimistic updates."""
    LAST_WRITE_WINS = "last_write_wins"  # Default: latest write overwrites
    MERGE = "merge"                       # Merge compatible changes
    REJECT = "reject"                     # Reject and notify caller


@dataclass
class VersionVector:
    """Version vector for tracking state versions per source."""
    versions: Dict[str, int] = field(default_factory=dict)

    def increment(self, source: str) -> None:
        """Increment version for a source."""
        self.versions[source] = self.versions.get(source, 0) + 1

    def get(self, source: str) -> int:
        """Get version for a source."""
        return self.versions.get(source, 0)

    def merge(self, other: "VersionVector") -> "VersionVector":
        """Merge two version vectors (take max of each)."""
        merged = VersionVector()
        all_sources = set(self.versions.keys()) | set(other.versions.keys())
        for source in all_sources:
            merged.versions[source] = max(self.get(source), other.get(source))
        return merged

    def dominates(self, other: "VersionVector") -> bool:
        """Check if this vector dominates (is causally after) another."""
        for source, version in other.versions.items():
            if self.get(source) < version:
                return False
        # Must have at least one greater version
        for source, version in self.versions.items():
            if version > other.get(source):
                return True
        return False

    def concurrent_with(self, other: "VersionVector") -> bool:
        """Check if two vectors are concurrent (neither dominates).

        Per causality rules, identical vectors are concurrent (happened
        independently with the same knowledge).
        """
        if self.versions == other.versions:
            return True
        return not self.dominates(other) and not other.dominates(self)

    def to_dict(self) -> Dict[str, int]:
        """Convert to dictionary."""
        return dict(self.versions)

    @classmethod
    def from_dict(cls, data: Dict[str, int]) -> "VersionVector":
        """Create from dictionary."""
        vv = cls()
        vv.versions = dict(data)
        return vv


@dataclass
class PendingUpdate:
    """Represents a pending optimistic update."""
    id: str
    key: str
    value: Any
    source: str
    timestamp: str
    version_vector: VersionVector
    status: str = "pending"  # pending, committed, rejected

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "id": self.id,
            "key": self.key,
            "value": self.value,
            "source": self.source,
            "timestamp": self.timestamp,
            "version_vector": self.version_vector.to_dict(),
            "status": self.status
        }


@dataclass
class ConflictInfo:
    """Information about a detected conflict."""
    key: str
    local_value: Any
    remote_value: Any
    local_source: str
    remote_source: str
    local_version: VersionVector
    remote_version: VersionVector
    resolution: Optional[str] = None
    resolved_value: Optional[Any] = None

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "key": self.key,
            "local_value": self.local_value,
            "remote_value": self.remote_value,
            "local_source": self.local_source,
            "remote_source": self.remote_source,
            "local_version": self.local_version.to_dict(),
            "remote_version": self.remote_version.to_dict(),
            "resolution": self.resolution,
            "resolved_value": self.resolved_value
        }


@dataclass
class StateChange:
    """Represents a state change event."""
    file_path: str
    old_value: Optional[Dict[str, Any]]
    new_value: Dict[str, Any]
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    change_type: str = "update"  # create, update, delete
    source: str = "state-manager"

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "file_path": self.file_path,
            "old_value": self.old_value,
            "new_value": self.new_value,
            "timestamp": self.timestamp,
            "change_type": self.change_type,
            "source": self.source
        }

    def get_diff(self) -> Dict[str, Any]:
        """Get the diff between old and new values."""
        if self.old_value is None:
            return {"added": self.new_value, "removed": {}, "changed": {}}

        diff = {"added": {}, "removed": {}, "changed": {}}

        old_keys = set(self.old_value.keys()) if self.old_value else set()
        new_keys = set(self.new_value.keys()) if self.new_value else set()

        # Added keys
        for key in new_keys - old_keys:
            diff["added"][key] = self.new_value[key]

        # Removed keys
        for key in old_keys - new_keys:
            diff["removed"][key] = self.old_value[key]

        # Changed keys
        for key in old_keys & new_keys:
            if self.old_value[key] != self.new_value[key]:
                diff["changed"][key] = {
                    "old": self.old_value[key],
                    "new": self.new_value[key]
                }

        return diff


# Default version retention limit
DEFAULT_VERSION_RETENTION = 10


@dataclass
class StateVersion:
    """Represents a historical version of state."""
    version: int
    timestamp: str
    data: Dict[str, Any]
    source: str
    change_type: str

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "version": self.version,
            "timestamp": self.timestamp,
            "data": self.data,
            "source": self.source,
            "change_type": self.change_type
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "StateVersion":
        """Create from dictionary."""
        return cls(
            version=data["version"],
            timestamp=data["timestamp"],
            data=data["data"],
            source=data.get("source", "unknown"),
            change_type=data.get("change_type", "update")
        )


@dataclass
class VersionInfo:
    """Summary info for a version (without full data)."""
    version: int
    timestamp: str
    source: str
    change_type: str
    data_hash: str

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary."""
        return {
            "version": self.version,
            "timestamp": self.timestamp,
            "source": self.source,
            "change_type": self.change_type,
            "data_hash": self.data_hash
        }


class StateFileHandler(FileSystemEventHandler if HAS_WATCHDOG else object):
    """Watchdog handler for state file changes."""

    def __init__(self, manager: "StateManager"):
        self.manager = manager
        if HAS_WATCHDOG:
            super().__init__()

    def on_modified(self, event):
        """Handle file modification."""
        if hasattr(event, 'is_directory') and event.is_directory:
            return
        if hasattr(event, 'src_path'):
            self.manager._on_file_changed(event.src_path)

    def on_created(self, event):
        """Handle file creation."""
        if hasattr(event, 'is_directory') and event.is_directory:
            return
        if hasattr(event, 'src_path'):
            self.manager._on_file_changed(event.src_path)


# Type alias for subscription callbacks
StateCallback = Callable[[StateChange], None]


# -----------------------------------------------------------------------------
# Subscription Filters (SYN-016)
# -----------------------------------------------------------------------------

class SubscriptionFilter:
    """
    Filter for selective state change subscriptions.

    Allows subscribing to specific files and/or change types.
    """

    def __init__(
        self,
        files: Optional[List[Union[str, ManagedFile]]] = None,
        change_types: Optional[List[str]] = None
    ):
        """
        Initialize subscription filter.

        Args:
            files: List of files to subscribe to (None = all files)
            change_types: List of change types to filter ("create", "update", "delete")
        """
        self.files = files
        self.change_types = change_types

    def matches(self, change: StateChange, loki_dir: Path) -> bool:
        """Check if a change matches this filter."""
        # Check file filter
        if self.files:
            filter_paths = set()
            for f in self.files:
                if isinstance(f, ManagedFile):
                    filter_paths.add(f.value)
                else:
                    filter_paths.add(f)

            if change.file_path not in filter_paths:
                return False

        # Check change type filter
        if self.change_types:
            if change.change_type not in self.change_types:
                return False

        return True


# -----------------------------------------------------------------------------
# Notification Channels (SYN-016)
# -----------------------------------------------------------------------------

class NotificationChannel:
    """Abstract base for notification channels."""

    def notify(self, change: StateChange) -> None:
        """Send notification for a state change."""
        raise NotImplementedError

    def close(self) -> None:
        """Close the notification channel."""
        pass


class FileNotificationChannel(NotificationChannel):
    """
    File-based notification channel for CLI/scripts.

    Writes change notifications to a file that can be monitored
    by external tools using tail -f or similar.
    """

    def __init__(self, notification_file: Path):
        """Initialize file notification channel."""
        self.notification_file = notification_file
        self.notification_file.parent.mkdir(parents=True, exist_ok=True)

    def notify(self, change: StateChange) -> None:
        """Write notification to file as JSONL (one JSON per line)."""
        try:
            notification = {
                "timestamp": change.timestamp,
                "file_path": change.file_path,
                "change_type": change.change_type,
                "source": change.source,
                "diff": change.get_diff()
            }
            with open(self.notification_file, "a") as f:
                fcntl.flock(f.fileno(), fcntl.LOCK_EX)
                f.write(json.dumps(notification) + "\n")
                fcntl.flock(f.fileno(), fcntl.LOCK_UN)
        except IOError:
            pass  # File notification errors shouldn't break state management


class InMemoryNotificationChannel(NotificationChannel):
    """
    In-memory notification channel for testing and embedding.

    Stores notifications in a list for later inspection.
    """

    def __init__(self, max_size: int = 1000):
        """Initialize in-memory notification channel."""
        self.notifications: List[Dict[str, Any]] = []
        self.max_size = max_size
        self._lock = threading.Lock()

    def notify(self, change: StateChange) -> None:
        """Store notification in memory."""
        with self._lock:
            notification = {
                "timestamp": change.timestamp,
                "file_path": change.file_path,
                "change_type": change.change_type,
                "source": change.source,
                "old_value": change.old_value,
                "new_value": change.new_value,
                "diff": change.get_diff()
            }
            self.notifications.append(notification)
            # Keep only recent notifications
            if len(self.notifications) > self.max_size:
                self.notifications = self.notifications[-self.max_size:]

    def get_notifications(self) -> List[Dict[str, Any]]:
        """Get all stored notifications."""
        with self._lock:
            return list(self.notifications)

    def clear(self) -> None:
        """Clear all stored notifications."""
        with self._lock:
            self.notifications.clear()


class StateManager:
    """
    Centralized state manager for Loki Mode.

    Manages state files with:
    - In-memory caching for fast reads
    - File locking for thread-safe writes
    - File watching for external change detection
    - Event bus integration for broadcasting
    - Subscription system for reactive updates

    Usage:
        manager = StateManager()

        # Get state
        state = manager.get_state(ManagedFile.ORCHESTRATOR)

        # Set state
        manager.set_state(ManagedFile.ORCHESTRATOR, {"phase": "planning"})

        # Subscribe to changes
        def on_change(change: StateChange):
            print(f"Changed: {change.file_path}")

        unsubscribe = manager.subscribe(on_change)

        # Cleanup
        manager.stop()
    """

    def __init__(
        self,
        loki_dir: Optional[Union[str, Path]] = None,
        enable_watch: bool = True,
        enable_events: bool = True,
        enable_versioning: bool = True,
        version_retention: int = DEFAULT_VERSION_RETENTION
    ):
        """
        Initialize the state manager.

        Args:
            loki_dir: Path to .loki directory. Defaults to ./.loki
            enable_watch: Enable file watching for external changes
            enable_events: Enable event bus integration
            enable_versioning: Enable version history for rollback (SYN-015)
            version_retention: Number of versions to retain per file (default: 10)
        """
        self.loki_dir = Path(loki_dir) if loki_dir else Path(".loki")
        self.enable_watch = enable_watch and HAS_WATCHDOG
        self.enable_events = enable_events and HAS_EVENT_BUS
        self.enable_versioning = enable_versioning
        self.version_retention = version_retention

        # In-memory cache: file_path -> (data, hash, mtime)
        self._cache: Dict[str, tuple] = {}
        self._cache_lock = threading.RLock()

        # Subscribers: set of callbacks
        self._subscribers: Set[StateCallback] = set()
        self._subscriber_lock = threading.Lock()

        # File watcher
        self._observer: Optional[Observer] = None
        self._handler: Optional[StateFileHandler] = None

        # Event bus
        self._event_bus: Optional[EventBus] = None

        # Optimistic updates tracking
        self._pending_updates: Dict[str, List[PendingUpdate]] = {}  # file_path -> list of pending updates
        self._version_vectors: Dict[str, VersionVector] = {}  # file_path -> version vector
        self._conflict_strategy: ConflictStrategy = ConflictStrategy.LAST_WRITE_WINS

        # Version counters for state versioning (SYN-015)
        self._version_counters: Dict[str, int] = {}  # file_key -> current version number

        # Notification channels (SYN-016)
        self._notification_channels: List[NotificationChannel] = []
        self._notification_channels_lock = threading.Lock()

        # Filtered subscribers (SYN-016): list of (callback, filter)
        self._filtered_subscribers: List[Tuple[StateCallback, SubscriptionFilter]] = []

        # Ensure directories exist
        self._ensure_directories()

        # Start file watching
        if self.enable_watch:
            self._start_watching()

        # Initialize event bus
        if self.enable_events:
            self._init_event_bus()

    def _ensure_directories(self) -> None:
        """Ensure all required directories exist."""
        directories = [
            self.loki_dir,
            self.loki_dir / "state",
            self.loki_dir / "state" / "history",  # Version history (SYN-015)
            self.loki_dir / "queue",
            self.loki_dir / "memory",
            self.loki_dir / "events",
        ]
        for directory in directories:
            directory.mkdir(parents=True, exist_ok=True)

    def _start_watching(self) -> None:
        """Start file system watcher."""
        if not HAS_WATCHDOG:
            return

        self._handler = StateFileHandler(self)
        self._observer = Observer()
        self._observer.schedule(self._handler, str(self.loki_dir), recursive=True)
        self._observer.start()

    def _init_event_bus(self) -> None:
        """Initialize event bus connection."""
        if not HAS_EVENT_BUS:
            return

        self._event_bus = EventBus(self.loki_dir)

    def stop(self) -> None:
        """Stop the state manager and cleanup resources."""
        if self._observer:
            self._observer.stop()
            self._observer.join(timeout=2.0)
            self._observer = None

        self._cache.clear()
        self._subscribers.clear()
        self._filtered_subscribers.clear()

        # Close all notification channels
        with self._notification_channels_lock:
            for channel in self._notification_channels:
                try:
                    channel.close()
                except Exception:
                    pass
            self._notification_channels.clear()

    # -------------------------------------------------------------------------
    # File Locking
    # -------------------------------------------------------------------------

    @contextmanager
    def _file_lock(self, path: Path, exclusive: bool = True):
        """
        Context manager for file locking.

        Args:
            path: Path to the file to lock
            exclusive: If True, acquire exclusive lock. Otherwise shared lock.

        Yields:
            None (lock is held)
        """
        lock_path = path.with_suffix(path.suffix + ".lock")
        lock_path.parent.mkdir(parents=True, exist_ok=True)

        lock_file = None
        try:
            lock_file = open(lock_path, "w")
            lock_type = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
            fcntl.flock(lock_file.fileno(), lock_type)
            yield
        finally:
            if lock_file is not None:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
                lock_file.close()

    # -------------------------------------------------------------------------
    # File I/O
    # -------------------------------------------------------------------------

    def _resolve_path(self, file_ref: Union[str, ManagedFile]) -> Path:
        """Resolve a file reference to an absolute path."""
        if isinstance(file_ref, ManagedFile):
            rel_path = file_ref.value
        else:
            rel_path = file_ref

        return self.loki_dir / rel_path

    def _compute_hash(self, data: Dict[str, Any]) -> str:
        """Compute a hash of the data for change detection."""
        content = json.dumps(data, sort_keys=True, default=str)
        return hashlib.md5(content.encode()).hexdigest()

    def _read_file(self, path: Path) -> Optional[Dict[str, Any]]:
        """Read JSON file with shared lock."""
        if not path.exists():
            return None

        with self._file_lock(path, exclusive=False):
            with open(path, "r") as f:
                try:
                    return json.load(f)
                except json.JSONDecodeError:
                    # Handle corrupted or empty JSON files
                    return None

    def _write_file(self, path: Path, data: Dict[str, Any]) -> None:
        """Write JSON file atomically with exclusive lock."""
        path.parent.mkdir(parents=True, exist_ok=True)

        with self._file_lock(path, exclusive=True):
            # Write to temp file first
            fd, temp_path = tempfile.mkstemp(
                dir=path.parent,
                prefix=".tmp_",
                suffix=".json"
            )
            try:
                with os.fdopen(fd, "w") as f:
                    json.dump(data, f, indent=2, default=str)
                # Atomic rename
                shutil.move(temp_path, path)
            except Exception:
                if os.path.exists(temp_path):
                    os.unlink(temp_path)
                raise

    # -------------------------------------------------------------------------
    # Cache Management
    # -------------------------------------------------------------------------

    def _get_from_cache(self, path: Path) -> Optional[Dict[str, Any]]:
        """Get data from cache if valid."""
        with self._cache_lock:
            if str(path) not in self._cache:
                return None

            data, cached_hash, cached_mtime = self._cache[str(path)]

            # Check if file still exists and mtime matches
            if path.exists():
                current_mtime = path.stat().st_mtime
                if current_mtime == cached_mtime:
                    return data

            return None

    def _put_in_cache(self, path: Path, data: Dict[str, Any]) -> None:
        """Put data in cache."""
        with self._cache_lock:
            data_hash = self._compute_hash(data)
            mtime = path.stat().st_mtime if path.exists() else 0
            self._cache[str(path)] = (data, data_hash, mtime)

    def _invalidate_cache(self, path: Path) -> None:
        """Invalidate cache entry."""
        with self._cache_lock:
            self._cache.pop(str(path), None)

    # -------------------------------------------------------------------------
    # State Operations
    # -------------------------------------------------------------------------

    def get_state(
        self,
        file_ref: Union[str, ManagedFile],
        default: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Get state from a managed file.

        Args:
            file_ref: File reference (ManagedFile enum or relative path)
            default: Default value if file doesn't exist

        Returns:
            State dictionary or default value
        """
        path = self._resolve_path(file_ref)

        # Try cache first
        cached = self._get_from_cache(path)
        if cached is not None:
            return cached

        # Read from file
        data = self._read_file(path)
        if data is None:
            return default

        # Update cache
        self._put_in_cache(path, data)

        return data

    def set_state(
        self,
        file_ref: Union[str, ManagedFile],
        data: Dict[str, Any],
        source: str = "state-manager",
        save_version: bool = True
    ) -> StateChange:
        """
        Set state in a managed file.

        Args:
            file_ref: File reference (ManagedFile enum or relative path)
            data: State data to write
            source: Source of the change (for tracking)
            save_version: Whether to save a version history entry (SYN-015)

        Returns:
            StateChange object describing the change
        """
        path = self._resolve_path(file_ref)

        # Get old value for change tracking
        old_value = self.get_state(file_ref)

        # Determine change type
        change_type = "create" if old_value is None else "update"

        # Save version before writing new data (SYN-015)
        if self.enable_versioning and save_version and old_value is not None:
            self._save_version(file_ref, old_value, source, change_type)

        # Write to file
        self._write_file(path, data)

        # Update cache
        self._put_in_cache(path, data)

        # Create change object
        change = StateChange(
            file_path=str(path.relative_to(self.loki_dir)),
            old_value=old_value,
            new_value=data,
            change_type=change_type,
            source=source
        )

        # Broadcast change
        self._broadcast(change)

        return change

    def update_state(
        self,
        file_ref: Union[str, ManagedFile],
        updates: Dict[str, Any],
        source: str = "state-manager"
    ) -> StateChange:
        """
        Merge updates into existing state.

        Args:
            file_ref: File reference
            updates: Dictionary of updates to merge
            source: Source of the change

        Returns:
            StateChange object
        """
        current = self.get_state(file_ref, default={})
        merged = {**current, **updates}
        return self.set_state(file_ref, merged, source)

    def delete_state(
        self,
        file_ref: Union[str, ManagedFile],
        source: str = "state-manager"
    ) -> Optional[StateChange]:
        """
        Delete a managed state file.

        Args:
            file_ref: File reference
            source: Source of the change

        Returns:
            StateChange object or None if file didn't exist
        """
        path = self._resolve_path(file_ref)

        if not path.exists():
            return None

        old_value = self.get_state(file_ref)

        with self._file_lock(path, exclusive=True):
            path.unlink()

        # Invalidate cache
        self._invalidate_cache(path)

        # Create change object
        change = StateChange(
            file_path=str(path.relative_to(self.loki_dir)),
            old_value=old_value,
            new_value={},
            change_type="delete",
            source=source
        )

        # Broadcast change
        self._broadcast(change)

        return change

    # -------------------------------------------------------------------------
    # Subscriptions
    # -------------------------------------------------------------------------

    def subscribe(
        self,
        callback: StateCallback,
        file_filter: Optional[List[Union[str, ManagedFile]]] = None,
        change_types: Optional[List[str]] = None
    ) -> Callable[[], None]:
        """
        Subscribe to state changes with optional filtering.

        Args:
            callback: Function to call on state changes
            file_filter: Optional list of files to filter (None = all files)
            change_types: Optional list of change types to filter ("create", "update", "delete")

        Returns:
            Unsubscribe function
        """
        # Create filter if any filtering is specified
        if file_filter or change_types:
            sub_filter = SubscriptionFilter(files=file_filter, change_types=change_types)
            with self._subscriber_lock:
                self._filtered_subscribers.append((callback, sub_filter))

            def unsubscribe():
                with self._subscriber_lock:
                    self._filtered_subscribers = [
                        (cb, flt) for cb, flt in self._filtered_subscribers
                        if cb is not callback
                    ]

            return unsubscribe
        else:
            # No filter, use simple subscriber set
            with self._subscriber_lock:
                self._subscribers.add(callback)

            def unsubscribe():
                with self._subscriber_lock:
                    self._subscribers.discard(callback)

            return unsubscribe

    def subscribe_filtered(
        self,
        callback: StateCallback,
        filter_obj: SubscriptionFilter
    ) -> Callable[[], None]:
        """
        Subscribe to state changes with a SubscriptionFilter object.

        Args:
            callback: Function to call on state changes
            filter_obj: SubscriptionFilter specifying files and/or change types

        Returns:
            Unsubscribe function
        """
        with self._subscriber_lock:
            self._filtered_subscribers.append((callback, filter_obj))

        def unsubscribe():
            with self._subscriber_lock:
                self._filtered_subscribers = [
                    (cb, flt) for cb, flt in self._filtered_subscribers
                    if cb is not callback
                ]

        return unsubscribe

    def add_notification_channel(self, channel: NotificationChannel) -> Callable[[], None]:
        """
        Add a notification channel for state changes.

        Args:
            channel: NotificationChannel to add

        Returns:
            Function to remove the channel
        """
        with self._notification_channels_lock:
            self._notification_channels.append(channel)

        def remove_channel():
            with self._notification_channels_lock:
                if channel in self._notification_channels:
                    self._notification_channels.remove(channel)
                    channel.close()

        return remove_channel

    def _notify_subscribers(self, change: StateChange) -> None:
        """Notify all internal subscribers (callback-based)."""
        # Notify simple subscribers (no filter)
        with self._subscriber_lock:
            simple_subscribers = list(self._subscribers)
            filtered_subscribers = list(self._filtered_subscribers)

        for callback in simple_subscribers:
            try:
                callback(change)
            except Exception:
                pass  # Don't let one callback break others

        # Notify filtered subscribers
        for callback, sub_filter in filtered_subscribers:
            try:
                if sub_filter.matches(change, self.loki_dir):
                    callback(change)
            except Exception:
                pass  # Don't let one callback break others

    def _emit_state_event(self, change: StateChange) -> None:
        """Emit state change event to the event bus."""
        if not self._event_bus or not self.enable_events:
            return

        try:
            self._event_bus.emit_simple(
                event_type=EventType.STATE,
                source=EventSource.RUNNER,
                action="state_changed",
                file_path=change.file_path,
                change_type=change.change_type,
                source_component=change.source,
                timestamp=change.timestamp,
                diff=change.get_diff()
            )
        except Exception:
            pass  # Event bus errors shouldn't break state management

    def _notify_channels(self, change: StateChange) -> None:
        """Notify all notification channels (file-based, WebSocket, etc.)."""
        with self._notification_channels_lock:
            channels = list(self._notification_channels)

        for channel in channels:
            try:
                channel.notify(change)
            except Exception:
                pass  # Channel errors shouldn't break state management

    def _broadcast(self, change: StateChange) -> None:
        """
        Broadcast a state change to all subscribers and channels.

        This is the main notification method that:
        1. Notifies internal callback subscribers
        2. Emits events to the event bus
        3. Sends notifications to all registered channels (file, WebSocket, etc.)
        """
        # 1. Notify internal subscribers
        self._notify_subscribers(change)

        # 2. Emit to event bus
        self._emit_state_event(change)

        # 3. Notify notification channels
        self._notify_channels(change)

    # -------------------------------------------------------------------------
    # File Watching
    # -------------------------------------------------------------------------

    def _on_file_changed(self, file_path: str) -> None:
        """Handle file change detected by watchdog."""
        path = Path(file_path)

        # Only handle JSON files
        if not path.suffix == ".json":
            return

        # Ignore lock files and temp files
        if ".lock" in path.name or path.name.startswith(".tmp_"):
            return

        # Get old value from cache BEFORE invalidating (fix race condition)
        with self._cache_lock:
            old_entry = self._cache.get(str(path))
            old_value = old_entry[0] if old_entry else None

        # Invalidate cache
        self._invalidate_cache(path)

        # Read new value
        try:
            new_value = self._read_file(path)
        except Exception:
            return

        if new_value is None:
            return

        # Update cache
        self._put_in_cache(path, new_value)

        # Create and broadcast change
        try:
            rel_path = path.relative_to(self.loki_dir)
        except ValueError:
            rel_path = path

        change = StateChange(
            file_path=str(rel_path),
            old_value=old_value,
            new_value=new_value,
            change_type="update",
            source="external"
        )

        self._broadcast(change)

    # -------------------------------------------------------------------------
    # Convenience Methods
    # -------------------------------------------------------------------------

    def get_orchestrator_state(self) -> Optional[Dict[str, Any]]:
        """Get orchestrator state."""
        return self.get_state(ManagedFile.ORCHESTRATOR)

    def get_autonomy_state(self) -> Optional[Dict[str, Any]]:
        """Get autonomy state."""
        return self.get_state(ManagedFile.AUTONOMY)

    def get_queue_state(self, queue_type: str = "pending") -> Optional[Dict[str, Any]]:
        """Get queue state by type."""
        queue_map = {
            "pending": ManagedFile.QUEUE_PENDING,
            "in-progress": ManagedFile.QUEUE_IN_PROGRESS,
            "completed": ManagedFile.QUEUE_COMPLETED,
            "failed": ManagedFile.QUEUE_FAILED,
            "current": ManagedFile.QUEUE_CURRENT,
        }
        file_ref = queue_map.get(queue_type, ManagedFile.QUEUE_PENDING)
        return self.get_state(file_ref)

    def get_memory_index(self) -> Optional[Dict[str, Any]]:
        """Get memory index."""
        return self.get_state(ManagedFile.MEMORY_INDEX)

    def set_orchestrator_state(
        self,
        state: Dict[str, Any],
        source: str = "orchestrator"
    ) -> StateChange:
        """Set orchestrator state."""
        return self.set_state(ManagedFile.ORCHESTRATOR, state, source)

    def set_autonomy_state(
        self,
        state: Dict[str, Any],
        source: str = "autonomy"
    ) -> StateChange:
        """Set autonomy state."""
        return self.set_state(ManagedFile.AUTONOMY, state, source)

    def update_orchestrator_phase(
        self,
        phase: str,
        source: str = "orchestrator"
    ) -> StateChange:
        """Update orchestrator phase."""
        return self.update_state(
            ManagedFile.ORCHESTRATOR,
            {"currentPhase": phase, "lastUpdated": datetime.now(timezone.utc).isoformat()},
            source
        )

    def update_autonomy_status(
        self,
        status: str,
        source: str = "autonomy"
    ) -> StateChange:
        """Update autonomy status."""
        return self.update_state(
            ManagedFile.AUTONOMY,
            {"status": status, "lastRun": datetime.now(timezone.utc).isoformat()},
            source
        )

    # -------------------------------------------------------------------------
    # Batch Operations
    # -------------------------------------------------------------------------

    def get_all_states(self) -> Dict[str, Dict[str, Any]]:
        """Get all managed states as a dictionary."""
        states = {}
        for file_ref in ManagedFile:
            state = self.get_state(file_ref)
            if state is not None:
                states[file_ref.name] = state
        return states

    def refresh_cache(self) -> None:
        """Refresh all cached entries from disk."""
        with self._cache_lock:
            for path_str in list(self._cache.keys()):
                path = Path(path_str)
                if path.exists():
                    data = self._read_file(path)
                    if data:
                        self._put_in_cache(path, data)
                else:
                    del self._cache[path_str]

    # -------------------------------------------------------------------------
    # Optimistic Updates (SYN-014)
    # -------------------------------------------------------------------------

    def set_conflict_strategy(self, strategy: ConflictStrategy) -> None:
        """Set the default conflict resolution strategy."""
        self._conflict_strategy = strategy

    def get_version_vector(
        self,
        file_ref: Union[str, ManagedFile]
    ) -> VersionVector:
        """Get the current version vector for a file."""
        path = self._resolve_path(file_ref)
        path_str = str(path)

        if path_str not in self._version_vectors:
            # Try to load from file metadata
            state = self.get_state(file_ref)
            if state and "_version_vector" in state:
                self._version_vectors[path_str] = VersionVector.from_dict(
                    state["_version_vector"]
                )
            else:
                self._version_vectors[path_str] = VersionVector()

        return self._version_vectors[path_str]

    def optimistic_update(
        self,
        file_ref: Union[str, ManagedFile],
        key: str,
        value: Any,
        source: str = "state-manager"
    ) -> PendingUpdate:
        """
        Apply an optimistic update immediately and queue for verification.

        The update is applied to local state immediately but tracked as pending
        until verified against the canonical state. If conflicts are detected
        during verification, they are resolved using the configured strategy.

        Args:
            file_ref: File reference (ManagedFile enum or relative path)
            key: The key to update within the state
            value: The new value
            source: Source of the update (for conflict detection)

        Returns:
            PendingUpdate object tracking this update
        """
        path = self._resolve_path(file_ref)
        path_str = str(path)

        # Get current version vector and increment for this source
        version_vector = self.get_version_vector(file_ref)
        version_vector.increment(source)

        # Create pending update
        pending = PendingUpdate(
            id=str(uuid.uuid4()),
            key=key,
            value=value,
            source=source,
            timestamp=datetime.now(timezone.utc).isoformat(),
            version_vector=VersionVector.from_dict(version_vector.to_dict())
        )

        # Track pending update
        if path_str not in self._pending_updates:
            self._pending_updates[path_str] = []
        self._pending_updates[path_str].append(pending)

        # Apply optimistically to local state
        current_state = self.get_state(file_ref, default={})
        current_state[key] = value
        current_state["_version_vector"] = version_vector.to_dict()
        current_state["_last_source"] = source
        current_state["_last_updated"] = pending.timestamp

        # Write state with version tracking
        self._write_file(path, current_state)
        self._put_in_cache(path, current_state)

        return pending

    def get_pending_updates(
        self,
        file_ref: Union[str, ManagedFile]
    ) -> List[PendingUpdate]:
        """Get all pending updates for a file."""
        path = self._resolve_path(file_ref)
        path_str = str(path)
        return self._pending_updates.get(path_str, [])

    def detect_conflicts(
        self,
        file_ref: Union[str, ManagedFile],
        remote_state: Dict[str, Any],
        remote_source: str
    ) -> List[ConflictInfo]:
        """
        Detect conflicts between local pending updates and remote state.

        Args:
            file_ref: File reference
            remote_state: State from remote/canonical source
            remote_source: Source identifier for remote state

        Returns:
            List of detected conflicts
        """
        path = self._resolve_path(file_ref)
        path_str = str(path)

        conflicts: List[ConflictInfo] = []
        pending = self._pending_updates.get(path_str, [])

        if not pending:
            return conflicts

        # Get remote version vector
        remote_vv = VersionVector()
        if "_version_vector" in remote_state:
            remote_vv = VersionVector.from_dict(remote_state["_version_vector"])

        local_state = self.get_state(file_ref, default={})

        # Check each pending update for conflicts
        for update in pending:
            if update.status != "pending":
                continue

            key = update.key

            # Check if same key was modified in remote state
            if key in remote_state and key in local_state:
                local_val = local_state[key]
                remote_val = remote_state[key]

                # Only conflict if values differ and versions are concurrent
                if local_val != remote_val:
                    if update.version_vector.concurrent_with(remote_vv):
                        conflict = ConflictInfo(
                            key=key,
                            local_value=local_val,
                            remote_value=remote_val,
                            local_source=update.source,
                            remote_source=remote_source,
                            local_version=update.version_vector,
                            remote_version=remote_vv
                        )
                        conflicts.append(conflict)

        return conflicts

    def resolve_conflicts(
        self,
        file_ref: Union[str, ManagedFile],
        conflicts: List[ConflictInfo],
        strategy: Optional[ConflictStrategy] = None
    ) -> Dict[str, Any]:
        """
        Resolve conflicts using the specified strategy.

        Args:
            file_ref: File reference
            conflicts: List of conflicts to resolve
            strategy: Resolution strategy (uses default if not specified)

        Returns:
            Resolved state dictionary
        """
        if strategy is None:
            strategy = self._conflict_strategy

        path = self._resolve_path(file_ref)
        path_str = str(path)

        local_state = self.get_state(file_ref, default={})
        resolved_state = dict(local_state)

        for conflict in conflicts:
            if strategy == ConflictStrategy.LAST_WRITE_WINS:
                # Use remote value (assuming remote is more recent)
                resolved_state[conflict.key] = conflict.remote_value
                conflict.resolution = "last_write_wins"
                conflict.resolved_value = conflict.remote_value

            elif strategy == ConflictStrategy.MERGE:
                # Attempt to merge values
                merged = self._merge_values(
                    conflict.local_value,
                    conflict.remote_value
                )
                resolved_state[conflict.key] = merged
                conflict.resolution = "merged"
                conflict.resolved_value = merged

            elif strategy == ConflictStrategy.REJECT:
                # Keep local value, mark conflict as rejected
                conflict.resolution = "rejected"
                conflict.resolved_value = conflict.local_value
                # Mark pending updates for this key as rejected
                for update in self._pending_updates.get(path_str, []):
                    if update.key == conflict.key and update.status == "pending":
                        update.status = "rejected"

        # Merge version vectors
        local_vv = self.get_version_vector(file_ref)
        for conflict in conflicts:
            local_vv = local_vv.merge(conflict.remote_version)

        resolved_state["_version_vector"] = local_vv.to_dict()
        self._version_vectors[path_str] = local_vv

        return resolved_state

    def _merge_values(self, local: Any, remote: Any) -> Any:
        """
        Attempt to merge two values.

        For dictionaries, performs a deep merge.
        For lists, concatenates and deduplicates.
        For other types, prefers remote value.
        """
        if isinstance(local, dict) and isinstance(remote, dict):
            merged = dict(local)
            for key, value in remote.items():
                if key in merged:
                    merged[key] = self._merge_values(merged[key], value)
                else:
                    merged[key] = value
            return merged

        elif isinstance(local, list) and isinstance(remote, list):
            # Concatenate and deduplicate (preserving order)
            seen = set()
            merged = []
            for item in local + remote:
                item_key = json.dumps(item, sort_keys=True, default=str) if isinstance(item, (dict, list)) else item
                if item_key not in seen:
                    seen.add(item_key)
                    merged.append(item)
            return merged

        else:
            # For scalars, prefer remote
            return remote

    def commit_pending_updates(
        self,
        file_ref: Union[str, ManagedFile]
    ) -> int:
        """
        Commit all pending updates for a file.

        This marks pending updates as committed and clears them from tracking.

        Args:
            file_ref: File reference

        Returns:
            Number of updates committed
        """
        path = self._resolve_path(file_ref)
        path_str = str(path)

        pending = self._pending_updates.get(path_str, [])
        committed = 0

        for update in pending:
            if update.status == "pending":
                update.status = "committed"
                committed += 1

        # Clear committed updates
        self._pending_updates[path_str] = [
            u for u in pending if u.status != "committed"
        ]

        return committed

    def rollback_pending_updates(
        self,
        file_ref: Union[str, ManagedFile],
        original_state: Dict[str, Any]
    ) -> int:
        """
        Rollback pending updates and restore original state.

        Args:
            file_ref: File reference
            original_state: State to restore

        Returns:
            Number of updates rolled back
        """
        path = self._resolve_path(file_ref)
        path_str = str(path)

        pending = self._pending_updates.get(path_str, [])
        rolled_back = 0

        for update in pending:
            if update.status == "pending":
                update.status = "rejected"
                rolled_back += 1

        # Restore original state
        self.set_state(file_ref, original_state, source="rollback")

        # Clear pending updates
        self._pending_updates[path_str] = []

        return rolled_back

    def sync_with_remote(
        self,
        file_ref: Union[str, ManagedFile],
        remote_state: Dict[str, Any],
        remote_source: str,
        strategy: Optional[ConflictStrategy] = None
    ) -> Tuple[Dict[str, Any], List[ConflictInfo], int]:
        """
        Synchronize local state with remote state, resolving conflicts.

        This is a high-level operation that:
        1. Detects conflicts between local pending updates and remote state
        2. Resolves conflicts using the specified strategy
        3. Commits or rejects pending updates accordingly
        4. Returns the final synchronized state

        Args:
            file_ref: File reference
            remote_state: State from remote/canonical source
            remote_source: Source identifier for remote state
            strategy: Conflict resolution strategy

        Returns:
            Tuple of (resolved_state, conflicts_resolved, updates_committed)
        """
        # Detect conflicts
        conflicts = self.detect_conflicts(file_ref, remote_state, remote_source)

        # Resolve conflicts
        resolved_state = self.resolve_conflicts(file_ref, conflicts, strategy)

        # Apply resolved state
        self.set_state(file_ref, resolved_state, source="sync")

        # Commit pending updates (non-rejected ones)
        committed = self.commit_pending_updates(file_ref)

        return resolved_state, conflicts, committed

    # -------------------------------------------------------------------------
    # State Versioning (SYN-015)
    # -------------------------------------------------------------------------

    def _get_file_key(self, file_ref: Union[str, ManagedFile]) -> str:
        """Get a safe key for the file reference (used in history paths)."""
        if isinstance(file_ref, ManagedFile):
            rel_path = file_ref.value
        else:
            rel_path = file_ref
        # Convert path separators to underscores for safe directory names
        return rel_path.replace("/", "_").replace("\\", "_").replace(".json", "")

    def _get_history_dir(self, file_ref: Union[str, ManagedFile]) -> Path:
        """Get the history directory for a file reference."""
        file_key = self._get_file_key(file_ref)
        return self.loki_dir / "state" / "history" / file_key

    def _get_next_version(self, file_ref: Union[str, ManagedFile]) -> int:
        """Get the next version number for a file."""
        file_key = self._get_file_key(file_ref)
        if file_key not in self._version_counters:
            # Initialize from existing versions on disk
            history_dir = self._get_history_dir(file_ref)
            if history_dir.exists():
                versions = glob_module.glob(str(history_dir / "*.json"))
                if versions:
                    max_version = 0
                    for v in versions:
                        try:
                            version_num = int(Path(v).stem)
                            max_version = max(max_version, version_num)
                        except ValueError:
                            pass
                    self._version_counters[file_key] = max_version
                else:
                    self._version_counters[file_key] = 0
            else:
                self._version_counters[file_key] = 0
        self._version_counters[file_key] += 1
        return self._version_counters[file_key]

    def _save_version(
        self,
        file_ref: Union[str, ManagedFile],
        data: Dict[str, Any],
        source: str,
        change_type: str
    ) -> int:
        """
        Save a version of the state to history.

        Args:
            file_ref: File reference
            data: State data to save
            source: Source of the change
            change_type: Type of change (create, update, delete)

        Returns:
            Version number
        """
        history_dir = self._get_history_dir(file_ref)
        history_dir.mkdir(parents=True, exist_ok=True)

        version = self._get_next_version(file_ref)
        timestamp = datetime.now(timezone.utc).isoformat()

        version_data = StateVersion(
            version=version,
            timestamp=timestamp,
            data=data,
            source=source,
            change_type=change_type
        )

        version_path = history_dir / f"{version}.json"
        self._write_file(version_path, version_data.to_dict())

        # Clean up old versions
        self._cleanup_old_versions(file_ref)

        return version

    def _cleanup_old_versions(self, file_ref: Union[str, ManagedFile]) -> None:
        """Remove versions beyond the retention limit."""
        history_dir = self._get_history_dir(file_ref)
        if not history_dir.exists():
            return

        version_files = glob_module.glob(str(history_dir / "*.json"))
        if len(version_files) <= self.version_retention:
            return

        # Sort by version number and remove oldest
        version_nums = []
        for vf in version_files:
            try:
                version_num = int(Path(vf).stem)
                version_nums.append((version_num, vf))
            except ValueError:
                pass

        version_nums.sort(key=lambda x: x[0])
        to_remove = version_nums[:-self.version_retention]

        for _, vf in to_remove:
            try:
                os.unlink(vf)
            except OSError:
                pass

    def get_version_history(
        self,
        file_ref: Union[str, ManagedFile]
    ) -> List[VersionInfo]:
        """
        Get version history for a state file.

        Args:
            file_ref: File reference (ManagedFile enum or relative path)

        Returns:
            List of VersionInfo objects sorted by version (newest first)
        """
        history_dir = self._get_history_dir(file_ref)
        if not history_dir.exists():
            return []

        versions = []
        version_files = glob_module.glob(str(history_dir / "*.json"))

        for vf in version_files:
            try:
                version_num = int(Path(vf).stem)
                data = self._read_file(Path(vf))
                if data:
                    versions.append(VersionInfo(
                        version=version_num,
                        timestamp=data.get("timestamp", ""),
                        source=data.get("source", "unknown"),
                        change_type=data.get("change_type", "update"),
                        data_hash=self._compute_hash(data.get("data", {}))
                    ))
            except (ValueError, json.JSONDecodeError):
                pass

        # Sort by version descending (newest first)
        versions.sort(key=lambda v: v.version, reverse=True)
        return versions

    def get_state_at_version(
        self,
        file_ref: Union[str, ManagedFile],
        version: int
    ) -> Optional[Dict[str, Any]]:
        """
        Get state data at a specific version without restoring.

        Args:
            file_ref: File reference
            version: Version number to retrieve

        Returns:
            State data at that version or None if not found
        """
        history_dir = self._get_history_dir(file_ref)
        version_path = history_dir / f"{version}.json"

        if not version_path.exists():
            return None

        version_data = self._read_file(version_path)
        if version_data:
            return version_data.get("data")
        return None

    def rollback(
        self,
        file_ref: Union[str, ManagedFile],
        version: int,
        source: str = "rollback"
    ) -> Optional[StateChange]:
        """
        Restore state to a specific version.

        Args:
            file_ref: File reference
            version: Version number to restore to
            source: Source of the rollback operation

        Returns:
            StateChange object or None if version not found
        """
        data = self.get_state_at_version(file_ref, version)
        if data is None:
            return None

        # Save current state as a version before rollback
        current = self.get_state(file_ref)
        if current is not None and self.enable_versioning:
            self._save_version(file_ref, current, source, "pre_rollback")

        # Set the restored state (save_version=False since we already saved)
        return self.set_state(file_ref, data, source, save_version=False)

    def get_version_count(self, file_ref: Union[str, ManagedFile]) -> int:
        """
        Get the number of versions stored for a file.

        Args:
            file_ref: File reference

        Returns:
            Number of stored versions
        """
        history_dir = self._get_history_dir(file_ref)
        if not history_dir.exists():
            return 0
        return len(glob_module.glob(str(history_dir / "*.json")))

    def clear_version_history(self, file_ref: Union[str, ManagedFile]) -> int:
        """
        Clear all version history for a file.

        Args:
            file_ref: File reference

        Returns:
            Number of versions removed
        """
        history_dir = self._get_history_dir(file_ref)
        if not history_dir.exists():
            return 0

        version_files = glob_module.glob(str(history_dir / "*.json"))
        count = 0
        for vf in version_files:
            try:
                os.unlink(vf)
                count += 1
            except OSError:
                pass

        # Reset version counter
        file_key = self._get_file_key(file_ref)
        self._version_counters.pop(file_key, None)

        return count

    def set_version_retention(self, retention: int) -> None:
        """
        Update the version retention limit.

        Args:
            retention: New retention limit (must be >= 1)
        """
        if retention < 1:
            raise ValueError("Version retention must be at least 1")
        self.version_retention = retention


# Singleton instance for convenience
_default_manager: Optional[StateManager] = None


def get_state_manager(
    loki_dir: Optional[Union[str, Path]] = None,
    **kwargs
) -> StateManager:
    """Get the default state manager instance."""
    global _default_manager

    if _default_manager is None:
        _default_manager = StateManager(loki_dir, **kwargs)

    return _default_manager


def reset_state_manager() -> None:
    """Reset the default state manager (for testing)."""
    global _default_manager

    if _default_manager:
        _default_manager.stop()
        _default_manager = None
