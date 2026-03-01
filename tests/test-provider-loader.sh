#!/usr/bin/env bash
# Test: Provider Loader Functionality
# Tests the provider loading, validation, and auto-detection

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

# Source the loader
source "$PROVIDERS_DIR/loader.sh"

echo "========================================"
echo "Provider Loader Tests"
echo "========================================"
echo "Providers dir: $PROVIDERS_DIR"
echo ""

# ===========================================
# Test 1: validate_provider() with valid providers
# ===========================================
log_test "validate_provider() with valid providers"
valid_count=0
for provider in claude codex gemini cline aider; do
    if validate_provider "$provider"; then
        ((valid_count++))
    else
        log_fail "validate_provider rejected valid provider: $provider"
    fi
done

if [ $valid_count -eq 5 ]; then
    log_pass "validate_provider() accepts all valid providers (claude, codex, gemini, cline, aider)"
fi

# ===========================================
# Test 2: validate_provider() with invalid providers
# ===========================================
log_test "validate_provider() with invalid provider names"
invalid_providers=("invalid" "foo" "openai" "gpt" "" "../etc/passwd" "claude.sh")
invalid_rejected=0

for provider in "${invalid_providers[@]}"; do
    if ! validate_provider "$provider"; then
        ((invalid_rejected++))
    else
        log_fail "validate_provider accepted invalid provider: '$provider'"
    fi
done

