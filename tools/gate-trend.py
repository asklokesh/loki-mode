#!/usr/bin/env python3
"""Is the merge gate getting better, getting worse, or going BLIND?

WHY THIS EXISTS. tools/gate-log.py made the verdicts durable and reports the
totals. Totals answer "how have we done", which is the wrong question for a
gate. The question an engineer asks before trusting a merge is directional:

    is this gate improving, or is it quietly degrading?

gate-log's own trend field compares two halves on one axis, the pass rate. That
is enough to say "healthier" or "worse", and it is deliberately not enough to
say WHY, because on one axis the two ways a gate degrades are indistinguishable.
This file separates them, because they call for opposite responses.

THE DISTINCTION THIS TOOL IS FOR:

    a rising FAIL rate    = the gate is doing its job, and the code is worse
    a rising UNEVALUABLE  = the gate is going BLIND, and knows nothing at all

The second is more urgent and reads as less urgent, which is how it survives. A
failing gate is loud: someone is blocked, someone investigates. A blind gate is
silent and its numbers look BETTER the longer it stays blind, because an axis
that cannot be evaluated can never fail. Three weeks of blindness on the receipt
axis renders as a falling failure rate, which is indistinguishable from three
weeks of improvement. So GOING BLIND outranks WORSENING in the verdict here: an
operator told only "worsening" fixes the failures, re-runs, sees the failure
rate drop, and is still blind.

THE ARITHMETIC THAT KILLS THIS, and the reason there is no subtraction below:

    unevaluable = total - passes - failures
    pass_rate   = 1 - fail_rate

Both are natural, both fold the third category into one of the other two, and
both are the exact defect gate-log.py's header names. Every rate here is counted
from its OWN bucket over the shared denominator. Nothing is derived by
complement, so no category can absorb another's mass.

FEWER THAN 2 RECORDS IS NOT "FLAT". Flat is a claim about change over time and
needs two points to make. One record reports INSUFFICIENT DATA and exits
non-zero, because this is a gate: saying "I cannot establish a trend" while
exiting 0 tells CI the trend axis was checked and was fine.

A CORRUPT LINE IS COUNTED, NEVER SKIPPED. Skipping is how a log half-eaten by a
crashed writer reports a clean history of whatever survived. Corrupt lines get
their own count, are included in the window and the denominator, and force the
blind exit code, since a line we could not read is a verdict we do not have.

AN EMPTY LOG EXITS 3, NOT 0. "No verdicts recorded" and "no verdict ever
blocked" are opposite facts. Absent is not zero.

WHAT IS DELIBERATELY NOT HERE: any cost figure, and therefore no use of
record_is_measured() from autonomy/lib/efficiency_cost.py. gate-log rows carry
no measured cost by design (see its "WHAT IS DELIBERATELY NOT HERE"), and
recovering one by parsing a policy's human-readable reason string would restate
a predicate efficiency_cost.py owns. That drift is what this repo fixed across
four surfaces. No cost surface beats a re-derived one, so this tool reports
categories only.

Usage:
  tools/gate-trend.py [--file .loki/gate-log.jsonl] [--window N] [--json]

Exit: 0 improving or steady with every record readable and passing-or-failing
cleanly, 1 a genuine regression in the FAIL rate, 2 could not evaluate (the
gate is blind: unevaluable or corrupt records present, or fewer than 2 records
to compare), 3 the log exists but holds no records, 64 usage error, 66 no log
file at that path.
"""

import argparse
import json
import os
import sys

sys.dont_write_bytecode = True

PASSED, FAILED, COULD_NOT_CHECK, NOTHING, USAGE, MISSING = 0, 1, 2, 3, 64, 66

DEFAULT_LOG = os.path.join(".loki", "gate-log.jsonl")

# THE ONE MAPPING from a recorded verdict word to a bucket. Three buckets,
# never two. Folding the blind bucket into the passing one is the whole defect
# this file exists to prevent, and it is a one-word edit -- which is exactly
# what tests/test_gate_trend.py mutates.
_CATEGORY = {"PASS": "pass", "FAIL": "fail", "UNEVALUABLE": "unevaluable"}

# Not a verdict any gate can emit; what a damaged line becomes. Kept out of
# _CATEGORY so no recorded state word can ever map into it.
_CORRUPT = "corrupt"

_ORDER = ["pass", "fail", "unevaluable", _CORRUPT]

