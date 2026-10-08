#!/usr/bin/env python3
"""40x scoreboard (D92). Called by scripts/scoreboard-40x.sh.

Input TSV, one loki run per line: task run verified wall_s usd human_min
  human_min = recorded human minutes for the run (interventions plus review time); NOT RECORDED when absent.
Per task, current release vs the baseline release (11.3.1), improvement factor = baseline / current (above 1 is better):
  cost_factor   cost per VERIFIED task          (total usd / verified count)
  wall_factor   wall minutes per run            (mean)
  human_factor  human minutes per run           (mean)
  EFFICIENCY    verified rate / (mean usd x mean wall_min x mean human_min); efficiency_factor = current / baseline
Any input a factor needs that is missing in any run reads NOT RECORDED, never 0. A recorded human_min of 0 makes
the human factor and EFFICIENCY NOT COMPUTABLE (division by zero); no estimate is substituted. A declared slot
with no runs prints NOT RUN.
"""
import argparse, csv, datetime, json, sys

NR, NC, NRUN = "NOT RECORDED", "NOT COMPUTABLE", "NOT RUN"
TASKS = ["trivial-sum", "two-bug", "medium", "mass-10"]


def num(v, positive=False):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    if x != x or x < 0 or (positive and x <= 0):
        return None
    return x


def load(path):
    out = {}
    with open(path, newline="") as fh:
        for row in csv.reader(fh, delimiter="\t"):
            if len(row) < 6 or not row[0].strip():
                continue
            t, _r, ver, wall, usd, hm = (c.strip() for c in row[:6])
            out.setdefault(t, []).append({"verified": ver == "1", "wall": num(wall, True),
                                          "usd": num(usd, True), "human": num(hm)})
    return out


def agg(runs):
    n = len(runs)
    if n == 0:
        return None
    a = {"n": n, "verified": sum(1 for r in runs if r["verified"])}

    def mean(k):
        v = [r[k] for r in runs]
        return None if any(x is None for x in v) else sum(v) / n

    a["usd_total"] = None if any(r["usd"] is None for r in runs) else sum(r["usd"] for r in runs)
    a["usd_mean"] = mean("usd")
    w = mean("wall")
    a["wall_min"] = None if w is None else w / 60.0
    a["human_min"] = mean("human")
    a["cost_per_verified"] = None if a["usd_total"] is None or a["verified"] == 0 else a["usd_total"] / a["verified"]
    if None in (a["usd_mean"], a["wall_min"], a["human_min"]):
        a["efficiency"] = NR
    elif a["human_min"] == 0 or a["verified"] == 0:
        a["efficiency"] = NC
    else:
        a["efficiency"] = (a["verified"] / n) / (a["usd_mean"] * a["wall_min"] * a["human_min"])
    return a


def factor(b, c):
    if b is None or c is None:
        return NR
    if b == 0 or c == 0:
        return NC
    return round(b / c, 4)


def efficiency_factor(b, c):
    for v in (b, c):
        if v == NR:
            return NR
    for v in (b, c):
        if isinstance(v, str):
            return NC
    return round(c / b, 4)


def show(v):
    return v if isinstance(v, str) else ("%.2f" % v)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--current", required=True)
    ap.add_argument("--baseline", required=True)
    ap.add_argument("--version", default="unknown")
    ap.add_argument("--baseline-version", default="11.3.1")
    ap.add_argument("--json-out", required=True)
    ap.add_argument("--metrics-out", default="")
    a = ap.parse_args()
    cur, base = load(a.current), load(a.baseline)
    rows = {}
    for t in TASKS:
        c, b = agg(cur.get(t, [])), agg(base.get(t, []))
        if c is None:
            rows[t] = {"status": NRUN + (" (declared slot, awaiting MASS-1)" if t == "mass-10" else "")}
            continue
        if b is None:
            rows[t] = {"status": "NO BASELINE", "n": c["n"]}
            continue
        rows[t] = {"status": "ok", "n": c["n"], "baseline_n": b["n"],
                   "cost_factor": factor(b["cost_per_verified"], c["cost_per_verified"]),
                   "wall_factor": factor(b["wall_min"], c["wall_min"]),
                   "human_factor": factor(b["human_min"], c["human_min"]),
                   "efficiency": c["efficiency"], "baseline_efficiency": b["efficiency"],
                   "efficiency_factor": efficiency_factor(b["efficiency"], c["efficiency"])}
    rep = {"version": a.version, "baseline": a.baseline_version,
           "date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "tasks": rows,
           "definitions": "factor = baseline / current, above 1 is better; EFFICIENCY = verified rate / (mean usd x mean wall min x mean human min); NOT RECORDED when a field is missing"}
    with open(a.json_out, "w") as fh:
        json.dump(rep, fh, indent=2)
        fh.write("\n")
    print("40x scoreboard %s vs %s (factor = baseline/current, above 1 is better)" % (a.version, a.baseline_version))
    print("%-12s %3s %8s %8s %8s %12s %10s" % ("task", "n", "cost_x", "wall_x", "human_x", "EFFICIENCY", "eff_x"))
    for t in TASKS:
        r = rows[t]
        if r["status"] != "ok":
            print("%-12s %s" % (t, r["status"]))
            continue
        eff = r["efficiency"] if isinstance(r["efficiency"], str) else "%.4g" % r["efficiency"]
        print("%-12s %3d %8s %8s %8s %12s %10s" % (t, r["n"], show(r["cost_factor"]), show(r["wall_factor"]),
                                                  show(r["human_factor"]), eff, show(r["efficiency_factor"])))
    if a.metrics_out:
        cells = " ".join("%s:%s" % (t, ("cost_x=%s wall_x=%s human_x=%s eff_x=%s" % tuple(
            show(rows[t][k]) for k in ("cost_factor", "wall_factor", "human_factor", "efficiency_factor")))
            if rows[t]["status"] == "ok" else rows[t]["status"]) for t in TASKS)
        with open(a.metrics_out, "a") as fh:
            fh.write("| %s | scoreboard-40x %s vs %s | %s |\n" % (rep["date"], a.version, a.baseline_version, cells))
    return 0


if __name__ == "__main__":
    sys.exit(main())
