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
PROVIDER_HAS_SUBAGENTS=false
PROVIDER_HAS_PARALLEL=false
PROVIDER_HAS_TASK_TOOL=false
PROVIDER_HAS_MCP=true
PROVIDER_MAX_PARALLEL=1

# Model Configuration
# Codex uses single model with effort parameter
# NOTE: gpt-5.3-codex is the official model name for Codex CLI v0.98+
CODEX_DEFAULT_MODEL="gpt-5.3-codex"

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
    # Not a valid Codex model name -- fall back to default
    echo "$CODEX_DEFAULT_MODEL"
}

# Provider-specific env (LOKI_CODEX_MODEL) is trusted and used verbatim -- the
# operator set a Codex-specific model on purpose (e.g. a fine-tune or org-scoped
# name that need not match CODEX_KNOWN_MODELS). Only the GENERIC LOKI_MODEL_*
# fallback is validated, since it may carry Claude aliases (opus/sonnet/haiku)
# that are invalid for Codex. Validating the whole chain silently downgraded a
# trusted LOKI_CODEX_MODEL to the default (BUG-PROV-003 fix).
PROVIDER_MODEL_PLANNING="${LOKI_CODEX_MODEL:-$(_codex_validate_model "${LOKI_MODEL_PLANNING:-$CODEX_DEFAULT_MODEL}")}"
PROVIDER_MODEL_DEVELOPMENT="${LOKI_CODEX_MODEL:-$(_codex_validate_model "${LOKI_MODEL_DEVELOPMENT:-$CODEX_DEFAULT_MODEL}")}"
PROVIDER_MODEL_FAST="${LOKI_CODEX_MODEL:-$(_codex_validate_model "${LOKI_MODEL_FAST:-$CODEX_DEFAULT_MODEL}")}"

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
# v7.x: pin the resolved model explicitly via -m/--model. Without it, codex
# falls back to the installed CLI's built-in default (e.g. gpt-5.5 on codex
# 0.132.0), which silently ignores _codex_validate_model and makes the run.sh
# cost table (priced for gpt-5.3-codex) wrong. --model is the documented model
# selector and is readable in process listings.
provider_invoke() {
    local prompt="$1"
    shift
    codex exec --sandbox workspace-write --skip-git-repo-check \
        --model "$PROVIDER_MODEL_DEVELOPMENT" \
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

    local extra_flags=()
    if [ "${LOKI_CODEX_WEB_SEARCH:-false}" = "true" ]; then
        extra_flags+=(--search)
    fi
    if [ "${LOKI_CODEX_OUTPUT_LAST:-true}" != "false" ] && [ -n "${LOKI_LOG_FILE:-}" ]; then
        extra_flags+=(--output-last-message "${LOKI_LOG_FILE}.last-message")
    fi

    LOKI_CODEX_REASONING_EFFORT="$effort" \
    CODEX_MODEL_REASONING_EFFORT="$effort" \
    # Guard the extra_flags array expansion: with no web-search / output-last
    # knobs the array is empty, and a bare "${arr[@]}" under `set -u` aborts with
    # "unbound variable" on bash 3.2 (stock macOS /bin/bash). ${arr[@]+...}
    # expands to nothing when empty and preserves spaced elements otherwise.
    codex exec \
        --sandbox workspace-write \
        --skip-git-repo-check \
        --model "$model" \
        "${extra_flags[@]+"${extra_flags[@]}"}" \
        "$prompt" "$@"
}
