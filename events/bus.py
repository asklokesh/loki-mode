"""
Loki Mode Event Bus - File-based cross-process event propagation.

Events are written to .loki/events/pending/ and processed by subscribers.
This enables CLI, API, VS Code, and MCP to communicate without shared memory.
"""

import json
import logging
import os
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Generator, List, Optional, Callable
import threading

logger = logging.getLogger(__name__)


class EventType(str, Enum):
    """Event types that can be emitted."""
    STATE = 'state'           # State changes (phase, status)
    MEMORY = 'memory'         # Memory operations (store, retrieve)
    TASK = 'task'             # Task lifecycle (claim, complete, fail)
    METRIC = 'metric'         # Metrics (token usage, timing)
    ERROR = 'error'           # Errors and failures
    SESSION = 'session'       # Session lifecycle (start, stop, pause)
    COMMAND = 'command'       # CLI command execution
    USER = 'user'             # User actions (VS Code, dashboard)


class EventSource(str, Enum):
    """Sources that can emit events."""
    CLI = 'cli'
    API = 'api'
    VSCODE = 'vscode'
    MCP = 'mcp'
    SKILL = 'skill'
    HOOK = 'hook'
    DASHBOARD = 'dashboard'
    MEMORY = 'memory'
    RUNNER = 'runner'


@dataclass
class LokiEvent:
    """A Loki Mode event."""
    type: EventType
    source: EventSource
    payload: dict
    id: str = ''
    timestamp: str = ''
    version: str = '1.0'

    def __post_init__(self):
        if not self.id:
            self.id = str(uuid.uuid4())[:8]
        if not self.timestamp:
            self.timestamp = datetime.now(timezone.utc).isoformat()

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            'id': self.id,
            'type': self.type.value if isinstance(self.type, EventType) else self.type,
            'source': self.source.value if isinstance(self.source, EventSource) else self.source,
            'timestamp': self.timestamp,
            'payload': self.payload,
            'version': self.version
        }

    @classmethod
    def from_dict(cls, data: dict) -> 'LokiEvent':
        """Create event from dictionary.

        Handles compound types like 'session_start' by splitting on underscore
        and using the first token as the event type.
        """
        raw_type = data.get('type', '')
        raw_source = data.get('source', '')

        # Parse event type, handling compound values like "session_start"
        try:
            event_type = EventType(raw_type) if raw_type else EventType.STATE
        except ValueError:
            # Try splitting compound type on underscore
            first_token = raw_type.split('_')[0] if raw_type else ''
            try:
                event_type = EventType(first_token)
            except ValueError:
                event_type = EventType.STATE

        # Parse event source with fallback
        try:
            event_source = EventSource(raw_source) if raw_source else EventSource.CLI
        except ValueError:
            event_source = EventSource.CLI

        return cls(
            id=data.get('id', ''),
            type=event_type,
            source=event_source,
            timestamp=data.get('timestamp', ''),
            payload=data.get('payload', {}),
            version=data.get('version', '1.0')
        )


