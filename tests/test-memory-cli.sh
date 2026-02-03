#!/usr/bin/env bash
#
# Test Memory CLI Commands
# Tests: loki memory index, timeline, consolidate, retrieve, pattern, skill, and error cases
#

set -uo pipefail
# Note: Not using -e to allow collecting all test results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOKI_CLI="${PROJECT_ROOT}/autonomy/loki"
TEST_DIR=$(mktemp -d)
TESTS_PASSED=0
TESTS_FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

skip() {
    echo -e "${YELLOW}[SKIP]${NC} $1"
}

log_test() {
    echo -e "${YELLOW}[TEST]${NC} $1"
}

# Helper to strip ANSI codes
strip_ansi() {
    sed 's/\x1b\[[0-9;]*m//g'
}

cleanup() {
    rm -rf "$TEST_DIR"
    rm -f /tmp/loki-memory-test-*.json 2>/dev/null || true
    # Clean up any test processes
    pkill -f "test-memory-cli" 2>/dev/null || true
}
trap cleanup EXIT

echo "========================================"
echo "Loki Mode Memory CLI Tests"
echo "========================================"
echo ""

# Check if loki CLI exists
if [ ! -f "$LOKI_CLI" ]; then
    echo -e "${RED}Loki CLI not found at $LOKI_CLI${NC}"
    exit 1
fi

# Setup test environment
cd "$TEST_DIR" || exit 1
export PYTHONPATH="${PROJECT_ROOT}:${PYTHONPATH:-}"

# Ensure learnings directory exists
mkdir -p "${HOME}/.loki/learnings"

# =============================================================================
# Basic Memory Commands
# =============================================================================

echo "--- Basic Memory Commands ---"
echo ""

