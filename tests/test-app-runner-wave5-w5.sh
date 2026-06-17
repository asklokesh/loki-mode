#!/usr/bin/env bash
#
# Wave-5 (W5) bug-hunt regression tests for autonomy/app-runner.sh
#
# Covers two confirmed findings:
#   L5 -- PID-file reuse race: a reused PID (the OS reassigned the crashed app's
#         PID to an unrelated process) must NOT be reported as a healthy app.
#         The fix records a per-process identity token (ps lstart+comm) at start
#         and verifies it on health-check; a token mismatch on a LIVE pid means
#         the app is DEAD.
#   L6 -- non-atomic restart: when app_runner_start fails after the stop,
#         app_runner_restart must log an error and return non-zero (not silent
#         success).
#
# These are NON-VACUOUS: the L5 negative case points app.pid at a LIVE pid with
# a deliberately-wrong stored token (so kill -0 PASSES and only the token check
# can catch it). If the token logic were absent the test would FAIL.
#
# Run: bash tests/test-app-runner-wave5-w5.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_RUNNER="$REPO_ROOT/autonomy/app-runner.sh"

PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

# --- Stub the log_* helpers that app-runner.sh expects from run.sh ----------
log_info()  { :; }
log_step()  { :; }
log_warn()  { :; }
log_error() { LAST_LOG_ERROR="$*"; :; }
LAST_LOG_ERROR=""

# Source the real functions under test.
# shellcheck disable=SC1090
source "$APP_RUNNER"

# Per-test sandbox: drive the real _app_runner_dir() via TARGET_DIR.
SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/loki-test-w5.XXXXXX")"
cleanup() { rm -rf "$SANDBOX" 2>/dev/null || true; kill "${LIVE_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT

echo "=== L5: PID-file reuse race -> foreign live PID must report DEAD ==="

# Spawn a real, long-lived process we control. Its identity token is REAL.
sleep 600 &
LIVE_PID=$!

# Point app-runner state at the sandbox and at this live PID.
export TARGET_DIR="$SANDBOX"
_app_runner_dir   # sets _APP_RUNNER_DIR and mkdir -p

# --- L5 negative case: live PID, WRONG stored token -> DEAD -----------------
# Write a token file that deliberately does NOT match LIVE_PID's real token.
printf '%s\n' "Thu Jan  1 00:00:00 1970 totally-not-the-app" > "$_APP_RUNNER_DIR/app.token"
echo "$LIVE_PID" > "$_APP_RUNNER_DIR/app.pid"

# Force the non-HTTP / non-docker path so health_check relies purely on
# kill -0 + the token (no curl).
_APP_RUNNER_PID=""        # force re-read from app.pid
_APP_RUNNER_IS_DOCKER=false
_APP_RUNNER_METHOD="npm run dev"
_APP_RUNNER_PORT=""        # no port -> skips HTTP probe, uses token+kill-0 only

# Sanity: prove the PID really is alive (otherwise the test would be vacuous --
# kill -0 would fail for the wrong reason).
if kill -0 "$LIVE_PID" 2>/dev/null; then
    pass "negative-case precondition: target PID is genuinely alive"
else
    fail "negative-case precondition: target PID should be alive"
fi

if app_runner_health_check; then
    fail "L5 negative: foreign live PID with mismatched token reported HEALTHY (race not caught)"
else
    pass "L5 negative: foreign live PID with mismatched token reported DEAD"
fi
# health.json should record ok:false
if grep -q '"ok": false' "$_APP_RUNNER_DIR/health.json" 2>/dev/null; then
    pass "L5 negative: health.json records ok:false"
else
    fail "L5 negative: health.json did not record ok:false"
fi

# --- L5 positive case: live PID with CORRECT stored token -> HEALTHY --------
# Capture the REAL token for LIVE_PID via the production helper.
_write_app_token "$LIVE_PID"
echo "$LIVE_PID" > "$_APP_RUNNER_DIR/app.pid"
_APP_RUNNER_PID=""
_APP_RUNNER_PORT=""

# Confirm a real token was actually captured (else this case is vacuous).
if [ -s "$_APP_RUNNER_DIR/app.token" ]; then
    pass "L5 positive precondition: real token captured for live PID"
else
    fail "L5 positive precondition: no token captured (ps unavailable?)"
fi

if app_runner_health_check; then
    pass "L5 positive: live PID with matching token reported HEALTHY (no false-DEAD regression)"
else
    fail "L5 positive: live PID with matching token wrongly reported DEAD"
fi

# --- L5 fallback case: live PID, NO token file -> trust kill -0 (HEALTHY) ----
rm -f "$_APP_RUNNER_DIR/app.token"
echo "$LIVE_PID" > "$_APP_RUNNER_DIR/app.pid"
_APP_RUNNER_PID=""
_APP_RUNNER_PORT=""
if app_runner_health_check; then
    pass "L5 fallback: live PID with no token file trusts kill -0 (HEALTHY) -- no false-DEAD for pre-fix apps"
else
    fail "L5 fallback: live PID with no token file wrongly reported DEAD"
fi

# --- L5 unit: _app_runner_pid_is_ours direct assertions --------------------
printf '%s\n' "WRONG TOKEN VALUE" > "$_APP_RUNNER_DIR/app.token"
if _app_runner_pid_is_ours "$LIVE_PID"; then
    fail "L5 unit: _app_runner_pid_is_ours returned true on mismatched token"
else
    pass "L5 unit: _app_runner_pid_is_ours returns false on mismatched token"
fi
_write_app_token "$LIVE_PID"
if _app_runner_pid_is_ours "$LIVE_PID"; then
    pass "L5 unit: _app_runner_pid_is_ours returns true on matching token"
else
    fail "L5 unit: _app_runner_pid_is_ours returned false on matching token"
fi

echo "=== L6: non-atomic restart -> failed start must surface + return non-zero ==="

# Fresh sandbox state for the restart test.
export TARGET_DIR="$SANDBOX"
_app_runner_dir

# Stub app_runner_stop (no-op success) and app_runner_start (forced failure)
# so app_runner_restart exercises the failure-handling path.
app_runner_stop()  { return 0; }
app_runner_start() { return 1; }

LAST_LOG_ERROR=""
_APP_RUNNER_RESTART_COUNT=0
app_runner_restart
restart_rc=$?

if [ "$restart_rc" -ne 0 ]; then
    pass "L6: app_runner_restart returns non-zero ($restart_rc) when start fails"
else
    fail "L6: app_runner_restart returned 0 despite start failure (silent success)"
fi

if [ -n "$LAST_LOG_ERROR" ]; then
    pass "L6: app_runner_restart logged an error on failed start: '$LAST_LOG_ERROR'"
else
    fail "L6: app_runner_restart did NOT log an error on failed start"
fi

# --- L6 happy path: start succeeds -> return 0, no error -------------------
app_runner_start() { return 0; }
LAST_LOG_ERROR=""
app_runner_restart
restart_ok_rc=$?
if [ "$restart_ok_rc" -eq 0 ] && [ -z "$LAST_LOG_ERROR" ]; then
    pass "L6 happy path: successful restart returns 0 and logs no error"
else
    fail "L6 happy path: successful restart misbehaved (rc=$restart_ok_rc, err='$LAST_LOG_ERROR')"
fi

echo
echo "==============================="
echo "Wave-5 W5 results: $PASS passed, $FAIL failed"
echo "==============================="
[ "$FAIL" -eq 0 ]
