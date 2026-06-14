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
# Spring Boot "port(s):" form (the generic port[ =:]+ scan misses the "(s):").
check_parse "spring boot port(s)"   "Tomcat started on port(s): 8081 (http) with context path ''" "8081"
# A line with no plausible listen info must NOT yield a port.
printf '%s\n' "compiling modules at 12:30:45" > "$PARSE_DIR/log"
if [ -z "$(_parse_listen_port "$PARSE_DIR/log")" ]; then
    note_pass "parse: noise line yields no port"
else
    note_fail "parse: noise line wrongly produced a port"
fi

# DB-connection noise carries no serving keyword, so it must NOT yield a port.
printf '%s\n' "Connecting to database on port 5432" > "$PARSE_DIR/log"
if [ -z "$(_parse_listen_port "$PARSE_DIR/log")" ]; then
    note_pass "parse: DB-connection noise yields no port"
else
    note_fail "parse: DB-connection noise wrongly produced a port"
fi

# Metrics endpoint line carries serving keywords ("server"/"listening"), so the
# PARSER can still return the metrics port. That is acceptable -- the reconcile
# layer's liveness check is what rejects a non-serving port (asserted below).
# Here we only document the parser behavior on a serving-URL-then-metrics log.
printf '%s\n' "Server running on http://localhost:3000" \
              "Prometheus metrics server listening on http://0.0.0.0:9464" \
              > "$PARSE_DIR/log"
parsed_metrics=$(_parse_listen_port "$PARSE_DIR/log")
if [ "$parsed_metrics" = "9464" ] || [ "$parsed_metrics" = "3000" ]; then
    note_pass "parse: metrics-after-serving returns a plausible port ($parsed_metrics)"
else
    note_fail "parse: metrics-after-serving expected 9464 or 3000, got '$parsed_metrics'"
fi
rm -rf "$PARSE_DIR"

#------------------------------------------------------------------------------
# Unit: _app_runner_reconcile_port liveness guard (mocked curl, no node needed)
#
# These exercise the PRIMARY fix: a parsed port is only committed when it
# actually serves HTTP. curl is stubbed so we control which ports "serve".
#------------------------------------------------------------------------------
RECON_DIR="$(mktemp -d -t loki-recon.XXXXXX)"
_APP_RUNNER_DIR="$RECON_DIR"
_APP_RUNNER_IS_DOCKER=false

# Stub curl modeling the real `curl -s -o /dev/null -m 2 http://localhost:PORT/`
# idiom (NO -f): curl exits 0 for ANY HTTP response, including 4xx/5xx, and only
# non-zero on a connection failure (dead/unbound port).
#   _LIVE_PORTS       -- ports that respond 2xx (alive)
#   _LIVE_404_PORTS   -- ports that respond non-2xx (e.g. Spring Boot whitelabel
#                        404, REST-only or auth-gated "/") but ARE bound/serving.
# Both sets must yield exit 0 (a bound server responded). If the stub used the
# old `-f` behavior, _LIVE_404_PORTS would exit non-zero and the reconcile would
# wrongly skip a live relocated port -- the regression this case guards.
_LIVE_PORTS=""
_LIVE_404_PORTS=""
curl() {
    local url="" arg has_f=false
    for arg in "$@"; do
        case "$arg" in
            -*f*) case "$arg" in -[A-Za-z]*f*|-f) has_f=true ;; esac ;;
            http*://*) url="$arg" ;;
        esac
    done
    local p
    p=$(printf '%s\n' "$url" | grep -oE ':[0-9]+/' | grep -oE '[0-9]+')
    case " $_LIVE_PORTS " in
        *" $p "*) return 0 ;;
    esac
    case " $_LIVE_404_PORTS " in
        # A non-2xx-but-alive port: exit 0 without -f, non-zero with -f.
        *" $p "*) if [ "$has_f" = "true" ]; then return 22; else return 0; fi ;;
    esac
    return 7   # connection refused: port is dead/unbound
}

reset_recon() {
    # $1 = recorded port, $2... = app.log lines
    local recorded="$1"; shift
    _APP_RUNNER_PORT="$recorded"
    _APP_RUNNER_URL="http://localhost:${recorded}"
    _APP_RUNNER_PID=""
    : > "$RECON_DIR/app.log"
    local line
    for line in "$@"; do printf '%s\n' "$line" >> "$RECON_DIR/app.log"; done
    _write_detection "override" "node server.js"
    export LOKI_APP_PORT_RECONCILE_SECS=2
}

