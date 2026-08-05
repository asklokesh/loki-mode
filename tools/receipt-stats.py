#!/usr/bin/env python3
"""Summarise an archive of receipts: how many, how verified, what they cost.

WHY THIS EXISTS. receipt-bundle.py rolls an archive into ONE verdict for a
compliance reviewer, and receipt-find.py returns the individual runs matching a
filter. Neither answers the question an operator asks first: what IS this
archive. How many receipts, how many actually verified, what did the whole
thing cost, and over what span. Answering that by eye means opening every
proof.json; answering it with `jq | paste | awk` is how the cost figure gets
quietly wrong, because every ad-hoc pipeline gets it wrong in the same
direction -- toward a smaller, tidier, more confident number.

THE RULES. Each is a specific way a summary can claim more than it measured.

1. AN UNMEASURED COST IS EXCLUDED FROM EVERY COST STATISTIC, AND THE EXCLUSION
   IS COUNTED. A receipt that never recorded cost did not cost $0. Summing it
   as 0 understates the total by exactly the spend nobody captured, and does
   something worse to the MEDIAN: nulls read as 0 cluster at the bottom of the
   sorted list and drag the midpoint down, so an archive of expensive runs with
   broken instrumentation reports a cheap median. That is the defect this
   codebase paid for on four surfaces (v8.51.0-v8.54.0) and it is sharpest
   here, because a median is the one statistic where adding fake low values
   changes the answer without changing any real one.

   The predicate is record_is_measured() in autonomy/lib/efficiency_cost.py,
   reached through receipt-diff.py's measured_cost(), which already maps the
   receipt's `cost.usd` onto the per-iteration `cost_usd` key that predicate
   reads. A second copy of either half is how the honesty rule drifts, so
   there is not one in this file.

   Measured is necessary but not sufficient: record_is_measured is true when
   ANY of five fields is non-zero, so a receipt with tokens and a null `usd` is
   honestly measured and still carries no dollar figure. Both are required --
   see _usd().

2. NOTHING MEASURED READS UNKNOWN, NEVER $0.00. When no receipt in the archive
   carried a cost, the total and the median are absent facts, not zero ones.
   The count of measured receipts decides this, never the total -- `if not
   total` would erase a real, measured $0.0000 archive, which is rule 2 failing
   in the opposite direction and just as untrue.

3. A MEASURED ZERO SURVIVES AS ZERO. A run that genuinely cost $0.00 is an
   observation. `is None` throughout, never truthiness: the two ways to be
   dishonest about cost are to invent a number and to discard one.

4. A MALFORMED RECEIPT IS COUNTED AND NAMED, NEVER SILENTLY SKIPPED. A summary
   that drops what it cannot read reports a tidier archive than exists, and
   does it invisibly. Note this bucket is kept SEPARATE from UNVERIFIABLE:
   receipt_state() folds an unloadable receipt into UNVERIFIABLE, which is
   right for a verdict and wrong for a census -- "this file is not JSON" and
   "this receipt cannot be re-derived outside its repo" are different facts
   with different fixes.

5. ZERO RECEIPTS IS NOT A CLEAN ARCHIVE. "We summarised an archive and it was
   empty" is not a finding; it is an invocation pointed at the wrong directory.
   It gets its own exit code and says so in words.

WHAT THIS IS NOT. This is an ADVISOR, not a gate, and the distinction is
deliberate and pinned by tests/test_tool_exit_contract.py.

  - A FAILED receipt in the archive does NOT make this exit 1. The census
    reports the count; receipt-bundle.py is the gate that refuses to merge on
    it. Re-deriving the weakest-link rule here would be a second copy of a
    verdict predicate, which is the exact drift the rules above warn about.

  - An archive where NOTHING measured cost still exits 0. "Every receipt is
    present and readable, and none of them recorded a cost" is a complete,
    successful, honest answer to the question asked -- the output says UNKNOWN
    in words. Forcing it non-zero would make the honest answer look like a tool
    failure, and train operators to ignore it.

Verdict classification is receipt_state() from receipt-bundle.py, which wraps
verify() from autonomy/lib/proof-verify.py. Nothing here re-implements it.

Usage:
    tools/receipt-stats.py [workspace] [--repo-dir DIR] [--json]

Exit codes:
    0   receipts were found and summarised
    3   the workspace exists but holds no receipts -- nothing to summarise
    64  usage error (unknown flag, bad argument)
    66  the workspace path does not exist
"""

import argparse
import datetime
import importlib.util
import json
import os
import pathlib
import sys

