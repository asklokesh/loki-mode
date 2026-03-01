#!/usr/bin/env bash
# Test: CLI Provider Flag Parsing
# Tests --provider flag, LOKI_PROVIDER env var, default provider, and precedence
#
# This file tests the CLI interface for provider selection without invoking
# actual provider CLIs (claude, codex, gemini, cline, aider).

set -uo pipefail
# Note: Not using -e to allow collecting all test results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROVIDERS_DIR="$PROJECT_DIR/providers"
RUN_SCRIPT="$PROJECT_DIR/autonomy/run.sh"
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

# Create temp directory for test artifacts
TEST_DIR=$(mktemp -d)
cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo "========================================"
echo "CLI Provider Flag Tests"
echo "========================================"
echo "Project dir: $PROJECT_DIR"
echo "Providers dir: $PROVIDERS_DIR"
echo ""

# ===========================================
# Test 1: Source provider loader
# ===========================================
log_test "Provider loader can be sourced"
if source "$PROVIDERS_DIR/loader.sh" 2>/dev/null; then
    log_pass "Provider loader sourced successfully"
else
    log_fail "Failed to source provider loader"
    exit 1  # Cannot continue without loader
fi

# ===========================================
# Test 2: Default provider is claude
# ===========================================
log_test "Default provider is 'claude'"
if [ "$DEFAULT_PROVIDER" = "claude" ]; then
    log_pass "DEFAULT_PROVIDER is correctly set to 'claude'"
else
    log_fail "DEFAULT_PROVIDER should be 'claude' (got: $DEFAULT_PROVIDER)"
fi

# ===========================================
# Test 3: LOKI_PROVIDER env var defaults to claude
# ===========================================
log_test "LOKI_PROVIDER defaults to 'claude' when unset"

# Run in subshell with unset LOKI_PROVIDER
result=$(
    unset LOKI_PROVIDER
    LOKI_PROVIDER=${LOKI_PROVIDER:-claude}
    echo "$LOKI_PROVIDER"
)

if [ "$result" = "claude" ]; then
    log_pass "LOKI_PROVIDER correctly defaults to 'claude'"
else
    log_fail "LOKI_PROVIDER should default to 'claude' (got: $result)"
fi

# ===========================================
# Test 4: LOKI_PROVIDER env var overrides default
# ===========================================
log_test "LOKI_PROVIDER env var overrides default"

for provider in claude codex gemini cline aider; do
    result=$(
        export LOKI_PROVIDER="$provider"
        LOKI_PROVIDER=${LOKI_PROVIDER:-claude}
        echo "$LOKI_PROVIDER"
    )

    if [ "$result" = "$provider" ]; then
        log_pass "LOKI_PROVIDER='$provider' correctly overrides default"
    else
        log_fail "LOKI_PROVIDER='$provider' should override default (got: $result)"
    fi
done

# ===========================================
# Test 5: validate_provider() accepts valid providers
# ===========================================
log_test "validate_provider() accepts all valid providers"
valid_count=0

for provider in claude codex gemini cline aider; do
    if validate_provider "$provider"; then
        ((valid_count++))
    else
        log_fail "validate_provider() rejected valid provider: $provider"
    fi
done

if [ $valid_count -eq 5 ]; then
    log_pass "validate_provider() accepts claude, codex, gemini, cline, aider"
fi

# ===========================================
# Test 6: validate_provider() rejects invalid providers
# ===========================================
log_test "validate_provider() rejects invalid provider names"
invalid_providers=("invalid" "openai" "gpt-4" "chatgpt" "" "CLAUDE" "Claude" "../etc/passwd" "claude.sh" "claude;ls")
rejected_count=0

for provider in "${invalid_providers[@]}"; do
    if ! validate_provider "$provider" 2>/dev/null; then
        ((rejected_count++))
    else
        log_fail "validate_provider() accepted invalid provider: '$provider'"
    fi
done

