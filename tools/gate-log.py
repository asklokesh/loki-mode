#!/usr/bin/env python3
"""One gate verdict is a fact. A hundred of them is a pattern. Keep them.

WHY THIS EXISTS. tools/ci-gate.py decides one run correctly and exits 0/1/2,
and tools/gate-report.py renders that one run for a human. Both are amnesiac by
design: they answer "is THIS merge safe" and then forget. But the questions an
engineer actually asks about a merge gate are historical ones --

    which policy blocks us most often, and is it getting better or worse?
    how long has the receipt axis been blind?

-- and nothing in this repo could answer them, because no verdict was ever
written down. So a durable append-only JSONL log, and a report over it.

THE RULE THIS FILE INHERITS, and the reason it is not just a counter:

    A POLICY THAT COULD NOT BE EVALUATED HAS NOT PASSED.

An aggregator is where that rule dies, and it dies by arithmetic rather than by
argument. Two lines of code make it die:

    passes = total - failures            # folds UNEVALUABLE into pass
    rate = passes / total                # a "94% pass rate" built on blindness

Both read as reasonable. Both convert "we were blind on the receipt axis for
three weeks" into a healthy-looking green number, and the longer the blindness
lasts the healthier the number looks, because a blind axis never fails. So
UNEVALUABLE is its OWN category here, counted and printed beside PASS and FAIL,
and there is no derived pass-rate anywhere in this file. Three counts, stated.

A CORRUPT LINE IS DATA. The obvious loop skips lines that do not parse, and a
skipped line is a verdict that silently left the record. A log half-eaten by a
crashed writer would then report a clean history of whatever survived. Corrupt
lines are counted and reported as their own category, so "12 records, 4 of them
unreadable" can never render as "12 records".

AN EMPTY LOG IS NOT A CLEAN HISTORY. `report` on zero records exits non-zero
and says UNKNOWN. "No blocks recorded" and "never blocked" are opposite facts
about the world, and the first one is what an empty file means. Absent is not
zero -- this repo has paid for that inversion on more than a dozen surfaces.

MALFORMED STDIN IS AN ERROR, NEVER AN ASSUMED PASS. `record` reading garbage
writes nothing and exits 66. The one thing it must never do is invent a PASS
row, because the log is the evidence every later report is built from, and a
fabricated row is indistinguishable from a real one forever after.

But note the SPLIT, because over-strictness here is its own dishonesty: input
that is not JSON at all is an error and is refused, while a well-formed verdict
carrying a state word we do not recognise is RECORDED as UNEVALUABLE. The gate
did run and did report something; we simply cannot read its verdict, and that
is exactly what UNEVALUABLE means. Dropping it would delete the evidence that
our own vocabulary drifted.

WHY APPEND-ONLY, SINGLE WRITE. One `open(..., "a")` and one `write()` of one
line that already ends in a newline. No read-modify-write, so two CI jobs
finishing together cannot lose each other's verdict, and nothing this tool does
can edit or remove a verdict already recorded. A log a tool can rewrite is not
evidence.

WHAT IS DELIBERATELY NOT HERE. No cost figure. ci-gate's JSON carries no
measured cost, and recovering one by parsing the dollar amount out of
cost-guard's human-readable reason string would restate a predicate that
autonomy/lib/efficiency_cost.py owns -- the exact drift this repo fixed across
four surfaces. No cost surface is better than a re-derived one.

Usage:
  tools/ci-gate.py <ws> --max-usd 5 --json | tools/gate-log.py record
  tools/gate-log.py report [--json]

Exit: record 0 on write, 66 on unusable stdin. report 0 all-pass, 1 a FAIL was
recorded, 2 an UNEVALUABLE or corrupt record (blind outranks failed), 3 the log
exists but holds no records, 66 the log file does not exist, 64 usage error.
"""

import argparse
import datetime
import json
import os
import sys

PASSED, FAILED, COULD_NOT_CHECK, NOTHING, USAGE, MISSING = 0, 1, 2, 3, 64, 66

