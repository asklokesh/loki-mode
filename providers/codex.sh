#!/usr/bin/env bash
# OpenAI Codex CLI Provider Configuration
# Shell-sourceable config for loki-mode multi-provider support

# Provider Functions (for external use)
# =====================================
# These functions provide a clean interface for external scripts:
#   provider_detect()           - Check if CLI is installed
#   provider_version()          - Get CLI version
#   provider_invoke()           - Invoke with prompt (autonomous mode)
#   provider_invoke_with_tier() - Invoke with tier-specific effort level
#   provider_get_tier_param()   - Map tier name to effort level
#
# Usage:
#   source providers/codex.sh
#   if provider_detect; then
#       provider_invoke "Your prompt here"
#   fi
#
# Note: autonomy/run.sh uses inline invocation for streaming support
# and real-time agent tracking. These functions are intended for
# simpler scripts, wrappers, and external integrations.
# =====================================

# Provider Identity
PROVIDER_NAME="codex"
PROVIDER_DISPLAY_NAME="OpenAI Codex CLI"
PROVIDER_CLI="codex"

# CLI Invocation
# Note: codex uses positional prompt after "exec" subcommand
# VERIFIED: codex 0.132.0 deprecates --full-auto (prints a deprecation warning
# and the flag is gone from `codex exec --help`). Use --sandbox workspace-write,
# which is the documented replacement and the sandbox --full-auto expanded to.
# `codex exec` is the non-interactive subcommand: it runs at approval "never"
# with no --ask-for-approval flag, so --sandbox workspace-write alone keeps the
# loop fully autonomous (verified against codex 0.132.0: no approval prompt).
# Alternative: "exec --dangerously-bypass-approvals-and-sandbox" (legacy, no sandbox)
PROVIDER_AUTONOMOUS_FLAG="exec --sandbox workspace-write --skip-git-repo-check"
PROVIDER_PROMPT_FLAG=""
PROVIDER_PROMPT_POSITIONAL=true

# Skill System
PROVIDER_SKILL_DIR="${HOME}/.agents/skills"
PROVIDER_SKILL_FORMAT="markdown"  # Codex v0.98+ loads skills from ~/.agents/skills

# Capability Flags
#
# SUBAGENTS / TASK_TOOL stay false: Codex has no equivalent of Claude Code's
# in-session subagent dispatch. These two are reporting-only in this codebase
# (loader.sh display + the degraded-mode summary); nothing branches on them.
PROVIDER_HAS_SUBAGENTS=false
PROVIDER_HAS_TASK_TOOL=false
PROVIDER_HAS_MCP=true
#
# PARALLEL: enabled 2026-07-27 after MEASURING it, not assuming it.
#
# The v0.98-era `false` was an untested assumption. On codex-cli 0.144.6 two
# concurrent `codex exec` runs in separate git worktrees both completed, exit 0,
# zero rate-limit errors. This flag gates exactly one behavior -- worktree
# parallel sessions (run.sh:4832 spawn guard, run.sh:23473 mode downgrade) --
# and that primitive is only "run the non-interactive CLI in N directories at
# once". It needs no subagents and no Task tool, which is why those two stay
# false above while this one does not.
#
# Enabling it required making the user-facing text honest first, because
# "degraded" was being reported as if it always implied "sequential":
# run.sh:23461 now enumerates the capabilities actually missing (read from
# these flags) instead of hardcoding "Parallel agents and Task tool", and the
# live-output banner only claims "Sequential execution only" when
# PROVIDER_HAS_PARALLEL is genuinely false. PROVIDER_DEGRADED itself is
# deliberately UNTOUCHED: its other consumers (run.sh:20340 workflow analysis,
# done-recognition.sh:167) are claude-only guards and one is parity-locked with
# the Bun route, so widening its meaning would ripple into prompt construction
# for no gain here.
#
# MAX_PARALLEL is 2, not the Claude value. Two is what was actually verified,
# and Codex's free ChatGPT tier -- the audience this matters for, since Codex is
# the only zero-cost on-ramp in the category -- is rate-limited well before
# process concurrency becomes the ceiling. Raise it only with evidence at the
# higher number.
PROVIDER_HAS_PARALLEL=true
PROVIDER_MAX_PARALLEL=2

