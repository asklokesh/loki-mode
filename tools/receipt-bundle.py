#!/usr/bin/env python3
"""Collect every receipt under a workspace into ONE verifiable audit trail.

WHY THIS EXISTS. Single-receipt verification exists (autonomy/lib/
proof-verify.py). Cross-run comparison exists (receipt-diff.py). Portable
attestation exists (receipt-attest.py). All three answer questions about ONE
run, or two. Nobody has to hand a compliance reviewer one run. They have to
hand over a SEQUENCE -- every run in the workspace, and a single verdict over
the lot.

That rollup is where the laundering happens, so it is what this file is
mostly about.

THE FOUR RULES. Each one is a specific way a bundle report can claim more than
it earned, and each is the honest direction, not the flattering one.

1. THE ROLLUP IS THE WEAKEST LINK, NEVER AN AVERAGE. Nine good receipts and
   one forged one is a FAILED bundle. Not "90% verified", not "mostly clean",
   not a score. A percentage lets a bad run hide inside a crowd of good ones,
   and hiding a bad run inside good ones is the entire attack this product
   line exists to prevent. Averaging also gets EASIER to pass as the bundle
   grows, which is exactly backwards: more runs should be harder to certify,
   not cheaper. See rollup() -- it is four lines and it is the product.

2. AN UNVERIFIABLE RECEIPT IS NEVER SILENTLY DROPPED. Absent is not clean. A
   bundle that quietly excludes what it could not check reports a stronger
   claim than it earned, and it does so invisibly -- the reader sees only
   receipts that passed and cannot tell whether that is because the rest were
   good or because the rest were omitted. So an unverifiable receipt is
   counted, NAMED, given a reason, and it holds the rollup down to
   UNVERIFIABLE. This is why the per-receipt state is three-valued and is NOT
   read off verify()'s `ok` field: `ok` is False for BOTH a tampered receipt
   and an honest receipt read from the wrong directory (proof-verify.py:706
   says so outright -- diff_drift None makes ok False by design). Collapsing
   those two together makes this rule unsatisfiable, because "name why" has no
   answer when FAILED and UNVERIFIABLE are the same bucket.

3. TOTAL COST SUMS ONLY MEASURED RECEIPTS, AND SAYS HOW MANY OF HOW MANY. A
   total over 10 receipts of which 3 measured cost is not a bundle total; it
   is a third of one wearing the label of the whole. The ratio rides with the
   number, always. And if NOTHING measured, the total reads UNKNOWN -- never
   $0.00, because unmeasured and free are different claims and only one of
   them is honest. The measured/unmeasured predicate is record_is_measured()
   in autonomy/lib/efficiency_cost.py, reached through receipt-diff.py's
   measured_cost() which already maps the receipt's `usd` onto the
   per-iteration `cost_usd` key. Imported twice over, restated zero times: a
   second copy of that predicate is precisely how the honesty rule drifts.

4. AN EMPTY WORKSPACE IS NOT A PASSING AUDIT. Zero receipts verified is not
   "everything verified". Vacuous truth is the cheapest false green there is,
   and a tool that reports EMPTY as clean can be passed by deleting the
   evidence. So EMPTY is its own verdict with its own non-zero exit code.

Nothing here re-implements verification. verify() in proof-verify.py is the
single source of truth; this projects its result onto three states and folds
them with min().

Usage:
    tools/receipt-bundle.py [workspace] [--json]

Exit codes:
    0  every receipt in the bundle VERIFIED
    1  at least one receipt FAILED
    2  nothing failed, but at least one receipt was UNVERIFIABLE
    3  no receipts found at all -- nothing was audited
"""

import argparse
import importlib.util
import json
import os
import pathlib
import sys
import time

# A stale .pyc for a hyphenated module loaded by path makes mutation probes
# report FALSE failures (the probe edits the source, the loader serves the old
# bytecode). Must be set before any loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo's convention 2 means "could NOT be checked" -- a real
    answer about the subject. A mistyped flag is not that: it is an error
    about the INVOCATION, and nothing about the subject was examined. The
    two call for opposite responses, since retrying cannot fix a typo.

    argparse exits 2 for every usage error unless this is overridden, so
    every tool needs it. tests/test_tool_exit_contract.py asserts it.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_pv = _load("proof_verify", _LIB / "proof-verify.py")
# measured_cost() already maps the receipt's cost block onto the per-iteration
# key names record_is_measured() expects. Reused rather than re-derived.
_rd = _load("receipt_diff", _ROOT / "tools" / "receipt-diff.py")

verify = _pv.verify
measured_cost = _rd.measured_cost

VERIFIED = "VERIFIED"
UNVERIFIABLE = "UNVERIFIABLE"
FAILED = "FAILED"
EMPTY = "EMPTY"

# Ordered worst-first. rollup() takes the min index, which IS the weakest-link
# rule: one FAILED sinks any number of VERIFIED.
_ORDER = (FAILED, UNVERIFIABLE, VERIFIED)

