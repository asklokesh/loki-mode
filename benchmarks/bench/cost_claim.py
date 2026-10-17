#!/usr/bin/env python3
"""Cost claim verdict: PROVEN_AT(target) or NOT PROVEN.

Pure function over per-row results for a Loki arm and a floor arm. The claim is
about the cost-per-accepted ratio (loki / floor). A paired bootstrap over tasks
(fixed seed) gives the 95% CI; the claim is gated on the CI upper bound, never
the point estimate.

Row shape (dict): task_id, accepted (bool), cost_usd (float), and optionally
cost_partial (bool), unmeasured (bool), engine (str), loki_version (str).
Rows may also carry elapsed_s; the verdict adds an informational paired time
ratio (floor / loki, above 1 means loki is faster) with the same bootstrap CI.
Rows without a usable elapsed_s are excluded from it and counted. The time
ratio never changes the verdict.
Unmeasured rows are excluded; their count is reported and, when the verdict is
NOT PROVEN, listed among the reasons.

No emojis. No em dashes.
"""

import argparse
import json
import math
import random
import sys

MIN_N_PER_TASK = 3
BOOTSTRAP_ITERS = 2000
DEFAULT_SEED = 20261016


def _cpa(rows):
    """Cost per accepted task over rows; None when nothing was accepted."""
    accepted = sum(1 for r in rows if r.get("accepted"))
    if accepted == 0:
        return None
    return sum(float(r.get("cost_usd") or 0.0) for r in rows) / accepted


def _group(rows):
    by_task = {}
    for r in rows:
        by_task.setdefault(r.get("task_id"), []).append(r)
    return by_task


def _percentile(sorted_vals, q):
    idx = q * (len(sorted_vals) - 1)
    lo = int(idx)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (idx - lo)


def bootstrap_ratio_ci(loki_rows, floor_rows, seed=DEFAULT_SEED,
                       iters=BOOTSTRAP_ITERS):
    """Paired bootstrap over tasks. Returns (point, lo, hi) or None."""
    lg, fg = _group(loki_rows), _group(floor_rows)
    tasks = sorted((t for t in lg if t in fg), key=str)
    point_l, point_f = _cpa(loki_rows), _cpa(floor_rows)
    if not tasks or point_l is None or not point_f:
        return None
    rng = random.Random(seed)
    ratios = []
    for _ in range(iters):
        pick = [tasks[rng.randrange(len(tasks))] for _ in tasks]
        a = _cpa([r for t in pick for r in lg[t]])
        b = _cpa([r for t in pick for r in fg[t]])
        if a is None or not b:
            continue
        ratios.append(a / b)
    if not ratios:
        return None
    ratios.sort()
    return (point_l / point_f, _percentile(ratios, 0.025),
            _percentile(ratios, 0.975))


def _has_elapsed(r):
    v = r.get("elapsed_s")
    return (isinstance(v, (int, float)) and not isinstance(v, bool)
            and math.isfinite(v) and v >= 0)


def _mean_elapsed(rows):
    """Mean elapsed_s over rows; None when there are no rows."""
    return sum(r["elapsed_s"] for r in rows) / len(rows) if rows else None


def bootstrap_time_ratio_ci(loki_rows, floor_rows, seed=DEFAULT_SEED,
                            iters=BOOTSTRAP_ITERS):
    """Paired bootstrap of mean elapsed_s, floor / loki. (point, lo, hi) or None.

    Only rows with a usable elapsed_s count, and only tasks timed in both arms.
    """
    lg = _group([r for r in loki_rows if _has_elapsed(r)])
    fg = _group([r for r in floor_rows if _has_elapsed(r)])
    tasks = sorted((t for t in lg if t in fg), key=str)
    if not tasks:
        return None
    point_l = _mean_elapsed([r for t in tasks for r in lg[t]])
    point_f = _mean_elapsed([r for t in tasks for r in fg[t]])
    if not point_l or point_f is None:
        return None
    rng = random.Random(seed)
    ratios = []
    for _ in range(iters):
        pick = [tasks[rng.randrange(len(tasks))] for _ in tasks]
        a = _mean_elapsed([r for t in pick for r in lg[t]])
        b = _mean_elapsed([r for t in pick for r in fg[t]])
        if not a:
            continue
        ratios.append(b / a)
    if not ratios:
        return None
    ratios.sort()
    return (point_f / point_l, _percentile(ratios, 0.025),
            _percentile(ratios, 0.975))


def _acc_rate(rows):
    return sum(1 for r in rows if r.get("accepted")) / len(rows) if rows else 0.0


