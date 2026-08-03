#!/usr/bin/env python3
"""Where did a run's cost and time actually GO, stage by stage.

run-replay.py reconstructs a run along the ITERATION axis: what happened in
iteration 3, did cost climb, did a gate fail twice. That is the right axis for
debugging one bad run and the wrong axis for the question a team asks after
paying the bill, which is about STAGES: is the money going to the agent, or to
code review, or to a doc-generation step nobody reads.

This reads only what a run already wrote -- .loki/events.jsonl and
.loki/metrics/efficiency/iteration-*.json. It starts nothing and spends
nothing.

THE REFUSAL THAT IS THE WHOLE POINT OF THIS TOOL:

    THERE IS NO PER-STAGE COST IN THE ARTIFACTS, SO NONE IS REPORTED.

A stage_complete record carries a stage name, a duration and an iteration. An
efficiency record carries dollars for a whole ITERATION. Nothing anywhere
attributes a dollar to a stage. So the per-stage cost column here is a
sentence, not a number.

The tempting fix is not even dividing the iteration's cost evenly across its
stages -- that is obviously invented and nobody would ship it. The tempting
fix is weighting by duration: cost_usd * (stage_seconds / iteration_seconds).
That is the SAME invention wearing a defensible-looking coat, and it is worse
precisely because a reader will believe it. A stage that burns thirty seconds
of wall clock spawning a linter costs nothing in tokens; a stage that spends
ten seconds streaming a huge completion costs most of the iteration. Wall
clock is not a cost proxy, and presenting it as one manufactures a fact the
run never recorded.

So the axes are reported separately and honestly:

  TIME per stage      measured, summed over the iterations that recorded it
  COST per iteration  measured, with unmeasured iterations EXCLUDED
  the largest contributor is named on each axis, and labelled with which one

THE OTHER HONESTY RULES, each of which this repo has paid for:

  1. An iteration with no efficiency record reads "cost not recorded" and is
     EXCLUDED from the total. Never summed as 0. A run of four iterations
     where two were never measured must not report the two measured ones as
     the whole bill -- so the total says how many of how many it covers.
  2. A stage that never emitted stage_complete reads "not recorded", never
     0s. 0s reads as "instant", a different claim. A genuine duration_s of 0
     from a fast gate IS real data and survives as 0.
  3. A corrupt event line is COUNTED and reported. A tool that silently skips
     bad lines reports a cleaner run than happened, and drops them most often
     when something upstream is broken.
  4. Empty or missing events exits non-zero, EVEN IF the efficiency records
     survived. An empty-looking report certifies a run that never happened,
     and a cost table printed under the heading "cost attribution" when the
     stage axis was never read over-claims its own subject.

Usage:
  tools/cost-attribute.py [workspace] [--json]

Exit: 0 report produced, 3 events present but nothing parseable to attribute,
66 no events file at all, 64 usage error.
"""

import argparse
import json
import os
import sys

sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
# Resolved from __file__, never from the workspace argument: the workspace
# being read is a different tree and has no autonomy/lib.
sys.path.insert(0, os.path.join(_REPO_ROOT, "autonomy", "lib"))

from efficiency_cost import record_is_measured  # noqa: E402

OK, NOTHING_TO_CHECK, USAGE, NO_INPUT = 0, 3, 64, 66


class _Parser(argparse.ArgumentParser):
    """argparse exits 2 on a usage error, and 2 here means "could not check".

    Those are opposite facts. "You typed the flag wrong" and "the instrument
    is blind" must not share an exit code, because a CI job branching on 2
    would treat a typo as a broken measurement and carry on.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        print("%s: error: %s" % (self.prog, message), file=sys.stderr)
        raise SystemExit(USAGE)


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


def load_events(path):
    """Return (events, corrupt_line_count).

    The count is a deliverable, not a debug aid: it is the only evidence that
    this report is reading a whole recording.
    """
    events = []
    corrupt = 0
    with open(path, errors="replace") as fh:
        for line in fh:
            if not line.strip():
                continue
            try:
                e = json.loads(line)
            except Exception:
                corrupt += 1
                continue
            if not isinstance(e, dict):
                # A bare JSON scalar parses fine but is not a record.
                corrupt = corrupt + 1
                continue
            events.append(e)
    return events, corrupt


def iteration_cost(workspace, iteration):
    """One iteration's measured USD, or None when it was never measured.

    Read per FILE rather than via collect_efficiency(), which sums the whole
    directory into one aggregate and so cannot say WHICH iterations were
    measured. record_is_measured() is the single shared rule and is applied
    unchanged; a second copy of that predicate is how the honesty rule drifts.
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
    usd = rec.get("cost_usd")
    if isinstance(usd, bool) or not isinstance(usd, (int, float)):
        # Tokens were measured but no dollar figure was priced. That is a
        # measured run with an unmeasured COST, and this tool sums dollars.
        return None
    return float(usd)


