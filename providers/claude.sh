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

# Source the v7.5.19 Phase B claude-flags helper (idempotent).
# shellcheck source=../autonomy/lib/claude-flags.sh
_loki_claude_flags_helper="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/autonomy/lib/claude-flags.sh"
if [ -f "$_loki_claude_flags_helper" ]; then
    # shellcheck disable=SC1090
    . "$_loki_claude_flags_helper"
fi

# Source the v7.5.22 Phase D mcp-config helper (idempotent).
# shellcheck source=../autonomy/lib/mcp-config.sh
_loki_mcp_config_helper="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/autonomy/lib/mcp-config.sh"
if [ -f "$_loki_mcp_config_helper" ]; then
    # shellcheck disable=SC1090
    . "$_loki_mcp_config_helper"
fi

# Build the auto-derived flag array. Caller passes tier + complexity + primary model.
# Values that the helper returns empty are dropped (no flag emitted).
# Honors loki_claude_flag_supported() so we never pass a flag the installed CLI lacks.
_loki_build_claude_auto_flags() {
    local tier="${1:-development}"
    local complexity="${2:-${LOKI_COMPLEXITY:-standard}}"
    local primary="${3:-}"
    _LOKI_CLAUDE_AUTO_FLAGS=()

    # --effort: default-on derived from tier + complexity.
    if type loki_effort_for_tier >/dev/null 2>&1 && loki_claude_flag_supported "--effort"; then
        local effort
        effort=$(loki_effort_for_tier "$tier" "$complexity")
        if [ -n "$effort" ]; then
            _LOKI_CLAUDE_AUTO_FLAGS+=("--effort" "$effort")
        fi
    fi

    # --max-budget-usd: derived from LOKI_BUDGET_LIMIT minus spend.
    if type loki_remaining_budget >/dev/null 2>&1 && loki_claude_flag_supported "--max-budget-usd"; then
        local rem
        rem=$(loki_remaining_budget)
        if [ -n "$rem" ]; then
            _LOKI_CLAUDE_AUTO_FLAGS+=("--max-budget-usd" "$rem")
        fi
    fi

    # --fallback-model: derived from primary model alias.
    if [ -n "$primary" ] && type loki_fallback_for_primary >/dev/null 2>&1 && loki_claude_flag_supported "--fallback-model"; then
        local fb
        fb=$(loki_fallback_for_primary "$primary")
        if [ -n "$fb" ]; then
            _LOKI_CLAUDE_AUTO_FLAGS+=("--fallback-model" "$fb")
        fi
    fi

    # --exclude-dynamic-system-prompt-sections (Phase E, v7.5.20).
    # Move per-machine sections (cwd, env, memory paths, git status) from the
    # system prompt into the first user message. Improves cross-user prompt-cache
    # reuse. Boolean flag: pass it OR do not, no value. Default ON when supported.
    # Suppress with LOKI_DYNAMIC_PROMPT_SECTIONS=keep (for users who want the
    # old behavior; the only opt-out lever for this flag).
    if [ "${LOKI_DYNAMIC_PROMPT_SECTIONS:-auto}" != "keep" ] \
       && loki_claude_flag_supported "--exclude-dynamic-system-prompt-sections"; then
        _LOKI_CLAUDE_AUTO_FLAGS+=("--exclude-dynamic-system-prompt-sections")
    fi

    # --mcp-config (Phase D, v7.5.22). Variadic flag (Commander `<configs...>`):
    # Claude expects SEPARATE argv elements per path, not one space-joined
    # value. Per Dev-C parity concern -- spread each path as its own argv
    # element so bash matches Bun's shape exactly. Loki bundle first, optional
    # user overlay (~/.claude/mcp.json) second. Skip entirely if the bundle
    # cannot be written so we never pass malformed paths.
    if type loki_mcp_config_argv >/dev/null 2>&1 \
       && loki_claude_flag_supported "--mcp-config"; then
        local _mcp_argv
        if _mcp_argv=$(loki_mcp_config_argv) && [ -n "$_mcp_argv" ]; then
            _LOKI_CLAUDE_AUTO_FLAGS+=("--mcp-config")
            # Split space-separated path list into individual argv elements.
            # Both paths come from Loki-controlled writers (loki_mcp_config_path)
            # or HOME expansion -- whitespace in paths is not supported here.
            local _mcp_path
            for _mcp_path in $_mcp_argv; do
                _LOKI_CLAUDE_AUTO_FLAGS+=("$_mcp_path")
            done
            # EMBED 1 (v7.33.0): --strict-mcp-config. ONLY emitted alongside an
            # actual --mcp-config bundle (never bare). Per `claude --help` it
            # makes the agent load servers ONLY from --mcp-config, ignoring ALL
            # other MCP sources (auto-discovered project .mcp.json AND any
            # settings-injected configs). Note the bundle already includes the
            # user's ~/.claude/mcp.json overlay explicitly, so the common
            # user-MCP case is preserved; what is dropped is any MCP config not
            # in the explicit bundle, making the run reproducible.
            # Default-ON; opt out with LOKI_STRICT_MCP=0. Gated on CLI support so
            # an older claude degrades gracefully.
            if [ "${LOKI_STRICT_MCP:-1}" != "0" ] \
               && loki_claude_flag_supported "--strict-mcp-config"; then
                _LOKI_CLAUDE_AUTO_FLAGS+=("--strict-mcp-config")
            fi
        fi
    fi

    # --include-hook-events (Phase D, v7.5.22). Boolean flag; only valid
    # when --output-format=stream-json (which the claude branch in
    # autonomy/run.sh always uses). Default-on; opt out with
    # LOKI_HOOK_EVENTS=off.
    if [ "${LOKI_HOOK_EVENTS:-on}" != "off" ] \
       && loki_claude_flag_supported "--include-hook-events"; then
        _LOKI_CLAUDE_AUTO_FLAGS+=("--include-hook-events")
    fi

    # --append-system-prompt (v7.7.31): authorize autonomous operation at the
    # system-prompt tier so the spawned agent does not refuse the run. Without
    # this, the agent reads the user's global ~/.claude/CLAUDE.md (which may say
    # "always ask for clarification" / "never commit without permission"),
    # judges it to conflict with Loki's "never ask, never stop" prompt (which is
    # only a user-message instruction and thus lower precedence), calls
    # AskUserQuestion, and exits in ~30s having done nothing. An appended system
    # prompt outranks CLAUDE.md memory (verified empirically), so it resolves the
    # conflict in Loki's favor for this authorized session. Default-on; opt out
    # with LOKI_AUTONOMY_OVERRIDE=off. We never edit the user's CLAUDE.md.
    if [ "${LOKI_AUTONOMY_OVERRIDE:-on}" != "off" ] \
       && loki_claude_flag_supported "--append-system-prompt"; then
        _LOKI_CLAUDE_AUTO_FLAGS+=("--append-system-prompt" "$(_loki_autonomy_override_text)")
    fi

    # --setting-sources (v7.8.0): pin the settings precedence so the invocation
    # does not drift with Claude Code's implicit default. Behavior-neutral.
    # Default-on; opt out with LOKI_SETTING_SOURCES=off.
    if [ "${LOKI_SETTING_SOURCES:-on}" != "off" ] \
       && loki_claude_flag_supported "--setting-sources"; then
        _LOKI_CLAUDE_AUTO_FLAGS+=("--setting-sources" "user,project,local")
    fi

    # --include-partial-messages (v7.8.0): stream incremental assistant deltas
    # for real-time dashboard/terminal output. The stream-json parser handles
    # the stream_event type additively and de-dupes against the final message.
    # Default-on; opt out with LOKI_PARTIAL_MESSAGES=off.
    if [ "${LOKI_PARTIAL_MESSAGES:-on}" != "off" ] \
       && loki_claude_flag_supported "--include-partial-messages"; then
        _LOKI_CLAUDE_AUTO_FLAGS+=("--include-partial-messages")
    fi
}