def cost_claim_verdict(loki_rows, floor_rows, target, seed=DEFAULT_SEED,
                       iters=BOOTSTRAP_ITERS):
    """Return {verdict, target, ratio, ci_low, ci_high, unmeasured, reasons}."""
    reasons = []
    unmeasured = sum(1 for r in list(loki_rows) + list(floor_rows)
                     if r.get("unmeasured"))
    loki = [r for r in loki_rows if not r.get("unmeasured")]
    floor = [r for r in floor_rows if not r.get("unmeasured")]
    rows = loki + floor

    if not loki or not floor:
        reasons.append("no_data: an arm has no measured rows")
    if any(r.get("cost_partial") for r in rows):
        reasons.append("partial: cost_partial row present")

    engines = {r.get("engine") for r in rows}
    versions = {r.get("loki_version") for r in rows}
    if None in engines or len(engines) > 1:
        reasons.append("engine: missing or mixed engine")
    if None in versions or len(versions) > 1:
        reasons.append("version: missing or mixed loki_version")

    for name, arm in (("loki", loki), ("floor", floor)):
        small = sorted(str(t) for t, g in _group(arm).items()
                       if len(g) < MIN_N_PER_TASK)
        if small:
            reasons.append("n: %s has fewer than %d runs for %s"
                           % (name, MIN_N_PER_TASK, ",".join(small)))

    if loki and floor and _acc_rate(loki) < _acc_rate(floor):
        reasons.append("acceptance: loki %.3f below floor %.3f"
                       % (_acc_rate(loki), _acc_rate(floor)))

    ci = bootstrap_ratio_ci(loki, floor, seed, iters) if loki and floor else None
    ratio = lo = hi = None
    if ci:
        ratio, lo, hi = ci
        if hi > target:
            reasons.append("ci: upper bound %.4f exceeds target %s"
                           % (hi, target))
    elif loki and floor:
        reasons.append("ci: not computable (no accepted work or no paired tasks)")

    time_excluded = sum(1 for r in rows if not _has_elapsed(r))
    tci = bootstrap_time_ratio_ci(loki, floor, seed, iters)

    if reasons and unmeasured:
        reasons.append("unmeasured: %d row(s) excluded" % unmeasured)

    return {
        "verdict": ("PROVEN_AT(%s)" % target) if not reasons else "NOT PROVEN",
        "target": target,
        "ratio": ratio,
        "ci_low": lo,
        "ci_high": hi,
        "unmeasured": unmeasured,
        "reasons": reasons,
        "time_ratio": tci[0] if tci else None,
        "time_ci": [tci[1], tci[2]] if tci else None,
        "time_rows_excluded": time_excluded,
    }


def _map_row(r):
    """Attribution row to verdict row."""
    out = dict(r)
    out["task_id"] = r.get("task")
    if r.get("status") in ("unmeasured", "harness_error"):
        out["unmeasured"] = True
    return out


def _load_rows(paths):
    """Return (object rows, count of non-object rows skipped)."""
    rows = []
    skipped = 0
    for p in paths:
        with open(p) as f:
            for line in f:
                if line.strip():
                    r = json.loads(line)
                    if isinstance(r, dict):
                        rows.append(r)
                    else:
                        skipped += 1
    return rows, skipped


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Cost claim verdict over attribution rows")
    ap.add_argument("--rows", nargs="+", required=True)
    ap.add_argument("--loki-arm", required=True)
    ap.add_argument("--floor-arm", required=True)
    ap.add_argument("--target", type=float, required=True)
    ap.add_argument("--exclude-task", action="append", default=[])
    try:
        a = ap.parse_args(argv)
        rows, skipped = _load_rows(a.rows)
    except SystemExit as e:
        return 2 if e.code else 0
    except (OSError, ValueError) as e:
        print("usage error: %s" % e, file=sys.stderr)
        return 2
    if skipped:
        print("warning: skipped %d non-object row(s)" % skipped,
              file=sys.stderr)
    excl = set(a.exclude_task)
    rows = [_map_row(r) for r in rows if r.get("task") not in excl]
    loki = [r for r in rows if r.get("arm") == a.loki_arm]
    floor = [r for r in rows if r.get("arm") == a.floor_arm]
    v = cost_claim_verdict(loki, floor, a.target)
    v["excluded_tasks"] = sorted(excl)
    v["skipped_non_object_rows"] = skipped
    print(json.dumps(v, indent=2, sort_keys=True))
    return 0 if v["verdict"].startswith("PROVEN_AT") else 1


if __name__ == "__main__":
    sys.exit(main())
