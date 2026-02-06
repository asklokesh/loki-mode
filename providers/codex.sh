#!/bin/bash
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
# VERIFIED: exec --full-auto confirmed in codex exec --help (v0.98.0)
# --full-auto: sets --ask-for-approval on-request + --sandbox workspace-write (v0.98.0)
# Alternative: "exec --dangerously-bypass-approvals-and-sandbox" (legacy, no sandbox)
PROVIDER_AUTONOMOUS_FLAG="exec --full-auto"
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
PROVIDER_MODEL_PLANNING="gpt-5.3-codex"
PROVIDER_MODEL_DEVELOPMENT="gpt-5.3-codex"
PROVIDER_MODEL_FAST="gpt-5.3-codex"

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
provider_invoke() {
    local prompt="$1"
    shift
    codex exec --full-auto "$prompt" "$@"
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

# Tier-aware invocation
# Note: Codex CLI does not support effort CLI flags
# Effort must be configured via environment: CODEX_MODEL_REASONING_EFFORT
# This function sets the env var before invocation
provider_invoke_with_tier() {
    local tier="$1"
    local prompt="$2"
    shift 2
    local effort
    effort=$(provider_get_tier_param "$tier")
    CODEX_MODEL_REASONING_EFFORT="$effort" codex exec --full-auto "$prompt" "$@"
}
