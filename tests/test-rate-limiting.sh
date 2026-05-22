#!/usr/bin/env bash
# shellcheck disable=SC2034  # Variables may be unused in test context
# shellcheck disable=SC2155  # Declare and assign separately
# shellcheck disable=SC2329  # Unreachable code in test functions
# Test suite for rate limiting functions in autonomy/run.sh
# Tests: is_rate_limited, parse_claude_reset_time, parse_retry_after,
#        calculate_rate_limit_backoff, detect_rate_limit, format_duration

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUN_SH="$PROJECT_ROOT/autonomy/run.sh"

# Create temp directory for test files
TEMP_DIR=$(mktemp -d)
# shellcheck disable=SC2064
trap "rm -rf $TEMP_DIR" EXIT

log_test() {
    echo -e "${YELLOW}[TEST]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    PASSED=$((PASSED + 1))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    FAILED=$((FAILED + 1))
}

# Extract functions from run.sh for testing
# We need to source specific functions without running the whole script
extract_functions() {
    # Extract rate limiting functions
    sed -n '/^is_rate_limited()/,/^}/p' "$RUN_SH"
    sed -n '/^parse_claude_reset_time()/,/^}/p' "$RUN_SH"
    sed -n '/^parse_retry_after()/,/^}/p' "$RUN_SH"
    sed -n '/^calculate_rate_limit_backoff()/,/^}/p' "$RUN_SH"
    sed -n '/^detect_rate_limit()/,/^}/p' "$RUN_SH"
    sed -n '/^format_duration()/,/^}/p' "$RUN_SH"
    # Add log_debug stub
    echo 'log_debug() { :; }'
}

# Source the extracted functions
eval "$(extract_functions)"

echo "========================================"
echo "Rate Limiting Function Tests"
echo "========================================"
echo ""

#===============================================================================
# Test: is_rate_limited()
#===============================================================================

log_test "is_rate_limited() detects HTTP 429"
echo "HTTP/1.1 429 Too Many Requests" > "$TEMP_DIR/test1.log"
if is_rate_limited "$TEMP_DIR/test1.log"; then
    log_pass "Detected 429 status code"
else
    log_fail "Failed to detect 429 status code"
fi

log_test "is_rate_limited() detects 'rate limit' (lowercase)"
echo "Error: rate limit exceeded" > "$TEMP_DIR/test2.log"
if is_rate_limited "$TEMP_DIR/test2.log"; then
    log_pass "Detected 'rate limit' text"
else
    log_fail "Failed to detect 'rate limit' text"
fi

log_test "is_rate_limited() detects 'Rate Limit' (mixed case)"
echo "Error: Rate Limit Exceeded" > "$TEMP_DIR/test3.log"
if is_rate_limited "$TEMP_DIR/test3.log"; then
    log_pass "Detected 'Rate Limit' text (case insensitive)"
else
    log_fail "Failed to detect 'Rate Limit' text"
fi

log_test "is_rate_limited() detects 'rate-limit' (hyphenated)"
echo "X-RateLimit-Remaining: 0" > "$TEMP_DIR/test4.log"
if is_rate_limited "$TEMP_DIR/test4.log"; then
    log_pass "Detected 'rate-limit' (hyphenated)"
else
    log_fail "Failed to detect 'rate-limit' (hyphenated)"
fi

log_test "is_rate_limited() detects 'too many requests'"
echo "Error: too many requests" > "$TEMP_DIR/test5.log"
if is_rate_limited "$TEMP_DIR/test5.log"; then
    log_pass "Detected 'too many requests'"
else
    log_fail "Failed to detect 'too many requests'"
fi

log_test "is_rate_limited() detects 'quota exceeded'"
echo "API quota exceeded for project" > "$TEMP_DIR/test6.log"
if is_rate_limited "$TEMP_DIR/test6.log"; then
    log_pass "Detected 'quota exceeded'"
