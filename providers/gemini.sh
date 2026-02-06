#!/bin/bash
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
# Primary: gemini-3-pro-preview (latest as of Jan 2026)
# Fallback: gemini-3-flash-preview (for rate limit scenarios)
PROVIDER_MODEL="gemini-3-pro-preview"
PROVIDER_MODEL_FALLBACK="gemini-3-flash-preview"
PROVIDER_MODEL_PLANNING="gemini-3-pro-preview"
PROVIDER_MODEL_DEVELOPMENT="gemini-3-pro-preview"
PROVIDER_MODEL_FAST="gemini-3-flash-preview"

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
PROVIDER_RATE_LIMIT_RPM=60

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
# Note: < /dev/null prevents Gemini from pausing on stdin
provider_invoke() {
    local prompt="$1"
    shift
    local output
    local exit_code

    # Try primary model first
    output=$(gemini --approval-mode=yolo --model "$PROVIDER_MODEL" "$prompt" "$@" < /dev/null 2>&1)
    exit_code=$?

    # Check for rate limit (429) or quota exceeded
    if [[ $exit_code -ne 0 ]] && echo "$output" | grep -qiE "(rate.?limit|429|quota|resource.?exhausted)"; then
        echo "[loki] Rate limit hit on $PROVIDER_MODEL, falling back to $PROVIDER_MODEL_FALLBACK" >&2
        gemini --approval-mode=yolo --model "$PROVIDER_MODEL_FALLBACK" "$prompt" "$@" < /dev/null
    else
        echo "$output"
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

# Tier-aware invocation with rate limit fallback
# Uses --model flag to specify model
# Falls back to flash model if pro hits rate limit
# Note: < /dev/null prevents Gemini from pausing on stdin
provider_invoke_with_tier() {
    local tier="$1"
    local prompt="$2"
    shift 2

    # Select model based on tier
    local model="$PROVIDER_MODEL"
    [[ "$tier" == "fast" ]] && model="$PROVIDER_MODEL_FAST"

    echo "[loki] Using tier: $tier, model: $model" >&2

    local output
    local exit_code

    # Try selected model first
    output=$(gemini --approval-mode=yolo --model "$model" "$prompt" "$@" < /dev/null 2>&1)
    exit_code=$?

    # Check for rate limit (429) or quota exceeded - fallback to flash
    if [[ $exit_code -ne 0 ]] && echo "$output" | grep -qiE "(rate.?limit|429|quota|resource.?exhausted)"; then
        echo "[loki] Rate limit hit on $model, falling back to $PROVIDER_MODEL_FALLBACK" >&2
        gemini --approval-mode=yolo --model "$PROVIDER_MODEL_FALLBACK" "$prompt" "$@" < /dev/null
    else
        echo "$output"
        return $exit_code
    fi
}