# A category that means the history itself is unreadable on that record. Both
# force the blind exit: a verdict we could not read is a verdict we do not have.
_BLIND = ("unevaluable", _CORRUPT)


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error. Here 2 means "could not check".

    A mistyped flag would otherwise be indistinguishable from this gate
    reporting that it was blind, and a CI job branching on the code would treat
    an operator's typo as a real finding about the merge. 64 is the convention.
    It also means a stray positional is an ERROR rather than something read as
    a log path: receipt-attest once read `--help` as a proof path and issued a
    verdict about it.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("gate-trend: %s\n" % message)
        raise SystemExit(USAGE)


def classify(verdict):
    """Bucket ONE recorded verdict. Anything unrecognised is unevaluable.

    Never defaults to "pass". A default of pass is how an aggregator launders
    every shape it did not anticipate into green, and the shapes it did not
    anticipate are precisely the broken ones.
    """
    if not isinstance(verdict, dict):
        return _CATEGORY["UNEVALUABLE"]
    state = verdict.get("state")
    if isinstance(state, str) and state.upper() in _CATEGORY:
        return _CATEGORY[state.upper()]
    return _CATEGORY["UNEVALUABLE"]


def category_of(entry):
    """A log entry's bucket, re-derived from its verdict when it lacks one.

    Trusting a stored "category" blindly would let a hand-edited log assert
    anything; the embedded verdict stays authoritative. An entry with neither is
    unevaluable, not a pass. Deliberately checks _CATEGORY.values() and not
    _ORDER, so a stored "corrupt" cannot inflate the count of lines this reader
    actually failed to parse.
    """
    if not isinstance(entry, dict):
        return _CATEGORY["UNEVALUABLE"]
    stored = entry.get("category")
    if isinstance(stored, str) and stored in _CATEGORY.values():
        return stored
    return classify(entry.get("verdict"))


def read_categories(path):
    """Every line in order, as a list of buckets. Corrupt lines INCLUDED.

    A corrupt line that is merely skipped is a verdict deleted from the record
    by the reader, and the resulting trend describes a history that never
    happened. Returning it in sequence also keeps it inside --window, so a
    window cannot launder corruption by sliding past it.
    """
    out = []
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            if not raw.strip():
                continue  # a trailing newline is not a damaged record
            try:
                entry = json.loads(raw)
            except ValueError:
                out.append(_CORRUPT)
                continue
            if not isinstance(entry, dict):
                out.append(_CORRUPT)
                continue
            out.append(category_of(entry))
    return out


def _rates(seq):
    """One rate per bucket, each counted from its OWN members.

    No complement, no subtraction from the total. `unevaluable = 1 - pass` is
    the one line that would make a blind gate look healthy, so every rate is
    an independent count over the shared denominator.
    """
    n = float(len(seq))
    return dict((name, sum(1 for c in seq if c == name) / n) for name in _ORDER)


def analyse(seq):
    """Split the window in half and compare each category's rate independently.

    Returns a summary whose "direction" is None -- UNKNOWN, never "flat" --
    when there are fewer than 2 records. Flat is a claim about change, and one
    point cannot support it.
    """
    counts = dict((name, sum(1 for c in seq if c == name)) for name in _ORDER)
    blind = sum(counts[name] for name in _BLIND)
    summary = {
        "records": len(seq),
        "counts": counts,
        "blind_records": blind,
        "direction": None,
        "older": None,
        "newer": None,
        "window": None,
    }
    if len(seq) < 2:
        return summary

    half = len(seq) // 2
    older, newer = _rates(seq[:half]), _rates(seq[half:])
    summary["older"] = older
    summary["newer"] = newer
    summary["window"] = [half, len(seq) - half]

    # PRECEDENCE. Blindness first: a gate that cannot evaluate has not passed,
    # and its failure rate falls precisely because it is blind. Reporting
    # "improving" off a falling failure rate while the blind rate climbs is the
    # inversion this tool exists to make impossible.
    blind_older = older["unevaluable"] + older[_CORRUPT]
    blind_newer = newer["unevaluable"] + newer[_CORRUPT]
    if blind_newer > blind_older:
        summary["direction"] = "going_blind"
    elif blind_newer:
        # Blind and getting less blind is STILL BLIND, never "improving". A
        # gate 75% unable to evaluate, printing "IMPROVING -- fewer blocked or
        # blind runs than before", is the same inversion as the rising case
        # wearing a recovery story: the headline an operator reads says the
        # thing is getting better while most of its axes report nothing. The
        # exit code alone is not enough here, because the human reads the word.
        summary["direction"] = "still_blind"
    elif newer["fail"] > older["fail"]:
        summary["direction"] = "worsening"
    elif newer["fail"] < older["fail"] or blind_newer < blind_older:
        summary["direction"] = "improving"
    else:
        summary["direction"] = "steady"
    summary["blind_rate_older"] = blind_older
    summary["blind_rate_newer"] = blind_newer
    return summary


