#!/usr/bin/env bash
# Test: Provider Degraded Mode Functionality
# Tests degraded mode flags, reasons, and capability constraints for all providers

set -uo pipefail
# Note: Not using -e to allow collecting all test results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDERS_DIR="$SCRIPT_DIR/../providers"
PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

# Helper: Reset all provider variables before loading a new provider
reset_provider_vars() {
    unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI 2>/dev/null || true
    unset PROVIDER_DEGRADED PROVIDER_DEGRADED_REASONS 2>/dev/null || true
    unset PROVIDER_HAS_SUBAGENTS PROVIDER_HAS_PARALLEL 2>/dev/null || true
    unset PROVIDER_HAS_TASK_TOOL PROVIDER_HAS_MCP 2>/dev/null || true
    unset PROVIDER_MAX_PARALLEL 2>/dev/null || true
}

# Helper: Load a provider config directly (bypass loader for direct testing)
load_provider_direct() {
    local provider="$1"
    local config_file="$PROVIDERS_DIR/${provider}.sh"
    if [ -f "$config_file" ]; then
        source "$config_file"
        return 0
    fi
    return 1
}

echo "========================================"
echo "Provider Degraded Mode Tests"
echo "========================================"
echo "Providers dir: $PROVIDERS_DIR"
echo ""

# ===========================================
# Test 1: Claude PROVIDER_DEGRADED is false
# ===========================================
log_test "Claude PROVIDER_DEGRADED is false"
reset_provider_vars
if load_provider_direct "claude"; then
    if [ "$PROVIDER_DEGRADED" = "false" ]; then
        log_pass "Claude PROVIDER_DEGRADED is false (full capability mode)"
    else
        log_fail "Claude PROVIDER_DEGRADED should be false (got: $PROVIDER_DEGRADED)"
    fi
else
    log_fail "Failed to load claude provider config"
fi

# ===========================================
# Test 2: Codex PROVIDER_DEGRADED is true
# ===========================================
log_test "Codex PROVIDER_DEGRADED is true"
reset_provider_vars
if load_provider_direct "codex"; then
    if [ "$PROVIDER_DEGRADED" = "true" ]; then
        log_pass "Codex PROVIDER_DEGRADED is true (degraded mode)"
    else
        log_fail "Codex PROVIDER_DEGRADED should be true (got: $PROVIDER_DEGRADED)"
    fi
else
    log_fail "Failed to load codex provider config"
fi

# Test 3: Gemini removed in v7.5.18 -- skipped.

