#!/usr/bin/env python3
"""What the system prompt COSTS per iteration, split at the cache breakpoint.

WHY THIS EXISTS. Every iteration re-sends the whole prompt. build_prompt.ts
splits it at the literal [CACHE_BREAKPOINT] marker into a cache-stable
<loki_system> prefix (COACHING -- how to work) and a volatile
<dynamic_context> tail (STATE -- which gate failed, what self-heal found), and
sdk_invoker.ts puts cache_control on that split. CLAUDE.md warns that any new
always-on instruction must go in the prefix or it busts the cache every
iteration. Nothing reported what that prefix actually WEIGHS, so the warning
had no number attached to it and the LOKI_SIMPLE ablation had no denominator.

This reads the byte-exact fixture corpus under
loki-ts/tests/fixtures/build_prompt/fixture-*/expected.txt -- the same bytes
the parity job pins -- and reports bytes and estimated tokens for each half.

THE RULES. Each is a specific way this report could claim more than it measured.

1. THE PREFIX IS AN UPPER BOUND ON THE LOKI_SIMPLE SAVING, NEVER THE SAVING.
   This is the sharpest rule in the file and the easiest one to get wrong.

   LOKI_SIMPLE=1 does NOT delete the prefix. At build_prompt.ts:1607 the
   `if (!simple)` block wraps NINE pushes; `<loki_system>`, the PRD anchor, the
   goal-score line and the closing tag survive it. So the prefix is a ceiling.

   Worse, the two obvious numbers to reach for are both wrong for THIS corpus:

     - The source comment at build_prompt.ts:1602 says "Measured on fixture-1:
       8090 -> 1776 bytes, -78%". fixture-1 in this corpus is 7909 bytes. That
       comment does not describe these fixtures; whatever it measured, it was
       not what this tool reads. Lifting -78% here would be reporting someone
       else's measurement as ours.
     - "the prefix is 94%, so LOKI_SIMPLE saves 94%" over-claims by everything
       that survives the strip.

   And NO fixture sets LOKI_SIMPLE (there is no post-ablation output in the
   corpus), so the exact saving is UNMEASURED. It is reported as a bound plus
   the word UNKNOWN, which is the honest pair. Re-deriving the nine-block strip
   list in Python to compute it exactly would be a second copy of the ablation
   predicate, and a second copy is how the rule it encodes drifts.

2. A FIXTURE WITH NO MARKER IS UNKNOWN AND IS EXCLUDED, NEVER COUNTED AS 0.
   fixture-30 and fixture-51 carry no [CACHE_BREAKPOINT]. Their prefix share is
   an absent measurement, not a 0% one. Folding two zeros into a 60-fixture
   mean drags the average toward the bottom without changing any real value --
   the same defect receipt-stats.py rule 1 exists to prevent, transplanted from
   cost to percentage. They are excluded from every aggregate, and the count of
   exclusions is printed in words.

3. AN UNSPLITTABLE CORPUS READS UNKNOWN, NOT 0%. If fixtures were found but
   none carried the marker, there is no aggregate to report. The count of
   SPLIT fixtures decides that, never the byte total -- `if not total` would
   also erase a real, measured empty prompt.

4. ZERO FIXTURES IS NOT A CHEAP PROMPT. Finding nothing to measure is an
   invocation pointed at the wrong directory, and a substring scan over an
   empty listing reports nothing missing. It gets exit 3 and says NOTHING TO
   MEASURE in words rather than printing a tidy 0-byte report.

WHAT THIS IS NOT. An ADVISOR, not a gate -- `_is_gate()` in
tests/test_tool_exit_contract.py does not match this name, deliberately. There
is no prompt size that is a FAILURE, so exit 1 is unreachable here BY DESIGN;
a future reader should not "fix" that by inventing a byte threshold. A budget
belongs in token-guard.py, which is a gate and is named like one.

Usage:
    tools/prompt-cost.py [fixture-dir] [--json] [--bytes-per-token N]

Exit codes:
    0   fixtures were found and measured
    3   the directory exists but holds no fixtures -- nothing to measure
    64  usage error (unknown flag, bad argument)
    66  the fixture directory does not exist
"""

