#!/usr/bin/env python3
"""Analyse benchmarks/results/prompt-ablation.jsonl.

THE QUESTION. LOKI_SIMPLE=1 cuts the assembled prompt by 78%. That is a TOKEN
measurement and it licenses no claim about outcomes. This answers the only
question that matters: does the stripped arm still build the thing, and does it
take more or fewer iterations to do it?

RELATIONSHIP TO report-prompt-ablation.py, WHICH ALREADY EXISTED. That script
is DESCRIPTIVE: medians with spread, and an explicit "NO DIFFERENCE
DEMONSTRATED" verdict whenever the arms overlap. It is not redundant with this
one and it should be read first -- it reaches the correct conclusion on this
dataset by refusing to claim on overlapping ranges, which is the right default.

This script is INFERENTIAL and adds four things that one does not compute:
exact-permutation p-values, the DESIGN FLOOR (the smallest p the sample size
can produce, which is what stopped an 18% speed claim at n=3), a rank-sum
statistic for the separated case where a median test is near-powerless, and a
DISPERSION test with MAD -- added after a 9.6x range difference here turned out
to be one outlier (MAD 31s vs 35s, p=0.80). It also reads `acceptance`, the
per-artifact check, which the descriptive report does not.

If the two ever disagree, the descriptive one is the safer default: a null it
reports is a null. A p-value from this script that contradicts an overlap
verdict there means the statistic was chosen badly, not that a finding was
uncovered.

WHY THIS IS NOT analyze-ab-history.py. That script compares ENGINE VERSIONS and
its metrics are speed-shaped. Here the arms are one environment variable in one
binary, and the load-bearing metric is not speed at all -- it is ACCEPTANCE. A
prompt ablation that runs 20% faster while completing fewer builds is a
regression that a speed-only summary would report as a win, so acceptance is
checked FIRST and a drop there is fatal regardless of every timing number.

The statistical method is inherited deliberately, because the same tiny-n trap
applies: a median-difference permutation test is near-powerless on separated
constant data, so both it and a rank-sum statistic are reported with the reason
one was believed. See the header of analyze-ab-history.py for the worked case
where the two disagree (p 0.486 vs 0.0286 on identical data).

Usage:  python3 benchmarks/analyze-prompt-ablation.py [--json]
Exit:   0 always (an analysis is not a gate); 2 if the history is unreadable.
"""

import itertools
import json
import os
import statistics as st
import sys

HISTORY = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "results", "prompt-ablation.jsonl")


def _accepted(row):
    """True only when EVERY recorded acceptance check passed.

    The harness records acceptance as a DICT of named checks --
    {"greet.js_exists": true} -- not a boolean. Treating that dict as a truthy
    scalar would count a run where every check FAILED as accepted, because a
    non-empty dict is truthy in Python; testing it against True would count
    every run as unaccepted. Both errors are silent and both would make the
    acceptance verdict, which gates the whole analysis, meaningless.

    An empty dict is NOT acceptance: no checks recorded is an absent
    measurement, not a pass.
    """
    acc = row.get("acceptance")
    if isinstance(acc, dict):
        # spec_acceptance_unmatched means the harness had NO acceptance check
        # for that spec and fell back to generic "something was produced"
        # signals. Those cannot establish a spec-level pass, and the flag is
        # itself truthy -- so an all-values-truthy test would count an
        # UNCHECKED run as accepted. That is the exact mirror of the false
        # negative this flag was added to prevent, so it is refused here.
        # Every one of these means "we did not measure this run", and each is
        # a TRUTHY value that the all-values test below would read as a pass.
        # Three separate variants of that trap have now appeared in this file;
        # they are listed together so the next one is added here rather than
        # rediscovered by shipping a wrong number.
        for _unmeasured in ("spec_acceptance_unmatched", "spec_unreadable"):
            if acc.get(_unmeasured):
                return False
        # A grader that could not RUN measured nothing. Counting it either way
        # blames or credits the build for a harness fault.
        if "grader_error" in acc:
            return False
        # When a held-out grader ran, IT is the verdict. The diagnostic strings
        # beside it (grader_stderr) are non-empty and would otherwise be read
        # as truthy checks by the all-values test below.
        if "graded" in acc:
            return bool(acc["graded"])
        return bool(acc) and all(bool(v) for v in acc.values())
    if isinstance(acc, bool):
        return acc
    if isinstance(acc, str):
        return acc.strip().lower() in ("pass", "true", "ok")
    return False


def _avg_ranks(pool):
    ordered = sorted(pool)
    out = {}
    for value in set(ordered):
        idx = [i + 1 for i, v in enumerate(ordered) if v == value]
        out[value] = sum(idx) / len(idx)
    return out


