#!/usr/bin/env python3
"""What did a VERIFIED outcome cost, versus a failed one?

WHY THIS EXISTS. receipt-stats.py answers "what IS this archive": how many
receipts, how many verified, what the whole thing cost. It reports ONE cost
figure across every receipt regardless of verdict. That answers the accounting
question and not the one a team actually asks when deciding whether the trust
layer pays for itself:

    Is a run that ends VERIFIED cheaper or more expensive than one that ends
    FAILED, and what are we paying for the runs we cannot verify at all?

Those three numbers are a different report from one blended average, and the
blended average actively hides the answer. An archive whose failures cost 5x
its successes and an archive where every run costs the same produce the SAME
total and the SAME overall median. Splitting by verdict class is the entire
product here; everything else is bookkeeping to keep the split honest.

THE HONESTY RULES. Each is a specific way a per-class average can claim more
than it measured, and each is sharper here than in a single-figure summary,
because a class is a SMALL sample. One fake zero folded into a total of forty
receipts moves it slightly. One fake zero folded into the three receipts that
happened to FAIL moves that class's average by a third.

1. AN UNMEASURED RECEIPT IS EXCLUDED FROM EVERY AVERAGE, AND THE EXCLUSION IS
   COUNTED PER CLASS. A receipt that never recorded cost did not cost $0. It
   is dropped from the mean and the total for its class, and the count of what
   was dropped is reported ON THE SAME ROW -- an average over 2 of 11 FAILED
   receipts is not wrong, but shown without that ratio it reads as the cost of
   failing, which it is not.

   The predicate is record_is_measured() in autonomy/lib/efficiency_cost.py,
   reached through receipt-diff.measured_cost() (re-exported by
   receipt-bundle.py), which already maps the receipt's `cost.usd` onto the
   per-iteration `cost_usd` key that predicate reads. Neither half is restated
   here; a second copy is exactly how this rule drifted across four surfaces
   before (v8.51.0-v8.54.0).

   Measured is necessary but NOT sufficient for a dollar figure:
   record_is_measured is true when ANY of five fields is non-zero, so a receipt
   carrying tokens and a null `usd` is honestly measured and still has no
   amount. Both are required -- see _usd().

2. A CLASS WITH NO MEASURED RECEIPTS READS UNKNOWN, AND STILL GETS A ROW.
   Two failures here, and they point opposite ways:

     - Rendering that class as "$0.00" says failing runs are free. They are
       the most expensive thing in the archive; we simply did not measure them.
     - OMITTING the row says no receipt landed in that class at all. "Three
       runs FAILED and none recorded a cost" and "nothing FAILED" are opposite
       facts, and dropping the row turns the first into the second silently.
       So every class in _CLASSES is rendered on every run, with its receipt
       count, whether or not anything in it measured.

   The MEASURED COUNT decides UNKNOWN, never the total. `if not total` would
   erase a class whose receipts each genuinely measured $0.0000 -- rule 1
   failing in the opposite direction, and just as untrue.

3. A MEASURED ZERO SURVIVES AS ZERO. A run that genuinely cost $0.00 is an
   observation, not an absence. `is None` throughout, never truthiness. The
   two ways to lie about cost are to invent a number and to discard one.

4. A MALFORMED RECEIPT IS COUNTED AND NAMED. Kept separate from UNVERIFIABLE,
   for the same reason receipt-stats.py keeps it separate: "this file is not
   JSON" and "this receipt cannot be re-derived here" have different fixes.
   Folding the first into the second inflates the UNVERIFIABLE class with
   files that were never receipts.

5. ZERO RECEIPTS IS NOT A CLEAN ARCHIVE. Exit 3, and say so in words. It is
   most often the wrong directory.

WHAT THIS IS NOT. An ADVISOR, not a gate, and the distinction is pinned by
tests/test_tool_exit_contract.py. A FAILED receipt in the archive does not make
this exit 1 -- receipt-bundle.py is the gate that refuses to merge on that, and
re-deriving the weakest-link rule here would be a second copy of a verdict
predicate. An archive where NOTHING measured cost still exits 0: "every receipt
is readable, and none recorded a cost" is a complete honest answer, and the
output says UNKNOWN in words. Forcing it non-zero would train operators to
ignore a tool that is working correctly.

Usage:
    tools/cost-per-outcome.py [workspace] [--repo-dir DIR] [--json]

Exit codes:
    0   receipts were found and split by verdict class
    3   the workspace exists but holds no receipts -- nothing to split
    64  usage error (unknown flag, bad argument)
    66  the workspace path does not exist
"""

import argparse
import importlib.util
import json
import os
import pathlib
import sys

# A stale .pyc for a hyphenated module loaded by path makes a mutation probe
# report a FALSE survival: the probe edits the source, the loader serves old
# bytecode, invalidation is mtime+size and the restore is byte-identical.
# Must be set before any loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# receipt_state() wraps verify() from autonomy/lib/proof-verify.py and already
# keeps VERIFIED / FAILED / UNVERIFIABLE apart with the `is` comparisons that
# make that correct (gpg_ok is the truthy string "n/a"; diff_drift None means
# unverifiable, not clean). measured_cost() reuses record_is_measured() AND
# maps cost.usd -> cost_usd. Both imported, neither restated.
_rb = _load("receipt_bundle", _ROOT / "tools" / "receipt-bundle.py")
receipt_state = _rb.receipt_state
measured_cost = _rb.measured_cost