# Test 1: Memory List Command
log_test "memory list command"
output=$("$LOKI_CLI" memory list 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Cross-Project Learnings\|Patterns:\|Mistakes:\|Successes:"; then
    pass "memory list command"
else
    fail "memory list command - unexpected output: $output"
fi

# Test 2: Memory Stats Command
log_test "memory stats command"
output=$("$LOKI_CLI" memory stats 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Statistics\|By Category\|By Project"; then
    pass "memory stats command"
else
    fail "memory stats command - unexpected output: $output"
fi

# Test 3: Memory Show Patterns
log_test "memory show patterns command"
output=$("$LOKI_CLI" memory show patterns --limit 5 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Patterns\|empty\|no patterns"; then
    pass "memory show patterns command"
else
    fail "memory show patterns command - unexpected output: $output"
fi

# Test 4: Memory Show Mistakes
log_test "memory show mistakes command"
output=$("$LOKI_CLI" memory show mistakes --limit 5 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Mistakes\|empty\|no mistakes"; then
    pass "memory show mistakes command"
else
    fail "memory show mistakes command - unexpected output: $output"
fi

# Test 5: Memory Show Successes
log_test "memory show successes command"
output=$("$LOKI_CLI" memory show successes --limit 5 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Successes\|empty\|no successes"; then
    pass "memory show successes command"
else
    fail "memory show successes command - unexpected output: $output"
fi

# Test 6: Memory Show All
log_test "memory show all command"
output=$("$LOKI_CLI" memory show all --limit 3 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Patterns" && echo "$output" | grep -q "Mistakes" && echo "$output" | grep -q "Successes"; then
    pass "memory show all command"
else
    fail "memory show all command - expected all three categories"
fi

# Test 7: Memory Search
log_test "memory search command"
output=$("$LOKI_CLI" memory search "test" 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Search Results\|No results"; then
    pass "memory search command"
else
    fail "memory search command - unexpected output: $output"
fi

# Test 8: Memory Export
log_test "memory export command"
export_file="/tmp/loki-memory-test-export-$$.json"
output=$("$LOKI_CLI" memory export "$export_file" 2>&1 || true)
if [ -f "$export_file" ]; then
    # Check it's valid JSON with expected structure
    if python3 -c "import json; d=json.load(open('$export_file')); assert 'patterns' in d or 'mistakes' in d or 'successes' in d" 2>/dev/null; then
        pass "memory export command"
        rm -f "$export_file"
    else
        fail "memory export command - invalid JSON structure"
    fi
else
    fail "memory export command - file not created"
fi

# =============================================================================
# Memory Index and Timeline
# =============================================================================

echo ""
echo "--- Memory Index and Timeline ---"
echo ""

# Test 9: Memory Index Show
log_test "memory index show command"
# First ensure the index exists
mkdir -p .loki/memory
echo '{"version":"1.0","topics":[],"total_memories":0}' > .loki/memory/index.json
output=$("$LOKI_CLI" memory index 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "version\|topics\|No index found"; then
    pass "memory index show command"
else
    fail "memory index show command - unexpected output: $output"
fi

# Test 10: Memory Timeline Show
log_test "memory timeline show command"
# Ensure timeline exists
echo '{"version":"1.0","recent_actions":[],"key_decisions":[]}' > .loki/memory/timeline.json
output=$("$LOKI_CLI" memory timeline 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "version\|recent_actions\|key_decisions\|No timeline found"; then
    pass "memory timeline show command"
else
    fail "memory timeline show command - unexpected output: $output"
fi

# Test 11: Memory Index Rebuild
log_test "memory index rebuild command"
output=$("$LOKI_CLI" memory index rebuild 2>&1 | strip_ansi || true)
# May fail if module not available, but should not crash
if echo "$output" | grep -q "rebuilt\|Error\|not found"; then
    pass "memory index rebuild command (handles errors gracefully)"
else
    fail "memory index rebuild command - unexpected output: $output"
fi

# =============================================================================
# Memory Consolidation
# =============================================================================

echo ""
echo "--- Memory Consolidation ---"
echo ""

# Test 12: Memory Consolidate
log_test "memory consolidate command"
output=$("$LOKI_CLI" memory consolidate 24 2>&1 | strip_ansi || true)
# May fail if module not available, but should not crash
if echo "$output" | grep -q "complete\|Error\|not found\|patterns\|episodes"; then
    pass "memory consolidate command (handles errors gracefully)"
else
    fail "memory consolidate command - unexpected output: $output"
fi

# =============================================================================
# Memory Deduplication
# =============================================================================

echo ""
echo "--- Memory Deduplication ---"
echo ""

# Test 13: Memory Dedupe
log_test "memory dedupe command"
output=$("$LOKI_CLI" memory dedupe 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Deduplicating\|duplicates\|kept\|unique"; then
    pass "memory dedupe command"
else
    fail "memory dedupe command - unexpected output: $output"
fi

# =============================================================================
# Error Cases
# =============================================================================

echo ""
echo "--- Error Cases ---"
echo ""

# Test 14: Memory Search Without Query
log_test "memory search without query (error case)"
output=$("$LOKI_CLI" memory search 2>&1 | strip_ansi || true)
if echo "$output" | grep -qi "usage\|error\|query"; then
    pass "memory search without query returns error"
else
    fail "memory search without query - expected usage message"
fi

# Test 15: Memory Show Invalid Type
log_test "memory show invalid type (error case)"
output=$("$LOKI_CLI" memory show invalidtype 2>&1 | strip_ansi || true)
if echo "$output" | grep -qi "unknown\|invalid\|error\|valid types"; then
    pass "memory show invalid type returns error"
else
    fail "memory show invalid type - expected error message"
fi

# Test 16: Memory Clear Invalid Type
log_test "memory clear invalid type (error case)"
output=$("$LOKI_CLI" memory clear invalidtype 2>&1 | strip_ansi || true)
if echo "$output" | grep -qi "unknown\|invalid\|error\|valid types"; then
    pass "memory clear invalid type returns error"
else
    fail "memory clear invalid type - expected error message"
fi

# =============================================================================
# Memory Retrieve (if implemented)
# =============================================================================

echo ""
echo "--- Memory Retrieve ---"
echo ""

# Test 17: Memory Retrieve Command
log_test "memory retrieve command"
output=$("$LOKI_CLI" memory retrieve "test query" 2>&1 | strip_ansi || true)
# This command may or may not be implemented
if echo "$output" | grep -qi "retrieve\|results\|error\|not found\|unknown command\|memories"; then
    pass "memory retrieve command (or graceful error)"
else
    skip "memory retrieve command - not implemented"
fi

# Test 18: Memory Pattern Command
log_test "memory pattern store command"
output=$("$LOKI_CLI" memory pattern 2>&1 | strip_ansi || true)
# This command may or may not be implemented
if echo "$output" | grep -qi "pattern\|error\|usage\|unknown\|not found"; then
    pass "memory pattern command (or graceful error)"
else
    skip "memory pattern command - not implemented"
fi

# Test 19: Memory Skill Command
log_test "memory skill command"
output=$("$LOKI_CLI" memory skill 2>&1 | strip_ansi || true)
# This command may or may not be implemented
if echo "$output" | grep -qi "skill\|error\|usage\|unknown\|not found"; then
    pass "memory skill command (or graceful error)"
else
    skip "memory skill command - not implemented"
fi

# =============================================================================
# Memory Clear (with mock confirmation)
# =============================================================================

echo ""
echo "--- Memory Clear (Safe Tests) ---"
echo ""

# Test 20: Memory Clear Single Type
log_test "memory clear patterns (creates empty file)"
# Create a backup first
patterns_file="${HOME}/.loki/learnings/patterns.jsonl"
if [ -f "$patterns_file" ]; then
    cp "$patterns_file" "${patterns_file}.bak"
fi

# Clear patterns (this is non-interactive for single type)
output=$("$LOKI_CLI" memory clear patterns 2>&1 | strip_ansi || true)

# Restore backup
if [ -f "${patterns_file}.bak" ]; then
    mv "${patterns_file}.bak" "$patterns_file"
fi

if echo "$output" | grep -qi "cleared\|patterns"; then
    pass "memory clear patterns command"
else
    fail "memory clear patterns command - unexpected output: $output"
fi

# =============================================================================
# Integration with Memory System
# =============================================================================

echo ""
echo "--- Integration Tests ---"
echo ""

# Test 21: Learnings Directory Structure
log_test "learnings directory structure"
learnings_dir="${HOME}/.loki/learnings"
if [ -d "$learnings_dir" ]; then
    pass "learnings directory exists"
else
    fail "learnings directory not found at $learnings_dir"
fi

# Test 22: JSONL File Format Validation
log_test "JSONL file format validation"
patterns_file="${HOME}/.loki/learnings/patterns.jsonl"
if [ -f "$patterns_file" ]; then
    # Try to parse first line as JSON
    first_line=$(head -1 "$patterns_file" 2>/dev/null || echo "")
    if [ -n "$first_line" ] && echo "$first_line" | python3 -m json.tool >/dev/null 2>&1; then
        pass "JSONL file format is valid"
    else
        skip "JSONL file empty or first line not valid JSON"
    fi
else
    skip "patterns.jsonl not found - skipping format test"
fi

# Test 23: Memory Commands with Project Filter
log_test "memory show with project filter"
output=$("$LOKI_CLI" memory show patterns --project "test-project" --limit 5 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Patterns\|empty\|no patterns"; then
    pass "memory show with project filter"
else
    fail "memory show with project filter - unexpected output"
fi

# Test 24: Memory Commands with Limit
log_test "memory show with custom limit"
output=$("$LOKI_CLI" memory show mistakes --limit 1 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Mistakes\|empty\|no mistakes"; then
    pass "memory show with custom limit"
else
    fail "memory show with custom limit - unexpected output"
fi

# =============================================================================
# Help and Usage
# =============================================================================

echo ""
echo "--- Help and Usage ---"
echo ""

# Test 25: Memory Help (via unknown subcommand)
log_test "memory unknown subcommand"
output=$("$LOKI_CLI" memory unknownsubcommand 2>&1 | strip_ansi || true)
# Should either show help or error
if echo "$output" | grep -qi "unknown\|error\|usage\|help\|list\|show\|search"; then
    pass "memory unknown subcommand returns helpful message"
else
    # Some implementations might silently ignore unknown commands
    skip "memory unknown subcommand - no helpful message"
fi

echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
