#!/usr/bin/env bash
#===============================================================================
# Test: app-runner port pass-through + reconcile (HIGH finding #597)
#
# Verifies the two fixes that keep the dashboard Live Preview pointed at the
# port the app ACTUALLY bound:
#
#   Fix 1 (pass PORT): app-runner exports PORT into the child env, so an app
#          that reads `process.env.PORT || 4000` binds Loki's chosen port and
#          state.json records the same port the app serves on.
#
#   Fix 2 (reconcile): when an app IGNORES PORT and binds its own port,
#          app-runner parses the real port from the app.log listen line and
#          rewrites state.json / detection.json / the preview URL to the real
#          port (not the stale guess).
#
# Also unit-tests _parse_listen_port against common listen-line shapes.
#
# SKIPS gracefully when node is unavailable so CI without node does not fail.
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
SKIP=0

note_pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
note_fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL+1)); }
note_skip() { printf 'SKIP: %s\n' "$1"; SKIP=$((SKIP+1)); }

finish() {
    printf '\nResult: %d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIP"
    [ "$FAIL" -eq 0 ]
}

# Read the "port" integer from a JSON state/detection file (grep-based, matches
# the parsing style used elsewhere in the project).
_json_port() {
    grep -o '"port": *[0-9]*' "$1" 2>/dev/null | head -1 | grep -oE '[0-9]+'
}
_json_url() {
    grep -o '"url": *"[^"]*"' "$1" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/'
}

# Pick a free-ish TCP port in a high range to reduce collision odds.
_free_port() {
    local p
    for _ in 1 2 3 4 5; do
        p=$(( (RANDOM % 5000) + 20000 ))
        if ! lsof -ti:"$p" >/dev/null 2>&1; then
            printf '%s\n' "$p"
            return 0
        fi
    done
    printf '%s\n' "$p"
}

# shellcheck disable=SC1091
TARGET_DIR=""
source "$REPO_ROOT/autonomy/app-runner.sh"

#------------------------------------------------------------------------------
# Unit: _parse_listen_port across listen-line shapes
#------------------------------------------------------------------------------
PARSE_DIR="$(mktemp -d -t loki-parse.XXXXXX)"
_APP_RUNNER_DIR="$PARSE_DIR"

check_parse() {
    local desc="$1"; local line="$2"; local want="$3"
    printf '%s\n' "$line" > "$PARSE_DIR/log"
    local got
    got=$(_parse_listen_port "$PARSE_DIR/log")
    if [ "$got" = "$want" ]; then
        note_pass "parse: $desc -> $got"
    else
        note_fail "parse: $desc expected '$want' got '$got'"
    fi
}

check_parse "node listening url"    "Server listening on http://127.0.0.1:4000" "4000"
check_parse "express running on"    "Example app listening on port 3210"        "3210"
check_parse "vite localhost url"    "  > Local:   http://localhost:5173/"        "5173"
check_parse "ansi-wrapped url"      $'\x1b[32mready\x1b[0m - started server on http://localhost:3001' "3001"
check_parse "running on host:port"  "Server running on 0.0.0.0:8080"             "8080"
check_parse "iso-ts + port word"    "2026-06-14T12:30:45 info: Server listening on port 8080" "8080"
check_parse "bracket-ts + port="    "[12:30:45] Server started, port=3000"       "3000"
# A line with no plausible listen info must NOT yield a port.
printf '%s\n' "compiling modules at 12:30:45" > "$PARSE_DIR/log"
if [ -z "$(_parse_listen_port "$PARSE_DIR/log")" ]; then
    note_pass "parse: noise line yields no port"
else
    note_fail "parse: noise line wrongly produced a port"
fi
rm -rf "$PARSE_DIR"

#------------------------------------------------------------------------------
# Integration: requires node
#------------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
    note_skip "node not installed -- skipping start/reconcile integration"
    finish
    exit $?
fi

run_app_case() {
    # $1 = description, $2 = server.js body, $3 = recorded(guessed) port,
    # $4 = expected final state.json port
    local desc="$1" server_body="$2" recorded="$3" expected="$4"
    local proj
    proj="$(mktemp -d -t loki-app-reconcile.XXXXXX)"
    printf '%s\n' "$server_body" > "$proj/server.js"

    # Reset module state for an isolated run. TARGET_DIR is consumed by
    # _app_runner_dir inside the sourced app-runner.sh, not directly here.
    # shellcheck disable=SC2034
    TARGET_DIR="$proj"
    _APP_RUNNER_DIR=""
    _APP_RUNNER_PID=""
    _APP_RUNNER_URL="http://localhost:${recorded}"
    _APP_RUNNER_IS_DOCKER=false
    _APP_RUNNER_HAS_SETSID=false
    _APP_RUNNER_CRASH_COUNT=0
    _APP_RUNNER_METHOD="node server.js"
    _APP_RUNNER_PORT="$recorded"
    _app_runner_dir
    # Seed detection.json the way app_runner_init would.
    _write_detection "override" "node server.js"
    # Faster reconcile window for the test.
    export LOKI_APP_PORT_RECONCILE_SECS=6

    app_runner_start >/dev/null 2>&1

    local state="$_APP_RUNNER_DIR/state.json"
    local got_port got_url det_port
    got_port=$(_json_port "$state")
    got_url=$(_json_url "$state")
    det_port=$(_json_port "$_APP_RUNNER_DIR/detection.json")

    if [ "$got_port" = "$expected" ]; then
        note_pass "$desc: state.json port = $got_port"
    else
        note_fail "$desc: state.json port expected $expected got '$got_port'"
        printf '  app.log:\n'; sed 's/^/    /' "$_APP_RUNNER_DIR/app.log" 2>/dev/null
    fi
    if [ "$got_url" = "http://localhost:${expected}" ]; then
        note_pass "$desc: state.json url = $got_url"
    else
        note_fail "$desc: state.json url expected http://localhost:${expected} got '$got_url'"
    fi
    if [ "$det_port" = "$expected" ]; then
        note_pass "$desc: detection.json port = $det_port"
    else
        note_fail "$desc: detection.json port expected $expected got '$det_port'"
    fi

    # Tear down the app process group.
    app_runner_stop >/dev/null 2>&1
    rm -rf "$proj"
    unset LOKI_APP_PORT_RECONCILE_SECS
}

CHOSEN=$(_free_port)
HARDCODED=$(_free_port)
# Ensure the two ports differ so the reconcile case is meaningful.
while [ "$HARDCODED" = "$CHOSEN" ]; do HARDCODED=$(_free_port); done

# Case A (fix 1): app honors PORT. Recorded port == chosen port; app should
# bind it and the recorded port stays correct (no reconcile needed).
run_app_case "honors-PORT" \
"const p = process.env.PORT || 4000;
require('http').createServer((q,r)=>{r.end('ok');}).listen(p, ()=>{
  console.log('Server listening on http://127.0.0.1:'+p);
});" \
"$CHOSEN" "$CHOSEN"

# Case B (fix 2): app IGNORES PORT and hardcodes its own port. Recorded port is
# a STALE guess (CHOSEN); app binds HARDCODED; reconcile must rewrite state to
# HARDCODED so the preview is not dead.
run_app_case "ignores-PORT-reconciles" \
"const p = ${HARDCODED};
require('http').createServer((q,r)=>{r.end('ok');}).listen(p, ()=>{
  console.log('Server listening on http://127.0.0.1:'+p);
});" \
"$CHOSEN" "$HARDCODED"

finish
exit $?
