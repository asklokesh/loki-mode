#!/usr/bin/env bash
#
# test-app-runner-watchdog-health.sh
#
# Regression test for the non-compose app_runner_watchdog HTTP-health gap.
#
# Bug being guarded:
#   The non-compose watchdog path used to treat `kill -0 $pid` succeeding as
#   "healthy" and return immediately. A process that is alive but no longer
#   serving HTTP (hung event loop, deadlock, wedged dev server) passes kill -0
#   forever, so it was never restarted and health.json went stale at ok:true.
#   Compounding: app_runner_health_check's HTTP-fail branch wrote ok:true
#   ("HTTP failed but process alive"), so the HTTP signal could never report
#   ok:false.
#
# What this test asserts (and how it is NON-VACUOUS):
#   1. WEDGED app  : a real, alive process (kill -0 true) whose declared port has
#                    NOTHING listening (curl -> connection refused, fast fail).
#                    The watchdog must detect this as a crash: increment the
#                    crash count AND attempt a restart (we stub app_runner_start
#                    + sleep so no real app spawns and no real backoff elapses).
#                    Against the PRE-FIX code this FAILS: kill -0 alone returns 0,
#                    crash count stays 0, app_runner_start is never called.
#   2. HEALTHY app : a real python3 -m http.server actually serving on its port.
#                    The watchdog must NOT restart it and must leave crash
#                    count at 0. (Guards against a restart storm / false positive.)
#   3. health.json : after the wedged probe, health.json must read ok:false.
#                    Against the PRE-FIX code this FAILS: it wrote ok:true.
#
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_RUNNER_SH="$REPO_ROOT/autonomy/app-runner.sh"

