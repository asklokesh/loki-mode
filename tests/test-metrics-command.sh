#!/usr/bin/env bash
# Test: loki metrics command
# Tests the session productivity reporter (v6.32.0)
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
echo "Loki Metrics Command Tests"
echo "========================================"
echo "CLI: $LOKI"
echo "VERSION: $(cat "$VERSION_FILE")"
echo ""

# Verify the loki script exists and is executable
if [ ! -x "$LOKI" ]; then
    echo -e "${RED}Error: $LOKI not found or not executable${NC}"
    exit 1
fi

# Create a temp dir for isolated testing
TMPDIR_BASE=$(mktemp -d /tmp/loki-test-metrics-XXXXXX)
ORIG_DIR="$(pwd)"
# INT/TERM as well as EXIT: a bare EXIT trap does not fire when the harness
# signals the test (local-ci does), and the /tmp dir then survives the run and
# trips the "no /tmp/loki-* leftovers" gate.
trap 'cd "$ORIG_DIR"; rm -rf "$TMPDIR_BASE"' EXIT INT TERM

# -------------------------------------------
# Test 1: Help flag works
# -------------------------------------------
test_cmd "loki metrics --help exits 0 and shows usage" \
    0 "Usage" metrics --help

# -------------------------------------------
# Test 2: Help mentions key flags
# -------------------------------------------
test_cmd "loki metrics --help mentions --json flag" \
    0 "json" metrics --help

# -------------------------------------------
# Test 3: Help mentions --save flag
# -------------------------------------------
test_cmd "loki metrics --help mentions --save flag" \
    0 "save" metrics --help

# -------------------------------------------
# Test 4: Help mentions --share flag
# -------------------------------------------
test_cmd "loki metrics --help mentions --share flag" \
    0 "share" metrics --help

# -------------------------------------------
# Test 5: Returns exit 0 on valid project (even without .loki/)
# -------------------------------------------
cd "$TMPDIR_BASE" || exit 1
((TOTAL++))
output=$("$LOKI" metrics 2>&1) || actual_exit=$?
actual_exit=${actual_exit:-0}
if [ "$actual_exit" -eq 0 ]; then
    if echo "$output" | grep -qi "PRODUCTIVITY REPORT"; then
        log_pass "loki metrics returns exit 0 and shows report header"
    else
        log_fail "loki metrics returns exit 0 and shows report header" "output missing PRODUCTIVITY REPORT"
        echo "  Actual output (first 5 lines):"
        echo "$output" | head -5 | sed 's/^/    /'
    fi
else
    log_fail "loki metrics returns exit 0 and shows report header" "exit code was $actual_exit"
fi
cd "$ORIG_DIR" || exit 1

# -------------------------------------------
# Test 6: JSON output is valid JSON
# -------------------------------------------
cd "$TMPDIR_BASE" || exit 1
((TOTAL++))
output=$("$LOKI" metrics --json 2>&1) || actual_exit=$?
actual_exit=${actual_exit:-0}
if [ "$actual_exit" -eq 0 ]; then
    if echo "$output" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
        log_pass "loki metrics --json produces valid JSON"
    else
        log_fail "loki metrics --json produces valid JSON" "invalid JSON output"
        echo "  Actual output (first 5 lines):"
        echo "$output" | head -5 | sed 's/^/    /'
    fi
else
    log_fail "loki metrics --json produces valid JSON" "exit code was $actual_exit"
fi
cd "$ORIG_DIR" || exit 1

# -------------------------------------------
# Test 7: --last N filters correctly (JSON check)
# -------------------------------------------
cd "$TMPDIR_BASE" || exit 1
((TOTAL++))
output=$("$LOKI" metrics --last 3 --json 2>&1) || actual_exit=$?
actual_exit=${actual_exit:-0}
if [ "$actual_exit" -eq 0 ]; then
    if echo "$output" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['sessions_analyzed'] <= 3" 2>/dev/null; then
        log_pass "loki metrics --last 3 limits sessions to 3 or fewer"
    else
        log_fail "loki metrics --last 3 limits sessions to 3 or fewer" "sessions_analyzed > 3"
    fi
else
    log_fail "loki metrics --last 3 limits sessions to 3 or fewer" "exit code was $actual_exit"
fi
cd "$ORIG_DIR" || exit 1

# -------------------------------------------
# Test 8: --save creates METRICS.md
# -------------------------------------------
cd "$TMPDIR_BASE" || exit 1
((TOTAL++))
"$LOKI" metrics --save >/dev/null 2>&1 || true
if [ -f "METRICS.md" ]; then
    if grep -qi "Loki Mode" METRICS.md; then
        log_pass "loki metrics --save creates METRICS.md with content"
    else
        log_fail "loki metrics --save creates METRICS.md with content" "METRICS.md exists but missing expected content"
    fi
else
    log_fail "loki metrics --save creates METRICS.md with content" "METRICS.md was not created"
fi
rm -f METRICS.md
cd "$ORIG_DIR" || exit 1

# -------------------------------------------
# Test 9: Works on empty .loki/ directory (shows zeros, does not crash)
# -------------------------------------------
cd "$TMPDIR_BASE" || exit 1
mkdir -p .loki
((TOTAL++))
output=$("$LOKI" metrics --json 2>&1) || actual_exit=$?
actual_exit=${actual_exit:-0}
if [ "$actual_exit" -eq 0 ]; then
    iterations=$(echo "$output" | python3 -c "import json,sys; print(json.load(sys.stdin)['agent_activity']['total_iterations'])" 2>/dev/null)
    if [ "$iterations" = "0" ]; then
        log_pass "loki metrics on empty .loki/ shows zero iterations"
    else
        log_fail "loki metrics on empty .loki/ shows zero iterations" "got iterations=$iterations"
    fi
else
    log_fail "loki metrics on empty .loki/ shows zero iterations" "exit code was $actual_exit"
fi
cd "$ORIG_DIR" || exit 1

# -------------------------------------------
# Test 10: Unknown option is rejected
# -------------------------------------------
test_cmd "loki metrics --bogus rejects unknown option" \
    1 "unknown option" metrics --bogus

# -------------------------------------------
# Test 11: Prometheus subcommand exists (fails gracefully without dashboard)
# -------------------------------------------
((TOTAL++))
output=$("$LOKI" metrics prometheus 2>&1) || actual_exit=$?
actual_exit=${actual_exit:-0}
if [ "$actual_exit" -eq 1 ]; then
    if echo "$output" | grep -qi "dashboard\|connect\|serve"; then
        log_pass "loki metrics prometheus fails gracefully without dashboard"
    else
        log_fail "loki metrics prometheus fails gracefully without dashboard" "unexpected error message"
    fi
else
    # Exit 0 means dashboard is actually running, which is fine
    log_pass "loki metrics prometheus fails gracefully without dashboard"
fi

# -------------------------------------------
# Test 12: Stats card mentions time saved
# -------------------------------------------
cd "$TMPDIR_BASE" || exit 1
test_cmd "loki metrics output includes TIME SAVED section" \
    0 "TIME SAVED" metrics
cd "$ORIG_DIR" || exit 1

# -------------------------------------------
# Summary
# -------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
