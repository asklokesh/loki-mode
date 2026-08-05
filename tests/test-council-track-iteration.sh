#!/usr/bin/env bash
#===============================================================================
# test-council-track-iteration.sh
#
# council_track_iteration() (autonomy/completion-council.sh, definition at
# council_track_iteration() around line 233) is the convergence counter that
# feeds the stagnation force-stop read in council_should_stop() (safety valve
# at ~line 3803: `safety_limit=$((COUNCIL_STAGNATION_LIMIT * 2))`). It has had
# ZERO direct tests. An off-by-one or missed reset here means either:
#   - early fake-completion: the counter over-counts / never resets on a real
#     change, so council_should_stop force-stops while work remains, OR
#   - never-stops: the counter under-counts / resets when it should not, so
#     the safety valve never trips and the run grinds to max iterations.
#
# THE COUNTER UNDER TEST
# -----------------------
# COUNCIL_CONSECUTIVE_NO_CHANGE (global, set by council_track_iteration):
#   - combined_hash = md5(git diff --stat HEAD) + md5(git diff --cached --stat)
#     + `git log --oneline -1` (first field). This mixes unstaged, staged, and
#     committed state so a committed change is ALSO detected (BUG-QG-004).
#   - if combined_hash == COUNCIL_LAST_DIFF_HASH: counter++  (no change)
#   - else:                                       counter=0  (change detected)
#   - COUNCIL_LAST_DIFF_HASH is updated to combined_hash every call.
#
# THE THRESHOLD UNDER TEST
# -------------------------
# COUNCIL_STAGNATION_LIMIT (default 5, env LOKI_COUNCIL_STAGNATION_LIMIT).
# council_circuit_breaker_triggered() trips when
#   COUNCIL_CONSECUTIVE_NO_CHANGE -ge COUNCIL_STAGNATION_LIMIT.
# council_should_stop()'s safety valve (only reached if the circuit breaker
# tripped AND council_evaluate rejected) force-stops when
#   COUNCIL_CONSECUTIVE_NO_CHANGE -ge (COUNCIL_STAGNATION_LIMIT * 2)
# and sets COUNCIL_FORCE_STOPPED=1 (force-stop, NOT a genuine council
# approval -- see tests/test-council-force-stop-wave7.sh for that sentinel's
# own contract).
#
# SEAM
# ----
# Source the real completion-council.sh (function definitions + var defaults
# only -- no execution at source time). Stub only the logging helpers (defined
# in run.sh, not this file) and council_evaluate (the heavy LLM-backed vote --
# forced to always reject so the safety valve, not a genuine approval, is what
# we observe). council_circuit_breaker_triggered is left REAL: it reads the
# real COUNCIL_CONSECUTIVE_NO_CHANGE / COUNCIL_STAGNATION_LIMIT globals that
# council_track_iteration itself maintains, so the whole counter chain is
# exercised end to end. All git operations run for real against a scratch
# repo in a mktemp dir (no network, no provider calls).
#
# Runnable standalone: bash tests/test-council-track-iteration.sh
# Exits 0 on pass, non-zero on fail. Self-cleaning via mktemp + trap.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COUNCIL_SH="$SCRIPT_DIR/../autonomy/completion-council.sh"

if [ ! -f "$COUNCIL_SH" ]; then
    echo "FAIL: cannot find completion-council.sh at $COUNCIL_SH"
    exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-council-track-XXXXXX")"
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Scratch git repo that council_track_iteration's `git diff`/`git log` calls
# will observe (they run against cwd, not TARGET_DIR).
REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email "test@example.com"
git -C "$REPO" config user.name "Test"
echo "line1" > "$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit -q -m "init"

TARGET_DIR="$REPO"
mkdir -p "$TARGET_DIR/.loki"

#-------------------------------------------------------------------------------
# Source the real file with logging silenced. No main-guard / no execution at
# source time (only var defaults + function defs), matching the convention
# used by tests/test-council-convergence-floor.sh and
# tests/test-council-force-stop-wave7.sh.
#-------------------------------------------------------------------------------
log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_header()  { :; }
log_debug()   { :; }
log_success() { :; }

