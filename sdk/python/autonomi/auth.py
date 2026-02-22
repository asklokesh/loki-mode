"""Authentication helpers for the Autonomi SDK."""

from __future__ import annotations

from typing import Dict


class TokenAuth:
    """Bearer token authentication."""

    def __init__(self, token: str) -> None:
        if not token:
            raise ValueError("Token must not be empty")
        self._token = token

    def __repr__(self) -> str:
        return "TokenAuth(token='loki_****')"

    def headers(self) -> Dict[str, str]:
        """Return authorization headers."""
        return {"Authorization": f"Bearer {self._token}"}
