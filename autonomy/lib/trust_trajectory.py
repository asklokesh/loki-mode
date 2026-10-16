#!/usr/bin/env python3
"""R4 trust trajectory - derive a per-project trust trend from proof-of-run history.

The story no competitor tells: show whether the agent is EARNING autonomy on
THIS repo over time. We derive the trajectory from the persistent per-run
records that R1/R3 already write to .loki/proofs/<run_id>/proof.json. No new
run-time instrumentation; this is a pure read-and-aggregate layer.

Axes (each derived from fields already present in proof.json):
  council_pass_rate   higher is better  (council.final_verdict approve => 1.0)
  gate_pass_rate      higher is better  (quality_gates.passed / .total)
  iterations          lower is better   (iterations.count)
  interventions       lower is better   (best-effort; available only when a
                                         proof carries it; never fabricated)

Honest-data rule: with fewer than 2 runs the trajectory is "insufficient"
(insufficient=True) and no direction is invented. Numbers are only ever derived
from real proof.json values; a missing axis is reported available=False, not 0.

Direction (up/down/flat) is computed by a median half-split: mean of the later
half minus mean of the earlier half. Robust to one noisy run, no float
regression needed, and a 2-run series degrades to last-vs-first.

Outcome effort definitions (shared with loki-ts/src/metrics/trust.ts and
benchmarks/bench/attribution.py; see docs/EVALUATING.md "Outcome analytics"):
accepted = verdict VERIFIED and not later contradicted; misleading completion =
false_verified / VERIFIED-claimed (attribution false_completion); cost per
accepted = total spend over ALL runs / accepted, None when nothing was accepted
or any run's cost is unmeasured. Waited seconds are wall-clock blocked time, an
upper bound on human attention; active minutes are NOT measured.

Public API:
  compute_trajectory(loki_dir) -> dict   (schema_version 1)
  format_trajectory_human(traj) -> str
  format_trajectory_json(traj) -> str
  write_trajectory_cache(loki_dir, traj) -> str | None
  main(argv) -> int                      (CLI entry: prints human or --json)

No external deps. Python 3.8+ (matches the rest of autonomy/lib).
"""

import json
import os
import sys
from datetime import datetime, timezone

SCHEMA_VERSION = 1

# Per-axis "good direction" polarity. True => higher is better.
_AXIS_HIGHER_IS_BETTER = {
    "council_pass_rate": True,
    "gate_pass_rate": True,
    "iterations": False,
    "interventions": False,
}

# Per-axis flat epsilon. Rates live in [0,1]; counts use a larger band.
_AXIS_EPSILON = {
    "council_pass_rate": 0.01,
    "gate_pass_rate": 0.01,
    "iterations": 0.25,
    "interventions": 0.25,
}

_AXIS_LABELS = {
    "council_pass_rate": "Council pass rate",
    "gate_pass_rate": "Gate pass rate",
    "iterations": "Iterations to completion",
    "interventions": "Human interventions",
}

# Verdict tokens that count as a council pass.
_PASS_TOKENS = ("APPROVE", "APPROVED", "COMPLETE", "PASS", "PASSED")


def _read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _obj(v):
    return v if isinstance(v, dict) else {}


def _verdict_is_pass(verdict):
    """Map a council final_verdict string to a pass (True) / fail (False)."""
    v = str(verdict or "").strip().upper()
    if not v:
        return None
    for tok in _PASS_TOKENS:
        if v.startswith(tok):
            return True
    return False


def _council_pass_value(council):
    """Per-run council pass as 1.0 / 0.0, or None when no council signal."""
    council = _obj(council)
    # Primary: explicit final verdict.
    fv = _verdict_is_pass(council.get("final_verdict"))
    if fv is not None:
        return 1.0 if fv else 0.0
    # Secondary: reviewer roll-up. A run "passes" when every reviewer approved.
    reviewers = council.get("reviewers")
    if isinstance(reviewers, list) and reviewers:
        approve = 0
        counted = 0
        for r in reviewers:
            if not isinstance(r, dict):
                continue
            counted += 1
            vote = str(r.get("vote") or "").strip().upper()
            if any(vote.startswith(tok) for tok in _PASS_TOKENS):
                approve += 1
        if counted:
            return 1.0 if approve == counted else 0.0
    return None


