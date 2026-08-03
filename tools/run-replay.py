#!/usr/bin/env python3
"""Reconstruct what a completed run actually did, iteration by iteration.

WHY. Unit cases prove the RULE. Only the recorded artifact proves the CASE.
A run leaves a flight recorder behind -- .loki/events.jsonl plus the
per-iteration efficiency records -- and until now reading it back meant either
hand-parsing JSONL or running scripts/measure-run.sh, which renders ONE
aggregate stage table for the whole run. An aggregate cannot answer the
questions that matter after a bad run: did cost climb between iterations, did
the same gate fail twice, which iteration was the slow one.

This reads ONLY what a run already wrote. It starts nothing, spends nothing,
and never contacts a provider. Replay is free.

Usage:
  tools/run-replay.py [workspace]      # default: .
  tools/run-replay.py --json [ws]      # machine-readable

THE HONESTY RULES, which are the point of this tool:

  1. A truncated or unparseable line is COUNTED and REPORTED, never silently
     dropped. measure-run.sh skips bad lines by design, so a corrupt tail
     disappears without a trace and the replay reports a cleaner run than
     happened. A replay that quietly loses data is worse than no replay.
  2. An unmeasured cost reads UNKNOWN, never $0.00 -- via the single shared
     record_is_measured() from autonomy/lib/efficiency_cost.py. Free and
     unmeasured are different claims and only one of them is honest.
  3. A stage that never emitted stage_complete reads "not recorded", NOT 0s.
     0s reads as "instant", which is a different claim. Note a genuine
     duration_s of 0 is real data (fast gates emit it) and is preserved.
  4. An empty or missing events.jsonl says so and exits non-zero. An
     empty-but-successful-looking replay certifies a run that never happened.
"""

import argparse
import json
import os
import sys

sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
# Resolved from __file__, never from the workspace argument: the workspace
# being replayed is a different tree and has no autonomy/lib.
sys.path.insert(0, os.path.join(_REPO_ROOT, "autonomy", "lib"))

from efficiency_cost import record_is_measured  # noqa: E402

EXIT_NO_DATA = 66  # matches the missing-workspace convention in measure-run.sh


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


def _load_events(path):
    """Return (events, skipped_line_count).

    Every line that does not parse into a dict is counted. The count is the
    deliverable, not a debug aid: it is the only evidence that the replay is
    reading a whole recording.
    """
    events = []
    skipped = 0
    with open(path, errors="replace") as fh:
        for line in fh:
            if not line.strip():
                continue
            try:
                e = json.loads(line)
            except Exception:
                # MUTATION PROBE TARGET. The increment below is the probe's
                # find-string and must stay the ONLY compound-assignment
                # spelling of it in this file -- which is why the sibling
                # branch writes the increment out longhand, and why this
                # comment does not quote it. A probe whose find-string is
                # ambiguous hits whichever copy comes first (here, a comment)
                # and reports MUTATION SURVIVED, which is indistinguishable
                # from a test that checks nothing.
                skipped += 1
                continue
            if not isinstance(e, dict):
                # A bare JSON scalar parses fine but is not a record.
                skipped = skipped + 1
                continue
            events.append(e)
    return events, skipped


