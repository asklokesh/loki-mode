#!/usr/bin/env bash
#===============================================================================
# Healing Test-Gate Fail-Closed Tests
#
# Regression coverage for the fail-open bug where detect_test_command returned
# a command that exits 0 ("echo 'No test command detected...'") when no test
# framework was detected and LOKI_TEST_COMMAND was unset. The healing phase
# gate (hook_healing_phase_gate) does `if ! eval "$test_cmd"; then BLOCK`, so an
# exit-0 command meant "no tests exist" was silently treated as "tests passed",
# defeating the behavioral-preservation guarantee.
#
# Three states must be distinguished in healing mode:
#   (a) tests ran and PASSED      -> ALLOW
#   (b) tests ran and FAILED      -> BLOCK
#   (c) no tests available        -> BLOCK (with actionable message)
#
# Outside healing mode the prior fail-open behavior is preserved (verified via
# detect_test_command not emitting the sentinel when LOKI_HEAL_MODE != true).
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [PASS] $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    [[ -n "${2:-}" ]] && echo "         $2"
}

echo "Healing Test-Gate Fail-Closed Tests"
echo "==================================="
echo ""

# Source the hooks. The file uses `set -euo pipefail`; we disable errexit
# locally so a non-zero return from a BLOCKED gate does not abort this script.
# shellcheck disable=SC1090
source "$PROJECT_DIR/autonomy/hooks/migration-hooks.sh"
set +e

# Each scenario uses a throwaway empty codebase so no test framework is
# detected. The stabilize:isolate transition gates ONLY on the test command
# (archaeology:stabilize additionally requires friction-map + institutional
# knowledge, which would confound the assertion), so we use it for the clean
# three-state isolation.

# -----------------------------------------------------------------------
# State (c): no tests available, healing mode -> BLOCK
# -----------------------------------------------------------------------
echo "Test 1: no test command + healing mode -> gate BLOCKS"
TMP_C="$(mktemp -d)"
out=""
if out=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP_C" LOKI_TEST_COMMAND="" \
    hook_healing_phase_gate "stabilize" "isolate" 2>&1); then
    fail "gate should BLOCK when no test command is available" "got exit 0; output: $out"
else
    if echo "$out" | grep -q "GATE_BLOCKED: no test command available; set LOKI_TEST_COMMAND"; then
        pass "gate BLOCKED with actionable no-test-command message"
    else
        fail "gate blocked but message wrong" "output: $out"
    fi
fi
rm -rf "$TMP_C"

# -----------------------------------------------------------------------
# State (a): test command set + PASSES -> ALLOW
# -----------------------------------------------------------------------
echo "Test 2: passing test command + healing mode -> gate ALLOWS"
TMP_A="$(mktemp -d)"
if LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP_A" LOKI_TEST_COMMAND="true" \
    hook_healing_phase_gate "stabilize" "isolate" >/dev/null 2>&1; then
    pass "gate ALLOWED when test command passes"
else
    fail "gate should ALLOW when test command passes"
fi
rm -rf "$TMP_A"

# -----------------------------------------------------------------------
# State (b): test command set + FAILS -> BLOCK
# -----------------------------------------------------------------------
echo "Test 3: failing test command + healing mode -> gate BLOCKS"
TMP_B="$(mktemp -d)"
out=""
if out=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP_B" LOKI_TEST_COMMAND="false" \
    hook_healing_phase_gate "stabilize" "isolate" 2>&1); then
    fail "gate should BLOCK when test command fails" "got exit 0; output: $out"
else
    if echo "$out" | grep -q "GATE_BLOCKED: Tests do not pass after stabilization"; then
        pass "gate BLOCKED with tests-failed message (distinct from no-test-command)"
    else
        fail "gate blocked but message wrong" "output: $out"
    fi
fi
rm -rf "$TMP_B"

# -----------------------------------------------------------------------
# State (c) at the modernize:validate transition too (all four gated sites)
# -----------------------------------------------------------------------
echo "Test 4: no test command + healing mode at modernize:validate -> BLOCKS"
TMP_C2="$(mktemp -d)"
out=""
if out=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP_C2" LOKI_TEST_COMMAND="" \
    hook_healing_phase_gate "modernize" "validate" 2>&1); then
    fail "modernize:validate should BLOCK with no test command" "output: $out"
else
    if echo "$out" | grep -q "GATE_BLOCKED: no test command available"; then
        pass "modernize:validate BLOCKED with no test command"
    else
        fail "blocked but message wrong" "output: $out"
    fi
fi
rm -rf "$TMP_C2"

# -----------------------------------------------------------------------
# post_healing_modify: no tests + healing -> BLOCK, no git revert attempted
# -----------------------------------------------------------------------
echo "Test 5: post_healing_modify + no test command + healing -> BLOCKS"
TMP_M="$(mktemp -d)"
out=""
if out=$(LOKI_HEAL_MODE=true LOKI_CODEBASE_PATH="$TMP_M" LOKI_TEST_COMMAND="" \
    hook_post_healing_modify "some/file.py" 2>&1); then
    fail "post_healing_modify should BLOCK when no test command" "output: $out"
else
    if echo "$out" | grep -q "HOOK_BLOCKED: no test command available; set LOKI_TEST_COMMAND"; then
        pass "post_healing_modify BLOCKED with actionable message"
    else
        fail "blocked but message wrong" "output: $out"
    fi
fi
rm -rf "$TMP_M"

# -----------------------------------------------------------------------
# Non-healing preservation: detect_test_command stays fail-open (exit-0 cmd)
# when LOKI_HEAL_MODE != true and no framework is detected.
# -----------------------------------------------------------------------
echo "Test 6: non-healing mode preserves fail-open detect_test_command"
TMP_N="$(mktemp -d)"
cmd="$(LOKI_TEST_COMMAND="" detect_test_command "$TMP_N")"
if is_no_test_cmd "$cmd"; then
    fail "non-healing mode must NOT emit the fail-closed sentinel" "got: $cmd"
else
    # The legacy fail-open command must still exit 0 (harmless echo), so the
    # three non-healing consumers keep their prior behavior.
    if eval "$cmd" >/dev/null 2>&1; then
        pass "non-healing detect_test_command returns an exit-0 command (fail-open preserved)"
    else
        fail "non-healing fail-open command unexpectedly exits non-zero" "got: $cmd"
    fi
fi
rm -rf "$TMP_N"

# -----------------------------------------------------------------------
# Healing mode: detect_test_command emits the sentinel when no framework
# -----------------------------------------------------------------------
echo "Test 7: healing mode emits no-test sentinel when no framework"
TMP_S="$(mktemp -d)"
cmd="$(LOKI_HEAL_MODE=true LOKI_TEST_COMMAND="" detect_test_command "$TMP_S")"
if is_no_test_cmd "$cmd"; then
    pass "healing detect_test_command emits __LOKI_NO_TEST_CMD__ sentinel"
else
    fail "healing mode should emit sentinel" "got: $cmd"
fi
rm -rf "$TMP_S"

echo ""
echo "==================================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] && exit 0 || exit 1
