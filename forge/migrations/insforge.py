"""Import from an InsForge export.

InsForge can dump its state via `insforge metadata --json`; we accept
that JSON shape and materialize the equivalent forge state.

Expected JSON shape (best-effort - we tolerate missing keys):
    {
      "tables":    [{"name": "...", "columns": [{"name", "type", ...}]}],
      "buckets":   [{"name": "...", "public": true|false}],
      "functions": [{"name": "...", "runtime": "deno|bun|python"}],
      "schedules": [{"name": "...", "cron": "...", "target": {...}}],
      "secrets":   ["NAME1", "NAME2"]
    }
"""

from __future__ import annotations

import json
import os
import time
from typing import Any, Dict, List


# Type alias map for InsForge -> forge (mostly identical to Supabase).
_TYPE_MAP = {
    "uuid": "uuid",
    "text": "text",
    "string": "text",
    "varchar": "text",
    "integer": "integer",
    "int": "integer",
    "bigint": "integer",
    "boolean": "boolean",
    "bool": "boolean",
    "json": "json",
    "jsonb": "json",
    "timestamp": "timestamp",
    "timestamptz": "timestamp",
    "real": "real",
    "float": "real",
    "double": "real",
}


def import_from_insforge(forge_dir: str, export_path: str) -> Dict[str, Any]:
    if not os.path.isfile(export_path):
        return {"ok": False, "error": "export not found", "path": export_path}
    try:
        with open(export_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        return {"ok": False, "error": f"export unreadable: {e}"}

    from forge.services.database import open_engine, migrate_apply
    from forge.services.storage import create_bucket
    from forge.services.schedules import create as schedule_create

    engine = open_engine(forge_dir)
    applied_tables: List[Dict[str, Any]] = []
    skipped: List[str] = []
    errors: List[str] = []

    for t in data.get("tables", []):
        name = t.get("name")
        if not name:
            skipped.append("table with no name")
            continue
        cols = []
        for c in t.get("columns", []) or []:
            cn = c.get("name")
            ct = (c.get("type") or "text").lower().split("(")[0]
            forge_type = _TYPE_MAP.get(ct, "text")
            col: Dict[str, Any] = {"name": cn, "type": forge_type}
            if c.get("primary_key") or c.get("is_primary"):
                col["primary_key"] = True
                if forge_type == "integer":
                    col["type"] = "id"
            if c.get("unique"):
                col["unique"] = True
            if c.get("not_null") or c.get("notnull"):
                col["notnull"] = True
            if "default" in c:
                col["default"] = c["default"]
            cols.append(col)
        if not cols:
            skipped.append(f"{name}: no columns parsed")
            continue
        try:
            res = migrate_apply(engine, {
                "summary": f"insforge import: {name}",
                "operations": [{"add_table": {
                    "name": name, "columns": cols, "rls": "own-row"}}],
            })
            applied_tables.append({"name": name,
                                   "migration_id": res["migration_id"]})
        except Exception as e:
            errors.append(f"table {name}: {e}")

    applied_buckets: List[str] = []
    for b in data.get("buckets", []):
        bname = b.get("name")
        if not bname:
            continue
        try:
            create_bucket(forge_dir, bname,
                          public=bool(b.get("public")))
            applied_buckets.append(bname)
        except Exception as e:
            errors.append(f"bucket {bname}: {e}")

    applied_schedules: List[str] = []
    for s in data.get("schedules", []):
        sname = s.get("name")
        cron = s.get("cron")
        target = s.get("target") or {}
        if not sname or not cron or not target:
            skipped.append(f"schedule {sname}: missing fields")
            continue
        try:
            schedule_create(forge_dir, sname, cron, target,
                            payload=s.get("payload"))
            applied_schedules.append(sname)
        except Exception as e:
            errors.append(f"schedule {sname}: {e}")

    deferred_secrets = [s for s in data.get("secrets", [])]

    report = {
        "schema": "loki.forge.migration.import/v1",
        "source": "insforge",
        "started_at": int(time.time()),
        "applied_tables": applied_tables,
        "applied_buckets": applied_buckets,
        "applied_schedules": applied_schedules,
        "deferred_secrets": deferred_secrets,
        "skipped": skipped,
        "errors": errors,
        "notes": [
            "secrets are imported as names only - values must be set "
            "via forge_secret_set after the import",
            "functions are NOT auto-imported - the agent re-deploys "
            "function source via forge_function_deploy",
        ],
    }
    out_path = os.path.join(forge_dir, "migrations",
                            f"insforge-{int(time.time())}.json")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True)
    report["report_path"] = out_path
    return report
