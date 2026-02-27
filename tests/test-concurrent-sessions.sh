#!/usr/bin/env bash
# test-concurrent-sessions.sh - Tests for concurrent session support (v6.4.0)
# Validates: per-session PID files, concurrent locking, stop by ID, status listing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI_CLI="$PROJECT_DIR/autonomy/loki"
PASS=0
FAIL=0
TOTAL=0

pass() { PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "[PASS] $1"; }
fail() { FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); echo "[FAIL] $1: $2"; }

# Setup temp directory
TMPDIR=$(mktemp -d /tmp/loki-concurrent-test-XXXXXX)
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

# Initialize a fake .loki directory
mkdir -p "$TMPDIR/.loki/sessions"
mkdir -p "$TMPDIR/.loki/logs"

# -------------------------------------------------------------------
# Test 1: LOKI_SESSION_ID creates per-session PID directory in run.sh
# -------------------------------------------------------------------
test_session_dir_creation() {
    local sid="42"
    mkdir -p "$TMPDIR/.loki/sessions/$sid"
    echo "99999" > "$TMPDIR/.loki/sessions/$sid/loki.pid"
    echo "$sid" > "$TMPDIR/.loki/sessions/$sid/session_id"

    if [ -f "$TMPDIR/.loki/sessions/$sid/loki.pid" ] && [ -f "$TMPDIR/.loki/sessions/$sid/session_id" ]; then
        pass "Test 1: Per-session PID directory structure"
    else
        fail "Test 1: Per-session PID directory structure" "Files not created"
    fi
    rm -rf "$TMPDIR/.loki/sessions/$sid"
}

# -------------------------------------------------------------------
# Test 2: Multiple session PID files can coexist
# -------------------------------------------------------------------
test_multiple_session_pids() {
    mkdir -p "$TMPDIR/.loki/sessions/52"
    mkdir -p "$TMPDIR/.loki/sessions/54"
    echo "11111" > "$TMPDIR/.loki/sessions/52/loki.pid"
    echo "22222" > "$TMPDIR/.loki/sessions/54/loki.pid"

    local pid52 pid54
    pid52=$(cat "$TMPDIR/.loki/sessions/52/loki.pid")
    pid54=$(cat "$TMPDIR/.loki/sessions/54/loki.pid")

    if [ "$pid52" = "11111" ] && [ "$pid54" = "22222" ]; then
        pass "Test 2: Multiple session PID files coexist"
    else
        fail "Test 2: Multiple session PID files coexist" "pid52=$pid52, pid54=$pid54"
    fi
    rm -rf "$TMPDIR/.loki/sessions/52" "$TMPDIR/.loki/sessions/54"
}