def exact_permutation(a, b, statistic):
    """Two-sided exact p, enumerating every split. No normal approximation."""
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
    return (hits / total if total else 1.0), total


def _median_diff(x, y, _pool):
    return st.median(x) - st.median(y)


def _rank_sum(x, _y, pool):
    ranks = _avg_ranks(pool)
    expected = len(x) * (len(pool) + 1) / 2
    return sum(ranks[v] for v in x) - expected


def _mad(x):
    """Median absolute deviation -- a dispersion statistic ONE outlier cannot move.

    Range and standard deviation are both outlier-driven, and this dataset
    proves why that matters: the simple arm's range was 9.6x the full arm's,
    which read as a dramatic variance effect. It came entirely from a single
    1330s run. MAD reports 31s vs 35s on the same data. A claim that survives
    range but not MAD is a claim about one trial, not about the arm.
    """
    m = st.median(x)
    return st.median([abs(v - m) for v in x])


def dispersion(metric, a, b):
    """Is the SPREAD different? Reported for every metric, three ways.

    A location test returning null does not mean the arms behave the same --
    an arm can share a median and still be wildly less predictable, which
    matters more than speed for a build tool. But dispersion is exactly where
    a non-robust statistic invents effects, so all three are reported and MAD
    is the one to believe.
    """
    if len(a) < 3 or len(b) < 3:
        return {"metric": metric, "verdict": "UNDERPOWERED",
                "reason": "dispersion needs at least 3 trials per arm"}
    out = {"metric": metric}
    for name, stat in (("range", lambda x: max(x) - min(x)),
                       ("stdev", st.pstdev),
                       ("mad", _mad)):
        p, splits = exact_permutation(a, b, lambda x, y, _p, s=stat: s(x) - s(y))
        out["%s_full" % name] = round(stat(a), 1)
        out["%s_simple" % name] = round(stat(b), 1)
        out["p_%s" % name] = round(p, 4)
        out["p_floor_at_this_n"] = round(2.0 / splits, 4)
    out["believe"] = "p_mad"
    out["verdict"] = "SIGNIFICANT" if out["p_mad"] <= 0.05 else "NOT SIGNIFICANT"
    out["reason"] = ("MAD is robust to a single slow run; range and stdev are "
                     "not, and a difference visible only in those is a claim "
                     "about one trial")
    return out


def compare(metric, a, b):
    if len(a) < 2 or len(b) < 2:
        return {"metric": metric, "verdict": "UNDERPOWERED",
                "reason": "fewer than 2 trials in an arm; no test is meaningful",
                "n": [len(a), len(b)]}
    p_med, splits = exact_permutation(a, b, _median_diff)
    p_rank, _ = exact_permutation(a, b, _rank_sum)
    separated = min(a) > max(b) or min(b) > max(a)
    out = {
        "metric": metric, "n": [len(a), len(b)],
        "median": [st.median(a), st.median(b)],
        "range": [[min(a), max(a)], [min(b), max(b)]],
        "ranges_overlap": not separated,
        "p_median_diff": round(p_med, 4),
        "p_rank_sum": round(p_rank, 4),
        "p_floor_at_this_n": round(2.0 / splits, 4),
    }
    if separated:
        out["believe"] = "p_rank_sum"
        out["reason"] = ("arms are completely separated; a median-difference "
                         "test is near-powerless on separated constant data")
        out["verdict"] = "SIGNIFICANT" if p_rank <= 0.05 else "UNDERPOWERED"
    else:
        out["believe"] = "p_median_diff"
        out["reason"] = ("ranges overlap, so no separation claim is available; "
                         "a rank statistic would not rescue it")
        out["verdict"] = "SIGNIFICANT" if p_med <= 0.05 else "NOT SIGNIFICANT"
    return out