def _iter_key(value):
    """Iteration number as an int, or None when unusable."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    try:
        return int(str(value).strip())
    except Exception:
        return None


def _read_cost(workspace, iteration):
    """Per-iteration cost dict, or None when nothing was measured.

    Read per FILE, not via collect_efficiency(): that sums the whole directory
    into one aggregate, which cannot answer "did cost climb between
    iterations". record_is_measured() is the shared rule and is applied here
    unchanged -- a second copy of that predicate is how the honesty rule
    drifts.
    """
    path = os.path.join(
        workspace, ".loki", "metrics", "efficiency",
        "iteration-%d.json" % iteration,
    )
    try:
        with open(path) as fh:
            rec = json.load(fh)
    except Exception:
        return None
    if not isinstance(rec, dict) or not record_is_measured(rec):
        return None
    return {
        "usd": float(rec.get("cost_usd") or 0.0),
        "input_tokens": int(rec.get("input_tokens") or 0),
        "output_tokens": int(rec.get("output_tokens") or 0),
        "cache_read_tokens": int(rec.get("cache_read_tokens") or 0),
        "cache_creation_tokens": int(rec.get("cache_creation_tokens") or 0),
        "model": str(rec.get("model") or "") or None,
    }


def build_replay(workspace):
    """Reconstruct the run. Returns a dict, or raises SystemExit on no data."""
    events_path = os.path.join(workspace, ".loki", "events.jsonl")
    if not os.path.isfile(events_path):
        print("no events at %s -- pass the workspace directory of a "
              "completed run" % events_path, file=sys.stderr)
        raise SystemExit(EXIT_NO_DATA)

    events, skipped = _load_events(events_path)

    # An events file that exists but yields nothing usable is a no-data run.
    # The skipped count still gets reported: a FULLY corrupt file is the worst
    # case of the bug rule 1 guards, so it must never exit silently.
    if not events:
        print("events.jsonl at %s has no parseable records "
              "(%d unparseable line(s) skipped) -- nothing to replay"
              % (events_path, skipped), file=sys.stderr)
        raise SystemExit(EXIT_NO_DATA)

    # stages[iteration][stage] = {"duration_s": .., "status": ..}
    stages = {}
    iteration_status = {}
    for e in events:
        etype = e.get("type") or e.get("event")
        data = e.get("data") if isinstance(e.get("data"), dict) else {}
        if etype == "stage_complete":
            it = _iter_key(data.get("iteration"))
            name = data.get("stage")
            secs = data.get("duration_s")
            if it is None or not name:
                continue
            # isinstance guard, not truthiness: duration_s of 0 is REAL data
            # from a fast gate. Filtering on falsy would convert a genuine 0
            # into "not recorded" and break the absent-stage rule the other
            # way round.
            if isinstance(secs, bool) or not isinstance(secs, (int, float)):
                continue
            stages.setdefault(it, {})[str(name)] = {
                "duration_s": float(secs),
                "status": str(data.get("status") or "unknown"),
            }
        elif etype == "iteration_complete":
            it = _iter_key(data.get("iteration"))
            if it is not None:
                iteration_status[it] = str(data.get("status") or "unknown")

    # An events.jsonl truncated at a LINE BOUNDARY -- what a killed run
    # leaves -- parses cleanly, so skipped_lines is 0 and the recording looks
    # whole while a whole iteration is missing. The efficiency records are a
    # second, independent witness to which iterations existed; without them
    # the missing iteration's cost silently vanishes from the total and from
    # "largest cost contributor", with no signal at all. A killed run is
    # exactly the case this tool exists for.
    numbers = set(stages) | set(iteration_status)
    try:
        for name in os.listdir(os.path.join(
                workspace, ".loki", "metrics", "efficiency")):
            if name.startswith("iteration-") and name.endswith(".json"):
                n = _iter_key(name[len("iteration-"):-len(".json")])
                if n is not None:
                    numbers.add(n)
    except Exception:
        pass
    numbers = sorted(numbers)
    if not numbers:
        print("no iteration or stage records in %s "
              "(%d unparseable line(s) skipped) -- nothing to replay"
              % (events_path, skipped), file=sys.stderr)
        raise SystemExit(EXIT_NO_DATA)

    # The stage vocabulary is the union actually observed, never a hardcoded
    # list: a fixed list rots, and would claim stages were missing on runs
    # that never had them.
    all_stages = sorted({s for per in stages.values() for s in per})

    iterations = []
    prev_cost = None
    prev_failed = set()
    for n in numbers:
        seen = stages.get(n, {})
        cost = _read_cost(workspace, n)
        failed = {s for s, v in seen.items() if v["status"] == "fail"}

        # Only comparable when BOTH ends were measured. A delta against an
        # unmeasured neighbour is a fabricated comparison.
        delta = None
        if cost is not None and prev_cost is not None:
            delta = round(cost["usd"] - prev_cost["usd"], 6)

        iterations.append({
            "iteration": n,
            "status": iteration_status.get(n),
            "stages": {
                s: (seen[s] if s in seen else None) for s in all_stages
            },
            "stages_not_recorded": [s for s in all_stages if s not in seen],
            "cost": cost,
            "cost_delta_usd": delta,
            "cost_comparable": cost is not None and prev_cost is not None,
            "gates_failed": sorted(failed),
            "gates_failed_again": sorted(failed & prev_failed),
        })
        # NOT `cost if cost is not None else prev_cost`: carrying the last
        # measured value across an unmeasured gap makes measured/unmeasured/
        # measured compare iteration 3 against iteration 1 while labelling it
        # "vs previous iteration". That is a fabricated comparison wearing a
        # true-sounding label.
        prev_cost = cost
        prev_failed = failed

    # Slowest stage overall, summed across iterations that recorded it.
    totals = {}
    for it in iterations:
        for s, v in it["stages"].items():
            if v is not None:
                totals[s] = totals.get(s, 0.0) + v["duration_s"]
    slowest = None
    if totals:
        name = max(totals, key=lambda k: totals[k])
        slowest = {"stage": name, "total_s": round(totals[name], 1)}

    measured = [it for it in iterations if it["cost"] is not None]
    largest = None
    if measured:
        top = max(measured, key=lambda it: it["cost"]["usd"])
        largest = {
            "iteration": top["iteration"],
            "usd": round(top["cost"]["usd"], 6),
            "measured_iterations": len(measured),
            "total_iterations": len(iterations),
        }

    return {
        "workspace": os.path.abspath(workspace),
        "read_only": True,
        "skipped_lines": skipped,
        "iterations": iterations,
        "slowest_stage": slowest,
        "largest_cost_contributor": largest,
        "total_cost_usd": (
            round(sum(it["cost"]["usd"] for it in measured), 6)
            if measured else None
        ),
    }


def _fmt_cost(cost):
    if cost is None:
        return "cost not recorded"
    return "$%.4f  in %d / out %d / cache-read %d tok%s" % (
        cost["usd"], cost["input_tokens"], cost["output_tokens"],
        cost["cache_read_tokens"],
        ("  [%s]" % cost["model"]) if cost["model"] else "",
    )


def render(rep):
    out = []
    out.append("RUN REPLAY -- reconstructed from artifacts only.")
    out.append("Nothing was started and nothing was spent; this reads "
               ".loki/ and exits.")
    out.append("  workspace: %s" % rep["workspace"])
    if rep["skipped_lines"]:
        out.append("  UNPARSEABLE LINES SKIPPED: %d "
                   "(counted, not dropped -- this replay is reading an "
                   "incomplete recording)" % rep["skipped_lines"])
    else:
        out.append("  unparseable lines skipped: 0 (whole recording read)")
    out.append("")

    for i, it in enumerate(rep["iterations"]):
        head = "ITERATION %d" % it["iteration"]
        if it["status"]:
            head += "  [%s]" % it["status"]
        out.append(head)
        out.append("-" * 60)
        for name, v in it["stages"].items():
            if v is None:
                out.append("  %-24s not recorded" % name)
            else:
                out.append("  %-24s %6.0fs   %s"
                           % (name, v["duration_s"], v["status"]))
        out.append("  %-24s %s" % ("cost", _fmt_cost(it["cost"])))
        if it["cost_delta_usd"] is not None:
            direction = "climbed" if it["cost_delta_usd"] > 0 else "fell"
            out.append("  %-24s %s $%+.4f vs previous iteration"
                       % ("change", direction, it["cost_delta_usd"]))
        elif it["cost"] is None:
            out.append("  %-24s cannot compare, cost not recorded"
                       % "change")
        elif i > 0:
            out.append("  %-24s cannot compare, previous iteration's cost "
                       "not recorded" % "change")
        if it["gates_failed"]:
            out.append("  %-24s %s" % ("gates failed",
                                       ", ".join(it["gates_failed"])))
        if it["gates_failed_again"]:
            out.append("  %-24s %s  <-- failed in the previous iteration too"
                       % ("REPEAT FAILURE",
                          ", ".join(it["gates_failed_again"])))
        out.append("")

    out.append("=" * 60)
    if rep["slowest_stage"]:
        out.append("slowest stage overall : %s (%.0fs across the run)"
                   % (rep["slowest_stage"]["stage"],
                      rep["slowest_stage"]["total_s"]))
    else:
        out.append("slowest stage overall : no stage durations recorded")

    lg = rep["largest_cost_contributor"]
    if lg is None:
        out.append("largest cost          : cost not recorded for any "
                   "iteration")
    else:
        out.append("largest cost          : iteration %d at $%.4f"
                   % (lg["iteration"], lg["usd"]))
        if lg["measured_iterations"] < lg["total_iterations"]:
            # A claim over a subset must say it is a claim over a subset.
            out.append("                        (largest among the %d of %d "
                       "iterations that recorded cost)"
                       % (lg["measured_iterations"], lg["total_iterations"]))
        out.append("total measured cost   : $%.4f" % rep["total_cost_usd"])
    return "\n".join(out)


def main(argv=None):
    ap = _Parser(
        description="Replay a completed run from its artifacts. Reads only; "
                    "starts nothing, spends nothing.")
    ap.add_argument("workspace", nargs="?", default=".")
    ap.add_argument("--json", action="store_true", dest="as_json")
    args = ap.parse_args(argv)

    # build_replay raises SystemExit on a no-data workspace, which bypassed
    # --json entirely: the caller asked for machine output and got a bare text
    # line, so `json.load(...)` crashed on the failure path -- unreadable to
    # the exact automation this tool exists for. A structured error is still
    # structured output; the exit code carries the verdict either way.
    try:
        rep = build_replay(args.workspace)
    except SystemExit as exc:
        code = exc.code if isinstance(exc.code, int) else EXIT_NO_DATA
        if args.as_json:
            print(json.dumps({
                "status": "no_data",
                "exit_code": code,
                "workspace": args.workspace,
                "why": "no replayable artifacts under this workspace; "
                       "see stderr for the specific path",
                "iterations": [],
                "skipped_lines": None,
            }, indent=2))
        return code

    if args.as_json:
        print(json.dumps(rep, indent=2))
    else:
        print(render(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
