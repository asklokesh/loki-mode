#!/usr/bin/env bash
# Cline CLI Provider Configuration (Multi-Provider, Tier 2)
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
#   source providers/cline.sh
#   if provider_detect; then
#       provider_invoke "Your prompt here"
#   fi
#
# Note: autonomy/run.sh uses inline invocation for streaming support
# and real-time agent tracking. These functions are intended for
# simpler scripts, wrappers, and external integrations.
# =====================================

# Provider Identity
PROVIDER_NAME="cline"
PROVIDER_DISPLAY_NAME="Cline CLI (Multi-Provider)"
PROVIDER_CLI="cline"

# CLI Invocation
# Cline CLI v2.5+ uses -y / --yolo for autonomous mode
# Prompt is passed as positional argument
PROVIDER_AUTONOMOUS_FLAG="-y"
PROVIDER_PROMPT_FLAG=""
PROVIDER_PROMPT_POSITIONAL=true

# Skill System
# Cline does not have a native skills directory
PROVIDER_SKILL_DIR=""
PROVIDER_SKILL_FORMAT="none"

# Capability Flags
# Cline has subagents and MCP -- NOT fully degraded (Tier 2)
PROVIDER_HAS_SUBAGENTS=true
PROVIDER_HAS_PARALLEL=false
PROVIDER_HAS_TASK_TOOL=false
PROVIDER_HAS_MCP=true
PROVIDER_MAX_PARALLEL=1

# Model Configuration
# Cline supports 12+ providers; model configured via LOKI_CLINE_MODEL env var
# or `cline auth` one-time setup. Defaults are placeholders.
PROVIDER_MODEL_PLANNING="${LOKI_CLINE_MODEL:-claude-sonnet-4-5-20250929}"
PROVIDER_MODEL_DEVELOPMENT="${LOKI_CLINE_MODEL:-claude-sonnet-4-5-20250929}"
PROVIDER_MODEL_FAST="${LOKI_CLINE_MODEL:-claude-sonnet-4-5-20250929}"

# No Task tool - model is configured externally
PROVIDER_TASK_MODEL_PARAM=""
PROVIDER_TASK_MODEL_VALUES=()

# Context and Limits (varies by underlying provider, conservative defaults)
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
# Cline is NOT degraded -- it has subagents and MCP (Tier 2: near-full)
PROVIDER_DEGRADED=false
PROVIDER_DEGRADED_REASONS=()

# Detection function - check if provider CLI is available
provider_detect() {
    command -v cline >/dev/null 2>&1
}

# Version check function
provider_version() {
    cline --version 2>/dev/null | head -1
}

# Invocation function
# Uses -y (YOLO) for autonomous mode, positional prompt
provider_invoke() {
    local prompt="$1"
    shift
    local model="${LOKI_CLINE_MODEL:-}"
    local model_flag=""
    [[ -n "$model" ]] && model_flag="-m $model"
    # shellcheck disable=SC2086
    cline -y $model_flag "$prompt" "$@" 2>&1
}

# Model tier to parameter (Cline uses single model, returns model name)
provider_get_tier_param() {
    local tier="$1"
    echo "${LOKI_CLINE_MODEL:-default}"
}

# Dynamic model resolution (v6.0.0)
# Cline uses a single externally-configured model, so tier resolution
# just returns the configured model name. maxTier has no effect.
resolve_model_for_tier() {
    local tier="$1"
    echo "${LOKI_CLINE_MODEL:-default}"
}

# Tier-aware invocation
# Cline uses a single model configured externally, tier has no effect
provider_invoke_with_tier() {
    local tier="$1"
    local prompt="$2"
    shift 2
    provider_invoke "$prompt" "$@"
}
