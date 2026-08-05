#!/usr/bin/env bash
# opencode Provider Configuration
# Shell-sourceable config for loki-mode multi-provider support.
#
# WHY THIS PROVIDER EXISTS
#   opencode is the model-agnostic route. It reaches 75+ providers through the
#   AI SDK + Models.dev registry, supports ANY OpenAI-compatible endpoint via
#   `@ai-sdk/openai-compatible`, and runs local models (Ollama, LM Studio,
#   llama.cpp). Users can add providers that are NOT in its built-in list -- it
#   is a registry, not a hardcoded table.
#
#   That matters because our own catalog is a fixed four-key file. Driving
#   opencode gives users every cheap open model without us maintaining a model
#   list per vendor.
#
#   Verified 2026-07-29/30:
#     - opencode.ai/docs/providers documents 75+ providers and custom
#       OpenAI-compatible endpoints.
#     - anomalyco/opencode: 190,871 stars, release v1.18.9 (2026-07-28), pushed
#       same week. Actively developed. (By contrast aider's last release is
#       v0.86.0 from 2025-08-09, and Roo Code is archived, Continue read-only --
#       so opencode, not aider, is the durable cheap-model route.)
#
#   Cost context (SWE-bench uniform scaffold, mini-swe-agent v2.0.0, 2026-02-17):
#   MiniMax M2.5 resolved 75.8 at $36.64 total vs Claude Opus 4.6 at 75.6 for
#   $275.76 -- an open model matching frontier accuracy at ~7.5x lower cost.
#
# CLI SURFACE (verified against the installed binary, v1.17.9, not assumed):
#   opencode run [message..]     non-interactive run
#     -m, --model provider/model model selection
#     --agent NAME               agent selection
#     --print-logs               logs to stderr
#   opencode models [provider]   list available models
#   opencode providers           manage providers/credentials
#
# Usage:
#   source providers/opencode.sh
#   if provider_detect; then provider_invoke "Your prompt here"; fi
# =====================================

# Provider Identity
PROVIDER_NAME="opencode"
PROVIDER_DISPLAY_NAME="opencode (75+ providers, model-agnostic)"
PROVIDER_CLI="opencode"

# CLI Invocation
# `run` takes the prompt POSITIONALLY; there is no -p/--prompt flag.
PROVIDER_SUBCOMMAND="run"
# --auto is REQUIRED for autonomous operation. Verified against the real CLI
# (opencode 1.18.9): `opencode run --help` documents
#   --auto  auto-approve permissions that are not explicitly denied  [default: false]
# The earlier empty value assumed `opencode run <prompt>` was already
# non-interactive. It is not: without --auto the run stalls on the first
# permission prompt with no TTY to answer it, which is indistinguishable from a
# hang. This is opencode's equivalent of claude's --dangerously-skip-permissions
# and aider's --yes-always, both of which their providers already pass.
PROVIDER_AUTONOMOUS_FLAG="--auto"
PROVIDER_PROMPT_FLAG=""
PROVIDER_PROMPT_POSITIONAL=true

# Skill System
PROVIDER_SKILL_DIR="${HOME}/.config/opencode"
PROVIDER_SKILL_FORMAT="markdown"

# Capability Flags
# Ranked by MODELS UNLOCKED, not by how Claude-like the CLI is. opencode has no
# Task tool, but it reaches every cheap model, which is the axis that matters
# for cost. It is not "degraded" -- it is differently capable.
PROVIDER_HAS_SUBAGENTS=false
PROVIDER_HAS_PARALLEL=false
PROVIDER_HAS_TASK_TOOL=false
PROVIDER_HAS_MCP=true          # `opencode mcp` manages MCP servers
PROVIDER_MAX_PARALLEL=1
PROVIDER_DEGRADED=false
PROVIDER_MAX_OUTPUT_TOKENS=128000

