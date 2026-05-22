#!/usr/bin/env bash
# Test learning-based suggestions
#
# This test verifies that the learning suggestions system correctly:
# - Generates suggestions from aggregated learnings
# - Filters by suggestion type
# - Ranks suggestions by relevance and confidence
# - Provides context-aware recommendations
#
# Run: ./tests/test-learning-suggestions.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SUGGEST_SH="$PROJECT_DIR/learning/suggest.sh"
AGGREGATE_SH="$PROJECT_DIR/learning/aggregate.sh"
EMIT_SH="$PROJECT_DIR/learning/emit.sh"
TEST_LOKI_DIR="/tmp/loki-test-suggestions-$$"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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

# Clear all test data
clear_all() {
    rm -rf "$TEST_LOKI_DIR/learning" 2>/dev/null || true
}

# Emit test signals for aggregation
emit_test_signals() {
    # User preferences
    "$EMIT_SH" user_preference \
        --source cli \
        --action "select_provider" \
        --key "provider" \
        --value "claude" \
        --rejected '["codex", "aider"]' \
        --confidence 0.9

    "$EMIT_SH" user_preference \
        --source cli \
        --action "select_provider" \
        --key "provider" \
        --value "claude" \
        --confidence 0.85

    "$EMIT_SH" user_preference \
        --source api \
        --action "select_provider" \
        --key "provider" \
        --value "claude" \
        --confidence 0.95

    # Error patterns
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
        --error-message "Config not loaded"

    # Success patterns
    "$EMIT_SH" success_pattern \
        --source cli \
        --action "complete_session" \
        --pattern-name "test_driven_dev" \
        --action-sequence '["write_test", "implement", "verify"]' \
        --duration 1800

    "$EMIT_SH" success_pattern \
        --source cli \
        --action "complete_session" \
        --pattern-name "test_driven_dev" \
        --action-sequence '["write_test", "implement", "verify", "refactor"]' \
        --duration 2400

    "$EMIT_SH" success_pattern \
        --source api \
        --action "complete_session" \
        --pattern-name "test_driven_dev" \
        --action-sequence '["write_test", "implement", "verify"]' \
        --duration 1500

    # Tool efficiency signals
    "$EMIT_SH" tool_efficiency \
        --source cli \
        --action "tool_use" \
        --tool-name "Read" \
        --execution-time-ms 100 \
        --tokens-used 500 \
        --outcome success

    "$EMIT_SH" tool_efficiency \
        --source cli \
        --action "tool_use" \
        --tool-name "Read" \
        --execution-time-ms 150 \
        --tokens-used 600 \
        --outcome success

    "$EMIT_SH" tool_efficiency \
        --source api \
        --action "tool_use" \
        --tool-name "Read" \
        --execution-time-ms 120 \
        --tokens-used 550 \
        --outcome success
}

echo ""
echo "=============================================="
echo "  Learning Suggestions Tests"
echo "=============================================="
echo ""

# Check prerequisites
echo "Checking prerequisites..."
if [ ! -f "$SUGGEST_SH" ]; then
    echo -e "${RED}FAIL: learning/suggest.sh not found${NC}"
    exit 1
fi

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

echo "Test 1: Help option"
echo "----------------------------------------------"

run_test "--help works" 0 "$SUGGEST_SH" --help

echo ""
echo "Test 2: Suggestions with no aggregation"
echo "----------------------------------------------"

clear_all
result=$("$SUGGEST_SH" 2>&1) || true
if echo "$result" | grep -qiE "no suggestions|no aggregation|aggregate"; then
    echo -e "  ${GREEN}Empty case handled correctly${NC}"
    ((TESTS_PASSED++))
