#!/usr/bin/env python3
"""Read-only evidence API: receipts (and the artifact files beside them).

WHY THIS EXISTS. The dashboard has 138 routes and ZERO of them touch receipts,
which are the product's differentiator: there is currently no way to show the
evidence chain at all. This module is the data layer for that, and nothing
more.

WHAT IS DELIBERATELY NOT HERE. No hashing, no receipt parsing, no verdict
precedence. Every one of those already has exactly one definition upstream and
a second copy is how the two drift:

    verify(), verify_integrity()   autonomy/lib/proof-verify.py
    receipt_state()                tools/receipt-bundle.py  (3-state classifier)
    find_receipts()                tools/receipt-bundle.py  (the walker)
    measured_cost()                tools/receipt-diff.py, via receipt-bundle

This file maps their output onto a UI shape and adds ONE fact they do not
carry: freshness. That is the entire diff.

THE STATES ARE NOT COLLAPSED. A receipt that cannot be verified reads
UNVERIFIABLE with the reason that made it so. It never reads "ok", and it is
never dropped from the list -- an absent row is indistinguishable from a clean
one, which is the failure mode receipts exist to prevent.

    VERIFIED      every axis was checked and passed
    FAILED        an axis was checked and said no
    UNVERIFIABLE  an axis could NOT be checked here, with its reason
    EMPTY         the walk found nothing (a verdict, never a pass)

FRESHNESS IS MEASURED OR UNKNOWN, NEVER ZERO. `freshness_s` is None when
generated_at is absent or unparseable, and `freshness_source` says which. Zero
would read as "generated this instant", which is a fabricated observation.
Note generated_at ends in "Z", which datetime.fromisoformat rejects before
Python 3.11 -- handled below, since this must behave the same on both.

EVERY RESULT CARRIES ITS OWN SOURCE AND ERROR STATE. `source` names the file or
walk the numbers came from, `checked_at` when, and `error` is a string whenever
the answer could not be produced -- never an empty list standing in for a
failed read.
"""

import datetime
import importlib.util
import os
import pathlib
import sys

# A stale .pyc for a hyphenated module loaded by path makes mutation probes
# report FALSE failures (the probe edits the source, the loader serves the old
# bytecode). Must be set before any loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_pv = _load("proof_verify", _ROOT / "autonomy" / "lib" / "proof-verify.py")
_rb = _load("receipt_bundle", _ROOT / "tools" / "receipt-bundle.py")

verify = _pv.verify
receipt_state = _rb.receipt_state
find_receipts = _rb.find_receipts
find_receipts_bounded = _rb.find_receipts_bounded
measured_cost = _rb.measured_cost

VERIFIED = _rb.VERIFIED
FAILED = _rb.FAILED
UNVERIFIABLE = _rb.UNVERIFIABLE
EMPTY = _rb.EMPTY


def _now():
    return datetime.datetime.now(datetime.timezone.utc)


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_generated_at(value):
    """(datetime | None, reason). Reason is non-empty exactly when dt is None.

    fromisoformat rejects a trailing "Z" before Python 3.11, so it is swapped
    for the explicit +00:00 offset rather than sliced away -- dropping it would
    silently reinterpret a UTC stamp as local time and skew every freshness
    number by the host's offset.
    """
    if not isinstance(value, str) or not value:
        return None, "receipt records no generated_at timestamp"
    try:
        dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None, "generated_at is not an ISO-8601 timestamp: %r" % value
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    return dt, ""


def _freshness(proof, now=None):
    """How old the receipt says it is, in seconds, or UNKNOWN with a reason.

    A negative age (receipt stamped in the future) is reported as-is rather
    than clamped to 0: clock skew is a real condition an operator needs to see,
    and clamping would disguise it as a fresh receipt.
    """
    now = now or _now()
    generated_at = proof.get("generated_at") if isinstance(proof, dict) else None
    dt, reason = _parse_generated_at(generated_at)
    if dt is None:
        return {
            "generated_at": generated_at if isinstance(generated_at, str) else None,
            "freshness_s": None,
            "freshness_source": "UNKNOWN: " + reason,
        }
    return {
        "generated_at": generated_at,
        "freshness_s": (now - dt).total_seconds(),
        "freshness_source": "receipt generated_at vs wall clock at read time",
    }


def _cost_usd(proof):
    """Measured cost, or None. None means UNMEASURED, not free.

    `is not None`, never truthiness: a genuinely measured $0.00 is a real
    observation and must survive as 0.0.
    """
    try:
        cost = measured_cost(proof)
    except Exception:
        return None
    if cost is None:
        return None
    return cost.get("cost_usd")


