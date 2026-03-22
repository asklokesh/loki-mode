#!/usr/bin/env bash
# Google Gemini CLI Provider Configuration
# Shell-sourceable config for loki-mode multi-provider support

# Provider Functions (for external use)
# =====================================
# These functions provide a clean interface for external scripts:
#   provider_detect()           - Check if CLI is installed
#   provider_version()          - Get CLI version
#   provider_invoke()           - Invoke with prompt (autonomous mode)
#   provider_invoke_with_tier() - Invoke with tier-specific thinking level
#   provider_get_tier_param()   - Map tier name to thinking level
#
# Usage:
#   source providers/gemini.sh
#   if provider_detect; then
#       provider_invoke "Your prompt here"
#   fi
#
# Note: autonomy/run.sh uses inline invocation for streaming support
# and real-time agent tracking. These functions are intended for
# simpler scripts, wrappers, and external integrations.
# =====================================

# Provider Identity
PROVIDER_NAME="gemini"
PROVIDER_DISPLAY_NAME="Google Gemini CLI"
PROVIDER_CLI="gemini"

# CLI Invocation
# VERIFIED: --approval-mode=yolo is the unified approach (replaces legacy --yolo)
# Sandbox enabled by default in yolo mode
PROVIDER_AUTONOMOUS_FLAG="--approval-mode=yolo"
# NOTE: -p flag is DEPRECATED per gemini --help. Using positional prompt instead.
PROVIDER_PROMPT_FLAG=""
PROVIDER_PROMPT_POSITIONAL=true

# Skill System
# Note: Gemini CLI does not have a native skills system
PROVIDER_SKILL_DIR=""
PROVIDER_SKILL_FORMAT="none"

# Capability Flags
PROVIDER_HAS_SUBAGENTS=false
PROVIDER_HAS_PARALLEL=false
PROVIDER_HAS_TASK_TOOL=false
PROVIDER_HAS_MCP=false
PROVIDER_MAX_PARALLEL=1

# Model Configuration
# Gemini CLI supports --model flag to specify model
# Primary: gemini-3-pro-preview (preview names - may change when GA is released)
# Fallback: gemini-3-flash-preview (for rate limit scenarios)
GEMINI_DEFAULT_PRO="gemini-3-pro-preview"
GEMINI_DEFAULT_FLASH="gemini-3-flash-preview"

# Known valid Gemini model prefixes for validation
GEMINI_KNOWN_MODELS=("gemini-" "models/gemini-")

# Validate that a model name looks like a Gemini model
_gemini_validate_model() {
    local model="$1"
    local fallback="$2"
    for prefix in "${GEMINI_KNOWN_MODELS[@]}"; do
        if [[ "$model" == ${prefix}* ]]; then
            echo "$model"
            return 0
        fi
    done
    # Not a valid Gemini model name -- fall back
    echo "$fallback"
}

PROVIDER_MODEL_PLANNING="$(_gemini_validate_model "${LOKI_GEMINI_MODEL_PLANNING:-${LOKI_MODEL_PLANNING:-$GEMINI_DEFAULT_PRO}}" "$GEMINI_DEFAULT_PRO")"
PROVIDER_MODEL_DEVELOPMENT="$(_gemini_validate_model "${LOKI_GEMINI_MODEL_DEVELOPMENT:-${LOKI_MODEL_DEVELOPMENT:-$GEMINI_DEFAULT_PRO}}" "$GEMINI_DEFAULT_PRO")"
PROVIDER_MODEL_FAST="$(_gemini_validate_model "${LOKI_GEMINI_MODEL_FAST:-${LOKI_MODEL_FAST:-$GEMINI_DEFAULT_FLASH}}" "$GEMINI_DEFAULT_FLASH")"
PROVIDER_MODEL_FALLBACK="${LOKI_GEMINI_MODEL_FALLBACK:-$GEMINI_DEFAULT_FLASH}"

# BUG-PROV-006 fix: PROVIDER_MODEL is now a function, not a frozen variable.
# For backward compatibility, set the variable to planning model at load time,
# but callers should use provider_get_current_model() for runtime resolution.
PROVIDER_MODEL="${PROVIDER_MODEL_PLANNING}"

# Return the model for the current tier at runtime (not frozen at load time)
provider_get_current_model() {
    local tier="${LOKI_CURRENT_TIER:-planning}"
    resolve_model_for_tier "$tier"
}

# Thinking levels (Gemini-specific: maps to reasoning depth)
PROVIDER_THINKING_PLANNING="high"
PROVIDER_THINKING_DEVELOPMENT="medium"
PROVIDER_THINKING_FAST="low"

# No Task tool - thinking level is set via CLI flag
PROVIDER_TASK_MODEL_PARAM=""
PROVIDER_TASK_MODEL_VALUES=()

# Context and Limits
PROVIDER_CONTEXT_WINDOW=1000000  # Gemini 3 has 1M context
PROVIDER_MAX_OUTPUT_TOKENS=65536
# Rate limit varies by tier: Free=5-15 RPM, Tier1=150+ RPM, Tier2=500+ RPM
# Default to conservative free-tier value; override with LOKI_GEMINI_RPM env var
PROVIDER_RATE_LIMIT_RPM="${LOKI_GEMINI_RPM:-15}"

# Cost (USD per 1K tokens, approximate for Gemini 3 Pro)
PROVIDER_COST_INPUT_PLANNING=0.00125
PROVIDER_COST_OUTPUT_PLANNING=0.005
PROVIDER_COST_INPUT_DEV=0.00125
PROVIDER_COST_OUTPUT_DEV=0.005
PROVIDER_COST_INPUT_FAST=0.00125
PROVIDER_COST_OUTPUT_FAST=0.005

