"""MCP tools for Managed Agents Memory (PII redaction, read proxies).

This module hosts the actual implementation of the loki_memory_redact tool.
The logic lives here -- rather than inline in mcp/server.py -- so unit tests
can import and exercise ``redact_memory_versions`` directly without having
to load the full MCP FastMCP runtime.

Registration pattern:
    from mcp.managed_tools import register_managed_tools
    register_managed_tools(mcp_server)   # Called from mcp/server.py
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple


_VALID_SCOPES = ("user", "org", "all")


def _store_scope(store: Any) -> str:
    if isinstance(store, dict):
        return (store.get("scope") or "").lower()
    return (getattr(store, "scope", "") or "").lower()


def _store_id(store: Any) -> Optional[str]:
    if isinstance(store, dict):
        return store.get("id") or store.get("store_id")
    return getattr(store, "id", None) or getattr(store, "store_id", None)


def _version_to_dict(version: Any) -> Dict[str, Any]:
    if isinstance(version, dict):
        return version
    to_dict = getattr(version, "model_dump", None) or getattr(version, "dict", None)
    if callable(to_dict):
        try:
            return to_dict()
        except Exception:
            return {"raw": str(version)}
    return {"raw": str(version)}


def _resolve_sdk(client: Any) -> Tuple[Any, Any, Any]:
    """
    Return (stores_list_fn, versions_list_fn, redact_fn) or raise RuntimeError.
    """
    beta = getattr(client._client, "beta", None)  # type: ignore[attr-defined]
    memory_stores = getattr(beta, "memory_stores", None) if beta is not None else None
    stores_list_fn = (
        getattr(memory_stores, "list", None) if memory_stores is not None else None
    )
    memory_versions = (
        getattr(memory_stores, "memory_versions", None)
        if memory_stores is not None else None
    )
    versions_list_fn = (
        getattr(memory_versions, "list", None) if memory_versions is not None else None
    )
    redact_fn = (
        getattr(memory_versions, "redact", None) if memory_versions is not None else None
    )
    if versions_list_fn is None or redact_fn is None:
        raise RuntimeError(
            "memory_versions.list / memory_versions.redact not available in SDK"
        )
    return stores_list_fn, versions_list_fn, redact_fn


def redact_memory_versions(
    pattern: str,
    scope: str = "all",
) -> Dict[str, Any]:
    """
    Redact memory versions whose content matches ``pattern`` (regex).

    Hard requirements:
        - LOKI_MANAGED_AGENTS=true AND LOKI_MANAGED_MEMORY=true
          (otherwise raises ManagedDisabled).

    Soft failures (returned as structured dicts, never raise):
        - invalid regex        -> {"error": "...", "redacted_count": 0}
        - invalid scope        -> {"error": "...", "redacted_count": 0}
        - per-store / per-redact SDK errors -> collected in "errors"

    Returns:
        {"redacted_count": int, "scanned": int, "errors": [...]}.
    """
    if scope not in _VALID_SCOPES:
        return {
            "error": f"invalid scope '{scope}'; expected one of "
                     + "|".join(_VALID_SCOPES),
            "redacted_count": 0,
            "errors": [],
            "scanned": 0,
        }

    # v7.0.2: bound pattern length to mitigate ReDoS. Catastrophic-backtracking
    # patterns like (a+)+$ can hang the MCP server. 512 chars is generous for
    # legitimate compliance/PII patterns.
    if not isinstance(pattern, str) or len(pattern) > 512:
        return {
            "error": "pattern must be a string of <=512 characters (ReDoS guard)",
            "redacted_count": 0,
            "errors": [],
            "scanned": 0,
        }

    try:
        compiled = re.compile(pattern)
    except re.error as e:
        return {
            "error": f"invalid regex: {e}",
            "redacted_count": 0,
            "errors": [],
            "scanned": 0,
        }

    # Hard flag check: raise so MCP callers see the ManagedDisabled exception
    # path rather than a silent no-op.
    from memory.managed_memory import ManagedDisabled, is_enabled
    from memory.managed_memory.client import get_client
    from memory.managed_memory.events import emit_managed_event

    if not is_enabled():
        raise ManagedDisabled(
            "loki_memory_redact requires LOKI_MANAGED_AGENTS=true and "
            "LOKI_MANAGED_MEMORY=true"
        )

    client = get_client()

    try:
        stores_list_fn, versions_list_fn, redact_fn = _resolve_sdk(client)
    except RuntimeError as exc:
        return {
            "error": str(exc),
            "redacted_count": 0,
            "errors": [],
            "scanned": 0,
        }

    errors: List[Dict[str, Any]] = []
    redacted_count = 0
    scanned = 0

    try:
        stores_result = stores_list_fn() if stores_list_fn is not None else []
        stores_data = getattr(stores_result, "data", stores_result) or []
    except Exception as e:
        errors.append({"op": "stores_list", "error": str(e)})
        stores_data = []

    for store in stores_data:
        if scope != "all" and _store_scope(store) != scope:
            continue
        sid = _store_id(store)
        if not sid:
            continue
        try:
            versions_result = versions_list_fn(store_id=sid)
            versions_data = getattr(versions_result, "data", versions_result) or []
        except Exception as e:
            errors.append({"op": "versions_list", "store_id": sid, "error": str(e)})
            continue

        for version in versions_data:
            scanned += 1
            vdict = _version_to_dict(version)
            content = vdict.get("content") or vdict.get("text") or ""
            if not isinstance(content, str):
                try:
                    content = json.dumps(content, default=str)
                except Exception:
                    content = str(content)
            if not compiled.search(content):
                continue
            vid = (
                vdict.get("id")
                or vdict.get("memory_version_id")
                or vdict.get("version_id")
            )
            if not vid:
                errors.append(
                    {"op": "redact", "store_id": sid, "error": "no version id"}
                )
                continue
            try:
                redact_fn(store_id=sid, memory_version_id=vid)
                redacted_count += 1
                try:
                    emit_managed_event(
                        "managed_memory_redact",
                        {
                            "store_id": sid,
                            "memory_version_id": vid,
                            "scope": scope,
                            "pattern": pattern,
                        },
                    )
                except Exception:
                    pass
            except Exception as e:
                errors.append(
                    {
                        "op": "redact",
                        "store_id": sid,
                        "memory_version_id": vid,
                        "error": str(e),
                    }
                )

    return {
        "redacted_count": redacted_count,
        "scanned": scanned,
        "errors": errors,
    }


def register_managed_tools(mcp) -> None:
    """Attach managed-memory MCP tools to a FastMCP instance."""

    @mcp.tool()
    async def loki_memory_redact(pattern: str, scope: str = "all") -> str:
        """
        Redact memory versions in the managed-agents store whose content matches a regex.
        Use it to redact sensitive content, for example a leaked secret, from
        managed memory versions that match a regex. Do not use it to read or
        search memory (use mem_search or loki_memory_retrieve); it needs managed
        memory enabled.

        Iterates memory versions within the requested scope and calls
        ``client.beta.memory_stores.memory_versions.redact(...)`` for each
        match. Requires ``LOKI_MANAGED_AGENTS=true`` and
        ``LOKI_MANAGED_MEMORY=true`` -- otherwise raises ``ManagedDisabled``.

        Args:
            pattern: Python regex compiled with ``re.search`` against each
                version's content.
            scope: One of ``user``, ``org``, or ``all`` (default).

        Returns:
            JSON ``{"redacted_count": int, "errors": [...], "scanned": int}``.
        """
        result = redact_memory_versions(pattern=pattern, scope=scope)
        return json.dumps(result)
