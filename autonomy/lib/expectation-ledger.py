#!/usr/bin/env python3
"""Annotate-before-act expected-outcome ledger for Loki Mode.

Companion to proof-generator.py / proof-verify.py. Before running verification
for a change or checklist item, the runtime writes a tamper-evident ledger of
EXPECTED observable outcomes (e.g. "GET /health -> 200 {status:ok}", "test X
fails before the fix and passes after", "endpoint Y should now exist"). At
verify time the actual results are compared to this PRE-COMMITTED prediction:
any expectation that was silently dropped (never executed) or contradicted
(actual != expected) becomes a finding. An expectation that cannot be evaluated
maps to INCONCLUSIVE, never VERIFIED.

Why this is trustworthy:
  - The ledger is written BEFORE the act/verify, so it is a genuine prediction,
    not a post-hoc rationalization of whatever happened.
  - It is TAMPER-EVIDENT: the whole ledger is canonicalized and hashed the SAME
    way proof-generator.py hashes proof.json (sha256 over the compact, sorted
    JSON form). The hash is recorded in the ledger file AND embedded into
    evidence.json / proof.json, so an expectation edited after the fact breaks
    the embedded hash and is detectable.

Design rules (mirror proof-generator.py):
  - Canonicalization MUST match proof-generator._canonical EXACTLY
    (json.dumps sort_keys=True, compact separators, default ensure_ascii). The
    ledger hash and the proof hash therefore use one identical scheme.
  - Additive + fail-open: nothing writes a ledger yet in the common case, so
    the read/compare side must no-op cleanly when the ledger is absent.
  - Catch broadly on the write path; never raise into the run loop.

CLI (bash-callable, mirrors proof-generator.py / proof-verify.py CLIs):
    expectation-ledger.py write --loki-dir .loki --iter 3 \
        --id health-200 --statement "GET /health -> 200" \
        --check-ref tests --expected '{"status":200}'
    expectation-ledger.py hash --loki-dir .loki --iter 3
    expectation-ledger.py verify-hash --loki-dir .loki --iter 3
"""

import argparse
import hashlib
import json
import os
import sys


# ---------------------------------------------------------------------------
# canonicalization (MUST match proof-generator._canonical / proof-verify._canonical)
# ---------------------------------------------------------------------------

