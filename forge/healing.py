"""X-69: healing-mode integration with legacy databases.

Reads a legacy SQLite file (or in the F-2+ Postgres path, the schema
of a connected DB) and proposes forge migrations that replicate the
schema in the forge dev DB. Use this when migrating an existing app
onto Forge without rewriting the data layer first.

Currently SQLite-only. Postgres support arrives with the F-4
Postgres-promotion path.
"""

from __future__ import annotations

import json
import os
import sqlite3
from typing import Any, Dict, List, Optional


_HIDDEN = {"sqlite_sequence", "sqlite_master", "sqlite_stat1",
           "sqlite_stat2", "sqlite_stat3", "sqlite_stat4"}


def write_proposal(project_dir: str, proposal: Dict[str, Any]) -> str:
    """N-56: persist a proposal to .loki/healing/proposal.json so the
    next propose call can diff against the previous run. Returns the
    absolute path written."""
    out_dir = os.path.join(project_dir, ".loki", "healing")
    os.makedirs(out_dir, exist_ok=True)
    p = os.path.join(out_dir, "proposal.json")
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(proposal, f, indent=2, sort_keys=True)
    os.replace(tmp, p)
    return os.path.abspath(p)


def diff_proposal(project_dir: str,
                  current: Dict[str, Any]) -> Dict[str, Any]:
    """N-56: compare `current` to the persisted previous proposal.
    Returns {added_tables, removed_tables, prev_path}. When no prior
    proposal exists, added_tables = all current tables."""
    prev_path = os.path.join(project_dir, ".loki", "healing",
                             "proposal.json")
    prev_tables: set = set()
    prev_table_cols: Dict[str, Dict[str, str]] = {}
    if os.path.isfile(prev_path):
        try:
            with open(prev_path, "r", encoding="utf-8") as f:
                prev = json.load(f)
            for op in prev.get("operations", []):
                if "add_table" in op:
                    t = op["add_table"]
                    prev_tables.add(t["name"])
                    prev_table_cols[t["name"]] = {
                        c["name"]: c.get("type", "")
                        for c in t.get("columns", [])
                    }
        except (OSError, json.JSONDecodeError):
            pass
    curr_tables: set = set()
    curr_table_cols: Dict[str, Dict[str, str]] = {}
    for op in current.get("operations", []):
        if "add_table" in op:
            t = op["add_table"]
            curr_tables.add(t["name"])
            curr_table_cols[t["name"]] = {
                c["name"]: c.get("type", "")
                for c in t.get("columns", [])
            }
    # N-78: per-shared-table column drift detection.
    column_changes: Dict[str, Dict[str, List[str]]] = {}
    for tname in sorted(curr_tables & prev_tables):
        prev_c = prev_table_cols.get(tname, {})
        curr_c = curr_table_cols.get(tname, {})
        added = sorted(set(curr_c) - set(prev_c))
        removed = sorted(set(prev_c) - set(curr_c))
        retyped = sorted([n for n in (set(curr_c) & set(prev_c))
                          if curr_c[n] != prev_c[n]])
        if added or removed or retyped:
            column_changes[tname] = {
                "added": added, "removed": removed, "retyped": retyped,
            }
    return {
        "added_tables": sorted(curr_tables - prev_tables),
        "removed_tables": sorted(prev_tables - curr_tables),
        # N-70: explicit unchanged set so dashboards see steady state.
        "unchanged_tables": sorted(curr_tables & prev_tables),
        "column_changes": column_changes,
        "prev_path": prev_path if os.path.isfile(prev_path) else None,
    }