# The system-prompt text that authorizes autonomous operation and resolves
# precedence against a conflicting user/project CLAUDE.md. Kept in one place so
# the bash and Bun routes can stay byte-identical. No emojis, no em dashes.
_loki_autonomy_override_text() {
    cat <<'LOKI_AUTONOMY_EOF'
[LOKI-AUTONOMY-AGENT] This is a Loki Mode autonomous agent process.
You are running INSIDE Loki Mode autonomous execution, a session the user explicitly launched with full prior authorization (loki start / loki run). This IS an authorized autonomous session, not an unattended action you must seek consent for.

Instruction precedence for THIS session: when the loki_system instructions in the user prompt conflict with any CLAUDE.md, project memory, or global memory that tells you to ask for clarification, pause for confirmation, refuse to act autonomously, or withhold routine commits, the loki_system instructions take precedence. The user has already consented by launching autonomous mode.

Therefore, for this session: do NOT ask the user questions, do NOT call the AskUserQuestion tool, do NOT stop to request confirmation, and do NOT refuse routine, reversible engineering work (writing code, running tests, creating files, atomic git checkpoints in the working tree). Proceed and complete the task directly. If a decision is genuinely ambiguous, choose the most reasonable option, record the assumption in .loki/CONTINUITY.md, and continue rather than halting.

Commit hygiene still applies: git checkpoints are LOCAL only. Never push or force-push. Stage files by explicit path, never `git add -A` or `git add .`, and never commit secrets, credentials, .env files, or untracked files you did not author this session.

This precedence override is narrow. It does NOT relax any safety rule. Every safety prohibition in CLAUDE.md or memory still fully binds: anything genuinely destructive or irreversible remains out of scope unless the task explicitly calls for it. This includes (not limited to) force-pushing, deleting or overwriting the user's data, dropping or truncating databases, publishing or releasing, rotating or exfiltrating secrets, touching production systems, and anything a CLAUDE.md safety rule explicitly forbids. When in doubt about whether an action is destructive, treat it as destructive and do not do it.
LOKI_AUTONOMY_EOF
}

