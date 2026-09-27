#!/usr/bin/env python3
"""E-33: the Loki 10 gate report (run by EV-6 on real results).

Usage: gate_report.py <results.jsonl> --metrics <path> --changelog <path>

Writes the same block, between the loki10-gate begin/end markers, into both
files (appended when a file has no block; rerunning replaces it, so the output
is idempotent). The block opens with the marker E-31 reads:
    <!-- loki10-gate: met|missed n=<N> results_sha256=<sha> -->
N is the smaller evaluated count of the v10 and raw-claude arms.
Exit 0 when written (met or missed), 2 on bad input or a malformed block.
"""
import argparse
import hashlib
import json
import os
import sys

sys.dont_write_bytecode = True  # no __pycache__ next to the harness
sys.path.insert(0,os.path.dirname(os.path.abspath(__file__)))
from harness import arm_stats, dedupe, fmt, summarize_rows  # noqa: E402

BEGIN = "<!-- loki10-gate:begin -->"
END = "<!-- loki10-gate:end -->"
MIN_EVALUATED = 25
P50_MAX_S = 300
P90_MAX_S = 600
V10, RAW = "v10", "raw-claude"


def ok(flag):
    return "MET" if flag else "MISSED"


def rate(a):
    return "n/a" if a["completion_rate"] is None else "%.1f%%" % (100 * a["completion_rate"])


def cost(a):
    return "not measured" if a["cost_per_completed_usd"] is None else "$%.4f" % a["cost_per_completed_usd"]


def report(rows, sha):
    """Return (met, n, markdown body without the markers)."""
    shas = sorted({x.get("harness_sha") or "unknown" for x in rows})
    # The arms run at different times on a moving main, so harness_sha is
    # informational: one constant keeps both arms in one group per model and
    # lets dedupe keep the newest row per (task, arm).
    rows = [dict(x, harness_sha="any") for x in rows]
    groups = summarize_rows(rows)
    # ponytail: the gate reads the largest model group; more than one model
    # already fails the one-model precondition below.
    g = max(groups, key=lambda x: sum(a["runs"] for a in x["arms"].values())) if groups \
        else {"model": "none", "harness_sha": "none", "arms": {}, "misses": [], "invalid_tasks": []}
    v, r = (g["arms"].get(arm) or arm_stats([]) for arm in (V10, RAW))
    n = min(v["evaluated"], r["evaluated"])
    models = sorted({x.get("model") or "unknown" for x in rows})

    sample_ok = n >= MIN_EVALUATED
    one_ok = len(models) == 1
    comp_ok = v["completion_rate"] is not None and r["completion_rate"] is not None \
        and v["completion_rate"] >= r["completion_rate"]
    p50_ok = v["p50_time_to_pr_s"] is not None and v["p50_time_to_pr_s"] <= P50_MAX_S
    p90_ok = v["p90_time_to_pr_s"] is not None and v["p90_time_to_pr_s"] <= P90_MAX_S
    cost_ok = v["cost_per_completed_usd"] is not None and r["cost_per_completed_usd"] is not None \
        and v["cost_per_completed_usd"] <= r["cost_per_completed_usd"]
    met = all((sample_ok, one_ok, comp_ok, p50_ok, p90_ok, cost_ok))

    invalid = {t["task"] for t in g["invalid_tasks"]}
    slow = [x for x in dedupe(rows)
            if (x.get("model") or "unknown", x.get("harness_sha") or "unknown") == (g["model"], g["harness_sha"])
            and x.get("arm") == V10 and x.get("completed") and x.get("task") not in invalid
            and x.get("time_to_pr_s") is not None and x["time_to_pr_s"] > P90_MAX_S]

    out = ["### Loki 10 gate: %s" % ok(met).lower(), "",
           "Results sha256 `%s`; model %s; harness %s. Completion, time to PR and cost come from "
           "harness.summarize_rows (nearest-rank percentiles over completed runs; cost is "
           "provider-reported, not measured when any evaluated run lacks a figure)." % (sha, g["model"], ", ".join(shas) or "none"),
           "", "| Arm | Completed | Rate | p50 time to PR | p90 time to PR | Cost per completed | Cost measured |",
           "|---|---|---|---|---|---|---|"]
    for arm, a in g["arms"].items():
        out.append("| %s | %d/%d | %s | %s | %s | %s | %d/%d |" % (
            arm, a["completed"], a["evaluated"], rate(a), fmt(a["p50_time_to_pr_s"], "s"),
            fmt(a["p90_time_to_pr_s"], "s"), cost(a), a["cost_measured_runs"], a["evaluated"]))
    out += ["", "Preconditions:", "",
            "- Sample: v10 %d, raw-claude %d evaluated (need %d or more per arm): %s" % (
                v["evaluated"], r["evaluated"], MIN_EVALUATED,
                "MET" if sample_ok else "MISSED (fewer than %d)" % MIN_EVALUATED),
            "- One model across all rows: %s: %s" % (", ".join(models) or "none", ok(one_ok)),
            "", "| Gate | Measured | Threshold | Result |", "|---|---|---|---|",
            "| Completion rate (v10 vs raw-claude) | %s vs %s | v10 >= raw-claude | %s |" % (rate(v), rate(r), ok(comp_ok)),
            "| v10 p50 time to PR | %s | <= %ds | %s |" % (fmt(v["p50_time_to_pr_s"], "s"), P50_MAX_S, ok(p50_ok)),
            "| v10 p90 time to PR | %s | <= %ds | %s |" % (fmt(v["p90_time_to_pr_s"], "s"), P90_MAX_S, ok(p90_ok)),
            "| Cost per completed task (v10 vs raw-claude) | %s vs %s | both measured, v10 <= raw-claude | %s |" % (
                cost(v), cost(r), ok(cost_ok))]
    misses = ["- %s / %s: %s" % (m["task"], m["arm"], m["reason"]) for m in g["misses"]]
    misses += ["- %s / v10: time to PR %ss over %ds" % (x["task"], x["time_to_pr_s"], P90_MAX_S) for x in slow]
    misses += ["- %s: invalid task, excluded from every arm: %s" % (t["task"], t["reason"]) for t in g["invalid_tasks"]]
    out += ["", "Misses (%d):" % len(misses), ""] + (misses or ["- none"])
    others = [x for x in groups if x is not g]
    if others:
        out += ["", "Result groups outside the gate:", ""] + [
            "- model %s: %d runs" % (x["model"], sum(a["runs"] for a in x["arms"].values()))
            for x in others]
    return met, n, "\n".join(out)


