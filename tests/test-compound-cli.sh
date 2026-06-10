#!/usr/bin/env bash
#
# Test: Loki Compound CLI Commands
# Tests all subcommands of 'loki compound': help, list, show, search, stats
# Uses a temporary HOME directory to isolate from real user data.
#
# Run: ./tests/test-compound-cli.sh
#
# Note: Not using -e to allow collecting all test results

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
LOKI_CLI="${PROJECT_ROOT}/autonomy/loki"
TEST_HOME=$(mktemp -d)
REAL_HOME="$HOME"

TESTS_PASSED=0
TESTS_FAILED=0
TESTS_TOTAL=0

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
    echo -e "${RED}[FAIL]${NC} $1 -- $2"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

log_test() {
    echo -e "${YELLOW}[TEST]${NC} $1"
    TESTS_TOTAL=$((TESTS_TOTAL + 1))
}

# Helper to strip ANSI codes
strip_ansi() {
    sed 's/\x1b\[[0-9;]*m//g'
}

cleanup() {
    rm -rf "$TEST_HOME" 2>/dev/null || true
}
trap cleanup EXIT

echo "========================================"
echo "Loki Compound CLI Tests"
echo "========================================"
echo "CLI: $LOKI_CLI"
echo "Test HOME: $TEST_HOME"
echo ""

# Verify the loki script exists and is executable
if [ ! -x "$LOKI_CLI" ]; then
    echo -e "${RED}Error: $LOKI_CLI not found or not executable${NC}"
    exit 1
fi

# Override HOME so cmd_compound() uses $TEST_HOME/.loki/solutions
export HOME="$TEST_HOME"

# =============================================================================
# Test 1: compound help
# =============================================================================