def _gate_rate_value(quality_gates):
    """Per-run gate pass-rate in [0,1], or None when no gates recorded."""
    qg = _obj(quality_gates)
    total = qg.get("total")
    passed = qg.get("passed")
    try:
        total = int(total)
        passed = int(passed)
    except (TypeError, ValueError):
        return None
    if total <= 0:
        return None
    return max(0.0, min(1.0, passed / total))


def _iterations_value(iterations):
    """Per-run iteration count, or None when not recorded."""
    if isinstance(iterations, dict):
        c = iterations.get("count")
    else:
        c = iterations
    try:
        c = int(c)
    except (TypeError, ValueError):
        return None
    if c < 0:
        return None
    return float(c)


def _interventions_value(proof):
    """Per-run human-intervention count, ONLY when the proof carries it.

    There is no per-run intervention counter persisted today; we read it
    opportunistically so the axis lights up the moment that field exists, but
    we never fabricate a value. Returns None when absent.
    """
    council = _obj(proof.get("council"))
    for src in (council.get("interventions"), proof.get("interventions")):
        try:
            n = int(src)
        except (TypeError, ValueError):
            continue
        if n >= 0:
            return float(n)
    return None


_IV_TYPES = ("steer", "input", "authorization", "repair")


def _cost_value(proof):
    usd = _obj(proof.get("cost")).get("usd")
    if usd is None or isinstance(usd, bool):
        return None
    try:
        n = float(usd)
    except (TypeError, ValueError):
        return None
    return n if n >= 0 and n == n and n != float("inf") else None


def _intervention_detail(proof):
    """(by_type, waited_s, active_s) from proof.interventions_detail; None when absent."""
    d = _obj(proof.get("interventions_detail"))
    bt = _obj(d.get("by_type"))
    out = {}
    any_key = False
    for k in _IV_TYPES:
        try:
            n = int(bt.get(k))
        except (TypeError, ValueError):
            n = 0
        out[k] = n if n >= 0 else 0
        if bt.get(k) is not None:
            any_key = True
    w = d.get("waited_s")
    ws = w if isinstance(w, (int, float)) and not isinstance(w, bool) and w >= 0 else None
    a = d.get("active_s")
    act = a if isinstance(a, int) and not isinstance(a, bool) and a >= 0 else None
    return (out if any_key else None), ws, act


def _verdict_evidence(proof):
    raw = str(proof.get("verdict") or "").strip().upper()
    verdict = raw or None
    later = str(proof.get("later_verdict") or "").strip().upper()
    if proof.get("false_verified") is True:
        return verdict, True
    if verdict is None:
        return verdict, None
    return verdict, verdict == "VERIFIED" and later == "FAILED"


def _load_runs(loki_dir):
    """Read every .loki/proofs/<id>/proof.json into a time-ordered run list."""
    proofs_dir = os.path.join(loki_dir, "proofs")
    runs = []
    try:
        entries = sorted(os.listdir(proofs_dir))
    except (OSError, FileNotFoundError):
        return runs
    for name in entries:
        d = os.path.join(proofs_dir, name)
        if not os.path.isdir(d):
            continue
        proof = _read_json(os.path.join(d, "proof.json"), default=None)
        if not isinstance(proof, dict):
            # Malformed / partial proof: skip, do not fail the trajectory.
            continue
        verdict, false_verified = _verdict_evidence(proof)
        by_type, waited_s, active_s = _intervention_detail(proof)
        runs.append({
            "verdict": verdict,
            "false_verified": false_verified,
            "cost_usd": _cost_value(proof),
            "interventions_by_type": by_type,
            "waited_s": waited_s,
            "active_s": active_s,
            "run_id": str(proof.get("run_id") or name),
            "generated_at": proof.get("generated_at"),
            "council_pass_rate": _council_pass_value(proof.get("council")),
            "gate_pass_rate": _gate_rate_value(proof.get("quality_gates")),
            "iterations": _iterations_value(proof.get("iterations")),
            "interventions": _interventions_value(proof),
        })
    # Order by generated_at ascending; runs without a timestamp sort last but
    # keep stable directory order among themselves.
    runs.sort(key=lambda r: (r.get("generated_at") is None, r.get("generated_at") or ""))
    return runs


