#!/usr/bin/env bash
# Test: loki share command
# Tests the session report sharing via GitHub Gist (v6.30.0)
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
        # -E so a pattern can offer alternatives. Some preconditions are
        # checked in an order that depends on the machine (e.g. gh auth before
        # the .loki probe), and the contract under test is "fails gracefully",
        # not "fails for this exact reason".
        if ! echo "$output" | grep -qiE "$pattern"; then
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
echo "Loki Share Command Tests"
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
TMPDIR_BASE=$(mktemp -d /tmp/loki-test-share-XXXXXX)
ORIG_DIR="$(pwd)"
trap 'cd "$ORIG_DIR"; rm -rf "$TMPDIR_BASE"' EXIT

# -------------------------------------------
# Test 1: Command exists and help shows
# -------------------------------------------
test_cmd "loki share --help exits 0 and shows usage" \
    0 "Usage" share --help

# -------------------------------------------
# Test 2: Help mentions --private flag
# -------------------------------------------
test_cmd "loki share --help mentions --private flag" \
    0 "private" share --help

# -------------------------------------------
# Test 3: Help mentions --format flag
# -------------------------------------------
test_cmd "loki share --help mentions --format flag" \
    0 "format" share --help

# -------------------------------------------
# Test 4: Help mentions gh CLI requirement
# -------------------------------------------
test_cmd "loki share --help mentions gh CLI" \
    0 "gh" share --help

# -------------------------------------------
# Test 5: --format text is accepted (fails gracefully without .loki)
# -------------------------------------------
cd "$TMPDIR_BASE" || exit 1
# The assertion is GRACEFUL FAILURE (exit 1 + an actionable message), not which
# precondition trips first. `gh auth status` is checked before the .loki probe
# (autonomy/loki:31717 vs :31727), so on a machine with an authenticated gh the
# user sees "No .loki/ directory found", and on CI -- where gh is not
# authenticated -- they see "GitHub CLI not authenticated" and a fix command.
# Both are correct. Pinning the message to one of them made this a test of the
# runner's gh login rather than of the command.
test_cmd "loki share --format text fails gracefully without .loki/" \
    1 "no \.loki|not authenticated" share --format text
cd "$ORIG_DIR" || exit 1

# -------------------------------------------
# Test 6: --private flag is accepted (fails gracefully without .loki)
# -------------------------------------------
cd "$TMPDIR_BASE" || exit 1
test_cmd "loki share --private fails gracefully without .loki/" \
    1 "no \.loki|not authenticated" share --private
cd "$ORIG_DIR" || exit 1

# -------------------------------------------
# Test 7: Invalid format is rejected
# -------------------------------------------
cd "$TMPDIR_BASE" || exit 1
mkdir -p .loki
test_cmd "loki share --format invalid rejects unknown format" \
    1 "unknown format" share --format invalid
cd "$ORIG_DIR" || exit 1

# -------------------------------------------
# Test 8: Unknown option is rejected
# -------------------------------------------
test_cmd "loki share --bogus rejects unknown option" \
    1 "unknown option" share --bogus

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
