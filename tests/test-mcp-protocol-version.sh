#!/usr/bin/env bash
# The Python MCP server must echo the protocol version a client asks for.
#
# An MCP SDK bump can silently change which protocol versions the stdio server
# negotiates. This handshakes mcp/server.py with a raw initialize request and
# asserts the negotiated version for each pinned client version, so a bump that
# changes it is visible by name. The requirements pins are deliberately NOT
# raised here: no SDK release is shown to support a newer spec (MCP-0).
#
# Fail-closed like test-mcp-tool-surface-packaged.sh: an absent SDK, a server
# that prints no response, or a non-zero exit is an unmeasured surface, not a
# pass. The SDK probe runs from a non-repo cwd, where `import mcp` would
# otherwise bind the repo's own mcp/ package. Nothing is installed or fetched.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LOKI_NO_BROWSER=1

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
die() { bad "$1"; echo "  Passed: $PASS  Failed: $FAIL"; exit 1; }

echo "TEST: MCP server negotiates the requested protocol version"

WORK="$(mktemp -d -t loki-mcp-pv-XXXX)" || die "could not create a work directory"
MAIN_PID=$$
cleanup() { [ "$$" = "$MAIN_PID" ] && [ -n "$WORK" ] && rm -rf "$WORK"; return 0; }
trap cleanup EXIT

command -v python3 >/dev/null 2>&1 || die "python3 unavailable"

SDK_ERR="$(cd "$WORK" && python3 - <<'PYSDK' 2>&1 >/dev/null
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
PYSDK
)"
SDK_RC=$?
if [ "$SDK_RC" -ne 0 ]; then
    [ -n "$SDK_ERR" ] && printf '  SDK probe stderr: %s\n' "$(printf '%s\n' "$SDK_ERR" | tail -1)"
    die "MCP SDK not importable (probe exit $SDK_RC) -- handshake unmeasurable; fails closed"
fi
ok "MCP SDK importable from a non-repo cwd"

# Prints "<negotiated version> <server exit code>" for a requested version.
handshake() {
    (cd "$WORK" && LOKI_REPO="$REPO_ROOT" LOKI_ASK="$1" python3 - <<'PYHS' 2>"$WORK/hs.err"
import json, os, subprocess, sys
repo = os.environ["LOKI_REPO"]
env = dict(os.environ)
env["PYTHONPATH"] = repo + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
p = subprocess.Popen([sys.executable, os.path.join(repo, "mcp", "server.py"), "--transport", "stdio"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                     env=env, text=True)
def send(m):
    p.stdin.write(json.dumps(m) + "\n"); p.stdin.flush()
send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"protocolVersion": os.environ["LOKI_ASK"], "capabilities": {},
                 "clientInfo": {"name": "version-guard", "version": "0"}}})
line = p.stdout.readline()
try:
    got = json.loads(line)["result"]["protocolVersion"]
except Exception:
    got = "NONE"
send({"jsonrpc": "2.0", "method": "notifications/initialized"})
p.stdin.close()
try:
    rc = p.wait(timeout=30)
except subprocess.TimeoutExpired:
    p.kill(); rc = 124
print(got, rc)
PYHS
    )
}

check_version() {  # $1=requested version
    local out got rc
    out="$(handshake "$1")"
    got="${out%% *}"; rc="${out##* }"
    if [ "$got" = "$1" ]; then
        ok "initialize with $1 negotiates $got"
    else
        [ -s "$WORK/hs.err" ] && sed -n '1,8p' "$WORK/hs.err" | sed 's/^/    handshake stderr: /'
        bad "initialize with $1 negotiated '$got' (expected $1)"
    fi
    if [ "$rc" = "0" ]; then
        ok "server exits 0 after the $1 handshake"
    else
        bad "server exit code after the $1 handshake was '$rc' (expected 0)"
    fi
}

check_version "2025-11-25"
check_version "2024-11-05"

echo "  Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
