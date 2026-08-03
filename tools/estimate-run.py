#!/usr/bin/env python3
"""Pre-run cost estimate: what is this run likely to cost, and on what basis.

WHY THIS EXISTS. cost-summary.py answers "what did that run cost" AFTER the
fact. The PRD-shaped estimator behind `loki plan` answers "what will a build of
this PRD cost" from PRD heuristics, before any run exists. Neither answers the
question an operator asks when they already have history in this workspace:
given what iterations here have ACTUALLY cost, what is N more likely to cost.

THE HONESTY RULE THIS INHERITS. Unmeasured is not free. That confusion shipped
to a user on four separate surfaces (v8.51.0 through v8.54.0). This is another
surface reading the same records, so it obeys the same rule by importing the
same predicate rather than restating it:

  - Zero measured records means NO BASIS. The projection is None and the render
    says so. It never prints $0.00, because a fabricated zero is exactly the
    defect this lineage keeps paying down, and a forward-looking $0.00 is worse
    than a backward-looking one: it invites someone to start a run believing it
    is free.
  - Unmeasured records are EXCLUDED from the basis, never averaged in as zero.
    The count that informed the estimate is always stated, so a 2-of-9 basis
    can never be mistaken for a 9-of-9 one.
  - A single data point is labelled as a single data point. A median of one is
    arithmetically fine and epistemically nearly worthless; saying "median"
    without saying "of 1" is how a guess acquires unearned authority.
  - The output is labelled an ESTIMATE with its basis. Never a guarantee.

MEASURED IS NOT THE SAME AS PRICED. record_is_measured() is field-agnostic on
purpose: a record carrying real tokens but cost_usd 0 is "measured" on the
strength of its tokens. For a COST basis that record is useless, and averaging
its 0 in would drag the projection toward a fabricated low -- the headline rule
inverted. Real costs are stored raw (0.018719), so a sub-cent charge is 0.0001
and never exactly 0; an exact zero is therefore a reliable unpriced signal.
cost-summary.py draws the same line for the same reason. So three counts are
reported, not two:

    found     iteration-*.json records the shared reader accepted
    measured  record_is_measured() -- carried an observed value
    priced    measured AND cost_usd is non-zero -- the actual basis

WHAT THIS DELIBERATELY DOES NOT DO. It does not derive a median ITERATION COUNT.
One workspace's .loki/metrics/efficiency/ holds one run's iterations, so a
"median iteration count" over it would be a median of one sample dressed up as a
distribution. There is no multi-run archive to draw a real one from, so
--iterations is REQUIRED. Inventing the horizon and then multiplying a real
per-iteration cost by it would launder a guess through an honest number.

Usage:
    python3 tools/estimate-run.py --iterations 12 [WORKSPACE] [--json]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import statistics
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
_LIB = os.path.join(_REPO_ROOT, "autonomy", "lib")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

# THE single definition of "measured". Restating it here is how the honesty
# rule drifts; the four surfaces that once rendered an unmeasured run as
# "$0.00" each had their own idea of what counted.
from efficiency_cost import record_is_measured  # noqa: E402

# iteration_attribution.py already reads, filters and sorts the efficiency dir
# (skipping malformed records rather than defaulting them to zero).
# cost-summary.py imports it for exactly this reason: one reader of that
# directory. A third copy would drift the same way a second predicate would.
_ia_spec = importlib.util.spec_from_file_location(
    "iteration_attribution", os.path.join(_LIB, "iteration_attribution.py"))
_ia = importlib.util.module_from_spec(_ia_spec)
_ia_spec.loader.exec_module(_ia)

# Alias-keyed table: {"pricing": {"sonnet": {"input": 3.0, "output": 15.0, ...}}}
# USD per 1M tokens. NOT the same schema as benchmarks/bench/prices.json (which
# efficiency_cost.price_from_tokens reads, keyed models.<x>.input_per_mtok), so
# this reads model-pricing.json directly rather than routing through it.
PRICING_PATH = os.path.join(
    _REPO_ROOT, "loki-ts", "data", "model-pricing.json")


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 64, not argparse's default 2.

    In this repo's convention 2 means "could NOT be checked" -- a real
    answer about the subject. A mistyped flag is not that: it is an error
    about the INVOCATION, and nothing about the subject was examined. The
    two call for opposite responses, since retrying cannot fix a typo.

    argparse exits 2 for every usage error unless this is overridden, so
    every tool needs it. tests/test_tool_exit_contract.py asserts it.
    """

    def error(self, message):
        self.print_usage(sys.stderr)
        sys.stderr.write("%s: error: %s\n" % (self.prog, message))
        raise SystemExit(64)


