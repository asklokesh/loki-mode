#!/usr/bin/env bash
#===============================================================================
# Loki Mode - Cross-Provider Auto-Failover Tests (v6.19.0)
#
# Tests failover JSON state, chain configuration, health checks,
# provider switching on rate limit, and primary recovery.
#===============================================================================

set -uo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
# shellcheck disable=SC2034
YELLOW='\033[1;33m'
# shellcheck disable=SC2034
BOLD='\033[1m'
NC='\033[0m'

# Counters
PASS=0
FAIL=0
TOTAL=0

# Test directory
TEST_DIR=$(mktemp -d /tmp/loki-test-failover-XXXXXX)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log_test() {
    ((TOTAL++))
    echo -e "${BOLD}[$TOTAL] $1${NC}"
}

log_pass() {
    ((PASS++))
    echo -e "  ${GREEN}PASS${NC}: $1"
}

log_fail() {
    ((FAIL++))
    echo -e "  ${RED}FAIL${NC}: $1"
}

cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# Setup: create minimal .loki structure
setup_test_env() {
    rm -rf "$TEST_DIR/.loki"
    mkdir -p "$TEST_DIR/.loki/state"
    mkdir -p "$TEST_DIR/.loki/logs"
    export TARGET_DIR="$TEST_DIR"
}

# Source run.sh functions (only the failover section)
# We need to source carefully since run.sh has many dependencies
source_failover_functions() {
    # Define minimal stubs for functions used by failover
    log_info() { echo "[INFO] $*"; }
    log_warn() { echo "[WARN] $*"; }
    log_debug() { :; }
    log_error() { echo "[ERROR] $*"; }
    emit_event_json() { :; }
    # shellcheck disable=SC2034
    ITERATION_COUNT=1
    PROVIDER_NAME="claude"

    # Source only the failover functions by extracting them
    local tmp_source="$TEST_DIR/failover_funcs.sh"
    sed -n '/^# Cross-Provider Auto-Failover/,/^# Rate Limit Detection$/p' \
        "$SCRIPT_DIR/autonomy/run.sh" | grep -v '^# Rate Limit Detection$' | \
        grep -v '^#====.*$' > "$tmp_source" || true
    # Re-add the closing context (the sed removes everything after the marker)
    source "$tmp_source"
}

echo -e "${BOLD}Loki Mode - Cross-Provider Auto-Failover Tests${NC}"
echo "================================================================"
echo ""

# Source the functions
setup_test_env
source_failover_functions

#-----------------------------------------------------------------------
# Test 1: Failover JSON creation
#-----------------------------------------------------------------------
log_test "init_failover_state creates failover.json when enabled"

setup_test_env
source_failover_functions
LOKI_FAILOVER="true"
PROVIDER_NAME="claude"
init_failover_state

if [ -f "$TEST_DIR/.loki/state/failover.json" ]; then
    log_pass "failover.json created"
else
    log_fail "failover.json not created"
fi

#-----------------------------------------------------------------------
# Test 2: Failover JSON has correct structure
#-----------------------------------------------------------------------
log_test "failover.json has correct fields"

if python3 -c "
import json, sys
with open('$TEST_DIR/.loki/state/failover.json') as f:
    d = json.load(f)
assert d['enabled'] == True, 'enabled should be True'
assert isinstance(d['chain'], list), 'chain should be a list'
assert d['currentProvider'] == 'claude', 'currentProvider should be claude'
assert d['primaryProvider'] == 'claude', 'primaryProvider should be claude'
assert d['lastFailover'] is None, 'lastFailover should be null'
assert 'healthCheck' in d, 'healthCheck should exist'
print('All fields valid')
" 2>/dev/null; then
    log_pass "JSON structure is correct"
else
    log_fail "JSON structure is incorrect"
fi

#-----------------------------------------------------------------------
# Test 3: init_failover_state skips when disabled
#-----------------------------------------------------------------------
log_test "init_failover_state skips when LOKI_FAILOVER is not true"

setup_test_env
source_failover_functions
LOKI_FAILOVER="false"
init_failover_state

if [ ! -f "$TEST_DIR/.loki/state/failover.json" ]; then
    log_pass "failover.json not created when disabled"
else
    log_fail "failover.json should not be created when disabled"
fi

#-----------------------------------------------------------------------
# Test 4: Chain configuration via LOKI_FAILOVER_CHAIN
#-----------------------------------------------------------------------
log_test "Custom failover chain via LOKI_FAILOVER_CHAIN"

setup_test_env
source_failover_functions
LOKI_FAILOVER="true"
# shellcheck disable=SC2034
# v7.5.18: gemini removed; use aider,claude,codex chain instead.
LOKI_FAILOVER_CHAIN="aider,claude,codex"
PROVIDER_NAME="aider"
init_failover_state