def list_receipts(workspace, repo_dir=".", max_entries=None,
                  max_seconds=None):
    """Every receipt under `workspace`, classified. Pure: no writes, no network.

    Returns a list of rows, one per receipt found, each carrying:
      path, verdict, hash_ok, cost_usd|None, measured, generated_at,
      freshness_s|None, freshness_source, reason

    `measured` is about COST specifically -- whether cost_usd is a real
    observation -- and is independent of the verdict. A FAILED receipt can
    still have measured its own spend, and hiding that would understate what a
    bad run cost.

    A row whose receipt will not load is kept with verdict UNVERIFIABLE and the
    loader's own reason. It is never dropped: a missing row and a clean row
    look identical to a reader.

    ponytail: O(N) receipts x several git subprocesses each, over an unbounded
    rglob, and integrity is computed twice per receipt (verify() does it
    internally, then verify_integrity() again for hash_ok). Both are deliberate:
    the alternative is re-deriving the verdict precedence ladder here, which is
    exactly the drift this module exists to avoid. Paginate, or cache by
    (path, mtime), if a workspace outgrows an interactive request.
    """
    root = pathlib.Path(workspace)
    if not root.is_dir():
        return []
    paths, _truncated = find_receipts_bounded(root, max_entries=max_entries,
                                              max_seconds=max_seconds)
    return _rows_for_paths(paths, repo_dir)


def _rows_for_paths(paths, repo_dir="."):
    """Classify an ALREADY-WALKED list of receipt paths.

    Split out from list_receipts so receipts_report can do the walk itself and
    keep the truncation reason as a local. Sharing this loop means the two
    entry points cannot drift into classifying the same receipt differently.
    """
    rows = []
    now = _now()
    for path in paths:
        state, reason = receipt_state(path, repo_dir)

        try:
            proof = _pv._load_proof(str(path))
        except Exception as exc:
            # Classified but unreadable: keep the row, say why, and leave every
            # derived field UNKNOWN rather than defaulting it to a number.
            rows.append({
                "path": str(path),
                "verdict": state,
                "hash_ok": None,
                "cost_usd": None,
                "measured": False,
                "generated_at": None,
                "freshness_s": None,
                "freshness_source": "UNKNOWN: receipt could not be read: %s" % exc,
                "reason": reason or str(exc),
            })
            continue

        # hash_ok is the integrity axis alone and is git-independent, so it
        # stays meaningful even where the repo checks cannot run.
        try:
            hash_ok = bool(_pv.verify_integrity(proof).get("hash_ok"))
        except Exception:
            hash_ok = None

        cost = _cost_usd(proof)
        row = {
            "path": str(path),
            "verdict": state,
            "hash_ok": hash_ok,
            "cost_usd": cost,
            "measured": cost is not None,
            "reason": reason,
        }
        row.update(_freshness(proof, now))
        rows.append(row)

    return rows


def receipts_report(workspace, repo_dir=".", max_entries=None,
                    max_seconds=None):
    """list_receipts plus the batch verdict, source, and error state.

    The verdict is the WEAKEST state present (imported, never restated), and an
    empty walk is EMPTY -- its own verdict, not a vacuous pass. "We found
    nothing wrong" is not a claim anyone is entitled to make about a tree they
    never opened.
    """
    root = pathlib.Path(workspace)
    checked_at = _iso(_now())
    base = {
        "report": "loki-dashboard-receipts/v1",
        "source": "walk of proof.json under %s, re-verified from %s" % (
            os.path.abspath(str(workspace)), os.path.abspath(repo_dir)),
        "checked_at": checked_at,
        "freshness_source": "computed at read time; no cache",
        "receipts": [],
        "count": 0,
        # Seeded here, not only on the success path. A consumer must be able to
        # read the same keys on BOTH paths; a counts block that exists only when
        # the walk succeeded makes report["counts"][FAILED] raise KeyError
        # exactly when something went wrong, which is when it is needed most.
        "counts": {FAILED: 0, UNVERIFIABLE: 0, VERIFIED: 0},
        "verdict": EMPTY,
        # Seeded here, not only on the success path, for the same reason
        # `counts` is: a consumer reading report["truncated"] must not hit a
        # KeyError on the branch where the walk could not run at all.
        "truncated": None,
        "error": None,
    }
    if not root.is_dir():
        base["error"] = "workspace not found or not a directory: %s" % workspace
        return base

    # The walk is done HERE, not inside list_receipts, so the truncation
    # reason is a plain local rather than shared mutable state. Stashing it on
    # the function object would race between concurrent requests and could
    # report one caller's complete walk as another's partial one.
    _paths, truncated = find_receipts_bounded(root, max_entries=max_entries,
                                              max_seconds=max_seconds)
    rows = _rows_for_paths(_paths, repo_dir)
    base["truncated"] = truncated
    base["receipts"] = rows
    base["count"] = len(rows)
    base["verdict"] = _rb.rollup([r["verdict"] for r in rows])
    base["counts"] = {s: sum(1 for r in rows if r["verdict"] == s)
                      for s in (FAILED, UNVERIFIABLE, VERIFIED)}
    if truncated:
        # A partial walk cannot certify a sequence. The verdict is held down
        # to UNVERIFIABLE rather than reported as VERIFIED over the subset
        # that happened to be reached before the limit.
        if base["verdict"] == VERIFIED:
            base["verdict"] = UNVERIFIABLE
        base["error"] = ("the receipt walk was truncated (%s), so this audit "
                         "is PARTIAL and cannot certify the workspace"
                         % truncated)
    elif not rows:
        base["error"] = ("no receipts found under this workspace, so nothing "
                         "was audited. Zero receipts is not a passing audit.")
    return base


