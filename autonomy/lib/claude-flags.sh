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

# ---------- v7.33.0 cheap-subcall + reviewer-guard flag emitters ----------
# These centralize three Claude Code 2.1.170 embeds so every cheap NON-MAIN
# subcall site emits the same gated flags. Each emitter prints its flags to
# stdout (space-free per element via one-per-line is not needed; callers read
# them into an array with command substitution + word-splitting on the single
# token they emit, OR append the function output as additional argv elements).
# All are default-ON, opt-out via env, and gated on loki_claude_flag_supported
# so an older CLI degrades gracefully (emits nothing).

# EMBED 2 -- --bare (cheap NON-MAIN subcalls only). Minimal mode. Per
# `claude --help` it SKIPS hooks, LSP, plugin sync, attribution, auto-memory,
# background prefetches, keychain reads, and CLAUDE.md AUTO-discovery. It does
# NOT nullify explicit --mcp-config/--settings/--agents (the help lists those as
# the way to "explicitly provide context" UNDER --bare); what it drops is the
# IMPLICIT/auto-discovered context. Therefore --bare is ONLY safe on subcalls
# whose prompt is fully self-contained (the entire instruction set + context is
# passed via -p), and NEVER on the main RARV loop or on any call that relies on
# auto-discovered CLAUDE.md / hooks / auto-memory.
#
# AUTH GATE (critical): --bare sets CLAUDE_CODE_SIMPLE=1 and per `claude --help`
# reads Anthropic auth STRICTLY from ANTHROPIC_API_KEY or an apiKeyHelper via
# --settings -- "OAuth and keychain are never read". A subscription/OAuth user
# (no ANTHROPIC_API_KEY) gets "Not logged in" on every --bare subcall, which
# exits 0 with the error on stdout, so a council vote parses as the default
# REJECT and the loop silently corrupts. So --bare is enabled ONLY when an
# API-key auth path exists (ANTHROPIC_API_KEY set, or an apiKeyHelper configured
# in settings); otherwise it emits nothing and the subcall runs full-auth, the
# same as before this embed. Subscription users are thus unaffected by default.
# Default-ON (when auth-safe); opt out entirely with LOKI_BARE_SUBCALLS=0.
# Predicate so call sites can append "--bare" to their argv array uniformly:
#   loki_subcall_bare_enabled && argv+=("--bare")
loki_subcall_bare_enabled() {
    [ "${LOKI_BARE_SUBCALLS:-1}" = "0" ] && return 1
    # API-key auth required (see AUTH GATE above). ANTHROPIC_API_KEY is the
    # common case; apiKeyHelper covers the settings-configured helper. Anything
    # else (OAuth/keychain subscription) must NOT use --bare.
    if [ -z "${ANTHROPIC_API_KEY:-}" ] && ! _loki_apikey_helper_configured; then
        return 1
    fi
    loki_claude_flag_supported "--bare"
}

# True when an apiKeyHelper is configured in any Claude settings source, which
# (unlike OAuth/keychain) IS honored under --bare. Best-effort, read-only.
_loki_apikey_helper_configured() {
    local f
    for f in "$HOME/.claude/settings.json" "$HOME/.config/claude/settings.json" \
             "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" \
             "$PWD/.claude/settings.json" "$PWD/.claude/settings.local.json"; do
        [ -f "$f" ] || continue
        grep -q '"apiKeyHelper"' "$f" 2>/dev/null && return 0
    done
    return 1
}

# EMBED 3 -- --disallowedTools (reviewer / adversarial subcalls). Motivation: a
# parallel agent once ran `git reset --hard` and wiped uncommitted work, so a
# reviewer/voter subcall should not casually mutate the tree. Per `claude --help`
# the value is a comma-or-space-separated list of tool names (e.g. "Bash(git *)
# Edit"); Bash(...) matching is command-PREFIX based (the `cmd:*` form).
#
# SCOPE / LIMITS (honest -- this is a denylist, NOT a sandbox):
#   - Denies the direct file-mutation tools (Edit, Write, NotebookEdit).
#   - Denies the common git MUTATION forms: the bare subcommand (`git reset:*`)
#     AND the global-flag-prefixed evasions (`git -C:*`, `git --git-dir:*`,
#     `git -c:*`) that slip a flag before the subcommand so the bare prefix
#     does not match. Read-only git (diff/log/show/status) stays allowed.
#   - It does NOT and cannot block every mutation path: a determined agent can
#     still write via `Bash(echo > f)`, `sed -i`, `cp/mv/tee`, `python -c`, etc.
#     This is a guardrail that raises the cost of the casual/common destructive
#     command, not a guarantee the tree is immutable. The real safety net is
#     that the integrator commits before any agent wave (see CLAUDE.md).
# The flag is variadic (<tools...>), so we emit ONE comma-separated token to
# avoid swallowing the following -p prompt as additional tool names.
# Default-ON; opt out with LOKI_REVIEW_TOOL_GUARD=0.
# Predicate + denylist so call sites append uniformly:
#   if loki_review_guard_enabled; then
#       argv+=("--disallowedTools" "$(loki_review_guard_denylist)")
#   fi
loki_review_guard_enabled() {
    [ "${LOKI_REVIEW_TOOL_GUARD:-1}" = "0" ] && return 1
    loki_claude_flag_supported "--disallowedTools"
}
loki_review_guard_denylist() {
    # Comma-separated single token. Bash(cmd:*) is command-prefix matching.
    # The `git -C:*` / `git --git-dir:*` / `git -c:*` entries close the
    # global-flag-before-subcommand evasion of the bare git-mutation rules.
    printf '%s' "Edit,Write,NotebookEdit,Bash(git commit:*),Bash(git reset:*),Bash(git push:*),Bash(git checkout:*),Bash(git clean:*),Bash(git rm:*),Bash(git stash:*),Bash(git -C:*),Bash(git --git-dir:*),Bash(git -c:*)"
}
