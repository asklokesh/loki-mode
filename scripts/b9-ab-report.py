#!/usr/bin/env python3
"""B9 raw-vs-loki report (B9-RAW-ARM). Called by scripts/b9-scoreboard.sh --ab-report.

Input TSV, one run per line: arm fixture run solved verified wall usd [cache_read cache_create]
  arm: raw | loki. solved: hidden checks passed (1/0). verified: loki receipt verdict VERIFIED (raw: equals solved).
  A loki run is delivered only when VERIFIED and solved (hidden-check passing); a false VERIFIED earns nothing.
  usd, wall: raw from the claude -p SDK result line (total_cost_usd, duration_ms), loki from receipt.json cost.usd and
  time.total_s (never time.wall_s); "NOT RECORDED" when absent.
Outputs a JSON file and one METRICS row:
  cost_ratio        (loki usd / loki verified tasks) / (raw usd / raw solved tasks); cost of failed runs is included
  correctness_ratio loki solve rate / raw solve rate
  wall_ratio        mean loki wall / mean raw wall
95 percent intervals: percentile bootstrap, resampling runs within each (arm, fixture) cell, fixed seed.
A cost that is missing, non-numeric or <= 0 anywhere in an arm makes cost_ratio NOT RECORDED (never 0, never a
ratio over the runs that happened to be recorded).
"""
import argparse
import csv
import json
import random
import sys
import datetime

NR = "NOT RECORDED"
NC = "NOT COMPUTABLE"


def load(path):
    runs = []
    with open(path, newline="") as fh:
        for row in csv.reader(fh, delimiter="\t"):
            if len(row) < 7 or row[0] not in ("raw", "loki"):
                continue
            arm, fixture, _run, solved, verified, wall, usd = (c.strip() for c in row[:7])
            try:
                w = float(wall)
            except ValueError:
                w = None
            try:
                u = float(usd)
                if u <= 0 or u != u:
                    u = None
            except ValueError:
                u = None
            runs.append({"arm": arm, "fixture": fixture, "solved": solved == "1",
                         "verified": verified == "1", "wall": w, "usd": u})
    return runs


def sums(runs, arm):
    rs = [r for r in runs if r["arm"] == arm]
    return rs


def stat_cost(raw, loki):
    if any(r["usd"] is None for r in raw + loki):
        return None
    ds = sum(1 for r in raw if r["solved"])
    dv = sum(1 for r in loki if r["verified"] and r["solved"])
    if ds == 0 or dv == 0:
        return None
    return (sum(r["usd"] for r in loki) / dv) / (sum(r["usd"] for r in raw) / ds)


def stat_correct(raw, loki):
    if not raw or not loki:
        return None
    rr = sum(1 for r in raw if r["solved"]) / len(raw)
    lr = sum(1 for r in loki if r["solved"]) / len(loki)
    return None if rr == 0 else lr / rr


def stat_wall(raw, loki):
    rw = [r["wall"] for r in raw]
    lw = [r["wall"] for r in loki]
    if not rw or not lw or any(w is None for w in rw + lw):
        return None
    m = sum(rw) / len(rw)
    return None if m <= 0 else (sum(lw) / len(lw)) / m


def resample(runs, rng):
    cells = {}
    for r in runs:
        cells.setdefault((r["arm"], r["fixture"]), []).append(r)
    out = []
    for key in sorted(cells):
        c = cells[key]
        out.extend(rng.choice(c) for _ in c)
    return out