def _mean(values):
    return sum(values) / len(values) if values else None


def _direction_for_axis(axis, ordered_values):
    """Compute direction for one axis over the time-ordered non-null values.

    Returns a dict describing the axis trend, or available=False when there is
    not enough non-null data (fewer than 2 points) to state a direction.
    """
    higher_is_better = _AXIS_HIGHER_IS_BETTER[axis]
    eps = _AXIS_EPSILON[axis]
    pts = [v for v in ordered_values if v is not None]
    n = len(pts)
    if n == 0:
        return {
            "axis": axis,
            "label": _AXIS_LABELS[axis],
            "available": False,
            "higher_is_better": higher_is_better,
            "note": "no runs recorded this metric",
        }
    if n < 2:
        return {
            "axis": axis,
            "label": _AXIS_LABELS[axis],
            "available": True,
            "data_points": n,
            "latest": round(pts[-1], 4),
            "higher_is_better": higher_is_better,
            "direction": "flat",
            "improving": None,
            "delta": 0.0,
            "earlier_mean": round(pts[0], 4),
            "later_mean": round(pts[-1], 4),
            "insufficient": True,
            "note": "not enough history yet (need 2+ runs with this metric)",
        }
    # Median half-split. Odd count drops the middle so halves never overlap.
    half = n // 2
    earlier = pts[:half]
    later = pts[n - half:]
    earlier_mean = _mean(earlier)
    later_mean = _mean(later)
    delta = later_mean - earlier_mean
    if abs(delta) <= eps:
        direction = "flat"
    elif delta > 0:
        direction = "up"
    else:
        direction = "down"
    if direction == "flat":
        improving = None
    else:
        going_up = direction == "up"
        improving = (going_up == higher_is_better)
    return {
        "axis": axis,
        "label": _AXIS_LABELS[axis],
        "available": True,
        "data_points": n,
        "latest": round(pts[-1], 4),
        "higher_is_better": higher_is_better,
        "direction": direction,
        "improving": improving,
        "delta": round(delta, 4),
        "earlier_mean": round(earlier_mean, 4),
        "later_mean": round(later_mean, 4),
        "insufficient": False,
    }


def outcome_effort(series):
    """Effort-per-outcome block; every unmeasured input yields None, never 0."""
    accepted = sum(1 for r in series if r["verdict"] == "VERIFIED" and r["false_verified"] is not True)
    claimed = sum(1 for r in series if r["verdict"] == "VERIFIED" or r["false_verified"] is True)
    false_v = sum(1 for r in series if r["false_verified"] is True)
    unmeasured = sum(1 for r in series if r["cost_usd"] is None)
    cost = None
    cost_note = None
    if not series:
        cost_note = "no runs"
    elif accepted == 0:
        cost_note = "no accepted run, cost per accepted is undefined"
    elif unmeasured:
        cost_note = "cost unmeasured for %d of %d runs, a partial sum is not a total" % (unmeasured, len(series))
    else:
        cost = round(sum(r["cost_usd"] for r in series) / accepted, 6)
    with_detail = [r for r in series if r["interventions_by_type"] is not None]
    by_type = None
    if with_detail:
        by_type = {k: sum(r["interventions_by_type"][k] for r in with_detail) for k in _IV_TYPES}
    all_iv = bool(series) and all(r["interventions"] is not None for r in series)
    all_waited = bool(series) and all(r["waited_s"] is not None for r in series)
    all_active = bool(series) and all(r["active_s"] is not None for r in series)
    return {
        "runs": len(series),
        "accepted": accepted,
        "claimed_verified": claimed,
        "false_verified": false_v,
        "misleading_completion_rate": round(false_v / claimed, 4) if claimed else None,
        "cost_per_accepted_usd": cost,
        "cost_note": cost_note,
        "interventions_by_type": by_type,
        "interventions_per_accepted": (
            round(sum(r["interventions"] for r in series) / accepted, 4) if accepted and all_iv else None),
        "waited_min_per_accepted": (
            round(sum(r["waited_s"] for r in series) / 60.0 / accepted, 1) if accepted and all_waited else None),
        "active_min_per_accepted": (
            round(sum(r["active_s"] for r in series) / 60.0 / accepted, 1) if accepted and all_active else None),
    }


