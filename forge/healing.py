"""X-69: healing-mode integration with legacy databases.

Reads a legacy SQLite file (or in the F-2+ Postgres path, the schema
of a connected DB) and proposes forge migrations that replicate the
schema in the forge dev DB. Use this when migrating an existing app
onto Forge without rewriting the data layer first.

Currently SQLite-only. Postgres support arrives with the F-4
Postgres-promotion path.
"""

from __future__ import annotations

import sqlite3
from typing import Any, Dict, List, Optional


_HIDDEN = {"sqlite_sequence", "sqlite_master", "sqlite_stat1",
           "sqlite_stat2", "sqlite_stat3", "sqlite_stat4"}


def propose_from_sqlite(legacy_db_path: str) -> Dict[str, Any]:
    """Read a legacy SQLite database and return a forge migration spec
    that would recreate its schema. Best-effort - emits warnings for
    columns we cannot map cleanly."""
    conn = sqlite3.connect(legacy_db_path)
    conn.row_factory = sqlite3.Row
    out: Dict[str, Any] = {
        "schema": "loki.forge.healing.proposal/v1",
        "source": legacy_db_path,
        "operations": [],
        "warnings": [],
    }
    try:
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        ).fetchall()
        for row in tables:
            tname = row["name"]
            if tname in _HIDDEN or tname.startswith("_forge_"):
                continue
            cols = conn.execute(f"PRAGMA table_info('{tname}')").fetchall()
            spec_cols: List[Dict[str, Any]] = []
            for c in cols:
                col: Dict[str, Any] = {
                    "name": c["name"],
                    "type": _map_type(c["type"]),
                }
                if c["pk"]:
                    col["primary_key"] = True
                    if col["type"] == "integer":
                        col["type"] = "id"
                if c["notnull"]:
                    col["notnull"] = True
                if c["dflt_value"] is not None:
                    val = c["dflt_value"]
                    if isinstance(val, str) and val.startswith("'") and val.endswith("'"):
                        col["default"] = val[1:-1]
                    else:
                        col["default"] = val
                spec_cols.append(col)
            if not spec_cols:
                out["warnings"].append(
                    f"{tname}: no columns extracted (skipped)"
                )
                continue
            out["operations"].append({"add_table": {
                "name": tname, "columns": spec_cols, "rls": "own-row",
            }})
            # Indices.
            indices = conn.execute(
                f"PRAGMA index_list('{tname}')"
            ).fetchall()
            for idx in indices:
                if idx["name"].startswith("sqlite_autoindex"):
                    continue
                idx_cols = [
                    r["name"] for r in
                    conn.execute(f"PRAGMA index_info('{idx['name']}')").fetchall()
                ]
                if idx_cols:
                    out["operations"].append({"create_index": {
                        "table": tname, "columns": idx_cols,
                        "name": idx["name"],
                        "unique": bool(idx["unique"]),
                    }})
    finally:
        conn.close()
    return out


def _map_type(legacy_type: Optional[str]) -> str:
    if not legacy_type:
        return "text"
    t = legacy_type.lower().split("(")[0].strip()
    if t in ("int", "integer", "bigint", "smallint", "int2", "int4", "int8"):
        return "integer"
    if t in ("real", "float", "double", "numeric", "decimal"):
        return "real"
    if t in ("bool", "boolean"):
        return "boolean"
    if t in ("blob", "bytea"):
        return "blob"
    if t in ("uuid",):
        return "uuid"
    if t in ("timestamp", "timestamptz", "datetime", "date"):
        return "timestamp"
    if t in ("json", "jsonb"):
        return "json"
    return "text"


def apply_proposal(forge_dir: str, proposal: Dict[str, Any]) -> Dict[str, Any]:
    """Apply the migration spec returned by propose_from_sqlite."""
    from forge.services.database import open_engine, migrate_apply
    engine = open_engine(forge_dir)
    applied: List[str] = []
    errors: List[str] = []
    for op in proposal.get("operations", []):
        if "add_table" in op:
            spec = {
                "summary": f"healing: ensure {op['add_table'].get('name')}",
                "operations": [op],
            }
        else:
            spec = {"operations": [op]}
        try:
            res = migrate_apply(engine, spec)
            applied.append(res["migration_id"])
        except Exception as e:
            errors.append(str(e))
    return {
        "schema": "loki.forge.healing.applied/v1",
        "applied": applied,
        "errors": errors,
    }
