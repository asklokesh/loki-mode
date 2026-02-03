"""
Loki Mode Unified Event Bus

Cross-process event propagation using file-based pub/sub.
Works across Python, Node.js, and Bash components.

Usage:
    from events import EventBus, LokiEvent

    # Emit event
    bus = EventBus()
    bus.emit(LokiEvent(
        type='task',
        source='cli',
        payload={'action': 'start', 'task_id': 'task-001'}
    ))

    # Subscribe to events
    for event in bus.subscribe(['task', 'state']):
        print(f"Got event: {event}")
"""

from .bus import EventBus, LokiEvent, EventType, EventSource

__all__ = ['EventBus', 'LokiEvent', 'EventType', 'EventSource']