EXIT = {VERIFIED: 0, FAILED: 1, UNVERIFIABLE: 2, EMPTY: 3}


def rollup(states):
    """The bundle verdict: the WEAKEST state present, never an average.

    This is the whole product. One FAILED receipt among a thousand VERIFIED
    ones makes the bundle FAILED, because a buyer handing this to a compliance
    reviewer is claiming the SEQUENCE is sound, and a sequence containing a
    forged run is not sound no matter what fraction it represents.

    Any scoring rule -- mean, median, majority, "90% or better" -- makes a bad
    run cheaper to hide the more good runs surround it. Empty is its own
    verdict, not a vacuous pass (rule 4).
    """
    if not states:
        return EMPTY
    return min(states, key=_ORDER.index)


def receipt_state(proof_path, repo_dir="."):
    """Project one receipt onto (state, reason), keeping three states apart.

    verify()'s `ok` is deliberately NOT the source here. It is False both for
    a receipt that failed a check and for one whose checks could not run at
    all -- and telling those apart is the entire point of rule 2. So the
    failure signals are read individually:

        a check RAN and said no      -> FAILED        (hash_ok False,
                                                       diff_drift True,
                                                       gpg_ok False,
                                                       headline_consistent False)
        a check COULD NOT RUN        -> UNVERIFIABLE  (diff_drift None, or the
                                                       receipt would not load)

    `is` comparisons are load-bearing throughout: gpg_ok is the truthy string
    "n/a" when there is nothing to check, and `if not gpg_ok` would read that
    as a signature failure.
    """
    try:
        result = verify(str(proof_path), repo_dir)
    except Exception as exc:  # unreadable, unparseable, wrong shape
        # Named and counted, never dropped. This is the branch rule 2 is about.
        return UNVERIFIABLE, "the receipt could not be loaded or verified: %s" % exc

    reasons = result.get("reasons") or []
    detail = reasons[0] if reasons else (result.get("reason") or "")

    if not result.get("hash_ok"):
        return FAILED, detail or "the recorded integrity hash does not match the receipt bytes"
    if result.get("diff_drift") is True:
        return FAILED, detail or "the recorded diff no longer matches the repository"
    if result.get("gpg_ok") is False:
        return FAILED, detail or "the gpg signature does not verify"
    if result.get("headline_consistent") is False:
        return FAILED, detail or "the headline disagrees with the recorded facts"
    if result.get("diff_drift") is None:
        return UNVERIFIABLE, detail or "the recorded diff could not be re-derived here"
    if not result.get("ok"):
        # verify() sank the verdict on an axis not enumerated above. Report it
        # as FAILED with its own words rather than silently upgrading to
        # VERIFIED -- a new check added upstream must not arrive here as a pass.
        return FAILED, detail or "verification failed"
    return VERIFIED, ""


def find_receipts(workspace):
    """Every proof.json under the workspace, sorted for a stable report.

    ponytail: rglob over the whole tree rather than only .loki/proofs/*, so a
    receipt archived elsewhere in the workspace still gets audited. Missing
    evidence is the failure mode this file exists to prevent; over-collecting
    is not.

    UNBOUNDED ON PURPOSE, and only safe because every caller of THIS function
    is a CLI auditing a workspace the operator chose. Truncating such an audit
    silently is the missing-evidence failure above. A caller reached from an
    HTTP request must use find_receipts_bounded() instead: there the walk is a
    denial-of-service surface, not a chore.
    """
    paths, _ = find_receipts_bounded(workspace)
    return paths


def find_receipts_bounded(workspace, max_entries=None, max_seconds=None):
    """find_receipts with explicit limits, returning (paths, truncated_reason).

    truncated_reason is None on a COMPLETE walk, otherwise a string naming the
    limit that stopped it. It is a return value rather than a log line because
    a caller must not be able to report a partial audit as a complete one: a
    truncated walk that looks complete lets a FAILED receipt sitting past the
    cutoff read as "no problems found", which is the laundering this whole
    module exists to prevent.

    Both limits default to None, so this is a superset of find_receipts and the
    unbounded CLI path keeps its exact behaviour.
    """
    root = pathlib.Path(workspace)
    started = time.monotonic()
    found = []
    scanned = 0
    reason = None
    # rglob("proof.json") yields only MATCHES, so counting its results counts
    # receipts, not work. The cost being bounded here is the TRAVERSAL: a tree
    # of 400 empty directories yields zero matches while still walking every
    # one of them. os.walk exposes the directories actually visited, which is
    # the quantity that makes this a denial-of-service surface.
    for dirpath, dirnames, filenames in os.walk(str(root)):
        scanned += 1 + len(filenames)
        if max_entries is not None and scanned > max_entries:
            reason = ("stopped after scanning %d entries (limit); results are "
                      "PARTIAL" % max_entries)
            break
        if max_seconds is not None and (time.monotonic() - started) > max_seconds:
            reason = ("stopped after %.1fs (limit); results are PARTIAL"
                      % max_seconds)
            break
        if "proof.json" in filenames:
            p = pathlib.Path(dirpath) / "proof.json"
            try:
                if p.is_file():
                    found.append(p)
            except OSError:
                # Vanished mid-walk or unreadable: skipped rather than
                # aborting the whole audit.
                continue
    return sorted(found), reason


