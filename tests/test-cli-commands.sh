#!/usr/bin/env bash
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
        # Case-insensitive substring check done in-shell (no pipe). Piping into
        # `grep -q` races: grep exits on first match and closes the pipe, so the
        # upstream `echo` is killed by SIGPIPE ("write error: Broken pipe"), and
        # on a loaded CI runner that broken-pipe exit can be misread as no-match.
        # A bash glob match has no subprocess and no pipe, so it is race-free.
        local hay_lc pat_lc
        hay_lc=$(printf '%s' "$output" | tr '[:upper:]' '[:lower:]')
        pat_lc=$(printf '%s' "$pattern" | tr '[:upper:]' '[:lower:]')
        case "$hay_lc" in
            *"$pat_lc"*) ;;
            *)
                log_fail "$desc" "output missing pattern: $pattern"
                echo "  Actual output (first 5 lines):"
                printf '%s\n' "$output" | head -5 | sed 's/^/    /'
                return 0
                ;;
        esac
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
# Test: loki preview --help
# -------------------------------------------
test_cmd "loki preview --help exits 0 and shows Usage" \
    0 "Usage: loki preview" preview --help

# -------------------------------------------
# Test: loki preview with no running app (honest message, exit 0)
# Run against an ISOLATED empty LOKI_DIR so the assertion is deterministic and
# does not depend on a stray .loki/app-runner/state.json in the test cwd (the
# command reads ${LOKI_DIR:-.loki}/app-runner/state.json).
# -------------------------------------------
_PREVIEW_TMP=$(mktemp -d 2>/dev/null || echo "/tmp/loki-preview-test-$$")
mkdir -p "$_PREVIEW_TMP"
LOKI_DIR="$_PREVIEW_TMP" test_cmd "loki preview --no-open exits 0 with no app running" \
    0 "No app running" preview --no-open
rm -rf "$_PREVIEW_TMP"

# -------------------------------------------
# Test: loki spec --help
# -------------------------------------------
test_cmd "loki spec --help exits 0 and shows the living-spec usage" \
    0 "the living spec" spec --help

# -------------------------------------------
# Test: loki spec status with no spec present -> usage error exit 2.
# Run in an ISOLATED empty dir so no stray prd.md/.loki is picked up.
# -------------------------------------------
_SPEC_TMP=$(mktemp -d 2>/dev/null || echo "/tmp/loki-spec-test-$$")
mkdir -p "$_SPEC_TMP"
( cd "$_SPEC_TMP" && "$LOKI" spec status >/dev/null 2>&1; [ "$?" -eq 2 ] ) \
    && { echo -e "${GREEN}[PASS]${NC} loki spec status with no spec exits 2 (usage)"; ((PASS++)); } \
    || { echo -e "${RED}[FAIL]${NC} loki spec status with no spec -- expected exit 2"; ((FAIL++)); }
((TOTAL++))
rm -rf "$_SPEC_TMP"

# -------------------------------------------
# Test: loki grill --help
# -------------------------------------------
test_cmd "loki grill --help exits 0 and shows the interrogation usage" \
    0 "interrogate a spec" grill --help

# -------------------------------------------
# Test: loki grill with no spec present -> usage error exit 2.
# -------------------------------------------
_GRILL_TMP=$(mktemp -d 2>/dev/null || echo "/tmp/loki-grill-test-$$")
mkdir -p "$_GRILL_TMP"
( cd "$_GRILL_TMP" && "$LOKI" grill >/dev/null 2>&1; [ "$?" -eq 2 ] ) \
    && { echo -e "${GREEN}[PASS]${NC} loki grill with no spec exits 2 (usage)"; ((PASS++)); } \
    || { echo -e "${RED}[FAIL]${NC} loki grill with no spec -- expected exit 2"; ((FAIL++)); }
((TOTAL++))

# -------------------------------------------
# Test: loki grill with an unavailable provider -> clean error exit 3.
# Uses a bogus LOKI_PROVIDER so the failure is deterministic regardless of
# whether the claude CLI is installed on the runner. Honest no-provider path:
# never a silent success, never fabricated questions.
# -------------------------------------------
printf '# Spec\n## Feature\nDo a thing.\n' > "$_GRILL_TMP/prd.md"
( cd "$_GRILL_TMP" && LOKI_PROVIDER=bogus "$LOKI" grill prd.md >/dev/null 2>&1; [ "$?" -eq 3 ] ) \
    && { echo -e "${GREEN}[PASS]${NC} loki grill with an unavailable provider exits 3 (clean error)"; ((PASS++)); } \
    || { echo -e "${RED}[FAIL]${NC} loki grill unavailable provider -- expected exit 3"; ((FAIL++)); }
((TOTAL++))
rm -rf "$_GRILL_TMP"

# -------------------------------------------
# Test: loki open alias --help routes to preview
# -------------------------------------------
test_cmd "loki open --help exits 0 and shows preview usage" \
    0 "Usage: loki preview" open --help

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
