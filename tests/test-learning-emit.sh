#!/usr/bin/env bash
# Test learning signal emission from bash helper
#
# This test verifies that the learning/emit.sh helper correctly
# emits signals via the Python learning emitter.
#
# Run: ./tests/test-learning-emit.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LEARNING_EMIT_SH="$PROJECT_DIR/learning/emit.sh"
TEST_LOKI_DIR="/tmp/loki-test-learning-$$"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Cleanup function
cleanup() {
    rm -rf "$TEST_LOKI_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Test helper
run_test() {
    local test_name="$1"
    local expected_result="${2:-0}"
    shift 2

    ((TESTS_RUN++))
    echo -n "  Testing $test_name... "

    if [ "$expected_result" = "0" ]; then
        if "$@" >/dev/null 2>&1; then
            echo -e "${GREEN}PASS${NC}"
            ((TESTS_PASSED++))
            return 0
        else
            echo -e "${RED}FAIL${NC}"
            ((TESTS_FAILED++))
            return 1
        fi
    else
        if ! "$@" >/dev/null 2>&1; then
            echo -e "${GREEN}PASS (expected failure)${NC}"
            ((TESTS_PASSED++))
            return 0
        else
            echo -e "${RED}FAIL (should have failed)${NC}"
            ((TESTS_FAILED++))
            return 1
        fi
    fi
}

# Check if signal file was created
check_signal_created() {
    local signal_dir="$TEST_LOKI_DIR/learning/signals"
    if [ -d "$signal_dir" ]; then
        local count
        count=$(find "$signal_dir" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
        if [ "$count" -gt 0 ]; then
            return 0
        fi
    fi
    return 1
}

# Get latest signal file content
get_latest_signal() {
    local signal_dir="$TEST_LOKI_DIR/learning/signals"
    if [ -d "$signal_dir" ]; then
        local latest
        latest=$(find "$signal_dir" -name "*.json" -type f 2>/dev/null | sort | tail -1)
        if [ -n "$latest" ]; then
            cat "$latest"
        fi
    fi
}

# Clear signals for next test
clear_signals() {
    rm -rf "$TEST_LOKI_DIR/learning/signals" 2>/dev/null || true
}

echo ""
echo "=============================================="
echo "  Learning Signal Emission Tests"
echo "=============================================="
echo ""

# Check prerequisites
echo "Checking prerequisites..."
if [ ! -f "$LEARNING_EMIT_SH" ]; then
    echo -e "${RED}FAIL: learning/emit.sh not found${NC}"
    exit 1
fi

if ! command -v python3 &> /dev/null; then
    echo -e "${RED}FAIL: python3 not found${NC}"
    exit 1
fi

echo -e "${GREEN}Prerequisites OK${NC}"
echo ""

# Create test directory
mkdir -p "$TEST_LOKI_DIR"
export LOKI_DIR="$TEST_LOKI_DIR"
export LOKI_SKILL_DIR="$PROJECT_DIR"

echo "Test 1: Basic signal emission"
echo "----------------------------------------------"

# Test user preference signal
clear_signals
run_test "user_preference signal" 0 \
    "$LEARNING_EMIT_SH" user_preference \
        --source cli \
        --action "test_action" \
        --key "test_key" \
        --value "test_value"

sleep 0.5
if check_signal_created; then
    echo -e "  ${GREEN}Signal file created${NC}"
    signal_content=$(get_latest_signal)
    if echo "$signal_content" | grep -q '"type": "user_preference"'; then
        echo -e "  ${GREEN}Signal type correct${NC}"
    else
        echo -e "  ${RED}Signal type incorrect${NC}"
        ((TESTS_FAILED++))
    fi
else
    echo -e "  ${RED}No signal file created${NC}"
    ((TESTS_FAILED++))
fi

# Test error pattern signal
clear_signals
run_test "error_pattern signal" 0 \
    "$LEARNING_EMIT_SH" error_pattern \
        --source cli \
        --action "test_error" \
        --error-type "TestError" \
        --error-message "Test error message"

sleep 0.5
if check_signal_created; then
    echo -e "  ${GREEN}Error pattern signal created${NC}"
else
    echo -e "  ${RED}No error pattern signal created${NC}"
    ((TESTS_FAILED++))
fi

# Test success pattern signal
clear_signals
run_test "success_pattern signal" 0 \
    "$LEARNING_EMIT_SH" success_pattern \
        --source cli \
        --action "test_success" \
        --pattern-name "test_pattern" \
        --action-sequence '["step1", "step2"]' \
        --duration 60

sleep 0.5
if check_signal_created; then
    echo -e "  ${GREEN}Success pattern signal created${NC}"
else
    echo -e "  ${RED}No success pattern signal created${NC}"
    ((TESTS_FAILED++))
fi

# Test tool efficiency signal
clear_signals
run_test "tool_efficiency signal" 0 \
    "$LEARNING_EMIT_SH" tool_efficiency \
        --source cli \
        --action "test_tool" \
        --tool-name "claude" \
        --execution-time-ms 1500 \
        --outcome success

sleep 0.5
if check_signal_created; then
    echo -e "  ${GREEN}Tool efficiency signal created${NC}"
else
    echo -e "  ${RED}No tool efficiency signal created${NC}"
    ((TESTS_FAILED++))
fi

# Test workflow pattern signal
clear_signals
run_test "workflow_pattern signal" 0 \
    "$LEARNING_EMIT_SH" workflow_pattern \
        --source cli \
        --action "test_workflow" \
        --workflow-name "test_flow" \
        --steps '["init", "run", "complete"]' \
        --outcome success

sleep 0.5
if check_signal_created; then
    echo -e "  ${GREEN}Workflow pattern signal created${NC}"
else
    echo -e "  ${RED}No workflow pattern signal created${NC}"
    ((TESTS_FAILED++))
fi

echo ""
echo "Test 2: Error handling"
echo "----------------------------------------------"

# Test missing action
run_test "reject missing --action" 1 \
    "$LEARNING_EMIT_SH" user_preference \
        --source cli \
        --key "test" \
        --value "test"

# Test unknown signal type
run_test "reject unknown signal type" 1 \
    "$LEARNING_EMIT_SH" invalid_type \
        --source cli \
        --action "test"

echo ""
echo "Test 3: Signal content validation"
echo "----------------------------------------------"

clear_signals
"$LEARNING_EMIT_SH" user_preference \
    --source cli \
    --action "validate_test" \
    --key "provider" \
    --value "claude" \
    --rejected '["codex", "gemini"]' \
    --confidence 0.95

sleep 0.5
signal_content=$(get_latest_signal)

# Validate signal structure
echo -n "  Checking signal has ID... "
if echo "$signal_content" | grep -q '"id": "sig-'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi

echo -n "  Checking signal has timestamp... "
if echo "$signal_content" | grep -q '"timestamp":'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi

echo -n "  Checking signal has source... "
if echo "$signal_content" | grep -q '"source": "cli"'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi

echo -n "  Checking preference_key... "
if echo "$signal_content" | grep -q '"preference_key": "provider"'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi

echo -n "  Checking preference_value... "
if echo "$signal_content" | grep -q '"preference_value": "claude"'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi

echo ""
echo "=============================================="
echo "  Test Results"
echo "=============================================="
echo ""
echo "  Tests run:    $TESTS_RUN"
echo "  Tests passed: $TESTS_PASSED"
echo "  Tests failed: $TESTS_FAILED"
echo ""

if [ "$TESTS_FAILED" -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