def _fmt_outcome_effort(e):
    mc = e.get("misleading_completion_rate")
    lines = ["Outcome effort"]
    lines.append("  Accepted (VERIFIED): %d of %d runs" % (e["accepted"], e["runs"]))
    lines.append("  Misleading completion: %s" % (
        "n/a (no VERIFIED claims)" if mc is None else
        "%d of %d VERIFIED claims (%s%%)" % (e["false_verified"], e["claimed_verified"], round(mc * 100, 1))))
    lines.append("  Cost per accepted: %s" % (
        "n/a (%s)" % (e.get("cost_note") or "unmeasured") if e["cost_per_accepted_usd"] is None
        else "$%.2f" % e["cost_per_accepted_usd"]))
    bt = e.get("interventions_by_type")
    lines.append("  Interventions by type: %s" % (
        "not recorded" if bt is None else ", ".join("%s %d" % (k, bt[k]) for k in _IV_TYPES)))
    ipa = e.get("interventions_per_accepted")
    lines.append("  Interventions per accepted: %s" % ("n/a" if ipa is None else ipa))
    w = e.get("waited_min_per_accepted")
    lines.append("  Minutes per accepted: %s" % (
        "n/a" if w is None else "%s (waited, upper bound)" % w))
    am = e.get("active_min_per_accepted")
    lines.append("  Active minutes per accepted: %s" % ("n/a (not measured)" if am is None else am))
    return lines


def compute_trajectory(loki_dir):
    """Return the R4 trust trajectory snapshot for a project's .loki dir."""
    runs = _load_runs(loki_dir)
    axes_order = ["council_pass_rate", "gate_pass_rate", "iterations", "interventions"]

    series = []
    for r in runs:
        series.append({
            "run_id": r["run_id"],
            "generated_at": r["generated_at"],
            "council_pass_rate": r["council_pass_rate"],
            "gate_pass_rate": r["gate_pass_rate"],
            "iterations": r["iterations"],
            "interventions": r["interventions"],
            "cost_usd": r["cost_usd"],
            "interventions_by_type": r["interventions_by_type"],
            "waited_s": r["waited_s"],
            "active_s": r["active_s"],
            "verdict": r["verdict"],
            "false_verified": r["false_verified"],
        })

    axes = {}
    for axis in axes_order:
        axes[axis] = _direction_for_axis(axis, [r[axis] for r in runs])

    insufficient = len(runs) < 2
    improving_axes = [
        a for a in axes_order
        if axes[a].get("available") and axes[a].get("improving") is True
    ]
    regressing_axes = [
        a for a in axes_order
        if axes[a].get("available") and axes[a].get("improving") is False
    ]

    notes = []
    if insufficient:
        notes.append(
            "not enough history yet: %d run(s) recorded, need 2+ to show a trend"
            % len(runs)
        )
    if not axes["interventions"].get("available"):
        notes.append(
            "intervention trend unavailable: no per-run intervention count in "
            "proof.json yet (axis lights up automatically once recorded)"
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "loki_dir": loki_dir,
        "runs_count": len(runs),
        "insufficient": insufficient,
        "axes": axes,
        "improving_count": len(improving_axes),
        "regressing_count": len(regressing_axes),
        "improving_axes": improving_axes,
        "regressing_axes": regressing_axes,
        "series": series,
        "notes": notes,
        "outcome_effort": outcome_effort(series),
    }


