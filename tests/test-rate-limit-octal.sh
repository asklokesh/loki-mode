#!/usr/bin/env bash
# tests/test-rate-limit-octal.sh - regression for the zero-padded octal crash in
# parse_claude_reset_time (autonomy/run.sh).
#
# BUG: the seconds-until-reset math used bare arithmetic on `date +%H/%M/%S`.
# During the 08:xx and 09:xx clock windows those values are "08"/"09", which
# bash treats as invalid octal ("value too great for base"), so the whole
# expansion aborted, wait_secs was discarded, and the engine fell back to a
# too-short generic backoff instead of honoring the real rate-limit reset.
#
# FIX: force base-10 with 10#$var on each date component.
#
# This test drives the real parse_claude_reset_time function with the current
# time forced to 08:09:08 (a value that crashes the OLD code) and asserts:
#   1. the function does not crash (exit 0, no "value too great" on stderr)
#   2. it returns a correct base-10 wait in seconds for a known reset time
#
# It fails on the OLD (bare arithmetic) code and passes on the fixed code.
# Self-skips cleanly if bash/date are unavailable.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0

_ok()   { printf '  PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
_no()   { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
_skip() { printf '  SKIP: %s\n' "$1"; }

# --- Dependency guards (self-skip cleanly) ---------------------------------
if ! command -v date >/dev/null 2>&1; then
    _skip "date not available"
    echo "SKIPPED"
    exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    _skip "autonomy/run.sh not found at $RUN_SH"
    echo "SKIPPED"
    exit 0
fi

# --- Extract parse_claude_reset_time from run.sh ---------------------------
# Pull only the function body so we can source it in isolation without running
# the whole engine. The function spans from its definition to the closing brace.
FN_SRC="$(awk '/^parse_claude_reset_time\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$RUN_SH")"

if [ -z "$FN_SRC" ]; then
    _no "could not extract parse_claude_reset_time from run.sh"
    echo "TEST FAILED"
    exit 1
fi

# Confirm the extraction actually captured a complete function.
if ! printf '%s\n' "$FN_SRC" | grep -q 'current_secs'; then
    _no "extracted function body looks incomplete (no current_secs)"
    echo "TEST FAILED"
    exit 1
fi

# --- Build an isolated harness that forces the octal-danger clock -----------
TMP_DIR="$(mktemp -d -t loki-octal-tests.XXXXXX)"
cleanup() { rm -rf "$TMP_DIR" 2>/dev/null || true; }
trap cleanup EXIT

# A log file that contains a rate-limit reset message the function parses.
# "resets 10am" -> reset hour 10 (24h).
LOG_FILE="$TMP_DIR/loki.log"
printf 'some noise\nClaude usage limit reached; resets 10am\nmore noise\n' > "$LOG_FILE"

# Harness script: overrides `date` so the "current time" is exactly the value
# that crashed the OLD code (08:09:08), then calls the real function.
HARNESS="$TMP_DIR/harness.sh"
{
    echo '#!/usr/bin/env bash'
    echo 'set -uo pipefail'
    # date override: return zero-padded octal-dangerous components.
    echo 'date() {'
    echo '  case "$1" in'
    echo '    +%H) echo "08" ;;'
    echo '    +%M) echo "09" ;;'
    echo '    +%S) echo "08" ;;'
    echo '    *) command date "$@" ;;'
    echo '  esac'
    echo '}'
    # The real function under test.
    printf '%s\n' "$FN_SRC"
    # Invoke it with the crafted log file.
    echo 'parse_claude_reset_time "$1"'
} > "$HARNESS"

# --- Run the harness, capturing stdout, stderr, and exit code --------------
STDERR_FILE="$TMP_DIR/stderr.txt"
OUT="$(bash "$HARNESS" "$LOG_FILE" 2>"$STDERR_FILE")"
RC=$?
ERR="$(cat "$STDERR_FILE")"

# --- Assertion 1: no crash -------------------------------------------------
# The OLD code aborts with "value too great for base" on 08/09.
if [ "$RC" -eq 0 ] && ! printf '%s' "$ERR" | grep -qi 'value too great for base'; then
    _ok "parse_claude_reset_time does not crash on zero-padded 08:09:08"
else
    _no "parse_claude_reset_time crashed on 08:09:08 (rc=$RC, stderr: $ERR)"
fi

# --- Assertion 2: correct base-10 wait -------------------------------------
# current time 08:09:08 -> current_secs = 8*3600 + 9*60 + 8 = 29348
# reset 10am -> reset_secs = 10*3600 = 36000
# wait = 36000 - 29348 = 6652, + 120s buffer = 6772
EXPECTED=6772
if [ "$OUT" = "$EXPECTED" ]; then
    _ok "wait seconds correct (base-10): got $OUT, expected $EXPECTED"
else
    _no "wait seconds wrong: got '$OUT', expected $EXPECTED (octal bug would discard/skew this)"
fi

# --- Summary ---------------------------------------------------------------
echo
printf 'RESULTS: %d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
    echo "ALL TESTS PASSED"
    exit 0
else
    echo "TEST FAILED"
    exit 1
fi
