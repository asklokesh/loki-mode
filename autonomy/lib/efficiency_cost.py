#!/usr/bin/env python3
"""Shared efficiency + cost collection for Loki Mode.

This module is the single source of truth for reading per-iteration
efficiency records out of .loki/metrics/efficiency/ and turning them into a
cost dict. It was extracted from autonomy/lib/proof-generator.py (R1) so that
both the proof generator and the R2 benchmark adapters compute cost the same
way ("bench cost == proof cost"). proof-generator.py has a hyphen in its name
and is therefore not importable as a module, which is why the logic lives
here instead.

Behavior contract (preserved from the R1 proof generator):
  - cost.usd is None when NO valid efficiency record was read (cost was never
    collected for this run). A skeptic seeing "$0.00" assumes the artifact is
    fake; "cost not recorded" is the honest signal.
  - Token counts are also None and available is False when no record exists.
  - A genuine 0.0 (records existed but summed to zero) is preserved as 0.0.
  - usd is rounded to 4 decimals only when records were collected.

The token->USD pricing helper (price_from_tokens) lives here too so that
adapters and the report compute uniform cost from a single dated price table
(benchmarks/bench/prices.json) when a tool reports tokens but no native
cost_usd. This is additive: the proof generator does not use it.
"""

import json
import os

__all__ = [
    "collect_efficiency",
    "load_prices",
    "price_from_tokens",
    "DEFAULT_PRICES_PATH",
]

# benchmarks/bench/prices.json relative to the repo root. Resolved lazily so
# importing this module never depends on cwd or on the file existing.
_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(os.path.dirname(_HERE))  # autonomy/lib -> repo
DEFAULT_PRICES_PATH = os.path.join(
    _REPO_ROOT, "benchmarks", "bench", "prices.json"
)


# ---------------------------------------------------------------------------
# small helpers (self-contained copies; proof-generator.py keeps its own)
# ---------------------------------------------------------------------------

def _read_json(path, default=None):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except Exception:
        return default


def _to_int(v, default=0):
    try:
        return int(v)
    except Exception:
        return default


def _to_float(v, default=0.0):
    try:
        return float(v)
    except Exception:
        return default


# ---------------------------------------------------------------------------
# efficiency collection (extracted verbatim from proof-generator.py)
# ---------------------------------------------------------------------------

def collect_efficiency(loki_dir):
    """Sum cost + tokens across .loki/metrics/efficiency/iteration-*.json.

    Returns (cost dict, best-effort model name (last non-empty seen)).

    Credibility: unavailable cost and token values are None when NO valid
    efficiency record was read. A skeptic seeing "$0.00" assumes the artifact
    is fake; "cost not recorded" is the honest signal. A genuine 0.0 from a
    present record is preserved as 0.0.
    """
    cost = {
        "usd": 0.0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        "available": False,
    }
    model = ""
    collected = False
    eff_dir = os.path.join(loki_dir, "metrics", "efficiency")
    try:
        names = sorted(os.listdir(eff_dir))
    except Exception:
        names = []
    for name in names:
        if not (name.startswith("iteration-") and name.endswith(".json")):
            continue
        rec = _read_json(os.path.join(eff_dir, name), default=None)
        if not isinstance(rec, dict):
            continue
        collected = True
        cost["usd"] += _to_float(rec.get("cost_usd"))
        cost["input_tokens"] += _to_int(rec.get("input_tokens"))
        cost["output_tokens"] += _to_int(rec.get("output_tokens"))
        cost["cache_read_tokens"] += _to_int(rec.get("cache_read_tokens"))
        cost["cache_creation_tokens"] += _to_int(rec.get("cache_creation_tokens"))
        if rec.get("model"):
            model = str(rec.get("model"))
    # A record EXISTING is not the same as a record carrying data. `collected`
    # was true for any parseable file, so a run whose records were all zeros
    # reported usd=0.0 with available=True -- the receipt asserting the run cost
    # NOTHING. That is a fabricated fact, and the receipt exists to prevent
    # exactly that.
    #
    # Measured on the real FireLater run: four efficiency records, every token
    # field 0 (codex wrote no usage before v8.51.0), and collect_efficiency
    # returned {'usd': 0.0, ..., 'available': True}.
    #
    # A run that did work necessarily consumed tokens. So "available" now means
    # at least one record carried a non-zero token count or cost -- an OBSERVED
    # value, not a present file. Zero everywhere means we failed to measure, and
    # unmeasured must read as unknown.
    _observed = any(
        cost[k] for k in (
            "usd", "input_tokens", "output_tokens",
            "cache_read_tokens", "cache_creation_tokens",
        )
    )
    if collected and _observed:
        # Round usd to a sane precision but keep it precise (anti-pattern:
        # round suspiciously-clean numbers). 4 decimals preserves odd values.
        cost["usd"] = round(cost["usd"], 4)
        cost["available"] = True
    else:
        # No record means unavailable, never an observed zero.
        for key in (
            "usd", "input_tokens", "output_tokens",
            "cache_read_tokens", "cache_creation_tokens",
        ):
            cost[key] = None
    return cost, model


# ---------------------------------------------------------------------------
# uniform token -> USD pricing (R2 benchmark; not used by the proof generator)
# ---------------------------------------------------------------------------

def load_prices(path=None):
    """Load the shared dated price table. Returns {} if missing/unreadable.

    Never raises: a missing price table means we cannot price tokens, which is
    an honest null, not a fabricated zero.
    """
    p = path or DEFAULT_PRICES_PATH
    data = _read_json(p, default=None)
    if not isinstance(data, dict):
        return {}
    return data


def price_from_tokens(model, input_tokens, output_tokens,
                      cache_read_tokens=0, prices=None, prices_path=None):
    """Compute a USD cost from raw token counts and the shared price table.

    Returns a float (rounded to 6 decimals) when the model is present in the
    price table, else None. None means "cannot price" (honest), never 0.0.

    Pricing is per million tokens (mtok). cache_read is priced separately from
    fresh input tokens. Used for tools that expose token counts but not a
    native cost_usd; keeps cross-tool cost comparison on one pricing basis.
    """
    table = prices if prices is not None else load_prices(prices_path)
    models = table.get("models") if isinstance(table, dict) else None
    if not isinstance(models, dict):
        return None
    entry = models.get(model)
    if not isinstance(entry, dict):
        return None
    in_rate = _to_float(entry.get("input_per_mtok"), None)
    out_rate = _to_float(entry.get("output_per_mtok"), None)
    cache_rate = _to_float(entry.get("cache_read_per_mtok"), 0.0)
    if in_rate is None or out_rate is None:
        return None
    it = _to_int(input_tokens)
    ot = _to_int(output_tokens)
    ct = _to_int(cache_read_tokens)
    usd = (
        (it / 1_000_000.0) * in_rate
        + (ot / 1_000_000.0) * out_rate
        + (ct / 1_000_000.0) * cache_rate
    )
    return round(usd, 6)
