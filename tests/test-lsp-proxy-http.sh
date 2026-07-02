#!/usr/bin/env bash
# Test: LSP-proxy MCP server HTTP transport no longer crashes on startup.
#
# Regression for the bug where mcp/lsp_proxy.py main() ran
#   mcp.run(transport='http', port=args.port)
# which raises TypeError (FastMCP.run has no port= kwarg; 'http' is not a valid
# transport literal). The supported path (mirrored from mcp/server.py) builds
# the Streamable-HTTP ASGI app, binds 127.0.0.1 explicitly, and runs it via
# uvicorn.
#
# Asserts:
#   - `mcp/lsp_proxy.py --transport http --port <p>` boots without crashing
#   - the server binds 127.0.0.1 explicitly (never 0.0.0.0)
#   - the server log contains no "unexpected keyword argument 'port'" TypeError
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

# Preflight: need the MCP SDK, uvicorn, and streamable_http_app support.
if ! "$PY" -c "import mcp, uvicorn" >/dev/null 2>&1; then
    log_skip "MCP SDK / uvicorn not importable; skipping LSP-proxy HTTP test"
    exit 0
fi
if ! "$PY" -c "from mcp.server.fastmcp import FastMCP; import sys; sys.exit(0 if hasattr(FastMCP('t'), 'streamable_http_app') else 1)" >/dev/null 2>&1; then
    log_skip "installed MCP SDK lacks streamable_http_app; skipping LSP-proxy HTTP test"
    exit 0
fi
if ! command -v lsof >/dev/null 2>&1; then
    log_skip "lsof not available; skipping LSP-proxy HTTP test"
    exit 0
fi

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

PORT="$(find_port)"
LOG="$(mktemp -t loki-lsp-http-test.XXXXXX)"
PYTHONPATH="$ROOT" "$PY" "$ROOT/mcp/lsp_proxy.py" --transport http --port "$PORT" \
    >"$LOG" 2>&1 &
SRV_PID=$!

BOUND=0
for i in $(seq 1 30); do
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
        BOUND=1
        break
    fi
    # Bail early if the process died (this is the old-code failure mode).
    if ! kill -0 "$SRV_PID" >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

if [ "$BOUND" -eq 1 ]; then
    log_pass "lsp_proxy --transport http booted without crashing"
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
        if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | grep -q "0.0.0.0:$PORT"; then
            log_fail "server also bound 0.0.0.0"
        else
            log_pass "server bound 127.0.0.1 explicitly (not 0.0.0.0)"
        fi
    else
        log_fail "server did not bind 127.0.0.1"
    fi
else
    log_fail "lsp_proxy --transport http did not bind (crashed on startup); log:"
    cat "$LOG" >&2
fi

# The old bug surfaces as a TypeError about the port= kwarg. Assert it is absent
# regardless of bind timing.
if grep -q "unexpected keyword argument 'port'" "$LOG" 2>/dev/null; then
    log_fail "startup log contains the FastMCP.run port= TypeError (old bug present)"
else
    log_pass "no FastMCP.run port= TypeError in startup log"
fi

kill "$SRV_PID" >/dev/null 2>&1
wait "$SRV_PID" 2>/dev/null
SRV_PID=""

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[ "$FAILED" -eq 0 ]