# Model Configuration
# Codex uses a single model with an effort parameter.
#
# DEFAULT IS EMPTY ON PURPOSE (2026-07-26). Pinning a model name here broke
# Codex outright for ChatGPT-account users -- the account tier that matters
# most, since Codex ships free with every ChatGPT plan and is the only
# zero-cost on-ramp in the category. Verified against codex-cli 0.144.6:
#
#   codex exec --model gpt-5.3-codex "..."
#     -> 400 invalid_request_error: "The 'gpt-5.3-codex' model is not
#        supported when using Codex with a ChatGPT account."
#   codex exec "..."            (no --model)
#     -> works, 22255 tokens, correct output
#
# The old pin ("official model name for Codex CLI v0.98+") was written against
# v0.98 and never re-verified; the installed CLI is 0.144.6. Replacing it with
# another hardcoded name would repeat the same mistake with a fresher string --
# valid model names differ per account tier and change with upstream releases,
# so THIS FILE CANNOT KNOW THEM. Codex already resolves an account-appropriate
# default (honoring ~/.codex/config.toml), so the correct behavior is to say
# nothing and let it choose. An operator who wants a specific model still sets
# LOKI_CODEX_MODEL or LOKI_MODEL_*, which are passed through below.
CODEX_DEFAULT_MODEL=""

# Known valid Codex model prefixes for validation (BUG-PROV-002 fix)
# Generic LOKI_MODEL_* may contain Claude model aliases (e.g. "opus", "sonnet",
# "haiku") which are invalid for Codex. Validate before accepting.
CODEX_KNOWN_MODELS=("gpt-" "o1-" "o3-" "o4-" "codex-" "ft:gpt-")

_codex_validate_model() {
    local model="$1"
    for prefix in "${CODEX_KNOWN_MODELS[@]}"; do
        if [[ "$model" == ${prefix}* ]]; then
            echo "$model"
            return 0
        fi
    done
    # Not a valid Codex model name (e.g. a Claude alias leaking in via the
    # generic LOKI_MODEL_*) -- fall back to the default, which is now EMPTY,
    # i.e. "pass no --model and let Codex pick". That is deliberately the same
    # safe outcome as an unset model rather than a guessed name.
    echo "$CODEX_DEFAULT_MODEL"
}

# Provider-specific env (LOKI_CODEX_MODEL) is trusted and used verbatim -- the
# operator set a Codex-specific model on purpose (e.g. a fine-tune or org-scoped
# name that need not match CODEX_KNOWN_MODELS). Only the GENERIC LOKI_MODEL_*
# fallback is validated, since it may carry Claude aliases (opus/sonnet/haiku)
# that are invalid for Codex. Validating the whole chain silently downgraded a
# trusted LOKI_CODEX_MODEL to the default (BUG-PROV-003 fix).
#
# Each tier resolves from the catalog, which is the single source of truth for
# what "small / medium / high" means per provider. Before this, all three tiers
# fell back to CODEX_DEFAULT_MODEL (empty), so a codex run sent no --model at
# all and `LOKI_SESSION_MODEL=high` selected nothing -- the tier vocabulary was
# inert on codex and a user had to name a model by hand.
#
# The empty default is still the last resort: if the catalog lookup yields
# nothing, we send no --model and let Codex pick, which is the safe outcome for
# a ChatGPT-account user rather than a guessed name.
_codex_tier_model() {
    local tier="$1" resolved=""
    if command -v loki_latest_model >/dev/null 2>&1; then
        resolved="$(loki_latest_model codex "$tier" 2>/dev/null)"
    fi
    printf '%s' "${resolved:-$CODEX_DEFAULT_MODEL}"
}

