#!/usr/bin/env bash
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
# The Claude Code CLI resolves aliases (opus/sonnet/haiku) to the latest available
# model at invocation time, so we pass aliases rather than dated IDs. The canonical
# mapping lives in providers/model_catalog.json (single source of truth):
#   opus   -> latest Opus   (e.g. claude-opus-4-7 -- 1M context, adaptive thinking)
#   sonnet -> latest Sonnet (e.g. claude-sonnet-4-6)
#   haiku  -> latest Haiku  (e.g. claude-haiku-4-5)
# Override per tier with LOKI_CLAUDE_MODEL_PLANNING, _DEVELOPMENT, _FAST.
CLAUDE_DEFAULT_PLANNING="opus"
CLAUDE_DEFAULT_DEVELOPMENT="opus"  # Opus for dev (was sonnet)
CLAUDE_DEFAULT_FAST="sonnet"

if [ "${LOKI_ALLOW_HAIKU:-false}" = "true" ]; then
    CLAUDE_DEFAULT_DEVELOPMENT="sonnet"  # Sonnet for dev when haiku enabled
    CLAUDE_DEFAULT_FAST="haiku"
fi

# Resolution order: provider-specific env > generic env > haiku-aware default
PROVIDER_MODEL_PLANNING="${LOKI_CLAUDE_MODEL_PLANNING:-${LOKI_MODEL_PLANNING:-$CLAUDE_DEFAULT_PLANNING}}"
PROVIDER_MODEL_DEVELOPMENT="${LOKI_CLAUDE_MODEL_DEVELOPMENT:-${LOKI_MODEL_DEVELOPMENT:-$CLAUDE_DEFAULT_DEVELOPMENT}}"
PROVIDER_MODEL_FAST="${LOKI_CLAUDE_MODEL_FAST:-${LOKI_MODEL_FAST:-$CLAUDE_DEFAULT_FAST}}"

# Model Selection (for Task tool)
PROVIDER_TASK_MODEL_PARAM="model"
if [ "${LOKI_ALLOW_HAIKU:-false}" = "true" ]; then
    PROVIDER_TASK_MODEL_VALUES=("opus" "sonnet" "haiku")
else
    PROVIDER_TASK_MODEL_VALUES=("opus" "sonnet")  # No haiku option
fi

# Context and Limits
# Opus 4.7 ships with 1M context at standard pricing (no long-context premium).
# RARV-C uses this headroom for deeper memory retrieval and longer task budgets.
PROVIDER_CONTEXT_WINDOW=1000000
PROVIDER_MAX_OUTPUT_TOKENS=128000
PROVIDER_RATE_LIMIT_RPM=50

# Effort / thinking defaults for Opus 4.7 (used when Loki invokes the API
# directly; the interactive CLI manages this automatically).
PROVIDER_DEFAULT_EFFORT="${LOKI_CLAUDE_EFFORT:-xhigh}"     # xhigh recommended for coding
PROVIDER_DEFAULT_THINKING="${LOKI_CLAUDE_THINKING:-adaptive}"
PROVIDER_DEFAULT_TASK_BUDGET_TOKENS="${LOKI_CLAUDE_TASK_BUDGET:-0}"  # 0 = unset (open-ended)

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

# Dynamic model resolution (v6.0.0)
# Resolves a capability tier to a concrete model name at runtime.
# Respects LOKI_MAX_TIER to cap cost (e.g., maxTier=sonnet prevents opus usage).
# Capability aliases: "best" -> planning tier, "fast" -> fast tier, "balanced" -> development tier
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

    # Resolve tier to model
    case "$tier" in
        planning)    model="$PROVIDER_MODEL_PLANNING" ;;
        development) model="$PROVIDER_MODEL_DEVELOPMENT" ;;
        fast)        model="$PROVIDER_MODEL_FAST" ;;
        *)           model="$PROVIDER_MODEL_DEVELOPMENT" ;;
    esac

    # Apply maxTier ceiling if set
    if [ -n "$max_tier" ]; then
        case "$max_tier" in
            haiku)
                # Cap everything to haiku/fast
                model="$PROVIDER_MODEL_FAST"
                ;;
            sonnet)
                # Cap planning to development
                if [ "$tier" = "planning" ]; then
                    model="$PROVIDER_MODEL_DEVELOPMENT"
                fi
                ;;
            opus)
                # No cap needed, opus is max
                ;;
        esac
    fi

    echo "$model"
}

# Tier-aware invocation (values are already aliases like opus/sonnet/haiku)
provider_invoke_with_tier() {
    local tier="$1"
    local prompt="$2"
    shift 2
    local model
    model=$(resolve_model_for_tier "$tier")
    claude --dangerously-skip-permissions --model "$model" -p "$prompt" "$@"
}
