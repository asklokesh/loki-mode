#!/usr/bin/env python3
"""Recover token usage for a codex iteration from its session rollout.

W1 in docs/WANG-PRINCIPLES-PLAN.md. Wang states the whole thesis conditionally:
"the right agentic loop AND the right eval or metric for the agents to
optimize". We had the loop and not the metric.

THE PROBLEM, measured on a real FireLater run: every efficiency record showed
input_tokens=0, output_tokens=0, cost_usd=0. Not just cost -- we were recording
NOTHING. `_read_iteration_cost` looks for `.loki/metrics/result-cost-<n>.json`
or `.loki/context/tracking.json`, and on codex neither exists, so cost silently
resolved to 0. A zero is a claim the iteration was free.

That made cost-per-resolved-issue unmeasurable, which is the axis with a
MEASURED 20x industry spread (~$14/pass on Sonnet 4.5; an open harness lands
tasks at ~1/20th Devin's cost). It is the number a buyer compares first.

WHY THE ROLLOUT AND NOT `--json`. codex emits usage on its `turn.completed`
event, but only under `codex exec --json`. The runner pipes codex stdout
through `tee` into the log files it parses for completion signals, so switching
the main dispatch to JSONL would change the format every one of those readers
depends on. codex ALSO persists a session rollout to
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl containing `total_token_usage`.
Reading that is a side channel: zero risk to the dispatch pipeline.

FAIL-SAFE: every failure path prints nothing and exits non-zero, so the caller
records "unknown" rather than a fabricated 0 -- the distinction this exists for.

Usage:
    codex-usage.py <since-epoch> [sessions-dir]
Prints one line: input_tokens output_tokens cached_tokens cache_write_tokens
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

try:
    import json
except Exception:  # pragma: no cover
    sys.exit(1)


def _find_usage(obj):
    """Depth-first search for a total_token_usage dict."""
    if isinstance(obj, dict):
        u = obj.get("total_token_usage")
        if isinstance(u, dict):
            return u
        for v in obj.values():
            found = _find_usage(v)
            if found:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = _find_usage(v)
            if found:
                return found
    return None


def main() -> int:
    if len(sys.argv) < 2:
        return 1
    try:
        since = float(sys.argv[1])
    except ValueError:
        return 1

    root = Path(sys.argv[2]) if len(sys.argv) > 2 else Path.home() / ".codex" / "sessions"
    if not root.is_dir():
        return 1

    # Only rollouts written during THIS iteration. Without the mtime bound a
    # stale session from an earlier run would be attributed to this one, which
    # is worse than reporting nothing: it would look like real data.
    candidates = []
    for p in root.rglob("rollout-*.jsonl"):
        try:
            if p.stat().st_mtime >= since:
                candidates.append(p)
        except OSError:
            continue
    if not candidates:
        return 1

    # The rollout carries CUMULATIVE totals, so the last usage record in the
    # newest matching file is this iteration's total. Summing across files would
    # double-count a resumed session.
    candidates.sort(key=lambda p: p.stat().st_mtime)
    usage = None
    for p in reversed(candidates):
        last = None
        try:
            with p.open(encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        found = _find_usage(json.loads(line))
                    except Exception:
                        continue
                    if found:
                        last = found
        except OSError:
            continue
        if last:
            usage = last
            break

    if not usage:
        return 1

    def _n(key):
        v = usage.get(key, 0)
        return int(v) if isinstance(v, (int, float)) and v >= 0 else 0

    # codex reports input_tokens INCLUSIVE of cached. The pricing tiers charge
    # cached reads at a lower rate, so the uncached remainder is what bills at
    # full input price; emitting the inclusive figure would overstate cost.
    total_in = _n("input_tokens")
    cached = _n("cached_input_tokens")
    uncached = max(total_in - cached, 0)

    out = _n("output_tokens")
    cwrite = _n("cache_write_input_tokens")

    # Cost, if the model is priced. codex reports tokens but never dollars, so
    # without this the whole chain still lands on cost_usd=0 -- tokens recovered
    # and the number that matters still missing.
    #
    # A model we cannot price prints an EMPTY cost field, never 0: "unknown" and
    # "free" are different claims and only one of them is honest.
    cost = ""
    model = os.environ.get("LOKI_CODEX_RESOLVED_MODEL", "").strip()
    if model:
        here = Path(__file__).resolve().parent
        for cand in (here / ".." / ".." / "loki-ts" / "data" / "model-pricing.json",):
            try:
                table = json.loads(cand.read_text(encoding="utf-8")).get("pricing", {})
            except Exception:
                continue
            p = table.get(model)
            if not p:
                # Tier names (small/medium/high) and suffixed variants
                # (gpt-5.6-sol-high) both reach here; match the longest prefix.
                for k in sorted(table, key=len, reverse=True):
                    if model.startswith(k):
                        p = table[k]
                        break
            if p:
                try:
                    cost = "%.6f" % (
                        uncached / 1_000_000 * float(p.get("input", 0))
                        + out / 1_000_000 * float(p.get("output", 0))
                        + cached / 1_000_000 * float(p.get("cache_read", p.get("input", 0)))
                        + cwrite / 1_000_000 * float(p.get("cache_write", p.get("input", 0)))
                    )
                except Exception:
                    cost = ""
            break

    print(uncached, out, cached, cwrite, cost)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(1)