def write_trajectory_cache(loki_dir, traj):
    """Persist the derived trajectory to .loki/metrics/trust-trajectory.json.

    Best-effort: returns the path on success, None on failure. This is a cache,
    always recomputable from .loki/proofs/; failure to write is non-fatal.
    """
    out_dir = os.path.join(loki_dir, "metrics")
    out_path = os.path.join(out_dir, "trust-trajectory.json")
    try:
        os.makedirs(out_dir, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as fh:
            json.dump(traj, fh, indent=2)
        return out_path
    except Exception:
        return None


def format_trajectory_json(traj):
    return json.dumps(traj, indent=2)


def _arrow(direction):
    return {"up": "up", "down": "down", "flat": "flat"}.get(direction, "?")


def _fmt_axis_line(ax):
    label = ax.get("label", ax.get("axis", "?"))
    if not ax.get("available"):
        return "  %-26s %s" % (label + ":", "no data")
    direction = ax.get("direction", "flat")
    latest = ax.get("latest")
    higher = ax.get("higher_is_better")
    if ax.get("insufficient"):
        tag = "(need 2+ runs)"
    elif ax.get("improving") is True:
        tag = "improving"
    elif ax.get("improving") is False:
        tag = "regressing"
    else:
        tag = "stable"
    polarity = "higher better" if higher else "lower better"
    return "  %-26s %-5s latest=%-7s %-11s [%s]" % (
        label + ":", _arrow(direction), latest, tag, polarity,
    )


def format_trajectory_human(traj):
    lines = []
    lines.append("Loki Mode Trust Trajectory  (snapshot at %s)" % traj.get("generated_at"))
    lines.append("Source: %s" % traj.get("loki_dir"))
    lines.append("Runs analyzed: %s" % traj.get("runs_count"))
    lines.append("")
    if traj.get("insufficient"):
        lines.append("Not enough history yet.")
        lines.append("Trust trajectory needs 2+ recorded runs to show a direction.")
        lines.append("Each `loki start` run writes a proof-of-run; come back after the next run.")
        if traj.get("runs_count") and traj.get("outcome_effort"):
            lines.append("")
            lines.extend(_fmt_outcome_effort(traj["outcome_effort"]))
        if traj.get("notes"):
            lines.append("")
            lines.append("Notes")
            for n in traj["notes"]:
                lines.append("  - %s" % n)
        return "\n".join(lines)
    axes = traj.get("axes", {})
    lines.append("Is the agent earning autonomy on this repo?")
    for axis in ("council_pass_rate", "gate_pass_rate", "iterations", "interventions"):
        if axis in axes:
            lines.append(_fmt_axis_line(axes[axis]))
    lines.append("")
    imp = traj.get("improving_count", 0)
    reg = traj.get("regressing_count", 0)
    if imp and not reg:
        lines.append("Overall: trending more trustworthy (%d axis improving)." % imp)
    elif reg and not imp:
        lines.append("Overall: trust regressing (%d axis regressing). Review recent runs." % reg)
    elif imp or reg:
        lines.append("Overall: mixed (%d improving / %d regressing)." % (imp, reg))
    else:
        lines.append("Overall: stable.")
    if traj.get("outcome_effort"):
        lines.append("")
        lines.extend(_fmt_outcome_effort(traj["outcome_effort"]))
    if traj.get("notes"):
        lines.append("")
        lines.append("Notes")
        for n in traj["notes"]:
            lines.append("  - %s" % n)
    return "\n".join(lines)


def _resolve_loki_dir(argv):
    for i, a in enumerate(argv):
        if a == "--loki-dir" and i + 1 < len(argv):
            return argv[i + 1]
        if a.startswith("--loki-dir="):
            return a.split("=", 1)[1]
    env = os.environ.get("LOKI_DIR")
    if env:
        return env
    return os.path.join(os.getcwd(), ".loki")


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    as_json = "--json" in argv
    no_cache = "--no-cache" in argv
    loki_dir = _resolve_loki_dir(argv)
    traj = compute_trajectory(loki_dir)
    if not no_cache:
        write_trajectory_cache(loki_dir, traj)
    if as_json:
        sys.stdout.write(format_trajectory_json(traj) + "\n")
    else:
        sys.stdout.write(format_trajectory_human(traj) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