class EventBus:
    """
    File-based event bus for cross-process communication.

    Events are stored in:
    - .loki/events/pending/   - New events waiting to be processed
    - .loki/events/archive/   - Processed events (for replay/debugging)

    This design allows:
    - Cross-language compatibility (Python, Node, Bash)
    - Persistence (events survive process crashes)
    - Replay capability (debug past events)
    - No external dependencies
    """

    def __init__(self, loki_dir: Optional[Path] = None):
        """
        Initialize the event bus.

        Args:
            loki_dir: Path to .loki directory. Defaults to ./.loki
        """
        self.loki_dir = loki_dir or Path('.loki')
        self.events_dir = self.loki_dir / 'events'
        self.pending_dir = self.events_dir / 'pending'
        self.archive_dir = self.events_dir / 'archive'
        self.processed_file = self.events_dir / 'processed.json'

        # Ensure directories exist
        self.pending_dir.mkdir(parents=True, exist_ok=True)
        self.archive_dir.mkdir(parents=True, exist_ok=True)

        # Track processed event IDs with deterministic FIFO eviction order
        self._processed_ids: OrderedDict = self._load_processed_ids()

        # Subscribers for callback-based subscription
        self._subscribers: List[tuple] = []  # [(types, callback), ...]
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def _load_processed_ids(self) -> OrderedDict:
        """Load ordered dict of already processed event IDs."""
        try:
            if self.processed_file.exists():
                with open(self.processed_file, 'r') as f:
                    data = json.load(f)
                    # Keep only last 1000 IDs to prevent unbounded growth
                    ids = data.get('ids', [])[-1000:]
                    return OrderedDict.fromkeys(ids)
        except (json.JSONDecodeError, IOError):
            pass
        return OrderedDict()

    def _save_processed_id(self, event_id: str) -> None:
        """Save event ID as processed."""
        self._processed_ids[event_id] = None

        # Prune to last 1000 using FIFO eviction (deterministic order)
        while len(self._processed_ids) > 1000:
            self._processed_ids.popitem(last=False)

        lockfile = self.processed_file.with_suffix('.json.lock')
        try:
            # Use lockfile approach (cross-platform, compatible with TS)
            fd = os.open(str(lockfile), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            try:
                with open(self.processed_file, 'w') as f:
                    json.dump({'ids': list(self._processed_ids.keys())}, f)
            finally:
                try:
                    lockfile.unlink()
                except OSError:
                    pass
        except FileExistsError:
            # Another process holds the lock; skip this disk write.
            # In-memory state is already updated.
            pass
        except IOError:
            # Disk write failed -- in-memory state is already updated
            pass

    def emit(self, event: LokiEvent) -> str:
        """
        Emit an event to the bus.

        Args:
            event: The event to emit

        Returns:
            The event ID
        """
        event_file = self.pending_dir / f"{event.timestamp.replace(':', '-')}_{event.id}.json"
        lockfile = event_file.with_suffix('.json.lock')

        try:
            # Use lockfile approach (cross-platform, compatible with TS)
            fd = os.open(str(lockfile), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            try:
                with open(event_file, 'w') as f:
                    json.dump(event.to_dict(), f, indent=2)
            finally:
                try:
                    lockfile.unlink()
                except OSError:
                    pass
        except FileExistsError:
            # Lock held by another process; write without lock as fallback
            # Event files are unique per ID so collision is unlikely
            with open(event_file, 'w') as f:
                json.dump(event.to_dict(), f, indent=2)
        except IOError as e:
            raise RuntimeError(f"Failed to emit event: {e}")

        return event.id

    def emit_simple(
        self,
        event_type: EventType,
        source: EventSource,
        action: str,
        **kwargs
    ) -> str:
        """
        Simplified event emission.

        Args:
            event_type: Type of event
            source: Source component
            action: Action name (e.g., 'start', 'complete')
            **kwargs: Additional payload fields

        Returns:
            The event ID
        """
        payload = {'action': action, **kwargs}
        event = LokiEvent(type=event_type, source=source, payload=payload)
        return self.emit(event)

    def get_pending_events(
        self,
        types: Optional[List[EventType]] = None,
        since: Optional[str] = None
    ) -> List[LokiEvent]:
        """
        Get pending events, optionally filtered by type and time.

        Args:
            types: Event types to include (None = all)
            since: ISO timestamp to filter events after

        Returns:
            List of pending events
        """
        events = []

        for event_file in sorted(self.pending_dir.glob('*.json')):
            try:
                with open(event_file, 'r') as f:
                    data = json.load(f)
                    event = LokiEvent.from_dict(data)

                    # Filter by type
                    if types and event.type not in types:
                        continue

                    # Filter by time
                    if since and event.timestamp < since:
                        continue

                    # Skip already processed
                    if event.id in self._processed_ids:
                        continue

                    events.append(event)
            except (json.JSONDecodeError, IOError):
                continue

        return events

    def mark_processed(self, event: LokiEvent, archive: bool = True) -> None:
        """
        Mark an event as processed.

        Args:
            event: The event to mark
            archive: Whether to move to archive (default True)
        """
        self._save_processed_id(event.id)

        if archive:
            # Find and move the event file
            for event_file in self.pending_dir.glob(f'*_{event.id}.json'):
                archive_file = self.archive_dir / event_file.name
                try:
                    event_file.rename(archive_file)
                except IOError:
                    pass

    def subscribe(
        self,
        types: Optional[List[EventType]] = None,
        poll_interval: float = 0.5,
        timeout: Optional[float] = None
    ) -> Generator[LokiEvent, None, None]:
        """
        Subscribe to events (generator-based).

        Args:
            types: Event types to subscribe to (None = all)
            poll_interval: Seconds between polls
            timeout: Total timeout in seconds (None = infinite)

        Yields:
            Events as they arrive
        """
        start_time = time.time()
        last_check = datetime.now(timezone.utc).isoformat()

        while True:
            if timeout and (time.time() - start_time) > timeout:
                break

            # Set last_check BEFORE fetching to avoid missing events that
            # arrive between fetch and timestamp update
            next_check = datetime.now(timezone.utc).isoformat()
            events = self.get_pending_events(types=types, since=last_check)
            last_check = next_check

            for event in events:
                yield event
                self.mark_processed(event)

            if not events:
                time.sleep(poll_interval)

    def subscribe_callback(
        self,
        callback: Callable[[LokiEvent], None],
        types: Optional[List[EventType]] = None
    ) -> None:
        """
        Subscribe with a callback function.

        Args:
            callback: Function to call for each event
            types: Event types to subscribe to
        """
        self._subscribers.append((types, callback))

    def start_background_processing(self, poll_interval: float = 0.5) -> None:
        """Start background thread to process events."""
        if self._running:
            return

        self._running = True

        def process_loop():
            while self._running:
                events = self.get_pending_events()
                for event in events:
                    for types, callback in self._subscribers:
                        if types is None or event.type in types:
                            try:
                                callback(event)
                            except Exception:
                                logger.warning(
                                    "Event callback %s failed for event %s",
                                    getattr(callback, "__name__", callback),
                                    event.type,
                                    exc_info=True,
                                )
                    self.mark_processed(event)
                time.sleep(poll_interval)

        self._thread = threading.Thread(target=process_loop, daemon=True)
        self._thread.start()

    def stop_background_processing(self) -> None:
        """Stop background processing thread."""
        self._running = False
        if self._thread:
            self._thread.join(timeout=2.0)
            self._thread = None

    def close(self) -> None:
        """Clean up all threading resources."""
        self.stop_background_processing()
        self._subscribers.clear()

    def __del__(self) -> None:
        """Ensure threads are cleaned up on garbage collection."""
        try:
            self.close()
        except Exception:
            pass

    def __enter__(self) -> 'EventBus':
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def get_event_history(
        self,
        types: Optional[List[EventType]] = None,
        limit: int = 100
    ) -> List[LokiEvent]:
        """
        Get historical events from archive.

        Args:
            types: Event types to include
            limit: Maximum events to return

        Returns:
            List of historical events (newest first)
        """
        events = []

        # Get archived events, sorted by filename (timestamp)
        for event_file in sorted(self.archive_dir.glob('*.json'), reverse=True):
            if len(events) >= limit:
                break

            try:
                with open(event_file, 'r') as f:
                    data = json.load(f)
                    event = LokiEvent.from_dict(data)

                    if types and event.type not in types:
                        continue

                    events.append(event)
            except (json.JSONDecodeError, IOError):
                continue

        return events

    def clear_pending(self) -> int:
        """
        Clear all pending events.

        Returns:
            Number of events cleared
        """
        count = 0
        for event_file in self.pending_dir.glob('*.json'):
            try:
                event_file.unlink()
                count += 1
            except IOError:
                pass
        return count

    def import_from_jsonl(self, limit: int = 100) -> int:
        """Bridge: read events from events.jsonl and import as pending events.

        This bridges the gap between the append-only events.jsonl log
        (written by emit.sh and run.sh) and the pending/ directory
        consumed by subscribers.

        Args:
            limit: Maximum number of recent events to import

        Returns:
            Number of events imported
        """
        jsonl_file = self.loki_dir / 'events.jsonl'
        if not jsonl_file.exists():
            return 0

        imported = 0
        try:
            with open(jsonl_file, 'r') as f:
                # Read from end of file to get most recent events
                lines = f.readlines()
                recent = lines[-limit:] if len(lines) > limit else lines

            for line in recent:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    event = LokiEvent.from_dict(data)

                    # Skip if already processed
                    if event.id in self._processed_ids:
                        continue

                    # Check if pending file already exists
                    existing = list(self.pending_dir.glob(f'*_{event.id}.json'))
                    if existing:
                        continue

                    # Write as pending event
                    event_file = self.pending_dir / f"{event.timestamp.replace(':', '-')}_{event.id}.json"
                    with open(event_file, 'w') as f:
                        json.dump(event.to_dict(), f, indent=2)
                    imported += 1
                except (json.JSONDecodeError, KeyError):
                    continue
        except IOError:
            pass

        return imported

    def clear_archive(self, older_than_days: int = 7) -> int:
        """
        Clear archived events older than specified days.

        Args:
            older_than_days: Delete events older than this

        Returns:
            Number of events deleted
        """
        cutoff = time.time() - (older_than_days * 24 * 60 * 60)
        count = 0

        for event_file in self.archive_dir.glob('*.json'):
            try:
                if event_file.stat().st_mtime < cutoff:
                    event_file.unlink()
                    count += 1
            except IOError:
                pass

        return count


# Convenience functions for common events
def emit_session_event(source: EventSource, action: str, **kwargs) -> str:
    """Emit a session lifecycle event."""
    bus = EventBus()
    return bus.emit_simple(EventType.SESSION, source, action, **kwargs)


def emit_task_event(source: EventSource, action: str, task_id: str, **kwargs) -> str:
    """Emit a task lifecycle event."""
    bus = EventBus()
    return bus.emit_simple(EventType.TASK, source, action, task_id=task_id, **kwargs)


def emit_state_event(source: EventSource, action: str, **kwargs) -> str:
    """Emit a state change event."""
    bus = EventBus()
    return bus.emit_simple(EventType.STATE, source, action, **kwargs)


def emit_error_event(source: EventSource, error: str, **kwargs) -> str:
    """Emit an error event."""
    bus = EventBus()
    return bus.emit_simple(EventType.ERROR, source, 'error', error=error, **kwargs)