def main():
    as_json = "--json" in sys.argv
    try:
        with open(HISTORY) as fh:
            rows = [json.loads(line) for line in fh if line.strip()]
    except FileNotFoundError:
        print("no prompt-ablation.jsonl yet -- run "
              "benchmarks/run-prompt-ablation.sh first", file=sys.stderr)
        return 2
    except (OSError, json.JSONDecodeError) as exc:
        print("cannot read %s: %s" % (HISTORY, exc), file=sys.stderr)
        return 2

    arms = {}
    for row in rows:
        # The engine stamps prompt_arm from its OWN environment. Trust that over
        # the harness label: if they ever disagree the attribution is wrong, and
        # averaging the two arms would silently corrupt every median below.
        arm = row.get("prompt_arm") or row.get("arm")
        if not arm or row.get("wall_clock_s") is None:
            continue
        arms.setdefault(arm, []).append(row)

    report = {"source": os.path.relpath(HISTORY), "rows_total": len(rows),
              "arms": {}, "acceptance": {}, "tests": []}
    for name, rs in sorted(arms.items()):
        report["arms"][name] = {
            "n": len(rs),
            "wall_clock_s": sorted(r["wall_clock_s"] for r in rs),
            "act_iterations": sorted(r["act_iterations"] for r in rs
                                     if r.get("act_iterations") is not None),
        }
        accepted = sum(1 for r in rs if _accepted(r))
        report["acceptance"][name] = {"accepted": accepted, "of": len(rs)}

    # ACCEPTANCE FIRST. A faster arm that completes fewer builds is a
    # regression, and a speed-only summary would report it as a win.
    if len(report["acceptance"]) == 2:
        (n1, a1), (n2, a2) = sorted(report["acceptance"].items())
        if a1["accepted"] != a2["accepted"]:
            report["acceptance_verdict"] = (
                "DIFFERS: %s %d/%d vs %s %d/%d. Timing comparisons below are "
                "NOT a summary of this run -- an arm that completes fewer "
                "builds has regressed regardless of how fast it was."
                % (n1, a1["accepted"], a1["of"], n2, a2["accepted"], a2["of"]))
        else:
            report["acceptance_verdict"] = (
                "EQUAL: both arms %d/%d. Timing comparisons below are "
                "meaningful because the arms built comparable outcomes."
                % (a1["accepted"], a1["of"]))

    if len(arms) == 2:
        (na, ra), (nb, rb) = sorted(arms.items())
        report["arm_order"] = [na, nb]
        for metric in ("wall_clock_s", "act_iterations"):
            a = [r[metric] for r in ra if r.get(metric) is not None]
            b = [r[metric] for r in rb if r.get(metric) is not None]
            if a and b:
                report["tests"].append(compare(metric, a, b))
                # A null LOCATION result is not "no difference": the arms can
                # share a median and differ in predictability. Checked for
                # every metric so that question is never left unasked.
                report.setdefault("dispersion", []).append(
                    dispersion(metric, a, b))

    report["not_claimed"] = (
        "No multiplier is reported. The 78% prompt reduction is a TOKEN "
        "measurement and says nothing about outcomes; only the acceptance and "
        "iteration results below speak to behaviour. Arms differ by one "
        "environment variable in one binary on one machine -- nothing here "
        "compares Loki to another vendor.")

    if as_json:
        print(json.dumps(report, indent=1))
        return 0

    print("prompt ablation: %d rows" % report["rows_total"])
    for name, info in report["arms"].items():
        acc = report["acceptance"].get(name, {})
        print("  %-8s n=%d  accepted=%s/%s  wall_s=%s  act_iters=%s"
              % (name, info["n"], acc.get("accepted", "?"), acc.get("of", "?"),
                 info["wall_clock_s"], info["act_iterations"]))
    if "acceptance_verdict" in report:
        print("\n  ACCEPTANCE: %s" % report["acceptance_verdict"])
    print()
    for t in report["tests"]:
        if "median" not in t:
            print("  %-16s %s -- %s" % (t["metric"], t["verdict"], t["reason"]))
            continue
        print("  %s: medians %s, ranges %s%s"
              % (t["metric"], t["median"], t["range"],
                 "  (SEPARATED)" if not t["ranges_overlap"] else ""))
        print("    p_median_diff=%.4f  p_rank_sum=%.4f  floor=%.4f"
              % (t["p_median_diff"], t["p_rank_sum"], t["p_floor_at_this_n"]))
        print("    believe %s -> %s  (%s)" % (t["believe"], t["verdict"], t["reason"]))
        print()
    for d in report.get("dispersion", []):
        if "p_mad" not in d:
            print("  dispersion %-14s %s -- %s" % (d["metric"], d["verdict"], d["reason"]))
            continue
        print("  dispersion %s: range %s/%s (p=%.4f)  stdev %s/%s (p=%.4f)  "
              "MAD %s/%s (p=%.4f)"
              % (d["metric"], d["range_full"], d["range_simple"], d["p_range"],
                 d["stdev_full"], d["stdev_simple"], d["p_stdev"],
                 d["mad_full"], d["mad_simple"], d["p_mad"]))
        print("    believe p_mad -> %s  (%s)" % (d["verdict"], d["reason"]))
    print()
    print("  NOT CLAIMED: %s" % report["not_claimed"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
