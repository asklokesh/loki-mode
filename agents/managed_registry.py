"""
Loki Managed Agents - Agent materialization registry (Phase 2 foundation).

Lazy registry that maps Loki pool names (as declared in agents/types.json)
to Managed Agent IDs minted via `client.beta.agents.create(...)`. Created
IDs are cached on disk at .loki/managed/agent_ids.json so subsequent
iterations re-use the same agent.

Design:
    - LAZY ONLY: no network calls at import time, no calls on Loki
      startup. The first call to materialize_agent(pool_name) triggers
      the single create-or-fetch round trip for that pool.
    - Uses the shared managed-agents client from providers.managed so
      the anthropic SDK stays imported from the two allowed files only.
    - agents/types.json is the single source of truth for pool names,
      personas, and capabilities. This registry treats the pool entry
      as opaque and forwards the persona as the agent's system prompt.
    - Writes to .loki/managed/agent_ids.json are atomic (write-to-temp
      then rename) so a crash mid-write does not corrupt the cache.

Not wired into autonomy/run.sh directly. Consumers go through
providers.managed.resolve_agent_ids(pool_names).
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

# Single import site for the event emitter -- shared with memory/managed_memory.
from memory.managed_memory.events import emit_managed_event


_CACHE_FILE_REL = ".loki/managed/agent_ids.json"
_TYPES_FILE_REL = "agents/types.json"

_cache_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def _target_dir() -> Path:
    base = os.environ.get("LOKI_TARGET_DIR") or os.getcwd()
    return Path(base)


def _cache_path() -> Path:
    return _target_dir() / _CACHE_FILE_REL


def _types_path() -> Path:
    # types.json lives next to this module in the repo layout. The repo
    # root is the parent of agents/ for the normal install.
    here = Path(__file__).resolve().parent
    local = here / "types.json"
    if local.exists():
        return local
    # Fallback to target_dir for relocated installs.
    return _target_dir() / _TYPES_FILE_REL


# ---------------------------------------------------------------------------
# Cache I/O
# ---------------------------------------------------------------------------


def _load_cache() -> Dict[str, str]:
    """Load pool_name -> agent_id mapping from disk. {} on any error."""
    p = _cache_path()
    if not p.exists():
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and isinstance(v, str)}


def _save_cache(cache: Dict[str, str]) -> None:
    """Atomic write of the cache dict to disk."""
    p = _cache_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    # Use a named temp file in the same directory so os.replace is atomic.
    tmp_fd, tmp_name = tempfile.mkstemp(
        prefix=".agent_ids-", suffix=".json.tmp", dir=str(p.parent)
    )
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2, sort_keys=True)
        os.replace(tmp_name, p)
    except OSError as e:
        # Best-effort cleanup; swallow the error so the caller can
        # proceed -- a stale cache is recoverable, a raise here would
        # break the RARV loop.
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        emit_managed_event(
            "managed_agents_fallback",
            {
                "op": "registry_save_cache",
                "reason": "cache_write_failed",
                "detail": str(e),
            },
        )


# ---------------------------------------------------------------------------
# types.json lookup
# ---------------------------------------------------------------------------


def _load_types() -> List[Dict[str, Any]]:
    try:
        with open(_types_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    return [d for d in data if isinstance(d, dict)]


def _lookup_type(pool_name: str) -> Optional[Dict[str, Any]]:
    for entry in _load_types():
        if entry.get("type") == pool_name or entry.get("name") == pool_name:
            return entry
    return None


def _persona_for(pool_name: str) -> str:
    entry = _lookup_type(pool_name) or {}
    persona = entry.get("persona") or ""
    cap = entry.get("capabilities") or ""
    if persona and cap:
        return f"{persona}\n\nCapabilities: {cap}"
    return persona or f"Loki pool agent: {pool_name}"


def _display_name_for(pool_name: str) -> str:
    entry = _lookup_type(pool_name) or {}
    return entry.get("name") or pool_name


# ---------------------------------------------------------------------------
# Materialization via the anthropic SDK
# ---------------------------------------------------------------------------


def _call_create_agent(pool_name: str) -> str:
    """
    Invoke the anthropic beta agents.create endpoint for `pool_name`.

    Raises RuntimeError on any SDK shape / network / auth error. Callers
    translate to a fallback-capable flow.
    """
    # Deferred import to keep the module SDK-free at import time.
    from providers.managed import _get_client, agent_model  # local import of shared client

    client = _get_client()
    beta = getattr(client, "beta", None)
    if beta is None:
        raise RuntimeError("anthropic SDK missing `beta` namespace")

    agents_ns = getattr(beta, "agents", None)
    if agents_ns is None or not hasattr(agents_ns, "create"):
        raise RuntimeError("anthropic.beta.agents.create not available in SDK")

    persona = _persona_for(pool_name)
    display_name = _display_name_for(pool_name)

    try:
        created = agents_ns.create(
            name=display_name,
            model=agent_model(),
            system=persona,
            metadata={"loki_pool": pool_name},
        )
    except (AttributeError, TypeError) as e:
        raise RuntimeError(f"agents.create shape error: {e}")
    except Exception as e:
        raise RuntimeError(f"agents.create failed for {pool_name!r}: {e}")

    agent_id = (
        getattr(created, "id", None)
        or (created.get("id") if isinstance(created, dict) else None)
        or getattr(created, "agent_id", None)
    )
    if not agent_id:
        raise RuntimeError(
            f"agents.create returned no id for {pool_name!r}: {created!r}"
        )
    return str(agent_id)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def materialize_agent(pool_name: str) -> str:
    """
    Return a Managed Agent ID for the given pool name.

    Cache lookup first. On miss, call `client.beta.agents.create(...)`
    with the persona from agents/types.json and persist the resulting
    ID to .loki/managed/agent_ids.json.

    Raises RuntimeError on failure (no silent fallback; the caller in
    providers.managed.resolve_agent_ids translates into ManagedUnavailable).
    """
    if not pool_name or not isinstance(pool_name, str):
        raise RuntimeError(f"invalid pool_name: {pool_name!r}")

    with _cache_lock:
        cache = _load_cache()
        cached = cache.get(pool_name)
        if cached:
            return cached

        # Create it. Anything that goes wrong raises.
        agent_id = _call_create_agent(pool_name)
        cache[pool_name] = agent_id
        _save_cache(cache)
        emit_managed_event(
            "managed_agent_materialized",
            {"op": "materialize_agent", "pool_name": pool_name, "agent_id": agent_id},
        )
        return agent_id


__all__ = [
    "materialize_agent",
    "_load_cache",
    "_save_cache",
]
