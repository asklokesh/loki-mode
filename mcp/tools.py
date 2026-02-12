"""
Loki Mode MCP Tools

Additional tool definitions that can be imported into the server.
These are helper functions and utilities for the MCP tools.
Uses StateManager for centralized state access with caching.
"""

import os
import sys
import json
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

# Add parent directory to path for state manager import
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Import StateManager for centralized state access
try:
    from state.manager import StateManager, ManagedFile, get_state_manager
    HAS_STATE_MANAGER = True
except ImportError:
    HAS_STATE_MANAGER = False
    StateManager = None
    ManagedFile = None
    get_state_manager = None


def get_loki_base_path() -> str:
    """Get the base .loki directory path."""
    return os.path.join(os.getcwd(), '.loki')


# Module-level StateManager instance
_state_manager = None


def _get_state_manager() -> Optional['StateManager']:
    """Get or create the StateManager instance."""
    global _state_manager
    if not HAS_STATE_MANAGER:
        return None
    if _state_manager is None:
        _state_manager = get_state_manager(
            loki_dir=get_loki_base_path(),
            enable_watch=False,
            enable_events=False
        )
    return _state_manager


def ensure_loki_initialized() -> bool:
    """Check if Loki Mode is initialized in current directory."""
    return os.path.exists(get_loki_base_path())


def get_task_queue_path() -> str:
    """Get path to the task queue file."""
    return os.path.join(get_loki_base_path(), 'state', 'task-queue.json')


def get_memory_path() -> str:
    """Get path to the memory directory."""
    return os.path.join(get_loki_base_path(), 'memory')


def load_task_queue() -> Dict[str, Any]:
    """Load the task queue from disk using StateManager."""
    manager = _get_state_manager()
    if manager:
        result = manager.get_state("state/task-queue.json")
        if result:
            return result
    # Fallback to direct file read if StateManager not available
    queue_path = get_task_queue_path()
    if os.path.exists(queue_path):
        with open(queue_path, 'r') as f:
            return json.load(f)
    return {"tasks": [], "version": "1.0"}


def save_task_queue(queue: Dict[str, Any]) -> None:
    """Save the task queue to disk using StateManager."""
    manager = _get_state_manager()
    if manager:
        manager.set_state("state/task-queue.json", queue, source="mcp-tools")
        return
    # Fallback to direct file write if StateManager not available
    queue_path = get_task_queue_path()
    os.makedirs(os.path.dirname(queue_path), exist_ok=True)
    with open(queue_path, 'w') as f:
        json.dump(queue, f, indent=2)


def create_task(
    title: str,
    description: str,
    priority: str = "medium",
    phase: str = "development"
) -> Dict[str, Any]:
    """Create a new task dictionary."""
    queue = load_task_queue()
    task_id = f"task-{len(queue['tasks']) + 1:04d}"

    return {
        "id": task_id,
        "title": title,
        "description": description,
        "priority": priority,
        "phase": phase,
        "status": "pending",
        "created_at": datetime.now(timezone.utc).isoformat()
    }


def filter_tasks_by_status(tasks: List[Dict], status: str) -> List[Dict]:
    """Filter tasks by their status."""
    return [t for t in tasks if t.get("status") == status]


def filter_tasks_by_priority(tasks: List[Dict], priority: str) -> List[Dict]:
    """Filter tasks by their priority."""
    return [t for t in tasks if t.get("priority") == priority]


def filter_tasks_by_phase(tasks: List[Dict], phase: str) -> List[Dict]:
    """Filter tasks by their SDLC phase."""
    return [t for t in tasks if t.get("phase") == phase]


def get_task_summary(queue: Dict[str, Any]) -> Dict[str, Any]:
    """Get a summary of the task queue."""
    tasks = queue.get("tasks", [])

    return {
        "total": len(tasks),
        "by_status": {
            "pending": len(filter_tasks_by_status(tasks, "pending")),
            "in_progress": len(filter_tasks_by_status(tasks, "in_progress")),
            "completed": len(filter_tasks_by_status(tasks, "completed")),
            "blocked": len(filter_tasks_by_status(tasks, "blocked"))
        },
        "by_priority": {
            "critical": len(filter_tasks_by_priority(tasks, "critical")),
            "high": len(filter_tasks_by_priority(tasks, "high")),
            "medium": len(filter_tasks_by_priority(tasks, "medium")),
            "low": len(filter_tasks_by_priority(tasks, "low"))
        },
        "by_phase": {
            "discovery": len(filter_tasks_by_phase(tasks, "discovery")),
            "architecture": len(filter_tasks_by_phase(tasks, "architecture")),
            "development": len(filter_tasks_by_phase(tasks, "development")),
            "testing": len(filter_tasks_by_phase(tasks, "testing")),
            "deployment": len(filter_tasks_by_phase(tasks, "deployment"))
        }
    }


def format_task_for_display(task: Dict[str, Any]) -> str:
    """Format a task for human-readable display."""
    lines = [
        f"Task: {task.get('id', 'unknown')}",
        f"Title: {task.get('title', 'Untitled')}",
        f"Status: {task.get('status', 'unknown')}",
        f"Priority: {task.get('priority', 'medium')}",
        f"Phase: {task.get('phase', 'development')}",
        f"Description: {task.get('description', 'No description')}",
    ]

    if task.get('created_at'):
        lines.append(f"Created: {task['created_at']}")
    if task.get('updated_at'):
        lines.append(f"Updated: {task['updated_at']}")

    return "\n".join(lines)


def validate_task_status(status: str) -> bool:
    """Validate a task status value."""
    valid_statuses = ["pending", "in_progress", "completed", "blocked"]
    return status in valid_statuses


def validate_task_priority(priority: str) -> bool:
    """Validate a task priority value."""
    valid_priorities = ["low", "medium", "high", "critical"]
    return priority in valid_priorities


def validate_task_phase(phase: str) -> bool:
    """Validate a task SDLC phase value."""
    valid_phases = ["discovery", "architecture", "development", "testing", "deployment"]
    return phase in valid_phases
