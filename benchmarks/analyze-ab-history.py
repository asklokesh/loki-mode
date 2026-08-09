#!/usr/bin/env python3
"""Analyse benchmarks/results/ab-history.jsonl with tests valid at tiny n.

WHY THIS EXISTS. The A/B harness records trials faithfully and nothing ever
computed a statistic from them. Eleven runs sat unanalysed, and eyeballing
medians produced exactly the two errors this script exists to prevent.

ERROR 1 -- A LARGE MEDIAN GAP THAT IS NOT SIGNIFICANT.
Wall clock reads v7 791s vs v8 524s, a 1.51x gap that looks decisive. The
ranges OVERLAP (v7 614-1123, v8 414-620) and an exact permutation test gives
p = 0.057 at n=3/4. Reporting "1.51x faster" from that would be a typed
multiplier the data does not support.

ERROR 2 -- THE WRONG TEST HIDING A REAL EFFECT.
Act iterations are perfectly separated: v7 is 7 in every run, v8 is 1 in every
run. A median-difference permutation test on that gives p = 0.486, which reads
as "no effect" and is nonsense -- with constant, fully separated arms nearly
every permutation reproduces a similar median gap, so the statistic has almost
no power. A rank-sum statistic on the same data gives p = 0.0286, which is the
SMALLEST p achievable at n=3 vs n=4 (1/35). The effect was always there; the
first test could not see it.

So this script reports BOTH statistics and says which one to believe, rather
than picking one and hiding the disagreement. Exact permutation throughout --
no normal approximation, which is invalid at these sample sizes.

Usage:  python3 benchmarks/analyze-ab-history.py [--json]
Exit:   0 always (an analysis is not a gate); 2 if the history is unreadable.
"""

import itertools
import json
import os
import statistics as st
import sys

HISTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "results", "ab-history.jsonl")


def classify(row):
    """Map a row to its arm. Labels are the ground truth; `arm` is often absent."""
    label = (row.get("label") or "")
    if label.startswith("v7"):
        return "v7"
    if label.startswith("v8fix") or label.startswith("v8final"):
        return "v8"
    if label.startswith("agnostic"):
        return "agnostic"
    return row.get("arm") or "unclassified"


def _avg_ranks(pool):
    ordered = sorted(pool)
    ranks = {}
    for value in set(ordered):
        idx = [i + 1 for i, v in enumerate(ordered) if v == value]
        ranks[value] = sum(idx) / len(idx)
    return ranks


def exact_permutation(a, b, statistic):
    """Two-sided exact p for `statistic`, enumerating every split.

    Exact rather than approximate on purpose: with n of 3 and 4 there are 35
    splits, so the null distribution can be enumerated completely and a normal
    approximation would be meaningless.
    """
    pool = list(a) + list(b)
    n = len(a)
    observed = abs(statistic(a, b, pool))
    hits = total = 0
    for combo in itertools.combinations(range(len(pool)), n):
        x = [pool[i] for i in combo]
        y = [pool[i] for i in range(len(pool)) if i not in combo]
        if abs(statistic(x, y, pool)) >= observed:
            hits += 1
        total += 1
    return hits / total if total else 1.0, total


def _median_diff(x, y, _pool):
    return st.median(x) - st.median(y)


def _rank_sum(x, _y, pool):
    ranks = _avg_ranks(pool)
    # Centred so the statistic is symmetric under relabelling, which the
    # two-sided enumeration above assumes.
    expected = len(x) * (len(pool) + 1) / 2
    return sum(ranks[v] for v in x) - expected