def bundle(workspace, repo_dir="."):
    """Audit every receipt under `workspace`. Pure: no writes, no network."""
    paths = find_receipts(workspace)

    receipts = []
    total = 0.0
    measured_n = 0

    for path in paths:
        state, reason = receipt_state(path, repo_dir)
        entry = {
            "path": str(path),
            "state": state,
            "reason": reason,
            "cost_usd": None,
        }

        # Cost is read from the receipt regardless of verdict, but only a
        # MEASURED cost contributes. measured_cost() returns None when the
        # block is absent, malformed, or all-zero.
        try:
            cost = measured_cost(_pv._load_proof(str(path)))
        except Exception:
            cost = None
        if cost is not None and cost.get("cost_usd") is not None:
            entry["cost_usd"] = cost["cost_usd"]
            total += cost["cost_usd"]
            measured_n += 1

        receipts.append(entry)

    verdict = rollup([r["state"] for r in receipts])

    # measured_n, NOT the total, decides UNKNOWN. Three receipts that each
    # genuinely measured $0.00 is a real observation and must survive as a
    # number; `if not total` would erase it and reintroduce the exact
    # unmeasured-reads-as-free defect this codebase spent four releases on.
    cost_block = {
        "measured_receipts": measured_n,
        "total_receipts": len(receipts),
        "total_usd": total if measured_n else None,
    }

    unverifiable = [r for r in receipts if r["state"] != VERIFIED]

    return {
        "bundle": "loki-receipt-bundle/v1",
        "workspace": os.path.abspath(str(workspace)),
        "checked_from": os.path.abspath(repo_dir),
        "receipts": receipts,
        "counts": {
            state: sum(1 for r in receipts if r["state"] == state)
            for state in _ORDER
        },
        "cost": cost_block,
        "not_verified": [
            {"path": r["path"], "state": r["state"], "reason": r["reason"]}
            for r in unverifiable
        ],
        "verdict": verdict,
        "summary": _summary(verdict, receipts, cost_block),
    }


def _cost_line(cost):
    """The total, always carrying its own ratio. UNKNOWN when nothing measured."""
    if cost["total_usd"] is None:
        return "total cost UNKNOWN (0 of %d receipts measured cost)" % (
            cost["total_receipts"])
    return "total cost $%.4f across %d of %d receipts measured" % (
        cost["total_usd"], cost["measured_receipts"], cost["total_receipts"])


def _summary(verdict, receipts, cost):
    if verdict == EMPTY:
        return ("EMPTY -- no receipts found under this workspace, so nothing "
                "was audited. Zero receipts is not a passing audit.")
    n = len(receipts)
    bad = sum(1 for r in receipts if r["state"] == FAILED)
    unv = sum(1 for r in receipts if r["state"] == UNVERIFIABLE)
    if verdict == VERIFIED:
        head = "VERIFIED -- all %d receipts verified" % n
    elif verdict == FAILED:
        head = ("FAILED -- %d of %d receipts FAILED verification; the bundle "
                "is only as good as its weakest receipt" % (bad, n))
    else:
        head = ("UNVERIFIABLE -- %d of %d receipts could not be checked here; "
                "nothing failed, but the bundle is not proven" % (unv, n))
    return head + ". " + _cost_line(cost)


def _render(report):
    lines = ["Receipt bundle: %s" % report["workspace"], ""]
    for r in report["receipts"]:
        lines.append("  %-13s %s" % (r["state"], r["path"]))
        if r["reason"]:
            lines.append("                %s" % r["reason"])
    if report["receipts"]:
        lines.append("")
    if report["not_verified"]:
        lines.append("Not verified (%d) -- counted, never dropped:"
                     % len(report["not_verified"]))
        for r in report["not_verified"]:
            lines.append("  %s [%s]" % (r["path"], r["state"]))
            lines.append("      %s" % r["reason"])
        lines.append("")
    lines.append(_cost_line(report["cost"]))
    lines.append("")
    lines.append(report["summary"])
    return "\n".join(lines)


def main(argv=None):
    ap = _Parser(
        description="Verify every receipt under a workspace as one bundle.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace to scan for receipts (default: .)")
    ap.add_argument("--json", action="store_true", help="emit the raw record")
    ap.add_argument("--repo-dir", default=".",
                    help="repository the receipts are re-checked against")
    args = ap.parse_args(argv)

    report = bundle(args.workspace, args.repo_dir)
    print(json.dumps(report, indent=2) if args.json else _render(report))
    return EXIT[report["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