VERIFIED = _rb.VERIFIED
FAILED = _rb.FAILED
UNVERIFIABLE = _rb.UNVERIFIABLE
MALFORMED = "MALFORMED"

# Rendered in this order on EVERY run, present or not (rule 2). MALFORMED is
# last because it is a census bucket, not one of receipt_state's verdicts.
_CLASSES = (VERIFIED, FAILED, UNVERIFIABLE, MALFORMED)

OK, NOTHING_TO_CHECK, USAGE, NO_INPUT = 0, 3, 64, 66


def _usd(proof):
    """The receipt's cost in dollars, or None when there is no such number.

    None means UNMEASURED. Every caller must EXCLUDE rather than substitute:
    returning 0.0 here is rule 1, and it would drag its class's average toward
    zero using a value nobody observed.

    Two gates, both required. measured_cost() returning None means the receipt
    recorded no measurement at all. A non-None record can still carry
    cost_usd=None -- tokens moved, dollars were never priced -- and defaulting
    that to 0.0 would invent a measurement out of a receipt proving only that
    work happened.
    """
    rec = measured_cost(proof)
    if rec is None:
        return None
    return rec.get("cost_usd")


def find_receipts(workspace):
    """Every proof.json under the workspace, sorted for a stable report.

    ponytail: same rglob as receipt-bundle.find_receipts, so a receipt archived
    outside .loki/proofs/ is still counted. Not imported, because that one
    assumes the directory exists and this tool must tell a MISSING workspace
    (exit 66) apart from an EMPTY one (exit 3).
    """
    root = pathlib.Path(workspace)
    if not root.is_dir():
        return []
    return sorted(p for p in root.rglob("proof.json") if p.is_file())


def _class_block(costs, receipt_n):
    """One verdict class's cost figures, carrying the basis they came from.

    `len(costs)`, never `sum(costs)`, decides UNKNOWN. Rules 2 and 3 in one
    line: a class of three receipts that each genuinely measured $0.0000 has a
    real total of 0.0 and a real mean of 0.0, and `if not total` would report
    both as UNKNOWN. Erasing a measurement is the same dishonesty as inventing
    one, pointed the other way.
    """
    measured_n = len(costs)
    return {
        "receipts": receipt_n,
        "measured_receipts": measured_n,
        "unmeasured_receipts": receipt_n - measured_n,
        "total_usd": sum(costs) if measured_n else None,
        "mean_usd": (sum(costs) / measured_n) if measured_n else None,
        "min_usd": min(costs) if measured_n else None,
        "max_usd": max(costs) if measured_n else None,
    }


def cost_per_outcome(workspace, repo_dir="."):
    """Join every receipt to its measured cost, split by verdict class.

    Pure: no writes, no network, no subprocess beyond what verify() already
    runs to re-derive a diff.
    """
    receipts = []
    malformed = []
    by_class = {c: [] for c in _CLASSES}   # class -> [measured usd, ...]
    counts = {c: 0 for c in _CLASSES}

    for path in find_receipts(workspace):
        try:
            with open(path, "r", encoding="utf-8") as f:
                proof = json.load(f)
            if not isinstance(proof, dict):
                raise ValueError("receipt is not a JSON object")
        except Exception as exc:
            # Rule 4: counted and NAMED in its own bucket, never dropped and
            # never folded into UNVERIFIABLE. Same keys as every other row so
            # a consumer reading receipts[i]["cost_usd"] does not KeyError on
            # exactly the rows this rule exists to surface.
            malformed.append({"path": str(path), "reason": str(exc)})
            counts[MALFORMED] += 1
            receipts.append({
                "path": str(path), "class": MALFORMED, "reason": str(exc),
                "cost_usd": None,
            })
            continue

        state, reason = receipt_state(path, repo_dir)
        usd = _usd(proof)

        counts[state] += 1
        if usd is not None:
            # `is not None`, never truthiness: a measured 0.0 is an
            # observation and must enter the average as a real data point.
            by_class[state].append(usd)

        receipts.append({
            "path": str(path), "class": state, "reason": reason,
            "cost_usd": usd,
        })

    classes = {c: _class_block(by_class[c], counts[c]) for c in _CLASSES}

    return {
        "report": "loki-cost-per-outcome/v1",
        "workspace": os.path.abspath(str(workspace)),
        "checked_from": os.path.abspath(repo_dir),
        "receipts": receipts,
        "receipt_count": len(receipts),
        "classes": classes,
        "malformed": malformed,
        "malformed_count": len(malformed),
        "comparison": _comparison(classes),
        "summary": _summary(len(receipts), classes),
    }


