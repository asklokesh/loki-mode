#!/usr/bin/env bash
# autonomy/lib/claude-flags.sh -- Phase B (v7.5.19) helpers.
#
# Compute Claude Code CLI flag values automatically from existing Loki state.
# No new env vars introduced (per binding constraint: nothing user-facing changes).
# Every value derives from RARV tier, complexity score, and budget config.
#
# Public API (all functions are pure: they read env + filesystem, write stdout).
#   loki_effort_for_tier <tier> [complexity]    -- emit one of: low|medium|high|xhigh|max
#   loki_remaining_budget                        -- emit dollar amount remaining as plain int/float, OR empty when unlimited
#   loki_fallback_for_primary <model>           -- emit fallback model alias (opus->sonnet, sonnet->haiku if allowed), OR empty when no fallback applies
#   loki_claude_flag_supported <flag>           -- 0 if `claude --help` lists the flag, 1 otherwise
#
# All functions are side-effect free. The caller (providers/claude.sh, loki-ts) decides whether to pass the result.

# Guard against double-source.
if [ "${__LOKI_CLAUDE_FLAGS_SH_LOADED:-0}" = "1" ]; then
    return 0 2>/dev/null || true
fi
__LOKI_CLAUDE_FLAGS_SH_LOADED=1

# ---------- Effort tier mapping ----------
# RARV tier names: planning (xhigh), development (high), fast (medium).
# Complexity shift: if the project is "complex", bump each tier one notch up.
# Honors LOKI_ALLOW_HAIKU=true semantics for the "fast" tier (medium stays medium; haiku is a separate model concept).
loki_effort_for_tier() {
    local tier="${1:-development}"
    local complexity="${2:-${LOKI_COMPLEXITY:-standard}}"
    local effort=""
    case "$tier" in
        planning)    effort="xhigh" ;;
        development) effort="high" ;;
        fast)        effort="medium" ;;
        # Capability aliases used elsewhere in the codebase.
        best)        effort="xhigh" ;;
        balanced)    effort="high" ;;
        cheap)       effort="low" ;;
        *)           effort="high" ;;
    esac
    # Complex projects get one bump up. "max" is the ceiling and only for explicit user override (not auto-bumped to from xhigh).
    if [ "$complexity" = "complex" ]; then
        case "$effort" in
            low)    effort="medium" ;;
            medium) effort="high" ;;
            high)   effort="xhigh" ;;
            # xhigh stays xhigh; max not auto-reached.
        esac
    fi
    printf '%s' "$effort"
}

# ---------- Remaining budget ----------
# Compute remaining budget = LOKI_BUDGET_LIMIT - cumulative spend so far.
# Spend lives in .loki/metrics/budget.json under "current_spend" (per autonomy/run.sh:8167+).
# Emit empty string when budget is unlimited (LOKI_BUDGET_LIMIT unset or 0).
# Emit empty when remaining <= 0 (caller decides what to do; we never emit 0).
loki_remaining_budget() {
    local limit="${LOKI_BUDGET_LIMIT:-}"
    # Empty or zero limit means no cap; emit nothing.
    if [ -z "$limit" ] || [ "$limit" = "0" ] || [ "$limit" = "0.0" ] || [ "$limit" = "0.00" ]; then
        return 0
    fi
    local budget_file="${TARGET_DIR:-.}/.loki/metrics/budget.json"
    local spend="0"
    if [ -f "$budget_file" ]; then
        spend=$(python3 -c "
import json, sys
try:
    with open('$budget_file') as f:
        d = json.load(f)
    v = d.get('current_spend', 0)
    print(float(v))
except Exception:
    print(0)
" 2>/dev/null)
    fi
    # Compute remaining via python3 (bash floats are unreliable across awk/bc variations).
    python3 -c "
import sys
try:
    limit = float('$limit')
    spend = float('$spend')
    rem = limit - spend
    # Strictly positive; otherwise emit nothing (caller decides whether to bail or warn).
    if rem > 0:
        # Round to 2 decimal places for the CLI.
        print(f'{rem:.2f}')
except Exception:
    pass
" 2>/dev/null
}

# ---------- Fallback model ----------
# Map primary model alias to a sensible fallback for `--fallback-model`.
# opus -> sonnet (always safe; sonnet is cheaper + similar capability)
# sonnet -> haiku ONLY when LOKI_ALLOW_HAIKU=true; else emit nothing
# haiku -> nothing (already at the bottom)
# Anything else (specific dated IDs, alt-provider names) -> nothing (no auto-fallback we can reason about)
loki_fallback_for_primary() {
    local primary="${1:-}"
    case "$primary" in
        opus)   printf '%s' "sonnet" ;;
        sonnet)
            if [ "${LOKI_ALLOW_HAIKU:-false}" = "true" ]; then
                printf '%s' "haiku"
            fi
            ;;
        # No fallback for haiku or other model names.
        *) ;;
    esac
}

# ---------- Flag-support detection ----------
# Returns 0 if `claude --help` lists the named flag, 1 otherwise.
# Cached per-process so we do not shell out N times per iteration.
loki_claude_flag_supported() {
    local flag="${1:-}"
    [ -z "$flag" ] && return 1
    # Per-process cache: __LOKI_CLAUDE_HELP_CACHE populated on first call.
    if [ -z "${__LOKI_CLAUDE_HELP_CACHE:-}" ]; then
        if command -v claude >/dev/null 2>&1; then
            __LOKI_CLAUDE_HELP_CACHE=$(claude --help 2>&1 || true)
        else
            __LOKI_CLAUDE_HELP_CACHE="__no_claude__"
        fi
        export __LOKI_CLAUDE_HELP_CACHE
    fi
    case "$__LOKI_CLAUDE_HELP_CACHE" in
        *"$flag"*) return 0 ;;
        *) return 1 ;;
    esac
}
