#!/usr/bin/env python3
"""equivalence_report.py -- aggregate model x config matrix results into a
per-axis equivalence verdict for the model-equivalence experiment.

Reads the tagged cell result JSONs written by matrix.sh (each row carries a
"cell" field of the form "<model>-<config>", e.g. "haiku-full"; matrix.sh also
set LOKI_BENCH_CELL per cell and runner.py persists it into the row). Computes,
PER AXIS and PER (model,config) cell:

  correctness = success_rate (deterministic held-out acceptance exit 0)
  honesty     = fraction of trials with a real proof present, else not_captured
  design      = not_captured (D-val judge is Planned, not built)

For each cell: the point estimate + a Wilson score interval for the binomial
success_rate. The hero comparison is gap = success_rate(haiku-full) minus
success_rate(opus-baseline), with a bootstrap CI (>=2000 resamples over
(task,trial) pairs, fixed seed for reproducibility).

Decision line per axis: "equivalent within epsilon" / "real residual gap"
/ "UNDERPOWERED at N=k, need N>=m".

HONESTY GUARDS:
  - Never fabricate a cell that did not run (shows not_run).
  - Always print N and spread.
  - REFUSES to compare two runs (haiku-full vs opus-baseline) for the SAME task
    when their task_hash differs (never compare across a changed corpus).
  - Small N cannot prove equivalence; the decision line says so explicitly.

Outputs a human-readable table (stdout / RESULTS-EQUIVALENCE.md) and a machine
JSON. Reuses report._median.

No emojis. No em dashes.
"""

from __future__ import annotations

import argparse
import glob
import json
import math
import os
import random
import sys
from typing import Any, Dict, List, Optional, Tuple

# Reuse report.py's _median helper (same directory).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bench_schema as _schema  # noqa: E402
try:
    from report import _median  # type: ignore
except Exception:  # pragma: no cover - fallback keeps the module importable
    import statistics

    def _median(values):
        nums = [v for v in values
                if isinstance(v, (int, float)) and not isinstance(v, bool)]
        return statistics.median(nums) if nums else None


EPSILON = 0.10          # equivalence band on success_rate
BOOTSTRAP_RESAMPLES = 2000
BOOTSTRAP_SEED = 1729   # FIXED for reproducibility
# Wilson uses z for a 95% two-sided interval.
Z_95 = 1.959963984540054
# Min N/task for a credible equivalence claim within epsilon=0.10 (plan section 1).
MIN_N_PER_TASK = 8


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def wilson_interval(successes: int, n: int, z: float = Z_95
                    ) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """Wilson score interval for a binomial proportion.

    Returns (point_estimate, low, high). For n == 0 returns (None, None, None):
    a cell with no trials has no rate, and reporting 0.0 would be a fabricated
    number (null != 0, per the honesty guards).
    """
    if n <= 0:
        return (None, None, None)
    p = successes / n
    z2 = z * z
    denom = 1.0 + z2 / n
    center = (p + z2 / (2 * n)) / denom
    margin = (z / denom) * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))
    low = max(0.0, center - margin)
    high = min(1.0, center + margin)
    return (p, low, high)


def bootstrap_gap_ci(hf_obs: List[int], ob_obs: List[int],
                     resamples: int = BOOTSTRAP_RESAMPLES,
                     seed: int = BOOTSTRAP_SEED
                     ) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """Bootstrap CI for gap = rate(haiku-full) - rate(opus-baseline).

    hf_obs / ob_obs are flat lists of 0/1 outcomes over (task,trial) pairs.
    Resampling is done independently within each cell (each is its own
    empirical distribution). Uses Python's random with a FIXED seed so the CI
    is reproducible run to run.

    Returns (point_gap, low, high). If either cell is empty, returns
    (None, None, None) -- there is no gap to bootstrap.
    """
    if not hf_obs or not ob_obs:
        return (None, None, None)
    point = (sum(hf_obs) / len(hf_obs)) - (sum(ob_obs) / len(ob_obs))
    rng = random.Random(seed)
    n_hf, n_ob = len(hf_obs), len(ob_obs)
    gaps: List[float] = []
    for _ in range(resamples):
        hf = sum(hf_obs[rng.randrange(n_hf)] for _ in range(n_hf)) / n_hf
        ob = sum(ob_obs[rng.randrange(n_ob)] for _ in range(n_ob)) / n_ob
        gaps.append(hf - ob)
    gaps.sort()
    lo = gaps[int(0.025 * (resamples - 1))]
    hi = gaps[int(0.975 * (resamples - 1))]
    return (point, lo, hi)