def _comparison(classes):
    """The headline this tool exists to produce, or why it cannot be produced.

    None on either side means UNKNOWN. A ratio computed against an invented
    zero is the exact lie this file is built to refuse, and a ratio computed
    against a genuine measured 0.0 is a division by zero -- so both are
    refused, in words that say which case it was.
    """
    v = classes[VERIFIED]["mean_usd"]
    f = classes[FAILED]["mean_usd"]
    if v is None or f is None:
        missing = [n for n, m in ((VERIFIED, v), (FAILED, f)) if m is None]
        return {
            "ratio_failed_over_verified": None,
            "note": ("UNKNOWN -- no measured cost for %s, so there is no "
                     "basis to compare what a failure costs against what a "
                     "success costs. Not a ratio of 1.0, and not $0.00."
                     % " and ".join(missing)),
        }
    if v == 0:
        return {
            "ratio_failed_over_verified": None,
            "note": ("UNKNOWN -- measured VERIFIED mean is exactly $0.0000, "
                     "so a ratio is undefined. That zero is real data, not a "
                     "missing measurement."),
        }
    return {
        "ratio_failed_over_verified": f / v,
        "note": ("a FAILED outcome costs %.2fx a VERIFIED one on the measured "
                 "receipts in each class" % (f / v)),
    }


def _amount(value):
    """A dollar figure, or the honest dash. Never "$0.0000" for an absence."""
    return "-" if value is None else "$%.4f" % value


def _class_line(name, block):
    """One rendered row. Emitted for every class whether or not it measured.

    Three distinct states, and collapsing any two is a claim the data does not
    support. "No run ended this way", "runs ended this way and none was
    priced", and "here is what they cost" are three different findings, and the
    first two are the pair a reader most often has to act on.
    """
    if block["receipts"] == 0:
        # Still UNKNOWN, with a DIFFERENT reason clause. "Nothing landed here"
        # is a fact about the archive; "we could not price what landed here" is
        # a fact about the instrumentation, and they have different fixes -- so
        # the clause differs. But the leading word does not: _summary() renders
        # this same class from `mean_usd is None`, and if the row said "none"
        # while the summary said UNKNOWN, one report would carry two words for
        # one class. That drift is the thing this file argues against, so the
        # two surfaces are kept on the same token deliberately.
        figures = ("UNKNOWN (0 of 0 measured) -- no receipt ended with this "
                   "outcome")
    elif block["measured_receipts"] == 0 or block["mean_usd"] is None:
        # Phrased off the data, never a hardcoded count. The second disjunct is
        # reachable with measured_receipts > 0 if a figure went missing without
        # the count going with it, and a tool arguing that a report must not
        # claim more than it measured cannot ship a sentence able to state a
        # false count.
        figures = ("UNKNOWN (%d of %d measured) -- not $0.00: unmeasured is "
                   "not free" % (block["measured_receipts"], block["receipts"]))
    else:
        figures = ("mean %s  total %s  range %s-%s  (%d of %d measured)"
                   % (_amount(block["mean_usd"]), _amount(block["total_usd"]),
                      _amount(block["min_usd"]), _amount(block["max_usd"]),
                      block["measured_receipts"], block["receipts"]))
        if block["unmeasured_receipts"]:
            figures += ("; %d EXCLUDED, cost never measured"
                        % block["unmeasured_receipts"])
    return "%-13s %2d receipt(s)  %s" % (name, block["receipts"], figures)


def _summary(n, classes):
    if n == 0:
        # Rule 5, distinct in words from "we split an empty archive".
        return ("NO RECEIPTS -- no proof.json found under this workspace, so "
                "there was nothing to split by outcome. Zero receipts is not "
                "a clean archive; it is most often the wrong directory.")
    parts = []
    for c in _CLASSES:
        b = classes[c]
        parts.append("%s %d receipt(s) %s"
                     % (c, b["receipts"],
                        "cost UNKNOWN" if b["mean_usd"] is None
                        else "mean %s" % _amount(b["mean_usd"])))
    return "%d receipt(s) split by outcome: %s." % (n, "; ".join(parts))


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error; here 2 means "could not check".

    Those are opposite facts. A mistyped flag would otherwise be
    indistinguishable from blind instrumentation, and an operator would go
    looking for a broken measurement that is really a typo. 64 is the usage
    error.

    error() only. --help routes through exit(), not error(), and overriding
    exit() would break the exit-0 contract test_tool_exit_contract.py asserts
    for every tool's --help.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(USAGE)


def main(argv=None):
    ap = _Parser(
        description="What a VERIFIED outcome cost, versus a failed one.")
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
            "cost-per-outcome: workspace does not exist: %s\n" % args.workspace)
        return NO_INPUT

    report = cost_per_outcome(args.workspace, args.repo_dir)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for c in _CLASSES:
            print(_class_line(c, report["classes"][c]))
        print("")
        print("comparison: %s" % report["comparison"]["note"])
        print(report["summary"])

    return OK if report["receipt_count"] else NOTHING_TO_CHECK


if __name__ == "__main__":
    sys.exit(main())
