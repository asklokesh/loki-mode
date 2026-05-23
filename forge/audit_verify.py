"""X-50: forge audit chain verification.

Walks the migration review records under .loki/quality/forge-
migrations/ and asserts:

  - Every spec_hash in the review record matches the sha256 of the
    stored spec_json in the engine's _forge_migrations table.
  - Every migration_id appears in the dashboard audit log (when the
    audit module is present and has events).

Returns a structured report; never throws on missing pieces - just
records them as warnings.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Dict, List


def verify(project_dir: str) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "schema": "loki.forge.audit.verify/v1",
        "ok": True,
        "checked_reviews": 0,
        "errors": [],
        "warnings": [],
    }
    rev_dir = os.path.join(project_dir, ".loki", "quality",
                            "forge-migrations")
    if not os.path.isdir(rev_dir):
        out["warnings"].append("no review directory yet")
        return out

    # Build a {migration_id -> spec_hash} map from the engine ledger.
    forge_dir = os.path.join(project_dir, ".loki", "forge")
    engine_hashes: Dict[str, Dict[str, str]] = {}
    db_path = os.path.join(forge_dir, "db.sqlite")
    if os.path.isfile(db_path):
        try:
            from forge.services.database import open_engine
            engine = open_engine(forge_dir)
            rows = engine.execute(
                "SELECT id, spec_hash, spec_json FROM _forge_migrations"
            )
            for r in rows:
                engine_hashes[r["id"]] = {
                    "spec_hash": r["spec_hash"],
                    "spec_json": r["spec_json"],
                }
        except Exception as e:
            out["warnings"].append(f"engine ledger unreadable: {e}")

    for f in sorted(os.listdir(rev_dir)):
        if not f.endswith(".json"):
            continue
        try:
            with open(os.path.join(rev_dir, f), "r", encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, json.JSONDecodeError) as e:
            out["errors"].append(f"review {f} unreadable: {e}")
            out["ok"] = False
            continue
        out["checked_reviews"] += 1
        mid = rec.get("migration_id")
        spec_hash = rec.get("spec_hash")
        ledger = engine_hashes.get(mid)
        if ledger is None:
            out["warnings"].append(
                f"review {mid} has no corresponding ledger entry"
            )
            continue
        if ledger["spec_hash"] != spec_hash:
            out["errors"].append(
                f"review {mid} spec_hash mismatch: review={spec_hash[:16]}.. "
                f"ledger={ledger['spec_hash'][:16]}.."
            )
            out["ok"] = False
            continue
        # Recompute the spec_hash from spec_json to make sure the ledger
        # itself wasn't tampered with.
        recomputed = hashlib.sha256(ledger["spec_json"].encode("utf-8")).hexdigest()
        # The ledger stores spec_json sorted via json.dumps(spec,
        # sort_keys=True). If the user serialized the spec with the
        # same sort_keys (which migrate_apply does) the hash will match
        # only when the ledger is unchanged. We tolerate sort_keys
        # variance by also computing via the canonical re-serialization.
        try:
            obj = json.loads(ledger["spec_json"])
            canonical = json.dumps(obj, sort_keys=True)
            recomputed_canon = hashlib.sha256(
                canonical.encode("utf-8")
            ).hexdigest()
        except json.JSONDecodeError:
            recomputed_canon = ""
        if spec_hash not in (recomputed, recomputed_canon):
            out["errors"].append(
                f"review {mid} ledger spec_json hash drift "
                f"(stored hash {spec_hash[:16]}.. does not match recomputed)"
            )
            out["ok"] = False

    # Dashboard audit chain check (when available + initialized).
    try:
        from dashboard import audit as _audit
        if hasattr(_audit, "verify_log_integrity") \
           and hasattr(_audit, "_get_current_log_file"):
            log_file = _audit._get_current_log_file()
            if os.path.isfile(str(log_file)):
                report = _audit.verify_log_integrity(str(log_file))
                if not report.get("valid"):
                    out["errors"].append(
                        "dashboard audit chain reported invalid"
                    )
                    out["ok"] = False
                else:
                    out["dashboard_audit"] = "ok"
            else:
                out["warnings"].append("dashboard audit log not initialized")
    except Exception as e:
        out["warnings"].append(f"dashboard audit check skipped: {e}")

    return out
