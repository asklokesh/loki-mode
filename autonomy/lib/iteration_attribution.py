#!/usr/bin/env python3
"""Explain WHY a run took the iterations it took.

WHY THIS EXISTS. Iterations are the direct multiplier on both wall clock and
cost, and the Evidence Receipt reports only `{count, succeeded, failed}`. A user
who sees "6 iterations" cannot tell real work from a gate false-positive that
forced five redos. Neither can we, which is worse: it means we cannot tell
whether an expensive run was the model being slow or the harness being wrong.

That distinction has already bitten this project. A measured run had the agent
claim done on EVERY iteration while a mock-integrity false positive blocked all
six, and a start-sha bug made the council see a permanently empty diff so it
could never vote done. Both were HARNESS defects billed to the user as model
cost. Removing a false positive raises accuracy AND cuts iterations, which is
the rare change that improves both axes at once -- but only if you can see it.

WHAT THIS DOES NOT DO. It does not guess. Every field is derived from records
the engine already writes, and anything not recorded is reported as unknown
rather than inferred. An attribution that invents a reason would be worse than
no attribution, because it would send someone optimising the wrong thing.

Sources, all already written by the engine:
  .loki/metrics/efficiency/iteration-N.json   status, duration_ms, cost_usd, model
  .loki/events.jsonl                          iteration_complete events

Usage:
    python3 autonomy/lib/iteration_attribution.py [--loki-dir .loki] [--json]
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def _read_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _iteration_records(loki_dir):
    """Return per-iteration records sorted by iteration number.

    Reads only what the engine already wrote. A malformed or partial record is
    SKIPPED rather than defaulted, because a zero-cost placeholder would silently
    understate the total and make the attribution wrong in the direction that
    flatters us.
    """
    eff_dir = os.path.join(loki_dir, "metrics", "efficiency")
    out = []
    try:
        names = sorted(os.listdir(eff_dir))
    except OSError:
        return out
    for name in names:
        if not (name.startswith("iteration-") and name.endswith(".json")):
            continue
        rec = _read_json(os.path.join(eff_dir, name))
        if not isinstance(rec, dict) or "iteration" not in rec:
            continue
        out.append(rec)
    out.sort(key=lambda r: r.get("iteration", 0))
    return out


def attribute(loki_dir):
    """Split iteration cost and time into PROGRESS versus REWORK.

    The definition is deliberately conservative and stated plainly, because a
    generous definition of "progress" is how a tool flatters itself:

      progress  an iteration that COMPLETED (exit 0)
      rework    an iteration that FAILED and therefore had to be repeated
      unknown   an iteration whose status was never recorded

    This is a floor on rework, not a ceiling. An iteration that "completed" but
    was forced to run again by a false-positive gate is counted as progress here,
    because the engine does not currently record the blocking gate per iteration.
    Saying so is the point: the number is honest about what it cannot see.
    """
    recs = _iteration_records(loki_dir)

    summary = {
        "iterations": len(recs),
        "progress": {"count": 0, "cost_usd": 0.0, "duration_ms": 0},
        "rework": {"count": 0, "cost_usd": 0.0, "duration_ms": 0},
        "unknown": {"count": 0, "cost_usd": 0.0, "duration_ms": 0},
        "cost_recorded": False,
        "notes": [],
    }

    for r in recs:
        status = str(r.get("status", "")).strip().lower()
        if status == "completed":
            bucket = "progress"
        elif status == "failed":
            bucket = "rework"
        else:
            bucket = "unknown"
        summary[bucket]["count"] += 1
        cost = r.get("cost_usd")
        if isinstance(cost, (int, float)):
            summary[bucket]["cost_usd"] += float(cost)
            if cost > 0:
                summary["cost_recorded"] = True
        dur = r.get("duration_ms")
        if isinstance(dur, (int, float)) and dur >= 0:
            summary[bucket]["duration_ms"] += int(dur)

    for b in ("progress", "rework", "unknown"):
        summary[b]["cost_usd"] = round(summary[b]["cost_usd"], 4)

    total_cost = sum(summary[b]["cost_usd"] for b in ("progress", "rework", "unknown"))
    summary["total_cost_usd"] = round(total_cost, 4) if summary["cost_recorded"] else None

    if not recs:
        summary["notes"].append(
            "no efficiency records: this run predates the recorder, or no iteration completed"
        )
    if not summary["cost_recorded"]:
        # Distinguishing "not recorded" from a genuine $0.00 is the same honesty
        # property the Evidence Receipt depends on. A skeptic reading $0.00
        # concludes the artifact is fake.
        summary["notes"].append(
            "cost not recorded for any iteration (reported as null, not as $0.00)"
        )
    if summary["rework"]["count"] and summary["cost_recorded"]:
        share = summary["rework"]["cost_usd"] / total_cost if total_cost else 0.0
        summary["rework_cost_share"] = round(share, 4)
        summary["notes"].append(
            f"{summary['rework']['count']} of {len(recs)} iterations failed and were "
            f"repeated, costing {share:.0%} of the run"
        )
    summary["notes"].append(
        "rework is a FLOOR: an iteration that completed but was forced to repeat by a "
        "gate is counted as progress, because the blocking gate is not recorded per "
        "iteration"
    )
    return summary


def _render(s):
    lines = ["Iteration attribution", "====================", ""]
    lines.append(f"Iterations:   {s['iterations']}")
    lines.append(f"  progress:   {s['progress']['count']}")
    lines.append(f"  rework:     {s['rework']['count']}")
    if s["unknown"]["count"]:
        lines.append(f"  unknown:    {s['unknown']['count']}")
    if s["total_cost_usd"] is None:
        lines.append("Cost:         not recorded")
    else:
        lines.append(f"Cost:         ${s['total_cost_usd']}")
        lines.append(f"  progress:   ${s['progress']['cost_usd']}")
        lines.append(f"  rework:     ${s['rework']['cost_usd']}")
    lines.append("")
    for n in s["notes"]:
        lines.append(f"note: {n}")
    return "\n".join(lines)


def _fmt_secs(ms):
    return f"{ms / 1000.0:.0f}s"


WINDOW = 3  # last N iterations rendered; the block ships in EVERY prompt


def prompt_block(loki_dir):
    """Render the run's own efficiency trend for injection into the next prompt.

    WHY THIS EXISTS. The engine has written .loki/metrics/efficiency/iteration-N.json
    every iteration for its entire life and never once read it back into a decision.
    Cost, duration and cache data flowed OUT to a budget breaker and an offline
    report, never IN to the agent producing the cost. The agent was the only party
    to the run with no visibility into its own efficiency.

    THE INCENTIVE TRAP, AND THE GUARD. A block reporting cost and duration ALONE
    instructs the model to be cheap, and the cheapest iteration is the one that
    does less work and verifies less. That is gate-weakening through the front
    door, with no gate edited. So spend is NEVER rendered without the progress /
    rework split beside it: the actionable number is "you failed N iterations and
    repeated them", whose correct response is "stop failing gates", not "spend
    less". Enforced by test, not by convention.

    Returns "" when there are no usable records, so an absent or empty metrics
    dir adds NOTHING to the prompt (no dangling header). This is why the block is
    rendered here rather than from attribute(), whose notes list is non-empty even
    on an empty dir.
    """
    recs = _iteration_records(loki_dir)
    if not recs:
        return ""

    s = attribute(loki_dir)
    lines = []

    # Per-iteration tail: the shape of the trend (getting slower? pricier?) is
    # what a model can actually steer on, and it is invisible in an aggregate.
    # Windowed to the last few so the block stays a few lines in EVERY prompt.
    tail = recs[-WINDOW:]
    for r in tail:
        it = r.get("iteration", "?")
        parts = []
        dur = r.get("duration_ms")
        if isinstance(dur, (int, float)) and dur >= 0:
            parts.append(_fmt_secs(dur))
        cost = r.get("cost_usd")
        if isinstance(cost, (int, float)):
            parts.append(f"${float(cost):.2f}")
        cread = r.get("cache_read_tokens")
        inp = r.get("input_tokens")
        if isinstance(cread, (int, float)) and isinstance(inp, (int, float)):
            denom = float(inp) + float(cread)
            if denom > 0:
                parts.append(f"cache {cread / denom:.0%}")
        st = str(r.get("status", "")).strip().lower()
        if st:
            parts.append(st)
        lines.append(f"  iter {it}: " + ", ".join(parts) if parts else f"  iter {it}")

    if not lines:
        return ""

    header = "EFFICIENCY TREND (your own last %d iteration(s); steer on it):" % len(tail)
    out = [header] + lines

    # The anti-incentive guard: spend never ships without the outcome split.
    prog = s["progress"]["count"]
    rew = s["rework"]["count"]
    total = s["iterations"]
    out.append(f"  progress {prog}/{total}, rework {rew}/{total}")
    share = s.get("rework_cost_share")
    if rew and share is not None:
        out.append(
            f"  {rew} iteration(s) failed and were repeated, costing {share:.0%} of the run. "
            "Cut rework by fixing what the gate flagged, NEVER by verifying less."
        )
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--loki-dir", default=".loki")
    ap.add_argument("--json", action="store_true")
    ap.add_argument(
        "--prompt-block",
        action="store_true",
        help="render the compact trend block for prompt injection (empty when no records)",
    )
    args = ap.parse_args()

    if args.prompt_block:
        block = prompt_block(args.loki_dir)
        if block:
            print(block)
        return 0

    s = attribute(args.loki_dir)
    if args.json:
        print(json.dumps(s, indent=2))
    else:
        print(_render(s))
    return 0


if __name__ == "__main__":
    sys.exit(main())
