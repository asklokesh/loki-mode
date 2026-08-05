#!/usr/bin/env bash
#===============================================================================
# test-council-aggregate-votes.sh
#
# council_aggregate_votes() (autonomy/completion-council.sh, definition around
# line 2921) is the PRIMARY completion-decision tally on the council path:
#   council_should_stop() -> council_evaluate() -> council_aggregate_votes().
# It runs council_evaluate_member() once per council member, counts how many
# returned COMPLETE, compares the count to _council_effective_threshold(), and
# prints exactly one token to STDOUT: "COMPLETE" or "CONTINUE".
#
# TWO CONTRACTS UNDER TEST
# ------------------------
# 1. THRESHOLD. For a 3-member council with the default operator threshold
#    (COUNCIL_THRESHOLD=2), _council_effective_threshold(3) resolves to:
#      floor  = ceil(2/3 * 3) = (3*2+2)/3 = 8/3 = 2   (integer div)
#      eff    = max(floor, COUNCIL_THRESHOLD=2) = 2, clamped to size 3 -> 2
#    So the verdict is COMPLETE iff complete_count >= 2:
#      2 COMPLETE (of 3) -> COMPLETE
#      1 COMPLETE (of 3) -> CONTINUE
#
# 2. STDOUT HYGIENE. council_aggregate_votes logs progress through log_info /
#    log_warn (stderr-destined helpers) and emits ONLY the verdict via
#    `echo "$verdict"`. Any log text that leaks onto STDOUT would corrupt the
#    single-token verdict the caller parses. We capture STDOUT and STDERR to
#    SEPARATE files and assert STDOUT is byte-for-byte just the verdict token.
#
# SEAM
# ----
# Source the real completion-council.sh (function defs + var defaults only; no
# execution at source time), matching tests/test-council-track-iteration.sh.
# Stub ONLY:
#   - council_evaluate_member: replaced with a scripted voter that emits the
#     next vote from a queue in the SAME "VOTE reason..." stdout format the real
#     member uses (real ~line 2907: `echo "$vote $reasons"`). This is how the
#     real aggregate consumes votes -- it reads the member's stdout and takes
#     field 1 as the vote. Feeding votes this way exercises the real tally,
#     threshold call, and verdict/echo path unchanged.
#   - log_info / log_warn / etc: the logging helpers are defined in run.sh, not
#     this file. We route them to STDERR with a distinctive marker so the
#     hygiene assertion is real: if the marker shows up in captured STDOUT, the
#     function echoed a log line to stdout (the bug this guards against).
# _council_effective_threshold is left REAL so the exact threshold is derived
# from production code, not re-implemented in the test.
#
# Runnable standalone: bash tests/test-council-aggregate-votes.sh
# Exits 0 on pass, non-zero on fail. Self-cleaning via mktemp + trap.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COUNCIL_SH="$SCRIPT_DIR/../autonomy/completion-council.sh"

if [ ! -f "$COUNCIL_SH" ]; then
    echo "FAIL: cannot find completion-council.sh at $COUNCIL_SH"
    exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-council-aggregate-XXXXXX")"
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

PASS_COUNT=0
FAIL_COUNT=0
pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "FAIL: $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# Distinctive marker so a stdout leak is unambiguous in the assertion below.
LOG_MARKER="__COUNCIL_LOG_MARKER__"

# Logging helpers live in run.sh, not completion-council.sh. Route them to
# STDERR (their real destination in the council/aggregate path) carrying the
# marker, so any log that wrongly reaches STDOUT is caught by the hygiene test.
log_info()    { echo "$LOG_MARKER $*" >&2; }
log_warn()    { echo "$LOG_MARKER $*" >&2; }
log_error()   { echo "$LOG_MARKER $*" >&2; }
log_header()  { echo "$LOG_MARKER $*" >&2; }
log_debug()   { echo "$LOG_MARKER $*" >&2; }
log_success() { echo "$LOG_MARKER $*" >&2; }

# shellcheck source=/dev/null
source "$COUNCIL_SH" >/dev/null 2>&1

if ! type council_aggregate_votes >/dev/null 2>&1; then
    echo "FAIL: council_aggregate_votes not defined after sourcing $COUNCIL_SH"
    exit 1
fi
if ! type _council_effective_threshold >/dev/null 2>&1; then
    echo "FAIL: _council_effective_threshold not defined after sourcing $COUNCIL_SH"
    exit 1
fi

# 3-member council with the default operator threshold. State dir is a throwaway
# scratch (council_aggregate_votes writes round-N.json there and to stderr logs;
# neither is on the stdout verdict path).
COUNCIL_SIZE=3
COUNCIL_THRESHOLD=2
COUNCIL_STATE_DIR="$WORK/council"
mkdir -p "$COUNCIL_STATE_DIR"
ITERATION_COUNT=0

# Derive the EXACT threshold from production code (not re-implemented here).
DERIVED_THRESHOLD="$(_council_effective_threshold "$COUNCIL_SIZE")"
if [ "$DERIVED_THRESHOLD" = "2" ]; then
    pass "threshold derived from real _council_effective_threshold(3) is 2 (>=2 COMPLETE required)"
