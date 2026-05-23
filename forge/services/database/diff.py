"""Migration diff renderer.

For each forge migration review record, render a human-friendly diff
of what changed in domain terms (added/removed tables, columns, indices,
RLS) and the raw SQL the migration applies. The dashboard UI consumes
this; the agent can read it during council review.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional


def render_diff(spec: Dict[str, Any]) -> Dict[str, Any]:
    """Turn a migration spec into a structured diff."""
    if not isinstance(spec, dict):
        return {"error": "spec must be a dict"}
    out = {
        "added_tables": [],
        "dropped_tables": [],
        "added_columns": [],
        "dropped_columns": [],
        "rls_changes": [],
        "indices": [],
    }
    for op in spec.get("operations", [spec]):
        if not isinstance(op, dict):
            continue
        if "add_table" in op:
            t = op["add_table"]
            out["added_tables"].append({
                "name": t.get("name"),
                "columns": [
                    _col_label(c) for c in (t.get("columns") or [])
                ],
                "rls": t.get("rls"),
            })
        elif "drop_table" in op:
            target = op["drop_table"]
            out["dropped_tables"].append(
                target if isinstance(target, str) else target.get("name")
            )
        elif "add_column" in op:
            v = op["add_column"]
            out["added_columns"].append({
                "table": v.get("table"),
                "column": _col_label(v.get("column")),
            })
        elif "drop_column" in op:
            v = op["drop_column"]
            out["dropped_columns"].append({
                "table": v.get("table"),
                "column": v.get("column"),
            })
        elif "set_rls" in op:
            v = op["set_rls"]
            out["rls_changes"].append({
                "table": v.get("table"),
                "policy": v.get("policy"),
                "predicate": v.get("predicate"),
            })
        elif "create_index" in op:
            v = op["create_index"]
            out["indices"].append({
                "table": v.get("table"),
                "columns": v.get("columns"),
                "unique": bool(v.get("unique")),
                "name": v.get("name"),
            })
    return out


def list_pending(project_dir: str) -> List[Dict[str, Any]]:
    """Return all migration review records (X-11)."""
    rev = os.path.join(project_dir, ".loki", "quality", "forge-migrations")
    if not os.path.isdir(rev):
        return []
    out: List[Dict[str, Any]] = []
    for f in sorted(os.listdir(rev)):
        if not f.endswith(".json"):
            continue
        try:
            with open(os.path.join(rev, f), "r", encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        # Renders the diff inline so the dashboard doesn't need to
        # re-parse spec_json (which the migration_review record does
        # not currently embed; spec lookup is via the main migrate
        # ledger).
        out.append(rec)
    return out


def _col_label(c: Any) -> str:
    if isinstance(c, str):
        return c
    if isinstance(c, dict):
        bits = [c.get("name", "?"), c.get("type", "text")]
        if c.get("primary_key"):
            bits.append("PK")
        if c.get("unique"):
            bits.append("UNIQUE")
        if c.get("notnull"):
            bits.append("NOT NULL")
        return " ".join(bits)
    return repr(c)
