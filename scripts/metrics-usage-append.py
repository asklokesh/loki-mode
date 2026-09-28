#!/usr/bin/env python3
"""Append one usage-governor snapshot to docs/v10/METRICS.md (founder 2026-09-28).

Runs scripts/usage-governor.py --json and inserts a dated block directly under
the "## Usage (hourly, from scripts/usage-governor.py)" header, newest first.
Usage: python3 scripts/metrics-usage-append.py [--json FILE] [--metrics FILE]
"""
import argparse
import json
import os
import subprocess
import sys

HEADER = "## Usage (hourly, from scripts/usage-governor.py)"


def fmt(n):
    return "n/a" if n is None else f"{n:,.0f}" if isinstance(n, (int, float)) else str(n)


def render(d):
    g, w, wk, t = d["governor"], d["window"], d["weekly"], d["totals"]
    pct = lambda x: "uncalibrated" if x.get("current_pct") is None else f"{x['current_pct']:.1f}%"
    lines = [
        f"### {d['generated_at'][:16]}Z",
        f"- 5h window: {pct(w)}, {fmt(w['current_tokens_output'])} output tokens since {w['start'][:16]}Z ({w['source']})",
        f"- Weekly: {pct(wk)}, {fmt(wk['current_tokens_output'])} output tokens, {g['hours_to_weekly_reset']:.1f}h to reset ({wk['source']})",
        f"- Last hour: {fmt(g['last_hour_output_tokens'])} output tokens; {g['active_engineers_last_hour']} active engineers; "
        f"{fmt(g['burn_per_engineer_output_last_hour'])} per engineer; Chief of Staff {fmt(g['chief_of_staff_burn_output_last_hour'])}",
        f"- Max engineers next hour: {'uncalibrated (no plan reading on file)' if g['max_engineers_next_hour'] is None else g['max_engineers_next_hour']}",
    ]
    by_model = {m: v["output_tokens"] for m, v in t["by_model"].items() if v["output_tokens"]}
    total = sum(by_model.values()) or 1
    lines.append("- Output tokens by model (all scanned transcripts): " + ", ".join(
        f"{m} {fmt(n)} ({100 * n / total:.1f}%)" for m, n in sorted(by_model.items(), key=lambda kv: -kv[1])))
    lines.append("- Output tokens by role (all scanned transcripts): " + ", ".join(
        f"{r} {fmt(v['output_tokens'])}" for r, v in sorted(t["by_role"].items(), key=lambda kv: -kv[1]["output_tokens"])))
    return "\n".join(lines) + "\n"


def insert(text, block):
    i = text.index(HEADER) + len(HEADER)
    i = text.index("\n", i) + 1
    return text[:i] + "\n" + block + text[i:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json")
    ap.add_argument("--metrics", default=os.path.join(os.path.dirname(__file__), "..", "docs", "v10", "METRICS.md"))
    a = ap.parse_args()
    if a.json:
        d = json.load(open(a.json))
    else:
        out = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "usage-governor.py"), "--json"],
                             capture_output=True, text=True, timeout=300, check=True).stdout
        d = json.loads(out)
    text = open(a.metrics).read()
    new = insert(text, render(d))
    assert len(new) > len(text) and new.count(HEADER) == 1  # never truncate the file
    open(a.metrics, "w").write(new)
    print(render(d), end="")


if __name__ == "__main__":
    main()