def receipt_detail(path, repo_dir="."):
    """The verifier's OWN output, verbatim, plus freshness and source.

    verify()'s dict is passed through unmodified under `verification` -- not
    reshaped, not filtered, not summarised. Any reshaping here would be a
    second opinion about what a receipt says, and the entire point is that
    there is one.
    """
    checked_at = _iso(_now())
    out = {
        "report": "loki-dashboard-receipt-detail/v1",
        "path": str(path),
        "source": "autonomy/lib/proof-verify.py verify(), re-run at read time",
        "checked_at": checked_at,
        "verification": None,
        "verdict": UNVERIFIABLE,
        "reason": "",
        "generated_at": None,
        "freshness_s": None,
        "freshness_source": "UNKNOWN: receipt not read",
        # Same rule as counts above: every early return below must still carry
        # these keys, and UNMEASURED is None/False -- never 0.0/True.
        "cost_usd": None,
        "measured": False,
        "error": None,
    }

    p = pathlib.Path(path)
    if not p.is_file():
        out["error"] = ("no such receipt: %s -- not present on disk" % path)
        out["reason"] = out["error"]
        out["freshness_source"] = "UNKNOWN: " + out["error"]
        return out

    try:
        out["verification"] = verify(str(p), repo_dir)
    except Exception as exc:
        out["error"] = "the receipt could not be verified: %s" % exc
        out["reason"] = out["error"]
        out["freshness_source"] = "UNKNOWN: " + out["error"]
        return out

    # The verdict comes from the shared classifier, NOT from verify()'s `ok`.
    # `ok` is False both for a receipt that failed a check and for one whose
    # checks could not run, and collapsing those two is the distinction this
    # whole surface exists to preserve.
    state, reason = receipt_state(str(p), repo_dir)
    out["verdict"] = state
    out["reason"] = reason

    try:
        proof = _pv._load_proof(str(p))
    except Exception as exc:
        out["freshness_source"] = "UNKNOWN: receipt could not be read: %s" % exc
        return out

    out.update(_freshness(proof))
    out["cost_usd"] = _cost_usd(proof)
    out["measured"] = out["cost_usd"] is not None
    return out


def list_artifacts(workspace):
    """Real files under `workspace`/artifacts/, with mtime-derived freshness.

    ponytail: an enumeration of what is actually on disk, nothing more. No
    artifact taxonomy, no type inference, no parsing of contents -- there is no
    artifact schema in this repo to be faithful to, and inventing one would be
    fabricating structure the files do not have.

    ponytail: unbounded rglob, stat per file, no pagination. Fine for the ~75
    files this repo has; add a limit + offset if a workspace outgrows it.
    """
    root = pathlib.Path(workspace) / "artifacts"
    now = _now()
    out = {
        "report": "loki-dashboard-artifacts/v1",
        "source": "directory listing of %s" % os.path.abspath(str(root)),
        "checked_at": _iso(now),
        "freshness_source": "filesystem mtime vs wall clock at read time",
        "artifacts": [],
        "count": 0,
        "error": None,
    }
    if not root.is_dir():
        out["error"] = "no artifacts directory under this workspace: %s" % root
        return out

    rows = []
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        try:
            st = p.stat()
        except OSError as exc:
            # Named and counted, never skipped -- an unreadable artifact is a
            # fact about the tree, not an absence.
            rows.append({
                "path": str(p),
                "size_bytes": None,
                "modified_at": None,
                "freshness_s": None,
                "freshness_source": "UNKNOWN: could not stat: %s" % exc,
            })
            continue
        mtime = datetime.datetime.fromtimestamp(
            st.st_mtime, datetime.timezone.utc)
        rows.append({
            "path": str(p),
            "size_bytes": st.st_size,
            "modified_at": _iso(mtime),
            "freshness_s": (now - mtime).total_seconds(),
            "freshness_source": "filesystem mtime",
        })

    out["artifacts"] = rows
    out["count"] = len(rows)
    if not rows:
        out["error"] = ("artifacts directory exists but contains no files, so "
                        "nothing was listed.")
    return out
