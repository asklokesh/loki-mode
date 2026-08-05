#!/usr/bin/env python3
"""Verify an EXPLICIT LIST of receipts, one verdict per line.

WHY THIS EXISTS, GIVEN receipt-bundle.py ALREADY SHIPS. receipt-bundle walks a
workspace: it answers "is everything under this tree sound". That is the right
question for an archive and the WRONG question for a pull request, because its
input is discovered rather than declared. A PR touches a known, enumerable set
of receipts, and the difference is not cosmetic:

    A receipt that should have been in the set, but is not on disk, is
    INVISIBLE to a walker and NAMED by a list.

The walker cannot report an absence. `rglob("proof.json")` over a tree missing
the one receipt that mattered returns the others and reports VERIFIED on them,
truthfully, while the reviewer reads that verdict as covering the receipt they
asked about. The list route is handed the expected paths, so a path that does
not exist is a COUNTED, NAMED result (rule 4) rather than a silent shortfall.

That is the whole feature. Everything else here is deliberately NOT new:

    receipt_state()  three-state per-receipt classifier   \\  imported from
    rollup()         weakest-link aggregation             /   receipt-bundle.py
    verify()         the actual verification              -- proof-verify.py

Re-deriving any of them would be the drift this codebase has paid for
repeatedly: the honesty rule survives because there is ONE copy of it. If the
classifier gains a fourth failure axis upstream, this tool gains it for free.

THE FOUR STATES, NEVER COLLAPSED:

    VERIFIED      every axis was checked and passed
    FAILED        an axis was checked and said no
    UNVERIFIABLE  an axis could NOT be checked here, with its reason
    MISSING       the path does not exist -- named, counted, never skipped

MISSING is kept distinct from UNVERIFIABLE on purpose. "This receipt could not
be re-checked from this directory" and "this receipt is not there" have
different remedies: the first is re-run from the right repo, the second is a
receipt that was never generated or was deleted. Folding the second into the
first sends the operator looking for a directory problem that does not exist.
Both are non-passing, so no green leaks either way.

ROLLUP IS WEAKEST-LINK, NEVER AN AVERAGE. One FAILED sinks the batch no matter
how many VERIFIED surround it. Any scoring rule -- mean, majority, "90% or
better" -- makes a bad receipt cheaper to hide the more good ones are added,
which is exactly backwards for a gate.

AN EMPTY LIST IS NOT A PASS. Verifying nothing and finding nothing wrong are
different facts. `receipt-verify-batch.py` with no paths, or `--stdin` fed an
empty pipe, exits 3: nothing was checked, so nothing is certified. A CI job
whose glob silently matched zero files must not read as green.

Exit codes (the repo-wide convention, see tests/test_tool_exit_contract.py):

    0   every listed receipt VERIFIED
    1   at least one receipt FAILED
    2   nothing failed, but at least one receipt was UNVERIFIABLE
    3   the list was empty -- nothing to check
    64  usage error (unknown flag, bad invocation)
    66  at least one listed path does not exist

66 outranks 1 and 2. An absent receipt means the SET this batch was asked about
is not the set it checked, so every other verdict here is a statement about a
different question than the one asked. Fix the input before reading the output.
"""

import argparse
import importlib.util
import json
import os
import pathlib
import sys

# A stale .pyc for a hyphenated module loaded by path makes mutation probes
# report FALSE failures (the probe edits the source, the loader serves the old
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


# The three-state classifier and the weakest-link rule are imported, never
# restated. receipt-bundle.py is the single definition of both.
_rb = _load("receipt_bundle", _TOOLS / "receipt-bundle.py")
_pv = _load("proof_verify", _LIB / "proof-verify.py")

receipt_state = _rb.receipt_state
measured_cost = _rb.measured_cost

VERIFIED = _rb.VERIFIED
FAILED = _rb.FAILED
UNVERIFIABLE = _rb.UNVERIFIABLE
EMPTY = _rb.EMPTY
MISSING = "MISSING"

# Ordered worst-first. rollup() takes the min index, which IS the weakest-link
# rule. MISSING sits at the worst end: a set that is not the set we were asked
# about invalidates the batch, it does not average out against it.
_ORDER = (MISSING, FAILED, UNVERIFIABLE, VERIFIED)

EXIT = {VERIFIED: 0, FAILED: 1, UNVERIFIABLE: 2, EMPTY: 3, MISSING: 66}


def rollup(states):
    """The batch verdict: the WEAKEST state present, never an average.

    Empty is its own verdict (EMPTY), not a vacuous pass. A batch of zero
    receipts has not been audited, and "we found nothing wrong" is a claim
    nobody is entitled to make about a set they never opened.
    """
    if not states:
        return EMPTY
    return min(states, key=_ORDER.index)


def check_one(path, repo_dir="."):
    """Classify ONE listed path into (state, reason).

    A path that does not exist returns MISSING with its own name in the reason,
    rather than being dropped from the list. This is the branch rule 4 is
    about and the one the walker route structurally cannot have.
    """
    p = pathlib.Path(path)
    if not p.exists():
        return MISSING, ("no such receipt: %s -- listed for verification but "
                         "not present on disk" % path)
    if p.is_dir():
        # A directory is a plausible typo for the receipt inside it. Say which
        # one we could not read rather than letting verify() raise something
        # about bytes.
        return MISSING, ("not a receipt file: %s is a directory" % path)
    return receipt_state(str(p), repo_dir)


