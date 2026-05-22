#!/usr/bin/env bash
# tests/test-anthropic-base-url.sh -- Phase I (v7.5.25) regression tests.
#
# Verifies:
# - resolve_model_for_tier returns the alias-based default when
#   ANTHROPIC_BASE_URL is unset (existing behavior)
# - When BOTH ANTHROPIC_BASE_URL and LOKI_MODEL_OVERRIDE are set,
#   resolve_model_for_tier returns LOKI_MODEL_OVERRIDE (alt-provider routing)
# - LOKI_MODEL_OVERRIDE alone (without ANTHROPIC_BASE_URL) does NOT override
#   the tier default (Anthropic-native invocations stay on aliases)
# - The override is respected for all 3 tiers (planning, development, fast)

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

# Helper: run resolve_model_for_tier in a clean subshell with controlled env.
_resolve() {
    local tier="$1"
    local base_url="${2:-}"
    local override="${3:-}"
    env -i HOME="$HOME" PATH="$PATH" \
        ANTHROPIC_BASE_URL="$base_url" \
        LOKI_MODEL_OVERRIDE="$override" \
        bash -c "set -e; cd '$REPO_ROOT'; . providers/claude.sh; resolve_model_for_tier '$tier'"
}

# ---------- No override (existing alias-based defaults) ----------
v=$(_resolve planning "" ""); [ "$v" = "opus" ] && ok "no override: planning=opus" || bad "no override planning got [$v]"
v=$(_resolve development "" ""); [ "$v" = "opus" ] && ok "no override: development=opus" || bad "no override development got [$v]"
v=$(_resolve fast "" ""); [ "$v" = "sonnet" ] && ok "no override: fast=sonnet" || bad "no override fast got [$v]"

# ---------- ANTHROPIC_BASE_URL alone (no override -> still alias) ----------
v=$(_resolve development "https://openrouter.ai/api/v1" "")
[ "$v" = "opus" ] && ok "BASE_URL alone: development still=opus (no override)" \
    || bad "BASE_URL alone development got [$v]"

# ---------- LOKI_MODEL_OVERRIDE alone (no BASE_URL -> ignored) ----------
v=$(_resolve development "" "anthropic/claude-3.5-sonnet")
[ "$v" = "opus" ] && ok "override alone: ignored when no BASE_URL" \
    || bad "override alone development got [$v]"

# ---------- BOTH set: override wins across all tiers ----------
v=$(_resolve planning "https://openrouter.ai/api/v1" "anthropic/claude-opus-4.5")
[ "$v" = "anthropic/claude-opus-4.5" ] && ok "both set: planning -> override" \
    || bad "both planning got [$v]"

v=$(_resolve development "https://openrouter.ai/api/v1" "anthropic/claude-3.5-sonnet")
[ "$v" = "anthropic/claude-3.5-sonnet" ] && ok "both set: development -> override" \
    || bad "both development got [$v]"

v=$(_resolve fast "https://openrouter.ai/api/v1" "anthropic/claude-3.5-haiku")
[ "$v" = "anthropic/claude-3.5-haiku" ] && ok "both set: fast -> override" \
    || bad "both fast got [$v]"

# ---------- Ollama-style local endpoint ----------
v=$(_resolve development "http://localhost:11434/v1" "qwen2.5-coder:32b")
[ "$v" = "qwen2.5-coder:32b" ] && ok "ollama: override applies for local endpoint" \
    || bad "ollama got [$v]"

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
