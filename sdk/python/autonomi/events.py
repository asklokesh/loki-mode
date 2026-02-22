"""Event polling for the Autonomi SDK."""

from __future__ import annotations

from typing import Any, Dict, List, Optional, TYPE_CHECKING

from .types import RunEvent

if TYPE_CHECKING:
    from .client import AutonomiClient


class EventStream:
    """Polls for run events (stdlib-only, no WebSocket)."""

    def __init__(self, client: AutonomiClient) -> None:
        self._client = client

    def poll_events(
        self,
        run_id: str,
        since: Optional[str] = None,
    ) -> List[RunEvent]:
        """Poll for new events on a run since a given timestamp."""
        params: Dict[str, Any] = {}
        if since is not None:
            params["since"] = since
        result = self._client._get(
            f"/api/runs/{run_id}/events", params=params or None
        )
        if not result:
            return []
        items = result if isinstance(result, list) else result.get("events", [])
        return [RunEvent.from_dict(e) for e in items]