# A stale .pyc can mask a mutation and turn a real probe into a false
# "MUTATION SURVIVED", since invalidation is mtime+size and a restore is
# byte-identical. Set before the loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# receipt_state() wraps verify() and already keeps VERIFIED / FAILED /
# UNVERIFIABLE apart with the `is`-comparisons that make that correct
# (gpg_ok is the truthy string "n/a"; diff_drift None means unverifiable, not
# clean). measured_cost() reuses record_is_measured() AND maps cost.usd ->
# cost_usd. Both are imported rather than restated.
_rb = _load("receipt_bundle", _ROOT / "tools" / "receipt-bundle.py")
receipt_state = _rb.receipt_state
measured_cost = _rb.measured_cost

VERIFIED = _rb.VERIFIED
UNVERIFIABLE = _rb.UNVERIFIABLE
FAILED = _rb.FAILED

MALFORMED = "MALFORMED"

# Reported in this order every time, so two runs are diffable. MALFORMED is
# last because it is a census bucket, not one of receipt_state's verdicts.
_BUCKETS = (VERIFIED, FAILED, UNVERIFIABLE, MALFORMED)


def _usd(proof):
    """The receipt's cost in dollars, or None when there is no such number.

    None means UNMEASURED, and every caller must exclude rather than
    substitute. Returning 0.0 here is rule 1 -- it would both understate the
    total and drag the median toward the bottom of the range.
    """
    rec = measured_cost(proof)
    if rec is None:
        return None
    return rec.get("cost_usd")


def _date(proof):
    """The receipt's UTC date as YYYY-MM-DD, or None.

    Sliced, not parsed. generated_at ends in "Z", which datetime.fromisoformat
    rejects before Python 3.11, and this tool must behave identically on every
    interpreter it runs under. ISO dates compare correctly as strings, so a
    slice is both the portable answer and the smaller one.
    """
    v = proof.get("generated_at")
    if not isinstance(v, str) or len(v) < 10:
        return None
    d = v[:10]
    try:
        datetime.date.fromisoformat(d)
    except ValueError:
        return None
    return d


def median(values):
    """The midpoint of `values`, or None when there is nothing to take it of.

    Takes only what it was given. The caller is responsible for having already
    excluded unmeasured receipts -- passing 0.0 for an absent measurement is
    rule 1, and it corrupts this function's answer silently because 0.0 is a
    perfectly valid cost.
    """
    if not values:
        return None
    s = sorted(values)
    n = len(s)
    mid = n // 2
    if n % 2:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2.0


def find_receipts(workspace):
    """Every proof.json under the workspace, sorted for a stable report.

    ponytail: same rglob as receipt-bundle.find_receipts, so a receipt archived
    outside .loki/proofs/ is still counted. Not imported, because that one
    assumes the directory exists and this tool must tell a missing workspace
    (exit 66) apart from an empty one (exit 3).
    """
    root = pathlib.Path(workspace)
    if not root.is_dir():
        return []
    return sorted(p for p in root.rglob("proof.json") if p.is_file())


def stats(workspace, repo_dir="."):
    """Summarise every receipt under `workspace`. Pure: no writes, no network."""
    paths = find_receipts(workspace)

    receipts = []
    malformed = []
    costs = []
    dates = []

    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as f:
                proof = json.load(f)
            if not isinstance(proof, dict):
                raise ValueError("receipt is not a JSON object")
        except Exception as exc:
            # Rule 4: counted and NAMED, with the reason, in its own bucket.
            # Never dropped, and never folded into UNVERIFIABLE -- unreadable
            # bytes and an unre-derivable diff have different fixes.
            malformed.append({"path": str(path), "reason": str(exc)})
            # Same keys as every other row, `reason` included. A consumer
            # reading receipts[i]["reason"] must not KeyError on exactly the
            # rows rule 4 exists to surface.
            receipts.append({
                "path": str(path), "state": MALFORMED, "reason": str(exc),
                "cost_usd": None, "date": None,
            })
            continue

        state, reason = receipt_state(path, repo_dir)

        usd = _usd(proof)
        if usd is not None:
            costs.append(usd)

        date = _date(proof)
        if date is not None:
            dates.append(date)

        receipts.append({
            "path": str(path), "state": state, "reason": reason,
            "cost_usd": usd, "date": date,
        })

    # len(costs), NOT sum(costs), decides UNKNOWN. Rules 2 and 3 in one line:
    # an archive of three receipts that each genuinely measured $0.0000 has a
    # real total of 0.0 and a real median of 0.0, and `if not total` would
    # report both as UNKNOWN -- erasing a measurement is the same dishonesty as
    # inventing one, pointed the other way.
    measured_n = len(costs)
    cost_block = {
        "measured_receipts": measured_n,
        "unmeasured_receipts": len(receipts) - measured_n,
        "total_usd": sum(costs) if measured_n else None,
        "median_usd": median(costs),
    }

    counts = {b: sum(1 for r in receipts if r["state"] == b) for b in _BUCKETS}

    return {
        "report": "loki-receipt-stats/v1",
        "workspace": os.path.abspath(str(workspace)),
        "checked_from": os.path.abspath(repo_dir),
        "receipts": receipts,
        "receipt_count": len(receipts),
        "counts": counts,
        "cost": cost_block,
        "dates": {
            "first": min(dates) if dates else None,
            "last": max(dates) if dates else None,
            "dated_receipts": len(dates),
        },
        "malformed": malformed,
        "malformed_count": len(malformed),
        "summary": _summary(len(receipts), counts, cost_block, dates),
    }