import argparse
import glob
import json
import os
import pathlib
import sys

# A stale .pyc can mask a mutation and turn a real probe into a false
# "MUTATION SURVIVED", since invalidation is mtime+size and a restore is
# byte-identical.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]

# The literal marker build_prompt.ts emits. Matched as bytes-in-text exactly as
# written; this is not a regex and must not become one.
MARKER = "[CACHE_BREAKPOINT]"

DEFAULT_FIXTURES = _ROOT / "loki-ts" / "tests" / "fixtures" / "build_prompt"

# The standard rough estimate. Named, not inlined, because it is an ESTIMATE
# and every figure derived from it is labelled as one -- a real tokenizer would
# disagree, and a number that looks exact invites being quoted as exact.
BYTES_PER_TOKEN = 4


def find_fixtures(fixture_dir):
    """Every expected.txt under fixture-*/, sorted numerically for a stable report.

    Sorted by the fixture NUMBER, so fixture-2 precedes fixture-10. Plain
    lexicographic sort puts fixture-10 second and makes two runs of the report
    diff cleanly but read wrongly.
    """
    root = pathlib.Path(fixture_dir)
    if not root.is_dir():
        return []
    paths = glob.glob(str(root / "fixture-*" / "expected.txt"))

    def key(p):
        name = pathlib.Path(p).parent.name
        tail = name.rsplit("-", 1)[-1]
        return (0, int(tail)) if tail.isdigit() else (1, 0, name)

    return sorted((pathlib.Path(p) for p in paths if os.path.isfile(p)), key=key)


def split_prompt(text):
    """Split at the first MARKER into (prefix, tail) as BYTE counts, or None.

    Returns None when the marker is absent -- rule 2. The caller must exclude
    rather than substitute; returning (0, 0) here would be indistinguishable
    from a genuinely empty prompt.

    Splits on the FIRST occurrence only. A second marker is content of the tail,
    and str.split(MARKER, 1) keeps it there rather than dropping it.
    """
    if MARKER not in text:
        return None
    prefix, tail = text.split(MARKER, 1)
    return len(prefix.encode("utf-8")), len(tail.encode("utf-8"))


def tokens(byte_count, bytes_per_token=BYTES_PER_TOKEN):
    """Estimated tokens. None in, None out -- an unmeasured half has no estimate."""
    if byte_count is None:
        return None
    return byte_count // bytes_per_token