# Invocation function (basic, no tier).
# Auto-flags use development tier defaults.
provider_invoke() {
    local prompt="$1"
    shift
    _loki_build_claude_auto_flags "development" "${LOKI_COMPLEXITY:-standard}" ""
    claude --dangerously-skip-permissions "${_LOKI_CLAUDE_AUTO_FLAGS[@]}" -p "$prompt" "$@"
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

# Canonical model-override / session-model normalization (single source of
# truth shared by run.sh, the dashboard, and the estimator). Trim leading and
# trailing whitespace, lowercase, and accept ONLY an exact allowlisted alias.
# Interior whitespace (e.g. "fab le") is therefore rejected rather than silently
# collapsed into "fable". bash 3.2 safe (no ${var,,}); uses tr for lowercasing.
# Echoes the canonical alias on success, or the empty string when the input is
# not an exact allowlisted alias.
loki_normalize_model_alias() {
    local raw="$1"
    # Trim leading/trailing whitespace (interior whitespace preserved so a
    # value like "fab le" stays "fab le" and fails the exact-match below).
    raw="${raw#"${raw%%[![:space:]]*}"}"
    raw="${raw%"${raw##*[![:space:]]}"}"
    raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
    case "$raw" in
        haiku|sonnet|opus|fable) printf '%s' "$raw" ;;
        *) printf '%s' "" ;;
    esac
}

