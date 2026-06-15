#!/usr/bin/env bash
# Test: cmd_start --allow-haiku flag parsing
#
# Regression for a real E2E bug: `loki start ./prd.md --allow-haiku` aborted with
# "Unknown option: --allow-haiku" even though loki --help and run.sh document the
# flag. Only LOKI_ALLOW_HAIKU=true worked. cmd_start now parses --allow-haiku,
# exports LOKI_ALLOW_HAIKU=true, and forwards the arg to run.sh (run.sh:15015).
#
# This test exercises the CLI interface only. It does not invoke the claude CLI:
# the start chain is bounded by `timeout` and we assert on the prereq-phase output
# (which run.sh reaches before any provider call) plus the help text.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_BIN="$PROJECT_DIR/autonomy/loki"
PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

TEST_DIR=$(mktemp -d)
cleanup() {
    # No process cleanup needed: this test never launches a real build (the
    # runtime check below aborts at provider validation, before any orchestrator
    # or provider CLI is spawned). A global `pkill -f loki-run-` here would be
    # unsafe -- it would kill unrelated loki runs on a shared/CI machine.
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

echo "========================================"
echo "CLI --allow-haiku Flag Tests"
echo "========================================"
echo "loki binary: $LOKI_BIN"
echo ""

# ===========================================
# Test 1: loki binary has valid bash syntax
# ===========================================
log_test "autonomy/loki has valid bash syntax"
if bash -n "$LOKI_BIN" 2>/dev/null; then
    log_pass "autonomy/loki parses"
else
    log_fail "autonomy/loki has a syntax error"
    exit 1
fi

# ===========================================
# Test 2: cmd_start has an --allow-haiku case (not the catch-all -*)
# ===========================================
log_test "cmd_start defines an --allow-haiku case"
if grep -qE '^[[:space:]]*--allow-haiku\)' "$LOKI_BIN"; then
    log_pass "--allow-haiku case present in autonomy/loki"
else
    log_fail "--allow-haiku case missing from autonomy/loki"
fi

# ===========================================
# Test 3: the --allow-haiku case exports LOKI_ALLOW_HAIKU=true
# ===========================================
log_test "--allow-haiku exports LOKI_ALLOW_HAIKU=true"
if awk '/^[[:space:]]*--allow-haiku\)/{f=1} f&&/export LOKI_ALLOW_HAIKU=true/{print;exit}' "$LOKI_BIN" | grep -q 'LOKI_ALLOW_HAIKU=true'; then
    log_pass "--allow-haiku exports LOKI_ALLOW_HAIKU=true"
else
    log_fail "--allow-haiku does not export LOKI_ALLOW_HAIKU=true"
fi

# ===========================================
# Test 4: cmd_start help documents --allow-haiku (flag and help agree)
# ===========================================
log_test "loki start --help documents --allow-haiku"
# Capture first, then grep the variable. Piping `loki start --help` directly into
# `grep -q` is unreliable under `set -o pipefail`: grep closes the pipe on first
# match, loki dies with SIGPIPE (141), and pipefail propagates that non-zero status
# even though the match succeeded.
help_out=$("$LOKI_BIN" start --help 2>&1)
if printf '%s' "$help_out" | grep -q -- '--allow-haiku'; then
    log_pass "help text documents --allow-haiku"
else
    log_fail "help text does not document --allow-haiku"
fi

# ===========================================
# Test 5: runtime parse proof -- the flag is ACCEPTED (no "Unknown option").
#
# This deliberately pairs --allow-haiku with an invalid --provider so cmd_start
# parses ALL flags (including --allow-haiku) and then aborts at provider
# validation with exit 1, BEFORE launching any orchestrator or provider CLI.
# That makes the assertion deterministic and side-effect-free: no real build,
# no paid model calls, no detached processes, no claude auth dependency.
# Before the fix this path printed "Unknown option: --allow-haiku" and aborted
# during arg parsing instead.
# ===========================================
log_test "loki start ./prd.md --allow-haiku is accepted (no Unknown option)"
printf '# Test PRD\nBuild a tiny thing.\n' > "$TEST_DIR/prd.md"
out=$(
    cd "$TEST_DIR" &&
    LOKI_AUTO_CONFIRM=true LOKI_DASHBOARD=false \
        "$LOKI_BIN" start ./prd.md --allow-haiku --provider loki_invalid_provider_xyz --no-dashboard --no-plan 2>&1
)

if printf '%s' "$out" | grep -q 'Unknown option'; then
    log_fail "start aborted with 'Unknown option' (flag rejected)"
    printf '%s\n' "$out" | grep 'Unknown option'
else
    log_pass "start did not reject --allow-haiku (parsed past the flag, aborted at provider validation)"
fi

# ===========================================
# Test 6: no real build was spawned by Test 5 (safety regression).
# The orchestrator stages its run script at /tmp/loki-run-*.sh and writes a
# build .loki tree; neither should exist for OUR invocation. We assert no
# orchestrator process is running against TEST_DIR.
# ===========================================
log_test "no orchestrator/provider process spawned for the test invocation"
if pgrep -f "loki-run-.*$TEST_DIR" >/dev/null 2>&1 || pgrep -f "start ./prd.md --allow-haiku --provider loki_invalid_provider_xyz" >/dev/null 2>&1; then
    log_fail "an orchestrator/provider process was spawned (should have aborted at provider validation)"
else
    log_pass "no build process spawned (aborted before orchestrator launch)"
fi

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
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