def attribute(workspace):
    """Build the attribution report. Returns (report dict, exit code)."""
    events_path = os.path.join(workspace, ".loki", "events.jsonl")
    if not os.path.isfile(events_path):
        return {
            "status": "no_events",
            "workspace": os.path.abspath(workspace),
            "why": "no events at %s -- pass the workspace directory of a "
                   "completed run" % events_path,
        }, NO_INPUT

    events, corrupt = load_events(events_path)

    # stage_seconds[stage] = [durations...]; iterations that recorded it.
    stage_seconds = {}
    stage_iterations = {}
    seen_iterations = set()
    for e in events:
        data = e.get("data") if isinstance(e.get("data"), dict) else {}
        it = _iter_key(data.get("iteration"))
        if it is not None:
            seen_iterations.add(it)
        if (e.get("type") or e.get("event")) != "stage_complete":
            continue
        name = data.get("stage")
        secs = data.get("duration_s")
        if it is None or not name:
            continue
        # isinstance guard, not truthiness: duration_s of 0 is REAL data from
        # a fast gate. Filtering on falsy would turn a genuine 0 into "not
        # recorded" and break the absent-stage rule the other way round.
        if isinstance(secs, bool) or not isinstance(secs, (int, float)):
            continue
        stage_seconds.setdefault(str(name), []).append(float(secs))
        stage_iterations.setdefault(str(name), set()).add(it)

    # The efficiency directory is a SECOND, independent witness to which
    # iterations existed. An events.jsonl truncated at a line boundary parses
    # clean, so the corrupt count is 0 while a whole iteration is missing.
    try:
        for name in os.listdir(os.path.join(
                workspace, ".loki", "metrics", "efficiency")):
            if name.startswith("iteration-") and name.endswith(".json"):
                n = _iter_key(name[len("iteration-"):-len(".json")])
                if n is not None:
                    seen_iterations.add(n)
    except Exception:
        pass

    # Keyed on PARSEABLE EVENTS, not on the union with the efficiency scan.
    # Those records are a second witness to which iterations existed, and they
    # are deliberately NOT enough to call this a report: the deliverable here
    # is the STAGE axis, and stage records live only in events.jsonl. A
    # workspace whose events file is empty or entirely corrupt, but whose
    # efficiency records survive, would otherwise print a confident cost table
    # under the heading "cost attribution" while the thing being attributed TO
    # was never read. That is a report over-claiming its own subject, and it
    # exits non-zero instead. cost-history.py and run-replay.py remain the
    # right tools when only the cost axis is wanted.
    if not events:
        return {
            "status": "nothing_to_attribute",
            "workspace": os.path.abspath(workspace),
            "corrupt_lines": corrupt,
            "why": "%s has no parseable event records (%d corrupt line(s) "
                   "counted) -- there is no stage axis to attribute to, so "
                   "no attribution is reported even if efficiency records "
                   "survived" % (events_path, corrupt),
        }, NOTHING_TO_CHECK

    stages = []
    for name in sorted(stage_seconds):
        secs = stage_seconds[name]
        stages.append({
            "stage": name,
            "total_s": round(sum(secs), 1),
            "iterations_recorded": len(stage_iterations[name]),
            "recorded": True,
        })

    # Costs, per iteration. An unmeasured one carries None and is kept in the
    # list so the report can say how much of the run the total covers.
    per_iteration = []
    for n in sorted(seen_iterations):
        per_iteration.append({"iteration": n,
                              "usd": iteration_cost(workspace, n)})

    costs = [it["usd"] for it in per_iteration if it["usd"] is not None]
    # `if costs else` would be a falsy test on the LIST, which is correct
    # (an empty list is the only falsy list) -- but spelled explicitly so a
    # later edit cannot quietly turn it into a test on the SUM, where a
    # genuine total of 0.0 would flip to UNKNOWN.
    total = round(sum(costs), 6) if len(costs) > 0 else None

    slowest = None
    if stages:
        top = max(stages, key=lambda s: s["total_s"])
        slowest = {"stage": top["stage"], "total_s": top["total_s"]}

    # `if measured_iters`, not `if costs`: a run measured at exactly $0.00 is
    # real data and still has a largest contributor. A falsy check would drop
    # it, which is the measured-zero rule failing in the other direction. The
    # list is also the SAME sequence `costs` came from, so this cannot be
    # non-empty while that generator is empty.
    measured_iters = [it for it in per_iteration if it["usd"] is not None]
    priciest = None
    if measured_iters:
        top = max(measured_iters, key=lambda it: it["usd"])
        priciest = {"iteration": top["iteration"], "usd": round(top["usd"], 6)}

    return {
        "status": "ok",
        "workspace": os.path.abspath(workspace),
        "read_only": True,
        "corrupt_lines": corrupt,
        "stages": stages,
        "per_iteration_cost": per_iteration,
        "measured_iterations": len(costs),
        "total_iterations": len(per_iteration),
        "total_measured_usd": total,
        "slowest_stage": slowest,
        "largest_cost_iteration": priciest,
        "cost_per_stage": None,
        "cost_per_stage_why": (
            "REFUSED. events.jsonl records a stage's DURATION and the "
            "efficiency records price a whole ITERATION; no artifact "
            "attributes a dollar to a stage. Splitting the iteration cost by "
            "each stage's share of wall clock would look like a measurement "
            "and would not be one -- wall clock is not a token proxy. Time "
            "per stage below is measured; cost per stage was never recorded."
        ),
    }, OK


