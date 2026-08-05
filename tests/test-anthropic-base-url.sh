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
# v7.104.0 (commit 766219ac) made Sonnet the default execution model for the
# planning and development tiers (~40% cheaper, near-frontier; restore opus via
# LOKI_CLAUDE_MODEL_DEVELOPMENT). These four assertions still expected opus.
# The Bun-route mirror (loki-ts/tests/runner/providers.test.ts) WAS updated for
# that flip; this bash twin was not, because no runner ever executed it.
# The contract under test -- the fail-closed BASE_URL AND override AND-gate --
# is unchanged and still asserted below.
v=$(_resolve planning "" ""); [ "$v" = "sonnet" ] && ok "no override: planning=sonnet" || bad "no override planning got [$v]"
v=$(_resolve development "" ""); [ "$v" = "sonnet" ] && ok "no override: development=sonnet" || bad "no override development got [$v]"
v=$(_resolve fast "" ""); [ "$v" = "sonnet" ] && ok "no override: fast=sonnet" || bad "no override fast got [$v]"

# ---------- ANTHROPIC_BASE_URL alone (no override -> still alias) ----------
v=$(_resolve development "https://openrouter.ai/api/v1" "")
[ "$v" = "sonnet" ] && ok "BASE_URL alone: development still=sonnet (no override)" \
    || bad "BASE_URL alone development got [$v]"

# ---------- LOKI_MODEL_OVERRIDE alone (no BASE_URL -> ignored) ----------
v=$(_resolve development "" "anthropic/claude-3.5-sonnet")
[ "$v" = "sonnet" ] && ok "override alone: ignored when no BASE_URL" \
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

# ---------- bash `loki doctor` ANTHROPIC_BASE_URL block (route parity) ----------
# v7.18.1: the bash doctor route gained the ANTHROPIC_BASE_URL detection block
# so it emits byte-identical output to the Bun route. These tests lock the
# block in place so the bun-parity matrix stays green when ANTHROPIC_BASE_URL
# is set in the environment.
_doctor_bash() {
    env ANTHROPIC_BASE_URL="${1:-}" LOKI_MODEL_OVERRIDE="${2:-}" LOKI_LEGACY_BASH=1 \
        bash "$REPO_ROOT/bin/loki" doctor 2>&1
}

out=$(_doctor_bash "https://api.anthropic.com" "")
printf '%s' "$out" | grep -q "ANTHROPIC_BASE_URL: https://api.anthropic.com" \
    && ok "doctor(bash): prints ANTHROPIC_BASE_URL endpoint" \
    || bad "doctor(bash): missing ANTHROPIC_BASE_URL endpoint line"
printf '%s' "$out" | grep -q "LOKI_MODEL_OVERRIDE not set" \
    && ok "doctor(bash): warns when LOKI_MODEL_OVERRIDE unset" \
    || bad "doctor(bash): missing LOKI_MODEL_OVERRIDE warn"

out=$(_doctor_bash "https://openrouter.ai/api/v1" "anthropic/claude-opus-4.5")
printf '%s' "$out" | grep -q "LOKI_MODEL_OVERRIDE: anthropic/claude-opus-4.5" \
    && ok "doctor(bash): prints LOKI_MODEL_OVERRIDE when set" \
    || bad "doctor(bash): missing LOKI_MODEL_OVERRIDE value line"

out=$(_doctor_bash "" "")
printf '%s' "$out" | grep -q "ANTHROPIC_BASE_URL" \
    && bad "doctor(bash): printed ANTHROPIC_BASE_URL block when env unset" \
    || ok "doctor(bash): no ANTHROPIC_BASE_URL block when env unset"

echo
echo "Total: $((PASS + FAIL))  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