PROVIDER_MODEL_PLANNING="${LOKI_CODEX_MODEL:-$(_codex_validate_model "${LOKI_MODEL_PLANNING:-$(_codex_tier_model planning)}")}"
PROVIDER_MODEL_DEVELOPMENT="${LOKI_CODEX_MODEL:-$(_codex_validate_model "${LOKI_MODEL_DEVELOPMENT:-$(_codex_tier_model development)}")}"
PROVIDER_MODEL_FAST="${LOKI_CODEX_MODEL:-$(_codex_validate_model "${LOKI_MODEL_FAST:-$(_codex_tier_model fast)}")}"

# Effort levels (Codex-specific: maps to reasoning time, not model capability)
PROVIDER_EFFORT_PLANNING="xhigh"
PROVIDER_EFFORT_DEVELOPMENT="high"
PROVIDER_EFFORT_FAST="low"

# No Task tool - effort is set via CLI flag
PROVIDER_TASK_MODEL_PARAM=""
PROVIDER_TASK_MODEL_VALUES=()

# Context and Limits
PROVIDER_CONTEXT_WINDOW=400000
PROVIDER_MAX_OUTPUT_TOKENS=128000
PROVIDER_RATE_LIMIT_RPM=60

# Cost (USD per 1K tokens, approximate for GPT-5.3)
PROVIDER_COST_INPUT_PLANNING=0.010
PROVIDER_COST_OUTPUT_PLANNING=0.030
PROVIDER_COST_INPUT_DEV=0.010
PROVIDER_COST_OUTPUT_DEV=0.030
PROVIDER_COST_INPUT_FAST=0.010
PROVIDER_COST_OUTPUT_FAST=0.030

# Degraded Mode
PROVIDER_DEGRADED=true
PROVIDER_DEGRADED_REASONS=(
    "No Task tool subagent support - cannot spawn parallel agents"
    "Single model with effort parameter - no cheap tier for parallelization"
)

# Detection function - check if provider CLI is available
provider_detect() {
    command -v codex >/dev/null 2>&1
}

# Version check function
provider_version() {
    codex --version 2>/dev/null | head -1
}

# Invocation function
# Note: Codex uses positional prompt, not -p flag
# Note: Reasoning effort is configured via environment or config, not CLI flag
# v7.x pinned the resolved model explicitly via -m/--model so the run.sh cost
# table matched what actually ran. That is still the behavior WHEN A MODEL IS
# SET -- but the flag is now OMITTED when the resolved model is empty, because
# a hardcoded name broke ChatGPT-account users outright (see CODEX_DEFAULT_MODEL
# above). Omitting it lets Codex resolve an account-appropriate default; the
# trade-off is that the cost table falls back to its generic estimate, which is
# strictly better than a run that cannot start at all.
_codex_model_flag() {
    # Echo nothing when no model is resolved, so the caller's array stays empty.
    [ -n "${1:-}" ] && printf '%s\n%s\n' "--model" "$1"
    return 0
}

provider_invoke() {
    local prompt="$1"
    shift
    local model_flag=()
    while IFS= read -r _mf; do
        [ -n "$_mf" ] && model_flag+=("$_mf")
    done < <(_codex_model_flag "$PROVIDER_MODEL_DEVELOPMENT")
    codex exec --sandbox workspace-write --skip-git-repo-check \
        "${model_flag[@]+"${model_flag[@]}"}" \
        "$prompt" "$@"
}

# Model tier to effort level parameter (Codex uses effort, not separate models)
provider_get_tier_param() {
    local tier="$1"
    case "$tier" in
        planning) echo "xhigh" ;;
        development) echo "high" ;;
        fast) echo "low" ;;
        *) echo "high" ;;  # default to development tier
    esac
}

