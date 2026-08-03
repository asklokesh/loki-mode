#!/usr/bin/env python3
"""What does verification cost in TOKENS, versus the build itself?

WHY THIS EXISTS. tools/verification-tax.py measures the gate in WALL TIME and
in how often it changed an outcome, and says in its own header that it does not
measure token cost. docs/CAPABILITY-BACKLOG.md carries that as the open half of
a SHIPPED-partial row ("Remaining: token cost"). This is that half.

WHAT IT REPORTS, and the one thing it REFUSES.

Tokens are recorded per ITERATION, in .loki/metrics/efficiency/iteration-N.json.
Stages are recorded per STAGE, as stage_complete events carrying a name, a
status and a duration_s. Those are the only two artifacts a run writes, and
NEITHER attributes a token to a stage. So:

    THE VERIFICATION SHARE OF TOKENS IS NOT REPORTED, BECAUSE NOTHING
    RECORDS IT.

The tempting fix is to weight each iteration's tokens by each stage's share of
that iteration's wall clock. tools/cost-attribute.py already refused exactly
that for dollars and named it correctly: the same invention wearing a
defensible-looking coat, and worse than an even split precisely because a
reader will believe it. A gate that shells out to eslint for thirty seconds
spends no tokens; a review stage that streams three completions in ten seconds
spends most of the iteration. Wall clock is not a token proxy.

What IS measured, and is reported:

  tokens per iteration      measured, unmeasured iterations excluded
  verification stages run   counted from stage_complete, by name
  build stages run          same, for the one stage that IS the agent
  tokens per verification-stage-execution   the denominator is measured and
                            the numerator is measured, but the DIVISION is
                            only an upper bound and is labelled as one

THE HONESTY RULE, which is the reason for the whole file. An iteration with no
recorded token counts reads UNKNOWN and is EXCLUDED from every average. It is
never averaged in as zero. Averaging absent measurements toward zero slides the
mean toward "verification is free" -- which is the conclusion someone building
a case for removing gates would want, reached by arithmetic rather than by
evidence. Measured-ness is record_is_measured() in
autonomy/lib/efficiency_cost.py, imported and never restated, fed the FOUR
TOKEN FIELDS ONLY: a record carrying a real cost_usd and zero tokens (the shape
codex wrote before v8.51.0) is a run whose TOKENS were never measured, and
feeding cost_usd in would report it as "0 tokens", which is the exact lie this
file exists to prevent.

WHAT THIS IS NOT. Not a gate. A workspace whose every gate BLOCKED still exits
0 here, because the question asked was "what did it cost", and that question
was answered. tools/token-guard.py is the gate.

Usage:
  tools/token-tax.py [workspace] [--json]

Exit: 0 reported, 2 could not check, 3 nothing to report, 64 usage error,
66 input path missing.
"""

import argparse
import json
import os
import sys

sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))
# Resolved from __file__, never from the workspace argument: the workspace being
# read is a different tree and has no autonomy/lib.
sys.path.insert(0, os.path.join(os.path.dirname(_HERE), "autonomy", "lib"))

from efficiency_cost import record_is_measured  # noqa: E402

OK = 0
COULD_NOT_CHECK = 2
NOTHING_TO_REPORT = 3
USAGE_ERROR = 64
INPUT_MISSING = 66

# The four token fields. cost_usd is deliberately absent; see the docstring.
TOKEN_FIELDS = ("input_tokens", "output_tokens", "cache_read_tokens",
                "cache_creation_tokens")

# The one stage that IS the build. Every other stage emitted by
# emit_stage_complete in autonomy/run.sh is verification or gate work.
BUILD_STAGES = frozenset(["agent"])

WHY_NO_SPLIT = (
    "REFUSED. Tokens are recorded per ITERATION and stages are recorded per "
    "STAGE; no artifact this repo writes attributes a token to a stage. "
    "Weighting each iteration's tokens by a stage's share of wall clock would "
    "look like a measurement and would not be one -- a gate shelling out to a "
    "linter burns seconds and no tokens, while one streaming a completion "
    "burns tokens in no time. The split becomes reportable when a writer "
    "records per-stage usage, not before."
)


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo's convention 2 means "could NOT be checked" -- a real answer
    about the subject. A mistyped flag is not that: it is an error about the
    INVOCATION, and nothing about the subject was examined. The two call for
    opposite responses, since retrying cannot fix a typo.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(USAGE_ERROR)


