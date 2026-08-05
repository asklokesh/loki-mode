#!/usr/bin/env python3
"""What does verification COST, and how often does it change the answer?

WHY THIS EXISTS. tools/gate-log.py made verdicts durable and tools/gate-trend.py
says whether the gate is improving or going blind. Both answer questions about
the gate's OUTPUT. Neither answers what the gate costs to run, and that is now
the load-bearing question: verification here is adaptive scaffolding whose
mandated trajectory is toward near-zero overhead, applied selectively where
calibrated confidence is low and bypassed where it is high.

Neither half of that mandate can be validated without a baseline. "Make it
cheaper" needs a current cost. "Bypass it where confidence is high" needs to
know how often running it changed an outcome at all -- because a gate that never
changes an outcome is pure tax, and a gate that frequently does is buying
something real. This file computes both from the log that already exists.

WHAT THIS IS NOT. It is not a gate. It never blocks, never returns a
merge-blocking exit code, and adds no new artifact format. It reads a log
written by other tools and reports two numbers. Verification machinery is
exactly what this must not become; it exists to make the existing machinery
measurable so it can be shrunk or skipped.

THE HONESTY RULE THIS INHERITS. A missing duration is not a duration of zero.
Entries that carry no timing are counted and reported as UNTIMED rather than
folded into the average as zeros, because averaging an absent measurement toward
zero manufactures exactly the "verification is already free" conclusion this
tool exists to test. An empty log reports NO DATA, never "0.0s, looks cheap".
"""

import argparse
import json
import os
import sys

# The repo-wide exit convention, enforced by tests/test_tool_exit_contract.py.
# COULD_NOT_CHECK was 4 here, which is not in the convention at all: a CI
# caller branching on 2 would have read "could not check" as an unrecognised
# code and fallen through to its default arm.
OK = 0
COULD_NOT_CHECK = 2
NO_DATA = 3
USAGE_ERROR = 64
INPUT_MISSING = 66

# Keys a duration may plausibly appear under. The verify evidence doc carries
# run_started_at/run_completed_at; a future writer may record an explicit
# duration. Accept either rather than mandating one shape.
DURATION_KEYS = ("duration_s", "duration_seconds", "elapsed_s")
START_KEYS = ("run_started_at", "started_at")
END_KEYS = ("run_completed_at", "completed_at", "ended_at")

# A verdict that blocks. Anything here means the gate CHANGED the outcome:
# without it the change would have proceeded.
BLOCKING = {"BLOCKED", "FAIL", "FAILED", "BLOCK"}


def _parse_iso(value):
    """Return epoch seconds, or None. None means unknown, never zero."""
    if not isinstance(value, str) or not value:
        return None
    import datetime
    text = value.strip().replace("Z", "+00:00")
    try:
        return datetime.datetime.fromisoformat(text).timestamp()
    except (ValueError, TypeError):
        return None


def _first(mapping, keys):
    for key in keys:
        if key in mapping and mapping[key] is not None:
            return mapping[key]
    return None


def duration_of(entry):
    """Seconds this verification took, or None if the entry never recorded it.

    Checked in two ways because two writers exist: an explicit duration field,
    or a start/end pair as the verify evidence document carries. A negative or
    non-numeric result is discarded as unknown rather than trusted.
    """
    verdict = entry.get("verdict")
    sources = [entry]
    if isinstance(verdict, dict):
        sources.append(verdict)
        produced = verdict.get("produced_by")
        if isinstance(produced, dict):
            sources.append(produced)

    for src in sources:
        if not isinstance(src, dict):
            continue
        explicit = _first(src, DURATION_KEYS)
        if isinstance(explicit, (int, float)) and explicit >= 0:
            return float(explicit)

    for src in sources:
        if not isinstance(src, dict):
            continue
        start = _parse_iso(_first(src, START_KEYS))
        end = _parse_iso(_first(src, END_KEYS))
        if start is not None and end is not None and end >= start:
            return end - start
    return None


def verdict_string(entry):
    """The verdict label, wherever this writer happened to put it."""
    verdict = entry.get("verdict")
    if isinstance(verdict, str):
        return verdict.upper()
    if isinstance(verdict, dict):
        for key in ("verdict", "status", "result"):
            value = verdict.get(key)
            if isinstance(value, str):
                return value.upper()
    category = entry.get("category")
    return category.upper() if isinstance(category, str) else ""


def changed_outcome(entry):
    """Did running the gate change what would otherwise have happened?

    Only a blocking verdict changes an outcome. A pass means the change would
    have shipped either way, so the time spent verifying bought information but
    not a different result. This is the hit rate that justifies the tax.
    """
    return verdict_string(entry) in BLOCKING


