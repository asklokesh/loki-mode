#!/usr/bin/env bash
# Test learning signal aggregation
#
# This test verifies that the learning aggregator correctly:
# - Reads signals from .loki/learning/signals/
# - Aggregates by type, source, and time window
# - Identifies patterns across signals
# - Saves aggregated learnings to .loki/learning/aggregated/
#
# Run: ./tests/test-learning-aggregator.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
AGGREGATE_SH="$PROJECT_DIR/learning/aggregate.sh"
EMIT_SH="$PROJECT_DIR/learning/emit.sh"
TEST_LOKI_DIR="/tmp/loki-test-aggregator-$$"

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

# Check if aggregated file was created
check_aggregation_created() {
    local agg_dir="$TEST_LOKI_DIR/learning/aggregated"
    if [ -d "$agg_dir" ]; then
        local count
        count=$(find "$agg_dir" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
        if [ "$count" -gt 0 ]; then
            return 0
        fi
    fi
    return 1
}

# Get latest aggregation file content
get_latest_aggregation() {
    local agg_dir="$TEST_LOKI_DIR/learning/aggregated"
    if [ -d "$agg_dir" ]; then
        local latest
        latest=$(find "$agg_dir" -name "*.json" -type f 2>/dev/null | sort | tail -1)
        if [ -n "$latest" ]; then
            cat "$latest"
        fi
    fi
}

# Clear signals and aggregations for next test
clear_all() {
    rm -rf "$TEST_LOKI_DIR/learning" 2>/dev/null || true
}

# Emit multiple test signals
emit_test_signals() {
    # User preferences - same key, same value (should aggregate)
    "$EMIT_SH" user_preference \
        --source cli \
        --action "select_provider" \
        --key "provider" \
        --value "claude" \
        --rejected '["codex", "gemini"]' \
        --confidence 0.9

    "$EMIT_SH" user_preference \
        --source api \
        --action "select_provider" \
        --key "provider" \
        --value "claude" \
        --rejected '["gemini"]' \
        --confidence 0.85

    "$EMIT_SH" user_preference \
        --source vscode \
        --action "select_provider" \
        --key "provider" \
        --value "claude" \
        --confidence 0.95

    # Error patterns - same type (should aggregate)
    "$EMIT_SH" error_pattern \
        --source cli \
        --action "run_cmd" \
        --error-type "ConfigError" \
        --error-message "Missing config file" \
        --resolution "Created default config"

    "$EMIT_SH" error_pattern \
        --source cli \
        --action "run_cmd" \
        --error-type "ConfigError" \
        --error-message "Invalid config format" \
        --resolution "Fixed JSON syntax"

    "$EMIT_SH" error_pattern \
        --source api \
        --action "api_call" \
        --error-type "ConfigError" \
        --error-message "Config not loaded" \
        --resolution "Loaded config first"

    # Success patterns - same name (should aggregate)
    "$EMIT_SH" success_pattern \
        --source cli \
        --action "complete_session" \
        --pattern-name "full_workflow" \
        --action-sequence '["init", "plan", "implement", "test", "deploy"]' \
        --duration 3600

    "$EMIT_SH" success_pattern \
        --source cli \
        --action "complete_session" \
        --pattern-name "full_workflow" \
        --action-sequence '["init", "plan", "implement", "test"]' \
        --duration 2400

    "$EMIT_SH" success_pattern \
        --source api \
        --action "complete_session" \
        --pattern-name "full_workflow" \
        --action-sequence '["init", "implement", "test", "deploy"]' \
        --duration 1800

    # Tool efficiency signals
    "$EMIT_SH" tool_efficiency \
        --source cli \
        --action "tool_use" \
        --tool-name "claude" \
        --execution-time-ms 5000 \
        --tokens-used 1000 \
        --outcome success

    "$EMIT_SH" tool_efficiency \
        --source cli \
        --action "tool_use" \
        --tool-name "claude" \
        --execution-time-ms 3000 \
        --tokens-used 800 \
        --outcome success

    "$EMIT_SH" tool_efficiency \
        --source api \
        --action "tool_use" \
        --tool-name "claude" \
        --execution-time-ms 4000 \
        --tokens-used 900 \
        --outcome failure

    # Workflow patterns
    "$EMIT_SH" workflow_pattern \
        --source cli \
        --action "workflow_complete" \
        --workflow-name "deploy_pipeline" \
        --steps '["build", "test", "deploy"]' \
        --total-duration 600 \
        --outcome success

    "$EMIT_SH" workflow_pattern \
        --source cli \
        --action "workflow_complete" \
        --workflow-name "deploy_pipeline" \
        --steps '["build", "test", "stage", "deploy"]' \
        --total-duration 900 \
        --outcome success
}

echo ""
echo "=============================================="
echo "  Learning Aggregator Tests"
echo "=============================================="
echo ""

# Check prerequisites
echo "Checking prerequisites..."
if [ ! -f "$AGGREGATE_SH" ]; then
    echo -e "${RED}FAIL: learning/aggregate.sh not found${NC}"
    exit 1
fi

if [ ! -f "$EMIT_SH" ]; then
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

echo "Test 1: Aggregation with no signals"
echo "----------------------------------------------"

clear_all
result=$("$AGGREGATE_SH" 2>&1) || true
if echo "$result" | grep -q "No patterns found\|Signals processed: 0"; then
    echo -e "  ${GREEN}Empty aggregation handled correctly${NC}"
    ((TESTS_PASSED++))
else
    echo -e "  ${RED}Empty aggregation not handled${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 2: Basic aggregation"
echo "----------------------------------------------"

clear_all
echo "  Emitting test signals..."
emit_test_signals
sleep 0.5

echo "  Running aggregation..."
run_test "aggregation completes" 0 "$AGGREGATE_SH"

sleep 0.5
if check_aggregation_created; then
    echo -e "  ${GREEN}Aggregation file created${NC}"
    ((TESTS_PASSED++))
else
    echo -e "  ${RED}No aggregation file created${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 3: Aggregation content validation"
echo "----------------------------------------------"

agg_content=$(get_latest_aggregation)

# Check has ID
echo -n "  Checking aggregation has ID... "
if echo "$agg_content" | grep -q '"id": "agg-'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

# Check has timestamp
echo -n "  Checking aggregation has timestamp... "
if echo "$agg_content" | grep -q '"timestamp":'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

# Check has preferences array
echo -n "  Checking has preferences array... "
if echo "$agg_content" | grep -q '"preferences":'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

# Check has error_patterns array
echo -n "  Checking has error_patterns array... "
if echo "$agg_content" | grep -q '"error_patterns":'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

# Check has tool_efficiencies array
echo -n "  Checking has tool_efficiencies array... "
if echo "$agg_content" | grep -q '"tool_efficiencies":'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 4: User preference aggregation"
echo "----------------------------------------------"

# Check preference key is aggregated
echo -n "  Checking preference key 'provider' detected... "
if echo "$agg_content" | grep -q '"preference_key": "provider"'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

# Check preferred value
echo -n "  Checking preferred value 'claude' detected... "
if echo "$agg_content" | grep -q '"preferred_value": "claude"'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

# Check frequency is 3 (we emitted 3 preference signals)
echo -n "  Checking frequency count... "
if echo "$agg_content" | grep -A5 '"preference_key": "provider"' | grep -q '"frequency": 3'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 5: Error pattern aggregation"
echo "----------------------------------------------"

# Check error type is aggregated
echo -n "  Checking error type 'ConfigError' detected... "
if echo "$agg_content" | grep -q '"error_type": "ConfigError"'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

# Check resolutions are collected
echo -n "  Checking resolutions collected... "
if echo "$agg_content" | grep -q '"resolutions":'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 6: Tool efficiency aggregation"
echo "----------------------------------------------"

# Check tool name is aggregated
echo -n "  Checking tool 'claude' detected... "
if echo "$agg_content" | grep -q '"tool_name": "claude"'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

# Check usage count
echo -n "  Checking usage count... "
if echo "$agg_content" | grep -A5 '"tool_name": "claude"' | grep -q '"usage_count": 3'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

# Check efficiency score exists
echo -n "  Checking efficiency_score calculated... "
if echo "$agg_content" | grep -q '"efficiency_score":'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 7: JSON output mode"
echo "----------------------------------------------"

json_output=$("$AGGREGATE_SH" --json --no-save 2>&1)
echo -n "  Checking JSON output is valid... "
if echo "$json_output" | python3 -c "import json, sys; json.load(sys.stdin)" 2>/dev/null; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 8: List mode"
echo "----------------------------------------------"

list_output=$("$AGGREGATE_SH" --list 2>&1)
echo -n "  Checking list shows aggregations... "
if echo "$list_output" | grep -q "agg-\|Recent Aggregations"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 9: Latest mode"
echo "----------------------------------------------"

latest_output=$("$AGGREGATE_SH" --latest 2>&1)
echo -n "  Checking latest shows summary... "
if echo "$latest_output" | grep -q "Learning Aggregation Summary\|ID:"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 10: Custom time window"
echo "----------------------------------------------"

run_test "custom --days works" 0 "$AGGREGATE_SH" --days 30 --no-save

echo ""
echo "Test 11: Minimum frequency filtering"
echo "----------------------------------------------"

# With high min-freq, should filter out patterns
high_freq_output=$("$AGGREGATE_SH" --min-freq 100 --no-save 2>&1)
echo -n "  Checking high min-freq filters patterns... "
if echo "$high_freq_output" | grep -q "No patterns found\|preferences): 0"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    # May still pass if output format is different
    if echo "$high_freq_output" | grep -qE "0 prefs|preferences.*0"; then
        echo -e "${GREEN}PASS${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "${RED}FAIL${NC}"
        ((TESTS_FAILED++))
    fi
fi
((TESTS_RUN++))

echo ""
echo "Test 12: Help option"
echo "----------------------------------------------"

run_test "--help works" 0 "$AGGREGATE_SH" --help

echo ""
echo "Test 13: Python module import"
echo "----------------------------------------------"

echo -n "  Checking LearningAggregator can be imported... "
if python3 -c "
import sys
sys.path.insert(0, '$PROJECT_DIR')
from learning import LearningAggregator, run_aggregation
print('OK')
" 2>/dev/null | grep -q "OK"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo -n "  Checking aggregated types can be imported... "
if python3 -c "
import sys
sys.path.insert(0, '$PROJECT_DIR')
from learning import (
    AggregatedPreference,
    AggregatedErrorPattern,
    AggregatedSuccessPattern,
    AggregatedToolEfficiency,
    AggregatedContextRelevance,
    AggregationResult,
)
print('OK')
" 2>/dev/null | grep -q "OK"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 14: Confidence calculation"
echo "----------------------------------------------"

echo -n "  Checking confidence scores are between 0 and 1... "
if echo "$agg_content" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for pref in data.get('preferences', []):
    if not 0 <= pref.get('confidence', -1) <= 1:
        sys.exit(1)
for err in data.get('error_patterns', []):
    if not 0 <= err.get('confidence', -1) <= 1:
        sys.exit(1)
for tool in data.get('tool_efficiencies', []):
    if not 0 <= tool.get('confidence', -1) <= 1:
        sys.exit(1)
print('OK')
" 2>/dev/null; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 15: Source tracking"
echo "----------------------------------------------"

echo -n "  Checking sources are tracked in preferences... "
if echo "$agg_content" | grep -A10 '"preference_key": "provider"' | grep -q '"sources":'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

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