def _num(v):
    """A number as itself; None, "", or a bool as None."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def measured_tokens(rec):
    """The four token fields summed, or None when this run never measured them.

    None means UNKNOWN. The caller must not treat it as zero -- that is the
    single property this whole file is built around.
    """
    if not isinstance(rec, dict):
        return None
    fields = {f: _num(rec.get(f)) for f in TOKEN_FIELDS}
    if not record_is_measured(fields):
        return None
    # Measured, so a None in one field is a real gap inside a real measurement.
    # Count it as 0 for summing rather than poisoning the whole record.
    return {f: (0 if fields[f] is None else fields[f]) for f in TOKEN_FIELDS}


def read_iterations(loki_dir):
    """[{iteration, tokens}] for every iteration-N.json, tokens None if unmeasured.

    Unreadable and non-dict records are kept with tokens=None rather than
    dropped: a file that exists and cannot be read is an iteration that
    happened and was not measured, which is exactly what this reports.
    """
    eff_dir = os.path.join(loki_dir, "metrics", "efficiency")
    try:
        names = sorted(os.listdir(eff_dir))
    except OSError:
        return []
    out = []
    for name in names:
        if not (name.startswith("iteration-") and name.endswith(".json")):
            continue
        try:
            n = int(name[len("iteration-"):-len(".json")])
        except ValueError:
            continue
        try:
            with open(os.path.join(eff_dir, name), "r", encoding="utf-8") as fh:
                rec = json.load(fh)
        except (OSError, ValueError):
            rec = None
        out.append({"iteration": n, "tokens": measured_tokens(rec)})
    out.sort(key=lambda r: r["iteration"])
    return out


def read_stages(loki_dir):
    """({stage: executions}, corrupt_line_count) from stage_complete events.

    Corrupt lines are counted, never silently dropped: a tool that skips bad
    lines reports a cleaner run than happened, and skips most often when
    something upstream is broken.
    """
    path = os.path.join(loki_dir, "events.jsonl")
    counts, corrupt = {}, 0
    try:
        fh = open(path, "r", encoding="utf-8", errors="replace")
    except OSError:
        return counts, corrupt
    with fh:
        for line in fh:
            if not line.strip():
                continue
            try:
                e = json.loads(line)
            except ValueError:
                corrupt += 1
                continue
            if not isinstance(e, dict):
                corrupt += 1
                continue
            if (e.get("type") or e.get("event")) != "stage_complete":
                continue
            data = e.get("data") if isinstance(e.get("data"), dict) else {}
            name = data.get("stage")
            if name:
                counts[str(name)] = counts.get(str(name), 0) + 1
    return counts, corrupt


def summarize(iterations, stages, corrupt):
    """The report. Averages cover MEASURED iterations only, and say so."""
    # THE EXCLUSION. One filter site, not a repeated guard: an unmeasured
    # iteration leaves the arithmetic entirely rather than entering it as zero.
    measured = [r for r in iterations if r["tokens"] is not None]
    unmeasured = len(iterations) - len(measured)

    totals = {f: sum(r["tokens"][f] for r in measured) for f in TOKEN_FIELDS}
    grand = sum(totals.values()) if measured else None

    verification = {k: v for k, v in stages.items() if k not in BUILD_STAGES}
    build = {k: v for k, v in stages.items() if k in BUILD_STAGES}
    v_execs = sum(verification.values())

    # An UPPER BOUND, and labelled as one everywhere it appears: it divides ALL
    # of a run's tokens by the verification executions, as though the build
    # spent none. It is the largest the true figure could be, which makes it
    # useful for bounding a claim and useless as an estimate.
    ceiling = None
    if grand is not None and v_execs:
        ceiling = round(grand / v_execs, 1)

    return {
        "iterations": len(iterations),
        "measured_iterations": len(measured),
        "unmeasured_iterations": unmeasured,
        "corrupt_lines": corrupt,
        "totals": totals if measured else {f: None for f in TOKEN_FIELDS},
        "total_tokens": grand,
        "mean_tokens_per_measured_iteration": (
            round(grand / len(measured), 1) if measured else None),
        "per_iteration": [
            {"iteration": r["iteration"],
             "tokens": (None if r["tokens"] is None
                        else sum(r["tokens"].values()))}
            for r in iterations
        ],
        "verification_stage_executions": v_execs,
        "verification_stages": dict(sorted(verification.items())),
        "build_stage_executions": sum(build.values()),
        "build_stages": dict(sorted(build.items())),
        "verification_tokens": None,
        "build_tokens": None,
        "verification_token_share": None,
        "verification_token_share_why": WHY_NO_SPLIT,
        "tokens_per_verification_execution_upper_bound": ceiling,
    }


def render(s):
    out = ["TOKEN TAX -- read from artifacts only; nothing was started and "
           "nothing was spent.", ""]
    out.append("  iterations         %d" % s["iterations"])
    out.append("  measured           %d of %d"
               % (s["measured_iterations"], s["iterations"]))

    if s["measured_iterations"]:
        out.append("  total tokens       %d" % s["total_tokens"])
        for f in TOKEN_FIELDS:
            out.append("    %-22s %d" % (f, s["totals"][f]))
        out.append("  mean per measured  %.1f"
                   % s["mean_tokens_per_measured_iteration"])
    else:
        out.append("  total tokens       UNKNOWN (no iteration recorded any "
                   "token count)")
        out.append("  mean per measured  UNKNOWN")

    if s["unmeasured_iterations"]:
        out.append("  UNMEASURED         %d iteration(s) carry no token count; "
                   "EXCLUDED from" % s["unmeasured_iterations"])
        out.append("                     the totals and the mean above, NOT "
                   "counted as 0 tokens.")
        out.append("                     The real figure is HIGHER than what "
                   "is printed here.")

    out.append("")
    out.append("PER ITERATION")
    out.append("-" * 60)
    for r in s["per_iteration"]:
        if r["tokens"] is None:
            out.append("  iteration %-8d UNKNOWN (not measured; excluded)"
                       % r["iteration"])
        else:
            out.append("  iteration %-8d %d tokens" % (r["iteration"],
                                                       r["tokens"]))

    out.append("")
    out.append("STAGES RUN (counted, not priced)")
    out.append("-" * 60)
    if s["verification_stages"]:
        for name, n in s["verification_stages"].items():
            out.append("  verification  %-22s %d execution(s)" % (name, n))
    else:
        out.append("  verification  no stage_complete record -- stages not "
                   "recorded (not 0 runs)")
    for name, n in s["build_stages"].items():
        out.append("  build         %-22s %d execution(s)" % (name, n))

    out.append("")
    out.append("VERIFICATION SHARE OF TOKENS")
    out.append("-" * 60)
    for chunk in WHY_NO_SPLIT.split(" -- "):
        out.append("  %s" % chunk)
    if s["tokens_per_verification_execution_upper_bound"] is not None:
        out.append("")
        out.append("  UPPER BOUND ONLY: %.1f tokens per verification execution "
                   "IF the build"
                   % s["tokens_per_verification_execution_upper_bound"])
        out.append("  had spent none, which it did not. This bounds a claim; "
                   "it does not estimate one.")

    if s["corrupt_lines"]:
        out.append("")
        out.append("  CORRUPT       %d unreadable event line(s), counted not "
                   "dropped" % s["corrupt_lines"])

    out.append("")
    if not s["measured_iterations"]:
        out.append("  READ: token cost is UNMEASURED. No claim that "
                   "verification is cheap or")
        out.append("  expensive can be made from this workspace. Absence of a "
                   "number is not a")
        out.append("  small number.")
    return "\n".join(out)


def main(argv=None):
    ap = _Parser(
        description="Report what verification cost in TOKENS versus the "
                    "build. Reports only; never blocks.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace root containing .loki/ (default .)")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the report as JSON")
    args = ap.parse_args(argv)

    if not os.path.exists(args.workspace):
        # 66, not COULD_NOT_CHECK. "The path you named does not exist" is a
        # fact about the INPUT; "I could not evaluate" is a fact about the
        # subject. A caller retrying on 2 would retry forever against a typo.
        sys.stderr.write("token-tax: no such workspace: %s\n" % args.workspace)
        return INPUT_MISSING

    loki = args.workspace
    if os.path.basename(os.path.normpath(loki)) != ".loki":
        loki = os.path.join(loki, ".loki")
    if not os.path.isdir(loki):
        sys.stderr.write("token-tax: no .loki directory under %s; nothing to "
                         "report\n" % args.workspace)
        return NOTHING_TO_REPORT

    try:
        iterations = read_iterations(loki)
        stages, corrupt = read_stages(loki)
    except OSError as exc:
        sys.stderr.write("token-tax: could not read %s: %s\n" % (loki, exc))
        return COULD_NOT_CHECK

    if not iterations and not stages and not corrupt:
        sys.stderr.write("token-tax: no efficiency records and no stage "
                         "events under %s; nothing to report\n" % loki)
        return NOTHING_TO_REPORT

    s = summarize(iterations, stages, corrupt)
    # Records present but NONE measured is exit 0, deliberately: the question
    # "what did this cost" was answered, and the answer is UNKNOWN. Collapsing
    # it into NOTHING_TO_REPORT would hide the exact case this file exists for.
    if args.as_json:
        print(json.dumps(s, indent=2, sort_keys=True))
    else:
        print(render(s))
    return OK


if __name__ == "__main__":
    sys.exit(main())
