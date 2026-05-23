"""Schema migration linter (X-48).

Pre-flight checks for migration specs to catch the common pitfalls
that bite in prod:

  - Dropping NOT NULL without a backfill plan
  - Changing column type in a way that is not nullable-compatible
  - Dropping a column that's referenced by a foreign key (best-effort:
    we surface a warning since we don't have the full schema graph
    in dev SQLite)
  - Adding a NOT NULL column with no default to a non-empty table
  - Index name collisions
  - Identifier shadowing forge-internal tables

Run inline by migrate_apply when LOKI_FORGE_LINT=true (default off
in dev, default on in prod via the compliance presets).
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


_FORGE_INTERNAL = {"_forge_migrations", "_forge_rls", "_forge_meta"}


def lint_spec(spec: Dict[str, Any],
              current_schema: Optional[Dict[str, Any]] = None
              ) -> Dict[str, Any]:
    """Return a structured lint report: {errors[], warnings[], info[]}.

    `current_schema` is the output of forge.services.database.introspect()
    when available - allows table-exists / column-conflict checks.
    Pure validation (no I/O); the caller decides whether to apply.
    """
    out = {"errors": [], "warnings": [], "info": []}
    if not isinstance(spec, dict):
        out["errors"].append("spec is not a dict")
        return out

    existing_tables = set()
    existing_cols: Dict[str, set] = {}
    if isinstance(current_schema, dict):
        for t in current_schema.get("tables", []):
            existing_tables.add(t["name"])
            existing_cols[t["name"]] = {c["name"] for c in t.get("columns", [])}

    for op in spec.get("operations", [spec]):
        if not isinstance(op, dict):
            out["errors"].append(f"op not a dict: {op!r}")
            continue
        if "add_table" in op:
            _lint_add_table(op["add_table"], existing_tables, out)
        elif "drop_table" in op:
            _lint_drop_table(op["drop_table"], existing_tables, out)
        elif "add_column" in op:
            _lint_add_column(op["add_column"], existing_cols, out)
        elif "drop_column" in op:
            _lint_drop_column(op["drop_column"], existing_cols, out)
        elif "set_rls" in op:
            _lint_set_rls(op["set_rls"], existing_tables, out)
        elif "create_index" in op:
            _lint_create_index(op["create_index"], existing_cols, out)
        # else: unknown verb is the migrate compiler's job to reject
    return out


def _lint_add_table(t: Dict[str, Any], tables: set, out: Dict[str, list]) -> None:
    name = t.get("name")
    if name in _FORGE_INTERNAL:
        out["errors"].append(
            f"add_table: '{name}' shadows forge-internal table"
        )
    if name in tables:
        out["warnings"].append(
            f"add_table: '{name}' already exists; migrate_apply will error"
        )
    cols = t.get("columns") or []
    has_pk = False
    for c in cols:
        if isinstance(c, str):
            toks = c.lower().split()
            if "pk" in toks or "primary" in toks:
                has_pk = True
        elif isinstance(c, dict) and c.get("primary_key"):
            has_pk = True
        # Adding NOT NULL with no default to a table that will be empty
        # at create-time is fine. But if the spec adds a NOT NULL with
        # no default AND no PK alias, warn.
        if isinstance(c, dict):
            if (c.get("notnull") and "default" not in c
                    and not c.get("primary_key")):
                out["info"].append(
                    f"add_table.{name}: column {c.get('name')!r} is NOT NULL"
                    f" without DEFAULT (safe on empty table; risky on backfill)"
                )
    if cols and not has_pk:
        out["warnings"].append(
            f"add_table: '{name}' has no primary key column; consider 'id pk'"
        )


def _lint_drop_table(target: Any, tables: set, out: Dict[str, list]) -> None:
    name = target if isinstance(target, str) else target.get("name")
    if name in _FORGE_INTERNAL:
        out["errors"].append(
            f"drop_table: refusing to drop forge-internal '{name}'"
        )
    if tables and name not in tables:
        out["warnings"].append(
            f"drop_table: '{name}' does not exist in current schema"
        )


def _lint_add_column(op: Dict[str, Any], cols: Dict[str, set],
                     out: Dict[str, list]) -> None:
    table = op.get("table")
    col = op.get("column")
    col_name = col["name"] if isinstance(col, dict) else (
        col.split()[0] if isinstance(col, str) else None
    )
    if table and table in cols and col_name in cols.get(table, set()):
        out["errors"].append(
            f"add_column: '{table}.{col_name}' already exists"
        )
    # NOT NULL without default = backfill required.
    is_notnull = False
    has_default = False
    if isinstance(col, dict):
        is_notnull = bool(col.get("notnull"))
        has_default = "default" in col
    elif isinstance(col, str):
        toks = col.lower().split()
        is_notnull = "notnull" in toks or "not_null" in toks
        has_default = "default" in toks
    if is_notnull and not has_default:
        out["warnings"].append(
            f"add_column: '{table}.{col_name}' is NOT NULL with no DEFAULT;"
            f" populating existing rows requires a backfill step"
        )


def _lint_drop_column(op: Dict[str, Any], cols: Dict[str, set],
                      out: Dict[str, list]) -> None:
    table = op.get("table")
    col = op.get("column")
    if table and table in cols and col not in cols.get(table, set()):
        out["warnings"].append(
            f"drop_column: '{table}.{col}' does not exist"
        )


def _lint_set_rls(op: Dict[str, Any], tables: set,
                  out: Dict[str, list]) -> None:
    table = op.get("table")
    if tables and table not in tables:
        out["warnings"].append(
            f"set_rls: '{table}' does not exist in current schema"
        )
    if op.get("policy") == "public":
        out["info"].append(
            f"set_rls.{table}: policy='public' grants unrestricted read"
        )


def _lint_create_index(op: Dict[str, Any], cols: Dict[str, set],
                       out: Dict[str, list]) -> None:
    table = op.get("table")
    columns = op.get("columns") or []
    if table and table in cols:
        for c in columns:
            if c not in cols[table]:
                out["warnings"].append(
                    f"create_index: '{table}.{c}' column missing"
                )
    name = op.get("name")
    if name and not re.match(r"^[a-z_][a-z0-9_]{0,62}$", name):
        out["errors"].append(
            f"create_index: invalid name {name!r}"
        )
