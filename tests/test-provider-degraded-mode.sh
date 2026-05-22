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
# Test 8: Codex has limited capability flags (all false)
# ===========================================
log_test "Codex has limited capability flags"
reset_provider_vars
if load_provider_direct "codex"; then
    failed_caps=()
    [ "$PROVIDER_HAS_SUBAGENTS" != "false" ] && failed_caps+=("PROVIDER_HAS_SUBAGENTS should be false")
    [ "$PROVIDER_HAS_PARALLEL" != "false" ] && failed_caps+=("PROVIDER_HAS_PARALLEL should be false")
    [ "$PROVIDER_HAS_TASK_TOOL" != "false" ] && failed_caps+=("PROVIDER_HAS_TASK_TOOL should be false")
    [ "$PROVIDER_HAS_MCP" != "false" ] && failed_caps+=("PROVIDER_HAS_MCP should be false")

    if [ ${#failed_caps[@]} -eq 0 ]; then
        log_pass "Codex has all capability flags set to false (degraded)"
    else
        log_fail "Codex capability mismatch: ${failed_caps[*]}"
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
# Test 11: Codex PROVIDER_MAX_PARALLEL is 1
# ===========================================
log_test "Codex PROVIDER_MAX_PARALLEL is 1"
reset_provider_vars
if load_provider_direct "codex"; then
    if [ "$PROVIDER_MAX_PARALLEL" -eq 1 ]; then
        log_pass "Codex PROVIDER_MAX_PARALLEL is 1 (sequential only)"
    else
        log_fail "Codex PROVIDER_MAX_PARALLEL should be 1 (got: $PROVIDER_MAX_PARALLEL)"
    fi
else
    log_fail "Failed to load codex provider config"
fi

# Test 12: Gemini removed in v7.5.18 -- skipped.

# ===========================================
# Test 13: Degraded providers have consistent limitation flags
# ===========================================
log_test "Degraded providers have consistent limitation flags"
for provider in codex aider; do
    reset_provider_vars
    if load_provider_direct "$provider"; then
        inconsistent=false

        # If PROVIDER_DEGRADED is true, all these should be false/1
        if [ "$PROVIDER_DEGRADED" = "true" ]; then
            [ "$PROVIDER_HAS_SUBAGENTS" = "true" ] && inconsistent=true
            [ "$PROVIDER_HAS_PARALLEL" = "true" ] && inconsistent=true
            [ "$PROVIDER_HAS_TASK_TOOL" = "true" ] && inconsistent=true
            [ "$PROVIDER_MAX_PARALLEL" -gt 1 ] && inconsistent=true
        fi

        if [ "$inconsistent" = "true" ]; then
            log_fail "$provider has inconsistent degraded mode flags"
        fi
    fi
done
log_pass "All degraded providers have consistent limitation flags"

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
# Test 17: Degraded reasons include MCP limitation
# ===========================================
log_test "Degraded reasons include MCP limitation"
for provider in codex aider; do
    reset_provider_vars
    if load_provider_direct "$provider"; then
        found_mcp_reason=false
        for reason in "${PROVIDER_DEGRADED_REASONS[@]}"; do
            if [[ "$reason" == *"MCP"* ]]; then
                found_mcp_reason=true
                break
            fi
        done
        if [ "$found_mcp_reason" = "false" ]; then
            log_fail "$provider PROVIDER_DEGRADED_REASONS should mention MCP limitation"
        fi
    fi
done
log_pass "All degraded providers document MCP limitations"

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
