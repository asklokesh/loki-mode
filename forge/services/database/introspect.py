"""Schema introspection - the structured semantic-layer output InsForge
calls 'the headline win'. We expose tables, columns, indices, foreign keys,
and (when present) RLS policy hints so the agent sees ground truth instead
of guessing what it built last iteration."""

from __future__ import annotations

from typing import Any, Dict, List

from .engine import Engine


_INTROSPECT_SCHEMA = "loki.forge.db.introspect/v1"

# SQLite system tables we never want to surface to the agent.
_HIDDEN = {"sqlite_sequence", "sqlite_master", "sqlite_temp_master",
           "sqlite_stat1", "sqlite_stat2", "sqlite_stat3", "sqlite_stat4"}

# Tables forge owns itself for migration tracking, etc. Surfaced separately
# so agents don't try to read/write them as if they were app tables.
_FORGE_INTERNAL = {"_forge_migrations", "_forge_rls", "_forge_meta"}


def introspect(engine: Engine) -> Dict[str, Any]:
    """Return a structured snapshot of the database schema."""
    tables = []
    rows = engine.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    )
    for r in rows:
        tname = r["name"]
        if tname in _HIDDEN:
            continue
        if tname in _FORGE_INTERNAL:
            continue
        tables.append({
            "name": tname,
            "columns": _columns(engine, tname),
            "indices": _indices(engine, tname),
            "foreign_keys": _foreign_keys(engine, tname),
            "rls": _rls_for(engine, tname),
            "row_count_estimate": _row_count(engine, tname),
        })
    return {
        "schema": _INTROSPECT_SCHEMA,
        "tables": tables,
        "internal": {
            "migrations": _migration_history(engine),
        },
    }


def _columns(engine: Engine, table: str) -> List[Dict[str, Any]]:
    # PRAGMA table_info reports: cid, name, type, notnull, dflt_value, pk
    rows = engine.execute(f"PRAGMA table_info({_qident(table)})")
    return [
        {
            "name": r["name"],
            "type": r["type"],
            "notnull": bool(r["notnull"]),
            "default": r["dflt_value"],
            "primary_key": bool(r["pk"]),
        }
        for r in rows
    ]


def _indices(engine: Engine, table: str) -> List[Dict[str, Any]]:
    rows = engine.execute(f"PRAGMA index_list({_qident(table)})")
    out = []
    for r in rows:
        idx_name = r["name"]
        cols = engine.execute(f"PRAGMA index_info({_qident(idx_name)})")
        out.append({
            "name": idx_name,
            "unique": bool(r["unique"]),
            "columns": [c["name"] for c in cols],
        })
    return out


def _foreign_keys(engine: Engine, table: str) -> List[Dict[str, Any]]:
    rows = engine.execute(f"PRAGMA foreign_key_list({_qident(table)})")
    return [
        {
            "column": r["from"],
            "references_table": r["table"],
            "references_column": r["to"],
            "on_delete": r["on_delete"],
            "on_update": r["on_update"],
        }
        for r in rows
    ]


def _row_count(engine: Engine, table: str) -> int:
    # Exact count on dev SQLite; F-2 swaps in pg_class.reltuples for prod.
    try:
        rows = engine.execute(f"SELECT COUNT(*) AS n FROM {_qident(table)}")
        return int(rows[0]["n"]) if rows else 0
    except Exception:
        return -1


def _rls_for(engine: Engine, table: str) -> Dict[str, Any]:
    """Return RLS metadata for a table from our _forge_rls registry. SQLite
    doesn't enforce RLS natively - we surface the policy so the agent can
    generate matching server-side checks in user code and the migration
    layer can target the same identity model when promoted to Postgres."""
    try:
        rows = engine.execute(
            "SELECT policy_name, predicate FROM _forge_rls "
            "WHERE table_name = ? ORDER BY policy_name",
            (table,),
        )
    except Exception:
        return {"declared": False, "policies": []}
    return {"declared": True, "policies": rows}


def _migration_history(engine: Engine) -> List[Dict[str, Any]]:
    try:
        rows = engine.execute(
            "SELECT id, applied_at, spec_hash, summary FROM _forge_migrations "
            "ORDER BY applied_at DESC LIMIT 50"
        )
    except Exception:
        return []
    return list(rows)


def _qident(name: str) -> str:
    """Quote an identifier for safe interpolation. Refuses anything that
    is not a plausible SQLite identifier so a malicious table name cannot
    inject."""
    if not name or not all(c.isalnum() or c == "_" for c in name):
        raise ValueError(f"unsafe identifier: {name!r}")
    return '"' + name + '"'
