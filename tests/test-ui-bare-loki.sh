#!/usr/bin/env bash
# D51-A12: bare `loki` starts/reuses the local UI; headless prints the URL and
# never opens a browser. A "running dashboard" is faked with a live pid + port
# file pointing at a tiny stub server that answers /health (this package's
# version and realpath) and GET / (html), which the fail-closed registry reuse
# (P0-DASH-LEAK) requires. The printed URL must carry the port the stub actually
# bound. open is a logging stub, so no browser can open.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI_BIN="$(cd "$SCRIPT_DIR/.." && pwd)/autonomy/loki"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

T="$(mktemp -d "${TMPDIR:-/tmp}/loki-uibare.XXXXXXXX")"
sleep 60 & SLEEP_PID=$!
cleanup() { kill "$SLEEP_PID" 2>/dev/null; [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null; [ -n "$T" ] && [ -d "$T" ] && rm -rf -- "$T"; }
trap cleanup EXIT

ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"
VER="$(tr -d '[:space:]' < "$ROOT/VERSION")"
mkdir -p "$T/home/.loki/dashboard" "$T/bin"
cat > "$T/stub.py" <<'PY'
import http.server, sys
ver, pkg, portfile = sys.argv[1], sys.argv[2], sys.argv[3]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            body, ct = ('{"status":"healthy","version":"%s","package":"%s"}' % (ver, pkg)).encode(), "application/json"
        else:
            body, ct = b"<html></html>", "text/html"
        self.send_response(200); self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
open(portfile, "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
python3 "$T/stub.py" "$VER" "$ROOT" "$T/stub.port" & STUB_PID=$!
for _ in $(seq 1 50); do [ -s "$T/stub.port" ] && break; sleep 0.1; done
PORT="$(cat "$T/stub.port" 2>/dev/null)"
echo "$SLEEP_PID" > "$T/home/.loki/dashboard/dashboard.pid"
echo "$PORT" > "$T/home/.loki/dashboard/port"
printf '#!/bin/sh\necho "$@" >> "%s/open.log"\n' "$T" > "$T/bin/open"
chmod +x "$T/bin/open"
run() { env -u CI HOME="$T/home" PATH="$T/bin:$PATH" "$@" bash "$LOKI_BIN" 2>/dev/null; }

URL="http://127.0.0.1:${PORT}/start"
[ -n "$PORT" ] || bad "stub server did not bind a port"
echo "TEST: headless prints the URL and does not open a browser"
out=$(run LOKI_HEADLESS=1)
[ "$out" = "$URL" ] && ok "LOKI_HEADLESS=1 prints $URL" || bad "headless output: '$out'"
out=$(env -u CI HOME="$T/home" PATH="$T/bin:$PATH" bash "$LOKI_BIN" --no-open 2>/dev/null)
[ "$out" = "$URL" ] && ok "--no-open prints the URL" || bad "--no-open output: '$out'"
out=$(run LOKI_NO_BROWSER=1)
[ "$out" = "$URL" ] && ok "LOKI_NO_BROWSER=1 falls back to printing the URL" || bad "no-browser output: '$out'"
[ ! -s "$T/open.log" ] && ok "open was never invoked" || bad "open was invoked: $(cat "$T/open.log")"


echo "TEST: the newcomer landing is kept behind LOKI_LANDING=1"
out=$(run LOKI_LANDING=1)
printf '%s' "$out" | grep -q "Loki Mode v" && ok "landing still reachable" || bad "landing missing"

echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