# ---------------------------------------------------------------------------
# Row parsing
# ---------------------------------------------------------------------------

_MODEL_ALIASES = {
    "claude-opus-5": "opus", "claude-sonnet-5": "sonnet",
    "claude-haiku-5": "haiku", "claude-fable": "fable",
}


def _normalize_model(raw: Optional[str]) -> str:
    if not raw:
        return "unknown"
    m = str(raw).strip().lower()
    if m in _MODEL_ALIASES:
        return _MODEL_ALIASES[m]
    # "claude-sonnet-5" / "sonnet-something" -> take the family token if present.
    for fam in ("opus", "sonnet", "haiku", "fable"):
        if fam in m:
            return fam
    return m


def _row_model(row: Dict[str, Any]) -> str:
    """Model family for a row: prefer explicit row model, then trial adapter."""
    m = _normalize_model(row.get("model"))
    if m != "unknown":
        return m
    for t in row.get("trials", []) or []:
        if isinstance(t, dict):
            ad = t.get("adapter")
            if isinstance(ad, dict) and ad.get("model_used"):
                return _normalize_model(ad.get("model_used"))
    return "unknown"


def parse_cell(row: Dict[str, Any]) -> Tuple[str, str]:
    """Return (model, config) for a row.

    Prefer the explicit "cell" tag ("<model>-<config>"). Fall back to the row
    model with config="unknown" for legacy (non-matrix) results -- honest:
    untagged runs appear but cannot be placed in a baseline/full column.
    """
    cell = row.get("cell")
    if isinstance(cell, str) and "-" in cell:
        model, _, config = cell.partition("-")
        return (_normalize_model(model), config)
    return (_row_model(row), "unknown")


def _trial_has_proof(trial: Dict[str, Any]) -> Optional[bool]:
    """Honesty signal for a trial: True if a real proof/verify verdict is present.

    Returns None when no proof machinery ran at all (so the axis is not_captured
    rather than counted as a failure). A proof is 'present' when the trial (or
    its adapter/provenance) records a proof artifact or an explicit verify
    verdict. Current bench results carry none, so this returns None today.
    """
    if not isinstance(trial, dict):
        return None
    if trial.get("proof") or trial.get("proof_path"):
        return True
    ad = trial.get("adapter")
    if isinstance(ad, dict):
        if ad.get("proof") or ad.get("proof_path"):
            return True
        prov = ad.get("provenance")
        if isinstance(prov, dict):
            if prov.get("proof_path") or prov.get("verify_verdict"):
                return True
    return None


def _declared_complete_normalized(trial: Dict[str, Any]) -> Optional[bool]:
    """Did the tool CLAIM this task was complete, under the ONE rule applied to
    EVERY tool including Loki?

    Rule (founder decision 2026-07-24): declared complete == the tool terminated
    without error AND produced a non-empty diff.

    Why deliberately ignore Loki's richer structured verdict here: Loki emits a
    proof.json honesty.headline; claude_code and aider emit nothing comparable,
    only a process exit status. Scoring Loki's strict self-report against a
    competitor's loose inferred one would bias the false-green number IN LOKI'S
    FAVOUR, and that is the first thing a skeptical reviewer would attack. So
    the headline metric handicaps our own signal on purpose, and the structured
    verdict is reported separately (see _declared_complete_structured).

    Returns None when the trial does not record enough to judge, so an
    unmeasurable trial is excluded from the denominator rather than silently
    counted as a success or a failure.
    """
    ad = trial.get("adapter")
    if not isinstance(ad, dict):
        return None

    status = ad.get("exit_status")
    if status is None:
        return None
    # exit_status is the adapter's own terminated-cleanly signal. Accept the
    # common spellings rather than assuming one adapter's convention.
    if isinstance(status, bool):
        terminated_ok = status
    elif isinstance(status, (int, float)) and not isinstance(status, bool):
        terminated_ok = int(status) == 0
    elif isinstance(status, str):
        terminated_ok = status.strip().lower() in ("ok", "success", "completed", "0")
    else:
        return None
    if not terminated_ok:
        return False

    # Non-empty diff. A tool that exits 0 having changed nothing has not
    # claimed completion in any meaningful sense (this is the same principle as
    # the engine's own empty-diff evidence gate).
    prov = ad.get("provenance") if isinstance(ad.get("provenance"), dict) else {}
    for key in ("files_changed", "diff_lines", "lines_changed"):
        v = ad.get(key, prov.get(key))
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return int(v) > 0
    for key in ("diff_sha256", "diff_hash"):
        v = ad.get(key, prov.get(key))
        if isinstance(v, str) and v.strip():
            return True
    # Terminated cleanly but the adapter recorded no diff evidence either way.
    return None