# Dynamic model resolution (v6.0.0)
# NOTE (BUG-PROV-012): Unlike other providers, Codex resolve_model_for_tier returns
# an EFFORT LEVEL (xhigh/high/low), not a model name. Codex uses a single model
# (gpt-5.3-codex) with varying effort. Callers that need the model name should use
# PROVIDER_MODEL_DEVELOPMENT (or CODEX_DEFAULT_MODEL) directly.
# The effort value is passed via CODEX_MODEL_REASONING_EFFORT env var at invocation.
resolve_model_for_tier() {
    local tier="$1"

    # Handle capability aliases
    case "$tier" in
        best)    tier="planning" ;;
        balanced) tier="development" ;;
        cheap)   tier="fast" ;;
    esac

    local max_tier="${LOKI_MAX_TIER:-}"
    # Normalize EXACTLY like claude.sh:356 (loki_apply_max_tier_clamp): trim +
    # lowercase BEFORE the case match. Without this, a user-typed cap like "Haiku"
    # or " haiku " (settings.json maxTier exports verbatim) fell through to the
    # default arm and the cost ceiling was silently bypassed for codex while
    # claude honored it. Both routes (this + applyCodexMaxTier in providers.ts)
    # normalize identically. Parity fix.
    max_tier="$(printf '%s' "$max_tier" | tr '[:upper:]' '[:lower:]' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    local effort=""

    case "$tier" in
        planning)    effort="$PROVIDER_EFFORT_PLANNING" ;;
        development) effort="$PROVIDER_EFFORT_DEVELOPMENT" ;;
        fast)        effort="$PROVIDER_EFFORT_FAST" ;;
        *)           effort="$PROVIDER_EFFORT_DEVELOPMENT" ;;
    esac

    # Apply maxTier ceiling (maps to effort levels)
    if [ -n "$max_tier" ]; then
        case "$max_tier" in
            haiku|low)   effort="low" ;;
            sonnet|high)
                if [ "$effort" = "xhigh" ]; then effort="high"; fi
                ;;
            opus|xhigh)  ;; # No cap
        esac
    fi

    echo "$effort"
}

# Tier-aware invocation.
#
# Aligned with codex CLI 0.132.0 (verified: --full-auto deprecated/removed
# from `codex exec --help`). `codex exec` is the non-interactive subcommand and
# runs at approval "never" with no --ask-for-approval flag, so --sandbox
# workspace-write alone keeps the loop autonomous (verified: no approval prompt
# on codex 0.132.0). workspace-write is the documented --full-auto replacement
# and the safer default (scoped disk writes) over danger-full-access; readable
# in process listings.
#
# Optional env knobs:
#   LOKI_CODEX_WEB_SEARCH=true      enable codex --search (live web)
#   LOKI_CODEX_OUTPUT_LAST=false    disable --output-last-message capture
#                                   (default ON; writes the final response
#                                   to ${LOKI_LOG_FILE}.last-message)
#
# Codex CLI uses CODEX_MODEL_REASONING_EFFORT env var for effort control.
# LOKI_CODEX_REASONING_EFFORT is the canonical namespaced env var (v6.37.1+).
# CODEX_MODEL_REASONING_EFFORT is supported for backward compatibility.
provider_invoke_with_tier() {
    local tier="$1"
    local prompt="$2"
    shift 2
    local effort
    effort=$(resolve_model_for_tier "$tier")

    # Resolve the model name by tier. These three vars can diverge via the
    # generic LOKI_MODEL_* env (each validated by _codex_validate_model), so
    # honor the tier rather than hardcoding development. Capability aliases
    # (best/balanced/cheap) mirror resolve_model_for_tier's mapping.
    local model
    case "$tier" in
        planning|best)        model="$PROVIDER_MODEL_PLANNING" ;;
        development|balanced) model="$PROVIDER_MODEL_DEVELOPMENT" ;;
        fast|cheap)           model="$PROVIDER_MODEL_FAST" ;;
        *)                    model="$PROVIDER_MODEL_DEVELOPMENT" ;;
    esac

    # --search is a TOP-LEVEL `codex` flag, not a `codex exec` flag. On codex
    # 0.141.0 `codex exec ... --search` aborts with "unexpected argument
    # '--search' found", silently breaking LOKI_CODEX_WEB_SEARCH. It must be
    # placed before the `exec` subcommand. --output-last-message (-o) IS an
    # `codex exec` flag and stays after `exec`. Keep the two in separate arrays.
    local pre_exec_flags=()
    if [ "${LOKI_CODEX_WEB_SEARCH:-false}" = "true" ]; then
        pre_exec_flags+=(--search)
    fi
    local extra_flags=()
    if [ "${LOKI_CODEX_OUTPUT_LAST:-true}" != "false" ] && [ -n "${LOKI_LOG_FILE:-}" ]; then
        extra_flags+=(--output-last-message "${LOKI_LOG_FILE}.last-message")
    fi

    LOKI_CODEX_REASONING_EFFORT="$effort" \
    CODEX_MODEL_REASONING_EFFORT="$effort" \
    # Guard the array expansions: with no web-search / output-last knobs an
    # array is empty, and a bare "${arr[@]}" under `set -u` aborts with
    # "unbound variable" on bash 3.2 (stock macOS /bin/bash). ${arr[@]+...}
    # expands to nothing when empty and preserves spaced elements otherwise.
    # Same conditional as provider_invoke: omit --model entirely when none
    # resolved, rather than passing an empty string (which codex rejects).
    local model_flag=()
    while IFS= read -r _mf; do
        [ -n "$_mf" ] && model_flag+=("$_mf")
    done < <(_codex_model_flag "$model")

    codex \
        "${pre_exec_flags[@]+"${pre_exec_flags[@]}"}" \
        exec \
        --sandbox workspace-write \
        --skip-git-repo-check \
        "${model_flag[@]+"${model_flag[@]}"}" \
        "${extra_flags[@]+"${extra_flags[@]}"}" \
        "$prompt" "$@"
}