def _cost_line(cost):
    """The cost figures, each carrying the basis it was computed from."""
    # Either signal absent means UNKNOWN. The count and the figures should
    # never disagree, and when they do this must still render an honest
    # sentence rather than raise inside %.4f -- a renderer that crashes on the
    # unknown path is a surface with no honest state at all.
    if (cost["measured_receipts"] == 0
            or cost["total_usd"] is None or cost["median_usd"] is None):
        # Phrased off the data, never a hardcoded "0 of N". This branch is
        # reachable with measured_receipts > 0 (a figure went missing without
        # the count going with it), and a file arguing that a summary must not
        # claim more than it measured cannot ship a sentence that can state a
        # false count.
        return ("cost UNKNOWN -- no usable cost figure across %d receipt(s) "
                "(%d measured), so there is no total and no median. "
                "Not $0.00: unmeasured is not free."
                % (cost["measured_receipts"] + cost["unmeasured_receipts"],
                   cost["measured_receipts"]))
    line = ("total $%.4f, median $%.4f across %d measured receipt(s)"
            % (cost["total_usd"], cost["median_usd"],
               cost["measured_receipts"]))
    if cost["unmeasured_receipts"]:
        line += (". %d receipt(s) EXCLUDED from both figures: cost was never "
                 "measured, and summing an absent measurement as 0 would "
                 "understate the total and drag the median down"
                 % cost["unmeasured_receipts"])
    return line


def _date_line(dates):
    """The span, or UNKNOWN. An absent range is never rendered as a real one."""
    if not dates:
        return "date range UNKNOWN -- no receipt carried a readable generated_at"
    return "%s to %s across %d dated receipt(s)" % (
        min(dates), max(dates), len(dates))


def _summary(n, counts, cost, dates):
    if n == 0:
        # Rule 5. Distinct in words from "we summarised an empty archive".
        return ("NO RECEIPTS -- no proof.json found under this workspace, so "
                "there was nothing to summarise. Zero receipts is not a clean "
                "archive; it is most often the wrong directory.")
    head = "%d receipt(s): %s." % (
        n, ", ".join("%d %s" % (counts[b], b) for b in _BUCKETS if counts[b]))
    head += " Cost: %s." % _cost_line(cost)
    head += " Dates: %s." % _date_line(dates)
    return head


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error; here 2 means "could not check".

    A mistyped flag would otherwise be indistinguishable from a blind gate --
    the operator sees the code that means "your instrumentation is broken" and
    goes looking for broken instrumentation. 64 is the usage error.

    error() only. --help routes through exit(), not error(), and overriding
    exit() would break the exit-0 contract that test_tool_exit_contract.py
    asserts for every tool's --help.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def main(argv=None):
    ap = _Parser(
        description="Summarise an archive of receipts: how many, how "
                    "verified, what they cost.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace holding the receipts (default: .)")
    ap.add_argument("--repo-dir", default=".",
                    help="repository the receipts are verified against "
                         "(default: .)")
    ap.add_argument("--json", action="store_true",
                    help="emit the full report as JSON")
    args = ap.parse_args(argv)

    if not os.path.isdir(args.workspace):
        # 66, not 3. "You pointed me at nothing" and "this archive is empty"
        # are different facts, and only one of them is about the archive.
        sys.stderr.write(
            "receipt-stats: workspace does not exist: %s\n" % args.workspace)
        return 66

    report = stats(args.workspace, args.repo_dir)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        # "-" for an unmeasured cost, never "$0.0000". The table is the surface
        # an operator eyeballs, and it must not be the one place the archive
        # looks free.
        reasons = {b["path"]: b["reason"] for b in report["malformed"]}
        for r in report["receipts"]:
            usd = "-" if r["cost_usd"] is None else "$%.4f" % r["cost_usd"]
            line = "%-13s %-10s %s" % (r["state"], usd, r["path"])
            if r["path"] in reasons:
                line += "  (%s)" % reasons[r["path"]]
            print(line)
        print("")
        print(report["summary"])

    return 0 if report["receipt_count"] else 3


if __name__ == "__main__":
    sys.exit(main())
