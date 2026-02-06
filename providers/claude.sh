#!/bin/bash
# Claude Code Provider Configuration
# Shell-sourceable config for loki-mode multi-provider support

# Provider Functions (for external use)
# =====================================
# These functions provide a clean interface for external scripts:
#   provider_detect()           - Check if CLI is installed
#   provider_version()          - Get CLI version
#   provider_invoke()           - Invoke with prompt (autonomous mode)
#   provider_invoke_with_tier() - Invoke with tier-specific model selection
#   provider_get_tier_param()   - Map tier name to model name
#
# Usage:
#   source providers/claude.sh
#   if provider_detect; then
#       provider_invoke "Your prompt here"
#   fi
#
# Note: autonomy/run.sh uses inline invocation for streaming support
# and real-time agent tracking. These functions are intended for
# simpler scripts, wrappers, and external integrations.
# =====================================

# Provider Identity
PROVIDER_NAME="claude"
PROVIDER_DISPLAY_NAME="Claude Code"
PROVIDER_CLI="claude"

# CLI Invocation
PROVIDER_AUTONOMOUS_FLAG="--dangerously-skip-permissions"
PROVIDER_PROMPT_FLAG="-p"
PROVIDER_PROMPT_POSITIONAL=false

# Skill System
PROVIDER_SKILL_DIR="${HOME}/.claude/skills"
PROVIDER_SKILL_FORMAT="markdown"  # YAML frontmatter + markdown body

# Capability Flags
PROVIDER_HAS_SUBAGENTS=true
PROVIDER_HAS_PARALLEL=true
PROVIDER_HAS_TASK_TOOL=true
PROVIDER_HAS_MCP=true
PROVIDER_MAX_PARALLEL=10

# Model Configuration (Abstract Tiers)
# Default: Haiku disabled for quality. Use --allow-haiku or LOKI_ALLOW_HAIKU=true to enable.
PROVIDER_MODEL_PLANNING="claude-opus-4-6"
PROVIDER_MODEL_DEVELOPMENT="claude-opus-4-6"  # Opus for dev (was sonnet)
if [ "${LOKI_ALLOW_HAIKU:-false}" = "true" ]; then
    PROVIDER_MODEL_FAST="claude-haiku-4-5-20251001"
    PROVIDER_MODEL_DEVELOPMENT="claude-sonnet-4-5-20250929"  # Sonnet for dev when haiku enabled
else
    PROVIDER_MODEL_FAST="claude-sonnet-4-5-20250929"  # Sonnet for fast (no haiku)
fi

# Model Selection (for Task tool)
PROVIDER_TASK_MODEL_PARAM="model"
if [ "${LOKI_ALLOW_HAIKU:-false}" = "true" ]; then
    PROVIDER_TASK_MODEL_VALUES=("opus" "sonnet" "haiku")
else
    PROVIDER_TASK_MODEL_VALUES=("opus" "sonnet")  # No haiku option
fi

# Context and Limits
PROVIDER_CONTEXT_WINDOW=200000  # 1M token context available in beta
PROVIDER_MAX_OUTPUT_TOKENS=128000
PROVIDER_RATE_LIMIT_RPM=50

# Cost (USD per 1K tokens, approximate)
PROVIDER_COST_INPUT_PLANNING=0.015
PROVIDER_COST_OUTPUT_PLANNING=0.075
PROVIDER_COST_INPUT_DEV=0.003
PROVIDER_COST_OUTPUT_DEV=0.015
PROVIDER_COST_INPUT_FAST=0.00025
PROVIDER_COST_OUTPUT_FAST=0.00125

# Degraded Mode
PROVIDER_DEGRADED=false
PROVIDER_DEGRADED_REASONS=()

# Detection function - check if provider CLI is available
provider_detect() {
    command -v claude >/dev/null 2>&1
}

# Version check function
provider_version() {
    claude --version 2>/dev/null | head -1
}

# Invocation function
provider_invoke() {
    local prompt="$1"
    shift
    claude --dangerously-skip-permissions -p "$prompt" "$@"
}

# Model tier to Task tool model parameter value
# Respects LOKI_ALLOW_HAIKU flag for tier mapping
provider_get_tier_param() {
    local tier="$1"
    if [ "${LOKI_ALLOW_HAIKU:-false}" = "true" ]; then
        # With haiku: original tier mapping
        case "$tier" in
            planning) echo "opus" ;;
            development) echo "sonnet" ;;
            fast) echo "haiku" ;;
            *) echo "sonnet" ;;
        esac
    else
        # Without haiku (default): upgrade all tiers
        # - Development + bug fixes -> opus
        # - Testing + documentation -> sonnet
        case "$tier" in
            planning) echo "opus" ;;
            development) echo "opus" ;;  # Upgraded from sonnet
            fast) echo "sonnet" ;;       # Upgraded from haiku
            *) echo "opus" ;;            # Default to opus
        esac
    fi
}

# Tier-aware invocation (Claude supports model selection via --model flag)
provider_invoke_with_tier() {
    local tier="$1"
    local prompt="$2"
    shift 2
    local model
    model=$(provider_get_tier_param "$tier")
    claude --dangerously-skip-permissions --model "$model" -p "$prompt" "$@"
}