def exit_code(summary):
    """Weakest link. Blind outranks failed, and INSUFFICIENT DATA is blind.

    A gate exiting 0 while its own output says it could not establish a trend
    tells CI the axis was checked and was fine. There is no reading of "fewer
    than 2 records" that earns a green.
    """
    if summary["blind_records"]:
        return COULD_NOT_CHECK
    if summary["direction"] is None:
        return COULD_NOT_CHECK
    if summary["direction"] == "worsening":
        return FAILED
    return PASSED


_HEADLINE = {
    "going_blind": "GOING BLIND -- the unevaluable rate is RISING. This is "
                   "more urgent than a rising failure rate: a gate that "
                   "cannot evaluate can never fail, so blindness renders as "
                   "improvement.",
    "still_blind": "STILL BLIND -- the unevaluable rate fell but is NOT zero. "
                   "Less blind is not sighted: the remaining blind runs "
                   "checked nothing, so this is not an improvement to report.",
    "worsening": "WORSENING -- the failure rate is rising. The gate is "
                 "working; the code getting to it is worse.",
    "improving": "IMPROVING -- fewer blocked or blind runs than before.",
    "steady": "STEADY -- no measured change in either rate.",
}


def render(summary):
    counts = summary["counts"]
    lines = ["gate-trend: %d record(s) in window" % summary["records"], ""]
    for name in _ORDER:
        label = {"unevaluable": "unevaluable (NOT a pass)",
                 _CORRUPT: "corrupt (counted, not skipped)"}.get(name, name)
        lines.append("  %-30s %d" % (label, counts[name]))
    lines.append("")
    if summary["direction"] is None:
        lines.append(
            "trend: INSUFFICIENT DATA -- %d record(s), 2 needed to compare. "
            "Not flat: flat is a claim about change." % summary["records"])
        return "\n".join(lines)
    lines.append("trend: %s" % _HEADLINE[summary["direction"]])
    lines.append("")
    older, newer = summary["older"], summary["newer"]
    lines.append("  %-14s %8s -> %8s" % ("rate", "older", "newer"))
    for name in _ORDER:
        lines.append("  %-14s %7.0f%% -> %7.0f%%"
                     % (name, older[name] * 100, newer[name] * 100))
    lines.append("")
    lines.append("  window: %d older then %d newer record(s)"
                 % (summary["window"][0], summary["window"][1]))
    if summary["blind_records"]:
        lines.append(
            "  NOTE: %d record(s) could not be evaluated or read. Those are "
            "counted here and are neither passes nor failures."
            % summary["blind_records"])
    return "\n".join(lines)


def main(argv=None):
    ap = _Parser(
        description="Report whether the merge gate is improving, worsening, "
                    "or going blind over its recorded verdicts.")
    # No positional argument, deliberately. A stray path then lands on
    # _Parser.error() -> 64, so a mistyped invocation can never be read as a
    # log to judge.
    ap.add_argument("--file", default=DEFAULT_LOG,
                    help="JSONL log written by gate-log.py (default: %s)"
                         % DEFAULT_LOG)
    ap.add_argument("--window", type=int, default=None,
                    help="compare only the most recent N records")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the summary as JSON")
    args = ap.parse_args(argv)

    # `is None` and never falsy: --window 0 is a value an operator typed, and
    # swallowing it as "not given" would silently analyse the whole log while
    # the operator believes a window is in force.
    if args.window is not None and args.window < 2:
        ap.error("--window must be at least 2: fewer than 2 records cannot "
                 "establish a trend")

    if not os.path.exists(args.file):
        sys.stderr.write(
            "gate-trend: no log at %s -- UNKNOWN, not a clean history. A gate "
            "whose verdicts were never recorded is not a gate that never "
            "blocked.\n" % args.file)
        return MISSING
    try:
        seq = read_categories(args.file)
    except OSError as exc:
        # An unreachable log is "could not check", never "checked and failed".
        sys.stderr.write("gate-trend: could not read %s: %s\n"
                         % (args.file, exc))
        return COULD_NOT_CHECK

    if not seq:
        sys.stderr.write(
            "gate-trend: %s holds no records -- nothing to trend. An empty log "
            "must never read as 'never blocked'.\n" % args.file)
        return NOTHING

    if args.window is not None:
        seq = seq[-args.window:]

    summary = analyse(seq)
    if args.as_json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(render(summary))
    return exit_code(summary)


if __name__ == "__main__":
    sys.exit(main())