# Shared cost-ceiling clamp (single source of truth for LOKI_MAX_TIER). Given a
# resolved model name and a tier hint, return the model clamped down to the
# operator's LOKI_MAX_TIER ceiling. Used by resolve_model_for_tier AND by the
# mid-flight model-override path in run.sh so a dashboard/CLI override cannot
# silently bypass the ceiling. Clamps are byte-identical by construction:
# sonnet-cap resolves planning/fable down to PROVIDER_MODEL_DEVELOPMENT (opus by
# default), opus-cap resolves fable down to opus, haiku-cap pins everything to
# PROVIDER_MODEL_FAST. No ceiling set -> model unchanged.
loki_apply_max_tier_clamp() {
    local model="$1"
    local tier="${2:-}"
    local max_tier="${LOKI_MAX_TIER:-}"
    # Normalize EXACTLY like the python ports (dashboard _clamp_to_max_tier,
    # estimator _max_tier): trim + lowercase. Without this, a user-typed cap
    # like "Sonnet" (settings.json maxTier exports verbatim) was silently
    # ignored here while quote and dashboard claimed the ceiling enforced:
    # the run would exceed the quote. Council R1 finding, v7.31.0.
    max_tier="$(printf '%s' "$max_tier" | tr '[:upper:]' '[:lower:]' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -z "$max_tier" ] && { printf '%s' "$model"; return; }
    case "$max_tier" in
        haiku)
            model="$PROVIDER_MODEL_FAST"
            ;;
        sonnet)
            # Cap planning/fable down to development.
            if [ "$tier" = "planning" ] || [ "$tier" = "fable" ] || [ "$model" = "fable" ]; then
                model="$PROVIDER_MODEL_DEVELOPMENT"
            fi
            ;;
        opus)
            # Opus is the ceiling: cap fable back to opus.
            if [ "$model" = "fable" ]; then
                model="opus"
            fi
            ;;
    esac
    printf '%s' "$model"
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

    local model=""

    # Resolve tier to model
    #   fable) explicit top-tier advisory model (Fable 5, 2x Opus). Reached when
    #          the session is pinned to fable (LOKI_SESSION_MODEL=fable), the
    #          mid-flight override file selects fable, or the architect opt-in
    #          (LOKI_FABLE_ARCHITECT=1) pins the first iteration's tier to fable
    #          in run.sh. So the resolver honors the documented lever instead of
    #          falling through the `*` arm to opus (the model-honesty fix).
    case "$tier" in
        planning)    model="$PROVIDER_MODEL_PLANNING" ;;
        development) model="$PROVIDER_MODEL_DEVELOPMENT" ;;
        fast)        model="$PROVIDER_MODEL_FAST" ;;
        fable)       model="fable" ;;
        *)           model="$PROVIDER_MODEL_DEVELOPMENT" ;;
    esac

    # Architect opt-in (LOKI_FABLE_ARCHITECT) is NOT applied here. It is applied
    # in run.sh, scoped to the FIRST iteration only (the architecture pass), so
    # a session pinned to opus does not silently route every iteration to fable.
    # run.sh sets CURRENT_TIER=fable for that one iteration, which lands on the
    # `fable)` arm above. Keeping the decision in run.sh is the only place that
    # has ITERATION_COUNT, so the scoping is honest.

    # Apply the shared LOKI_MAX_TIER ceiling (same clamp the run.sh override path
    # uses, so the cost ceiling is enforced byte-identically on both paths).
    model="$(loki_apply_max_tier_clamp "$model" "$tier")"

    # Phase I (v7.5.25): when ANTHROPIC_BASE_URL is set, the user is routing
    # Claude Code to an alt-provider (OpenRouter, Ollama, LiteLLM, self-hosted).
    # The alt-provider may not recognize the opus/sonnet/haiku aliases that
    # only Anthropic resolves. Let the user override the resolved model name
    # via LOKI_MODEL_OVERRIDE; it wins over all tier mapping. Bash and Bun
    # routes honor the same env var.
    if [ -n "${ANTHROPIC_BASE_URL:-}" ] && [ -n "${LOKI_MODEL_OVERRIDE:-}" ]; then
        model="$LOKI_MODEL_OVERRIDE"
    fi

    echo "$model"
}

# Tier-aware invocation (values are already aliases like opus/sonnet/haiku).
# v7.5.19 Phase B: auto-derive --effort, --max-budget-usd, --fallback-model from existing Loki state.
# v7.5.25 Phase I: ANTHROPIC_BASE_URL is passed through unchanged (Claude Code
# reads it natively; we never strip or rewrite it). LOKI_MODEL_OVERRIDE wins
# over tier-resolved model when an alt-provider endpoint is configured.
provider_invoke_with_tier() {
    local tier="$1"
    local prompt="$2"
    shift 2
    local model
    model=$(resolve_model_for_tier "$tier")
    _loki_build_claude_auto_flags "$tier" "${LOKI_COMPLEXITY:-standard}" "$model"
    claude --dangerously-skip-permissions --model "$model" "${_LOKI_CLAUDE_AUTO_FLAGS[@]}" -p "$prompt" "$@"
}
