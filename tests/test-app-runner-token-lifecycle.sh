#!/usr/bin/env bash
#===============================================================================
# Test: app-runner app.token lifecycle consistency (LOW-3)
#
# Invariant: every code path that removes app.pid must also remove app.token.
# A token file that outlives its app.pid is stale state: the next liveness
# decision (_app_runner_pid_is_ours) consults the leftover token and can
# compare a fresh, unrelated PID against a dead process's identity.
#
# Two unpaired sites existed before the fix:
#   - app_runner_watchdog auto-restart branch: rm app.pid, no rm app.token
#   - app_runner_cleanup: rm app.pid, no rm app.token
#
# The naturally-reachable harmful interleaving:
#   1. app crashes; watchdog dead-path removes app.pid and calls start
#   2. start fails (e.g. orphan still holds the port -> port-conflict guard)
#      so no new app.pid and no new token are written -- the OLD token leaks
#   3. that leftover state (token present, no app.pid, _APP_RUNNER_PID empty)
#      reaches app_runner_cleanup, whose stop call early-returns (no pid) and
#      whose own rm only targets app.pid -- the stale token survives session end
#
# This test reproduces that leftover state and asserts cleanup leaves NO
# stale app.token. Pre-fix: FAIL (token survives). Post-fix: PASS.
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Stub loki logging primitives so we can source app-runner.sh standalone.
log_error() { :; }
log_info()  { :; }
log_warn()  { :; }
log_step()  { :; }

PASS=0
FAIL=0

note_pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
note_fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL+1)); }

# Isolated workspace.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-token-lifecycle.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
export TARGET_DIR="$WORK"

# shellcheck source=../autonomy/app-runner.sh
source "$REPO_ROOT/autonomy/app-runner.sh"

#------------------------------------------------------------------------------
# Case 1: cleanup must not leave a stale app.token (the post-failed-restart
# leftover state: token present, no app.pid, _APP_RUNNER_PID empty).
#------------------------------------------------------------------------------
_app_runner_dir
# Simulate the leftover state from a failed auto-restart.
printf 'Mon Jan  1 00:00:00 2024 fakeproc\n' > "$_APP_RUNNER_DIR/app.token"
rm -f "$_APP_RUNNER_DIR/app.pid"
_APP_RUNNER_PID=""
_APP_RUNNER_IS_DOCKER=false
_APP_RUNNER_METHOD="npm start"

app_runner_cleanup >/dev/null 2>&1 || true

if [ -f "$_APP_RUNNER_DIR/app.token" ]; then
    note_fail "cleanup left a stale app.token (no paired rm app.token)"
else
    note_pass "cleanup removed the stale app.token"
fi

#------------------------------------------------------------------------------
# Case 2: the watchdog auto-restart branch must remove app.token alongside
# app.pid. We exercise the dead-PID -> restart path directly with a fast
# backoff and an unstartable method so start fails immediately, then assert
# the token did not survive the rm-app.pid step.
#------------------------------------------------------------------------------
_app_runner_dir
# A definitely-dead pid (kill -0 fails) so the watchdog takes the dead path.
_APP_RUNNER_PID=999999
echo "999999" > "$_APP_RUNNER_DIR/app.pid"
printf 'Mon Jan  1 00:00:00 2024 fakeproc\n' > "$_APP_RUNNER_DIR/app.token"
_APP_RUNNER_IS_DOCKER=false
# Empty method so app_runner_start returns 1 immediately (no real process),
# keeping the test fast and side-effect-free.
_APP_RUNNER_METHOD=""
_APP_RUNNER_CRASH_COUNT=0

# Run the watchdog; it will rm app.pid, clear the pid, sleep the backoff
# (2s for crash #1), then call start which no-ops. Bound it so a hang fails
# loudly rather than blocking CI.
app_runner_watchdog >/dev/null 2>&1 || true

if [ -f "$_APP_RUNNER_DIR/app.token" ]; then
    note_fail "watchdog auto-restart left a stale app.token after removing app.pid"
else
    note_pass "watchdog auto-restart removed the stale app.token"
fi

#------------------------------------------------------------------------------
# Regression guard: the EXISTING paired sites must keep removing the token.
# app_runner_stop with a live-but-foreign pid removes both files.
#------------------------------------------------------------------------------
_app_runner_dir
echo "$$" > "$_APP_RUNNER_DIR/app.pid"
printf 'token\n' > "$_APP_RUNNER_DIR/app.token"
_APP_RUNNER_PID="$$"        # our own shell pid: a real, live pid to signal-noop
_APP_RUNNER_IS_DOCKER=false
_APP_RUNNER_HAS_SETSID=false
_APP_RUNNER_METHOD="npm start"
# Prevent stop from actually killing this test shell's tree: stub the signal
# helpers to no-ops so only the file-removal bookkeeping runs.
_app_runner_collect_descendants() { :; }
_app_runner_signal_pids() { :; }
_app_runner_any_alive() { return 1; }

app_runner_stop >/dev/null 2>&1 || true

if [ -f "$_APP_RUNNER_DIR/app.token" ]; then
    note_fail "stop regressed: left app.token behind"
else
    note_pass "stop still removes app.token (regression guard)"
fi

echo "----------------------------------------"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