def metric(name, fn, runs, rng, boots, missing_reason=None):
    raw, loki = sums(runs, "raw"), sums(runs, "loki")
    if missing_reason:
        return {"value": NR, "ci95": NR, "reason": missing_reason}
    if name == "wall" and any(r["wall"] is None for r in raw + loki):
        return {"value": NR, "ci95": NR, "reason": "%d run(s) have no recorded duration" % sum(1 for r in raw + loki if r["wall"] is None)}
    point = fn(raw, loki)
    if point is None:
        return {"value": NC, "ci95": NC, "reason": "a denominator is zero (no solved/verified run or no raw baseline)"}
    if any(len(sums(runs, arm)) < 2 for arm in ("raw", "loki")) or min(
            sum(1 for r in runs if (r["arm"], r["fixture"]) == (a, f)) for a in ("raw", "loki")
            for f in {r["fixture"] for r in runs}) < 2:
        return {"value": round(point, 9), "ci95": NC, "reason": "an (arm, fixture) cell has n<2; a bootstrap interval would be a false point"}
    vals = []
    for _ in range(boots):
        rs = resample(runs, rng)
        v = fn(sums(rs, "raw"), sums(rs, "loki"))
        if v is not None:
            vals.append(v)
    if len(vals) < 0.95 * boots:
        return {"value": round(point, 9), "ci95": NC, "reason": "too many bootstrap resamples had a zero denominator"}
    vals.sort()
    lo = vals[int(0.025 * (len(vals) - 1))]
    hi = vals[int(round(0.975 * (len(vals) - 1)))]
    return {"value": round(point, 9), "ci95": [round(lo, 9), round(hi, 9)]}


def fmt(m):
    if isinstance(m["value"], str):
        return m["value"]
    ci = m["ci95"]
    return "%.2f ci95=%s" % (m["value"], ci if isinstance(ci, str) else "[%.2f,%.2f]" % (ci[0], ci[1]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tsv")
    ap.add_argument("--json-out", required=True)
    ap.add_argument("--metrics-out", default="")
    ap.add_argument("--version", default="unknown")
    ap.add_argument("--seed", type=int, default=20261008)
    ap.add_argument("--boots", type=int, default=10000)
    a = ap.parse_args()
    runs = load(a.tsv)
    raw, loki = sums(runs, "raw"), sums(runs, "loki")
    if not raw or not loki:
        print("b9-ab-report: need runs for both arms (raw=%d loki=%d)" % (len(raw), len(loki)), file=sys.stderr)
        return 2
    missing = None
    if any(r["usd"] is None for r in raw + loki):
        bad = sum(1 for r in raw + loki if r["usd"] is None)
        missing = "%d run(s) have no recorded cost (missing, non-numeric or 0)" % bad
    rng = random.Random(a.seed)
    cost = metric("cost", stat_cost, runs, rng, a.boots, missing)
    corr = metric("correctness", stat_correct, runs, rng, a.boots)
    wall = metric("wall", stat_wall, runs, rng, a.boots)
    cells = {}
    for r in runs:
        cells[(r["arm"], r["fixture"])] = cells.get((r["arm"], r["fixture"]), 0) + 1
    fixtures = sorted({r["fixture"] for r in runs})
    significant = all(cells.get((arm, f), 0) >= 3 for arm in ("raw", "loki") for f in fixtures)
    rep = {"version": a.version, "date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
           "fixtures": fixtures, "n": {"raw": len(raw), "loki": len(loki)}, "significant": significant,
           "cost_ratio": cost, "correctness_ratio": corr, "wall_ratio": wall,
           "seed": a.seed, "boots": a.boots,
           "definitions": {"cost_ratio": "(loki usd per VERIFIED task) / (raw usd per task solved); failed-run cost included",
                           "correctness_ratio": "loki hidden-check solve rate / raw hidden-check solve rate",
                           "wall_ratio": "mean loki wall / mean raw wall"}}
    with open(a.json_out, "w") as fh:
        json.dump(rep, fh, indent=2)
        fh.write("\n")
    label = "" if significant else " n=%d not significant" % min(cells.values())
    row = "| %s | b9-ab %s | %s | cost_ratio=%s correctness_ratio=%s wall_ratio=%s n=%d/%d%s |" % (
        rep["date"], a.version, ",".join(fixtures), fmt(cost), fmt(corr), fmt(wall), len(raw), len(loki), label)
    print(row)
    if a.metrics_out:
        with open(a.metrics_out, "a") as fh:
            fh.write(row + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