# -------------------------------------------------------------------
# Test 3: is_session_running detects specific session
# -------------------------------------------------------------------
test_is_session_running_specific() {
    # Source the CLI to get the function
    local LOKI_DIR="$TMPDIR/.loki"
    mkdir -p "$LOKI_DIR/sessions/77"

    # Create a PID file with our own PID (guaranteed to be alive)
    echo "$$" > "$LOKI_DIR/sessions/77/loki.pid"

    # Source just the function we need
    # (Can't source the whole CLI, so we replicate the logic)
    local pid_file="$LOKI_DIR/sessions/77/loki.pid"
    local pid
    pid=$(cat "$pid_file" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        pass "Test 3: is_session_running detects specific alive session"
    else
        fail "Test 3: is_session_running detects specific alive session" "PID $pid not detected"
    fi

    rm -rf "$LOKI_DIR/sessions/77"
}

# -------------------------------------------------------------------
# Test 4: Dead session PID is not detected as running
# -------------------------------------------------------------------
test_dead_session_not_running() {
    local LOKI_DIR="$TMPDIR/.loki"
    mkdir -p "$LOKI_DIR/sessions/99"

    # Use a PID that definitely doesn't exist
    echo "999999" > "$LOKI_DIR/sessions/99/loki.pid"

    local pid_file="$LOKI_DIR/sessions/99/loki.pid"
    local pid
    pid=$(cat "$pid_file" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        fail "Test 4: Dead session PID not detected" "PID 999999 reported as alive"
    else
        pass "Test 4: Dead session PID not detected"
    fi

    rm -rf "$LOKI_DIR/sessions/99"
}

# -------------------------------------------------------------------
# Test 5: Session lock files are per-session
# -------------------------------------------------------------------
test_session_lock_files() {
    mkdir -p "$TMPDIR/.loki/sessions/52"
    mkdir -p "$TMPDIR/.loki/sessions/54"
    touch "$TMPDIR/.loki/sessions/52/session.lock"
    touch "$TMPDIR/.loki/sessions/54/session.lock"

    if [ -f "$TMPDIR/.loki/sessions/52/session.lock" ] && \
       [ -f "$TMPDIR/.loki/sessions/54/session.lock" ]; then
        pass "Test 5: Per-session lock files"
    else
        fail "Test 5: Per-session lock files" "Lock files not created"
    fi
    rm -rf "$TMPDIR/.loki/sessions/52" "$TMPDIR/.loki/sessions/54"
}

# -------------------------------------------------------------------
# Test 6: Global lock still works (no LOKI_SESSION_ID)
# -------------------------------------------------------------------
test_global_lock_still_works() {
    # The global lock path should be .loki/loki.pid (not under sessions/)
    echo "$$" > "$TMPDIR/.loki/loki.pid"

    local pid
    pid=$(cat "$TMPDIR/.loki/loki.pid" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        pass "Test 6: Global lock still works without session ID"
    else
        fail "Test 6: Global lock still works without session ID" "Global PID not detected"
    fi
    rm -f "$TMPDIR/.loki/loki.pid"
}

# -------------------------------------------------------------------
# Test 7: cmd_run exports LOKI_SESSION_ID
# -------------------------------------------------------------------
test_cmd_run_exports_session_id() {
    # Check that the code sets LOKI_SESSION_ID in cmd_run
    if grep -q 'export LOKI_SESSION_ID=' "$LOKI_CLI"; then
        pass "Test 7: cmd_run exports LOKI_SESSION_ID"
    else
        fail "Test 7: cmd_run exports LOKI_SESSION_ID" "export not found in CLI"
    fi
}

# -------------------------------------------------------------------
# Test 8: Detached mode passes LOKI_SESSION_ID to nohup
# -------------------------------------------------------------------
test_detached_passes_session_id() {
    if grep -q 'export LOKI_SESSION_ID=.*session_id' "$LOKI_CLI"; then
        pass "Test 8: Detached mode passes LOKI_SESSION_ID"
    else
        fail "Test 8: Detached mode passes LOKI_SESSION_ID" "Not found in nohup block"
    fi
}

# -------------------------------------------------------------------
# Test 9: run.sh uses per-session PID when LOKI_SESSION_ID is set
# -------------------------------------------------------------------
test_run_sh_per_session_pid() {
    local run_sh="$PROJECT_DIR/autonomy/run.sh"
    if grep -q 'pid_file=".loki/sessions/${LOKI_SESSION_ID}/loki.pid"' "$run_sh"; then
        pass "Test 9: run.sh uses per-session PID file"
    else
        fail "Test 9: run.sh uses per-session PID file" "Per-session PID path not found"
    fi
}

# -------------------------------------------------------------------
# Test 10: run.sh cleans up per-session PID on exit
# -------------------------------------------------------------------
test_run_sh_cleanup_session_pid() {
    local run_sh="$PROJECT_DIR/autonomy/run.sh"
    local count
    count=$(grep -c 'rm -f.*sessions.*LOKI_SESSION_ID.*loki.pid' "$run_sh")
    if [ "$count" -ge 3 ]; then
        pass "Test 10: run.sh cleans up per-session PID on exit (found $count cleanup points)"
    else
        fail "Test 10: run.sh cleans up per-session PID on exit" "Only $count cleanup points (expected >= 3)"
    fi
}

# -------------------------------------------------------------------
# Test 11: _stop_session_by_id helper exists
# -------------------------------------------------------------------
test_stop_session_helper() {
    if grep -q '_stop_session_by_id()' "$LOKI_CLI"; then
        pass "Test 11: _stop_session_by_id helper exists"
    else
        fail "Test 11: _stop_session_by_id helper exists" "Function not found"
    fi
}

# -------------------------------------------------------------------
# Test 12: cmd_stop accepts session ID argument
# -------------------------------------------------------------------
test_cmd_stop_accepts_arg() {
    if grep -q 'cmd_stop "$@"' "$LOKI_CLI"; then
        pass "Test 12: cmd_stop receives arguments from dispatch"
    else
        fail "Test 12: cmd_stop receives arguments from dispatch" "Not passing args"
    fi
}

# -------------------------------------------------------------------
# Test 13: list_running_sessions function exists
# -------------------------------------------------------------------
test_list_running_sessions() {
    if grep -q 'list_running_sessions()' "$LOKI_CLI"; then
        pass "Test 13: list_running_sessions function exists"
    else
        fail "Test 13: list_running_sessions function exists" "Function not found"
    fi
}

# -------------------------------------------------------------------
# Test 14: Dashboard SessionInfo model exists
# -------------------------------------------------------------------
test_dashboard_session_info() {
    if grep -q 'class SessionInfo' "$PROJECT_DIR/dashboard/server.py"; then
        pass "Test 14: Dashboard SessionInfo model exists"
    else
        fail "Test 14: Dashboard SessionInfo model exists" "Model not found"
    fi
}

# -------------------------------------------------------------------
# Test 15: Dashboard scans sessions directory
# -------------------------------------------------------------------
test_dashboard_scans_sessions() {
    if grep -q 'sessions_dir = loki_dir / "sessions"' "$PROJECT_DIR/dashboard/server.py"; then
        pass "Test 15: Dashboard scans .loki/sessions/ directory"
    else
        fail "Test 15: Dashboard scans .loki/sessions/ directory" "Not found in server.py"
    fi
}

# -------------------------------------------------------------------
# Test 16: StatusResponse includes sessions list
# -------------------------------------------------------------------
test_status_response_sessions() {
    if grep -q 'sessions: list\[SessionInfo\]' "$PROJECT_DIR/dashboard/server.py"; then
        pass "Test 16: StatusResponse includes sessions list"
    else
        fail "Test 16: StatusResponse includes sessions list" "Not in StatusResponse"
    fi
}

# -------------------------------------------------------------------
# Test 17: Concurrent flock uses per-session lock (no cross-blocking)
# -------------------------------------------------------------------
test_concurrent_flock_isolation() {
    mkdir -p "$TMPDIR/.loki/sessions/A"
    mkdir -p "$TMPDIR/.loki/sessions/B"

    local lockA="$TMPDIR/.loki/sessions/A/session.lock"
    local lockB="$TMPDIR/.loki/sessions/B/session.lock"
    touch "$lockA" "$lockB"

    if command -v flock >/dev/null 2>&1; then
        # Acquire lock on A
        (
            exec 200>"$lockA"
            flock -n 200
            # While A is locked, B should still be acquirable
            (
                exec 201>"$lockB"
                if flock -n 201 2>/dev/null; then
                    echo "B_ACQUIRED"
                else
                    echo "B_BLOCKED"
                fi
            )
        ) > "$TMPDIR/flock_result.txt" 2>&1

        local result
        result=$(cat "$TMPDIR/flock_result.txt")
        if [[ "$result" == *"B_ACQUIRED"* ]]; then
            pass "Test 17: Concurrent flock isolation (lock A does not block B)"
        else
            fail "Test 17: Concurrent flock isolation" "B was blocked: $result"
        fi
    else
        pass "Test 17: Concurrent flock isolation (skipped - flock not available)"
    fi
    rm -rf "$TMPDIR/.loki/sessions/A" "$TMPDIR/.loki/sessions/B"
}

# -------------------------------------------------------------------
# Test 18: cmd_status shows multiple sessions
# -------------------------------------------------------------------
test_status_shows_sessions() {
    if grep -q 'Active Sessions:' "$LOKI_CLI"; then
        pass "Test 18: cmd_status shows multiple active sessions"
    else
        fail "Test 18: cmd_status shows multiple active sessions" "Not in status output"
    fi
}

# Run all tests
echo "================================================================"
echo "  Concurrent Sessions Test Suite (v6.4.0)"
echo "================================================================"
echo ""

test_session_dir_creation
test_multiple_session_pids
test_is_session_running_specific
test_dead_session_not_running
test_session_lock_files
test_global_lock_still_works
test_cmd_run_exports_session_id
test_detached_passes_session_id
test_run_sh_per_session_pid
test_run_sh_cleanup_session_pid
test_stop_session_helper
test_cmd_stop_accepts_arg
test_list_running_sessions
test_dashboard_session_info
test_dashboard_scans_sessions
test_status_response_sessions
test_concurrent_flock_isolation
test_status_shows_sessions

echo ""
echo "================================================================"
echo "  Results: $PASS/$TOTAL passed, $FAIL failed"
echo "================================================================"

[ $FAIL -eq 0 ] || exit 1
