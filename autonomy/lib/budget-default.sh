#!/usr/bin/env bash
# Default per-run spend cap, read from the single source of truth
# loki-ts/data/budget-defaults.json (also read by loki-ts/src/e10ext/budget_cap.ts).
# Contract: docs/contracts/budget.md. Side-effect-free on source.

# Prints the default cap as a plain number (e.g. 100). Falls back to 100 only
# if the JSON is unreadable, matching the TS fallback literal.
loki_budget_default_usd() {
    local lib_dir json v
    lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
    json="${lib_dir}/../../loki-ts/data/budget-defaults.json"
    v=""
    if [ -f "$json" ]; then
        v="$(sed -n 's/.*"default_max_cost_usd"[[:space:]]*:[[:space:]]*\([0-9][0-9.]*\).*/\1/p' "$json" | head -1)"
    fi
    printf '%s\n' "${v:-100}"
}