def measure(fixture_dir, bytes_per_token=BYTES_PER_TOKEN):
    """Measure every fixture. Pure: no writes, no network."""
    paths = find_fixtures(fixture_dir)

    rows = []
    unsplit = []
    shares = []

    for path in paths:
        name = path.parent.name
        try:
            text = path.read_text(encoding="utf-8")
        except Exception as exc:
            # Counted and NAMED, never silently dropped. A report that skips
            # what it cannot read describes a tidier corpus than exists.
            unsplit.append({"fixture": name, "reason": str(exc)})
            rows.append({
                "fixture": name, "path": str(path), "total_bytes": None,
                "prefix_bytes": None, "tail_bytes": None,
                "prefix_tokens": None, "tail_tokens": None,
                "prefix_share_pct": None, "reason": str(exc),
            })
            continue

        total = len(text.encode("utf-8"))
        split = split_prompt(text)

        if split is None:
            unsplit.append({"fixture": name, "reason": "no %s marker" % MARKER})
            rows.append({
                "fixture": name, "path": str(path), "total_bytes": total,
                "prefix_bytes": None, "tail_bytes": None,
                "prefix_tokens": None, "tail_tokens": None,
                "prefix_share_pct": None,
                "reason": "no %s marker" % MARKER,
            })
            continue

        prefix_b, tail_b = split
        # The marker's own bytes are the third slice. prefix + marker + tail is
        # the whole file exactly; asserting it here catches a slicing off-by-one
        # that would otherwise hide in the ~0.2% rounding gap between the two
        # reported percentages.
        assert prefix_b + len(MARKER.encode("utf-8")) + tail_b == total, (
            "%s: split does not reconstruct the file" % name)

        share = 100.0 * prefix_b / total if total else None
        if share is not None:
            shares.append(share)

        rows.append({
            "fixture": name, "path": str(path), "total_bytes": total,
            "prefix_bytes": prefix_b, "tail_bytes": tail_b,
            "prefix_tokens": tokens(prefix_b, bytes_per_token),
            "tail_tokens": tokens(tail_b, bytes_per_token),
            "prefix_share_pct": share, "reason": None,
        })

    # len(shares), NOT the byte total, decides UNKNOWN -- rule 3.
    split_n = len(shares)
    prefix_total = sum(r["prefix_bytes"] for r in rows
                       if r["prefix_bytes"] is not None) if split_n else None
    tail_total = sum(r["tail_bytes"] for r in rows
                     if r["tail_bytes"] is not None) if split_n else None

    aggregate = {
        "fixtures": len(rows),
        "split_fixtures": split_n,
        "unsplit_fixtures": len(rows) - split_n,
        "prefix_bytes_total": prefix_total,
        "tail_bytes_total": tail_total,
        "prefix_tokens_total": tokens(prefix_total, bytes_per_token),
        "tail_tokens_total": tokens(tail_total, bytes_per_token),
        # Mean of the per-fixture shares, over SPLIT fixtures only (rule 2).
        "mean_prefix_share_pct": (sum(shares) / split_n) if split_n else None,
    }

    return {
        "report": "loki-prompt-cost/v1",
        "fixture_dir": os.path.abspath(str(fixture_dir)),
        "marker": MARKER,
        "bytes_per_token": bytes_per_token,
        "fixtures": rows,
        "aggregate": aggregate,
        "unsplit": unsplit,
        "unsplit_count": len(unsplit),
        "summary": _summary(aggregate, bytes_per_token),
    }


def _simple_line(agg):
    """What LOKI_SIMPLE=1 would save -- as a BOUND plus UNKNOWN. Rule 1.

    Never prints a savings figure. The prefix is a ceiling (the strip keeps
    <loki_system>, the PRD anchor, the goal-score line and the closing tag), and
    no fixture in this corpus was generated with LOKI_SIMPLE=1, so the actual
    post-ablation size was never observed here.
    """
    if agg["split_fixtures"] == 0 or agg["prefix_tokens_total"] is None:
        return ("LOKI_SIMPLE=1 saving UNKNOWN -- no fixture could be split, so "
                "there is no prefix to bound it with")
    return ("LOKI_SIMPLE=1 saving UNKNOWN -- not measured by this corpus (no "
            "fixture sets LOKI_SIMPLE). BOUND: it strips coaching from the "
            "prefix, so it removes AT MOST the %d prefix bytes (~%d est "
            "tokens) across %d fixture(s), and strictly less in practice "
            "because <loki_system>, the PRD anchor and the closing tag survive "
            "the strip. Not a saving figure: a ceiling."
            % (agg["prefix_bytes_total"], agg["prefix_tokens_total"],
               agg["split_fixtures"]))


