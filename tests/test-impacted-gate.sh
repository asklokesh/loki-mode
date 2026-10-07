#!/usr/bin/env bash
# tests/test-impacted-gate.sh -- end-to-end regression for scripts/impacted-gate.sh (FC-31).
#
# The gate once ran each suite as `run_suite &` with an EXIT trap that deletes
# the run dir. Every background subshell ran that trap, so the first suite to
# finish removed the dir, results were lost, and the gate printed PASS with
# exit 0 although suites had failed. This drives the real gate over stub
# suites (test-only hook IMPACTED_TEST_MODE=1 + IMPACTED_SUITES_FILE).
# Set GATE to run a mutated copy (used to prove this test goes red).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GATE="${GATE:-$REPO_ROOT/scripts/impacted-gate.sh}"
export LOKI_NO_BROWSER=1

# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
unset LOKI_RUN_TMP
loki_run_tmp_create || { echo "cannot create run tmp"; exit 1; }
FIX="$LOKI_RUN_TMP"
unset LOKI_RUN_TMP
trap 'LOKI_RUN_TMP="$FIX" loki_run_tmp_cleanup' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

printf 'exit 1\n' >"$FIX/s-fail.sh"
printf 'sleep 2\nexit 0\n' >"$FIX/s-slow.sh"
printf 'sleep 1\nexit 0\n' >"$FIX/s-mid.sh"
printf 'exit 0\n' >"$FIX/s-ok.sh"
# A suite that cleans up the run dir it inherited (what the real suites do via
# loki_run_tmp_cleanup). The gate must not hand its own run dir to children.
printf '. "%s/eval/loki10/lib-tmp.sh"\nloki_run_tmp_cleanup\nexit 0\n' "$REPO_ROOT" >"$FIX/s-cleaner.sh"

run_gate() {
    local list="$1"
    IMPACTED_TEST_MODE=1 IMPACTED_SUITES_FILE="$list" IMPACTED_JOBS=3 \
        timeout -k 5 60 /bin/bash "$GATE" base HEAD 2>&1
}

# Case 1: a cleaner and a failing suite finish first, two slower passing suites
# follow. Must fail and never print PASS.
printf '%s\n%s\n%s\n%s\n' "$FIX/s-cleaner.sh" "$FIX/s-fail.sh" "$FIX/s-slow.sh" "$FIX/s-mid.sh" >"$FIX/list-fail.txt"
out="$(run_gate "$FIX/list-fail.txt")"
rc=$?
[ "$rc" -ne 0 ] && ok "failing suite makes the gate exit non-zero (rc=$rc)" || bad "gate exited 0 with a failing suite"
printf '%s' "$out" | grep -q 'impacted-gate: PASS' && bad "gate printed PASS despite a failing suite" || ok "gate did not print PASS"
printf '%s' "$out" | grep -q 'impacted-gate: FAIL' && ok "gate printed FAIL" || bad "gate did not print FAIL"
printf '%s' "$out" | grep -q "^rc=1 $FIX/s-fail.sh" && ok "failing suite rc=1 reported" || bad "failing suite rc not reported"

# Case 2: all passing, slower suites included. Must exit 0 with all results kept.
printf '%s\n%s\n%s\n%s\n' "$FIX/s-cleaner.sh" "$FIX/s-slow.sh" "$FIX/s-mid.sh" "$FIX/s-ok.sh" >"$FIX/list-ok.txt"
out="$(run_gate "$FIX/list-ok.txt")"
rc=$?
[ "$rc" -eq 0 ] && ok "all-pass run exits 0" || bad "all-pass run exited $rc"
printf '%s' "$out" | grep -q 'impacted-gate: PASS (4 suites)' && ok "all-pass run reports 4 suites" || bad "all-pass run did not report 4 suites"

# Case 3: a selected suite file that does not exist is a failure, not a skip.
printf '%s\n%s\n' "$FIX/s-ok.sh" "$FIX/does-not-exist.sh" >"$FIX/list-missing.txt"
out="$(run_gate "$FIX/list-missing.txt")"
rc=$?
[ "$rc" -ne 0 ] && ok "missing suite file fails the gate (rc=$rc)" || bad "missing suite file passed the gate"

echo "impacted-gate fixtures: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
