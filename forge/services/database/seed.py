"""X-72: declarative database seeding.

The agent passes a list of {table, rows[]} dicts; we INSERT each row
and record a content-hash in `_forge_seeds` so subsequent applies of
the same seed set are idempotent.

Use case: bootstrap a fresh project with default users, default
roles, demo data, etc.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Dict, List

from .engine import Engine
from .introspect import _qident


def _ensure_seed_table(engine: Engine) -> None:
    engine.script_exec(
        "CREATE TABLE IF NOT EXISTS _forge_seeds ("
        " id TEXT PRIMARY KEY,"
        " content_hash TEXT NOT NULL UNIQUE,"
        " table_name TEXT NOT NULL,"
        " rows INTEGER NOT NULL,"
        " applied_at TEXT NOT NULL)"
    )


def seed(engine: Engine, seeds: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Apply each seed. seeds = [{"table": "users", "rows": [{...}, {...}]}].

    Returns {applied, skipped, errors}. Idempotent by content_hash.
    """
    _ensure_seed_table(engine)
    applied: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    errors: List[str] = []

    import time as _time
    for seed_spec in seeds:
        if not isinstance(seed_spec, dict):
            errors.append(f"seed entry must be a dict: {seed_spec!r}")
            continue
        table = seed_spec.get("table")
        rows = seed_spec.get("rows") or []
        if not table or not isinstance(rows, list) or not rows:
            errors.append(f"seed entry needs table + non-empty rows")
            continue
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", table):
            errors.append(f"invalid table name: {table!r}")
            continue

        canonical = json.dumps({"table": table, "rows": rows},
                                sort_keys=True, separators=(",", ":"))
        content_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()

        existing = engine.execute(
            "SELECT id FROM _forge_seeds WHERE content_hash = ?",
            (content_hash,),
        )
        if existing:
            skipped.append({"table": table, "reason": "already_applied",
                            "content_hash": content_hash[:16]})
            continue

        inserted = 0
        for row in rows:
            if not isinstance(row, dict) or not row:
                errors.append(f"{table}: row must be a non-empty dict")
                continue
            cols = sorted(row.keys())
            for c in cols:
                if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", c):
                    errors.append(f"{table}: invalid column {c!r}")
                    cols = []
                    break
            if not cols:
                continue
            placeholders = ", ".join("?" for _ in cols)
            col_list = ", ".join(_qident(c) for c in cols)
            values = [row[c] for c in cols]
            try:
                engine.execute(
                    f"INSERT INTO {_qident(table)} ({col_list}) "
                    f"VALUES ({placeholders})",
                    values, allow_writes=True,
                )
                inserted += 1
            except Exception as e:
                errors.append(f"{table}: row insert failed: {e}")

        if inserted:
            import uuid as _uuid
            engine.execute(
                "INSERT INTO _forge_seeds "
                "(id, content_hash, table_name, rows, applied_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (_uuid.uuid4().hex, content_hash, table, inserted,
                 _time.strftime("%Y-%m-%dT%H:%M:%SZ", _time.gmtime())),
                allow_writes=True,
            )
            applied.append({"table": table, "rows_inserted": inserted,
                            "content_hash": content_hash[:16]})

    return {"applied": applied, "skipped": skipped, "errors": errors}