# ===========================================
# Test 4: Claude PROVIDER_DEGRADED_REASONS is empty
# ===========================================
log_test "Claude PROVIDER_DEGRADED_REASONS is empty"
reset_provider_vars
if load_provider_direct "claude"; then
    if [ ${#PROVIDER_DEGRADED_REASONS[@]} -eq 0 ]; then
        log_pass "Claude PROVIDER_DEGRADED_REASONS is empty (no limitations)"
    else
        log_fail "Claude PROVIDER_DEGRADED_REASONS should be empty (got: ${#PROVIDER_DEGRADED_REASONS[@]} reasons)"
    fi
else
    log_fail "Failed to load claude provider config"
fi

# ===========================================
# Test 5: Codex PROVIDER_DEGRADED_REASONS is populated
# ===========================================
log_test "Codex PROVIDER_DEGRADED_REASONS is populated"
reset_provider_vars
if load_provider_direct "codex"; then
    if [ ${#PROVIDER_DEGRADED_REASONS[@]} -gt 0 ]; then
        log_pass "Codex PROVIDER_DEGRADED_REASONS has ${#PROVIDER_DEGRADED_REASONS[@]} reasons"
    else
        log_fail "Codex PROVIDER_DEGRADED_REASONS should be populated"
    fi
else
    log_fail "Failed to load codex provider config"
fi

# Test 6: Gemini removed in v7.5.18 -- skipped.

# ===========================================
# Test 7: Claude has full capability flags (all true)
# ===========================================
log_test "Claude has full capability flags"
reset_provider_vars
if load_provider_direct "claude"; then
    failed_caps=()
    [ "$PROVIDER_HAS_SUBAGENTS" != "true" ] && failed_caps+=("PROVIDER_HAS_SUBAGENTS")
    [ "$PROVIDER_HAS_PARALLEL" != "true" ] && failed_caps+=("PROVIDER_HAS_PARALLEL")
    [ "$PROVIDER_HAS_TASK_TOOL" != "true" ] && failed_caps+=("PROVIDER_HAS_TASK_TOOL")
    [ "$PROVIDER_HAS_MCP" != "true" ] && failed_caps+=("PROVIDER_HAS_MCP")

    if [ ${#failed_caps[@]} -eq 0 ]; then
        log_pass "Claude has all capability flags set to true"
    else
        log_fail "Claude missing capabilities: ${failed_caps[*]}"
    fi
else
    log_fail "Failed to load claude provider config"
fi

# ===========================================
# Test 8: Codex capability flags match what the CLI actually supports
# ===========================================
# This test used to assert ALL FOUR flags were false ("degraded"). Two of those
# assertions were already wrong against the shipped config -- PROVIDER_HAS_MCP
# has been true (codex has a real `mcp` subcommand) while the test demanded
# false, so this test and its sibling had been failing rather than guarding.
#
# Each flag below is now pinned to a MEASURED capability of codex-cli 0.144.6,
# not to a blanket "Codex is degraded" assumption:
#   MCP      true  -- `codex mcp` manages external MCP servers.
#   PARALLEL true  -- MEASURED on codex-cli 0.144.6: two concurrent
#                     `codex exec` runs in separate worktrees, both exit 0,
#                     zero rate limiting. Enabled 2026-07-27 once the
#                     user-facing text stopped hardcoding "sequential only"
#                     for every degraded provider. See providers/codex.sh.
#   SUBAGENTS/TASK_TOOL false -- codex has no in-session subagent dispatch.
log_test "Codex capability flags match measured CLI support"
reset_provider_vars
if load_provider_direct "codex"; then
    failed_caps=()
    [ "$PROVIDER_HAS_SUBAGENTS" != "false" ] && failed_caps+=("PROVIDER_HAS_SUBAGENTS should be false")
    [ "$PROVIDER_HAS_PARALLEL" != "true" ] && failed_caps+=("PROVIDER_HAS_PARALLEL should be true (measured on 0.144.6)")
    [ "$PROVIDER_HAS_TASK_TOOL" != "false" ] && failed_caps+=("PROVIDER_HAS_TASK_TOOL should be false")
    [ "$PROVIDER_HAS_MCP" != "true" ] && failed_caps+=("PROVIDER_HAS_MCP should be true (codex mcp exists)")

    if [ ${#failed_caps[@]} -eq 0 ]; then
        log_pass "Codex capability flags match measured CLI support"
    else
        log_fail "Codex capability mismatch: ${failed_caps[*]}"
    fi
else
    log_fail "Failed to load codex provider config"
fi

# ===========================================
# Test 8b: Codex pins NO model by default
# ===========================================
# Regression guard for a shipped breakage: CODEX_DEFAULT_MODEL was
# "gpt-5.3-codex", which codex-cli 0.144.6 REJECTS on a ChatGPT account
# ("The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT
# account"). Since Codex ships free with every ChatGPT plan, that pin broke the
# only zero-cost on-ramp in the category. The default must stay EMPTY so no
# --model flag is passed and codex resolves its own account-appropriate model.
log_test "Codex pins no model by default (ChatGPT-account safe)"
reset_provider_vars
if load_provider_direct "codex"; then
    if [ -z "${PROVIDER_MODEL_DEVELOPMENT:-}" ]; then
        log_pass "Codex resolves no default model (no --model is passed)"
    else
        log_fail "Codex pinned a default model: '$PROVIDER_MODEL_DEVELOPMENT' (a hardcoded name breaks ChatGPT accounts)"
    fi
else
    log_fail "Failed to load codex provider config"
fi

# Test 9: Gemini removed in v7.5.18 -- skipped.

# ===========================================
# Test 10: Claude PROVIDER_MAX_PARALLEL is 10
# ===========================================
log_test "Claude PROVIDER_MAX_PARALLEL is 10"
reset_provider_vars
if load_provider_direct "claude"; then
    if [ "$PROVIDER_MAX_PARALLEL" -eq 10 ]; then
        log_pass "Claude PROVIDER_MAX_PARALLEL is 10 (full parallelization)"
    else
        log_fail "Claude PROVIDER_MAX_PARALLEL should be 10 (got: $PROVIDER_MAX_PARALLEL)"
    fi
else
    log_fail "Failed to load claude provider config"
fi

# ===========================================
# Test 11: Codex PROVIDER_MAX_PARALLEL is 2 (measured, deliberately conservative)
# ===========================================
# 2 is the number that was actually verified (two concurrent `codex exec` runs
# in separate worktrees, both exit 0, zero rate limiting). It is NOT the Claude
# value of 10 on purpose: Codex's free ChatGPT tier is the audience that matters
# here, and its rate limits bite long before process concurrency does. Raising
# this pins a number nobody measured, which is the same mistake as the
# gpt-5.3-codex model pin.
log_test "Codex PROVIDER_MAX_PARALLEL is 2"
reset_provider_vars
if load_provider_direct "codex"; then
    if [ "$PROVIDER_MAX_PARALLEL" -eq 2 ]; then
        log_pass "Codex PROVIDER_MAX_PARALLEL is 2 (measured, conservative)"
    else
        log_fail "Codex PROVIDER_MAX_PARALLEL should be 2 (got: $PROVIDER_MAX_PARALLEL)"
    fi
else
    log_fail "Failed to load codex provider config"
fi

# Test 12: Gemini removed in v7.5.18 -- skipped.

# ===========================================
# Test 13: Degraded providers are missing AT LEAST ONE capability
# ===========================================
# SEMANTICS CHANGED 2026-07-27. This used to require that a degraded provider
# have ALL FOUR capabilities off, which conflated "degraded" with "can do
# nothing". That conflation was wrong and it had a cost: Codex demonstrably
# supports concurrent worktree sessions on codex-cli 0.144.6 (two concurrent
# `codex exec` runs, both exit 0, zero rate limiting), yet the invariant forced
# PROVIDER_HAS_PARALLEL=false, and Codex is the only zero-cost on-ramp in the
# category -- so the false flag was a direct adoption ceiling.
#
# "Degraded" now means what the word should mean: at least one capability is
# missing relative to a Tier-1 provider. The per-capability flags carry the
# specific truth, and run.sh reads THOSE for its user-facing warning rather
# than assuming a fixed pair.
log_test "Degraded providers are missing at least one capability"
for provider in codex aider; do
    reset_provider_vars
    if load_provider_direct "$provider"; then
        if [ "$PROVIDER_DEGRADED" = "true" ]; then
            # At least one capability must actually be missing, or the provider
            # is mislabelled as degraded.
            missing=0
            [ "$PROVIDER_HAS_SUBAGENTS" != "true" ] && missing=$((missing + 1))
            [ "$PROVIDER_HAS_PARALLEL" != "true" ] && missing=$((missing + 1))
            [ "$PROVIDER_HAS_TASK_TOOL" != "true" ] && missing=$((missing + 1))
            [ "$PROVIDER_HAS_MCP" != "true" ] && missing=$((missing + 1))
            if [ "$missing" -eq 0 ]; then
                log_fail "$provider is flagged degraded but no capability is missing"
            fi

            # A provider that CAN run parallel sessions must not advertise a
            # max of 1, and one that cannot must not advertise more.
            if [ "$PROVIDER_HAS_PARALLEL" = "true" ] && [ "$PROVIDER_MAX_PARALLEL" -lt 2 ]; then
                log_fail "$provider claims parallel support but MAX_PARALLEL=$PROVIDER_MAX_PARALLEL"
            fi
            if [ "$PROVIDER_HAS_PARALLEL" != "true" ] && [ "$PROVIDER_MAX_PARALLEL" -gt 1 ]; then
                log_fail "$provider has no parallel support but MAX_PARALLEL=$PROVIDER_MAX_PARALLEL"
            fi
        fi
    fi
done
log_pass "Degraded providers are missing at least one capability"

# ===========================================
# Test 14: Non-degraded provider has consistent capability flags
# ===========================================
log_test "Non-degraded provider (Claude) has consistent capability flags"
reset_provider_vars
if load_provider_direct "claude"; then
    inconsistent=false

    # If PROVIDER_DEGRADED is false, capabilities should be enabled
    if [ "$PROVIDER_DEGRADED" = "false" ]; then
        [ "$PROVIDER_HAS_SUBAGENTS" = "false" ] && inconsistent=true
        [ "$PROVIDER_HAS_PARALLEL" = "false" ] && inconsistent=true
        [ "$PROVIDER_HAS_TASK_TOOL" = "false" ] && inconsistent=true
        [ "$PROVIDER_MAX_PARALLEL" -eq 1 ] && inconsistent=true
    fi

    if [ "$inconsistent" = "true" ]; then
        log_fail "Claude has inconsistent non-degraded mode flags"
    else
        log_pass "Claude has consistent non-degraded capability flags"
    fi
else
    log_fail "Failed to load claude provider config"
fi

# ===========================================
# Test 15: Degraded reasons include Task tool limitation
# ===========================================
log_test "Degraded reasons include Task tool limitation"
for provider in codex aider; do
    reset_provider_vars
    if load_provider_direct "$provider"; then
        found_task_reason=false
        for reason in "${PROVIDER_DEGRADED_REASONS[@]}"; do
            if [[ "$reason" == *"Task tool"* ]] || [[ "$reason" == *"subagent"* ]]; then
                found_task_reason=true
                break
            fi
        done
        if [ "$found_task_reason" = "false" ]; then
            log_fail "$provider PROVIDER_DEGRADED_REASONS should mention Task tool or subagent limitation"
        fi
    fi
done
log_pass "All degraded providers document Task tool/subagent limitations"

# ===========================================
# Test 16: Degraded reasons include parallelization limitation
# ===========================================
log_test "Degraded reasons include parallelization limitation"
for provider in codex aider; do
    reset_provider_vars
    if load_provider_direct "$provider"; then
        found_parallel_reason=false
        for reason in "${PROVIDER_DEGRADED_REASONS[@]}"; do
            if [[ "$reason" == *"parallel"* ]] || [[ "$reason" == *"cheap tier"* ]]; then
                found_parallel_reason=true
                break
            fi
        done
        if [ "$found_parallel_reason" = "false" ]; then
            log_fail "$provider PROVIDER_DEGRADED_REASONS should mention parallelization limitation"
        fi
    fi
done
log_pass "All degraded providers document parallelization limitations"

# ===========================================
# Test 17: Providers WITHOUT MCP document that limitation
# ===========================================
# Codex was in this list and should never have been: it sets
# PROVIDER_HAS_MCP=true (it has a real `codex mcp` subcommand), so demanding it
# document an MCP limitation it does not have made this test fail rather than
# guard anything. Drive the check off the CAPABILITY FLAG instead of a
# hardcoded provider list, so it stays correct as providers gain MCP support.
log_test "Providers without MCP document that limitation"
for provider in codex aider; do
    reset_provider_vars
    if load_provider_direct "$provider"; then
        # Only providers that actually lack MCP owe an explanation.
        [ "${PROVIDER_HAS_MCP:-false}" = "true" ] && continue
        found_mcp_reason=false
        for reason in "${PROVIDER_DEGRADED_REASONS[@]}"; do
            if [[ "$reason" == *"MCP"* ]]; then
                found_mcp_reason=true
                break
            fi
        done
        if [ "$found_mcp_reason" = "false" ]; then
            log_fail "$provider lacks MCP but PROVIDER_DEGRADED_REASONS does not mention it"
        fi
    fi
done
log_pass "Providers without MCP document that limitation"

# ===========================================
# Test 18: PROVIDER_TASK_MODEL_PARAM consistency
# ===========================================
log_test "PROVIDER_TASK_MODEL_PARAM consistency with Task tool support"
reset_provider_vars
if load_provider_direct "claude"; then
    if [ -n "$PROVIDER_TASK_MODEL_PARAM" ] && [ "$PROVIDER_HAS_TASK_TOOL" = "true" ]; then
        log_pass "Claude has PROVIDER_TASK_MODEL_PARAM when Task tool is available"
    else
        log_fail "Claude should have PROVIDER_TASK_MODEL_PARAM set when Task tool is available"
    fi
fi

for provider in codex aider; do
    reset_provider_vars
    if load_provider_direct "$provider"; then
        if [ -z "$PROVIDER_TASK_MODEL_PARAM" ] && [ "$PROVIDER_HAS_TASK_TOOL" = "false" ]; then
            # Consistent: no Task tool, no model param
            :
        else
            log_fail "$provider PROVIDER_TASK_MODEL_PARAM should be empty when Task tool is unavailable"
        fi
    fi
done
log_pass "PROVIDER_TASK_MODEL_PARAM is consistent with Task tool availability"

echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
