#!/usr/bin/env python3
"""Is a DIRECTORY of evidence documents still true of the current tree?

WHY THIS EXISTS, GIVEN `loki verify --check-fresh` ALREADY SHIPS. That answers
the freshness question for ONE evidence doc, from inside the workspace that
produced it. The question an operator actually has before a release is plural:

    I have a folder of receipts. Which of them still describe THIS tree?

Nothing answers that. `receipt-bundle.py` walks a directory but rolls every
axis into one integrity verdict, and `receipt-verify-batch.py` takes a declared
list. Neither separates "the tree moved underneath this receipt" from "this
receipt is forged" -- and for a staleness sweep those are the only two things
that matter, because they have opposite remedies. A stale receipt is REGENERATED.
A forged one is INVESTIGATED.

THE THREE STATES, and why the third one is the whole point:

    FRESH    the recorded diff (and tree digest, when recorded) still matches
             the repository -- this document is true of the tree right now
    STALE    a freshness axis was CHECKED and says the tree has moved since
    UNKNOWN  a freshness axis could NOT be checked here, with its reason

UNKNOWN IS NEVER FOLDED INTO FRESH AND NEVER COUNTED AS STALE. An absent
measurement is not a verdict. Folding it into FRESH is the false green this
whole tool line exists to prevent; counting it as STALE would send an operator
regenerating receipts that were never shown to be out of date. It gets its own
count, its own reason, and its own exit code (2), which is the honest report:
"nothing was proven stale, and I could not check all of it".

WHAT THIS IS NOT. This is NOT the integrity gate. A receipt whose hash does not
match, whose gpg signature fails, or whose headline contradicts its own facts is
reported here as UNKNOWN -- because its freshness genuinely cannot be determined
(a tampered receipt's recorded base sha is not trustworthy input to a drift
comparison, and its tree may not have moved at all). The integrity failure is
NAMED in the reason string and the receipt is never dropped, but the verdict it
sinks the sweep to is UNKNOWN (exit 2), not FAILED (exit 1). That is weaker than
`receipt-bundle.py`, which is the correct tool for the integrity question. Run
both; this one answers only "still true of the tree?".

Nothing here re-implements hashing, receipt parsing, verification, or the walk.
`verify()` (autonomy/lib/proof-verify.py) is the single source of truth for the
drift signal, and `find_receipts()` (tools/receipt-bundle.py) is the single
definition of the walk.

Usage:
    tools/evidence-freshness.py [directory] [--json] [--repo-dir DIR]

Exit codes (the repo-wide convention, tests/test_tool_exit_contract.py):

    0   every receipt found is FRESH
    1   at least one receipt is STALE (checked, and the tree has moved)
    2   nothing stale, but at least one receipt's freshness is UNKNOWN
    3   no receipts found -- nothing to check, which is not a pass
    64  usage error (unknown flag, bad invocation)
    66  the directory to scan does not exist

66 outranks everything. A scan of a directory that is not there measured no
receipts at all, and reporting 3 ("nothing to check") for a mistyped path would
tell an operator their evidence folder is empty when it is merely elsewhere.
"""

import argparse
import importlib.util
import json
import os
import pathlib
import sys

# A stale .pyc for a hyphenated module loaded by path makes mutation probes
# report FALSE results (the probe edits the source, the loader serves the old
# bytecode). Must be set before any loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"
_TOOLS = _ROOT / "tools"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_pv = _load("proof_verify", _LIB / "proof-verify.py")
_rb = _load("receipt_bundle", _TOOLS / "receipt-bundle.py")

verify = _pv.verify
# The walk is imported, never restated. If receipt-bundle learns about a new
# receipt location, this tool learns about it for free.
find_receipts = _rb.find_receipts

FRESH = "FRESH"
STALE = "STALE"
UNKNOWN = "UNKNOWN"
EMPTY = "EMPTY"

# Ordered worst-first. rollup() takes the min index, which IS the weakest-link
# rule: one STALE receipt sinks the sweep no matter how many FRESH surround it.
# STALE outranks UNKNOWN because a proven staleness is a stronger finding than
# an unproven one -- an operator with both should act on the one that is known.
_ORDER = (STALE, UNKNOWN, FRESH)

