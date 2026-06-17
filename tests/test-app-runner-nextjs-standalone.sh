#!/usr/bin/env bash
#===============================================================================
# Test: app-runner Next.js standalone detection + reverse-proxy URL probing (B1)
#
# Covers two additions to autonomy/app-runner.sh:
#
#   1) _detect_nextjs_standalone + app_runner_init wiring: a Next.js build with
#      output: 'standalone' emits a self-contained `.next/standalone/server.js`
#      launched with `node server.js` (not `next start`). The package.json branch
#      detects the artifact BEFORE the dev/start scripts and surfaces the
#      preview URL (default port 3000).
#
#   2) _probe_app_url + reconcile fallback: when an app sits behind a reverse
#      proxy or binds a port we did not choose and logs no recognizable listen
#      line, we PROBE app-scoped candidate ports and surface only a port that
#      actually responds. We MUST NEVER fabricate a URL for a non-listening port.
#
# Non-vacuity: the "URL surfaced" probe runs against a REAL background HTTP
# listener (python3 -m http.server on an ephemeral high port) and asserts the
# helper returns that exact URL; the "no fabrication" case probes a port with
# nothing listening and asserts the helper returns the empty string. If the
# helpers were stubs that always (or never) returned a URL, one of the two
# assertions would fail.
#
# SKIPS gracefully when curl or python3 is unavailable so CI without them does
# not fail.
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

# Pick a free-ish TCP port in a high range to reduce collision odds.
_free_port() {
    local p
    for _ in 1 2 3 4 5; do
        p=$(( (RANDOM % 5000) + 25000 ))
        if ! lsof -ti:"$p" >/dev/null 2>&1; then
            printf '%s\n' "$p"
            return 0
        fi
    done
    printf '%s\n' "$p"
}

# Track resources for trap-based cleanup (never leak a process or temp dir).
_HTTP_PID=""
_TMP_DIRS=()
cleanup() {
    [ -n "$_HTTP_PID" ] && kill "$_HTTP_PID" 2>/dev/null
    local d
    for d in "${_TMP_DIRS[@]:-}"; do
        [ -n "$d" ] && rm -rf "$d"
    done
}
trap cleanup EXIT INT TERM

# shellcheck disable=SC1091
TARGET_DIR=""
APP_RUNNER_ENABLED="true"
source "$REPO_ROOT/autonomy/app-runner.sh"

#------------------------------------------------------------------------------
# Unit: _detect_nextjs_standalone keys on the built artifact, not config text
#------------------------------------------------------------------------------
NJS_DIR="$(mktemp -d -t loki-njs.XXXXXX)"; _TMP_DIRS+=("$NJS_DIR")

# A plain Next.js project (no standalone build) must NOT be detected as
# standalone -- a normal `.next/` dir does not contain standalone/server.js.
mkdir -p "$NJS_DIR/.next"
if [ -z "$(_detect_nextjs_standalone "$NJS_DIR")" ]; then
    note_pass "detect: plain .next/ (no standalone) yields no standalone method"
else
    note_fail "detect: plain .next/ wrongly detected as standalone"
fi

# A standalone build (.next/standalone/server.js present) IS detected and the
# run method is the node-server.js launch.
mkdir -p "$NJS_DIR/.next/standalone"
: > "$NJS_DIR/.next/standalone/server.js"
njs_method="$(_detect_nextjs_standalone "$NJS_DIR")"
if [ "$njs_method" = "node .next/standalone/server.js" ]; then
    note_pass "detect: standalone artifact -> '$njs_method'"
else
    note_fail "detect: standalone expected 'node .next/standalone/server.js' got '$njs_method'"
fi

#------------------------------------------------------------------------------
# Integration: app_runner_init surfaces the standalone method + a preview URL
#------------------------------------------------------------------------------
INIT_DIR="$(mktemp -d -t loki-njs-init.XXXXXX)"; _TMP_DIRS+=("$INIT_DIR")
# Minimal Next.js standalone project: package.json with a start script (which
# must be IGNORED in favor of the standalone artifact) + the built server.js.
cat > "$INIT_DIR/package.json" <<'JSON'
{ "name": "njs-app", "scripts": { "start": "next start", "build": "next build" },
  "dependencies": { "next": "14.0.0" } }
JSON
mkdir -p "$INIT_DIR/.next/standalone"
: > "$INIT_DIR/.next/standalone/server.js"