# Degraded Mode
PROVIDER_DEGRADED=true
PROVIDER_DEGRADED_REASONS=(
    "No Task tool subagent support - cannot spawn parallel agents"
    "Single model with thinking_level parameter - no cheap tier for parallelization"
    "No native skills system - SKILL.md must be passed via prompt"
    "No MCP server integration"
)

# Detection function - check if provider CLI is available
provider_detect() {
    command -v gemini >/dev/null 2>&1
}

# Version check function
provider_version() {
    gemini --version 2>/dev/null | head -1
}

# Invocation function with rate limit fallback
# Uses --model flag to specify model, --approval-mode=yolo for autonomous mode
# Falls back to flash model if pro hits rate limit
# Accepts optional --model <name> as first args to override default model
# BUG-PROV-010 fix: uses tee to stream output while still capturing for rate-limit check
# Note: < /dev/null prevents Gemini from pausing on stdin
provider_invoke() {
    local model
    model=$(provider_get_current_model)

    # Allow callers to pass --model <name> to override
    if [[ "${1:-}" == "--model" ]] && [[ -n "${2:-}" ]]; then
        model="$2"
        shift 2
    fi

    local prompt="$1"
    shift
    local exit_code

    # Stream output via tee while capturing for rate-limit check
    local output_file stderr_file
    output_file=$(mktemp)
    stderr_file=$(mktemp)
    gemini --approval-mode=yolo --model "$model" "$prompt" "$@" < /dev/null 2>"$stderr_file" | tee "$output_file"
    exit_code=${PIPESTATUS[0]}

    # Check for rate limit (429) or quota exceeded (check stderr for error indicators)
    if [[ $exit_code -ne 0 ]] && grep -qiE "(rate.?limit|429|quota|resource.?exhausted)" "$stderr_file" 2>/dev/null; then
        rm -f "$stderr_file" "$output_file"
        echo "[loki] Rate limit hit on $model, falling back to $PROVIDER_MODEL_FALLBACK" >&2
        gemini --approval-mode=yolo --model "$PROVIDER_MODEL_FALLBACK" "$prompt" "$@" < /dev/null
    else
        rm -f "$stderr_file" "$output_file"
        return $exit_code
    fi
}

# Model tier to thinking level parameter
provider_get_tier_param() {
    local tier="$1"
    case "$tier" in
        planning) echo "high" ;;
        development) echo "medium" ;;
        fast) echo "low" ;;
        *) echo "medium" ;;  # default to development tier
    esac
}

# Dynamic model resolution (v6.0.0)
# Resolves a capability tier to a concrete model name at runtime.
# Respects LOKI_MAX_TIER to cap cost.
resolve_model_for_tier() {
    local tier="$1"

    # Handle capability aliases
    case "$tier" in
        best)    tier="planning" ;;
        balanced) tier="development" ;;
        cheap)   tier="fast" ;;
    esac

    local max_tier="${LOKI_MAX_TIER:-}"
    local model=""

    case "$tier" in
        planning)    model="$PROVIDER_MODEL_PLANNING" ;;
        development) model="$PROVIDER_MODEL_DEVELOPMENT" ;;
        fast)        model="$PROVIDER_MODEL_FAST" ;;
        *)           model="$PROVIDER_MODEL_DEVELOPMENT" ;;
    esac

    # Apply maxTier ceiling
    if [ -n "$max_tier" ]; then
        case "$max_tier" in
            haiku|flash)
                model="$PROVIDER_MODEL_FAST"
                ;;
            sonnet|pro)
                # Cap planning to development (pro)
                if [ "$tier" = "planning" ]; then
                    model="$PROVIDER_MODEL_DEVELOPMENT"
                fi
                ;;
            opus)  ;; # No cap
        esac
    fi

    echo "$model"
}

# Tier-aware invocation with rate limit fallback
# BUG-PROV-001 fix: uses resolve_model_for_tier to select actual model for the tier
# BUG-PROV-010 fix: uses tee to stream output while capturing for rate-limit check
# Note: < /dev/null prevents Gemini from pausing on stdin
provider_invoke_with_tier() {
    local tier="$1"
    local prompt="$2"
    shift 2

    local model
    model=$(resolve_model_for_tier "$tier")

    echo "[loki] Using tier: $tier, model: $model" >&2

    local exit_code

    # Stream output via tee while capturing for rate-limit check
    local output_file stderr_file
    output_file=$(mktemp)
    stderr_file=$(mktemp)
    gemini --approval-mode=yolo --model "$model" "$prompt" "$@" < /dev/null 2>"$stderr_file" | tee "$output_file"
    exit_code=${PIPESTATUS[0]}

    # Check for rate limit (429) or quota exceeded - fallback to flash
    if [[ $exit_code -ne 0 ]] && grep -qiE "(rate.?limit|429|quota|resource.?exhausted)" "$stderr_file" 2>/dev/null; then
        rm -f "$stderr_file" "$output_file"
        echo "[loki] Rate limit hit on $model, falling back to $PROVIDER_MODEL_FALLBACK" >&2
        gemini --approval-mode=yolo --model "$PROVIDER_MODEL_FALLBACK" "$prompt" "$@" < /dev/null
    else
        rm -f "$stderr_file" "$output_file"
        return $exit_code
    fi
}