# Model defaults. opencode names models "provider/model"; the catalog supplies
# the value and LOKI_OPENCODE_MODEL overrides it.
_opencode_default_from_catalog() {
    if type loki_latest_model >/dev/null 2>&1; then
        loki_latest_model opencode development 2>/dev/null && return 0
    fi
    printf 'openrouter/deepseek/deepseek-v3.2'
}
# Resolution: provider-scoped env > catalog. The GLOBAL tier var
# (LOKI_MODEL_DEVELOPMENT) is deliberately NOT in this chain: opencode takes
# "provider/model" strings ("openrouter/deepseek/deepseek-v3.2"), while the
# global tier var carries Claude CLI aliases ("sonnet"), so a global set for
# one provider silently changed opencode's model too. Namespace-incompatible,
# not merely mis-ordered. Do not re-add it.
OPENCODE_DEFAULT_MODEL="${LOKI_OPENCODE_MODEL:-$(_opencode_default_from_catalog)}"
PROVIDER_MODEL_PLANNING="$OPENCODE_DEFAULT_MODEL"
PROVIDER_MODEL_DEVELOPMENT="$OPENCODE_DEFAULT_MODEL"
PROVIDER_MODEL_FAST="$OPENCODE_DEFAULT_MODEL"

# provider_detect -- is the CLI installed?
provider_detect() {
    command -v opencode >/dev/null 2>&1
}

# provider_version -- CLI version string (empty when absent).
provider_version() {
    command -v opencode >/dev/null 2>&1 || return 1
    opencode --version 2>/dev/null | head -1
}

# provider_get_tier_param -- map a loki tier to an opencode model id.
# opencode has no opus/sonnet/haiku tier concept, so all three tiers resolve to
# one model unless the operator overrides per tier. This mirrors the codex
# provider, where tier flattening is already an accepted shape.
provider_get_tier_param() {
    local tier="${1:-development}"
    case "$tier" in
        planning)    printf '%s' "$PROVIDER_MODEL_PLANNING" ;;
        fast)        printf '%s' "$PROVIDER_MODEL_FAST" ;;
        *)           printf '%s' "$PROVIDER_MODEL_DEVELOPMENT" ;;
    esac
}

# provider_invoke <prompt> -- run one non-interactive turn.
provider_invoke() {
    # CONTRACT: prompt is $1, and EXTRA ARGS MUST PASS THROUGH. The first cut of
    # this provider used `local prompt="${1:-}"` with no `shift`, which silently
    # DROPPED every caller-supplied flag -- callers pass model overrides and
    # per-invocation flags positionally after the prompt. Dropping them fails
    # quietly: opencode still runs, just not with what the caller asked for,
    # which is the worst shape for a provider-agnostic route to fail in.
    # tests/test-provider-invocation.sh asserts this signature for EVERY
    # provider precisely so a new one cannot skip it.
    local prompt="$1"
    shift
    [ -n "$prompt" ] || return 1
    command -v opencode >/dev/null 2>&1 || return 127
    opencode run --auto --model "$PROVIDER_MODEL_DEVELOPMENT" "$prompt" "$@"
}

# provider_invoke_with_tier <tier> <prompt>
provider_invoke_with_tier() {
    # Same contract as provider_invoke, with the tier ahead of the prompt:
    # tier=$1, prompt=$2, `shift 2`, remainder forwarded verbatim.
    local tier="$1"
    local prompt="$2"
    shift 2
    [ -n "$tier" ] || tier="development"
    [ -n "$prompt" ] || return 1
    command -v opencode >/dev/null 2>&1 || return 127
    local model
    model="$(provider_get_tier_param "$tier")"
    opencode run --auto --model "$model" "$prompt" "$@"
}

# provider_invoke_argv <tier> <prompt> -- see providers/claude.sh for rationale.
provider_invoke_argv() {
    local tier="${1:-development}"
    local prompt="${2:-}"
    local model
    model="$(provider_get_tier_param "$tier")"
    _LOKI_INVOKE_ARGV=(opencode run --auto --model "$model" "$prompt")
}
