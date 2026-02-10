#!/bin/bash
# Test: Loki CLI Commands
# Tests non-destructive CLI commands that are safe to run without an active session.
# These verify exit codes and expected output patterns.
#
# Note: Not using -e to allow collecting all test results

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"
VERSION_FILE="$SCRIPT_DIR/../VERSION"

PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; ((FAIL++)); }

# Run a CLI command, check exit code and optionally grep for expected output
# Usage: test_cmd "description" expected_exit_code "grep_pattern" args...
test_cmd() {
    local desc="$1"
    local expected_exit="$2"
    local pattern="$3"
    shift 3

    ((TOTAL++))

    local output
    local actual_exit=0
    output=$("$LOKI" "$@" 2>&1) || actual_exit=$?

    if [ "$actual_exit" -ne "$expected_exit" ]; then
        log_fail "$desc" "expected exit $expected_exit, got $actual_exit"
        return 0
    fi

    if [ -n "$pattern" ]; then
        if ! echo "$output" | grep -qi "$pattern"; then
            log_fail "$desc" "output missing pattern: $pattern"
            echo "  Actual output (first 5 lines):"
            echo "$output" | head -5 | sed 's/^/    /'
            return 0
        fi
    fi

    log_pass "$desc"
    return 0
}

echo "========================================"
echo "Loki CLI Command Tests"
echo "========================================"
echo "CLI: $LOKI"
echo "VERSION: $(cat "$VERSION_FILE")"
echo ""

# Verify the loki script exists and is executable
if [ ! -x "$LOKI" ]; then
    echo -e "${RED}Error: $LOKI not found or not executable${NC}"
    exit 1
fi

EXPECTED_VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')

# -------------------------------------------
# Test: loki help
# -------------------------------------------
test_cmd "loki help exits 0 and shows Usage" \
    0 "Usage" help

# -------------------------------------------
# Test: loki --help
# -------------------------------------------
test_cmd "loki --help exits 0 and shows Usage" \
    0 "Usage" --help

# -------------------------------------------
# Test: loki version
# -------------------------------------------
test_cmd "loki version exits 0 and shows version" \
    0 "$EXPECTED_VERSION" version

# -------------------------------------------
# Test: loki --version
# -------------------------------------------
test_cmd "loki --version exits 0 and shows version" \
    0 "$EXPECTED_VERSION" --version

# -------------------------------------------
# Test: loki status
# -------------------------------------------
test_cmd "loki status exits 0" \
    0 "" status

# -------------------------------------------
# Test: loki config show
# -------------------------------------------
test_cmd "loki config show exits 0 and shows Configuration" \
    0 "Configuration" config show

# -------------------------------------------
# Test: loki config path
# -------------------------------------------
test_cmd "loki config path exits 0" \
    0 "" config path

# -------------------------------------------
# Test: loki memory list
# -------------------------------------------
test_cmd "loki memory list exits 0 and shows Learnings" \
    0 "Learnings" memory list

# -------------------------------------------
# Test: loki compound list
# -------------------------------------------
test_cmd "loki compound list exits 0 and shows Solutions" \
    0 "Solutions" compound list

# -------------------------------------------
# Test: loki provider list
# -------------------------------------------
test_cmd "loki provider list exits 0 and shows claude" \
    0 "claude" provider list

# -------------------------------------------
# Test: loki provider show
# -------------------------------------------
test_cmd "loki provider show exits 0 and shows provider" \
    0 "provider" provider show

# -------------------------------------------
# Test: loki completions bash
# -------------------------------------------
test_cmd "loki completions bash exits 0 and shows complete" \
    0 "complete" completions bash

# -------------------------------------------
# Test: loki completions zsh
# -------------------------------------------
test_cmd "loki completions zsh exits 0 and shows compdef" \
    0 "compdef" completions zsh

# -------------------------------------------
# Test: unknown command exits non-zero
# -------------------------------------------
test_cmd "loki unknown-command exits 1" \
    1 "Unknown command" nonexistent-command-xyz

# -------------------------------------------
# Summary
# -------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (out of $TOTAL)"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
