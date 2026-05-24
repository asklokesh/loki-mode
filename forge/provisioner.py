"""Forge provisioner facade.

The provisioner is the bridge between spec detection and primitive
materialization. It reads a ForgeRequirements record and applies the
necessary side-effects (db migrations, bucket creates, schedule registers).

In F-1 it only materializes database tables. F-2 wires in auth providers,
buckets, functions, and the model gateway.

The provisioner is intentionally idempotent: applying the same
requirements record twice produces the same end state. This lets us run
it on every RARV iteration without thrashing.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .spec_detector import ForgeRequirements, TableSpec
from .services.database import open_engine, migrate_apply, migrate_dryrun


@dataclass
class ProvisionResult:
    forge_dir: str
    db_migrations: List[Dict[str, Any]]
    skipped: List[str]
    errors: List[str]

    def to_json(self) -> str:
        return json.dumps({
            "schema": "loki.forge.provision/v1",
            "forge_dir": self.forge_dir,
            "db_migrations": self.db_migrations,
            "skipped": self.skipped,
            "errors": self.errors,
        }, indent=2, sort_keys=True)


def provision(req: ForgeRequirements, forge_dir: str,
              dryrun: bool = False) -> ProvisionResult:
    """Apply a ForgeRequirements record. Returns a structured result."""
    os.makedirs(forge_dir, exist_ok=True)
    db_results: List[Dict[str, Any]] = []
    skipped: List[str] = []
    errors: List[str] = []

    if req.none:
        return ProvisionResult(forge_dir=forge_dir,
                               db_migrations=[],
                               skipped=["none-required"],
                               errors=[])

    # F-1: database tables.
    if req.tables:
        try:
            engine = open_engine(forge_dir)
            for t in req.tables:
                spec = _table_spec_to_migration(t)
                if dryrun:
                    sql = migrate_dryrun(engine, spec)
                    db_results.append({"table": t.name, "dryrun_sql": sql})
                else:
                    res = migrate_apply(engine, spec)
                    db_results.append({"table": t.name, **res})
        except Exception as e:
            errors.append(f"db provisioning failed: {e}")

    # F-2: auth providers - register each one with default config (the
    # agent supplies client_id later via forge_auth_provider_add).
    if req.auth_providers:
        try:
            from .services.auth import add_provider
            for p in req.auth_providers:
                try:
                    add_provider(forge_dir, p, {"_provisioned_by": "detector"})
                except ValueError as e:
                    # Already registered or unsupported - record but continue.
                    skipped.append(f"auth_provider:{p}: {e}")
        except Exception as e:
            errors.append(f"auth provisioning failed: {e}")

        # F-2.05: auto-provision a users table the user-app can JOIN
        # against. Skipped when the agent already declared its own.
        if not dryrun:
            try:
                declared = any(t.name == "users"
                               for t in (req.tables or []))
                if not declared:
                    # Module-level imports already bring open_engine +
                    # migrate_apply into scope; introspect needs a lazy
                    # import. Re-binding open_engine here would shadow
                    # it as a local and trigger UnboundLocalError up
                    # the function from the earlier write site.
                    from .services.database import introspect as _intro
                    engine = open_engine(forge_dir)
                    try:
                        existing = {t["name"] for t in
                                    _intro(engine).get("tables", [])}
                    except Exception:
                        existing = set()
                    if "users" not in existing:
                        spec = {
                            "summary": "forge auth: ensure users table",
                            "operations": [{"add_table": {
                                "name": "users",
                                "columns": [
                                    "id pk",
                                    "email text unique",
                                    "password_hash text",
                                    "oauth_subject text",
                                    "created_at timestamp default(now())",
                                    "last_login_at timestamp",
                                ],
                                "rls": "own-row",
                            }}],
                        }
                        try:
                            res = migrate_apply(engine, spec)
                            db_results.append({
                                "table": "users (auth)",
                                "migration_id": res["migration_id"],
                            })
                        except Exception as e:
                            skipped.append(f"users-auth-table: {e}")
            except Exception as e:
                skipped.append(f"users-auth-table: {e}")

    # F-2: storage buckets - create one per detected name. Default to
    # private; the agent flips public on specific buckets as needed.
    if req.buckets:
        try:
            from .services.storage import create_bucket, list_buckets
            existing = {b["name"] for b in list_buckets(forge_dir)}
            for b in req.buckets:
                if b in existing:
                    skipped.append(f"bucket:{b}: already exists")
                    continue
                try:
                    create_bucket(forge_dir, b, public=(b == "public-assets"))
                except Exception as e:
                    skipped.append(f"bucket:{b}: {e}")
        except Exception as e:
            errors.append(f"storage provisioning failed: {e}")

    # F-2/F-3 placeholders so we don't silently lose detected requirements.
    for kind, items in (
        ("functions", req.functions),
        ("schedules", req.schedules),
        ("realtime_channels", req.realtime_channels),
        ("payments", req.payments),
    ):
        if items:
            skipped.append(f"{kind}={items} (Phase F-3)")

    return ProvisionResult(forge_dir=forge_dir,
                           db_migrations=db_results,
                           skipped=skipped,
                           errors=errors)


def _table_spec_to_migration(t: TableSpec) -> Dict[str, Any]:
    """Convert a detector TableSpec into a migrate_apply input dict.

    The detector emits a best-effort schema. The agent will refine via
    further forge_db_migrate calls inside the loop - this baseline just
    ensures the table exists so the iteration's prompt can show it in the
    semantic-layer block."""
    columns: List[Dict[str, Any]] = []
    has_id = False
    for c in t.columns or []:
        col = _normalize_column(c)
        if col.get("primary_key"):
            has_id = True
        columns.append(col)
    if not has_id:
        columns.insert(0, {"name": "id", "type": "id"})
    return {
        "summary": f"forge_detector: ensure table {t.name}",
        "operations": [
            {
                "add_table": {
                    "name": t.name,
                    "columns": columns,
                    "rls": t.rls or "own-row",
                    "indices": t.indices or [],
                }
            }
        ],
    }


def _normalize_column(c: Any) -> Dict[str, Any]:
    if isinstance(c, dict):
        return c
    # Detector emits strings like "id pk" or "email text unique".
    tokens = str(c).strip().split()
    if not tokens:
        return {"name": "col", "type": "text"}
    name = tokens[0]
    out: Dict[str, Any] = {"name": name, "type": "text"}
    rest = [t.lower() for t in tokens[1:]]
    for tok in rest:
        if tok in ("pk", "primary"):
            out["primary_key"] = True
            out["type"] = "id"
        elif tok == "unique":
            out["unique"] = True
        elif tok in ("notnull", "not_null"):
            out["notnull"] = True
        elif tok in ("text", "string", "int", "integer", "bool", "boolean",
                     "real", "float", "double", "json", "timestamp",
                     "datetime", "uuid", "blob", "bytes"):
            out["type"] = tok
        elif tok.startswith("default(") and tok.endswith(")"):
            out["default"] = tok[len("default("):-1]
        elif tok.startswith("references="):
            out["references"] = tok.split("=", 1)[1]
    return out
