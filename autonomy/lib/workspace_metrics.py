#!/usr/bin/env python3
"""loki workspace metrics: PRs per wall-clock hour and per attention minute (D51-B15).

    python3 workspace_metrics.py <integration.json | run-dir> [--attention-min N]

Reads the per-repo `timing` ({repo: {started_at, finished_at}} in epoch
seconds) that `loki workspace run` records in integration.json. A PR is a repo
whose outcome is "ok". Wall clock is the earliest start to the latest finish.
A run without timestamps (an older integration.json, or a repo missing its
timing) is reported as "unmeasured", never as zero. Attention minutes are the
human minutes the operator spent; they are not recorded by the runner, so the
per-attention rate is "unmeasured" unless --attention-min is given.
"""
import json
import os
import sys

UNMEASURED = "unmeasured"


def compute(ev, attention_min=None):
    """Return a dict of metric name -> number or UNMEASURED."""
    outcomes = ev.get("outcomes") or {}
    timing = ev.get("timing") or {}
    ok_repos = [r for r, o in outcomes.items() if o == "ok"]
    out = {"prs": len(ok_repos), "wall_clock_seconds": UNMEASURED,
           "prs_per_hour": UNMEASURED, "prs_per_attention_minute": UNMEASURED}

    spans = []
    complete = bool(timing) and all(
        isinstance(timing.get(r), dict)
        and isinstance(timing[r].get("started_at"), (int, float))
        and isinstance(timing[r].get("finished_at"), (int, float))
        for r in ok_repos)
    if complete:
        for t in timing.values():
            if isinstance(t, dict) and isinstance(t.get("started_at"), (int, float)) \
                    and isinstance(t.get("finished_at"), (int, float)):
                spans.append((t["started_at"], t["finished_at"]))
    wall = (max(f for _, f in spans) - min(s for s, _ in spans)) if spans else None
    if wall is not None and wall > 0:
        out["wall_clock_seconds"] = round(wall, 1)
        out["prs_per_hour"] = out["prs"] / (wall / 3600.0)
    if out["prs_per_hour"] != UNMEASURED and attention_min is not None and attention_min > 0:
        out["prs_per_attention_minute"] = out["prs"] / attention_min
    return out


def _fmt(key, val):
    if val == UNMEASURED or key in ("prs", "wall_clock_seconds"):
        return str(val)
    return "%.4f" % val if key == "prs_per_attention_minute" else "%.2f" % val


def main(argv):
    attention = None
    args = list(argv)
    if "--attention-min" in args:
        i = args.index("--attention-min")
        try:
            attention = float(args[i + 1])
            del args[i:i + 2]
        except (IndexError, ValueError):
            print("workspace_metrics: --attention-min needs a number")
            return 2
    if len(args) != 1:
        print("Usage: workspace_metrics.py <integration.json | run-dir> [--attention-min N]")
        return 2
    path = args[0]
    if os.path.isdir(path):
        path = os.path.join(path, "integration.json")
    try:
        with open(path) as f:
            ev = json.load(f)
    except (OSError, ValueError) as e:
        print("workspace_metrics: cannot read %s: %s" % (path, e))
        return 2
    res = compute(ev, attention)
    for key in ("prs", "wall_clock_seconds", "prs_per_hour", "prs_per_attention_minute"):
        print("%s: %s" % (key, _fmt(key, res[key])))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
