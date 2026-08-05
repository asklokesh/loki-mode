#!/usr/bin/env python3
"""Append a real cross-model run to benchmarks/results/cross-model-eval.json.

WHY THIS EXISTS. That artifact is the evidence behind our model-invariance
claim, and it was HAND-MAINTAINED. Hand-maintained evidence drifts: the two runs
in it carry wall-clock and iteration counts but NO cost at all, so the cost
story -- one of the few genuinely measured differentiators we have -- cannot be
shown to a buyer.

The fix is not to write a cost number into the file. Nobody measured cost for
those runs, and inventing one would be exactly the fabrication the Evidence
Receipt exists to prevent. The fix is a recorder that reads cost from the
engine's own per-iteration metrics, so every FUTURE run carries it as a fact.

Cost is read via autonomy/lib/efficiency_cost.collect_efficiency, the same
function the Evidence Receipt uses, so a number here and a number on a receipt
are computed identically and cannot disagree.

That collector deliberately reports "unavailable" rather than 0.0 when no
efficiency record exists, and this script preserves that distinction. A skeptic
reading "$0.00" concludes the artifact is fake; "cost not recorded" is the
honest signal and keeps the rest of the file believable.

Usage:
    python3 benchmarks/record_cross_model_run.py \\
        --model haiku --loki-dir /path/to/build/.loki \\
        --wall-clock-s 460 --iterations 1 --exit-code 0

Nothing here runs a build or spends money. It records one that already happened.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "autonomy" / "lib"))

ARTIFACT = REPO_ROOT / "benchmarks" / "results" / "cross-model-eval.json"


def _load_collector():
    """Import the SAME cost collector the Evidence Receipt uses.

    Deliberately not reimplemented. Two code paths computing 'cost' from the
    same metrics will drift, and the first symptom is a benchmark number that
    contradicts a receipt for the same run -- which destroys the credibility of
    both.
    """
    try:
        from efficiency_cost import collect_efficiency  # type: ignore
        return collect_efficiency
    except ImportError as exc:
        raise SystemExit(
            f"cannot import efficiency_cost from autonomy/lib: {exc}"
        ) from exc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", required=True)
    ap.add_argument("--loki-dir", required=True,
                    help="the .loki directory of the completed run")
    ap.add_argument("--wall-clock-s", type=float, required=True)
    ap.add_argument("--iterations", type=int, required=True)
    ap.add_argument("--exit-code", type=int, required=True)
    ap.add_argument("--work-s", type=float, default=None)
    ap.add_argument("--acceptance", default="{}",
                    help='JSON object of acceptance checks, e.g. \'{"x_exists":true}\'')
    ap.add_argument("--dry-run", action="store_true",
                    help="print the record instead of writing it")
    args = ap.parse_args()

    collect = _load_collector()
    cost, model_from_metrics = collect(args.loki_dir)

    try:
        acceptance = json.loads(args.acceptance)
        if not isinstance(acceptance, dict):
            raise ValueError("acceptance must be a JSON object")
    except (ValueError, TypeError) as exc:
        print(f"invalid --acceptance: {exc}", file=sys.stderr)
        return 2

    record = {
        "model": args.model,
        "wall_clock_s": args.wall_clock_s,
        "iterations": args.iterations,
        "exit_code": args.exit_code,
        "engine_completed": args.exit_code == 0,
        "acceptance": acceptance,
        "acceptance_met": bool(acceptance) and all(acceptance.values()),
        "recorded_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if args.work_s is not None:
        record["work_s"] = args.work_s

    # THE POINT OF THIS SCRIPT. Carry cost as a fact when the engine recorded
    # one, and say so plainly when it did not. Never synthesise a zero.
    if cost.get("available"):
        record["cost_usd"] = cost.get("usd")
        record["input_tokens"] = cost.get("input_tokens")
        record["output_tokens"] = cost.get("output_tokens")
        record["cost_source"] = "engine efficiency metrics (same collector as the Evidence Receipt)"
    else:
        record["cost_usd"] = None
        record["cost_source"] = "not recorded (no efficiency metrics in this run)"

    # The model the engine actually dispatched, when it differs from the label
    # asked for. A run labelled 'haiku' that in fact dispatched sonnet would
    # invalidate the comparison, and that has bitten this project before.
    if model_from_metrics and model_from_metrics != args.model:
        record["dispatched_model"] = model_from_metrics
        record["label_mismatch"] = True

    if args.dry_run:
        print(json.dumps(record, indent=2))
        return 0

    doc = json.loads(ARTIFACT.read_text(encoding="utf-8"))
    doc.setdefault("runs", []).append(record)
    doc["generated"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ARTIFACT.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n",
                        encoding="utf-8")
    print(f"recorded {args.model} run (cost_usd={record['cost_usd']}) -> {ARTIFACT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