def splice(text, block):
    """Replace the one begin/end block in text, or append it. ValueError when malformed."""
    b, e = text.count(BEGIN), text.count(END)
    if b == 0 and e == 0:
        if text and not text.endswith("\n"):
            text += "\n"
        return text + ("\n" if text else "") + block + "\n"
    i, j = text.find(BEGIN), text.find(END)
    if b != 1 or e != 1 or j < i:
        raise ValueError("expected exactly one %s before one %s" % (BEGIN, END))
    return text[:i] + block + text[j + len(END):]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("results")
    ap.add_argument("--metrics", required=True)
    ap.add_argument("--changelog", required=True)
    a = ap.parse_args(argv)
    try:
        with open(a.results, "rb") as f:
            raw = f.read()
        rows = [json.loads(ln) for ln in raw.decode("utf-8").splitlines() if ln.strip()]
    except (OSError, ValueError) as e:
        print("error: cannot read results: %s" % e, file=sys.stderr)
        return 2
    sha = hashlib.sha256(raw).hexdigest()
    met, n, body = report(rows, sha)
    marker = "<!-- loki10-gate: %s n=%d results_sha256=%s -->" % ("met" if met else "missed", n, sha)
    block = "\n".join((BEGIN, marker, "", body, "", END))
    # Validate both targets before writing either, so a refusal writes nothing.
    new = {}
    for path in (a.metrics, a.changelog):
        try:
            with open(path, encoding="utf-8") as f:
                text = f.read()
        except FileNotFoundError:
            text = ""
        try:
            new[path] = splice(text, block)
        except ValueError as e:
            print("error: %s: %s" % (path, e), file=sys.stderr)
            return 2
    for path, text in new.items():
        tmp = path + ".gate-tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    print(marker)
    return 0


if __name__ == "__main__":
    sys.exit(main())
