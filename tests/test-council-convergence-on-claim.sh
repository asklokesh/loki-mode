#!/usr/bin/env bash
# tests/test-council-convergence-on-claim.sh
#
# v7.105.0 convergence fix: an EXPLICIT completion claim must make the completion
# council EVALUATE this iteration instead of deferring to the N-iteration check
# interval -- WITHOUT weakening any approval guard.
#
# Root cause (docs/SPEED-DIAGNOSIS-2026-07-01.md, from real telemetry): a build
# could be verifiably done at iteration 1 (reviews non-blocking, tests green) yet
# the council was not allowed to check until iteration % COUNCIL_CHECK_INTERVAL
# == 0, so the loop ground out needless "next improvement" iterations (14 for a
# ~1-iteration job).
#
# This test sources the REAL council_should_stop from completion-council.sh, stubs
# council_evaluate / circuit-breaker / augment so ONLY the should_check gate is
# under test, and asserts the truth table. council_evaluate is stubbed to record
# whether it was REACHED (i.e. should_check passed) -- proving WHEN the council
# runs, while leaving the real approval logic (which this fix does not touch)
# out of scope.
#
# Truth table:
#   1. claim + past MIN_ITERATIONS + off-interval  -> council REACHED (the fix)
#   2. NO claim + off-interval                      -> council NOT reached (unchanged cadence)
#   3. NO claim + ON-interval                       -> council REACHED (unchanged cadence)
#   4. claim + BEFORE MIN_ITERATIONS                -> council NOT reached (guard preserved)
#   5. claim signalled via COMPLETION_REQUESTED file -> council REACHED (file path)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"
[ -f "$COUNCIL_SH" ] || { echo "FAIL: cannot find $COUNCIL_SH"; exit 1; }

PASS=0; FAIL=0
ok()  { echo "ok: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# quiet, side-effect-free logging
log_info(){ :; }; log_warn(){ :; }; log_error(){ :; }; log_debug(){ :; }; log_header(){ :; }

# shellcheck source=/dev/null
source "$COUNCIL_SH" >/dev/null 2>&1 || true
type council_should_stop >/dev/null 2>&1 || { echo "FAIL: council_should_stop not defined"; exit 1; }

WORK="$(mktemp -d -t loki-converge-XXXXXX)"
trap 'rm -rf "${WORK:-/nonexistent}"' EXIT
mkdir -p "$WORK/.loki/signals"

# --- Stubs that isolate the should_check gate --------------------------------
# council_evaluate: record that the gate LET the council run, then return 1
# (not-approved) so council_should_stop returns 1 regardless -- we are testing
# WHEN it evaluates, not the vote outcome.
COUNCIL_EVALUATED=0
council_evaluate() { COUNCIL_EVALUATED=1; return 1; }
# No stagnation / no managed branch / no augment side effects.
council_circuit_breaker_triggered() { return 1; }
council_managed_should_stop() { return 1; }
council_augment_from_managed_memory() { return 0; }

# Deterministic council config
COUNCIL_ENABLED=true
COUNCIL_MIN_ITERATIONS=3
COUNCIL_CHECK_INTERVAL=5
LOKI_EXPERIMENTAL_MANAGED_COUNCIL=false
TARGET_DIR="$WORK"

run_case() {
  # $1=iteration $2=claim(0/1 via env) $3=use_file(0/1)
  COUNCIL_EVALUATED=0
  ITERATION_COUNT="$1"
  rm -f "$WORK/.loki/signals/COMPLETION_REQUESTED"
  [ "$3" = "1" ] && : > "$WORK/.loki/signals/COMPLETION_REQUESTED"
  LOKI_COMPLETION_CLAIMED="$2" council_should_stop >/dev/null 2>&1 || true
  echo "$COUNCIL_EVALUATED"
}

# 1. claim (env) + iter 7 (off the 5-interval) + past MIN -> council REACHED
r=$(run_case 7 1 0)
[ "$r" = "1" ] && ok "claim off-interval (iter 7) -> council evaluates NOW (the fix)" || bad "claim off-interval did NOT reach council (got eval=$r)"

# 2. no claim + iter 7 (off-interval) -> council NOT reached (cadence unchanged)
r=$(run_case 7 0 0)
[ "$r" = "0" ] && ok "no claim off-interval (iter 7) -> council does NOT run (cadence preserved)" || bad "no-claim off-interval wrongly ran council (got eval=$r)"

# 3. no claim + iter 5 (ON interval) -> council REACHED (cadence unchanged)
r=$(run_case 5 0 0)
[ "$r" = "1" ] && ok "no claim on-interval (iter 5) -> council runs (cadence preserved)" || bad "on-interval did NOT run council (got eval=$r)"

# 4. claim + iter 2 (BEFORE MIN_ITERATIONS=3) -> council NOT reached (guard preserved)
r=$(run_case 2 1 0)
[ "$r" = "0" ] && ok "claim before MIN_ITERATIONS (iter 2) -> council does NOT run (min-iter guard preserved)" || bad "claim bypassed MIN_ITERATIONS guard (got eval=$r)"

# 5. claim via COMPLETION_REQUESTED file + iter 7 -> council REACHED (file path)
r=$(run_case 7 0 1)
[ "$r" = "1" ] && ok "claim via COMPLETION_REQUESTED file (iter 7) -> council evaluates NOW" || bad "file-signalled claim did NOT reach council (got eval=$r)"

echo
echo "-----------------------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "ALL CONVERGENCE TESTS PASSED" || echo "SOME TESTS FAILED"
exit "$FAIL"