DEFAULT_LOG = os.path.join(".loki", "gate-log.jsonl")

# THE ONE MAPPING from a gate's verdict word to a bucket in the report. Three
# buckets, never two. Folding "UNEVALUABLE" in with "PASS" here is the entire
# defect this file exists to prevent, and it is a one-word edit, which is why
# tests/test_gate_log.py mutates precisely this line.
_CATEGORY = {"PASS": "pass", "FAIL": "fail", "UNEVALUABLE": "unevaluable"}

# Corrupt is not a verdict a gate can emit; it is what a damaged log line
# becomes. Kept out of _CATEGORY so no state word can ever map into it.
_CORRUPT = "corrupt"

_ORDER = ["pass", "fail", "unevaluable", _CORRUPT]

# Weakest link, same precedence ci-gate uses: blind outranks failed. An
# operator who sees 1, fixes the cost and re-runs is still blind on the dead
# axis, so the exit code must surface the blindness first.
_EXIT_FOR = {"pass": PASSED, "fail": FAILED,
             "unevaluable": COULD_NOT_CHECK, _CORRUPT: COULD_NOT_CHECK}


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error. Here 2 means "could not check".

    A mistyped flag would otherwise be indistinguishable from a gate reporting
    that it was blind, and a CI job branching on the code would treat an
    operator's typo as a real finding about the merge. 64 is the convention.
    Subparsers inherit this class from the top-level parser, so `record
    --bogus` lands on 64 too.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("gate-log: %s\n" % message)
        raise SystemExit(USAGE)


def classify(verdict):
    """Bucket ONE gate verdict. Anything unrecognised is unevaluable.

    Never returns "pass" by default. A default of pass is how an aggregator
    launders every shape it did not anticipate into green, and the shapes it
    did not anticipate are precisely the broken ones.
    """
    if not isinstance(verdict, dict):
        return _CATEGORY["UNEVALUABLE"]
    state = verdict.get("state")
    if isinstance(state, str) and state.upper() in _CATEGORY:
        return _CATEGORY[state.upper()]
    return _CATEGORY["UNEVALUABLE"]


def failing_policies(verdict):
    """Policy names this verdict recorded as FAIL. Only FAIL, never blind ones.

    An unevaluable policy is not a failing policy: naming it in the
    most-failing tally would send an engineer to fix a rule that never fired,
    while the real problem is that its instrumentation is dead. The unevaluable
    tally is reported separately for that reason.
    """
    rows = verdict.get("policies") if isinstance(verdict, dict) else None
    out = []
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            state = row.get("state")
            if isinstance(state, str) and state.upper() == "FAIL":
                out.append(str(row.get("policy") or "?"))
    return out


def _entry(verdict):
    """The line that gets appended. Timestamp ours, verdict theirs, verbatim.

    The raw verdict is embedded whole rather than summarised, so a later reader
    who needs a field this version never thought about can still recover it.
    Summarising at write time is a one-way loss.
    """
    return {
        "recorded_at": datetime.datetime.now(
            datetime.timezone.utc).replace(microsecond=0).isoformat(),
        "category": classify(verdict),
        "failing_policies": failing_policies(verdict),
        "verdict": verdict,
    }


def append_record(path, verdict):
    """One open, one write, one line. No read-modify-write, ever."""
    parent = os.path.dirname(os.path.abspath(path))
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)
    line = json.dumps(_entry(verdict), sort_keys=True) + "\n"
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(line)
    return line


def _io_error(action, path, exc):
    """An unreachable log is "could not check", never "checked and failed".

    Without this an OSError escapes as a traceback and Python exits 1, which in
    this convention claims the gate was evaluated and FAILED. A permission
    error is not a finding about a merge.
    """
    sys.stderr.write("gate-log: could not %s %s: %s\n" % (action, path, exc))
    return COULD_NOT_CHECK


