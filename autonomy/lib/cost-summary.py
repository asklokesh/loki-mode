#!/usr/bin/env python3
"""Per-run cost summary: what this run spent, and what we failed to measure.

WHY THIS EXISTS. The engine writes .loki/metrics/efficiency/iteration-N.json
every iteration, and the only ways to read it back are a dashboard HTTP
endpoint and a prompt-injection block. Neither answers the question an operator
actually asks between runs: what did that cost, is it climbing, and is the
cache working. Cache hit ratio is the number that moves cost most -- a run
reading 90% from cache costs roughly a tenth of the same run reading fresh --
and nothing on the CLI surfaced it.

THE HONESTY RULE THIS INHERITS. Unmeasured is not free. That confusion shipped
to a user on four separate surfaces (v8.51.0 through v8.54.0: the codex
dispatch recorded no tokens, the receipt said {"usd": 0.0, "available": true},
the PROMPT said "$0.00" per iteration, and the verifier never checked). Each
was fixed in isolation. This is a fifth surface reading the same records, so it
obeys the same rule, by importing the same predicate rather than restating it:

  - An unmeasured iteration prints UNKNOWN and is EXCLUDED from totals. Adding
    it as zero would be indistinguishable from a real measurement of zero.
  - When NO iteration is measured, the total reads UNKNOWN, never $0.00.
  - measured/exists is always stated, so a partial measurement can never be
    mistaken for a complete one. Half the iterations measured is half a number,
    and a total presented without that ratio silently claims to be whole.
  - A ratio over a zero denominator is UNKNOWN, not 0%. "The cache missed
    everything" is an expensive, actionable claim; we have not earned it.
  - A trend needs two measured points. "Flat" from one point is fabrication of
    the same family.

Definitions, stated because an unstated denominator is its own dishonesty:
  cache hit ratio = cache_read / (input_tokens + cache_read)
    i.e. share of everything read IN that came from cache. Same denominator as
    iteration_attribution.prompt_block, so both surfaces report one number.
  measured = the record carries a non-zero cost or token count
    (efficiency_cost.record_is_measured -- the single definition).

Usage:
    python3 autonomy/lib/cost-summary.py [WORKSPACE] [--json]
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from efficiency_cost import record_is_measured  # noqa: E402

# iteration_attribution.py already reads and sorts the efficiency dir, skipping
# malformed records. Importing it keeps ONE reader of that directory; a third
# copy would drift the same way a second honesty predicate would.
_ia_spec = importlib.util.spec_from_file_location(
    "iteration_attribution", os.path.join(_HERE, "iteration_attribution.py"))
_ia = importlib.util.module_from_spec(_ia_spec)
_ia_spec.loader.exec_module(_ia)

TOKEN_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
)


def _num(v):
    """Non-bool int/float, else None. Never coerces junk to 0."""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def _count_iteration_files(loki_dir):
    """How many iteration-*.json files EXIST, parseable or not.

    A corrupt or partial record is skipped by the reader but still happened, so
    it counts toward "exists". Dropping it from the denominator would shrink a
    partial run into a complete-looking one -- exactly the mistake the
    measured/exists ratio is here to prevent.
    """
    eff_dir = os.path.join(loki_dir, "metrics", "efficiency")
    try:
        names = os.listdir(eff_dir)
    except OSError:
        return 0
    return sum(
        1 for n in names if n.startswith("iteration-") and n.endswith(".json"))


def _ratio(cache_read, fresh_input):
    """cache_read / (fresh_input + cache_read), or None when nothing was read."""
    denom = fresh_input + cache_read
    if denom <= 0:
        return None
    return round(cache_read / denom, 4)


def summarize(workspace="."):
    """Build the summary dict. Pure derivation, no guessing."""
    loki_dir = os.path.join(workspace, ".loki")
    recs = _ia._iteration_records(loki_dir)
    exists = max(_count_iteration_files(loki_dir), len(recs))

    iterations = []
    totals = dict.fromkeys(TOKEN_FIELDS, 0)
    total_usd = 0.0
    measured = 0
    cost_points = []  # (iteration, usd) for measured costs only, for the trend

    for rec in recs:
        it = rec.get("iteration", "?")
        is_measured = record_is_measured(rec)
        row = {"iteration": it, "measured": is_measured}

        if not is_measured:
            # EXCLUDED from totals, not added as zero. These two produce an
            # identical total on a partial run, which is why the measured/exists
            # count below (not the total) is what proves the difference.
            row["cost_usd"] = None
            for f in TOKEN_FIELDS:
                row[f] = None
            row["cache_hit_ratio"] = None
            iterations.append(row)
            continue

        measured += 1
        usd = _num(rec.get("cost_usd"))
        # UNPRICED IS NOT FREE. record_is_measured() is field-agnostic: a record
        # with real tokens but cost_usd 0 is "measured" on the strength of its
        # tokens, and the cost slot would then render $0.0000 -- the headline
        # rule inverted, on a shape that actually ships. Codex tiers can record
        # tokens with no priced cost, and the real FireLater records wrote an
        # explicit "cost_usd": 0 rather than omitting the key.
        #
        # An exact zero is a reliable unpriced signal because real costs are
        # stored raw (0.018719), so a sub-cent charge is 0.0001, never 0. Same
        # truthiness rule record_is_measured applies to the aggregate, applied
        # one level down. Tokens still render; only cost reads UNKNOWN.
        if usd == 0:
            usd = None
        row["cost_usd"] = usd
        if usd is not None:
            total_usd += float(usd)
            cost_points.append((it, float(usd)))
        for f in TOKEN_FIELDS:
            v = _num(rec.get(f))
            row[f] = v
            if v is not None:
                totals[f] += int(v)
        row["cache_hit_ratio"] = _ratio(
            row.get("cache_read_tokens") or 0, row.get("input_tokens") or 0)
        iterations.append(row)

    # A measured iteration can still carry tokens but no cost (an unpriced
    # model). Cost totals therefore key on cost_points, not on `measured`.
    have_cost = bool(cost_points)

    out = {
        "workspace": os.path.abspath(workspace),
        "iterations_found": exists,
        "iterations_measured": measured,
        "fully_measured": exists > 0 and measured == exists,
        "total_cost_usd": round(total_usd, 4) if have_cost else None,
        "cost_iterations_counted": len(cost_points),
        "avg_cost_per_iteration": (
            round(total_usd / len(cost_points), 4) if have_cost else None),
        "cache_hit_ratio": _ratio(
            totals["cache_read_tokens"], totals["input_tokens"]),
        "cost_trend": _trend(cost_points),
        "iterations": iterations,
        "notes": [],
    }
    for f in TOKEN_FIELDS:
        out["total_" + f] = totals[f] if measured else None

    n = out["notes"]
    if exists == 0:
        n.append("no efficiency records found: nothing to summarize")
    if not have_cost:
        n.append(
            "cost not measured for any iteration: total reads UNKNOWN, "
            "not $0.00 (unmeasured is not free)")
        if measured:
            n.append(
                "tokens WERE recorded but no cost was: the model is likely "
                "unpriced, so spend is unknown rather than zero")
    elif len(cost_points) < measured:
        n.append(
            "%d of %d measured iterations carried tokens but no cost "
            "(unpriced model): the cost total excludes them"
            % (measured - len(cost_points), measured))
    elif measured < exists:
        n.append(
            "PARTIAL: %d of %d iterations measured. The total covers only the "
            "measured ones; unmeasured iterations are excluded, not counted as "
            "zero, so the real cost is HIGHER than shown."
            % (measured, exists))
    if out["cache_hit_ratio"] is None and measured:
        n.append(
            "cache hit ratio UNKNOWN: no input or cache-read tokens recorded "
            "(a 0% ratio would claim a cold cache we did not observe)")
    return out


def _trend(points):
    """Is cost per iteration climbing? Needs two measured points to say.

    Compares the mean of the first half against the mean of the second half.
    Deliberately coarse: the useful signal is direction, and a regression slope
    over four noisy points would look more precise than it is.
    """
    if len(points) < 2:
        return {
            "direction": "unknown",
            "points": len(points),
            "detail": "need at least 2 measured iterations to compare",
        }
    vals = [v for _, v in points]
    half = len(vals) // 2
    first = sum(vals[:half]) / half
    second = sum(vals[half:]) / len(vals[half:])
    if first <= 0:
        direction = "unknown"
    elif second > first * 1.1:
        direction = "climbing"
    elif second < first * 0.9:
        direction = "falling"
    else:
        direction = "flat"
    return {
        "direction": direction,
        "points": len(vals),
        "first_half_avg_usd": round(first, 4),
        "second_half_avg_usd": round(second, 4),
        "detail": "mean of first half vs second half of measured iterations",
    }


UNKNOWN = "UNKNOWN"


def _usd(v):
    return UNKNOWN if v is None else "$%.4f" % v


def _pct(v):
    return UNKNOWN if v is None else "%.1f%%" % (v * 100)


def _tok(v):
    return UNKNOWN if v is None else "{:,}".format(v)


def render(s):
    L = ["Cost summary", "============", "", "Workspace: " + s["workspace"], ""]
    L.append("Iterations:  %d found, %d measured%s" % (
        s["iterations_found"], s["iterations_measured"],
        "" if s["fully_measured"] else "  <- PARTIAL" if s["iterations_found"]
        else ""))
    L.append("Total cost:  " + _usd(s["total_cost_usd"]))
    L.append("Avg / iter:  " + _usd(s["avg_cost_per_iteration"]))
    L.append("Cache ratio: " + _pct(s["cache_hit_ratio"])
             + "   (cache_read / (input + cache_read))")
    t = s["cost_trend"]
    L.append("Cost trend:  %s (%d measured point(s))" % (
        t["direction"].upper(), t["points"]))
    L.append("")
    L.append("Tokens:")
    L.append("  input:          " + _tok(s["total_input_tokens"]))
    L.append("  output:         " + _tok(s["total_output_tokens"]))
    L.append("  cache read:     " + _tok(s["total_cache_read_tokens"]))
    L.append("  cache creation: " + _tok(s["total_cache_creation_tokens"]))

    if s["iterations"]:
        L += ["", "Per iteration:"]
        for r in s["iterations"]:
            if not r["measured"]:
                L.append("  iter %s: %s (excluded from totals)"
                         % (r["iteration"], UNKNOWN))
                continue
            L.append("  iter %s: %s, in %s, out %s, cache %s" % (
                r["iteration"], _usd(r["cost_usd"]), _tok(r["input_tokens"]),
                _tok(r["output_tokens"]), _pct(r["cache_hit_ratio"])))
    if s["notes"]:
        L.append("")
        for note in s["notes"]:
            L.append("note: " + note)
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Per-run cost summary for a Loki workspace.")
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace containing .loki/ (default: .)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)
    s = summarize(args.workspace)
    print(json.dumps(s, indent=2) if args.json else render(s))
    return 0


if __name__ == "__main__":
    sys.exit(main())
