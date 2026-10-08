#!/usr/bin/env bash
# Test: MCP HTTP transport bearer-token auth + explicit loopback bind (gap #18)
#
# Boots the real MCP server over --transport http on an ephemeral loopback port
# and asserts:
#   - the server binds 127.0.0.1 explicitly (never 0.0.0.0)
#   - with LOKI_MCP_AUTH_TOKEN set: no bearer -> 401, wrong bearer -> 401,
#     correct bearer -> not 401 (the request reaches the MCP layer)
#   - with LOKI_MCP_AUTH_TOKEN unset: no auth is applied (request reaches MCP)
#
# Skips cleanly (exit 0) when the MCP SDK / uvicorn are not importable, so it
# never blocks environments without the optional Python deps.

set -uo pipefail
# Silence job-control "Killed" notices when we kill -9 the background server.
set +m 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PASSED=0
FAILED=0

log_pass() { echo "[PASS] $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo "[FAIL] $1"; FAILED=$((FAILED + 1)); }
log_skip() { echo "[SKIP] $1"; }

PY="${PYTHON:-python3}"

# ---------------------------------------------------------------------------
# Node server (MCP-D): task creation over HTTP. Needs only node and curl, so it runs
# before the Python SDK preflight below. Task methods spawn a process, so over HTTP they
# need a token even when general auth is off, a JSON Content-Type, and a loopback Origin.
# ---------------------------------------------------------------------------
NODE_TMP=""
NODE_PID=""
node_cleanup() {
    [ -n "$NODE_PID" ] && kill "$NODE_PID" >/dev/null 2>&1 && wait "$NODE_PID" 2>/dev/null
    NODE_PID=""
    [ -n "$NODE_TMP" ] && [ -d "$NODE_TMP" ] && rm -rf -- "$NODE_TMP"
    NODE_TMP=""
}
trap node_cleanup EXIT

node_phase() {
    command -v node >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 || { log_skip "node or curl missing; skipping Node task-auth phase"; return 0; }
    NODE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-mcp-node-auth.XXXXXX")" || return 0
    local port argv_log stub body c
    port="$("$PY" -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
    argv_log="$NODE_TMP/argv.log"
    stub="$NODE_TMP/stub.sh"
    printf '#!/bin/sh\necho "$@" >> "%s"\necho "{}"\n' "$argv_log" >"$stub"
    chmod +x "$stub"
    body='{"jsonrpc":"2.0","id":1,"method":"tasks/create","params":{"tool":"loki_v10_run","arguments":{"ref":"uninstall","repo_path":"."}}}'

    # A: no token configured -> tasks refused, nothing spawned, whatever the headers say.
    ( cd "$NODE_TMP" && exec env -u MCP_AUTH_TOKEN -u LOKI_MCP_AUTH_TOKEN LOKI_MCP_TASKS=1 LOKI_PYTHON="$stub" LOKI_NO_BROWSER=1 \
        node "$ROOT/src/protocols/mcp-server.js" --sse --port "$port" >"$NODE_TMP/srv.log" 2>&1 ) &
    NODE_PID=$!
    local i; for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$port/mcp/health" && break; sleep 0.3; done

    c="$(curl -s -H 'Content-Type: application/json' -d "$body" "http://127.0.0.1:$port/mcp")"
    case "$c" in *'"code":-32001'*) log_pass "node: no token configured, tasks/create over HTTP refused" ;; *) log_fail "node: tasks/create without auth was not refused: $c" ;; esac
    c="$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: text/plain' -H 'Origin: https://evil.example' -d "$body" "http://127.0.0.1:$port/mcp")"
    case "$c" in 415|403) log_pass "node: text/plain cross-origin task POST rejected ($c)" ;; *) log_fail "node: cross-origin text/plain task POST got $c" ;; esac
    sleep 0.5
    [ ! -s "$argv_log" ] && log_pass "node: nothing was spawned without a token" || log_fail "node: a process was spawned without a token: $(cat "$argv_log")"
    node_stop

    # B: token configured.
    ( cd "$NODE_TMP" && exec env -u LOKI_MCP_AUTH_TOKEN MCP_AUTH_TOKEN=node-tok LOKI_MCP_TASKS=1 LOKI_PYTHON="$stub" LOKI_NO_BROWSER=1 \
        node "$ROOT/src/protocols/mcp-server.js" --sse --port "$port" >"$NODE_TMP/srv.log" 2>&1 ) &
    NODE_PID=$!
    for i in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$port/mcp/health" && break; sleep 0.3; done

    c="$(curl -s -H 'Content-Type: application/json' -d "$body" "http://127.0.0.1:$port/mcp")"
    case "$c" in *'"code":-32001'*) log_pass "node: token set, no bearer -> refused" ;; *) log_fail "node: no bearer not refused: $c" ;; esac
    c="$(curl -s -H 'Content-Type: application/json' -H 'Authorization: Bearer wrong' -d "$body" "http://127.0.0.1:$port/mcp")"
    case "$c" in *'"code":-32001'*) log_pass "node: token set, wrong bearer -> refused" ;; *) log_fail "node: wrong bearer not refused: $c" ;; esac
    c="$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: text/plain' -H 'Authorization: Bearer node-tok' -d "$body" "http://127.0.0.1:$port/mcp")"
    [ "$c" = "415" ] && log_pass "node: valid bearer but text/plain -> 415" || log_fail "node: text/plain got $c (want 415)"
    c="$(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -H 'Authorization: Bearer node-tok' -d "$body" "http://127.0.0.1:$port/mcp")"
    [ "$c" = "403" ] && log_pass "node: valid bearer but non-loopback Origin -> 403" || log_fail "node: evil Origin got $c (want 403)"
    sleep 0.5
    [ ! -s "$argv_log" ] && log_pass "node: still nothing spawned by any refused request" || log_fail "node: a refused request spawned: $(cat "$argv_log")"
    c="$(curl -s -H 'Content-Type: application/json' -H 'Authorization: Bearer node-tok' -d "$body" "http://127.0.0.1:$port/mcp")"
    case "$c" in *'"status":"working"'*) log_pass "node: valid bearer + JSON + no Origin -> task starts" ;; *) log_fail "node: authorized task did not start: $c" ;; esac
    node_stop
}
node_stop() {
    [ -n "$NODE_PID" ] && kill "$NODE_PID" >/dev/null 2>&1 && wait "$NODE_PID" 2>/dev/null
    NODE_PID=""
}
node_phase