def read_log(path):
    """Every line, corrupt ones INCLUDED as their own category.

    Returns (entries, corrupt_count). A corrupt line that is merely skipped is
    a verdict deleted from the record by the reader, and the resulting report
    describes a history that never happened.
    """
    entries, corrupt = [], 0
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            if not raw.strip():
                continue  # a trailing newline is not a damaged record
            try:
                entry = json.loads(raw)
            except ValueError:
                corrupt += 1
                continue
            if not isinstance(entry, dict):
                corrupt += 1
                continue
            entries.append(entry)
    return entries, corrupt


def _category_of(entry):
    """An entry's bucket, re-derived from its verdict if it lacks one.

    Trusting a stored "category" blindly would let a hand-edited log assert
    anything; falling back to the embedded verdict keeps the raw evidence
    authoritative. An entry with neither is unevaluable, not a pass.
    """
    stored = entry.get("category")
    # Deliberately _CATEGORY.values() and not _ORDER: "corrupt" is in _ORDER
    # but is not a verdict any gate can emit. Honouring a stored "corrupt"
    # would add to the count of lines this reader actually failed to parse,
    # and the buckets would then no longer sum to the record total.
    if isinstance(stored, str) and stored in _CATEGORY.values():
        return stored
    return classify(entry.get("verdict"))


def summarize(entries, corrupt):
    """Counts, the most frequently failing policy, and the trend.

    Every bucket is pre-seeded to 0, so a MEASURED zero survives as 0 and is
    reported as 0. That is not cosmetic: "fail: 0" over 40 records is a real
    finding, and it must not be confused with the UNKNOWN this returns when
    there are no records at all.
    """
    counts = dict((name, 0) for name in _ORDER)
    counts[_CORRUPT] = corrupt
    policy_hits = {}
    sequence = []
    for entry in entries:
        category = _category_of(entry)
        counts[category] = counts.get(category, 0) + 1
        sequence.append(category)
        for name in failing_policies(entry.get("verdict")):
            policy_hits[name] = policy_hits.get(name, 0) + 1

    total = len(entries) + corrupt
    return {
        "records": total,
        "readable": len(entries),
        "counts": counts,
        "top_failing_policy": _top_policy(policy_hits),
        "policy_failures": policy_hits,
        "trend": _trend(sequence),
    }


def _top_policy(policy_hits):
    """The most frequently failing policy, or a MEASURED "none".

    None means unknown; the string "none" with zero failures is a measurement
    -- we read the records and no policy failed. Collapsing those two would
    make an empty log and a clean history read identically.
    """
    if not policy_hits:
        return None
    best = max(sorted(policy_hits), key=lambda name: policy_hits[name])
    return {"policy": best, "failures": policy_hits[best]}


def _trend(sequence):
    """Healthier, worse, or steady over the two halves. UNKNOWN under 2.

    A single record has no trend. Reporting "steady" from one data point is an
    invented measurement, so this returns None and the report prints UNKNOWN.
    "Not blocked" counts pass only: an unevaluable half is not an improving
    half, which is the same folding error the counts refuse to make.
    """
    if len(sequence) < 2:
        return None
    half = len(sequence) // 2
    older, newer = sequence[:half], sequence[half:]
    before = sum(1 for c in older if c == "pass") / float(len(older))
    after = sum(1 for c in newer if c == "pass") / float(len(newer))
    if after > before:
        direction = "improving"
    elif after < before:
        direction = "worsening"
    else:
        direction = "steady"
    return {"direction": direction, "older_pass_rate": round(before, 3),
            "newer_pass_rate": round(after, 3),
            "window": [len(older), len(newer)]}


