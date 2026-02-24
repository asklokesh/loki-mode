#!/usr/bin/env bash
# Test Loki Mode hooks system

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_DIR=$(mktemp -d)
TESTS_PASSED=0
TESTS_FAILED=0

# Cleanup
cleanup() {
    rm -rf "$TEST_DIR"
    pkill -f "test-hooks-" 2>/dev/null || true
}
trap cleanup EXIT

log_test() { echo "[TEST] $1"; }
pass() { ((TESTS_PASSED++)); echo "[PASS] $1"; }
fail() { ((TESTS_FAILED++)); echo "[FAIL] $1"; }

# Setup test environment
setup() {
    mkdir -p "$TEST_DIR/.loki/hooks" "$TEST_DIR/.loki/state" "$TEST_DIR/.claude"
    cp -r "$PROJECT_ROOT/autonomy/hooks/"*.sh "$TEST_DIR/.loki/hooks/" 2>/dev/null || true
    chmod +x "$TEST_DIR/.loki/hooks/"*.sh 2>/dev/null || true
    cd "$TEST_DIR" || exit 1
}

# Test 1: session-init.sh exists and is executable
test_session_init_exists() {
    log_test "session-init.sh exists and is executable"
    if [ -x "$PROJECT_ROOT/autonomy/hooks/session-init.sh" ]; then
        pass "session-init.sh is executable"
    else
        fail "session-init.sh not found or not executable"
    fi
}

# Test 2: session-init.sh returns valid JSON
test_session_init_json() {
    log_test "session-init.sh returns valid JSON"
    INPUT='{"session_id":"test-123","cwd":"'"$TEST_DIR"'"}'
    OUTPUT=$(echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/session-init.sh" 2>/dev/null)
    if echo "$OUTPUT" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
        pass "session-init.sh returns valid JSON"
    else
        fail "session-init.sh output is not valid JSON: $OUTPUT"
    fi
}

# Test 3: validate-bash.sh blocks dangerous commands
test_validate_bash_blocks_dangerous() {
    log_test "validate-bash.sh blocks dangerous commands"
    INPUT='{"tool_input":{"command":"rm -rf /"},"cwd":"'"$TEST_DIR"'"}'
    OUTPUT=$(echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" 2>/dev/null)
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 2 ] && echo "$OUTPUT" | grep -q '"permissionDecision": "deny"'; then
        pass "validate-bash.sh blocks rm -rf /"
    else
        fail "validate-bash.sh did not block dangerous command (exit: $EXIT_CODE)"
    fi
}

# Test 4: validate-bash.sh allows safe commands
test_validate_bash_allows_safe() {
    log_test "validate-bash.sh allows safe commands"
    mkdir -p "$TEST_DIR/.loki/logs"
    INPUT='{"tool_input":{"command":"ls -la"},"cwd":"'"$TEST_DIR"'"}'
    OUTPUT=$(echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" 2>/dev/null)
    if echo "$OUTPUT" | grep -q '"permissionDecision": "allow"'; then
        pass "validate-bash.sh allows ls -la"
    else
        fail "validate-bash.sh did not allow safe command"
    fi
}

# Test 5: validate-bash.sh creates audit log
test_validate_bash_audit_log() {
    log_test "validate-bash.sh creates audit log"
    mkdir -p "$TEST_DIR/.loki/logs"
    INPUT='{"tool_input":{"command":"echo test"},"cwd":"'"$TEST_DIR"'"}'
    echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" >/dev/null 2>&1
    if [ -f "$TEST_DIR/.loki/logs/bash-audit.jsonl" ]; then
        pass "Audit log created"
    else
        fail "Audit log not created"
    fi
}

# Test 6: quality-gate.sh returns valid JSON
test_quality_gate_json() {
    log_test "quality-gate.sh returns valid JSON"
    INPUT='{"cwd":"'"$TEST_DIR"'"}'
    OUTPUT=$(echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/quality-gate.sh" 2>/dev/null)
    if echo "$OUTPUT" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
        pass "quality-gate.sh returns valid JSON"
    else
        fail "quality-gate.sh output is not valid JSON"
    fi
}

# Test 7: track-metrics.sh creates metrics file
test_track_metrics() {
    log_test "track-metrics.sh creates metrics file"
    mkdir -p "$TEST_DIR/.loki/metrics"
    INPUT='{"tool_name":"Bash","cwd":"'"$TEST_DIR"'"}'
    echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/track-metrics.sh" >/dev/null 2>&1
    if [ -f "$TEST_DIR/.loki/metrics/tool-usage.jsonl" ]; then
        pass "Metrics file created"
    else
        fail "Metrics file not created"
    fi
}

# Test 8: .claude/settings.json exists and is valid
test_settings_json() {
    log_test ".claude/settings.json exists and is valid"
    if [ -f "$PROJECT_ROOT/.claude/settings.json" ]; then
        if python3 -c "import json; json.load(open('$PROJECT_ROOT/.claude/settings.json'))" 2>/dev/null; then
            pass ".claude/settings.json is valid JSON"
        else
            fail ".claude/settings.json is not valid JSON"
        fi
    else
        fail ".claude/settings.json not found"
    fi
}

# Test 9: settings.json has required hook events
test_settings_hook_events() {
    log_test "settings.json has required hook events"
    EVENTS=$(python3 -c "
import json
with open('$PROJECT_ROOT/.claude/settings.json') as f:
    hooks = json.load(f).get('hooks', {})
    print(' '.join(hooks.keys()))
")
    REQUIRED="SessionStart PreToolUse PostToolUse Stop"
    MISSING=""
    for event in $REQUIRED; do
        if ! echo "$EVENTS" | grep -q "$event"; then
            MISSING="$MISSING $event"
        fi
    done
    if [ -z "$MISSING" ]; then
        pass "All required hook events present"
    else
        fail "Missing hook events:$MISSING"
    fi
}

# Test 10: validate-bash blocks fork bomb
test_validate_bash_blocks_forkbomb() {
    log_test "validate-bash.sh blocks fork bomb"
    INPUT='{"tool_input":{"command":":(){ :|:& };:"},"cwd":"'"$TEST_DIR"'"}'
    OUTPUT=$(echo "$INPUT" | "$PROJECT_ROOT/autonomy/hooks/validate-bash.sh" 2>/dev/null)
    EXIT_CODE=$?
    if [ "$EXIT_CODE" -eq 2 ]; then
        pass "Fork bomb blocked"
    else
        fail "Fork bomb not blocked"
    fi
}

# Run tests
setup
test_session_init_exists
test_session_init_json
test_validate_bash_blocks_dangerous
test_validate_bash_allows_safe
test_validate_bash_audit_log
test_quality_gate_json
test_track_metrics
test_settings_json
test_settings_hook_events
test_validate_bash_blocks_forkbomb

# Summary
echo ""
echo "========================================"
echo "Hooks Test Results"
echo "========================================"
echo "Passed: $TESTS_PASSED"
echo "Failed: $TESTS_FAILED"
echo "========================================"

[ "$TESTS_FAILED" -eq 0 ]