# shellcheck source=/dev/null
source "$COUNCIL_SH" >/dev/null 2>&1

if ! type council_track_iteration >/dev/null 2>&1; then
    echo "FAIL: council_track_iteration not defined after sourcing $COUNCIL_SH"
    exit 1
fi
if ! type council_should_stop >/dev/null 2>&1; then
    echo "FAIL: council_should_stop not defined after sourcing $COUNCIL_SH"
    exit 1
fi

COUNCIL_ENABLED="true"
COUNCIL_STAGNATION_LIMIT=5           # real default; explicit for a stable test
COUNCIL_DONE_SIGNAL_LIMIT=10000      # keep the OTHER safety valve (done-signals) out of the way
COUNCIL_TOTAL_DONE_SIGNALS=0
COUNCIL_CHECK_INTERVAL=5
COUNCIL_MIN_ITERATIONS=3

# council_init sets COUNCIL_STATE_DIR, COUNCIL_LAST_DIFF_HASH="",
# COUNCIL_CONSECUTIVE_NO_CHANGE=0, COUNCIL_DONE_SIGNALS=0,
# COUNCIL_TOTAL_DONE_SIGNALS=0 and creates $TARGET_DIR/.loki/council.
council_init "" >/dev/null 2>&1

# council_track_iteration's git calls run against cwd.
cd "$REPO" || { echo "FAIL: cannot cd into scratch repo"; exit 1; }

ITERATION_COUNT=0

expect_counter() {
    local desc="$1" expected="$2"
    if [ "$COUNCIL_CONSECUTIVE_NO_CHANGE" = "$expected" ]; then
        pass "$desc (COUNCIL_CONSECUTIVE_NO_CHANGE=$COUNCIL_CONSECUTIVE_NO_CHANGE)"
    else
        fail "$desc (expected COUNCIL_CONSECUTIVE_NO_CHANGE=$expected, got $COUNCIL_CONSECUTIVE_NO_CHANGE)"
    fi
}

#===============================================================================
# Step 1: first call establishes the baseline hash. No prior hash exists
# (COUNCIL_LAST_DIFF_HASH="" from council_init), and the repo is clean, so the
# very first observation cannot match a "previous" state -> counter resets/
# stays at 0 (change branch: combined_hash != "" is true on iteration 1).
#===============================================================================
ITERATION_COUNT=1
council_track_iteration
expect_counter "iteration 1 (baseline, no prior hash) -> counter is 0" 0

#===============================================================================
# Step 2: a REAL change (edit file.txt, unstaged) -> counter resets to 0
# (it was already 0, so this also proves the change branch doesn't increment).
#===============================================================================
ITERATION_COUNT=2
echo "line2" >> "$REPO/file.txt"
council_track_iteration
expect_counter "iteration 2 (file edited -> change detected) -> counter resets to 0" 0

#===============================================================================
# Step 3: three consecutive NO-CHANGE iterations (repo untouched between
# calls) -> counter increments 1, 2, 3.
#===============================================================================
ITERATION_COUNT=3
council_track_iteration
expect_counter "iteration 3 (no change #1) -> counter is 1" 1

ITERATION_COUNT=4
council_track_iteration
expect_counter "iteration 4 (no change #2) -> counter is 2" 2

ITERATION_COUNT=5
council_track_iteration
expect_counter "iteration 5 (no change #3) -> counter is 3" 3

#===============================================================================
# Step 4: a CHANGE (this time commit it, exercising the commit-hash component
# of combined_hash per BUG-QG-004) -> counter resets to 0.
#===============================================================================
ITERATION_COUNT=6
git -C "$REPO" add file.txt
git -C "$REPO" commit -q -m "second change"
council_track_iteration
expect_counter "iteration 6 (committed change -> change detected) -> counter resets to 0" 0

