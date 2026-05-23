"""Semantic-layer renderer.

Produces the prompt-injection block that goes into every RARV iteration
prompt when forge has active resources. Capped at ~2 KB so context budget
on long-running sessions stays reasonable; older detail flows into the
existing memory consolidation pipeline.

This is the structural advantage InsForge calls 'the semantic layer'.
We render it locally from .loki/forge/ state so the agent sees ground
truth, not its own iteration-N-1 memory.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional

# Import the introspect *function* directly; importing the submodule and
# then dotting in would shadow it because forge.services.database.__init__
# already re-exports the function name.
from .services.database.introspect import introspect as _db_introspect
from .services.database.engine import open_engine


MAX_BLOCK_BYTES = 2048


def render_prompt_block(forge_dir: str) -> str:
    """Render the semantic-layer block. Empty string when forge has no
    state (no provisioned db, no buckets, no functions, etc.) so the
    prompt is unchanged for projects that don't use forge."""
    if not _has_forge_state(forge_dir):
        return ""

    parts: List[str] = ["## Backend (Loki Forge - auto-provisioned)\n"]

    db_block = _render_db(forge_dir)
    if db_block:
        parts.append(db_block)

    auth_block = _render_auth(forge_dir)
    if auth_block:
        parts.append(auth_block)

    storage_block = _render_storage(forge_dir)
    if storage_block:
        parts.append(storage_block)

    functions_block = _render_functions(forge_dir)
    if functions_block:
        parts.append(functions_block)

    gateway_block = _render_gateway(forge_dir)
    if gateway_block:
        parts.append(gateway_block)

    parts.append(_render_mcp_hint())

    text = "\n".join(parts)
    if len(text.encode("utf-8")) > MAX_BLOCK_BYTES:
        text = _summarize(text)
    return text


def _has_forge_state(forge_dir: str) -> bool:
    if not forge_dir or not os.path.isdir(forge_dir):
        return False
    return any(
        os.path.exists(os.path.join(forge_dir, p))
        for p in ("db.sqlite", "required.json", "auth", "storage",
                  "functions", "schedules", "secrets.vault")
    )


def _render_db(forge_dir: str) -> str:
    db_path = os.path.join(forge_dir, "db.sqlite")
    if not os.path.exists(db_path):
        return ""
    try:
        engine = open_engine(forge_dir)
        snap = _db_introspect(engine)
    except Exception as e:
        return f"Database: (introspect failed: {e})"
    if not snap.get("tables"):
        return "Database: (empty - no tables yet)"
    lines = ["Database (SQLite dev):"]
    for t in snap["tables"]:
        col_summary = ", ".join(
            c["name"] + (" PK" if c["primary_key"] else "")
            for c in t["columns"][:8]
        )
        if len(t["columns"]) > 8:
            col_summary += f", ... ({len(t['columns']) - 8} more)"
        rls = t.get("rls") or {}
        rls_summary = ""
        if rls.get("declared"):
            policy_names = [p["policy_name"] for p in rls.get("policies", [])]
            if policy_names:
                rls_summary = " [RLS: " + ", ".join(policy_names) + "]"
        lines.append(f"  {t['name']}({col_summary}){rls_summary} "
                     f"rows~={t.get('row_count_estimate', 0)}")
    return "\n".join(lines)


def _render_auth(forge_dir: str) -> str:
    auth_dir = os.path.join(forge_dir, "auth", "providers")
    if not os.path.isdir(auth_dir):
        return ""
    try:
        from .services.auth import list_providers, list_users
        providers = list_providers(forge_dir)
        user_count = len(list_users(forge_dir, limit=1000))
    except Exception as e:
        return f"Auth: (introspect failed: {e})"
    if not providers:
        return ""
    names = ", ".join(p.get("_provider", "?") for p in providers)
    return f"Auth providers ({len(providers)}): {names}; users={user_count}"


def _render_storage(forge_dir: str) -> str:
    sroot = os.path.join(forge_dir, "storage")
    if not os.path.isdir(sroot):
        return ""
    try:
        from .services.storage import list_buckets
        buckets = list_buckets(forge_dir)
    except Exception as e:
        return f"Storage: (introspect failed: {e})"
    if not buckets:
        return ""
    lines = [f"Storage buckets ({len(buckets)}):"]
    for b in buckets:
        visibility = "public" if b.get("public") else "private"
        cap_mb = int(b.get("max_file_size", 0) or 0) // (1024 * 1024)
        lines.append(f"  {b['name']} [{visibility}, <={cap_mb}MB/file]")
    return "\n".join(lines)


def _render_functions(forge_dir: str) -> str:
    froot = os.path.join(forge_dir, "functions")
    if not os.path.isdir(froot):
        return ""
    try:
        from .services.functions import list_functions
        funcs = list_functions(forge_dir)
    except Exception as e:
        return f"Functions: (introspect failed: {e})"
    if not funcs:
        return ""
    lines = [f"Edge functions ({len(funcs)}):"]
    for fn in funcs:
        triggers = ",".join(
            t.get("type", "?") for t in (fn.get("triggers") or [])
        )
        lines.append(
            f"  {fn['name']} [{fn.get('runtime')}, v{fn.get('active_version')}, "
            f"triggers={triggers or 'http'}]"
        )
    return "\n".join(lines)


def _render_gateway(forge_dir: str) -> str:
    groot = os.path.join(forge_dir, "gateway")
    if not os.path.isdir(groot):
        return ""
    try:
        from .services.gateway import list_routes
        routes = list_routes(forge_dir)
    except Exception as e:
        return f"Gateway: (introspect failed: {e})"
    if not routes:
        return ""
    models = sorted({r.get("model") for r in routes if r.get("model")})
    return f"Model gateway routes ({len(routes)}): {', '.join(models)}"


def _render_mcp_hint() -> str:
    return (
        "MCP tools available for backend mutations (call directly inside the iteration):\n"
        "  forge_db_query, forge_db_introspect, forge_db_migrate,\n"
        "  forge_db_migrate_dryrun, forge_db_migrate_rollback,\n"
        "  forge_auth_provider_add, forge_auth_user_create, forge_auth_user_list,\n"
        "  forge_storage_bucket_create, forge_storage_signed_url,\n"
        "  forge_storage_transform_preset, forge_storage_list_objects,\n"
        "  forge_state_dump"
    )


def _summarize(text: str) -> str:
    """Tail-truncation with an explicit notice. F-2 swaps in our memory
    consolidation pipeline so older detail is summarized semantically."""
    hard_cap = MAX_BLOCK_BYTES - 64
    head = text.encode("utf-8")[:hard_cap].decode("utf-8", errors="ignore")
    return head + "\n... (truncated to fit context budget)"
