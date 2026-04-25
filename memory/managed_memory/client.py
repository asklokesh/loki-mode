"""
Loki Managed Agents Memory - Client wrapper (v6.83.0 Phase 1).

Thin wrapper around the `anthropic` SDK. This is the ONLY file in the codebase
that imports `anthropic`. A CI invariant test enforces that.

The wrapper:
    - Sets anthropic-beta: managed-agents-2026-04-01 on every request.
    - Reads ANTHROPIC_API_KEY from env. Absence raises ManagedDisabled.
    - Wraps every SDK call in a 10s hard timeout. Timeouts are treated as
      recoverable: the caller decides whether to fall back.
    - Never retries inside the client (no retry-storm). Callers implement
      bounded retry (e.g. 409 precondition merge-and-retry-once).

NOTE on API surface: the exact Managed Agents memory endpoints are under a
beta channel. This wrapper implements a minimal, forward-compatible subset --
stores_list, stores_get_or_create, memory_create, memory_read, memories_list.
If the SDK version installed does not expose `beta.memory`, calls raise an
AttributeError which the callers translate into a ManagedDisabled/fallback.

Not tested end-to-end against a live ANTHROPIC_API_KEY in CI. Automated tests
use memory/managed_memory/fakes.py.
"""

from __future__ import annotations

import hashlib
import os
import threading
from typing import Any, Dict, List, Optional

from . import ManagedDisabled
from ._beta import BETA_HEADER

_DEFAULT_TIMEOUT = 10.0  # seconds


def _check_flags_or_raise() -> None:
    parent = os.environ.get("LOKI_MANAGED_AGENTS", "").strip().lower() == "true"
    child = os.environ.get("LOKI_MANAGED_MEMORY", "").strip().lower() == "true"
    if not (parent and child):
        raise ManagedDisabled(
            "managed memory flags are off "
            "(LOKI_MANAGED_AGENTS and LOKI_MANAGED_MEMORY must both be 'true')"
        )


def _require_api_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise ManagedDisabled("ANTHROPIC_API_KEY is not set")
    return key


def compute_sha256(content: str) -> str:
    """Stable content hash used as an optimistic precondition on writes."""
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