def _summary(agg, bytes_per_token):
    if agg["fixtures"] == 0:
        # Rule 4. Distinct in words from "we measured a corpus and it was small".
        return ("NOTHING TO MEASURE -- no fixture-*/expected.txt found under "
                "this directory, so no prompt was read. Zero fixtures is not a "
                "cheap prompt; it is most often the wrong directory.")

    if agg["split_fixtures"] == 0:
        # Rule 3: fixtures were read, none could be split. Real fact, no aggregate.
        head = ("%d fixture(s) read, NONE splittable: not one carried the %s "
                "marker, so the prefix/tail share is UNKNOWN -- not 0%%."
                % (agg["fixtures"], MARKER))
        return head + " " + _simple_line(agg)

    head = ("%d fixture(s): prefix %d bytes (~%d est tokens), tail %d bytes "
            "(~%d est tokens) totalled across %d splittable fixture(s). "
            "Prefix is %.1f%% of the prompt on average (mean of per-fixture "
            "shares); at ~%d bytes/token that prefix is re-sent every "
            "iteration and is what the cache breakpoint exists to hold."
            % (agg["fixtures"], agg["prefix_bytes_total"],
               agg["prefix_tokens_total"], agg["tail_bytes_total"],
               agg["tail_tokens_total"], agg["split_fixtures"],
               agg["mean_prefix_share_pct"], bytes_per_token))

    if agg["unsplit_fixtures"]:
        # Rule 2, stated in words with the count. Phrased off the data so this
        # sentence can never assert a false number.
        head += (" %d fixture(s) EXCLUDED from every aggregate: no %s marker, "
                 "and counting an absent split as 0%% would drag the mean down "
                 "without changing any real measurement."
                 % (agg["unsplit_fixtures"], MARKER))

    return head + " " + _simple_line(agg)


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error; here 2 means "could not check".

    A mistyped flag would otherwise be indistinguishable from a tool that ran
    and could not measure anything. 64 is the usage error.

    error() only. --help routes through exit(), not error(), and overriding
    exit() would break the exit-0 contract test_tool_exit_contract.py asserts
    for every tool's --help.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def main(argv=None):
    ap = _Parser(
        description="Report what the system prompt costs per iteration, split "
                    "at the cache breakpoint into coaching prefix and state tail.")
    ap.add_argument("fixture_dir", nargs="?", default=str(DEFAULT_FIXTURES),
                    help="directory holding fixture-*/expected.txt "
                         "(default: the build_prompt parity corpus)")
    ap.add_argument("--json", action="store_true",
                    help="emit the full report as JSON")
    ap.add_argument("--bytes-per-token", type=int, default=BYTES_PER_TOKEN,
                    metavar="N",
                    help="bytes per token for the ESTIMATE (default: %d)"
                         % BYTES_PER_TOKEN)
    args = ap.parse_args(argv)

    if args.bytes_per_token < 1:
        ap.error("--bytes-per-token must be >= 1")

    if not os.path.isdir(args.fixture_dir):
        # 66, not 3. "You pointed me at nothing" and "this corpus is empty" are
        # different facts, and only one of them is about the corpus.
        sys.stderr.write(
            "prompt-cost: fixture directory does not exist: %s\n"
            % args.fixture_dir)
        return 66

    report = measure(args.fixture_dir, args.bytes_per_token)

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        # "UNKNOWN" for an unsplittable fixture, never "0". The table is the
        # surface an operator eyeballs, and it must not be the one place a
        # missing measurement reads as a cheap prompt.
        print("%-12s %8s %8s %8s %7s" % (
            "FIXTURE", "TOTAL", "PREFIX", "TAIL", "PREFIX%"))
        for r in report["fixtures"]:
            if r["prefix_bytes"] is None:
                total = "UNKNOWN" if r["total_bytes"] is None else str(r["total_bytes"])
                print("%-12s %8s %8s %8s %7s  (%s)" % (
                    r["fixture"], total, "UNKNOWN", "UNKNOWN", "UNKNOWN",
                    r["reason"]))
            else:
                print("%-12s %8d %8d %8d %6.1f%%" % (
                    r["fixture"], r["total_bytes"], r["prefix_bytes"],
                    r["tail_bytes"], r["prefix_share_pct"]))
        print("")
        print(report["summary"])

    # Exit 1 is unreachable BY DESIGN -- see the module docstring. There is no
    # prompt size that constitutes a FAILURE; a budget belongs in token-guard.py.
    return 0 if report["aggregate"]["fixtures"] else 3


if __name__ == "__main__":
    sys.exit(main())