# Preflight: need the MCP SDK, uvicorn, starlette, and curl.
#
# `import mcp` is NOT a valid probe for the SDK here. This repo contains a local
# package directory named mcp/, and the test runs from the repo root, so
# Python's implicit cwd-on-sys.path resolves `import mcp` to ./mcp/ -- the
# guard passed on CI with no SDK installed, the test proceeded, and the server
# then died with "MCP SDK (pip package 'mcp') not found". mcp/_sdk_loader.py
# exists precisely because of this shadowing.
#
# Probe the way the server does: drop repo-root/cwd entries from sys.path, then
# import a symbol that only the real SDK provides.
if ! "$PY" - <<'PREFLIGHT' >/dev/null 2>&1
import os, sys
_root = os.getcwd()
sys.path[:] = [p for p in sys.path
               if p not in ("", ".", _root) and os.path.abspath(p or ".") != _root]
import mcp.server            # only the installed SDK has this
import uvicorn, starlette    # noqa: F401
PREFLIGHT
then
    log_skip "MCP SDK / uvicorn / starlette not importable; skipping HTTP auth test"
    exit 0
fi
if ! command -v curl >/dev/null 2>&1; then
    log_skip "curl not available; skipping HTTP auth test"
    exit 0
fi

# Pick a free-ish high port. Fixed offset per phase to avoid clashing.
find_port() {
    "$PY" - <<'PYEOF'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PYEOF
}

