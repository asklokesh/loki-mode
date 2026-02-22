"""Session management for the Autonomi SDK."""

from __future__ import annotations

from typing import Any, Dict, List, TYPE_CHECKING

if TYPE_CHECKING:
    from .client import AutonomiClient


class SessionManager:
    """Manages session lifecycle for a project."""

    def __init__(self, client: AutonomiClient) -> None:
        self._client = client

    def list_sessions(self, project_id: str) -> List[Dict[str, Any]]:
        """List all sessions for a project."""
        result = self._client._get(f"/api/projects/{project_id}/sessions")
        if not result:
            return []
        if isinstance(result, list):
            return result
        return result.get("sessions", [])

    def get_session(self, session_id: str) -> Dict[str, Any]:
        """Get a single session by ID."""
        result = self._client._get(f"/api/sessions/{session_id}")
        return result or {}