local_chain=$(python3 -c "
import json
with open('$TEST_DIR/.loki/state/failover.json') as f:
    d = json.load(f)
print(','.join(d['chain']))
" 2>/dev/null)

if [ "$local_chain" = "aider,claude,codex" ]; then
    log_pass "Custom chain set correctly: $local_chain"
else
    log_fail "Expected 'aider,claude,codex', got '$local_chain'"
fi
unset LOKI_FAILOVER_CHAIN

#-----------------------------------------------------------------------
# Test 5: read_failover_config reads state correctly
#-----------------------------------------------------------------------
log_test "read_failover_config reads state correctly"

setup_test_env
source_failover_functions
LOKI_FAILOVER="true"
PROVIDER_NAME="claude"
init_failover_state

read_failover_config

if [ "$FAILOVER_ENABLED" = "true" ] && [ "$FAILOVER_CURRENT" = "claude" ] && [ "$FAILOVER_PRIMARY" = "claude" ]; then
    log_pass "Config read correctly: enabled=$FAILOVER_ENABLED, current=$FAILOVER_CURRENT, primary=$FAILOVER_PRIMARY"
else
    log_fail "Config incorrect: enabled=$FAILOVER_ENABLED, current=${FAILOVER_CURRENT:-unset}, primary=${FAILOVER_PRIMARY:-unset}"
fi

#-----------------------------------------------------------------------
# Test 6: read_failover_config returns error when no file
#-----------------------------------------------------------------------
log_test "read_failover_config returns error when file missing"

setup_test_env
source_failover_functions
rm -f "$TEST_DIR/.loki/state/failover.json"

if ! read_failover_config 2>/dev/null; then
    log_pass "Returns error when file missing"
else
    log_fail "Should return error when file missing"
fi

#-----------------------------------------------------------------------
# Test 7: update_failover_state modifies values
#-----------------------------------------------------------------------
log_test "update_failover_state modifies values correctly"

setup_test_env
source_failover_functions
LOKI_FAILOVER="true"
PROVIDER_NAME="claude"
init_failover_state

update_failover_state "currentProvider" "codex"

local_current=$(python3 -c "
import json
with open('$TEST_DIR/.loki/state/failover.json') as f:
    d = json.load(f)
print(d['currentProvider'])
" 2>/dev/null)

if [ "$local_current" = "codex" ]; then
    log_pass "State updated: currentProvider=codex"
else
    log_fail "Expected 'codex', got '$local_current'"
fi

#-----------------------------------------------------------------------
# Test 8: update_failover_health sets provider health
#-----------------------------------------------------------------------
log_test "update_failover_health sets provider health status"

setup_test_env
source_failover_functions
LOKI_FAILOVER="true"
PROVIDER_NAME="claude"
init_failover_state

update_failover_health "claude" "unhealthy"
update_failover_health "codex" "healthy"

health_result=$(python3 -c "
import json
with open('$TEST_DIR/.loki/state/failover.json') as f:
    d = json.load(f)
h = d.get('healthCheck', {})
print(f\"{h.get('claude','?')},{h.get('codex','?')}\")
" 2>/dev/null)

if [ "$health_result" = "unhealthy,healthy" ]; then
    log_pass "Health updated: claude=unhealthy, codex=healthy"
else
    log_fail "Expected 'unhealthy,healthy', got '$health_result'"
fi

#-----------------------------------------------------------------------
# Test 9: check_provider_health detects installed CLIs
#-----------------------------------------------------------------------
log_test "check_provider_health detects CLI availability"

# Claude CLI should be installed on this machine
if command -v claude &>/dev/null && [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    if check_provider_health "claude"; then
        log_pass "claude detected as healthy"
    else
        log_fail "claude should be healthy (CLI installed + key present)"
    fi
elif command -v claude &>/dev/null; then
    # CLI installed but no key - should fail
    if ! check_provider_health "claude"; then
        log_pass "claude correctly unhealthy (no API key)"
    else
        log_fail "claude should be unhealthy without API key"
    fi
else
    log_pass "claude CLI not installed - skipping (expected in CI)"
fi

#-----------------------------------------------------------------------
# Test 10: check_provider_health rejects unknown provider
#-----------------------------------------------------------------------
log_test "check_provider_health rejects unknown provider"

if ! check_provider_health "nonexistent"; then
    log_pass "Unknown provider correctly rejected"
else
    log_fail "Unknown provider should be rejected"
fi

#-----------------------------------------------------------------------
# Test 11: attempt_provider_failover returns error when disabled
#-----------------------------------------------------------------------
log_test "attempt_provider_failover returns error when failover disabled"

setup_test_env
source_failover_functions
# No failover file = disabled

if ! attempt_provider_failover 2>/dev/null; then
    log_pass "Failover correctly declined when disabled"
else
    log_fail "Failover should fail when disabled"
fi

#-----------------------------------------------------------------------
# Test 12: check_primary_recovery returns error when already on primary
#-----------------------------------------------------------------------
log_test "check_primary_recovery returns error when already on primary"

setup_test_env
source_failover_functions
LOKI_FAILOVER="true"
PROVIDER_NAME="claude"
init_failover_state

if ! check_primary_recovery 2>/dev/null; then
    log_pass "Correctly no-ops when already on primary"
else
    log_fail "Should return 1 when already on primary"
fi

#-----------------------------------------------------------------------
# Test 13: CLI cmd_failover --help works
#-----------------------------------------------------------------------
log_test "loki failover --help shows usage"

output=$("$SCRIPT_DIR/autonomy/loki" failover --help 2>&1) || true

if echo "$output" | grep -qi "cross-provider"; then
    log_pass "Help text shown"
else
    log_fail "Help text not found in output"
    echo "  Output: ${output:0:200}"
fi

#-----------------------------------------------------------------------
# Test 14: CLI cmd_failover (no args) shows status
#-----------------------------------------------------------------------
log_test "loki failover shows status when no args"

output=$("$SCRIPT_DIR/autonomy/loki" failover 2>&1) || true

if echo "$output" | grep -qi "auto-failover\|status"; then
    log_pass "Status shown"
else
    log_fail "Status not shown"
    echo "  Output: ${output:0:200}"
fi

#-----------------------------------------------------------------------
# Summary
#-----------------------------------------------------------------------
echo ""
echo "================================================================"
echo -e "${BOLD}Results: $PASS passed, $FAIL failed, $TOTAL total${NC}"
echo "================================================================"

if [ "$FAIL" -gt 0 ]; then
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
else
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