# Case 1 (the v7.41.1 corruption bug): recorded 3000 is CORRECT, but the
# fast-path curl flakes (Next.js first-compile > 2s), and the parser surfaces
# the metrics port 9464 from a line logged after the serving URL. Without the
# liveness guard the reconcile would clobber 3000 with the dead 9464. With the
# guard: fast-path fails (3000 not yet live in this stub), parser returns 9464,
# 9464 fails liveness -> recorded 3000 is kept.
reset_recon 3000 \
    "Server running on http://localhost:3000" \
    "Prometheus metrics server listening on http://0.0.0.0:9464"
_LIVE_PORTS=""   # 3000 flaking at fast-path; metrics port 9464 never serves
_app_runner_reconcile_port
if [ "$_APP_RUNNER_PORT" = "3000" ] && [ "$_APP_RUNNER_URL" = "http://localhost:3000" ]; then
    note_pass "reconcile: metrics-after-serving + flaky fast-path keeps recorded 3000"
else
    note_fail "reconcile: metrics-after-serving expected 3000 got '$_APP_RUNNER_PORT' ($_APP_RUNNER_URL)"
fi

# Case 2: liveness verifies BEFORE commit -- recorded port flakes (fast-path
# curl fails) but the parsed port genuinely serves -> reconcile commits it.
reset_recon 3000 "Server listening on http://127.0.0.1:4100"
_LIVE_PORTS="4100"   # recorded 3000 not live (fast path fails), 4100 serves
_app_runner_reconcile_port
if [ "$_APP_RUNNER_PORT" = "4100" ] && [ "$_APP_RUNNER_URL" = "http://localhost:4100" ]; then
    note_pass "reconcile: live parsed port 4100 committed over flaky recorded 3000"
else
    note_fail "reconcile: expected commit to 4100 got '$_APP_RUNNER_PORT' ($_APP_RUNNER_URL)"
fi

# Case 3: parsed port does NOT serve (e.g. a DB/metrics-only port) and neither
# does the recorded port at parse time -> keep the recorded port, never commit a
# dead port.
reset_recon 3000 "Server listening on port 5432"
_LIVE_PORTS=""   # nothing serves
_app_runner_reconcile_port
if [ "$_APP_RUNNER_PORT" = "3000" ]; then
    note_pass "reconcile: non-serving parsed port rejected, recorded 3000 kept"
else
    note_fail "reconcile: expected recorded 3000 kept got '$_APP_RUNNER_PORT'"
fi

# Case 4 (no regression on the happy reconcile): recorded port is a stale guess,
# the app bound a different port that serves -> commit the real port.
reset_recon 3000 "Server running on http://localhost:8081"
_LIVE_PORTS="8081"
_app_runner_reconcile_port
if [ "$_APP_RUNNER_PORT" = "8081" ]; then
    note_pass "reconcile: stale guess 3000 reconciled to live 8081"
else
    note_fail "reconcile: expected 8081 got '$_APP_RUNNER_PORT'"
fi

# Case 5 (the v7.41.3 council fix): the relocated serving port responds non-2xx
# on "/" (Spring Boot whitelabel 404, REST-only or auth-gated root) but IS bound
# and serving. With curl -f it would look dead and the reconcile would skip,
# keeping the old dead port (reintroducing #597). Without -f, any HTTP response
# proves the port is live, so the reconcile commits it.
reset_recon 3000 "Tomcat started on port(s): 8081 (http) with context path ''"
_LIVE_PORTS=""
_LIVE_404_PORTS="8081"   # 8081 serves but returns 404 on /
_app_runner_reconcile_port
if [ "$_APP_RUNNER_PORT" = "8081" ] && [ "$_APP_RUNNER_URL" = "http://localhost:8081" ]; then
    note_pass "reconcile: alive-but-404 port 8081 committed (curl -f would have wrongly skipped)"
else
    note_fail "reconcile: alive-but-404 expected commit to 8081 got '$_APP_RUNNER_PORT' ($_APP_RUNNER_URL)"
fi

unset -f curl
unset LOKI_APP_PORT_RECONCILE_SECS _LIVE_404_PORTS
rm -rf "$RECON_DIR"

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