def render(rep):
    if rep["status"] == "no_events":
        return "NO DATA: %s" % rep["why"]
    if rep["status"] == "nothing_to_attribute":
        return "NOTHING TO ATTRIBUTE: %s" % rep["why"]

    out = ["COST ATTRIBUTION -- read from artifacts only; nothing was started "
           "and nothing was spent.",
           "  workspace: %s" % rep["workspace"]]
    if rep["corrupt_lines"]:
        out.append("  CORRUPT LINES: %d (counted, not dropped -- this report "
                   "is reading an incomplete recording)"
                   % rep["corrupt_lines"])
    else:
        out.append("  corrupt lines: 0 (whole recording read)")
    out.append("")

    out.append("TIME PER STAGE (measured)")
    out.append("-" * 60)
    if rep["stages"]:
        for s in rep["stages"]:
            out.append("  %-24s %8.1fs   over %d iteration(s)"
                       % (s["stage"], s["total_s"], s["iterations_recorded"]))
    else:
        out.append("  no stage emitted stage_complete -- stage timing not "
                   "recorded for this run (not 0s, which would mean instant)")
    out.append("")

    out.append("COST PER ITERATION (measured)")
    out.append("-" * 60)
    for it in rep["per_iteration_cost"]:
        if it["usd"] is None:
            out.append("  iteration %-14d cost not recorded  (excluded from "
                       "the total)" % it["iteration"])
        else:
            out.append("  iteration %-14d $%.4f" % (it["iteration"], it["usd"]))
    out.append("")

    out.append("COST PER STAGE")
    out.append("-" * 60)
    for chunk in rep["cost_per_stage_why"].split(" -- "):
        out.append("  %s" % chunk)
    out.append("")

    out.append("=" * 60)
    if rep["slowest_stage"]:
        out.append("largest time contributor : %s (%.1fs across the run)"
                   % (rep["slowest_stage"]["stage"],
                      rep["slowest_stage"]["total_s"]))
    else:
        out.append("largest time contributor : not recorded, no stage "
                   "durations in this run")

    if rep["total_measured_usd"] is None:
        out.append("largest cost contributor : cost not recorded for any of "
                   "the %d iteration(s)" % rep["total_iterations"])
        out.append("total measured cost      : UNKNOWN (0 of %d iterations "
                   "measured; unmeasured is not free)"
                   % rep["total_iterations"])
    else:
        out.append("largest cost contributor : iteration %d at $%.4f"
                   % (rep["largest_cost_iteration"]["iteration"],
                      rep["largest_cost_iteration"]["usd"]))
        out.append("total measured cost      : $%.4f  (%d of %d iterations "
                   "measured)"
                   % (rep["total_measured_usd"], rep["measured_iterations"],
                      rep["total_iterations"]))
        if rep["measured_iterations"] < rep["total_iterations"]:
            # A claim over a subset must say it is a claim over a subset.
            out.append("                           the %d unmeasured "
                       "iteration(s) are excluded, not counted as free, so "
                       "the real bill is HIGHER than this."
                       % (rep["total_iterations"]
                          - rep["measured_iterations"]))
    return "\n".join(out)


def main(argv=None):
    ap = _Parser(
        description="Attribute a run's cost and time to where they went, "
                    "per stage. Reads only; starts nothing, spends nothing.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace root containing .loki/ (default .)")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the report as JSON")
    args = ap.parse_args(argv)

    rep, code = attribute(args.workspace)
    if args.as_json:
        # A structured error is still structured output. The caller asked for
        # machine-readable and must not get a bare text line on the failure
        # path; the exit code carries the verdict either way.
        print(json.dumps(rep, indent=2))
    else:
        print(render(rep), file=sys.stderr if code else sys.stdout)
    return code


if __name__ == "__main__":
    sys.exit(main())