def _declared_complete_structured(trial: Dict[str, Any]) -> Optional[bool]:
    """Loki-only secondary signal: the receipt's own honesty headline.

    Reported ALONGSIDE the normalized axis, never in place of it. Tools with no
    structured verdict return None and stay out of this axis entirely (rather
    than being scored 0, which would read as "never claimed done").
    """
    ad = trial.get("adapter")
    if not isinstance(ad, dict):
        return None
    prov = ad.get("provenance")
    if not isinstance(prov, dict):
        return None
    verdict = prov.get("verify_verdict")
    if not isinstance(verdict, str) or not verdict.strip():
        return None
    return verdict.strip().upper() == "VERIFIED"


def _false_green(rows: List[Dict[str, Any]], declared_fn) -> Any:
    """FALSE-GREEN RATE: of the trials where the tool CLAIMED completion, the
    fraction the held-out grader says did NOT actually pass.

    This is the metric the whole benchmark exists for. `success` comes from the
    grader ONLY (a held-out acceptance command the agent could not edit), and
    the claim comes from `declared_fn`. Their disagreement is the moat measured
    rather than asserted.

    Denominator is CLAIMED trials, not all trials: "when this tool tells you it
    is done, how often is it wrong" is the question a user actually has.
    Returns "not_captured" when nothing is measurable, never 0.0 -- a silent 0
    would read as a perfect score.
    """
    claimed = 0
    false_green = 0
    for row in rows:
        for t in row.get("trials", []) or []:
            if not isinstance(t, dict):
                continue
            declared = declared_fn(t)
            if declared is not True:
                continue
            claimed += 1
            if not t.get("success"):
                false_green += 1
    if claimed == 0:
        return "not_captured"
    return {
        "n_claimed": claimed,
        "n_false_green": false_green,
        "rate": round(false_green / claimed, 4),
    }