else
    log_fail "Failed to detect 'quota exceeded'"
fi

log_test "is_rate_limited() detects 'retry-after' header"
echo "Retry-After: 60" > "$TEMP_DIR/test7.log"
if is_rate_limited "$TEMP_DIR/test7.log"; then
    log_pass "Detected 'Retry-After' header"
else
    log_fail "Failed to detect 'Retry-After' header"
fi

log_test "is_rate_limited() detects Claude 'resets Xam' format"
echo "Rate limit exceeded, resets 4am" > "$TEMP_DIR/test8.log"
if is_rate_limited "$TEMP_DIR/test8.log"; then
    log_pass "Detected Claude 'resets 4am' format"
else
    log_fail "Failed to detect Claude 'resets 4am' format"
fi

log_test "is_rate_limited() returns false for normal output"
echo "Request completed successfully" > "$TEMP_DIR/test9.log"
if is_rate_limited "$TEMP_DIR/test9.log"; then
    log_fail "False positive on normal output"
else
    log_pass "Correctly returned false for normal output"
fi

log_test "is_rate_limited() handles non-existent file"
if is_rate_limited "$TEMP_DIR/nonexistent.log"; then
    log_fail "Should return false for non-existent file"
else
    log_pass "Correctly returns false for non-existent file"
fi

log_test "is_rate_limited() handles empty file"
touch "$TEMP_DIR/empty.log"
if is_rate_limited "$TEMP_DIR/empty.log"; then
    log_fail "Should return false for empty file"
else
    log_pass "Correctly returns false for empty file"
fi

#===============================================================================
# Test: parse_retry_after()
#===============================================================================

log_test "parse_retry_after() parses 'Retry-After: 60'"
echo "Retry-After: 60" > "$TEMP_DIR/retry1.log"
result=$(parse_retry_after "$TEMP_DIR/retry1.log")
if [ "$result" -eq 60 ]; then
    log_pass "Parsed Retry-After: 60 correctly"
else
    log_fail "Expected 60, got $result"
fi

log_test "parse_retry_after() parses 'retry-after: 120' (lowercase)"
echo "retry-after: 120" > "$TEMP_DIR/retry2.log"
result=$(parse_retry_after "$TEMP_DIR/retry2.log")
if [ "$result" -eq 120 ]; then
    log_pass "Parsed lowercase retry-after correctly"
else
    log_fail "Expected 120, got $result"
fi

log_test "parse_retry_after() returns 0 when not found"
echo "Normal response" > "$TEMP_DIR/retry3.log"
result=$(parse_retry_after "$TEMP_DIR/retry3.log")
if [ "$result" -eq 0 ]; then
    log_pass "Returns 0 when header not found"
else
    log_fail "Expected 0, got $result"
fi

log_test "parse_retry_after() uses last value if multiple"
echo -e "Retry-After: 30\nRetry-After: 90" > "$TEMP_DIR/retry4.log"
result=$(parse_retry_after "$TEMP_DIR/retry4.log")
if [ "$result" -eq 90 ]; then
    log_pass "Uses last Retry-After value"
else
    log_fail "Expected 90 (last value), got $result"
fi

#===============================================================================
# Test: calculate_rate_limit_backoff()
#===============================================================================

log_test "calculate_rate_limit_backoff() with default RPM (50)"
unset PROVIDER_RATE_LIMIT_RPM
result=$(calculate_rate_limit_backoff)
# 120 * 60 / 50 = 144, should be clamped
if [ "$result" -ge 60 ] && [ "$result" -le 300 ]; then
    log_pass "Default backoff within bounds: $result seconds"
else
    log_fail "Backoff out of bounds: $result (expected 60-300)"
fi

log_test "calculate_rate_limit_backoff() with RPM=60"
PROVIDER_RATE_LIMIT_RPM=60
result=$(calculate_rate_limit_backoff)
# 120 * 60 / 60 = 120
if [ "$result" -eq 120 ]; then
    log_pass "Calculated 120 seconds for 60 RPM"