def analyse(metric, a, b):
    """Both statistics on one metric, plus which to believe and why."""
    if len(a) < 2 or len(b) < 2:
        return {"metric": metric, "verdict": "UNDERPOWERED",
                "reason": "fewer than 2 trials in an arm; no test is meaningful"}
    p_med, splits = exact_permutation(a, b, _median_diff)
    p_rank, _ = exact_permutation(a, b, _rank_sum)
    separated = min(a) > max(b) or min(b) > max(a)
    floor = 2.0 / splits  # smallest two-sided p this design can produce
    out = {
        "metric": metric,
        "n": [len(a), len(b)],
        "median": [st.median(a), st.median(b)],
        "range": [[min(a), max(a)], [min(b), max(b)]],
        "ranges_overlap": not separated,
        "p_median_diff": round(p_med, 4),
        "p_rank_sum": round(p_rank, 4),
        "p_floor_at_this_n": round(floor, 4),
    }
    if separated:
        out["believe"] = "p_rank_sum"
        out["reason"] = (
            "The arms are COMPLETELY SEPARATED. A median-difference test is "
            "near-powerless on separated constant data -- almost every "
            "permutation reproduces a similar gap -- so its p is misleadingly "
            "high. The rank statistic is the one that can see separation.")
        out["verdict"] = "SIGNIFICANT" if p_rank <= 0.05 else "UNDERPOWERED"
    else:
        out["believe"] = "p_median_diff"
        out["reason"] = (
            "The ranges overlap, so no claim of separation is available. The "
            "median-difference test is the honest summary; a rank statistic "
            "would not rescue it.")
        out["verdict"] = "SIGNIFICANT" if p_med <= 0.05 else "NOT SIGNIFICANT"
    if out["verdict"] != "SIGNIFICANT" and abs(floor - p_med) < 1e-9:
        out["note"] = ("p equals the floor for this design: even a perfect "
                       "result could not clear alpha at this sample size.")
    return out


def main():
    as_json = "--json" in sys.argv
    try:
        with open(HISTORY) as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
    except (OSError, json.JSONDecodeError) as exc:
        print("cannot read %s: %s" % (HISTORY, exc), file=sys.stderr)
        return 2

    arms = {}
    skipped = 0
    for row in rows:
        # A row with `missing` recorded a harness failure, not a trial. Counting
        # it as a data point would let a hung harness masquerade as a slow arm.
        if row.get("missing") or row.get("wall_clock_s") is None:
            skipped += 1
            continue
        arms.setdefault(classify(row), []).append(row)

    report = {"source": os.path.relpath(HISTORY), "rows_total": len(rows),
              "rows_skipped_as_harness_failures": skipped, "arms": {}, "tests": []}
    for name, rs in sorted(arms.items()):
        report["arms"][name] = {
            "n": len(rs),
            "wall_clock_s": sorted(r["wall_clock_s"] for r in rs),
            "act_iterations": sorted(r["act_iterations"] for r in rs
                                     if r.get("act_iterations") is not None),
        }

    if "v7" in arms and "v8" in arms:
        for metric, key in (("wall_clock_s", "wall_clock_s"),
                            ("act_iterations", "act_iterations")):
            a = [r[key] for r in arms["v7"] if r.get(key) is not None]
            b = [r[key] for r in arms["v8"] if r.get(key) is not None]
            if a and b:
                report["tests"].append(analyse(metric, a, b))

    report["not_claimed"] = (
        "No multiplier is reported. A median ratio without a significant test "
        "is a typed number, not a measurement, and these sample sizes (3 and 4) "
        "put the smallest achievable two-sided p at 0.057 for an overlapping "
        "metric. Arms differ by engine version on the same spec, model and "
        "machine; nothing here compares Loki to another vendor.")

    if as_json:
        print(json.dumps(report, indent=1))
        return 0

    print("A/B history: %d rows (%d skipped as harness failures)"
          % (report["rows_total"], skipped))
    for name, info in report["arms"].items():
        print("  %-12s n=%d  wall_s=%s  act_iters=%s"
              % (name, info["n"], info["wall_clock_s"], info["act_iterations"]))
    print()
    for t in report["tests"]:
        if t.get("verdict") == "UNDERPOWERED" and "n" not in t:
            print("  %-16s %s -- %s" % (t["metric"], t["verdict"], t["reason"]))
            continue
        print("  %s: medians %s, ranges %s%s"
              % (t["metric"], t["median"], t["range"],
                 "  (SEPARATED)" if not t["ranges_overlap"] else ""))
        print("    p_median_diff=%.4f  p_rank_sum=%.4f  floor=%.4f"
              % (t["p_median_diff"], t["p_rank_sum"], t["p_floor_at_this_n"]))
        print("    believe %s -> %s" % (t["believe"], t["verdict"]))
        print("    %s" % t["reason"])
        if "note" in t:
            print("    %s" % t["note"])
        print()
    print("  NOT CLAIMED: %s" % report["not_claimed"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