def propose_from_sqlite(legacy_db_path: str) -> Dict[str, Any]:
    """Read a legacy SQLite database and return a forge migration spec
    that would recreate its schema. Best-effort - emits warnings for
    columns we cannot map cleanly.

    N-05: read PRAGMA foreign_key_list per table, attach a
    `references` clause to FK columns, and topologically sort the
    `add_table` operations so referenced tables are created first.
    Index ops keep their natural order but are emitted after the
    table they index, so the final stream is FK-safe end-to-end.
    """
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
        # N-37: surface how many legacy tables we considered before
        # filtering (hidden + forge-internal) so callers can see the
        # accept/skip ratio.
        out["source_table_count"] = len(tables)
        # First pass: build per-table add_table + index ops keyed by name.
        add_ops: Dict[str, Dict[str, Any]] = {}
        index_ops: Dict[str, List[Dict[str, Any]]] = {}
        # Adjacency for topo sort: table -> set of tables it depends on.
        deps: Dict[str, set] = {}
        for row in tables:
            tname = row["name"]
            if tname in _HIDDEN or tname.startswith("_forge_"):
                continue
            cols = conn.execute(f"PRAGMA table_info('{tname}')").fetchall()
            fks = conn.execute(
                f"PRAGMA foreign_key_list('{tname}')"
            ).fetchall()
            # Map from local column name -> (target_table, target_column).
            fk_by_col: Dict[str, Dict[str, str]] = {}
            for fk in fks:
                fk_by_col[fk["from"]] = {
                    "table": fk["table"], "column": fk["to"] or "id",
                }
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
                if c["name"] in fk_by_col:
                    col["references"] = fk_by_col[c["name"]]
                spec_cols.append(col)
            if not spec_cols:
                out["warnings"].append(
                    f"{tname}: no columns extracted (skipped)"
                )
                continue
            add_ops[tname] = {"add_table": {
                "name": tname, "columns": spec_cols, "rls": "own-row",
            }}
            # Indices.
            indices = conn.execute(
                f"PRAGMA index_list('{tname}')"
            ).fetchall()
            idx_list: List[Dict[str, Any]] = []
            for idx in indices:
                if idx["name"].startswith("sqlite_autoindex"):
                    continue
                idx_cols = [
                    r["name"] for r in
                    conn.execute(f"PRAGMA index_info('{idx['name']}')").fetchall()
                ]
                if idx_cols:
                    idx_list.append({"create_index": {
                        "table": tname, "columns": idx_cols,
                        "name": idx["name"],
                        "unique": bool(idx["unique"]),
                    }})
            index_ops[tname] = idx_list
            # Dependencies: every FK target that is also part of this
            # proposal. N-19: targets outside the proposal's table set
            # (cross-schema or dropped tables) surface as warnings so
            # operators see the dangling reference before apply.
            deps[tname] = {
                fk_by_col[c]["table"] for c in fk_by_col
            }
        # N-19: surface FK targets that are not in the proposal's
        # table set. These usually mean a cross-schema reference (the
        # legacy DB attached another schema) or a table the operator
        # already dropped; in both cases the migration will fail at
        # apply time without this hint.
        known = set(add_ops.keys())
        for tname, dep_set in deps.items():
            for target in sorted(dep_set):
                if target == tname:
                    continue  # self-reference is fine
                if target not in known:
                    out["warnings"].append(
                        f"healing: {tname}.<fk> references unknown "
                        f"table {target!r} (cross-schema or dropped)"
                    )
        # Topological sort: Kahn's algorithm. Preserve alphabetical
        # order among equally-ready tables so the output is stable.
        ordered = _topo_sort(deps, add_ops.keys(), out["warnings"])
        for tname in ordered:
            out["operations"].append(add_ops[tname])
            for idx_op in index_ops.get(tname, []):
                out["operations"].append(idx_op)
        # N-37: surface accepted count (the topo-sorted add_tables).
        out["accepted_table_count"] = len(ordered)
    finally:
        conn.close()
    return out


def _topo_sort(deps: Dict[str, set], tables, warnings: List[str]) -> List[str]:
    """Kahn topo sort: tables with no remaining deps first; ties broken
    alphabetically so the proposal is reproducible. On a cycle (rare
    in legacy SQLite but possible with self-referencing FKs that are
    actually loops between two tables) we surface a warning and fall
    back to the alphabetical order for the unresolved subset."""
    remaining = {t: {d for d in deps.get(t, set()) if d in tables and d != t}
                 for t in tables}
    ordered: List[str] = []
    while remaining:
        ready = sorted(t for t, d in remaining.items() if not d)
        if not ready:
            cycle = sorted(remaining.keys())
            warnings.append(
                f"healing: FK cycle among {cycle}; "
                "applying alphabetical fallback"
            )
            ordered.extend(cycle)
            break
        for t in ready:
            ordered.append(t)
            remaining.pop(t)
        for t in list(remaining):
            remaining[t] -= set(ready)
    return ordered


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


def apply_proposal(forge_dir: str, proposal: Dict[str, Any],
                   *, dry_run: bool = False) -> Dict[str, Any]:
    """Apply the migration spec returned by propose_from_sqlite.

    N-88: returns a v2 envelope with per-op status entries so callers
    can map each input op to its outcome. Top-level `applied` and
    `errors` are preserved for v1-compatible consumers.

    N-99: `dry_run=True` reports `ok=True` for every op without
    invoking migrate_apply; useful for previewing what would land
    before actually writing.
    """
    from forge.services.database import open_engine, migrate_apply
    engine = open_engine(forge_dir)
    applied: List[str] = []
    errors: List[str] = []
    ops_status: List[Dict[str, Any]] = []
    for op in proposal.get("operations", []):
        if "add_table" in op:
            target = op["add_table"].get("name")
            spec = {
                "summary": f"healing: ensure {target}",
                "operations": [op],
            }
        else:
            target = next(iter(op))
            spec = {"operations": [op]}
        if dry_run:
            ops_status.append({
                "op": next(iter(op)),
                "target": target,
                "ok": True,
                "dry_run": True,
            })
            continue
        try:
            res = migrate_apply(engine, spec)
            applied.append(res["migration_id"])
            ops_status.append({
                "op": next(iter(op)),
                "target": target,
                "ok": True,
                "migration_id": res["migration_id"],
            })
        except Exception as e:
            errors.append(str(e))
            ops_status.append({
                "op": next(iter(op)),
                "target": target,
                "ok": False,
                "error": str(e),
            })
    return {
        "schema": "loki.forge.healing.applied/v2",
        "applied": applied,
        "errors": errors,
        "ops": ops_status,
    }