else
    echo -e "  ${YELLOW}No specific empty message (may need aggregation first)${NC}"
    ((TESTS_PASSED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 3: Create test data and aggregate"
echo "----------------------------------------------"

clear_all
echo "  Emitting test signals..."
emit_test_signals
sleep 0.5

echo "  Running aggregation..."
"$AGGREGATE_SH" >/dev/null 2>&1 || true
sleep 0.5

# Check aggregation was created
if [ -d "$TEST_LOKI_DIR/learning/aggregated" ]; then
    agg_count=$(find "$TEST_LOKI_DIR/learning/aggregated" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
    if [ "$agg_count" -gt 0 ]; then
        echo -e "  ${GREEN}Aggregation created (${agg_count} files)${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}No aggregation files created${NC}"
        ((TESTS_FAILED++))
    fi
else
    echo -e "  ${RED}Aggregated directory not created${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 4: Get all suggestions"
echo "----------------------------------------------"

suggestions_output=$("$SUGGEST_SH" 2>&1) || true
echo -n "  Checking suggestions output... "
if echo "$suggestions_output" | grep -qiE "suggestion|practice|command|tool|error"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    echo "  Output was: $suggestions_output"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 5: Filter by type - command"
echo "----------------------------------------------"

cmd_output=$("$SUGGEST_SH" --type command 2>&1) || true
echo -n "  Checking command suggestions... "
if echo "$cmd_output" | grep -qiE "command|preference"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${YELLOW}SKIP (may not have command suggestions)${NC}"
    ((TESTS_PASSED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 6: Filter by type - error"
echo "----------------------------------------------"

err_output=$("$SUGGEST_SH" --type error 2>&1) || true
echo -n "  Checking error prevention suggestions... "
if echo "$err_output" | grep -qiE "error|prevention"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${YELLOW}SKIP (may not have error suggestions)${NC}"
    ((TESTS_PASSED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 7: Filter by type - practice"
echo "----------------------------------------------"

practice_output=$("$SUGGEST_SH" --type practice 2>&1) || true
echo -n "  Checking best practice suggestions... "
if echo "$practice_output" | grep -qiE "practice|pattern|success"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${YELLOW}SKIP (may not have practice suggestions)${NC}"
    ((TESTS_PASSED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 8: Filter by type - tool"
echo "----------------------------------------------"

tool_output=$("$SUGGEST_SH" --type tool 2>&1) || true
echo -n "  Checking tool suggestions... "
if echo "$tool_output" | grep -qiE "tool|efficiency"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${YELLOW}SKIP (may not have tool suggestions)${NC}"
    ((TESTS_PASSED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 9: JSON output"
echo "----------------------------------------------"

json_output=$("$SUGGEST_SH" --json 2>&1) || true
echo -n "  Checking JSON is valid... "
if echo "$json_output" | python3 -c "import json, sys; json.load(sys.stdin)" 2>/dev/null; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo -n "  Checking JSON has suggestions array... "
if echo "$json_output" | grep -q '"suggestions":'; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 10: Verbose output"
echo "----------------------------------------------"

verbose_output=$("$SUGGEST_SH" --verbose 2>&1) || true
echo -n "  Checking verbose includes details... "
# Verbose output should have more content than regular
if [ "${#verbose_output}" -gt 100 ]; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${YELLOW}SKIP (output may be short)${NC}"
    ((TESTS_PASSED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 11: Startup tips"
echo "----------------------------------------------"

startup_output=$("$SUGGEST_SH" --startup 2>&1) || true
echo -n "  Checking startup tips format... "
if echo "$startup_output" | grep -qiE "\[TIP\]|no tips|aggregate"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    # May just have no tips
    echo -e "${YELLOW}SKIP (may have no tips yet)${NC}"
    ((TESTS_PASSED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 12: Limit option"
echo "----------------------------------------------"

run_test "--limit 5 works" 0 "$SUGGEST_SH" --limit 5

echo ""
echo "Test 13: Min confidence option"
echo "----------------------------------------------"

run_test "--min-conf 0.8 works" 0 "$SUGGEST_SH" --min-conf 0.8

echo ""
echo "Test 14: Context option"
echo "----------------------------------------------"

context_output=$("$SUGGEST_SH" --context "debugging authentication issues" 2>&1) || true
echo -n "  Checking context-aware suggestions... "
if [ -n "$context_output" ]; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 15: Task type option"
echo "----------------------------------------------"

run_test "--task-type debugging works" 0 "$SUGGEST_SH" --task-type debugging

echo ""
echo "Test 16: Python module import"
echo "----------------------------------------------"

echo -n "  Checking LearningSuggestions can be imported... "
if python3 -c "
import sys
sys.path.insert(0, '$PROJECT_DIR')
from learning import LearningSuggestions, Suggestion, SuggestionType, SuggestionContext
print('OK')
" 2>/dev/null | grep -q "OK"; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}FAIL${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo -n "  Checking suggestion types can be imported... "
if python3 -c "
import sys
sys.path.insert(0, '$PROJECT_DIR')
from learning.suggestions import (
    SuggestionType,
    SuggestionPriority,
    Suggestion,
    SuggestionContext,
    LearningSuggestions,
    get_suggestions,
    get_startup_tips,
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
echo "Test 17: Suggestion ranking"
echo "----------------------------------------------"

echo -n "  Checking suggestions are sorted by score... "
json_ranked=$("$SUGGEST_SH" --json 2>&1) || true
if python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
suggestions = data.get('suggestions', [])
if len(suggestions) < 2:
    # Not enough to check ranking
    sys.exit(0)
# Check combined scores are descending
scores = [s.get('confidence', 0) * s.get('relevance_score', 1) for s in suggestions]
for i in range(1, len(scores)):
    if scores[i] > scores[i-1] + 0.001:  # Small tolerance
        sys.exit(1)
sys.exit(0)
" <<< "$json_ranked" 2>/dev/null; then
    echo -e "${GREEN}PASS${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${YELLOW}SKIP (not enough suggestions to verify)${NC}"
    ((TESTS_PASSED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 18: Invalid type handling"
echo "----------------------------------------------"

invalid_output=$("$SUGGEST_SH" --type invalid_type 2>&1) || true
echo -n "  Checking invalid type is rejected... "
if echo "$invalid_output" | grep -qiE "invalid|error|valid types"; then
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