class ManagedClient:
    """
    Thin SDK wrapper. Instantiating this class imports anthropic and validates
    credentials; callers should construct it lazily inside flag-gated paths.
    """

    def __init__(self, timeout: float = _DEFAULT_TIMEOUT) -> None:
        _check_flags_or_raise()
        api_key = _require_api_key()
        # Import lazily so the top-level package stays SDK-free.
        try:
            import anthropic  # noqa: F401  (imported for side-effects + symbol)
        except ImportError as e:  # pragma: no cover - import surface
            raise ManagedDisabled(f"anthropic SDK not installed: {e}")

        self._anthropic = anthropic
        self._client = anthropic.Anthropic(
            api_key=api_key,
            timeout=timeout,
            default_headers={"anthropic-beta": BETA_HEADER},
        )
        self._timeout = timeout

    # ---------- helpers -------------------------------------------------

    def _beta(self):
        """Return the beta namespace, if the SDK exposes it.

        Newer SDK versions expose `client.beta.memory.*`. If the attribute
        path is missing we raise ManagedDisabled so callers can fall back.
        """
        beta = getattr(self._client, "beta", None)
        if beta is None:
            raise ManagedDisabled("anthropic SDK missing `beta` namespace")
        return beta

    # ---------- stores --------------------------------------------------

    def stores_list(self) -> List[Dict[str, Any]]:
        """List managed memory stores on this account (may be empty)."""
        beta = self._beta()
        stores = getattr(beta, "memory_stores", None) or getattr(beta, "stores", None)
        if stores is None or not hasattr(stores, "list"):
            raise ManagedDisabled("memory_stores API not available in SDK")
        try:
            result = stores.list()
        except ManagedDisabled:
            raise
        except Exception as e:
            raise ManagedDisabled(f"stores_list failed: {e!s}") from e
        # SDK returns a pydantic model; normalize to list of dicts.
        data = getattr(result, "data", result)
        return [self._to_dict(x) for x in (data or [])]

    def stores_get_or_create(
        self, name: str, description: str = "", scope: str = "project"
    ) -> Dict[str, Any]:
        """Return existing store with `name` or create it."""
        existing = [s for s in self.stores_list() if s.get("name") == name]
        if existing:
            return existing[0]
        beta = self._beta()
        stores = getattr(beta, "memory_stores", None) or getattr(beta, "stores", None)
        if stores is None or not hasattr(stores, "create"):
            raise ManagedDisabled("memory_stores.create not available in SDK")
        try:
            created = stores.create(name=name, description=description, scope=scope)
        except ManagedDisabled:
            raise
        except Exception as e:
            raise ManagedDisabled(f"stores_get_or_create failed: {e!s}") from e
        return self._to_dict(created)

    # ---------- memories ------------------------------------------------

    def memory_create(
        self,
        store_id: str,
        path: str,
        content: str,
        sha256_precondition: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Create a memory entry at `path` in `store_id`.

        When sha256_precondition is supplied, this is an optimistic
        concurrency hint: if the store already holds a different hash the
        SDK is expected to surface a 409-shaped error. Callers handle the
        409 by re-reading, merging, and retrying once.
        """
        beta = self._beta()
        memories = getattr(beta, "memories", None)
        if memories is None or not hasattr(memories, "create"):
            raise ManagedDisabled("memories.create not available in SDK")
        kwargs: Dict[str, Any] = {
            "store_id": store_id,
            "path": path,
            "content": content,
        }
        if sha256_precondition:
            kwargs["if_match_sha256"] = sha256_precondition
        try:
            created = memories.create(**kwargs)
        except ManagedDisabled:
            raise
        except Exception as e:
            raise ManagedDisabled(f"memory_create failed: {e!s}") from e
        return self._to_dict(created)

    def memory_read(self, store_id: str, memory_id: str) -> Dict[str, Any]:
        beta = self._beta()
        memories = getattr(beta, "memories", None)
        if memories is None or not hasattr(memories, "retrieve"):
            raise ManagedDisabled("memories.retrieve not available in SDK")
        try:
            got = memories.retrieve(store_id=store_id, memory_id=memory_id)
        except ManagedDisabled:
            raise
        except Exception as e:
            raise ManagedDisabled(f"memory_read failed: {e!s}") from e
        return self._to_dict(got)

    def memories_list(
        self, store_id: str, path_prefix: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        beta = self._beta()
        memories = getattr(beta, "memories", None)
        if memories is None or not hasattr(memories, "list"):
            raise ManagedDisabled("memories.list not available in SDK")
        kwargs: Dict[str, Any] = {"store_id": store_id}
        if path_prefix:
            kwargs["path_prefix"] = path_prefix
        try:
            result = memories.list(**kwargs)
        except ManagedDisabled:
            raise
        except Exception as e:
            raise ManagedDisabled(f"memories_list failed: {e!s}") from e
        data = getattr(result, "data", result)
        return [self._to_dict(x) for x in (data or [])]

    # ---------- internal ------------------------------------------------

    @staticmethod
    def _to_dict(obj: Any) -> Dict[str, Any]:
        """Best-effort pydantic-or-dict to dict conversion."""
        if isinstance(obj, dict):
            return obj
        to_dict = getattr(obj, "model_dump", None) or getattr(obj, "dict", None)
        if callable(to_dict):
            try:
                return to_dict()
            except TypeError:
                return to_dict()
        return {"raw": str(obj)}


# Optional helper for callers that want a thread-safe singleton.
_singleton: Optional[ManagedClient] = None
_singleton_lock = threading.Lock()


def get_client() -> ManagedClient:
    """Return a lazily-constructed singleton. Raises ManagedDisabled if off."""
    global _singleton
    with _singleton_lock:
        if _singleton is None:
            _singleton = ManagedClient()
        return _singleton


def reset_client() -> None:
    """Test hook: drop the cached singleton so tests can swap implementations."""
    global _singleton
    with _singleton_lock:
        _singleton = None