EXIT = {FRESH: 0, STALE: 1, UNKNOWN: 2, EMPTY: 3}

MISSING_DIR_EXIT = 66


def rollup(states):
    """The sweep verdict: the WEAKEST state present, never an average.

    Any scoring rule -- mean, majority, "90% fresh" -- makes a stale receipt
    cheaper to hide the more fresh ones surround it, which is backwards for a
    freshness report. Empty is its own verdict, not a vacuous pass.
    """
    if not states:
        return EMPTY
    return min(states, key=_ORDER.index)


def freshness_state(proof_path, repo_dir="."):
    """Project ONE receipt onto (state, reason), keeping UNKNOWN distinct.

    This deliberately does NOT reuse receipt-bundle.receipt_state(): that
    classifier folds drift together with hash/gpg/headline failures into a
    single FAILED, which destroys the FRESH/STALE distinction this tool is for.
    It reads verify()'s drift axes directly instead.

    The integrity axes are still read, but they route to UNKNOWN rather than to
    a freshness verdict. A receipt whose bytes were edited after hashing has an
    untrustworthy recorded base sha, so comparing it to the tree answers nothing
    about freshness -- the honest report is that freshness could not be
    determined, with the integrity problem named. See the module docstring: this
    is not the integrity gate.

    `is` comparisons are load-bearing: diff_drift is three-valued
    (True/False/None) and `if not diff_drift` would read None as "no drift".
    """
    try:
        result = verify(str(proof_path), repo_dir)
    except Exception as exc:  # unreadable, unparseable, wrong shape
        return UNKNOWN, ("freshness could not be determined: the receipt could "
                         "not be loaded or verified: %s" % exc)

    reasons = result.get("reasons") or []
    detail = reasons[0] if reasons else (result.get("reason") or "")

    # Integrity first. A receipt that fails these is not evidence about the tree
    # at all, so no freshness claim can be made from it in either direction.
    if not result.get("hash_ok"):
        return UNKNOWN, ("freshness undeterminable: the recorded integrity hash "
                         "does not match the receipt bytes, so its recorded "
                         "base sha cannot be trusted as a comparison point "
                         "(run receipt-bundle.py -- this is an integrity "
                         "finding, not a staleness one). %s" % detail).strip()
    if result.get("gpg_ok") is False:
        return UNKNOWN, ("freshness undeterminable: the gpg signature does not "
                         "verify, so the recorded facts cannot be trusted as a "
                         "comparison point (run receipt-bundle.py). "
                         "%s" % detail).strip()
    if result.get("headline_consistent") is False:
        return UNKNOWN, ("freshness undeterminable: the headline disagrees with "
                         "the recorded facts, so the receipt is internally "
                         "inconsistent (run receipt-bundle.py). "
                         "%s" % detail).strip()

    # Now the freshness axes proper.
    drift = result.get("diff_drift")
    tree_drift = result.get("tree_drift")
    recorded_tree = (result.get("tree_recheck") or {}).get("recorded")

    if drift is None:
        return UNKNOWN, (detail or "the recorded diff could not be re-derived "
                         "here, so freshness is unknown -- re-run from the "
                         "repository this receipt was generated in")
    if drift is True:
        return STALE, (detail or "the recorded diff no longer matches the "
                       "repository: the tree has moved since this evidence was "
                       "written")
    if recorded_tree and tree_drift is None:
        # A tree digest was recorded but could not be recomputed. The diff axis
        # passed, but a receipt that binds exact file content and cannot have
        # that content re-checked is not proven fresh.
        return UNKNOWN, (detail or "the recorded final workspace tree digest "
                         "could not be re-derived, so content freshness is "
                         "unknown even though the diff stat matched")
    if tree_drift is True:
        return STALE, (detail or "the recorded workspace tree digest no longer "
                       "matches: file content changed since this evidence was "
                       "written")
    return FRESH, ""