log_test "compound help shows usage information"
output=$("$LOKI_CLI" compound help 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "loki memory compound" && \
   echo "$output" | grep -q "Knowledge compounding system" && \
   echo "$output" | grep -q "Commands:" && \
   echo "$output" | grep -q "list" && \
   echo "$output" | grep -q "show" && \
   echo "$output" | grep -q "search" && \
   echo "$output" | grep -q "run" && \
   echo "$output" | grep -q "stats"; then
    pass "compound help shows all expected sections"
else
    fail "compound help missing expected content" "output: $(echo "$output" | head -3)"
fi

# =============================================================================
# Test 2: compound help exit code
# =============================================================================

log_test "compound help exits with 0"
"$LOKI_CLI" compound help >/dev/null 2>&1
exit_code=$?
if [ "$exit_code" -eq 0 ]; then
    pass "compound help exits with 0"
else
    fail "compound help exits with 0" "got exit code $exit_code"
fi

# =============================================================================
# Test 3: default subcommand is help
# =============================================================================

log_test "compound with no subcommand defaults to help"
output=$("$LOKI_CLI" compound 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Knowledge compounding system"; then
    pass "compound with no subcommand defaults to help"
else
    fail "compound with no subcommand defaults to help" "output did not match help text"
fi

# =============================================================================
# Test 4: compound list with no solutions directory
# =============================================================================

log_test "compound list with no solutions directory"
output=$("$LOKI_CLI" compound list 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "No solutions yet" && \
   echo "$output" | grep -q "Location:"; then
    pass "compound list shows empty state when no solutions directory"
else
    fail "compound list shows empty state" "output: $(echo "$output" | head -3)"
fi

# =============================================================================
# Test 5: compound list after creating a test solution
# =============================================================================

log_test "compound list after creating a test solution"

# Create a test solution in the testing category
mkdir -p "$TEST_HOME/.loki/solutions/testing"
cat > "$TEST_HOME/.loki/solutions/testing/playwright-shadow-dom.md" << 'SOLUTION'
---
title: "Playwright shadow DOM piercing for web components"
category: testing
tags: [test, playwright, e2e, shadow-dom]
symptoms:
  - "element.textContent() returns empty string on custom element host"
root_cause: "Shadow DOM boundary prevents direct text content access"
prevention: "Use locator chaining which pierces shadow DOM automatically"
confidence: 0.85
source_project: "loki-mode"
created: "2026-01-15T10:00:00Z"
applied_count: 3
---

## Solution

- Use Playwright locator().locator() chaining which pierces shadow DOM
- Avoid element.textContent() on custom element hosts
- Target classes inside shadow root directly

## Context

Compounded from 4 learnings from project: loki-mode
SOLUTION

output=$("$LOKI_CLI" compound list 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "testing" && \
   echo "$output" | grep -q "1 solutions" && \
   echo "$output" | grep -q "Total: 1"; then
    pass "compound list shows testing category with 1 solution"
else
    fail "compound list with test solution" "output: $(echo "$output" | head -8)"
fi

# =============================================================================
# Test 6: compound list with multiple categories
# =============================================================================

log_test "compound list with multiple categories"

# Add a second category
mkdir -p "$TEST_HOME/.loki/solutions/security"
cat > "$TEST_HOME/.loki/solutions/security/cors-misconfiguration.md" << 'SOLUTION'
---
title: "CORS misconfiguration allowing wildcard origins"
category: security
tags: [cors, auth, security]
symptoms:
  - "API accessible from any origin"
root_cause: "Access-Control-Allow-Origin set to *"
prevention: "Whitelist specific origins in CORS config"
confidence: 0.90
source_project: "api-gateway"
created: "2026-01-20T14:00:00Z"
applied_count: 1
---

## Solution

- Configure explicit origin whitelist instead of wildcard
- Validate Origin header server-side

## Context

Compounded from 3 learnings from project: api-gateway
SOLUTION

output=$("$LOKI_CLI" compound list 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "security" && \
   echo "$output" | grep -q "testing" && \
   echo "$output" | grep -q "Total: 2"; then
    pass "compound list shows multiple categories"
else
    fail "compound list with multiple categories" "output: $(echo "$output" | head -10)"
fi

# =============================================================================
# Test 7: compound show with a valid category
# =============================================================================

log_test "compound show testing category"
output=$("$LOKI_CLI" compound show testing 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Solutions: testing" && \
   echo "$output" | grep -q "Playwright shadow DOM piercing"; then
    pass "compound show displays testing solutions with title"
else
    fail "compound show testing" "output: $(echo "$output" | head -5)"
fi

# =============================================================================
# Test 8: compound show displays confidence and project
# =============================================================================

log_test "compound show displays confidence and source project"
output=$("$LOKI_CLI" compound show testing 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "confidence: 0.85" && \
   echo "$output" | grep -q "project: loki-mode"; then
    pass "compound show displays confidence and project metadata"
else
    fail "compound show metadata" "output: $(echo "$output" | head -5)"
fi

# =============================================================================
# Test 9: compound show with empty category
# =============================================================================

log_test "compound show with no category argument returns error"
output=$("$LOKI_CLI" compound show 2>&1 | strip_ansi || true)
exit_code=0
"$LOKI_CLI" compound show >/dev/null 2>&1 || exit_code=$?
if [ "$exit_code" -ne 0 ] && echo "$output" | grep -qi "Error.*Specify a category"; then
    pass "compound show with no argument returns error"
else
    fail "compound show with no argument" "expected error, got exit=$exit_code output: $(echo "$output" | head -3)"
fi

# =============================================================================
# Test 10: compound show with nonexistent category
# =============================================================================

log_test "compound show with nonexistent category"
output=$("$LOKI_CLI" compound show nonexistent 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "No solutions in category: nonexistent"; then
    pass "compound show handles nonexistent category gracefully"
else
    fail "compound show nonexistent category" "output: $(echo "$output" | head -3)"
fi

# =============================================================================
# Test 11: compound search matching a tag
# =============================================================================

log_test "compound search matching a tag"
output=$("$LOKI_CLI" compound search "playwright" 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Searching solutions for: playwright" && \
   echo "$output" | grep -q "Found: 1"; then
    pass "compound search finds solution by tag/content match"
else
    fail "compound search by tag" "output: $(echo "$output" | head -5)"
fi

# =============================================================================
# Test 12: compound search matching content in solution body
# =============================================================================

log_test "compound search matching solution body content"
output=$("$LOKI_CLI" compound search "shadow" 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Found:"; then
    pass "compound search finds solution by body content"
else
    fail "compound search body content" "output: $(echo "$output" | head -5)"
fi

# =============================================================================
# Test 13: compound search with no results
# =============================================================================

log_test "compound search with no matching results"
output=$("$LOKI_CLI" compound search "zzz_nonexistent_query_zzz" 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "No solutions matching: zzz_nonexistent_query_zzz"; then
    pass "compound search shows no results message for unmatched query"
else
    fail "compound search no results" "output: $(echo "$output" | head -5)"
fi

# =============================================================================
# Test 14: compound search with no query argument
# =============================================================================

log_test "compound search with no query argument returns error"
exit_code=0
"$LOKI_CLI" compound search >/dev/null 2>&1 || exit_code=$?
output=$("$LOKI_CLI" compound search 2>&1 | strip_ansi || true)
if [ "$exit_code" -ne 0 ] && echo "$output" | grep -qi "Error.*search query"; then
    pass "compound search with no query returns error"
else
    fail "compound search no query" "expected error, got exit=$exit_code output: $(echo "$output" | head -3)"
fi

# =============================================================================
# Test 15: compound search with no solutions directory
# =============================================================================

log_test "compound search with no solutions directory"
# Temporarily remove solutions dir
mv "$TEST_HOME/.loki/solutions" "$TEST_HOME/.loki/solutions.bak"
output=$("$LOKI_CLI" compound search "test" 2>&1 | strip_ansi || true)
mv "$TEST_HOME/.loki/solutions.bak" "$TEST_HOME/.loki/solutions"
if echo "$output" | grep -q "No solutions directory found"; then
    pass "compound search handles missing solutions directory"
else
    fail "compound search no directory" "output: $(echo "$output" | head -3)"
fi

# =============================================================================
# Test 16: compound stats output format
# =============================================================================

log_test "compound stats shows total and metadata"
output=$("$LOKI_CLI" compound stats 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Compound Solution Statistics" && \
   echo "$output" | grep -q "Total solutions: 2" && \
   echo "$output" | grep -q "Newest:" && \
   echo "$output" | grep -q "Oldest:" && \
   echo "$output" | grep -q "Location:"; then
    pass "compound stats shows all expected fields"
else
    fail "compound stats output" "output: $(echo "$output" | head -8)"
fi

# =============================================================================
# Test 17: compound stats with no solutions directory
# =============================================================================

log_test "compound stats with no solutions directory"
mv "$TEST_HOME/.loki/solutions" "$TEST_HOME/.loki/solutions.bak"
output=$("$LOKI_CLI" compound stats 2>&1 | strip_ansi || true)
mv "$TEST_HOME/.loki/solutions.bak" "$TEST_HOME/.loki/solutions"
if echo "$output" | grep -q "No solutions directory found"; then
    pass "compound stats handles missing solutions directory"
else
    fail "compound stats no directory" "output: $(echo "$output" | head -3)"
fi

# =============================================================================
# Test 18: compound list 'ls' alias
# =============================================================================

log_test "compound ls alias works same as list"
output=$("$LOKI_CLI" compound ls 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "testing" && \
   echo "$output" | grep -q "security"; then
    pass "compound ls alias works"
else
    fail "compound ls alias" "output: $(echo "$output" | head -5)"
fi

# =============================================================================
# Test 19: compound unknown subcommand
# =============================================================================

log_test "compound unknown subcommand returns error"
exit_code=0
"$LOKI_CLI" compound foobar >/dev/null 2>&1 || exit_code=$?
output=$("$LOKI_CLI" compound foobar 2>&1 | strip_ansi || true)
if [ "$exit_code" -ne 0 ] && echo "$output" | grep -q "Unknown compound command: foobar"; then
    pass "compound unknown subcommand returns error"
else
    fail "compound unknown subcommand" "expected error, got exit=$exit_code"
fi

# =============================================================================
# Test 20: compound help shows categories list
# =============================================================================

log_test "compound help lists all 7 categories"
output=$("$LOKI_CLI" compound help 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "security" && \
   echo "$output" | grep -q "performance" && \
   echo "$output" | grep -q "architecture" && \
   echo "$output" | grep -q "testing" && \
   echo "$output" | grep -q "debugging" && \
   echo "$output" | grep -q "deployment" && \
   echo "$output" | grep -q "general"; then
    pass "compound help lists all 7 categories"
else
    fail "compound help categories" "missing one or more categories"
fi

# =============================================================================
# Test 21: compound show falls back to filename when title missing
# =============================================================================

log_test "compound show falls back to filename when no title in frontmatter"
mkdir -p "$TEST_HOME/.loki/solutions/general"
cat > "$TEST_HOME/.loki/solutions/general/no-frontmatter.md" << 'SOLUTION'
This file has no YAML frontmatter at all.

## Just a plain solution

Some content here.
SOLUTION

output=$("$LOKI_CLI" compound show general 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "no-frontmatter"; then
    pass "compound show falls back to filename when title missing"
else
    fail "compound show filename fallback" "output: $(echo "$output" | head -5)"
fi

# =============================================================================
# Test 22: compound search finds results across categories
# =============================================================================

log_test "compound search finds results across multiple categories"
output=$("$LOKI_CLI" compound search "Compounded from" 2>&1 | strip_ansi || true)
if echo "$output" | grep -q "Found: 2"; then
    pass "compound search finds results across categories"
else
    fail "compound search cross-category" "output: $(echo "$output" | head -5)"
fi

# Restore HOME before summary
export HOME="$REAL_HOME"

# =============================================================================
# Summary
# =============================================================================

echo ""
echo "========================================"
echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed (out of $TESTS_TOTAL)"
echo "========================================"

if [ "$TESTS_FAILED" -gt 0 ]; then
    exit 1
fi
exit 0
