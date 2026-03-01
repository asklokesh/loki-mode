#!/usr/bin/env bash
# Aider Provider Configuration (18+ Providers, Tier 3)
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
#   source providers/aider.sh
#   if provider_detect; then
#       provider_invoke "Your prompt here"
#   fi
#
# Note: autonomy/run.sh uses inline invocation for streaming support
# and real-time agent tracking. These functions are intended for
# simpler scripts, wrappers, and external integrations.
# =====================================

# Provider Identity
PROVIDER_NAME="aider"
PROVIDER_DISPLAY_NAME="Aider (18+ Providers)"
PROVIDER_CLI="aider"

# CLI Invocation
# Aider uses --message for single-instruction mode, --yes-always for auto-approve
# Prompt is passed via --message flag, not positional
PROVIDER_AUTONOMOUS_FLAG="--yes-always"
PROVIDER_PROMPT_FLAG="--message"
PROVIDER_PROMPT_POSITIONAL=false

# Skill System
# Aider does not have a native skills directory
PROVIDER_SKILL_DIR=""
PROVIDER_SKILL_FORMAT="none"

# Capability Flags
PROVIDER_HAS_SUBAGENTS=false
PROVIDER_HAS_PARALLEL=false
PROVIDER_HAS_TASK_TOOL=false
PROVIDER_HAS_MCP=false
PROVIDER_MAX_PARALLEL=1

# Model Configuration
# Aider supports 18+ providers; model configured via LOKI_AIDER_MODEL env var
# or provider-specific env vars (OPENAI_API_KEY, OPENAI_API_BASE, etc.)
PROVIDER_MODEL_PLANNING="${LOKI_AIDER_MODEL:-claude-3.7-sonnet}"
PROVIDER_MODEL_DEVELOPMENT="${LOKI_AIDER_MODEL:-claude-3.7-sonnet}"
PROVIDER_MODEL_FAST="${LOKI_AIDER_MODEL:-claude-3.7-sonnet}"

# No Task tool - model is configured externally
PROVIDER_TASK_MODEL_PARAM=""
PROVIDER_TASK_MODEL_VALUES=()

# Context and Limits (varies by underlying model, conservative defaults)
PROVIDER_CONTEXT_WINDOW=200000
PROVIDER_MAX_OUTPUT_TOKENS=128000
PROVIDER_RATE_LIMIT_RPM=60

# Cost (varies by underlying provider, not tracked by loki)
PROVIDER_COST_INPUT_PLANNING=0.003
PROVIDER_COST_OUTPUT_PLANNING=0.015
PROVIDER_COST_INPUT_DEV=0.003
PROVIDER_COST_OUTPUT_DEV=0.015
PROVIDER_COST_INPUT_FAST=0.003
PROVIDER_COST_OUTPUT_FAST=0.015

# Degraded Mode
PROVIDER_DEGRADED=true
PROVIDER_DEGRADED_REASONS=(
    "No subagent support"
    "Sequential execution only"
    "No Task tool or MCP"
)

# Detection function - check if provider CLI is available
provider_detect() {
    command -v aider >/dev/null 2>&1
}

# Version check function
provider_version() {
    aider --version 2>/dev/null | head -1
}

# Invocation function
# --message: single instruction mode (process and exit)
# --yes-always: auto-approve all prompts
# --no-auto-commits: loki manages git
provider_invoke() {
    local prompt="$1"
    shift
    local model="${LOKI_AIDER_MODEL:-claude-3.7-sonnet}"
    local extra_flags="${LOKI_AIDER_FLAGS:-}"
    # shellcheck disable=SC2086
    aider --message "$prompt" \
          --yes-always \
          --no-auto-commits \
          --model "$model" \
          $extra_flags "$@" 2>&1
}

# Model tier to parameter (Aider uses single model, returns model name)
provider_get_tier_param() {
    local tier="$1"
    echo "${LOKI_AIDER_MODEL:-claude-3.7-sonnet}"
}

# Dynamic model resolution (v6.0.0)
# Aider uses a single externally-configured model, so tier resolution
# just returns the configured model name. maxTier has no effect.
resolve_model_for_tier() {
    local tier="$1"
    echo "${LOKI_AIDER_MODEL:-claude-3.7-sonnet}"
}

# Tier-aware invocation
# Aider uses a single model configured externally, tier has no effect
provider_invoke_with_tier() {
    local tier="$1"
    local prompt="$2"
    shift 2
    provider_invoke "$prompt" "$@"
}
