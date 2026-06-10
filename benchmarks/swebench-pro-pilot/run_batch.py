#!/usr/bin/env python3
"""Run the first N instances of the pinned subset sequentially through Loki.

Produces:
  - <work_root>/loki_predictions.json   ({instance_id, patch, prefix} list)
  - <work_root>/batch_records.json      (per-instance run records: cost, wall, etc.)
  - <work_root>/<iid>.patch             (each patch on disk)

Run grading separately via the official evaluator (see METHODOLOGY.md Section 6).
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_instance  # noqa: E402

SUBSET = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                      "pilot-subset-119.json")


# Pre-registration amendment 2026-06-10 (BEFORE batch instances 2-10 ran):
# Stage 2 measured ~$14.55/instance at LOKI_MAX_ITERATIONS=8 (vs $3-8 expected)
# and found the in-product USD breaker inert (cost pipeline defect). To stay
# inside the authorized $30-80 envelope: instances 2-10 run at
# LOKI_MAX_ITERATIONS=4 and the batch hard-aborts when cumulative measured
# spend reaches USD 78. Instances not run are reported explicitly as
# "not run (budget exhausted)" -- never silently dropped. Instance 1 ran
# pre-amendment at max_iter=8 and is documented as such.
BATCH_MAX_ITER = 4
CUMULATIVE_CAP_USD = 78.0


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    work_root = sys.argv[2] if len(sys.argv) > 2 else "/tmp/swebench-pro-pilot/runs"
    os.makedirs(work_root, exist_ok=True)
    ids = json.load(open(SUBSET))["instance_ids"][:n]

    records = []
    preds = []
    # resume: skip instances already recorded
    rec_path = os.path.join(work_root, "batch_records.json")
    done = {}
    if os.path.exists(rec_path):
        for r in json.load(open(rec_path)):
            done[r["instance_id"]] = r

    def spent():
        return sum((r.get("cost") or {}).get("usd") or 0 for r in records)

    for i, iid in enumerate(ids):
        if iid in done:
            print(f"[{i+1}/{n}] SKIP (already done): {iid}", flush=True)
            rec = done[iid]
            records.append(rec)
            pp = os.path.join(work_root, iid + ".patch")
            patch = open(pp).read() if os.path.exists(pp) else ""
            preds.append({"instance_id": iid, "patch": patch, "prefix": "loki-pilot"})
            continue
        if spent() >= CUMULATIVE_CAP_USD:
            print(f"[{i+1}/{n}] NOT RUN (budget exhausted at "
                  f"${spent():.2f} >= ${CUMULATIVE_CAP_USD}): {iid}", flush=True)
            records.append({"instance_id": iid, "patch_produced": False,
                            "error": "not_run_budget_exhausted",
                            "cost": None, "wall_s": None, "exit": None})
            preds.append({"instance_id": iid, "patch": "", "prefix": "loki-pilot"})
            continue
        print(f"[{i+1}/{n}] RUN: {iid} (spent so far: ${spent():.2f})", flush=True)
        rec, patch = run_instance.run(iid, work_root, max_iter=BATCH_MAX_ITER)
        records.append(rec)
        with open(os.path.join(work_root, iid + ".patch"), "w") as f:
            f.write(patch)
        preds.append({"instance_id": iid, "patch": patch, "prefix": "loki-pilot"})
        # persist incrementally so a crash doesn't lose progress
        json.dump(records, open(rec_path, "w"), indent=2)
        json.dump(preds, open(os.path.join(work_root, "loki_predictions.json"), "w"))
        print(f"    produced={rec['patch_produced']} cost={rec['cost']} "
              f"wall={rec['wall_s']}s exit={rec['exit']}", flush=True)

    json.dump(records, open(rec_path, "w"), indent=2)
    json.dump(preds, open(os.path.join(work_root, "loki_predictions.json"), "w"))
    print(f"DONE. {len(records)} records, total spend ${spent():.2f} -> {rec_path}",
          flush=True)


if __name__ == "__main__":
    main()