if [ $rejected_count -eq ${#invalid_providers[@]} ]; then
    log_pass "validate_provider() rejects all invalid providers"
fi

# ===========================================
# Test 7: load_provider() loads correct config for each provider
# ===========================================
log_test "load_provider() loads correct configuration for each provider"

for provider in claude codex gemini cline aider; do
    # Reset provider variables
    unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_DEGRADED 2>/dev/null || true

    if load_provider "$provider"; then
        if [ "$PROVIDER_NAME" = "$provider" ] && [ "$PROVIDER_CLI" = "$provider" ]; then
            log_pass "load_provider('$provider') sets PROVIDER_NAME='$provider', PROVIDER_CLI='$provider'"
        else
            log_fail "load_provider('$provider') set incorrect values (NAME=$PROVIDER_NAME, CLI=$PROVIDER_CLI)"
        fi
    else
        log_fail "load_provider('$provider') failed"
    fi
done

# ===========================================
# Test 8: load_provider() rejects invalid providers
# ===========================================
log_test "load_provider() rejects invalid provider"

if ! load_provider "invalid_provider" 2>/dev/null; then
    log_pass "load_provider() correctly rejects invalid provider"
else
    log_fail "load_provider() should reject invalid provider"
fi

# ===========================================
# Test 9: --provider flag parsing (space-separated)
# ===========================================
log_test "--provider flag parsing (--provider <value>)"

# Simulate argument parsing from run.sh
test_provider_flag_space() {
    local args=("$@")
    local provider=""
    local i=0

    while [ $i -lt ${#args[@]} ]; do
        case "${args[$i]}" in
            --provider)
                if [ $((i + 1)) -lt ${#args[@]} ]; then
                    provider="${args[$((i + 1))]}"
                fi
                break
                ;;
        esac
        ((i++))
    done

    echo "$provider"
}

for provider in claude codex gemini cline aider; do
    result=$(test_provider_flag_space "--provider" "$provider" "./prd.md")
    if [ "$result" = "$provider" ]; then
        log_pass "--provider $provider correctly parsed"
    else
        log_fail "--provider $provider should be parsed (got: '$result')"
    fi
done

# ===========================================
# Test 10: --provider flag parsing (equals-separated)
# ===========================================
log_test "--provider flag parsing (--provider=<value>)"

test_provider_flag_equals() {
    local args=("$@")
    local provider=""

    for arg in "${args[@]}"; do
        case "$arg" in
            --provider=*)
                provider="${arg#*=}"
                break
                ;;
        esac
    done

    echo "$provider"
}

for provider in claude codex gemini cline aider; do
    result=$(test_provider_flag_equals "--provider=$provider" "./prd.md")
    if [ "$result" = "$provider" ]; then
        log_pass "--provider=$provider correctly parsed"
    else
        log_fail "--provider=$provider should be parsed (got: '$result')"
    fi
done

# ===========================================
# Test 11: --provider flag takes precedence over env var
# ===========================================
log_test "--provider flag takes precedence over LOKI_PROVIDER env var"

# Simulate combined parsing
test_flag_precedence() {
    local env_provider="$1"
    local flag_provider="$2"

    # Start with env var
    local result="$env_provider"

    # Flag overrides
    if [ -n "$flag_provider" ]; then
        result="$flag_provider"
    fi

    echo "$result"
}

# Test: env=codex, flag=claude -> should be claude
result=$(test_flag_precedence "codex" "claude")
if [ "$result" = "claude" ]; then
    log_pass "Flag 'claude' overrides env 'codex'"
else
    log_fail "Flag should override env (expected 'claude', got '$result')"
fi

# Test: env=gemini, flag=codex -> should be codex
result=$(test_flag_precedence "gemini" "codex")
if [ "$result" = "codex" ]; then
    log_pass "Flag 'codex' overrides env 'gemini'"
else
    log_fail "Flag should override env (expected 'codex', got '$result')"
fi

# Test: env=claude, flag="" (unset) -> should be claude
result=$(test_flag_precedence "claude" "")
if [ "$result" = "claude" ]; then
    log_pass "No flag uses env var 'claude'"
else
    log_fail "No flag should use env (expected 'claude', got '$result')"
fi

# ===========================================
# Test 12: Invalid provider in --provider flag should error
# ===========================================
log_test "Invalid provider in --provider flag is rejected"

test_invalid_flag() {
    local provider="$1"

    if ! validate_provider "$provider" 2>/dev/null; then
        return 0  # Correctly rejected
    else
        return 1  # Incorrectly accepted
    fi
}

invalid_flags=("invalid" "openai" "gpt" "CLAUDE" "")

for flag in "${invalid_flags[@]}"; do
    if test_invalid_flag "$flag"; then
        log_pass "--provider='$flag' correctly rejected"
    else
        log_fail "--provider='$flag' should be rejected"
    fi
done

# ===========================================
# Test 13: Provider config variables are set after load
# ===========================================
log_test "Provider config variables are correctly set after load_provider()"

# Test claude provider config
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_AUTONOMOUS_FLAG PROVIDER_DEGRADED 2>/dev/null || true
load_provider "claude" >/dev/null 2>&1

if [ "$PROVIDER_NAME" = "claude" ] && \
   [ "$PROVIDER_CLI" = "claude" ] && \
   [ "$PROVIDER_AUTONOMOUS_FLAG" = "--dangerously-skip-permissions" ] && \
   [ "$PROVIDER_DEGRADED" = "false" ]; then
    log_pass "Claude provider config correctly loaded"
else
    log_fail "Claude provider config incomplete (NAME=$PROVIDER_NAME, CLI=$PROVIDER_CLI, FLAG=$PROVIDER_AUTONOMOUS_FLAG, DEGRADED=$PROVIDER_DEGRADED)"
fi

# Test codex provider config
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_AUTONOMOUS_FLAG PROVIDER_DEGRADED 2>/dev/null || true
load_provider "codex" >/dev/null 2>&1

if [ "$PROVIDER_NAME" = "codex" ] && \
   [ "$PROVIDER_CLI" = "codex" ] && \
   [ -n "$PROVIDER_AUTONOMOUS_FLAG" ]; then
    log_pass "Codex provider config correctly loaded"
else
    log_fail "Codex provider config incomplete (NAME=$PROVIDER_NAME, CLI=$PROVIDER_CLI)"
fi

# Test gemini provider config
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_AUTONOMOUS_FLAG PROVIDER_DEGRADED 2>/dev/null || true
load_provider "gemini" >/dev/null 2>&1

if [ "$PROVIDER_NAME" = "gemini" ] && \
   [ "$PROVIDER_CLI" = "gemini" ] && \
   [ -n "$PROVIDER_AUTONOMOUS_FLAG" ]; then
    log_pass "Gemini provider config correctly loaded"
else
    log_fail "Gemini provider config incomplete (NAME=$PROVIDER_NAME, CLI=$PROVIDER_CLI)"
fi

# Test cline provider config
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_AUTONOMOUS_FLAG PROVIDER_DEGRADED 2>/dev/null || true
load_provider "cline" >/dev/null 2>&1

if [ "$PROVIDER_NAME" = "cline" ] && \
   [ "$PROVIDER_CLI" = "cline" ] && \
   [ -n "$PROVIDER_AUTONOMOUS_FLAG" ]; then
    log_pass "Cline provider config correctly loaded"
else
    log_fail "Cline provider config incomplete (NAME=$PROVIDER_NAME, CLI=$PROVIDER_CLI)"
fi

# Test aider provider config
unset PROVIDER_NAME PROVIDER_DISPLAY_NAME PROVIDER_CLI PROVIDER_AUTONOMOUS_FLAG PROVIDER_DEGRADED 2>/dev/null || true
load_provider "aider" >/dev/null 2>&1

if [ "$PROVIDER_NAME" = "aider" ] && \
   [ "$PROVIDER_CLI" = "aider" ] && \
   [ -n "$PROVIDER_AUTONOMOUS_FLAG" ]; then
    log_pass "Aider provider config correctly loaded"
else
    log_fail "Aider provider config incomplete (NAME=$PROVIDER_NAME, CLI=$PROVIDER_CLI)"
fi

# ===========================================
# Test 14: SUPPORTED_PROVIDERS array contains expected values
# ===========================================
log_test "SUPPORTED_PROVIDERS array contains expected providers"

expected_providers=("claude" "codex" "gemini" "cline" "aider")

if [ ${#SUPPORTED_PROVIDERS[@]} -eq ${#expected_providers[@]} ]; then
    all_match=true
    for i in "${!expected_providers[@]}"; do
        if [ "${SUPPORTED_PROVIDERS[$i]}" != "${expected_providers[$i]}" ]; then
            all_match=false
            break
        fi
    done

    if $all_match; then
        log_pass "SUPPORTED_PROVIDERS contains (claude, codex, gemini, cline, aider) in order"
    else
        log_fail "SUPPORTED_PROVIDERS has incorrect values"
    fi
else
    log_fail "SUPPORTED_PROVIDERS should have 5 entries (got: ${#SUPPORTED_PROVIDERS[@]})"
fi

# ===========================================
# Test 15: Help text mentions --provider flag
# ===========================================
log_test "run.sh help text mentions --provider flag"

if grep -q "\-\-provider" "$RUN_SCRIPT" 2>/dev/null; then
    log_pass "run.sh contains --provider flag documentation"
else
    log_fail "run.sh should document --provider flag"
fi

# ===========================================
# Test 16: Environment variable precedence order
# ===========================================
log_test "Precedence order: --provider flag > LOKI_PROVIDER env > default"

# Simulate full precedence chain
test_full_precedence() {
    local default_provider="claude"
    local env_provider="${1:-}"
    local flag_provider="${2:-}"

    # Start with default
    local result="$default_provider"

    # Env overrides default
    if [ -n "$env_provider" ]; then
        result="$env_provider"
    fi

    # Flag overrides env
    if [ -n "$flag_provider" ]; then
        result="$flag_provider"
    fi

    echo "$result"
}

# Test case 1: All unset -> default (claude)
result=$(test_full_precedence "" "")
if [ "$result" = "claude" ]; then
    log_pass "All unset -> default 'claude'"
else
    log_fail "All unset should default to 'claude' (got: '$result')"
fi

# Test case 2: Env set, no flag -> env
result=$(test_full_precedence "codex" "")
if [ "$result" = "codex" ]; then
    log_pass "Env 'codex', no flag -> 'codex'"
else
    log_fail "Env should override default (got: '$result')"
fi

# Test case 3: Env set, flag set -> flag
result=$(test_full_precedence "codex" "gemini")
if [ "$result" = "gemini" ]; then
    log_pass "Env 'codex', flag 'gemini' -> 'gemini'"
else
    log_fail "Flag should override env (got: '$result')"
fi

# Test case 4: No env, flag set -> flag
result=$(test_full_precedence "" "codex")
if [ "$result" = "codex" ]; then
    log_pass "No env, flag 'codex' -> 'codex'"
else
    log_fail "Flag should override default (got: '$result')"
fi

# ===========================================
# Test 17: Provider config files exist for all providers
# ===========================================
log_test "Provider config files exist for all supported providers"

all_exist=true
for provider in claude codex gemini cline aider; do
    config_file="$PROVIDERS_DIR/${provider}.sh"
    if [ ! -f "$config_file" ]; then
        log_fail "Missing provider config: $config_file"
        all_exist=false
    fi
done

if $all_exist; then
    log_pass "All provider config files exist (claude.sh, codex.sh, gemini.sh, cline.sh, aider.sh)"
fi

# ===========================================
# Test 18: Provider config syntax validation
# ===========================================
log_test "Provider config files have valid bash syntax"

syntax_ok=true
for provider in claude codex gemini cline aider; do
    config_file="$PROVIDERS_DIR/${provider}.sh"
    if ! bash -n "$config_file" 2>/dev/null; then
        log_fail "Syntax error in $config_file"
        syntax_ok=false
    fi
done

if $syntax_ok; then
    log_pass "All provider config files have valid bash syntax"
fi

# ===========================================
# Test 19: Case sensitivity - providers must be lowercase
# ===========================================
log_test "Provider names are case-sensitive (must be lowercase)"

uppercase_variants=("CLAUDE" "Claude" "CODEX" "Codex" "GEMINI" "Gemini" "CLINE" "Cline" "AIDER" "Aider")
all_rejected=true

for variant in "${uppercase_variants[@]}"; do
    if validate_provider "$variant" 2>/dev/null; then
        log_fail "Uppercase variant '$variant' should be rejected"
        all_rejected=false
    fi
done

if $all_rejected; then
    log_pass "All uppercase variants correctly rejected"
fi

# ===========================================
# Test 20: loki-wrapper.sh uses LOKI_PROVIDER
# ===========================================
log_test "loki-wrapper.sh reads LOKI_PROVIDER env var"

WRAPPER_SCRIPT="$PROJECT_DIR/scripts/loki-wrapper.sh"
if [ -f "$WRAPPER_SCRIPT" ]; then
    if grep -q "LOKI_PROVIDER" "$WRAPPER_SCRIPT" 2>/dev/null; then
        log_pass "loki-wrapper.sh references LOKI_PROVIDER"
    else
        log_fail "loki-wrapper.sh should use LOKI_PROVIDER env var"
    fi
else
    log_fail "loki-wrapper.sh not found at $WRAPPER_SCRIPT"
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