def read_log(path):
    """Every line. Corrupt lines counted, never silently dropped."""
    entries, corrupt = [], 0
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                corrupt += 1
                continue
            if isinstance(obj, dict):
                entries.append(obj)
            else:
                corrupt += 1
    return entries, corrupt


def summarize(entries, corrupt):
    """Two numbers and the honesty around them.

    total_s and mean_s are computed over TIMED entries only, and untimed is
    reported alongside so a reader can see how much of the log the average
    actually covers. An average over 2 of 200 runs is not a baseline.
    """
    timed = [d for d in (duration_of(e) for e in entries) if d is not None]
    changed = sum(1 for e in entries if changed_outcome(e))
    total = len(entries)
    return {
        "runs": total,
        "timed": len(timed),
        "untimed": total - len(timed),
        "corrupt": corrupt,
        "total_s": round(sum(timed), 3) if timed else None,
        "mean_s": round(sum(timed) / len(timed), 3) if timed else None,
        "max_s": round(max(timed), 3) if timed else None,
        "changed_outcome": changed,
        "hit_rate": round(changed / total, 4) if total else None,
    }


def render(summary):
    lines = ["VERIFICATION TAX", ""]
    runs = summary["runs"]
    lines.append("  runs logged        %d" % runs)

    if summary["timed"]:
        lines.append("  timed              %d of %d" % (summary["timed"], runs))
        lines.append("  total time         %.1fs" % summary["total_s"])
        lines.append("  mean per run       %.2fs" % summary["mean_s"])
        lines.append("  slowest run        %.2fs" % summary["max_s"])
    else:
        lines.append("  timed              0 of %d" % runs)
        lines.append("  total time         UNKNOWN (no entry carried timing)")
        lines.append("  mean per run       UNKNOWN")

    if summary["untimed"]:
        lines.append("  UNTIMED            %d run(s) carry no duration; excluded"
                     % summary["untimed"])
        lines.append("                     from the averages above, NOT counted as 0s")

    lines.append("")
    if summary["hit_rate"] is None:
        lines.append("  outcome changed    UNKNOWN")
    else:
        lines.append("  outcome changed    %d of %d runs (%.1f%%)" % (
            summary["changed_outcome"], runs, summary["hit_rate"] * 100))
        lines.append("                     a pass would have shipped anyway; only a")
        lines.append("                     block changed what happened")

    if summary["corrupt"]:
        lines.append("")
        lines.append("  CORRUPT            %d unreadable line(s), counted not dropped"
                     % summary["corrupt"])

    lines.append("")
    if summary["timed"] and summary["hit_rate"] == 0:
        lines.append("  READ: every logged run passed. On this sample the tax bought")
        lines.append("  information but changed no outcome -- the case for applying it")
        lines.append("  selectively rather than universally.")
    elif not summary["timed"]:
        lines.append("  READ: cost is UNMEASURED. No claim that verification is cheap")
        lines.append("  or expensive can be made from this log until writers record")
        lines.append("  timing. Absence of a number is not a small number.")
    return "\n".join(lines)


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo's convention 2 means "could NOT be checked" -- a real
    answer about the subject. A mistyped flag is not that; it is an error
    about the INVOCATION, and reporting it as 2 tells a CI caller that the
    axis was evaluated and found unevaluable, when in fact nothing was
    examined at all.

    argparse defaults to 2 for every usage error, so a tool that does not
    override this silently emits the wrong code. This one did: `--bogus`
    exited 2 and a missing positional exited 2.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(USAGE_ERROR)


def main(argv=None):
    parser = _Parser(
        description="Measure what verification costs and how often it "
                    "changed an outcome. Reports only; never blocks.")
    parser.add_argument("log", help="JSONL log (e.g. from tools/gate-log.py)")
    parser.add_argument("--json", action="store_true",
                        help="emit the summary as JSON")
    args = parser.parse_args(argv)

    if not os.path.exists(args.log):
        # 66, not COULD_NOT_CHECK. "The path you named does not exist" is a
        # fact about the INPUT; "I could not evaluate" is a fact about the
        # subject. A caller retrying on 2 would retry forever against a
        # typo, while 66 says the argument itself is wrong.
        sys.stderr.write("verification-tax: no such log: %s\n" % args.log)
        return INPUT_MISSING
    try:
        entries, corrupt = read_log(args.log)
    except OSError as exc:
        sys.stderr.write("verification-tax: could not read %s: %s\n"
                         % (args.log, exc))
        return COULD_NOT_CHECK

    if not entries and not corrupt:
        sys.stderr.write("verification-tax: log is empty; NO DATA\n")
        return NO_DATA

    summary = summarize(entries, corrupt)
    if args.json:
        sys.stdout.write(json.dumps(summary, sort_keys=True, indent=2) + "\n")
    else:
        sys.stdout.write(render(summary) + "\n")
    return OK


if __name__ == "__main__":
    sys.exit(main())