def render(summary):
    counts = summary["counts"]
    lines = ["gate-log: %d record(s)" % summary["records"], ""]
    for name in _ORDER:
        label = name if name != "unevaluable" \
            else "unevaluable (NOT a pass)"
        lines.append("  %-26s %d" % (label, counts.get(name, 0)))
    lines.append("")
    top = summary["top_failing_policy"]
    if summary["readable"] == 0:
        # Every line was unreadable. "no policy failed" would be a measurement
        # we never took: we read nothing, so we know nothing about failures.
        lines.append("most failing policy: UNKNOWN -- no readable record")
    elif top is None:
        lines.append("most failing policy: none -- no FAIL in %d readable "
                     "record(s)" % summary["readable"])
    else:
        lines.append("most failing policy: %s (%d failure(s))"
                     % (top["policy"], top["failures"]))
    trend = summary["trend"]
    if trend is None:
        lines.append("trend: UNKNOWN -- fewer than 2 readable records (%d)"
                     % summary["readable"])
    else:
        lines.append("trend: %s (pass rate %.0f%% -> %.0f%% over %d then %d "
                     "record(s))"
                     % (trend["direction"], trend["older_pass_rate"] * 100,
                        trend["newer_pass_rate"] * 100,
                        trend["window"][0], trend["window"][1]))
    return "\n".join(lines)


def exit_code(summary):
    """Weakest link over the whole history. Blind and corrupt outrank failed."""
    worst = PASSED
    counts = summary["counts"]
    for name in _ORDER:
        if counts.get(name, 0):
            worst = max(worst, _EXIT_FOR[name])
    return worst


def _cmd_record(args):
    raw = sys.stdin.read()
    if not raw.strip():
        sys.stderr.write(
            "gate-log: empty stdin -- expected a ci-gate --json verdict. "
            "Nothing to record is not a pass, so nothing was written.\n")
        return MISSING
    try:
        verdict = json.loads(raw)
    except ValueError as exc:
        sys.stderr.write(
            "gate-log: could not parse the gate verdict (%s). Refusing to "
            "record: an invented row is indistinguishable from a real one.\n"
            % exc)
        return MISSING
    if not isinstance(verdict, dict):
        sys.stderr.write(
            "gate-log: expected a JSON object from ci-gate, got %s. Nothing "
            "was written.\n" % type(verdict).__name__)
        return MISSING
    try:
        line = append_record(args.file, verdict)
    except OSError as exc:
        return _io_error("write", args.file, exc)
    entry = json.loads(line)
    sys.stderr.write("gate-log: recorded %s to %s\n"
                     % (entry["category"], args.file))
    return PASSED


def _cmd_report(args):
    if not os.path.exists(args.file):
        sys.stderr.write(
            "gate-log: no log at %s -- UNKNOWN, not a clean history. A gate "
            "that was never recorded is not a gate that never blocked.\n"
            % args.file)
        return MISSING
    try:
        entries, corrupt = read_log(args.file)
    except OSError as exc:
        return _io_error("read", args.file, exc)
    if not entries and not corrupt:
        sys.stderr.write(
            "gate-log: %s holds no records -- UNKNOWN. An empty log must "
            "never read as 'never blocked'.\n" % args.file)
        return NOTHING
    summary = summarize(entries, corrupt)
    if args.as_json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print(render(summary))
    return exit_code(summary)


def main(argv=None):
    ap = _Parser(description="Append ci-gate verdicts to a durable log and "
                             "report the pattern.")
    subs = ap.add_subparsers(dest="command")
    for name, help_text in (("record", "append a ci-gate --json verdict read "
                                       "from stdin"),
                            ("report", "summarise the recorded verdicts")):
        sub = subs.add_parser(name, help=help_text)
        sub.add_argument("--file", default=DEFAULT_LOG,
                         help="JSONL log path (default: %s)" % DEFAULT_LOG)
        if name == "report":
            sub.add_argument("--json", action="store_true", dest="as_json",
                             help="emit the summary as JSON")
    args = ap.parse_args(argv)
    if args.command == "record":
        return _cmd_record(args)
    if args.command == "report":
        return _cmd_report(args)
    # No subcommand. Not a verdict about anything, so it is a usage error --
    # exiting 0 here would let `gate-log.py` alone read as a clean gate.
    ap.error("a subcommand is required: record or report")


if __name__ == "__main__":
    sys.exit(main())