else
    fail "expected threshold 2 for a 3-member council, got '$DERIVED_THRESHOLD'"
fi

#-------------------------------------------------------------------------------
# Scripted voter seam. council_aggregate_votes calls
#   result=$(council_evaluate_member "$role" "...")
# once per member and reads field 1 of the member's STDOUT as the vote. Because
# that call is inside a command substitution (a SUBSHELL), the stub cannot use a
# shell-array cursor -- mutations would not survive back to the parent loop, so
# every member would read the same first vote. The queue is therefore backed by
# a FILE: each invocation atomically consumes (sed-deletes) its first line. The
# stub prints the vote in the real member format ("VOTE reason words"), driving
# the real tally / threshold / verdict path.
#-------------------------------------------------------------------------------
VOTE_QUEUE_FILE="$WORK/vote-queue"
council_evaluate_member() {
    local v
    v="$(sed -n '1p' "$VOTE_QUEUE_FILE")"
    sed -i.bak '1d' "$VOTE_QUEUE_FILE" 2>/dev/null && rm -f "$VOTE_QUEUE_FILE.bak"
    echo "$v scripted reason for the $1 role"
}

# Run council_aggregate_votes with the given scripted votes, capturing STDOUT and
# STDERR to SEPARATE files. Echoes: "<stdout>|<stderr_file>".
run_aggregate() {
    local out_file="$WORK/out.$$.$RANDOM"
    local err_file="$WORK/err.$$.$RANDOM"
    printf '%s\n' "$@" > "$VOTE_QUEUE_FILE"
    council_aggregate_votes >"$out_file" 2>"$err_file"
    printf '%s|%s' "$(cat "$out_file")" "$err_file"
}

#===============================================================================
# Case 1: 2 COMPLETE of 3 -> STDOUT is exactly "COMPLETE".
#===============================================================================
res1="$(run_aggregate COMPLETE COMPLETE CONTINUE)"
out1="${res1%%|*}"
err1="${res1#*|}"

if [ "$out1" = "COMPLETE" ]; then
    pass "2 COMPLETE of 3 -> stdout is exactly 'COMPLETE'"
else
    fail "2 COMPLETE of 3 -> expected stdout exactly 'COMPLETE', got '$out1'"
fi
# Stdout hygiene: the ONLY thing on stdout is the verdict token -- no log marker.
if printf '%s' "$out1" | grep -q "$LOG_MARKER"; then
    fail "log text leaked onto STDOUT (marker found in verdict capture): '$out1'"
else
    pass "no log text leaked onto STDOUT for the COMPLETE case"
fi
# Sanity: the logs did run and landed on STDERR (marker present there), proving
# the clean-stdout result is real routing, not merely a silent function.
if grep -q "$LOG_MARKER" "$err1"; then
    pass "log output correctly went to STDERR (marker present in stderr capture)"
else
    fail "expected log marker on STDERR; logs did not run as expected"
fi

#===============================================================================
# Case 2: 1 COMPLETE of 3 -> STDOUT is exactly "CONTINUE".
#===============================================================================
res2="$(run_aggregate COMPLETE CONTINUE CONTINUE)"
out2="${res2%%|*}"

if [ "$out2" = "CONTINUE" ]; then
    pass "1 COMPLETE of 3 -> stdout is exactly 'CONTINUE'"
else
    fail "1 COMPLETE of 3 -> expected stdout exactly 'CONTINUE', got '$out2'"
fi
if printf '%s' "$out2" | grep -q "$LOG_MARKER"; then
    fail "log text leaked onto STDOUT (marker found in verdict capture): '$out2'"
else
    pass "no log text leaked onto STDOUT for the CONTINUE case"
fi

#===============================================================================
# Case 3 (boundary control): 3 COMPLETE of 3 -> COMPLETE, and 0 COMPLETE of 3
# -> CONTINUE. Pins both ends so the >=2 assertions above are not vacuous.
#===============================================================================
res3="$(run_aggregate COMPLETE COMPLETE COMPLETE)"
out3="${res3%%|*}"
if [ "$out3" = "COMPLETE" ]; then
    pass "3 COMPLETE of 3 -> stdout is exactly 'COMPLETE'"
else
    fail "3 COMPLETE of 3 -> expected 'COMPLETE', got '$out3'"
fi

res4="$(run_aggregate CONTINUE CONTINUE CONTINUE)"
out4="${res4%%|*}"
if [ "$out4" = "CONTINUE" ]; then
    pass "0 COMPLETE of 3 -> stdout is exactly 'CONTINUE'"
else
    fail "0 COMPLETE of 3 -> expected 'CONTINUE', got '$out4'"
fi

#===============================================================================
# Summary
#===============================================================================
echo "----------------------------------------------------------------"
echo "test-council-aggregate-votes: ${PASS_COUNT} passed, ${FAIL_COUNT} failed"

if [ "$FAIL_COUNT" -ne 0 ]; then
    exit 1
fi
exit 0