def _canonical(obj):
    """Canonical JSON form used for the tamper-evident hash.

    Identical to proof-generator.py _canonical() and proof-verify.py
    _canonical(): json.dumps with sort_keys=True and compact separators, and no
    explicit ensure_ascii (defaults to True). Keeping this byte-for-byte
    identical is what lets the ledger hash and the proof hash share one scheme,
    so a verifier recomputes it the same way for both artifacts.
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


# ---------------------------------------------------------------------------
# ledger paths + shape
# ---------------------------------------------------------------------------

def ledger_path(loki_dir, iteration):
    """Path to the per-iteration ledger: .loki/expectations/<iter>.json."""
    return os.path.join(loki_dir, "expectations", "%s.json" % iteration)


def _normalize_entry(entry):
    """Coerce one expectation into the frozen entry shape.

    Shape: {id, statement, check_ref, expected}. Unknown keys are dropped so the
    canonical hash is stable regardless of caller-supplied extras. `expected` is
    kept as-is (it may be a scalar, dict, or list): the compare step interprets
    it, the ledger only records it verbatim.
    """
    if not isinstance(entry, dict):
        return None
    eid = entry.get("id")
    if eid is None or str(eid).strip() == "":
        return None
    return {
        "id": str(eid),
        "statement": str(entry.get("statement") or ""),
        "check_ref": str(entry.get("check_ref") or ""),
        "expected": entry.get("expected"),
    }


def _sorted_entries(entries):
    """Entries sorted by id so the ledger hash is order-independent.

    Two runs that record the same expectations in a different order produce the
    same ledger and the same hash -- the prediction is a SET, not a sequence.
    """
    clean = [e for e in (_normalize_entry(x) for x in entries) if e is not None]
    return sorted(clean, key=lambda e: e["id"])


def compute_ledger_hash(entries):
    """sha256 over the canonical form of the sorted entries.

    Same algorithm proof-generator.py uses for proof.json's integrity hash
    (sha256 of _canonical(...)), so the value embedded into evidence/proof is
    recomputable by the same verifier code path.
    """
    canonical = _canonical(_sorted_entries(entries)).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


# ---------------------------------------------------------------------------
# read / write
# ---------------------------------------------------------------------------

def read_ledger(loki_dir, iteration):
    """Return the ledger dict, or None when absent / unreadable.

    Absent ledger is the common case today; callers treat None as "no ledger,
    no-op". Never raises: a malformed file returns None so the read side stays
    fail-open.
    """
    path = ledger_path(loki_dir, iteration)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r") as f:
            data = json.load(f)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    return data


def write_entry(loki_dir, iteration, entry):
    """Append one expectation to the iteration ledger and re-seal the hash.

    Idempotent per id: writing the same id again REPLACES the prior entry (a
    prediction is refined, not duplicated). Recomputes ledger_sha256 over the
    full entry set after each write so the on-disk file is always self-consistent
    (the recorded hash matches its own entries). Returns the new ledger_sha256,
    or None on failure (never raises into the run loop).
    """
    norm = _normalize_entry(entry)
    if norm is None:
        return None
    try:
        existing = read_ledger(loki_dir, iteration) or {}
        entries = existing.get("entries")
        if not isinstance(entries, list):
            entries = []
        # Replace-by-id so refining a prediction does not create a duplicate.
        entries = [e for e in entries
                   if not (isinstance(e, dict) and str(e.get("id")) == norm["id"])]
        entries.append(norm)
        entries = _sorted_entries(entries)

        ledger = {
            "schema_version": "1.0",
            "iteration": str(iteration),
            "entries": entries,
            "ledger_sha256": compute_ledger_hash(entries),
        }
        path = ledger_path(loki_dir, iteration)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(ledger, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
        return ledger["ledger_sha256"]
    except Exception:
        return None


def ledger_hash_ok(loki_dir, iteration):
    """True iff the recorded ledger_sha256 matches its own entries.

    This is the tamper check: an expectation edited after write (without
    re-sealing) makes the stored hash disagree with the recomputed one. Returns
    (ok, recorded, recomputed); ok is None when there is no ledger.
    """
    ledger = read_ledger(loki_dir, iteration)
    if ledger is None:
        return None, None, None
    recorded = str(ledger.get("ledger_sha256") or "")
    entries = ledger.get("entries")
    if not isinstance(entries, list):
        entries = []
    recomputed = compute_ledger_hash(entries)
    return (recorded == recomputed and bool(recorded)), recorded, recomputed


# ---------------------------------------------------------------------------
# compare (READ + COMPARE)
# ---------------------------------------------------------------------------

def _stringify(v):
    """Stable string form for equality comparison of an expected/actual value.

    Uses the canonical form for dicts/lists so key order does not matter, and a
    plain str() for scalars. Comparison is intentionally exact after this
    normalization -- an expectation is a precise prediction, not a fuzzy match.
    """
    if isinstance(v, (dict, list)):
        return _canonical(v)
    return str(v)


def compare(loki_dir, iteration, observed):
    """Compare the pre-committed ledger against observed results.

    `observed` maps expectation id -> actual observation. Each observation is
    either:
      - a value (scalar/dict/list): compared directly to `expected`; OR
      - a dict {"actual": <value>} for the same; OR
      - a dict {"evaluable": False, ...} to mark an expectation that ran but
        could not be evaluated (-> inconclusive).
    An id NOT present in `observed` is a DROPPED expectation (never executed).

    Returns a dict:
      {
        "ledger_present": bool,
        "ledger_hash_ok": bool | None,   # None when no ledger
        "ledger_sha256": str | None,
        "results": [ {id, statement, check_ref, expected, actual,
                      outcome} ],        # outcome in met|contradicted|dropped|inconclusive
        "met": int, "contradicted": int, "dropped": int, "inconclusive": int,
      }
    Fully no-op when the ledger is absent: ledger_present False, empty results.
    """
    out = {
        "ledger_present": False,
        "ledger_hash_ok": None,
        "ledger_sha256": None,
        "results": [],
        "met": 0, "contradicted": 0, "dropped": 0, "inconclusive": 0,
    }
    ledger = read_ledger(loki_dir, iteration)
    if ledger is None:
        return out

    out["ledger_present"] = True
    out["ledger_sha256"] = str(ledger.get("ledger_sha256") or "") or None
    ok, _rec, _recomp = ledger_hash_ok(loki_dir, iteration)
    out["ledger_hash_ok"] = ok

    observed = observed if isinstance(observed, dict) else {}
    entries = ledger.get("entries")
    if not isinstance(entries, list):
        entries = []

    for e in entries:
        if not isinstance(e, dict):
            continue
        eid = str(e.get("id") or "")
        expected = e.get("expected")
        row = {
            "id": eid,
            "statement": str(e.get("statement") or ""),
            "check_ref": str(e.get("check_ref") or ""),
            "expected": expected,
            "actual": None,
            "outcome": "dropped",
        }

        if eid not in observed:
            # Not executed at all -> dropped. A predicted-and-forgotten check is
            # exactly the silent-drop this ledger exists to catch.
            row["outcome"] = "dropped"
        else:
            obs = observed[eid]
            if isinstance(obs, dict) and obs.get("evaluable") is False:
                row["outcome"] = "inconclusive"
                row["actual"] = obs.get("actual")
            else:
                actual = obs.get("actual") if isinstance(obs, dict) and "actual" in obs else obs
                row["actual"] = actual
                if _stringify(actual) == _stringify(expected):
                    row["outcome"] = "met"
                else:
                    row["outcome"] = "contradicted"

        out[row["outcome"]] += 1
        out["results"].append(row)

    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _cmd_write(args):
    try:
        expected = json.loads(args.expected) if args.expected else None
    except Exception:
        # A bare string that is not JSON is recorded verbatim as the expected
        # value (e.g. --expected "200"): honest passthrough, never a crash.
        expected = args.expected
    h = write_entry(args.loki_dir, args.iter, {
        "id": args.id,
        "statement": args.statement,
        "check_ref": args.check_ref,
        "expected": expected,
    })
    if h is None:
        sys.stderr.write("warn: expectation-ledger write failed\n")
        return 1
    print(h)
    return 0


def _cmd_hash(args):
    ledger = read_ledger(args.loki_dir, args.iter)
    if ledger is None:
        sys.stderr.write("no ledger for iteration %s\n" % args.iter)
        return 2
    print(str(ledger.get("ledger_sha256") or ""))
    return 0


def _cmd_verify_hash(args):
    ok, recorded, recomputed = ledger_hash_ok(args.loki_dir, args.iter)
    if ok is None:
        print(json.dumps({"ok": False, "error": "no ledger"}))
        return 2
    print(json.dumps({"ok": bool(ok), "recorded": recorded,
                      "recomputed": recomputed}))
    return 0 if ok else 1


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Loki Mode annotate-before-act expectation ledger")
    sub = parser.add_subparsers(dest="cmd")

    w = sub.add_parser("write", help="append/replace one expectation")
    w.add_argument("--loki-dir", default=".loki")
    w.add_argument("--iter", required=True)
    w.add_argument("--id", required=True)
    w.add_argument("--statement", default="")
    w.add_argument("--check-ref", default="", dest="check_ref")
    w.add_argument("--expected", default="")
    w.set_defaults(func=_cmd_write)

    h = sub.add_parser("hash", help="print the recorded ledger_sha256")
    h.add_argument("--loki-dir", default=".loki")
    h.add_argument("--iter", required=True)
    h.set_defaults(func=_cmd_hash)

    v = sub.add_parser("verify-hash", help="check ledger_sha256 vs its entries")
    v.add_argument("--loki-dir", default=".loki")
    v.add_argument("--iter", required=True)
    v.set_defaults(func=_cmd_verify_hash)

    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
