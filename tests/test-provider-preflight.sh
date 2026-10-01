#!/usr/bin/env bash
# Test: Explicit-provider pre-flight in cmd_start (autonomy/loki)
#
# WHAT THIS GUARDS. `--provider codex` on a machine where only claude is
# installed used to sail past provider_offer_gate (which passes when ANY
# provider is on PATH) and fail much later in the runner. The correctness
# requirement is that an explicit choice which cannot be honoured is an ERROR,
# never a silent substitution -- running a different model than the user asked
# for is worse than failing.
#
# HOW IT TESTS. It EXECUTES autonomy/loki with a hermetic PATH containing only
# stub binaries we create, so the result does not depend on what happens to be
# installed on the host. It does NOT source the script: the call site is part of
# what is under test, and a sourced-function test would leave it unproven.

set -uo pipefail
# Note: Not using -e to allow collecting all test results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_BIN="$REPO_DIR/autonomy/loki"
PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/test-provider-preflight.XXXXXX")
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

# run_loki <stub-dir-name> <fake-binaries...> -- <loki args...>
#
# Builds a hermetic PATH holding ONLY the named fake provider binaries plus the
# system dirs loki needs for coreutils, then runs `loki start ...` from a scratch
# cwd with its own LOKI_DIR so nothing touches this repo's .loki.
#
# Output is captured with 2>&1 on purpose: loki mixes stdout and stderr for
# these messages, and a stdout-only capture would be a silent false green.
#
# _PF_ENV_PROVIDER (default empty) drives LOKI_PROVIDER in the child, so the
# env-var route into "explicitly chosen" is covered as well as the flag.
RUN_OUT=""
RUN_RC=0
_PF_ENV_PROVIDER=""
run_loki() {
    local case_name="$1"; shift
    local stubs=()
    while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
        stubs+=("$1"); shift
    done
    shift  # drop the --

    local case_dir="$TMP_ROOT/$case_name"
    local bin_dir="$case_dir/bin"
    mkdir -p "$bin_dir" "$case_dir/work"

    local s
    for s in ${stubs[@]+"${stubs[@]}"}; do
        printf '#!/bin/sh\nexit 0\n' > "$bin_dir/$s"
        chmod +x "$bin_dir/$s"
    done

    RUN_OUT=$(
        cd "$case_dir/work" || exit 1
        PATH="$bin_dir:/usr/bin:/bin:/usr/sbin:/sbin" \
        LOKI_DIR="$case_dir/work/.loki" \
        LOKI_PROVIDER="${_PF_ENV_PROVIDER:-}" \
        CI=1 \
            bash "$LOKI_BIN" "$@" 2>&1
    )
    RUN_RC=$?
}

echo "========================================"
echo "Explicit Provider Pre-flight Tests"
echo "========================================"
echo "loki: $LOKI_BIN"
echo ""

# ===========================================
# Test 1: explicit uninstalled provider fails non-zero and names the provider
# ===========================================
log_test "explicit uninstalled provider (--provider codex, only claude present)"
run_loki "uninstalled" claude -- start --provider codex --yes

# Vacuity guard: a negative grep over EMPTY output passes for the wrong reason.
# Assert we got real output and a real failure BEFORE asserting any absence.
if [ -z "$RUN_OUT" ]; then
    log_fail "no output captured -- every assertion below would be vacuous"
elif [ "$RUN_RC" -eq 0 ]; then
    log_fail "expected non-zero exit for an uninstalled explicit provider, got 0"
else
    log_pass "exits non-zero (rc=$RUN_RC) for an uninstalled explicit provider"
fi

if echo "$RUN_OUT" | grep -q "codex" && echo "$RUN_OUT" | grep -qi "not installed"; then
    log_pass "message names the missing provider and says it is not installed"
else
    log_fail "message must name 'codex' and say it is not installed. Got: $RUN_OUT"
fi

if echo "$RUN_OUT" | grep -q "Installed providers on this machine:.*claude"; then
    log_pass "message lists the installed alternatives (claude)"
else
    log_fail "message must list installed alternatives. Got: $RUN_OUT"
fi

# ===========================================
# Test 2: no silent substitution -- the chosen name never changes
# ===========================================
log_test "no silent substitution to an installed provider"
# The run must never have reached the start path. Those lines are the tell:
# cmd_start prints "Starting Loki Mode..." and "Provider: <name>" only once it
# has committed to running.
if echo "$RUN_OUT" | grep -q "Starting Loki Mode"; then
    log_fail "reached the start path instead of failing on the explicit provider"
elif echo "$RUN_OUT" | grep -qE "^.*Provider:.*claude"; then
    log_fail "substituted claude for the requested codex"
else
    log_pass "did not start, and did not substitute a different provider"
fi

# ===========================================
# Test 3: no provider installed at all -- says so plainly
# ===========================================
log_test "explicit provider with NO provider installed at all"
run_loki "none" -- start --provider codex --yes

if [ "$RUN_RC" -ne 0 ] && echo "$RUN_OUT" | grep -q "No supported provider CLI is installed"; then
    log_pass "states plainly that no provider is installed, exits non-zero (rc=$RUN_RC)"
else
    log_fail "expected a plain 'no provider installed' message. rc=$RUN_RC out: $RUN_OUT"
fi

# ===========================================
# Test 3b: LOKI_PROVIDER is "explicit" too, not just the --provider flag
# ===========================================
log_test "LOKI_PROVIDER=codex (env var route) with only claude installed"
_PF_ENV_PROVIDER=codex run_loki "envvar" claude -- start --yes
_PF_ENV_PROVIDER=""

if [ -n "$RUN_OUT" ] && [ "$RUN_RC" -ne 0 ] \
    && echo "$RUN_OUT" | grep -q "codex" \
    && echo "$RUN_OUT" | grep -q "Installed providers on this machine:.*claude" \
    && ! echo "$RUN_OUT" | grep -q "Starting Loki Mode"; then
    log_pass "LOKI_PROVIDER route fails the same way (rc=$RUN_RC), no substitution"
else
    log_fail "LOKI_PROVIDER=codex must fail like --provider codex. rc=$RUN_RC out: $RUN_OUT"
fi

# ===========================================
# Test 4: explicit INSTALLED provider passes the guard untouched
# ===========================================
# The opposite direction: an over-strict guard that blocks a VALID run is just
# as broken. We point at a nonexistent PRD so the run terminates on that instead
# of exec'ing the runner; reaching the PRD error proves the provider guard let
# it through.
log_test "explicit INSTALLED provider is not blocked"
run_loki "installed" claude -- start --prd "$TMP_ROOT/does-not-exist.md" --provider claude --yes

if echo "$RUN_OUT" | grep -q "you asked for provider"; then
    log_fail "provider pre-flight wrongly blocked an INSTALLED provider. Got: $RUN_OUT"
elif echo "$RUN_OUT" | grep -q "PRD file not found"; then
    log_pass "installed provider passes through (run proceeded to the PRD check)"
else
    log_fail "expected to reach the PRD check. rc=$RUN_RC out: $RUN_OUT"
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