def cell_axes(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Aggregate the per-axis stats for one (model,config) cell (>=1 row).

    A cell may span multiple task result-rows; trials are pooled across tasks.
    """
    successes = 0
    n = 0
    n_unmeasured = 0
    obs: List[int] = []
    proof_present = 0
    proof_observed = 0
    costs: List[float] = []
    durations: List[float] = []
    for row in rows:
        for t in row.get("trials", []) or []:
            if not isinstance(t, dict):
                continue
            # A trial that produced no gradeable state (tool absent, timed out,
            # harness error) is NOT a zero. Counting it would deflate this
            # cell's success_rate, tighten its Wilson interval around a number
            # nothing observed, and feed both into the hero gap. Excluded from
            # the denominator; counted separately so the loss stays visible.
            if not _schema.trial_is_measured(t):
                n_unmeasured += 1
                continue
            n += 1
            ok = 1 if t.get("success") else 0
            successes += ok
            obs.append(ok)
            c = t.get("cost_usd")
            if isinstance(c, (int, float)) and not isinstance(c, bool):
                costs.append(c)
            d = t.get("duration_s")
            if isinstance(d, (int, float)) and not isinstance(d, bool):
                durations.append(d)
            p = _trial_has_proof(t)
            if p is not None:
                proof_observed += 1
                if p:
                    proof_present += 1
    p_est, lo, hi = wilson_interval(successes, n)
    honesty = ("not_captured" if proof_observed == 0
               else round(proof_present / proof_observed, 4))
    return {
        "n_trials": n,
        "n_unmeasured": n_unmeasured,
        "n_success": successes,
        "correctness": {
            "success_rate": None if p_est is None else round(p_est, 4),
            "wilson_low": None if lo is None else round(lo, 4),
            "wilson_high": None if hi is None else round(hi, 4),
        },
        "honesty": honesty,
        # false_green is the HEADLINE competitive metric (one normalization rule,
        # every tool, Loki included). false_green_structured is Loki's own
        # receipt verdict, reported as a secondary column and never as the
        # headline -- see _declared_complete_normalized for why.
        "false_green": _false_green(rows, _declared_complete_normalized),
        "false_green_structured": _false_green(rows, _declared_complete_structured),
        "design": "not_captured",
        "cost_usd_median": _median(costs),
        # COST PER VERIFIED TASK: total spend divided by GRADER-CONFIRMED
        # successes, not by attempts. Cost per attempt flatters a tool that
        # fails cheaply and often; the question a buyer actually has is what a
        # working result costs. null (never 0) when nothing was solved or no
        # cost was recorded, so an unmeasured cell cannot read as "free".
        "cost_usd_per_verified": (
            round(sum(costs) / successes, 4)
            if costs and successes > 0 else None
        ),
        "duration_s_median": _median(durations),
        "obs": obs,
    }


# ---------------------------------------------------------------------------
# task_hash safety: refuse to compare across a changed corpus
# ---------------------------------------------------------------------------

def harness_sig(row: Dict[str, Any]) -> str:
    """The harness stratum a row belongs to.

    Rows written before harness stamping existed carry no signature. They are
    their own "unknown" stratum -- reported, never silently folded in with rows
    from a known engine, because we cannot show they came from the same one.
    """
    sig = row.get("harness_sig")
    if isinstance(sig, str) and sig.strip():
        return sig.strip()
    return "unknown"


def group_by_harness(rows: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Split rows into strata keyed by harness signature. Never pools across."""
    out: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        out.setdefault(harness_sig(r), []).append(r)
    return out


def check_harness_consistency(rows: List[Dict[str, Any]], label: str) -> List[str]:
    """A single cell must come from ONE harness. Returns problem descriptions.

    Refusing loudly beats averaging silently: trials from two engines are two
    different experiments, and their mean is a number about nothing.
    """
    strata = group_by_harness(rows)
    if len(strata) <= 1:
        return []
    parts = ["%s (n=%d rows)" % (sig[:12], len(rs))
             for sig, rs in sorted(strata.items())]
    return ["cell '%s' mixes %d harness signatures: %s"
            % (label, len(strata), ", ".join(parts))]


def check_task_hash_consistency(hf_rows: List[Dict[str, Any]],
                                ob_rows: List[Dict[str, Any]]) -> List[str]:
    """For each task appearing in BOTH cells, the task_hash must match.

    Returns a list of mismatch descriptions (empty = consistent). The caller
    aborts the gap comparison on any mismatch (never compare across a changed
    corpus).
    """
    def by_task(rows):
        out: Dict[str, str] = {}
        for r in rows:
            tid = r.get("task_id", "")
            th = r.get("task_hash", "")
            if tid:
                out[tid] = th
        return out

    hf, ob = by_task(hf_rows), by_task(ob_rows)
    problems = []
    for tid in sorted(set(hf) & set(ob)):
        if hf[tid] != ob[tid]:
            problems.append(
                "task_hash mismatch for task '%s': haiku-full=%s opus-baseline=%s"
                % (tid, hf[tid][:12] or "<none>", ob[tid][:12] or "<none>"))
    return problems


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def build_report(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Build the full machine report from a list of result-rows.

    Raises ValueError if the hero comparison (haiku-full vs opus-baseline)
    spans a mismatched task_hash for any shared task.
    """
    grid: Dict[str, Dict[str, List[Dict[str, Any]]]] = {}
    for r in rows:
        model, config = parse_cell(r)
        grid.setdefault(model, {}).setdefault(config, []).append(r)

    cells: Dict[str, Dict[str, Any]] = {}
    for model in sorted(grid):
        for config in sorted(grid[model]):
            key = "%s-%s" % (model, config)
            cells[key] = cell_axes(grid[model][config])

    hf_rows = grid.get("haiku", {}).get("full", [])
    ob_rows = grid.get("opus", {}).get("baseline", [])

    hero: Dict[str, Any] = {"haiku_full": bool(hf_rows),
                            "opus_baseline": bool(ob_rows)}
    hero["harness_strata"] = {
        "haiku_full": sorted(group_by_harness(hf_rows)),
        "opus_baseline": sorted(group_by_harness(ob_rows)),
    }
    if hf_rows and ob_rows:
        mismatches = check_task_hash_consistency(hf_rows, ob_rows)
        if mismatches:
            raise ValueError(
                "REFUSING to compute the gap across a changed corpus:\n  - "
                + "\n  - ".join(mismatches))
        # Same principle one level up: an unchanged task run by a CHANGED
        # harness is still two experiments. Pooling them would average across
        # engine versions and quietly launder a mid-campaign run.sh edit.
        harness_problems = (check_harness_consistency(hf_rows, "haiku-full")
                            + check_harness_consistency(ob_rows, "opus-baseline"))
        if harness_problems:
            raise ValueError(
                "REFUSING to pool trials from different harness versions:\n  - "
                + "\n  - ".join(harness_problems)
                + "\n  Re-run a cell so each arm has one harness, or report the "
                  "strata separately.")
        hf = cell_axes(hf_rows)
        ob = cell_axes(ob_rows)
        gap, glo, ghi = bootstrap_gap_ci(hf["obs"], ob["obs"])
        hero["gap"] = None if gap is None else round(gap, 4)
        hero["gap_ci_low"] = None if glo is None else round(glo, 4)
        hero["gap_ci_high"] = None if ghi is None else round(ghi, 4)
        hero["n_haiku_full"] = hf["n_trials"]
        hero["n_opus_baseline"] = ob["n_trials"]
        hero["decision"] = _decision_line(
            gap, glo, ghi, hf["n_trials"], ob["n_trials"], len(hf_rows))

    return {
        "epsilon": EPSILON,
        "bootstrap_resamples": BOOTSTRAP_RESAMPLES,
        "bootstrap_seed": BOOTSTRAP_SEED,
        "cells": cells,
        "hero_correctness": hero,
        "axes": {
            "correctness": "measured (held-out acceptance exit 0)",
            "honesty": "measured when proof present, else not_captured",
            "design": "not_captured (D-val judge is Planned, not built)",
        },
    }


def _decision_line(gap, lo, hi, n_hf, n_ob, n_tasks) -> str:
    """Explicit per-axis decision string for the correctness gap."""
    if gap is None or lo is None or hi is None:
        return "not_run: one hero cell has no trials"
    n_per_task = (min(n_hf, n_ob) / n_tasks) if n_tasks else 0
    underpowered = n_per_task < MIN_N_PER_TASK
    if lo >= -EPSILON:
        base = ("equivalent within epsilon=%.2f (gap=%+.3f, CI [%+.3f, %+.3f])"
                % (EPSILON, gap, lo, hi))
        if underpowered:
            need = math.ceil(MIN_N_PER_TASK * n_tasks)
            return (base + " -- but UNDERPOWERED at N=%d (%.1f/task); small N "
                    "cannot PROVE equivalence, need N>=%d total (>=%d/task)"
                    % (min(n_hf, n_ob), n_per_task, need, MIN_N_PER_TASK))
        return base
    if hi < -EPSILON:
        return ("real residual gap = %+.3f [CI %+.3f, %+.3f] (below -epsilon=%.2f)"
                % (gap, lo, hi, EPSILON))
    # CI straddles -epsilon.
    need = math.ceil(MIN_N_PER_TASK * n_tasks) if n_tasks else MIN_N_PER_TASK
    return ("UNDERPOWERED at N=%d: gap=%+.3f CI [%+.3f, %+.3f] straddles "
            "-epsilon=%.2f, need N>=%d total"
            % (min(n_hf, n_ob), gap, lo, hi, EPSILON, need))


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _fmt_rate(cx: Dict[str, Any]) -> str:
    sr = cx["correctness"]["success_rate"]
    if sr is None:
        # Distinguish "this cell never ran" from "it ran and every trial was
        # lost". Both are not_run for decision purposes, but only the second
        # means trials were paid for and produced nothing.
        if cx.get("n_unmeasured"):
            return "not_run (%d unmeasured)" % cx["n_unmeasured"]
        return "not_run"
    return ("%.2f [%.2f, %.2f]"
            % (sr, cx["correctness"]["wilson_low"], cx["correctness"]["wilson_high"]))


def _fmt_false_green(v) -> str:
    """Render the false-green axis for the grid.

    Always shows the DENOMINATOR alongside the rate: "0.25 (1/4)" tells a reader
    the sample size, where a bare "0.25" invites over-reading a 4-trial cell.
    A cell with nothing measurable renders as not_captured, never as 0.
    """
    if not isinstance(v, dict):
        return "not_captured"
    return "%.2f (%d/%d)" % (v["rate"], v["n_false_green"], v["n_claimed"])


def _fmt_usd(v) -> str:
    return "not recorded" if v is None else ("$%.4f" % v).rstrip("0").rstrip(".")


def render_markdown(report: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Model-Equivalence Report")
    lines.append("")
    lines.append("Axes (never blended):")
    for ax, desc in report["axes"].items():
        lines.append("- %s: %s" % (ax, desc))
    lines.append("")
    lines.append("epsilon=%.2f, bootstrap resamples=%d, seed=%d"
                 % (report["epsilon"], report["bootstrap_resamples"],
                    report["bootstrap_seed"]))
    lines.append("")

    # (a) model x config grid.
    lines.append("## Grid: success_rate + Wilson 95% CI")
    lines.append("")
    lines.append("| cell | N | success_rate [CI] | false_green | honesty | design | cost_median | dur_median |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for key in sorted(report["cells"]):
        cx = report["cells"][key]
        dur = ("not recorded" if cx["duration_s_median"] is None
               else "%.1fs" % cx["duration_s_median"])
        lines.append("| %s | %d | %s | %s | %s | %s | %s | %s |" % (
            key, cx["n_trials"], _fmt_rate(cx), _fmt_false_green(cx.get("false_green")),
            cx["honesty"], cx["design"],
            _fmt_usd(cx["cost_usd_median"]), dur))
    lines.append("")

    # (b) ablation table placeholder.
    lines.append("## Ablation table (Planned -- filled when Stage-2 ablation runs)")
    lines.append("")
    lines.append("| lever | haiku OFF | haiku ON | marginal lift [CI] | overfit flag |")
    lines.append("|---|---|---|---|---|")
    lines.append("| (not_run) | -- | -- | -- | -- |")
    lines.append("")

    # (c) explicit decision line per axis.
    lines.append("## Decision (per axis)")
    lines.append("")
    hero = report["hero_correctness"]
    if not (hero.get("haiku_full") and hero.get("opus_baseline")):
        missing = []
        if not hero.get("haiku_full"):
            missing.append("haiku-full")
        if not hero.get("opus_baseline"):
            missing.append("opus-baseline")
        lines.append("- correctness: not_run (missing hero cell(s): %s)"
                     % ", ".join(missing))
    else:
        lines.append("- correctness: %s" % hero["decision"])
    lines.append("- honesty: not_captured (no proof/verify verdict present in "
                 "current results)")
    lines.append("- design: not_captured (D-val judge is Planned, not built)")
    lines.append("")
    lines.append("Note: small N cannot prove equivalence. N and spread are shown "
                 "above; null is never rendered as 0.")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _load_rows(paths: List[str]) -> List[Dict[str, Any]]:
    rows = []
    for p in paths:
        with open(p) as fh:
            obj = json.load(fh)
        if isinstance(obj, dict) and "trials" in obj:
            rows.append(obj)
    return rows


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Model-equivalence aggregation report.")
    ap.add_argument("files", nargs="*",
                    help="result JSONs (default: results/*.json next to this script)")
    ap.add_argument("--json-out", help="write the machine JSON report here")
    ap.add_argument("--md-out", help="write the markdown report here")
    args = ap.parse_args(argv)

    paths = args.files
    if not paths:
        here = os.path.dirname(os.path.abspath(__file__))
        paths = sorted(glob.glob(os.path.join(here, "results", "*.json")))
    rows = _load_rows(paths)
    if not rows:
        print("no result rows found", file=sys.stderr)
        return 1

    try:
        report = build_report(rows)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    md = render_markdown(report)
    print(md, end="")
    if args.md_out:
        with open(args.md_out, "w") as fh:
            fh.write(md)
    if args.json_out:
        with open(args.json_out, "w") as fh:
            json.dump(report, fh, indent=2, sort_keys=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
