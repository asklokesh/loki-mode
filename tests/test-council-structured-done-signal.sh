#!/usr/bin/env bash
#===============================================================================
# test-council-structured-done-signal.sh
#
# REGRESSION GUARD for the "loop burns to the wall on structured completion
# claims" bug (real telemetry: saas-dashboard emitted 11 identical structured
# completion claims, none were counted as done-signals, the done-signal safety
# valve never armed, and the loop ran to the 60-min timeout at ~$34).
#
# ROOT CAUSE: council_track_iteration counted a "done signal" ONLY from a fuzzy
# grep of the iteration LOG ("all tests pass", ...). The DEFAULT completion path
# since v6.82.0 is the STRUCTURED loki_complete_task MCP tool, which writes
# .loki/signals/COMPLETION_REQUESTED (or TASK_COMPLETION_CLAIMED) and does NOT
# necessarily leave a grep-matching phrase in the log. So structured claims were
# invisible to COUNCIL_TOTAL_DONE_SIGNALS, and the "Safety valve 2" in
# council_should_stop (COUNCIL_TOTAL_DONE_SIGNALS >= COUNCIL_DONE_SIGNAL_LIMIT)
# never tripped.
#
# THE FIX: council_track_iteration now peeks (non-destructively) at the two
# structured signal files and counts a present signal as a done signal, exactly
# like a log-grep match. This test proves:
#   1. a present COMPLETION_REQUESTED signal increments both done counters
#   2. TASK_COMPLETION_CLAIMED likewise counts
#   3. absence of any signal (and no log phrase) resets the CONSECUTIVE counter
#      but leaves the TOTAL counter intact
#   4. N consecutive structured claims arm the done-signal safety valve in
#      council_should_stop (force-stop, cheap, instead of running to the wall)
#
# Runnable standalone: bash tests/test-council-structured-done-signal.sh
# Exits 0 on pass, non-zero on fail. Self-cleaning via mktemp + trap.
# No emojis. No em dashes.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COUNCIL_SH="$SCRIPT_DIR/../autonomy/completion-council.sh"
[ -f "$COUNCIL_SH" ] || { echo "FAIL: cannot find $COUNCIL_SH"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-council-donesig-XXXXXX")"
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Scratch git repo (council_track_iteration runs git against cwd).
REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email "test@example.com"
git -C "$REPO" config user.name "Test"
echo "line1" > "$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit -q -m "init"

TARGET_DIR="$REPO"
mkdir -p "$TARGET_DIR/.loki/signals"

log_info()    { :; }
log_warn()    { :; }
log_error()   { :; }
log_header()  { :; }
log_debug()   { :; }
log_success() { :; }

# shellcheck source=/dev/null
source "$COUNCIL_SH" >/dev/null 2>&1
type council_track_iteration >/dev/null 2>&1 || { echo "FAIL: council_track_iteration missing"; exit 1; }

COUNCIL_ENABLED="true"
COUNCIL_STAGNATION_LIMIT=5
COUNCIL_DONE_SIGNAL_LIMIT=3           # small so the valve arms quickly in this test
COUNCIL_CHECK_INTERVAL=1
COUNCIL_MIN_ITERATIONS=0
council_init "" >/dev/null 2>&1
cd "$REPO" || { echo "FAIL: cannot cd scratch repo"; exit 1; }
ITERATION_COUNT=0

sig="$TARGET_DIR/.loki/signals"

# ---------------------------------------------------------------------------
# 1. A present COMPLETION_REQUESTED signal counts as a done signal.
# ---------------------------------------------------------------------------
: > "$sig/COMPLETION_REQUESTED"
before=$COUNCIL_TOTAL_DONE_SIGNALS
ITERATION_COUNT=1
council_track_iteration ""    # no log file -> only the structured path can count
[ "$COUNCIL_TOTAL_DONE_SIGNALS" -eq $((before + 1)) ] \
    && pass "COMPLETION_REQUESTED increments TOTAL done signals" \
    || fail "COMPLETION_REQUESTED should increment TOTAL (before=$before now=$COUNCIL_TOTAL_DONE_SIGNALS)"
[ "$COUNCIL_DONE_SIGNALS" -ge 1 ] \
    && pass "COMPLETION_REQUESTED increments CONSECUTIVE done signals" \
    || fail "COMPLETION_REQUESTED should increment CONSECUTIVE (got $COUNCIL_DONE_SIGNALS)"

# ---------------------------------------------------------------------------
# 2. TASK_COMPLETION_CLAIMED counts too.
# ---------------------------------------------------------------------------
rm -f "$sig/COMPLETION_REQUESTED"
: > "$sig/TASK_COMPLETION_CLAIMED"
before=$COUNCIL_TOTAL_DONE_SIGNALS
ITERATION_COUNT=2
council_track_iteration ""
[ "$COUNCIL_TOTAL_DONE_SIGNALS" -eq $((before + 1)) ] \
    && pass "TASK_COMPLETION_CLAIMED increments TOTAL done signals" \
    || fail "TASK_COMPLETION_CLAIMED should increment TOTAL (before=$before now=$COUNCIL_TOTAL_DONE_SIGNALS)"

# ---------------------------------------------------------------------------
# 3. No signal + no log phrase -> CONSECUTIVE resets, TOTAL is preserved.
# ---------------------------------------------------------------------------
rm -f "$sig/TASK_COMPLETION_CLAIMED" "$sig/COMPLETION_REQUESTED"
total_before=$COUNCIL_TOTAL_DONE_SIGNALS
ITERATION_COUNT=3
council_track_iteration ""
[ "$COUNCIL_DONE_SIGNALS" -eq 0 ] \
    && pass "no signal resets CONSECUTIVE done signals to 0" \
    || fail "no signal should reset CONSECUTIVE (got $COUNCIL_DONE_SIGNALS)"
[ "$COUNCIL_TOTAL_DONE_SIGNALS" -eq "$total_before" ] \
    && pass "no signal preserves TOTAL done signals" \
    || fail "no signal must not change TOTAL (before=$total_before now=$COUNCIL_TOTAL_DONE_SIGNALS)"

# ---------------------------------------------------------------------------
# 4. Repeated structured claims arm the done-signal safety valve: once TOTAL
#    reaches COUNCIL_DONE_SIGNAL_LIMIT, council_should_stop force-stops (cheap)
#    even though the council keeps rejecting. Stub council_evaluate to REJECT so
#    only the safety valve, not a genuine approval, can stop us.
# ---------------------------------------------------------------------------
council_evaluate() { return 1; }               # always reject
council_circuit_breaker_triggered() { return 1; }  # isolate the done-signal valve
COUNCIL_CONSECUTIVE_NO_CHANGE=0                 # keep the no-change valve out of play
COUNCIL_TOTAL_DONE_SIGNALS=$COUNCIL_DONE_SIGNAL_LIMIT   # at the limit
COUNCIL_FORCE_STOPPED=0
ITERATION_COUNT=10
if LOKI_COMPLETION_CLAIMED=1 council_should_stop; then
    [ "${COUNCIL_FORCE_STOPPED:-0}" = "1" ] \
        && pass "done-signal flood arms the force-stop valve (fails cheap, not at the wall)" \
        || fail "should_stop returned stop but COUNCIL_FORCE_STOPPED != 1 (would read as a real approval)"
else
    fail "done-signal flood at the limit must force-stop, but council_should_stop returned continue"
fi

echo ""
echo "test-council-structured-done-signal: $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" -eq 0 ] || exit 1