#===============================================================================
# Step 5: drive enough consecutive NO-CHANGE iterations to cross the
# stagnation limit (COUNCIL_STAGNATION_LIMIT=5), then keep going to the
# council_should_stop safety-valve threshold (2x limit = 10). Assert
# council_circuit_breaker_triggered flips exactly at the limit, and that the
# counter itself hits precisely 2x the limit (no off-by-one).
#===============================================================================
circuit_tripped_at=""
for i in $(seq 7 16); do
    ITERATION_COUNT=$i
    council_track_iteration
    if [ -z "$circuit_tripped_at" ] && council_circuit_breaker_triggered >/dev/null 2>&1; then
        circuit_tripped_at="$COUNCIL_CONSECUTIVE_NO_CHANGE"
    fi
done

expect_counter "after 10 consecutive no-change iterations -> counter is exactly 10 (2x stagnation limit)" 10

if [ "$circuit_tripped_at" = "$COUNCIL_STAGNATION_LIMIT" ]; then
    pass "circuit breaker trips at exactly COUNCIL_STAGNATION_LIMIT ($COUNCIL_STAGNATION_LIMIT), not before/after"
else
    fail "circuit breaker tripped at counter=$circuit_tripped_at, expected exactly $COUNCIL_STAGNATION_LIMIT"
fi

#===============================================================================
# Step 6: council_should_stop force-stops via the stagnation safety valve.
# council_evaluate is stubbed to always reject (no genuine approval possible),
# so the ONLY way rc=0 happens here is the safety valve at
# safety_limit = COUNCIL_STAGNATION_LIMIT * 2 (~line 3803-3807), which also
# sets COUNCIL_FORCE_STOPPED=1 (bash-F1 sentinel: force-stop, not approval).
# council_circuit_breaker_triggered is left REAL (not stubbed) so this proves
# the counter chain drives the real force-stop end to end.
#===============================================================================
council_evaluate() { return 1; }          # council never approves (heavy vote stubbed out)
council_write_report() { :; }             # side-effecting; not under test here
council_augment_from_managed_memory() { return 0; }

# ITERATION_COUNT=16 is not on the 5-interval boundary (16 % 5 != 0), but the
# circuit breaker being triggered makes _council_should_check_now return
# check-now regardless (see _council_should_check_now: circuit_triggered ->
# return 0 unconditionally), so should_check does not gate this call.
council_should_stop
stop_rc=$?

if [ "$stop_rc" = "0" ]; then
    pass "council_should_stop force-stops once counter reaches 2x stagnation limit (rc=0)"
else
    fail "council_should_stop did NOT stop at counter=$COUNCIL_CONSECUTIVE_NO_CHANGE (expected rc=0, got rc=$stop_rc) -- never-stops failure mode"
fi

if [ "${COUNCIL_FORCE_STOPPED:-0}" = "1" ]; then
    pass "COUNCIL_FORCE_STOPPED=1 confirms this was the safety valve, not a genuine council approval"
else
    fail "COUNCIL_FORCE_STOPPED expected 1, got '${COUNCIL_FORCE_STOPPED:-UNSET}'"
fi

#===============================================================================
# Step 7 (negative control): one step short of the safety limit, the valve
# must NOT fire yet (proves the assertion above isn't vacuously true for any
# large counter, i.e. catches an off-by-one in the OTHER direction too).
#===============================================================================
ITERATION_COUNT=20
COUNCIL_CONSECUTIVE_NO_CHANGE=$(( (COUNCIL_STAGNATION_LIMIT * 2) - 1 ))
council_evaluate() { return 1; }
council_should_stop
short_rc=$?

if [ "$short_rc" != "0" ] || [ "${COUNCIL_FORCE_STOPPED:-0}" != "1" ]; then
    pass "one below the safety limit (counter=$COUNCIL_CONSECUTIVE_NO_CHANGE) does not force-stop via the valve"
else
    fail "safety valve fired ONE ITERATION EARLY at counter=$COUNCIL_CONSECUTIVE_NO_CHANGE (expected no force-stop until $((COUNCIL_STAGNATION_LIMIT * 2)))"
fi

#===============================================================================
# Summary
#===============================================================================
echo "----------------------------------------------------------------"
echo "test-council-track-iteration: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

if [ "$FAIL_COUNT" -ne 0 ]; then
    exit 1
fi
exit 0