PASS=0
FAIL=0
ok()   { echo "PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# Isolated workspace; cleaned up on any exit.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-apprunner-wd.XXXXXX")"
HELPER_SERVER_PID=""
cleanup() {
    [ -n "$HELPER_SERVER_PID" ] && kill -9 "$HELPER_SERVER_PID" 2>/dev/null || true
    rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- stub external deps before sourcing -------------------------------------
# log_* are defined in sibling files (issue-parser.sh etc); stub them silent.
log_info()  { :; }
log_warn()  { :; }
log_error() { :; }
log_step()  { :; }
log_success() { :; }

# shellcheck disable=SC1090
source "$APP_RUNNER_SH"

# Stub app_runner_start + sleep so the restart path neither spawns a real app
# nor waits for the exponential backoff. Record whether start was attempted.
START_ATTEMPTS=0
app_runner_start() { START_ATTEMPTS=$((START_ATTEMPTS+1)); return 0; }
# Override sleep as a no-op shell function (skips real backoff waits).
sleep() { :; }

# Pick a high TCP port that is almost certainly closed (nothing listening) so
# curl fails fast with connection-refused for the WEDGED case.
CLOSED_PORT=59731
# Find an actually-free port for the healthy server; fall back to a fixed one.
HEALTHY_PORT=59732

reset_state() {
    # Fresh per-case .loki dir + reset all circuit-breaker globals.
    TARGET_DIR="$WORK/case-$1"
    mkdir -p "$TARGET_DIR"
    _APP_RUNNER_DIR=""
    _APP_RUNNER_PID=""
    _APP_RUNNER_IS_DOCKER=false
    _APP_RUNNER_METHOD="npm run dev"
    _APP_RUNNER_WEB_SERVICE=""
    _APP_RUNNER_HAS_SETSID=false
    _APP_RUNNER_CRASH_COUNT=0
    _APP_RUNNER_RESTART_COUNT=0
    _APP_RUNNER_URL=""
    START_ATTEMPTS=0
    _app_runner_dir
}

#=============================================================================
# Case 1: WEDGED -- alive process, port not serving -> must be treated as crash
#=============================================================================
reset_state wedged
# A real alive process (kill -0 true) that is NOT an HTTP server.
( exec sleep 600 ) &
WEDGED_PID=$!
_APP_RUNNER_PID="$WEDGED_PID"
echo "$WEDGED_PID" > "$_APP_RUNNER_DIR/app.pid"
_APP_RUNNER_PORT="$CLOSED_PORT"   # declared HTTP port with nothing listening

# Sanity: the process really is alive (so kill -0 alone would have said "ok").
if kill -0 "$WEDGED_PID" 2>/dev/null; then
    ok "wedged fixture process is alive (kill -0 succeeds)"
else
    bad "wedged fixture process should be alive"
fi

app_runner_watchdog >/dev/null 2>&1 || true

if [ "$_APP_RUNNER_CRASH_COUNT" -ge 1 ]; then
    ok "wedged app detected as crash (crash_count=$_APP_RUNNER_CRASH_COUNT)"
else
    bad "wedged app NOT detected as crash (crash_count=$_APP_RUNNER_CRASH_COUNT) -- kill -0 shortcut still present"
fi

if [ "$START_ATTEMPTS" -ge 1 ]; then
    ok "wedged app triggered a restart attempt (START_ATTEMPTS=$START_ATTEMPTS)"
else
    bad "wedged app did NOT trigger restart (START_ATTEMPTS=$START_ATTEMPTS)"
fi

# health.json must reflect ok:false after the failed HTTP probe.
HEALTH_JSON="$_APP_RUNNER_DIR/health.json"
if [ -f "$HEALTH_JSON" ] && grep -q '"ok": *false' "$HEALTH_JSON"; then
    ok "health.json reports ok:false on HTTP failure"
else
    bad "health.json did not report ok:false ($(cat "$HEALTH_JSON" 2>/dev/null))"
fi

# The wedged process should have been torn down before restart (no port leak).
kill -9 "$WEDGED_PID" 2>/dev/null || true

#=============================================================================
# Case 2: HEALTHY -- real HTTP server -> must NOT restart, crash_count stays 0
#=============================================================================
reset_state healthy
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not available for healthy-server case"
else
    ( cd "$WORK" && exec python3 -m http.server "$HEALTHY_PORT" >/dev/null 2>&1 ) &
    HELPER_SERVER_PID=$!
    _APP_RUNNER_PID="$HELPER_SERVER_PID"
    echo "$HELPER_SERVER_PID" > "$_APP_RUNNER_DIR/app.pid"
    _APP_RUNNER_PORT="$HEALTHY_PORT"

    # Wait for the server to actually accept connections (up to ~3s).
    served=false
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
        if curl -sf -o /dev/null -m 1 "http://localhost:${HEALTHY_PORT}/" 2>/dev/null; then
            served=true; break
        fi
        command sleep 0.2
    done

    if [ "$served" = true ]; then
        ok "healthy fixture server is serving HTTP"
        app_runner_watchdog >/dev/null 2>&1 || true
        if [ "$_APP_RUNNER_CRASH_COUNT" -eq 0 ]; then
            ok "healthy app NOT counted as crash (crash_count=0)"
        else
            bad "healthy app wrongly counted as crash (crash_count=$_APP_RUNNER_CRASH_COUNT)"
        fi
        if [ "$START_ATTEMPTS" -eq 0 ]; then
            ok "healthy app NOT restarted (no restart storm)"
        else
            bad "healthy app wrongly restarted (START_ATTEMPTS=$START_ATTEMPTS)"
        fi
        if grep -q '"ok": *true' "$_APP_RUNNER_DIR/health.json" 2>/dev/null; then
            ok "health.json reports ok:true for healthy app"
        else
            bad "health.json did not report ok:true for healthy app"
        fi
    else
        bad "healthy fixture server never came up (cannot validate no-restart case)"
    fi
    kill -9 "$HELPER_SERVER_PID" 2>/dev/null || true
    HELPER_SERVER_PID=""
fi

#=============================================================================
# Case 3: ALIVE + 404 on / -- an API-only backend that serves HTTP but returns
#         a non-2xx on the root path. It IS serving (just not 2xx on /), so it
#         must NOT be restarted. Guards against the curl -f false-positive: a
#         status-strict probe would treat 404 as "down" and restart a healthy
#         API backend (restart storm). The fix keys on "did the server answer at
#         all" (HTTP status code != 000), not on a 2xx.
#=============================================================================
reset_state api404
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not available for 404-backend case"
else
    API_PORT=59733
    # Minimal HTTP server that returns 404 on every path (an API-only backend
    # with no root route). It is genuinely serving HTTP, just not 2xx on /.
    cat > "$WORK/api404_server.py" <<'PYEOF'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(404)
        self.end_headers()
        self.wfile.write(b"not found")
    def log_message(self, *a):
        pass
HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PYEOF
    ( exec python3 "$WORK/api404_server.py" "$API_PORT" >/dev/null 2>&1 ) &
    API_PID=$!
    _APP_RUNNER_PID="$API_PID"
    echo "$API_PID" > "$_APP_RUNNER_DIR/app.pid"
    _APP_RUNNER_PORT="$API_PORT"

    # Wait until it actually answers (with a 404).
    answered=false
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
        code=$(curl -s -o /dev/null -m 1 -w '%{http_code}' "http://localhost:${API_PORT}/" 2>/dev/null || echo "000")
        if [ "$code" = "404" ]; then answered=true; break; fi
        command sleep 0.2
    done

    if [ "$answered" = true ]; then
        ok "404-backend fixture is serving HTTP (returns 404 on /)"
        app_runner_watchdog >/dev/null 2>&1 || true
        if [ "$_APP_RUNNER_CRASH_COUNT" -eq 0 ]; then
            ok "404-on-root backend NOT counted as crash (serving != 2xx)"
        else
            bad "404-on-root backend wrongly counted as crash (crash_count=$_APP_RUNNER_CRASH_COUNT) -- curl -f false positive"
        fi
        if [ "$START_ATTEMPTS" -eq 0 ]; then
            ok "404-on-root backend NOT restarted (no restart storm)"
        else
            bad "404-on-root backend wrongly restarted (START_ATTEMPTS=$START_ATTEMPTS)"
        fi
        if grep -q '"ok": *true' "$_APP_RUNNER_DIR/health.json" 2>/dev/null; then
            ok "health.json reports ok:true for serving (404-root) backend"
        else
            bad "health.json did not report ok:true for serving 404-root backend"
        fi
    else
        bad "404-backend fixture never came up (cannot validate)"
    fi
    kill -9 "$API_PID" 2>/dev/null || true
fi

#=============================================================================
echo "----------------------------------------"
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
