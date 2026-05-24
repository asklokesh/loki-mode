"""X-50: forge audit chain verification.

Walks the migration review records under .loki/quality/forge-
migrations/ and asserts:

  - Every spec_hash in the review record matches the sha256 of the
    stored spec_json in the engine's _forge_migrations table.
  - Every migration_id appears in the dashboard audit log (when the
    audit module is present and has events).

N-13: the dashboard chain integrity check and the per-review walk
are combined into a single pass. We read the chain log once into a
{migration_id -> entry} index, verify the chain hash inline as we go,
and cross-reference each review against the index so we catch both
'review without chain entry' and 'chain entry without review' in the
same call.

Returns a structured report; never throws on missing pieces - just
records them as warnings.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Dict, List


class _ChainSkipped(Exception):
    """Internal signal for N-59 scope='migrations' path."""
    pass


def verify(project_dir: str, *, scope: str = "all") -> Dict[str, Any]:
    """N-59: scope='all' (default), 'migrations', or 'chain'. Skips
    the opposite half when scope is one of the two."""
    out: Dict[str, Any] = {
        "schema": "loki.forge.audit.verify/v1",
        "ok": True,
        "checked_reviews": 0,
        "errors": [],
        "warnings": [],
    }
    rev_dir = os.path.join(project_dir, ".loki", "quality",
                            "forge-migrations")
    # Default the dashboard_audit field so the report shape is stable
    # even on the early-return paths (N-13: single-pass invariant).
    out["dashboard_audit"] = "not_initialized"
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

    # N-13: build the chain index up-front so per-review checks can
    # cross-reference without a second pass. Chain hash verification
    # happens here too; we record the result on the report.
    chain_index: Dict[str, Dict[str, Any]] = {}
    out["dashboard_audit"] = "not_initialized"
    # N-59: skip the chain block when scope='migrations'.
    if scope == "migrations":
        out["dashboard_audit"] = "skipped"
        skip_chain = True
    else:
        skip_chain = False
    try:
        if skip_chain:
            raise _ChainSkipped()
        from dashboard import audit as _audit
        if hasattr(_audit, "_compute_chain_hash") \
           and hasattr(_audit, "_get_current_log_file"):
            log_file = _audit._get_current_log_file()
            if log_file and os.path.isfile(str(log_file)):
                prev_hash = "0" * 64
                chain_ok = True
                line_no = 0
                with open(str(log_file), "r", encoding="utf-8") as fh:
                    for line in fh:
                        line_no += 1
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            entry = json.loads(line)
                        except json.JSONDecodeError:
                            chain_ok = False
                            out["errors"].append(
                                f"chain line {line_no}: parse error"
                            )
                            break
                        stored = entry.pop("_integrity_hash", None)
                        if stored is None:
                            chain_ok = False
                            out["errors"].append(
                                f"chain line {line_no}: missing _integrity_hash"
                            )
                            break
                        entry_json = json.dumps(entry, sort_keys=True,
                                                 default=str)
                        expected = _audit._compute_chain_hash(
                            entry_json, prev_hash
                        )
                        if stored != expected:
                            chain_ok = False
                            out["errors"].append(
                                f"chain line {line_no}: integrity mismatch"
                            )
                            break
                        prev_hash = stored
                        # Index migration-related events by migration_id
                        # so the per-review walk can cross-reference in
                        # the same pass (N-13).
                        evt = entry.get("event_type", "")
                        mid = (entry.get("metadata") or {}).get("migration_id") \
                              or (entry.get("details") or {}).get("migration_id") \
                              or entry.get("migration_id")
                        if mid and "forge_migration" in evt:
                            chain_index[mid] = {
                                "line": line_no,
                                "event_type": evt,
                            }
                out["dashboard_audit"] = "ok" if chain_ok else "invalid"
                if not chain_ok:
                    out["ok"] = False
    except _ChainSkipped:
        pass
    except Exception as e:
        out["warnings"].append(f"dashboard audit check skipped: {e}")

    # N-59: skip the per-review walk when scope='chain'.
    if scope == "chain":
        return out

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
        # N-13: same-pass chain cross-reference. Only flag missing
        # chain entries when we actually have a chain to compare
        # against; an uninitialized chain stays a warning at the
        # report level and individual reviews are not penalized.
        if out["dashboard_audit"] in ("ok", "invalid"):
            if mid and mid not in chain_index:
                out["warnings"].append(
                    f"review {mid} missing from dashboard audit chain"
                )

    # N-13: chain entries that reference a migration_id with no
    # corresponding review file get flagged too. This catches the
    # inverse drift (chain records a migration the operator never
    # reviewed) which the old sequential pass missed.
    reviewed_ids = set()
    for f in os.listdir(rev_dir):
        if not f.endswith(".json"):
            continue
        try:
            with open(os.path.join(rev_dir, f), "r", encoding="utf-8") as fh:
                rec = json.load(fh)
                if rec.get("migration_id"):
                    reviewed_ids.add(rec["migration_id"])
        except (OSError, json.JSONDecodeError):
            pass
    for mid in chain_index:
        if mid not in reviewed_ids:
            out["warnings"].append(
                f"chain entry {mid} has no matching review file"
            )

    return out