# provider_invoke_argv <tier> <prompt> -- see providers/claude.sh for the full
# rationale. Prints argv into _LOKI_INVOKE_ARGV so a caller can wrap it in
# `timeout`, which cannot wrap a shell function.
provider_invoke_argv() {
    local tier="${1:-development}"
    local prompt="${2:-}"

    # DO NOT pass provider_get_tier_param to --model. For Codex that function
    # returns an EFFORT LEVEL (xhigh/high/low), not a model name -- the note at
    # BUG-PROV-012 above says so explicitly, and provider_invoke() already routes
    # it correctly via CODEX_MODEL_REASONING_EFFORT.
    #
    # This path passed it to --model anyway, so every argv-based invocation sent
    # `--model high` and the API rejected it outright:
    #   400 invalid_request_error: The 'high' model is not supported when using
    #   Codex with a ChatGPT account.
    # Measured 2026-07-30: five trials, elapsed 96s/6s/5s/4s/5s, artifact never
    # created. The same task through provider_invoke() succeeded in 72s. The
    # split meant the timeout-safe seam -- the one used precisely when a call
    # must be bounded -- was the broken one, so a hung provider could not be
    # cut off without also breaking the invocation.
    #
    # The model name comes from PROVIDER_MODEL_DEVELOPMENT / CODEX_DEFAULT_MODEL.
    # Both are legitimately EMPTY by default so codex uses its own current
    # default rather than a pinned name that rots; an empty value must therefore
    # omit --model entirely, not send an empty string.
    local model="${PROVIDER_MODEL_DEVELOPMENT:-${CODEX_DEFAULT_MODEL:-}}"
    local effort
    effort="$(provider_get_tier_param "$tier" 2>/dev/null || printf '%s' "")"

    _LOKI_INVOKE_ARGV=(codex exec --sandbox workspace-write)
    [ -n "$model" ] && _LOKI_INVOKE_ARGV+=(--model "$model")
    _LOKI_INVOKE_ARGV+=("$prompt")

    # Effort travels as an env var, not an argv flag. Exported so it survives
    # `timeout "${_LOKI_INVOKE_ARGV[@]}"`, which is the whole reason this seam
    # exists: `timeout` cannot exec a shell function.
    [ -n "$effort" ] && export CODEX_MODEL_REASONING_EFFORT="$effort"
}
