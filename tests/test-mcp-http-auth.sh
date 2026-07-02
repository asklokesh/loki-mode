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

# Preflight: need the MCP SDK, uvicorn, starlette, and curl.
if ! "$PY" -c "import mcp, uvicorn, starlette" >/dev/null 2>&1; then
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