def _num(v):
    """Non-bool int/float, else None. Never coerces junk to 0."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def load_pricing(path=None):
    """Return the alias -> rates map, or {} when unreadable.

    A missing price table means we cannot quote a price, which is an honest
    null. It never blocks the projection: observed cost comes from the recorded
    cost_usd, not from this table.
    """
    try:
        with open(path or PRICING_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {}
    pricing = data.get("pricing") if isinstance(data, dict) else None
    return pricing if isinstance(pricing, dict) else {}


def resolve_model_now(workspace="."):
    """The model a run started NOW would use, and the lever that chose it.

    Mirrors the runner's precedence -- a pending mid-flight override file is the
    most specific, just-requested intent and wins over the session pin. Returns
    (model, source); (None, None) when neither lever is set, which is an honest
    "unresolved" rather than a guessed default. Guessing here would let the
    report assert the projection transfers when it may not.
    """
    override = os.path.join(workspace, ".loki", "state", "model-override")
    try:
        with open(override, encoding="utf-8") as handle:
            val = handle.read().strip().lower()
        if val:
            return val, "model-override file"
    except OSError:
        pass
    val = (os.environ.get("LOKI_SESSION_MODEL") or "").strip().lower()
    if val:
        return val, "LOKI_SESSION_MODEL"
    return None, None


def estimate(workspace=".", iterations=None, pricing_path=None):
    """Build the estimate dict. Pure derivation, no guessing."""
    loki_dir = os.path.join(workspace, ".loki")
    recs = _ia._iteration_records(loki_dir)

    found = len(recs)
    measured = 0
    cost_points = []      # priced costs only -- THE basis
    basis_models = []     # models of the priced records, in order

    for rec in recs:
        if not record_is_measured(rec):
            # EXCLUDED, not added as zero. Averaging an unmeasured iteration in
            # as 0 is indistinguishable from a real measurement of 0.
            continue
        measured += 1
        usd = _num(rec.get("cost_usd"))
        # Measured on tokens but unpriced: real for token accounting, useless
        # for a cost basis, and a fabricated low if averaged in. See module
        # docstring.
        if usd is None or usd == 0:
            continue
        cost_points.append(float(usd))
        model = rec.get("model")
        basis_models.append(str(model) if model else "")

    # THE HONESTY GUARD. No priced history means no basis, so every downstream
    # number is None and the render says why. Turning this into 0.0 is the
    # "unmeasured becomes free" defect, pointed at the future.
    median_usd = None if not cost_points else statistics.median(cost_points)

    known_models = sorted({m for m in basis_models if m})
    model_now, model_source = resolve_model_now(workspace)
    rates = load_pricing(pricing_path).get(model_now) if model_now else None

    out = {
        "workspace": os.path.abspath(workspace),
        "label": "ESTIMATE",
        "iterations_found": found,
        "iterations_measured": measured,
        "iterations_priced": len(cost_points),
        "basis_count": len(cost_points),
        "has_basis": bool(cost_points),
        "single_point_basis": len(cost_points) == 1,
        "median_cost_per_iteration_usd": (
            None if median_usd is None else round(median_usd, 4)),
        "min_cost_per_iteration_usd": (
            round(min(cost_points), 4) if cost_points else None),
        "max_cost_per_iteration_usd": (
            round(max(cost_points), 4) if cost_points else None),
        "iterations_projected": iterations,
        "projected_cost_usd": (
            round(median_usd * iterations, 4)
            if median_usd is not None and iterations else None),
        "basis_models": known_models,
        "model_now": model_now,
        "model_now_source": model_source,
        "model_now_price_per_mtok": (
            {"input": rates.get("input"), "output": rates.get("output"),
             "cache_read": rates.get("cache_read")}
            if isinstance(rates, dict) else None),
        "projection_transfers": None,
        "notes": [],
    }

    n = out["notes"]

    if found == 0:
        n.append(
            "no iteration records found in this workspace: there is NO history "
            "to project from, so no cost is estimated (not $0.00)")
    elif not cost_points:
        n.append(
            "no measured, priced iteration in %d record(s): there is NO basis "
            "to project from, so no cost is estimated (not $0.00)" % found)
        if measured:
            n.append(
                "%d of %d records carried tokens but no cost (unpriced model): "
                "spend is unknown rather than zero, so they cannot form a basis"
                % (measured - len(cost_points), measured))
    else:
        n.append(
            "ESTIMATE based on %d measured, priced iteration(s) of %d found -- "
            "not a guarantee" % (len(cost_points), found))
        if len(cost_points) == 1:
            n.append(
                "the basis is a SINGLE data point: this is one observation "
                "extrapolated, not a distribution, and the range is that one "
                "point")
        if len(cost_points) < found:
            n.append(
                "PARTIAL: %d of %d records did not inform the estimate "
                "(unmeasured or unpriced), and were excluded rather than "
                "counted as zero" % (found - len(cost_points), found))
        if iterations is None:
            n.append(
                "no --iterations given and no multi-run history exists to "
                "derive a median iteration count from: pass --iterations N for "
                "a projection")

    # MODEL TRANSFER. Naming the model is not enough -- if history was priced on
    # a different model than the one that would run now, the per-iteration
    # median does not carry over, and saying so is the difference between an
    # estimate and a misleading one.
    if cost_points:
        if len(known_models) > 1:
            out["projection_transfers"] = False
            n.append(
                "the basis MIXES models (%s): a single median across different "
                "price points may not transfer to either" % ", ".join(known_models))
        elif not known_models:
            out["projection_transfers"] = None
            n.append(
                "the basis records name no model: whether this projection "
                "transfers to the model that would run now is unknown")
        elif model_now is None:
            out["projection_transfers"] = None
            n.append(
                "basis model is %s; no model is pinned for a run now "
                "(LOKI_SESSION_MODEL unset, no override file), so whether the "
                "projection transfers is unknown" % known_models[0])
        elif model_now != known_models[0]:
            out["projection_transfers"] = False
            n.append(
                "basis model is %s but a run now would use %s (%s): this "
                "projection MAY NOT TRANSFER" % (
                    known_models[0], model_now, model_source))
        else:
            out["projection_transfers"] = True

    if model_now and rates is None:
        n.append(
            "no price listed for %s in the pricing table: its rate is not "
            "quoted (the projection still comes from observed cost, not price)"
            % model_now)

    return out


def _fmt_usd(v):
    """UNKNOWN, never $0.00, when there is nothing to report."""
    return "UNKNOWN" if v is None else "$%.4f" % v


def render(est):
    """Human-readable report. The honesty lives here too, not only in the dict."""
    lines = []
    lines.append("Run cost ESTIMATE -- %s" % est["workspace"])
    lines.append("")

    if not est["has_basis"]:
        lines.append("  NO BASIS: no measured, priced iteration to project from.")
        lines.append("  Cost per iteration:  UNKNOWN")
        lines.append("  Projected cost:      UNKNOWN")
        lines.append("  Records found: %d  measured: %d  priced: %d"
                     % (est["iterations_found"], est["iterations_measured"],
                        est["iterations_priced"]))
    else:
        lines.append("  Basis:               %d measured, priced iteration(s) "
                     "of %d found" % (est["basis_count"], est["iterations_found"]))
        lines.append("  Cost per iteration:  median %s  (range %s - %s)" % (
            _fmt_usd(est["median_cost_per_iteration_usd"]),
            _fmt_usd(est["min_cost_per_iteration_usd"]),
            _fmt_usd(est["max_cost_per_iteration_usd"])))
        if est["iterations_projected"]:
            label = "Projected for %d:" % est["iterations_projected"]
            lines.append("  %-20s %s"
                         % (label, _fmt_usd(est["projected_cost_usd"])))
        else:
            lines.append("  Projected cost:      UNKNOWN (pass --iterations N)")

    basis_models = est["basis_models"]
    lines.append("  Basis model(s):      %s"
                 % (", ".join(basis_models) if basis_models else "not recorded"))
    if est["model_now"]:
        rate = est["model_now_price_per_mtok"]
        price = ("not in pricing table" if not rate else
                 "$%s in / $%s out per Mtok" % (rate["input"], rate["output"]))
        lines.append("  Model now:           %s (via %s) -- %s"
                     % (est["model_now"], est["model_now_source"], price))
    else:
        lines.append("  Model now:           not pinned")

    lines.append("")
    for note in est["notes"]:
        lines.append("  - %s" % note)
    return "\n".join(lines)


def main(argv=None):
    ap = _Parser(
        description="Estimate what a run is likely to cost, from measured history.")
    ap.add_argument("workspace", nargs="?", default=".")
    ap.add_argument("--iterations", type=int, default=None,
                    help="how many iterations to project (no multi-run history "
                         "exists to derive this, so it is required for a "
                         "projected total)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    # A workspace that does not EXIST is not the same fact as one with no cost
    # history, and exit 0 collapsed them. preflight.sh consumes this tool, so a
    # mistyped or unmounted path silently became "no basis to project from"
    # instead of an error. Same defect fixed in model-advisor.py in v8.96.0;
    # tests/test_tool_exit_contract.py now catches the class rather than the
    # instance.
    if not os.path.isdir(args.workspace):
        sys.stderr.write(
            "cannot estimate: workspace does not exist: %s\n" % args.workspace)
        return 66

    est = estimate(args.workspace, args.iterations)
    if args.json:
        print(json.dumps(est, indent=2))
    else:
        print(render(est))
    # Exit 0 for a REAL workspace with no basis: that is a successful, honest
    # answer rather than a tool failure, and the output says so. Callers read
    # has_basis.
    return 0


if __name__ == "__main__":
    sys.exit(main())