SRV_PID=""
LOG=""
cleanup() {
    node_cleanup
    [ -n "$SRV_PID" ] && kill -9 "$SRV_PID" >/dev/null 2>&1
    [ -n "$LOG" ] && rm -f "$LOG" >/dev/null 2>&1
}
trap cleanup EXIT

start_server() {
    # $1 = port
    LOG="$(mktemp -t loki-mcp-http-test.XXXXXX)"
    PYTHONPATH="$ROOT" "$PY" "$ROOT/mcp/server.py" --transport http --port "$1" \
        >"$LOG" 2>&1 &
    SRV_PID=$!
    local i
    for i in $(seq 1 30); do
        if lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
            return 0
        fi
        # Bail early if the process died.
        if ! kill -0 "$SRV_PID" >/dev/null 2>&1; then
            echo "server exited early; log:" >&2
            cat "$LOG" >&2
            return 1
        fi
        sleep 0.5
    done
    return 1
}

stop_server() {
    if [ -n "$SRV_PID" ]; then
        kill "$SRV_PID" >/dev/null 2>&1
        # Reap quietly so job control does not print a "Killed" notice.
        wait "$SRV_PID" 2>/dev/null
    fi
    SRV_PID=""
    [ -n "$LOG" ] && rm -f "$LOG" >/dev/null 2>&1
    LOG=""
}

code_for() {
    # $1 = port, remaining = extra curl args. Prints HTTP status code.
    local port="$1"; shift
    curl -s -o /dev/null -w "%{http_code}" "$@" "http://127.0.0.1:$port/mcp"
}

INIT_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'

# ---------------------------------------------------------------------------
# Phase 1: token SET
# ---------------------------------------------------------------------------
TOKEN="loki-test-token-$$"
PORT1="$(find_port)"
export LOKI_MCP_AUTH_TOKEN="$TOKEN"
if start_server "$PORT1"; then
    # Explicit loopback bind.
    if lsof -nP -iTCP:"$PORT1" -sTCP:LISTEN 2>/dev/null | grep -q "127.0.0.1:$PORT1"; then
        if lsof -nP -iTCP:"$PORT1" -sTCP:LISTEN 2>/dev/null | grep -q "0.0.0.0:$PORT1"; then
            log_fail "server also bound 0.0.0.0"
        else
            log_pass "server bound 127.0.0.1 explicitly (not 0.0.0.0)"
        fi
    else
        log_fail "server did not bind 127.0.0.1"
    fi

    c="$(code_for "$PORT1")"
    [ "$c" = "401" ] && log_pass "token set, no bearer -> 401" || log_fail "token set, no bearer -> got $c (want 401)"

    c="$(code_for "$PORT1" -H 'Authorization: Bearer wrong')"
    [ "$c" = "401" ] && log_pass "token set, wrong bearer -> 401" || log_fail "token set, wrong bearer -> got $c (want 401)"

    c="$(code_for "$PORT1" -H "Authorization: Bearer $TOKEN" \
        -H 'Accept: application/json, text/event-stream' \
        -H 'Content-Type: application/json' -d "$INIT_BODY")"
    [ "$c" != "401" ] && log_pass "token set, correct bearer -> not 401 (got $c)" || log_fail "token set, correct bearer -> 401 (auth wrongly rejected)"
else
    log_fail "server failed to start (token set)"
fi
stop_server
unset LOKI_MCP_AUTH_TOKEN

# ---------------------------------------------------------------------------
# Phase 2: token UNSET (no auth applied)
# ---------------------------------------------------------------------------
PORT2="$(find_port)"
if start_server "$PORT2"; then
    c="$(code_for "$PORT2" \
        -H 'Accept: application/json, text/event-stream' \
        -H 'Content-Type: application/json' -d "$INIT_BODY")"
    [ "$c" != "401" ] && log_pass "token unset, no bearer -> not 401 (got $c; auth not applied)" || log_fail "token unset -> 401 (auth wrongly applied)"
else
    log_fail "server failed to start (token unset)"
fi
stop_server

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[ "$FAILED" -eq 0 ]
