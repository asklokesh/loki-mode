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

    for i, iid in enumerate(ids):
        if iid in done:
            print(f"[{i+1}/{n}] SKIP (already done): {iid}", flush=True)
            rec = done[iid]
            records.append(rec)
            pp = os.path.join(work_root, iid + ".patch")
            patch = open(pp).read() if os.path.exists(pp) else ""
            preds.append({"instance_id": iid, "patch": patch, "prefix": "loki-pilot"})
            continue
        print(f"[{i+1}/{n}] RUN: {iid}", flush=True)
        rec, patch = run_instance.run(iid, work_root)
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
    print(f"DONE. {len(records)} records -> {rec_path}", flush=True)


if __name__ == "__main__":
    main()