def batch(paths, repo_dir="."):
    """Verify exactly the listed receipts. Pure: no writes, no network."""
    receipts = []
    total = 0.0
    measured_n = 0

    for path in paths:
        state, reason = check_one(path, repo_dir)
        entry = {"path": str(path), "state": state, "reason": reason,
                 "cost_usd": None}

        # Cost is read regardless of verdict, but only a MEASURED cost
        # contributes. measured_cost() returns None when the block is absent,
        # malformed, or all-zero.
        if state != MISSING:
            try:
                cost = measured_cost(_pv._load_proof(str(path)))
            except Exception:
                cost = None
            # `is not None`, never truthiness: a genuinely measured $0.00 is a
            # real observation and must survive as 0.0.
            if cost is not None and cost.get("cost_usd") is not None:
                entry["cost_usd"] = cost["cost_usd"]
                total += cost["cost_usd"]
                measured_n += 1

        receipts.append(entry)

    verdict = rollup([r["state"] for r in receipts])

    # measured_n, NOT the total, decides UNKNOWN. Receipts that each genuinely
    # measured $0.00 sum to 0.0, and `if not total` would erase that into
    # "unmeasured" -- the exact defect four surfaces already shipped.
    cost_block = {
        "measured_receipts": measured_n,
        "total_receipts": len(receipts),
        "total_usd": total if measured_n else None,
    }

    not_verified = [r for r in receipts if r["state"] != VERIFIED]

    return {
        "batch": "loki-receipt-verify-batch/v1",
        "checked_from": os.path.abspath(repo_dir),
        "receipts": receipts,
        "counts": {s: sum(1 for r in receipts if r["state"] == s)
                   for s in _ORDER},
        "cost": cost_block,
        "not_verified": [
            {"path": r["path"], "state": r["state"], "reason": r["reason"]}
            for r in not_verified
        ],
        "missing": [r["path"] for r in receipts if r["state"] == MISSING],
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
        return ("EMPTY -- no receipts were listed, so nothing was checked. "
                "Verifying nothing is not a pass.")
    n = len(receipts)
    miss = sum(1 for r in receipts if r["state"] == MISSING)
    bad = sum(1 for r in receipts if r["state"] == FAILED)
    unv = sum(1 for r in receipts if r["state"] == UNVERIFIABLE)
    if verdict == MISSING:
        head = ("MISSING -- %d of %d listed receipts are not on disk; the set "
                "checked is not the set asked about" % (miss, n))
    elif verdict == FAILED:
        head = ("FAILED -- %d of %d receipts FAILED verification; the batch is "
                "only as good as its weakest receipt" % (bad, n))
    elif verdict == UNVERIFIABLE:
        head = ("UNVERIFIABLE -- %d of %d receipts could not be checked here; "
                "nothing failed, but the batch is not proven" % (unv, n))
    else:
        head = "VERIFIED -- all %d listed receipts verified" % n
    return head + ". " + _cost_line(cost)


def _render(report):
    """One verdict per line, which is the surface a reviewer reads."""
    lines = []
    for r in report["receipts"]:
        lines.append("%-13s %s" % (r["state"], r["path"]))
        if r["reason"]:
            lines.append("              %s" % r["reason"])
    if report["receipts"]:
        lines.append("")
    if report["not_verified"]:
        lines.append("Not verified (%d) -- counted, never dropped:"
                     % len(report["not_verified"]))
        for r in report["not_verified"]:
            lines.append("  %s [%s]" % (r["path"], r["state"]))
        lines.append("")
    lines.append(_cost_line(report["cost"]))
    lines.append("")
    lines.append(report["summary"])
    return "\n".join(lines)


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error, and 2 here means COULD NOT CHECK.

    Left at the default, a mistyped flag would report the same code as a gate
    that ran and found itself blind -- a typo masquerading as an honest
    inability. 64 is the usage code, and it is distinct precisely so an
    operator can tell "I invoked this wrong" from "this could not evaluate".
    """

    def error(self, message):
        self.exit(64, "usage error: %s\n" % message)


def main(argv=None):
    ap = _Parser(
        prog="receipt-verify-batch.py",
        description="Verify an explicit list of receipts, one verdict per line.")
    ap.add_argument("paths", nargs="*",
                    help="receipt paths (proof.json) to verify")
    ap.add_argument("--stdin", action="store_true",
                    help="read receipt paths from stdin, one per line")
    ap.add_argument("--json", action="store_true", help="emit the raw record")
    ap.add_argument("--repo-dir", default=".",
                    help="repository the receipts are re-checked against")
    args = ap.parse_args(argv)

    paths = list(args.paths)
    if args.stdin:
        paths += [ln.strip() for ln in sys.stdin.read().splitlines()
                  if ln.strip()]

    report = batch(paths, args.repo_dir)
    print(json.dumps(report, indent=2) if args.json else _render(report))
    return EXIT[report["verdict"]]


if __name__ == "__main__":
    sys.exit(main())
