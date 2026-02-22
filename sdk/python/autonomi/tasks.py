"""Task management for the Autonomi SDK."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, TYPE_CHECKING

from .types import Task

if TYPE_CHECKING:
    from .client import AutonomiClient


class TaskManager:
    """Manages task operations."""

    def __init__(self, client: AutonomiClient) -> None:
        self._client = client

    def list_tasks(
        self,
        project_id: Optional[str] = None,
        status: Optional[str] = None,
    ) -> List[Task]:
        """List tasks, optionally filtered by project and/or status."""
        params: Dict[str, Any] = {}
        if project_id is not None:
            params["project_id"] = project_id
        if status is not None:
            params["status"] = status
        result = self._client._get("/api/tasks", params=params or None)
        if not result:
            return []
        items = result if isinstance(result, list) else result.get("tasks", [])
        return [Task.from_dict(t) for t in items]

    def get_task(self, task_id: str) -> Task:
        """Get a single task by ID."""
        result = self._client._get(f"/api/tasks/{task_id}")
        return Task.from_dict(result)

    def create_task(
        self,
        project_id: str,
        title: str,
        description: Optional[str] = None,
        priority: str = "medium",
    ) -> Task:
        """Create a new task in a project."""
        payload: Dict[str, Any] = {
            "project_id": project_id,
            "title": title,
            "priority": priority,
        }
        if description is not None:
            payload["description"] = description
        result = self._client._post("/api/tasks", data=payload)
        return Task.from_dict(result)

    def update_task(
        self,
        task_id: str,
        status: Optional[str] = None,
        priority: Optional[str] = None,
    ) -> Task:
        """Update a task's status and/or priority."""
        payload: Dict[str, Any] = {}
        if status is not None:
            payload["status"] = status
        if priority is not None:
            payload["priority"] = priority
        result = self._client._put(f"/api/tasks/{task_id}", data=payload)
        return Task.from_dict(result)