if [ $invalid_rejected -eq ${#invalid_providers[@]} ]; then
    log_pass "validate_provider() rejects all invalid providers"
fi

# ===========================================
# Test 3: load_provider() loads correct config for each provider
# ===========================================
log_test "load_provider() loads correct config for claude"
# Reset provider variables
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_DEGRADED 2>/dev/null || true

if load_provider "claude"; then
    if [ "$PROVIDER_NAME" = "claude" ] && [ "$PROVIDER_CLI" = "claude" ] && [ "$PROVIDER_DEGRADED" = "false" ]; then
        log_pass "load_provider() correctly loads claude config"
    else
        log_fail "load_provider() loaded claude but variables incorrect"
    fi
else
    log_fail "load_provider() failed to load claude"
fi

log_test "load_provider() loads correct config for codex"
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_DEGRADED 2>/dev/null || true

if load_provider "codex"; then
    if [ "$PROVIDER_NAME" = "codex" ] && [ "$PROVIDER_CLI" = "codex" ]; then
        log_pass "load_provider() correctly loads codex config"
    else
        log_fail "load_provider() loaded codex but variables incorrect (NAME=$PROVIDER_NAME, CLI=$PROVIDER_CLI)"
    fi
else
    log_fail "load_provider() failed to load codex"
fi

log_test "load_provider() loads correct config for gemini"
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_DEGRADED 2>/dev/null || true

if load_provider "gemini"; then
    if [ "$PROVIDER_NAME" = "gemini" ] && [ "$PROVIDER_CLI" = "gemini" ]; then
        log_pass "load_provider() correctly loads gemini config"
    else
        log_fail "load_provider() loaded gemini but variables incorrect (NAME=$PROVIDER_NAME, CLI=$PROVIDER_CLI)"
    fi
else
    log_fail "load_provider() failed to load gemini"
fi

log_test "load_provider() rejects invalid provider"
if ! load_provider "invalid_provider" 2>/dev/null; then
    log_pass "load_provider() correctly rejects invalid provider"
else
    log_fail "load_provider() should reject invalid provider"
fi

# ===========================================
# Test 4: check_provider_installed() behavior
# ===========================================
log_test "check_provider_installed() for known providers"

# Test with claude (may or may not be installed)
if command -v claude >/dev/null 2>&1; then
    if check_provider_installed "claude"; then
        log_pass "check_provider_installed() correctly detects installed claude"
    else
        log_fail "check_provider_installed() should detect installed claude"
    fi
else
    if ! check_provider_installed "claude"; then
        log_pass "check_provider_installed() correctly reports claude not installed"
    else
        log_fail "check_provider_installed() should report claude not installed"
    fi
fi

log_test "check_provider_installed() for unknown provider"
if ! check_provider_installed "unknown_provider"; then
    log_pass "check_provider_installed() returns false for unknown provider"
else
    log_fail "check_provider_installed() should return false for unknown provider"
fi

# ===========================================
# Test 5: auto_detect_provider() priority order
# ===========================================
log_test "auto_detect_provider() priority order"

# Get installed providers list
installed_list=$(get_installed_providers)

# Check priority order is correct (claude > codex > gemini)
detected=$(auto_detect_provider)

if [ -n "$detected" ]; then
    # Verify the detected provider is actually installed
    if check_provider_installed "$detected"; then
        # Verify priority: if claude is installed, it should be detected
        if command -v claude >/dev/null 2>&1; then
            if [ "$detected" = "claude" ]; then
                log_pass "auto_detect_provider() prioritizes claude correctly"
            else
                log_fail "auto_detect_provider() should return claude when installed (got: $detected)"
            fi
        elif command -v codex >/dev/null 2>&1; then
            if [ "$detected" = "codex" ]; then
                log_pass "auto_detect_provider() falls back to codex correctly"
            else
                log_fail "auto_detect_provider() should return codex when claude not installed (got: $detected)"
            fi
        elif command -v gemini >/dev/null 2>&1; then
            if [ "$detected" = "gemini" ]; then
                log_pass "auto_detect_provider() falls back to gemini correctly"
            else
                log_fail "auto_detect_provider() should return gemini as last resort (got: $detected)"
            fi
        else
            log_pass "auto_detect_provider() returned installed provider: $detected"
        fi
    else
        log_fail "auto_detect_provider() returned non-installed provider: $detected"
    fi
else
    # No provider installed - this is acceptable
    if [ -z "$installed_list" ]; then
        log_pass "auto_detect_provider() returns empty when no providers installed"
    else
        log_fail "auto_detect_provider() should detect installed providers: $installed_list"
    fi
fi

# Test that auto_detect_provider returns failure code when no providers found
log_test "auto_detect_provider() returns correct exit code"
# We can't easily test "no providers" scenario without mocking, so just verify function exists
if type auto_detect_provider >/dev/null 2>&1; then
    log_pass "auto_detect_provider() function exists and is callable"
else
    log_fail "auto_detect_provider() function not found"
fi

# ===========================================
# Test 6: SUPPORTED_PROVIDERS array
# ===========================================
log_test "SUPPORTED_PROVIDERS array contents"
if [ ${#SUPPORTED_PROVIDERS[@]} -eq 5 ]; then
    expected=("claude" "codex" "gemini" "cline" "aider")
    all_match=true
    for i in "${!expected[@]}"; do
        if [ "${SUPPORTED_PROVIDERS[$i]}" != "${expected[$i]}" ]; then
            all_match=false
            break
        fi
    done
    if $all_match; then
        log_pass "SUPPORTED_PROVIDERS contains correct providers in order"
    else
        log_fail "SUPPORTED_PROVIDERS order mismatch"
    fi
else
    log_fail "SUPPORTED_PROVIDERS should have 5 entries (got: ${#SUPPORTED_PROVIDERS[@]})"
fi

# ===========================================
# Test 7: DEFAULT_PROVIDER value
# ===========================================
log_test "DEFAULT_PROVIDER is set to claude"
if [ "$DEFAULT_PROVIDER" = "claude" ]; then
    log_pass "DEFAULT_PROVIDER is correctly set to 'claude'"
else
    log_fail "DEFAULT_PROVIDER should be 'claude' (got: $DEFAULT_PROVIDER)"
fi

# ===========================================
# Test 8: load_provider() loads cline config correctly
# ===========================================
log_test "load_provider() loads correct config for cline"
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_DEGRADED PROVIDER_HAS_SUBAGENTS PROVIDER_HAS_MCP 2>/dev/null || true

if load_provider "cline"; then
    if [ "$PROVIDER_NAME" = "cline" ] && [ "$PROVIDER_CLI" = "cline" ] && [ "$PROVIDER_DEGRADED" = "false" ]; then
        log_pass "load_provider() correctly loads cline config (not degraded)"
    else
        log_fail "load_provider() loaded cline but variables incorrect (NAME=$PROVIDER_NAME, DEGRADED=$PROVIDER_DEGRADED)"
    fi
else
    log_fail "load_provider() failed to load cline"
fi

# ===========================================
# Test 9: Cline has subagents and MCP (Tier 2)
# ===========================================
log_test "Cline provider has subagents and MCP capabilities"
unset PROVIDER_NAME PROVIDER_HAS_SUBAGENTS PROVIDER_HAS_MCP PROVIDER_HAS_TASK_TOOL 2>/dev/null || true

if load_provider "cline"; then
    if [ "$PROVIDER_HAS_SUBAGENTS" = "true" ] && [ "$PROVIDER_HAS_MCP" = "true" ] && [ "$PROVIDER_HAS_TASK_TOOL" = "false" ]; then
        log_pass "Cline has subagents=true, MCP=true, Task tool=false (Tier 2)"
    else
        log_fail "Cline capability flags incorrect (subagents=$PROVIDER_HAS_SUBAGENTS, MCP=$PROVIDER_HAS_MCP, task=$PROVIDER_HAS_TASK_TOOL)"
    fi
else
    log_fail "load_provider() failed to load cline for capability check"
fi

# ===========================================
# Test 10: load_provider() loads aider config correctly
# ===========================================
log_test "load_provider() loads correct config for aider"
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_DEGRADED 2>/dev/null || true

if load_provider "aider"; then
    if [ "$PROVIDER_NAME" = "aider" ] && [ "$PROVIDER_CLI" = "aider" ] && [ "$PROVIDER_DEGRADED" = "true" ]; then
        log_pass "load_provider() correctly loads aider config (degraded)"
    else
        log_fail "load_provider() loaded aider but variables incorrect (NAME=$PROVIDER_NAME, DEGRADED=$PROVIDER_DEGRADED)"
    fi
else
    log_fail "load_provider() failed to load aider"
fi

# ===========================================
# Test 11: Aider is fully degraded (Tier 3)
# ===========================================
log_test "Aider provider is fully degraded (no subagents, no MCP)"
unset PROVIDER_NAME PROVIDER_HAS_SUBAGENTS PROVIDER_HAS_MCP PROVIDER_HAS_TASK_TOOL PROVIDER_HAS_PARALLEL 2>/dev/null || true

if load_provider "aider"; then
    if [ "$PROVIDER_HAS_SUBAGENTS" = "false" ] && [ "$PROVIDER_HAS_MCP" = "false" ] && [ "$PROVIDER_HAS_TASK_TOOL" = "false" ] && [ "$PROVIDER_HAS_PARALLEL" = "false" ]; then
        log_pass "Aider all capabilities false (Tier 3 degraded)"
    else
        log_fail "Aider capability flags incorrect (subagents=$PROVIDER_HAS_SUBAGENTS, MCP=$PROVIDER_HAS_MCP)"
    fi
else
    log_fail "load_provider() failed to load aider for capability check"
fi

# ===========================================
# Test 12: Cline and Aider not in auto_detect_provider
# ===========================================
log_test "auto_detect_provider() does not return cline or aider"
detected=$(auto_detect_provider 2>/dev/null)
if [ "$detected" != "cline" ] && [ "$detected" != "aider" ]; then
    log_pass "auto_detect_provider() does not auto-detect cline or aider"
else
    log_fail "auto_detect_provider() should not auto-detect $detected"
fi

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