def scan(directory, repo_dir="."):
    """Classify every receipt under `directory`. Pure: no writes, no network."""
    paths = find_receipts(directory)

    receipts = []
    for path in paths:
        state, reason = freshness_state(path, repo_dir)
        receipts.append({"path": str(path), "state": state, "reason": reason})

    verdict = rollup([r["state"] for r in receipts])
    counts = {s: sum(1 for r in receipts if r["state"] == s) for s in _ORDER}

    return {
        "report": "loki-evidence-freshness/v1",
        "directory": os.path.abspath(str(directory)),
        "checked_from": os.path.abspath(repo_dir),
        "receipts": receipts,
        "counts": counts,
        "stale": [{"path": r["path"], "reason": r["reason"]}
                  for r in receipts if r["state"] == STALE],
        # Carried as its OWN list, never merged into stale[]. An operator acts
        # on these differently: stale means regenerate, unknown means find out.
        "unknown": [{"path": r["path"], "reason": r["reason"]}
                    for r in receipts if r["state"] == UNKNOWN],
        "verdict": verdict,
        "summary": _summary(verdict, receipts, counts),
    }


def _summary(verdict, receipts, counts):
    if verdict == EMPTY:
        return ("EMPTY -- no receipts found under this directory, so no "
                "evidence was checked. Zero receipts is not a fresh sweep.")
    n = len(receipts)
    if verdict == FRESH:
        return ("FRESH -- all %d receipts still describe the current tree" % n)
    if verdict == STALE:
        return ("STALE -- %d of %d receipts no longer describe the current "
                "tree (%d fresh, %d unknown). Regenerate the stale ones; the "
                "sweep is only as current as its oldest receipt."
                % (counts[STALE], n, counts[FRESH], counts[UNKNOWN]))
    return ("UNKNOWN -- %d of %d receipts could not be checked for freshness "
            "(%d fresh, 0 proven stale). Nothing was shown to be out of date, "
            "and the sweep is not complete: an absent measurement is not a "
            "verdict." % (counts[UNKNOWN], n, counts[FRESH]))


def _render(report):
    lines = ["Evidence freshness: %s" % report["directory"], ""]
    for r in report["receipts"]:
        lines.append("  %-8s %s" % (r["state"], r["path"]))
        if r["reason"]:
            lines.append("           %s" % r["reason"])
    if report["receipts"]:
        lines.append("")
    c = report["counts"]
    lines.append("%d fresh, %d stale, %d unknown"
                 % (c[FRESH], c[STALE], c[UNKNOWN]))
    lines.append("")
    lines.append(report["summary"])
    return "\n".join(lines)


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo's convention 2 means "could NOT be checked" -- a real answer
    about the subject. A mistyped flag is not that: it is an error about the
    INVOCATION, and nothing about the subject was examined. The two call for
    opposite responses, since retrying cannot fix a typo.

    argparse exits 2 for every usage error unless this is overridden, so every
    tool needs it. tests/test_tool_exit_contract.py asserts it.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def main(argv=None):
    ap = _Parser(
        prog="evidence-freshness.py",
        description="Report which evidence receipts still describe the "
                    "current tree.")
    ap.add_argument("directory", nargs="?", default=".",
                    help="directory of receipts to scan (default: .)")
    ap.add_argument("--json", action="store_true", help="emit the raw record")
    ap.add_argument("--repo-dir", default=".",
                    help="repository the receipts are re-checked against")
    args = ap.parse_args(argv)

    # Checked BEFORE the scan, and kept distinct from an empty result. A
    # directory that is not there measured nothing; reporting 3 ("nothing to
    # check") would tell an operator their evidence folder is empty when it is
    # merely somewhere else.
    if not os.path.isdir(args.directory):
        msg = ("no such directory: %s -- nothing was scanned, so no freshness "
               "claim is made about anything" % args.directory)
        print(json.dumps({"verdict": "MISSING", "directory": args.directory,
                          "summary": msg}, indent=2)
              if args.json else "MISSING -- %s" % msg)
        return MISSING_DIR_EXIT

    report = scan(args.directory, args.repo_dir)
    print(json.dumps(report, indent=2) if args.json else _render(report))
    return EXIT[report["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