else
    log_fail "Expected 120, got $result"
fi

log_test "calculate_rate_limit_backoff() minimum clamp (high RPM)"
PROVIDER_RATE_LIMIT_RPM=500
result=$(calculate_rate_limit_backoff)
# 120 * 60 / 500 = 14.4, should clamp to 60
if [ "$result" -eq 60 ]; then
    log_pass "Correctly clamped to minimum 60 seconds"
else
    log_fail "Expected minimum 60, got $result"
fi

log_test "calculate_rate_limit_backoff() maximum clamp (low RPM)"
PROVIDER_RATE_LIMIT_RPM=10
result=$(calculate_rate_limit_backoff)
# 120 * 60 / 10 = 720, should clamp to 300
if [ "$result" -eq 300 ]; then
    log_pass "Correctly clamped to maximum 300 seconds"
else
    log_fail "Expected maximum 300, got $result"
fi

#===============================================================================
# Test: format_duration()
#===============================================================================

log_test "format_duration() formats 60 seconds"
result=$(format_duration 60)
if [ "$result" = "1m" ]; then
    log_pass "60 seconds = 1m"
else
    log_fail "Expected '1m', got '$result'"
fi

log_test "format_duration() formats 3600 seconds"
result=$(format_duration 3600)
if [ "$result" = "1h 0m" ]; then
    log_pass "3600 seconds = 1h 0m"
else
    log_fail "Expected '1h 0m', got '$result'"
fi

log_test "format_duration() formats 3660 seconds"
result=$(format_duration 3660)
if [ "$result" = "1h 1m" ]; then
    log_pass "3660 seconds = 1h 1m"
else
    log_fail "Expected '1h 1m', got '$result'"
fi

log_test "format_duration() formats 30 seconds"
result=$(format_duration 30)
if [ "$result" = "0m" ]; then
    log_pass "30 seconds = 0m"
else
    log_fail "Expected '0m', got '$result'"
fi

log_test "format_duration() formats 7320 seconds"
result=$(format_duration 7320)
if [ "$result" = "2h 2m" ]; then
    log_pass "7320 seconds = 2h 2m"
else
    log_fail "Expected '2h 2m', got '$result'"
fi

#===============================================================================
# Test: detect_rate_limit() integration
#===============================================================================

log_test "detect_rate_limit() returns 0 for normal output"
PROVIDER_NAME="claude"
echo "Success" > "$TEMP_DIR/detect1.log"
result=$(detect_rate_limit "$TEMP_DIR/detect1.log")
if [ "$result" -eq 0 ]; then
    log_pass "Returns 0 when no rate limit"
else
    log_fail "Expected 0, got $result"
fi

log_test "detect_rate_limit() uses Retry-After when present"
PROVIDER_NAME="codex"
echo -e "Error: rate limit exceeded\nRetry-After: 75" > "$TEMP_DIR/detect2.log"
result=$(detect_rate_limit "$TEMP_DIR/detect2.log")
if [ "$result" -eq 75 ]; then
    log_pass "Used Retry-After value: 75 seconds"
else
    log_fail "Expected 75 from Retry-After, got $result"
fi

log_test "detect_rate_limit() falls back to calculated backoff"
# v7.5.18: gemini removed; use aider (also Tier 3 degraded).
PROVIDER_NAME="aider"
PROVIDER_RATE_LIMIT_RPM=60
echo "Error: 429 rate limited" > "$TEMP_DIR/detect3.log"
result=$(detect_rate_limit "$TEMP_DIR/detect3.log")
# Should use calculate_rate_limit_backoff since no Retry-After
if [ "$result" -eq 120 ]; then
    log_pass "Fell back to calculated backoff: 120 seconds"
else
    log_fail "Expected calculated 120, got $result"
fi

#===============================================================================
# Summary
#===============================================================================

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
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
