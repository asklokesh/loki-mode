#!/usr/bin/env bash
# Test: SLICE 6d -- OPT-IN auto-tune of the council CHECK interval by complexity.
#
# _loki_auto_tune_interval(complexity) is a PURE function of its argument plus the
# LOKI_AUTO_TUNE env var (default 0 = OFF). It changes only WHEN the council is
# allowed to evaluate, never WHETHER a gate passes: the MIN_ITERATIONS floor, the
# hard gate, the evidence gate and the aggregate vote are all untouched by it.
#
# This sources the REAL helper from completion-council.sh so it cannot drift.
#
# Cases:
#   OFF-DEFAULT : LOKI_AUTO_TUNE unset, simple -> base 5 (stock unchanged).
#   OFF-EXPLICIT: LOKI_AUTO_TUNE=0, simple    -> base 5 (unchanged).
#   ON-SIMPLE   : LOKI_AUTO_TUNE=1, simple    -> 3 (converge faster; 2or3 allowed).
#   ON-STANDARD : LOKI_AUTO_TUNE=1, standard  -> 5 (unchanged).
#   ON-COMPLEX  : LOKI_AUTO_TUNE=1, complex   -> 5 (unchanged).
#   ON-UNKNOWN  : LOKI_AUTO_TUNE=1, ""        -> 5 (unknown tier is unchanged).
#   ON-CUSTOMBASE: LOKI_AUTO_TUNE=1, standard, base 8 -> 8 (honors explicit base).
#   GATE-INVARIANCE: the interval never flips MIN_ITERATIONS (a gate input); the
#                    simple floor stays 1 whether auto-tune is on or off.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

if [ ! -f "$COUNCIL_SH" ]; then
    echo "FAIL: cannot find $COUNCIL_SH"
    exit 1
fi

# Quiet, side-effect-free logging stubs so sourcing is silent.
log_info()  { :; }
log_warn()  { :; }
log_error() { :; }
log_debug() { :; }
log_header() { :; }

# shellcheck source=/dev/null
source "$COUNCIL_SH" >/dev/null 2>&1 || true

if ! type _loki_auto_tune_interval >/dev/null 2>&1; then
    echo "FAIL: _loki_auto_tune_interval not defined after sourcing $COUNCIL_SH"
    exit 1
fi

PASS=0
FAIL=0

# check <name> <expected> <actual>
check() {
    local name="$1" expected="$2" actual="$3"
    if [ "$actual" = "$expected" ]; then
        echo "PASS: $name (got $actual)"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $name -- expected '$expected', got '$actual'"
        FAIL=$((FAIL + 1))
    fi
}

# Base interval that the runtime carries (stock default).
COUNCIL_CHECK_INTERVAL=5

# OFF-DEFAULT: env unset entirely.
unset LOKI_AUTO_TUNE
check "OFF-DEFAULT simple->base" "5" "$(_loki_auto_tune_interval simple)"

# OFF-EXPLICIT.
LOKI_AUTO_TUNE=0
check "OFF-EXPLICIT simple->base" "5" "$(_loki_auto_tune_interval simple)"

# ON.
LOKI_AUTO_TUNE=1
_v="$(_loki_auto_tune_interval simple)"
if [ "$_v" = "2" ] || [ "$_v" = "3" ]; then
    echo "PASS: ON-SIMPLE simple->2or3 (got $_v)"
    PASS=$((PASS + 1))
else
    echo "FAIL: ON-SIMPLE simple -- expected 2 or 3, got '$_v'"
    FAIL=$((FAIL + 1))
fi
check "ON-STANDARD standard->base" "5" "$(_loki_auto_tune_interval standard)"
check "ON-COMPLEX complex->base"   "5" "$(_loki_auto_tune_interval complex)"
check "ON-UNKNOWN empty->base"     "5" "$(_loki_auto_tune_interval '')"

# ON-CUSTOMBASE: explicit LOKI_COUNCIL_CHECK_INTERVAL propagates via the base.
COUNCIL_CHECK_INTERVAL=8
check "ON-CUSTOMBASE standard->8" "8" "$(_loki_auto_tune_interval standard)"
COUNCIL_CHECK_INTERVAL=5

# GATE-INVARIANCE: the auto-tune knob must not move a GATE input. The simple
# MIN_ITERATIONS floor is 1 regardless of LOKI_AUTO_TUNE -- interval gates WHEN
# not WHETHER.
if type _council_effective_min_iter >/dev/null 2>&1; then
    DETECTED_COMPLEXITY=simple
    unset LOKI_COUNCIL_MIN_ITERATIONS
    COUNCIL_MIN_ITERATIONS=3
    LOKI_AUTO_TUNE=1
    _floor_on="$(_council_effective_min_iter)"
    LOKI_AUTO_TUNE=0
    _floor_off="$(_council_effective_min_iter)"
    check "GATE-INVARIANCE floor unchanged by auto-tune" "$_floor_off" "$_floor_on"
    check "GATE-INVARIANCE simple floor stays 1" "1" "$_floor_on"
else
    echo "SKIP: _council_effective_min_iter not present (gate-invariance)"
fi

echo "-----------------------------------------"
echo "PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
