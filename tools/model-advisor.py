#!/usr/bin/env python3
"""Would a cheaper model have done this job, and what would it have saved.

WHY THIS EXISTS. This project has one order-of-magnitude finding from its own
benchmark work: on SWE-bench verified, MiniMax M2.5 (open weights) scored 75.8
against Claude Opus 4.6's 75.6, at $36.64 against $275.76 -- roughly 7.5x
cheaper for equal-or-better quality. Separately, the HARNESS was worth about
3.4 points on an identical model. Nothing in the product surfaces any of that
to an operator deciding what to run. estimate-run.py answers "what will this
cost on the model I am already using". Nothing answers "should I be using a
different model at all".

WHAT SEPARATION MAKES THIS HONEST. Two things are kept strictly apart, and
conflating them is the failure mode this tool exists to avoid:

  RATE, which we can compute. The pricing table gives USD per Mtok. Replaying
  THIS workspace's observed token vector through another model's rates is
  arithmetic, and the resulting ratio is a fact about prices.

  QUALITY, which we cannot compute. Whether the cheaper model would have
  produced the same result on YOUR workload is not something any cost record
  can answer. The SWE-bench figures above are reported as a CITED EXTERNAL
  BENCHMARK with the numbers attached, on a different workload, and they never
  rank a candidate, never weight a recommendation, and are never phrased as a
  promise. A ranking driven by a benchmark we did not run on your task would be
  exactly the fabricated authority this repo has spent thirteen surfaces
  removing.

THE HONESTY RULES, inherited from the cost lineage (v8.51.0 - v8.54.0, where a
single missing measurement became four different renderings of "$0.00"):

  1. NO MEASURED BASIS MEANS NO RECOMMENDATION. Not a smaller saving, not a
     zero -- no number at all, and the output says why. A projected saving with
     no history behind it is an invented fact, and it is worse than an invented
     past cost because it invites a switch.
  2. Every projection is labelled ESTIMATE with the count of records it rests
     on. A basis of one is stated as a basis of one.
  3. A CHEAPER RATE IS NOT A CHEAPER RUN. Token counts differ between models: a
     weaker model can need more iterations, longer outputs, more retries, and
     the saving assumes comparable token usage. We cannot verify that
     assumption from cost records alone, and the output says so in the output
     itself, not only in this docstring.
  4. A model absent from the pricing table reads "unpriced". Never $0, never
     omitted silently, and never ranked -- an unpriced model with no ratio
     cannot be claimed to be cheaper.

HOW THE RATIO IS COMPUTED, and why not the obvious way. The naive form is
candidate_input_rate / incumbent_input_rate. That is wrong here: output tokens
cost 5x input, cache reads a tenth, and the mix varies enormously between
workloads. So the observed token vector from the measured records is replayed
through BOTH models' full rate cards:

    ratio = modelled_candidate / modelled_incumbent

then the saving scales the RECORDED cost, not the modelled one:

    projected_candidate_usd = recorded_usd * ratio

The ratio is dimensionless, so it cancels drift between the table and what was
actually billed -- and sonnet is on intro pricing through 2026-08-31 per the
table's own _source note, so that drift is real today. The saving therefore
stays anchored to a measured number rather than to a price-card reconstruction.

If the modelled incumbent cost is zero (records carry cost but no tokens), the
ratio is undefined and we say so rather than falling back to an input-only
ratio, which would quietly answer a different question.

Usage:
    python3 tools/model-advisor.py [WORKSPACE] [--json]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys

# ponytail: bytecode writing off before any file-based loader, so a probe that
# mutates and restores a file cannot be served a stale .pyc of the pre-mutation
# source.
sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_HERE)
_LIB = os.path.join(_REPO_ROOT, "autonomy", "lib")
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)

# THE single definition of "measured". Restating it is how the honesty rule
# drifts; the four surfaces that once rendered an unmeasured run as "$0.00"
# each had their own idea of what counted.
from efficiency_cost import record_is_measured  # noqa: E402

# One reader of .loki/metrics/efficiency/ -- it already skips malformed records
# rather than defaulting them to zero. cost-summary.py and estimate-run.py load
# it exactly this way; a third copy would drift the same way a second predicate
# would.
_ia_spec = importlib.util.spec_from_file_location(
    "iteration_attribution", os.path.join(_LIB, "iteration_attribution.py"))
_ia = importlib.util.module_from_spec(_ia_spec)
_ia_spec.loader.exec_module(_ia)

# Alias-keyed: {"pricing": {"sonnet": {"input": 3.0, "output": 15.0,
# "cache_read": 0.3, "cache_write": 3.75}}}, USD per 1M tokens. NOT the schema
# of benchmarks/bench/prices.json (models.<x>.input_per_mtok), so this reads
# the file directly rather than routing through price_from_tokens.
PRICING_PATH = os.path.join(
    _REPO_ROOT, "loki-ts", "data", "model-pricing.json")

# Record token field -> pricing rate field. cache_creation is billed at the
# write rate, which is 1.25x input and NOT the same as fresh input.
_TOKEN_TO_RATE = (
    ("input_tokens", "input"),
    ("output_tokens", "output"),
    ("cache_read_tokens", "cache_read"),
    ("cache_creation_tokens", "cache_write"),
)

# A cited EXTERNAL benchmark on an EXTERNAL workload. Reported verbatim with
# its numbers so a reader can weigh it; never an input to the ranking, which is
# ordered purely by computed rate. See module docstring.
SWEBENCH_CITATION = {
    "benchmark": "SWE-bench verified",
    "workload": "SWE-bench verified issues -- NOT this workspace's workload",
    "results": [
        {"model": "MiniMax M2.5 (open weights)", "score": 75.8,
         "cost_usd": 36.64},
        {"model": "Claude Opus 4.6", "score": 75.6, "cost_usd": 275.76},
    ],
    "harness_effect": (
        "the harness itself was worth about 3.4 points on an identical model"),
    "caveat": (
        "equal-or-better score at roughly 7.5x lower cost ON THAT BENCHMARK. "
        "It is not a measurement of your workload and does not predict that a "
        "cheaper model would complete YOUR task"),
}


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

    A missing table means we cannot quote any rate, which is an honest null:
    every model then reads unpriced and no ratio is offered.
    """
    try:
        with open(path or PRICING_PATH, encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {}
    pricing = data.get("pricing") if isinstance(data, dict) else None
    return pricing if isinstance(pricing, dict) else {}


def modelled_cost(tokens, rates):
    """Replay an observed token vector through one model's full rate card.

    Returns USD, or None when the model has no usable rates -- unpriced, which
    must never render as 0. Rates are per 1M tokens.
    """
    if not isinstance(rates, dict):
        return None
    total = 0.0
    priced_any = False
    for tok_key, rate_key in _TOKEN_TO_RATE:
        rate = _num(rates.get(rate_key))
        if rate is None:
            continue
        priced_any = True
        total += (tokens.get(tok_key, 0) / 1_000_000.0) * rate
    # A table entry naming the model but carrying no numeric rate prices
    # nothing. That is unpriced, not free.
    return total if priced_any else None


def advise(workspace=".", pricing_path=None):
    """Build the advice dict. Pure derivation from measured records."""
    loki_dir = os.path.join(workspace, ".loki")
    recs = _ia._iteration_records(loki_dir)

    found = len(recs)
    measured = 0
    priced = 0
    recorded_usd = 0.0
    tokens = {key: 0 for key, _ in _TOKEN_TO_RATE}
    by_model_cost = {}

    for rec in recs:
        if not record_is_measured(rec):
            # EXCLUDED, not summed as zero. An unmeasured iteration averaged in
            # as 0 is indistinguishable from a real measurement of 0.
            continue
        measured += 1
        usd = _num(rec.get("cost_usd"))
        # Measured on tokens but carrying no cost is real for token accounting
        # and useless as a COST basis. Real costs are stored raw (0.018719), so
        # a sub-cent charge is 0.0001 and never exactly 0; an exact zero is a
        # reliable unpriced signal. estimate-run.py draws the same line.
        if usd is None or usd == 0:
            continue
        priced += 1
        recorded_usd += float(usd)
        for key, _ in _TOKEN_TO_RATE:
            tokens[key] += _num(rec.get(key)) or 0
        name = str(rec.get("model") or "").strip()
        by_model_cost[name] = by_model_cost.get(name, 0.0) + float(usd)

    pricing = load_pricing(pricing_path)

    # THE INCUMBENT. Not collect_efficiency()'s last-non-empty-seen model:
    # across mixed history that names whichever model happened to be recorded
    # last, which is not the model the spend belongs to. Dominant by COST
    # share, with the mix always reported.
    incumbent = None
    if by_model_cost:
        named = {k: v for k, v in by_model_cost.items() if k}
        if named:
            incumbent = max(named, key=lambda k: named[k])
    mixed = len([k for k in by_model_cost if k]) > 1

    incumbent_rates = pricing.get(incumbent) if incumbent else None
    incumbent_modelled = modelled_cost(tokens, incumbent_rates)

    out = {
        "workspace": os.path.abspath(workspace),
        "label": "ESTIMATE",
        "iterations_found": found,
        "iterations_measured": measured,
        "iterations_priced": priced,
        "basis_count": priced,
        "has_basis": priced > 0,
        "single_point_basis": priced == 1,
        "incumbent_model": incumbent,
        "incumbent_priced": incumbent_rates is not None,
        "incumbent_recorded_cost_usd": (
            round(recorded_usd, 4) if priced else None),
        "observed_tokens": dict(tokens) if priced else None,
        "basis_models": sorted(k for k in by_model_cost if k),
        "mixed_basis_models": mixed,
        "candidates": [],
        "best_candidate": None,
        "swebench_citation": SWEBENCH_CITATION,
        "assumption_verified": False,
        "notes": [],
    }

    n = out["notes"]

    # ---- THE HONESTY GUARD -------------------------------------------------
    # No priced history means no basis, so there is no recommendation and no
    # number. Softening this into a 0.0 saving, or into a rate-only ranking
    # dressed as advice, is the "unmeasured becomes free" defect pointed at a
    # purchasing decision.
    if not out["has_basis"]:
        out["incumbent_recorded_cost_usd"] = None
        if found == 0:
            n.append(
                "NO BASIS: no iteration records in this workspace. There is no "
                "measured history to compare models against, so no saving is "
                "projected (not $0.00) and no model is recommended")
        else:
            n.append(
                "NO BASIS: no measured, priced iteration among %d record(s). "
                "There is no measured history to compare models against, so no "
                "saving is projected (not $0.00) and no model is recommended"
                % found)
            if measured > priced:
                n.append(
                    "%d of %d measured record(s) carried tokens but no cost "
                    "(unpriced): that spend is UNKNOWN rather than zero, so it "
                    "cannot form a basis" % (measured - priced, measured))
        n.append(
            "run an iteration with cost recording enabled, then re-run this "
            "tool")
        return out
    # ------------------------------------------------------------------------

    n.append(
        "ESTIMATE based on %d measured, priced iteration(s) of %d found -- "
        "not a guarantee" % (priced, found))
    if priced == 1:
        n.append(
            "the basis is a SINGLE data point: one observation extrapolated, "
            "not a distribution")
    if priced < found:
        n.append(
            "PARTIAL: %d of %d record(s) did not inform this comparison "
            "(unmeasured or unpriced), and were excluded rather than counted "
            "as zero" % (found - priced, found))
    if mixed:
        n.append(
            "the basis MIXES models (%s): the incumbent below is the one with "
            "the largest share of recorded cost, and a single ratio across "
            "different price points may not transfer to either"
            % ", ".join(out["basis_models"]))

    if incumbent is None:
        n.append(
            "the priced records name no model: the incumbent is unknown, so no "
            "rate ratio can be computed and no saving is projected")
        return out

    if incumbent_rates is None:
        n.append(
            "no price listed for the incumbent %s in the pricing table: it "
            "reads UNPRICED (not $0), and without its rates no ratio against "
            "any candidate can be computed, so no saving is projected"
            % incumbent)
        return out

    if not incumbent_modelled:
        # Cost recorded but no tokens (or all rates zero): the ratio's
        # denominator is zero. Falling back to an input-rate-only ratio here
        # would silently answer a different question.
        n.append(
            "the measured records carry cost but no usable token counts, so "
            "the incumbent's modelled cost is zero and every ratio would be "
            "undefined: no saving is projected")
        return out

    # ---- CANDIDATES --------------------------------------------------------
    # Ordered purely by computed rate ratio. The SWE-bench citation is attached
    # to the report as external context and deliberately does NOT rank anything.
    for name in sorted(pricing):
        if name == incumbent:
            continue
        cand_modelled = modelled_cost(tokens, pricing.get(name))
        if cand_modelled is None:
            # Named in the table but with no usable rate: unpriced, so it is
            # listed as unpriced and carries no ratio and no saving.
            out["candidates"].append({
                "model": name, "priced": False, "rate_ratio": None,
                "projected_cost_usd": None, "projected_saving_usd": None,
                "cheaper": None,
            })
            continue
        ratio = cand_modelled / incumbent_modelled
        projected = recorded_usd * ratio
        out["candidates"].append({
            "model": name,
            "priced": True,
            "rate_ratio": round(ratio, 4),
            "projected_cost_usd": round(projected, 4),
            "projected_saving_usd": round(recorded_usd - projected, 4),
            "cheaper": ratio < 1.0,
        })

    cheaper = [c for c in out["candidates"] if c["cheaper"]]
    cheaper.sort(key=lambda c: c["rate_ratio"])
    out["candidates"].sort(
        key=lambda c: (c["rate_ratio"] is None, c["rate_ratio"]))

    if cheaper:
        out["best_candidate"] = cheaper[0]["model"]
        n.append(
            "%d cheaper-RATE candidate(s) found; cheapest is %s at %.2fx the "
            "incumbent's rate on this workspace's observed token mix"
            % (len(cheaper), cheaper[0]["model"], cheaper[0]["rate_ratio"]))
    else:
        # Already on the cheapest priced model. Saying "no cheaper candidate"
        # is a real answer; an empty ranked list rendered as a saving of
        # nothing is not.
        n.append(
            "no cheaper-rate candidate: %s is already the cheapest priced "
            "model in the table for this token mix" % incumbent)

    unpriced = [c["model"] for c in out["candidates"] if not c["priced"]]
    if unpriced:
        n.append(
            "unpriced (no rate in the pricing table, so UNKNOWN and not $0, "
            "and not ranked): %s" % ", ".join(unpriced))

    # RULE 3, stated in the output and not only in the source. Every number
    # above is a rate comparison holding tokens fixed; nothing here has
    # measured a second model on this workload.
    n.append(
        "A CHEAPER RATE IS NOT A CHEAPER RUN. Every projection above replays "
        "THIS run's observed token counts through another model's rates. Token "
        "counts differ between models -- a different model may need more "
        "iterations, longer outputs or more retries -- so the saving assumes "
        "COMPARABLE TOKEN USAGE")
    n.append(
        "that assumption is NOT VERIFIED here: this workspace has no measured "
        "run on any candidate model, so its real token usage is unknown. The "
        "only way to verify it is to run the candidate and compare")
    n.append(
        "quality is NOT projected. The SWE-bench figures in this report are a "
        "cited external benchmark on a different workload, not a prediction "
        "about your task")
    return out


def _fmt_usd(v):
    """UNKNOWN, never $0.00, when there is nothing to report."""
    return "UNKNOWN" if v is None else "$%.4f" % v


def _fmt_saving(v):
    """A negative saving is EXTRA COST and must not read as one.

    "$-1.6558" in a SAVING column is a number a reader skims as a saving with a
    stray character. A more expensive model costs more; say that.
    """
    if v is None:
        return "UNKNOWN"
    return "$%.4f" % v if v >= 0 else "+$%.4f more" % abs(v)


def render(adv):
    """Human-readable report. The honesty lives here too, not only in the dict."""
    lines = []
    lines.append("Model cost advisor -- %s" % adv["workspace"])
    lines.append("")

    if not adv["has_basis"]:
        lines.append("  NO BASIS: no measured, priced iteration in this workspace.")
        lines.append("  Model used:          UNKNOWN")
        lines.append("  Measured cost:       UNKNOWN")
        lines.append("  Recommendation:      NONE -- there is no measured basis")
        lines.append("  Projected saving:    UNKNOWN")
        lines.append("  Records found: %d  measured: %d  priced: %d"
                     % (adv["iterations_found"], adv["iterations_measured"],
                        adv["iterations_priced"]))
    else:
        lines.append("  Model used:          %s%s" % (
            adv["incumbent_model"] or "not recorded",
            "" if adv["incumbent_priced"] else "  (UNPRICED)"))
        lines.append("  Measured cost:       %s  (ESTIMATE basis: %d priced "
                     "iteration(s) of %d found)" % (
                         _fmt_usd(adv["incumbent_recorded_cost_usd"]),
                         adv["basis_count"], adv["iterations_found"]))
        lines.append("")
        if adv["candidates"]:
            lines.append("  Candidates (ESTIMATE, basis %d iteration(s)):"
                         % adv["basis_count"])
            lines.append("    %-16s %-10s %-12s %s"
                         % ("MODEL", "RATE", "PROJECTED", "SAVING"))
            for cand in adv["candidates"]:
                if not cand["priced"]:
                    lines.append("    %-16s %-10s %-12s %s" % (
                        cand["model"], "unpriced", "unpriced", "unpriced"))
                    continue
                lines.append("    %-16s %-10s %-12s %s" % (
                    cand["model"],
                    "%.2fx" % cand["rate_ratio"],
                    _fmt_usd(cand["projected_cost_usd"]),
                    _fmt_saving(cand["projected_saving_usd"])))
            lines.append("")
        if adv["best_candidate"]:
            lines.append("  Cheapest rate:       %s" % adv["best_candidate"])
        else:
            lines.append("  Cheapest rate:       none cheaper than the model "
                         "already in use")

    # LOCAL CALIBRATION, shown as a CAVEAT and never as a ranking input.
    #
    # This module's own docstring says quality "is not something any cost
    # record can answer", and that stands: nothing below re-ranks a candidate
    # or weights a saving. advise() is untouched, so the recommendation is
    # provably identical with and without this block.
    #
    # What it adds is one honest local fact. tools/calibration-audit.py scores
    # council votes against council outcomes on THIS workload, so unlike the
    # SWE-bench citation it is not borrowed from someone else's task. It is
    # surfaced ABOVE that citation for exactly that reason: local evidence
    # first, external evidence second.
    #
    # THE LIMIT, restated here because a reader arriving at a cost tool will
    # not have read the audit's header: the audit measures AGREEMENT WITH THE
    # MAJORITY, not correctness. The council outcome is derived from the votes,
    # so a voter partly causes its own label. Treating that as a quality score
    # would be the fabricated authority this tool exists to refuse -- so it is
    # printed as a pointer, with the caveat attached, and never as a number
    # that moves a recommendation.
    lines.append("")
    lines.append("  Local calibration -- a CAVEAT, not a ranking input:")
    lines.append("    Cheaper is not better if the cheaper model agrees with "
                 "your council less often.")
    lines.append("    This tool does NOT measure that and does not pretend to. "
                 "For the local signal:")
    lines.append("      python3 tools/calibration-audit.py <workspace>")
    lines.append("    Read its header first: it scores agreement with the "
                 "majority, NOT accuracy.")
    lines.append("    No artifact records whether the council was right, so no "
                 "quality claim is")
    lines.append("    available from any tool in this repo today.")

    cite = adv["swebench_citation"]
    lines.append("")
    lines.append("  Cited external benchmark (%s) -- NOT a measurement of your "
                 "workload:" % cite["benchmark"])
    for row in cite["results"]:
        lines.append("    %-30s score %.1f   cost $%.2f"
                     % (row["model"], row["score"], row["cost_usd"]))
    lines.append("    %s" % cite["harness_effect"])
    lines.append("    %s" % cite["caveat"])

    lines.append("")
    for note in adv["notes"]:
        lines.append("  - %s" % note)
    return "\n".join(lines)


def main(argv=None):
    ap = _Parser(
        description="Recommend a cheaper model from this workspace's measured "
                    "cost history, and quantify the saving.")
    ap.add_argument("workspace", nargs="?", default=".")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    # A workspace that does not EXIST is not the same fact as a workspace with
    # no cost history, and exit 0 collapsed them. A CI job doing
    # `model-advisor.py "$WS" && ...` on a mistyped or unmounted path saw green
    # and carried on. Every sibling tool distinguishes these (run-replay 66,
    # cost-guard 2, receipt-bundle 3); this one did not.
    if not os.path.isdir(args.workspace):
        sys.stderr.write(
            "cannot advise: workspace does not exist: %s\n" % args.workspace)
        return 66

    adv = advise(args.workspace)
    print(json.dumps(adv, indent=2) if args.json else render(adv))
    # Exit 0 for a real workspace with no basis: that IS a successful, honest
    # answer rather than a tool failure, and the output says so in words.
    # Callers read has_basis.
    return 0


if __name__ == "__main__":
    sys.exit(main())