# Reset module state and run only the detection (not start). Stub the node-dep
# installer so init does not try to run npm.
_install_node_deps() { :; }
# shellcheck disable=SC2034
TARGET_DIR="$INIT_DIR"
_APP_RUNNER_DIR=""
_APP_RUNNER_METHOD=""
_APP_RUNNER_URL=""
_APP_RUNNER_PORT=""
_APP_RUNNER_IS_DOCKER=false
unset LOKI_APP_COMMAND LOKI_APP_PORT 2>/dev/null || true

if app_runner_init >/dev/null 2>&1; then
    if [ "$_APP_RUNNER_METHOD" = "node .next/standalone/server.js" ]; then
        note_pass "init: standalone method chosen over package.json start"
    else
        note_fail "init: expected standalone method, got '$_APP_RUNNER_METHOD'"
    fi
    # URL surfaced at default Next port 3000 (no .env PORT override present).
    if [ "$_APP_RUNNER_URL" = "http://localhost:3000" ]; then
        note_pass "init: preview URL surfaced ($_APP_RUNNER_URL)"
    else
        note_fail "init: expected http://localhost:3000 got '$_APP_RUNNER_URL'"
    fi
else
    note_fail "init: app_runner_init returned non-zero for a standalone project"
fi

#------------------------------------------------------------------------------
# Unit: _probe_app_url -- real probing, no fabrication
#------------------------------------------------------------------------------
if ! command -v curl >/dev/null 2>&1; then
    note_skip "curl not installed -- skipping probe assertions"
    finish
    exit $?
fi
if ! command -v python3 >/dev/null 2>&1; then
    note_skip "python3 not installed -- skipping probe assertions"
    finish
    exit $?
fi

# (a) NO fabrication: probe a port with nothing listening -> empty result. We
# isolate the candidate set to a single confirmed-dead port via LOKI_APP_PORT so
# the helper cannot fall through to some other live local service.
DEAD_PORT=$(_free_port)
# Make sure nothing is actually on it (a free port should be dead).
if curl -s -o /dev/null -m 1 "http://localhost:${DEAD_PORT}/" 2>/dev/null; then
    note_skip "port $DEAD_PORT unexpectedly live -- skipping no-fabrication case"
else
    _APP_RUNNER_PORT="$DEAD_PORT"
    LOKI_APP_PORT="$DEAD_PORT"
    probed_dead="$(_probe_app_url "$DEAD_PORT")"
    unset LOKI_APP_PORT
    if [ -z "$probed_dead" ]; then
        note_pass "probe: non-listening port yields NO fabricated URL"
    else
        note_fail "probe: non-listening port fabricated a URL: '$probed_dead'"
    fi
fi

# (b) URL surfaced for a REAL listener. Start python3 -m http.server on an
# ephemeral high port, wait for it to bind, then assert the helper surfaces it.
LIVE_PORT=$(_free_port)
while [ "$LIVE_PORT" = "${DEAD_PORT:-}" ]; do LIVE_PORT=$(_free_port); done
python3 -m http.server "$LIVE_PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
_HTTP_PID=$!

# Wait (bounded) for the listener to accept connections.
_up=false
for _ in $(seq 1 30); do
    if curl -s -o /dev/null -m 1 "http://localhost:${LIVE_PORT}/" 2>/dev/null; then
        _up=true; break
    fi
    sleep 0.2
done

if [ "$_up" != true ]; then
    note_skip "background http.server did not come up on $LIVE_PORT -- skipping live probe"
else
    # Candidate set: recorded port is the dead one, default arg is the live one.
    # The helper must skip the dead recorded port and surface the live default,
    # proving it probes rather than blindly returning the first candidate.
    _APP_RUNNER_PORT="$DEAD_PORT"
    unset LOKI_APP_PORT 2>/dev/null || true
    probed_live="$(_probe_app_url "$LIVE_PORT")"
    if [ "$probed_live" = "http://localhost:${LIVE_PORT}" ]; then
        note_pass "probe: live listener URL surfaced ($probed_live)"
    else
        note_fail "probe: expected http://localhost:${LIVE_PORT} got '$probed_live'"
    fi
fi

# Tear down the listener now (trap also covers it on early exit).
[ -n "$_HTTP_PID" ] && kill "$_HTTP_PID" 2>/dev/null
_HTTP_PID=""

finish
exit $?
