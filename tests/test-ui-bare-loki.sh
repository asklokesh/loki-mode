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
cleanup() { kill "$SLEEP_PID" 2>/dev/null; [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null; [ -n "${CP_PID:-}" ] && kill "$CP_PID" 2>/dev/null; [ -n "${CP6_PID:-}" ] && kill "$CP6_PID" 2>/dev/null; [ -n "$T" ] && [ -d "$T" ] && rm -rf -- "$T"; }
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
run() { env -u CI LOKI_CONTROL_DEFAULT=0 HOME="$T/home" PATH="$T/bin:$PATH" "$@" bash "$LOKI_BIN" 2>/dev/null; }

URL="http://127.0.0.1:${PORT}"
[ -n "$PORT" ] || bad "stub server did not bind a port"
echo "TEST: headless prints the URL and does not open a browser"
out=$(run LOKI_HEADLESS=1)
[ "$out" = "$URL" ] && ok "LOKI_HEADLESS=1 prints $URL" || bad "headless output: '$out'"
out=$(env -u CI LOKI_CONTROL_DEFAULT=0 HOME="$T/home" PATH="$T/bin:$PATH" bash "$LOKI_BIN" --no-open 2>/dev/null)
[ "$out" = "$URL" ] && ok "--no-open prints the URL" || bad "--no-open output: '$out'"
out=$(run LOKI_NO_BROWSER=1)
[ "$out" = "$URL" ] && ok "LOKI_NO_BROWSER=1 falls back to printing the URL" || bad "no-browser output: '$out'"
[ ! -s "$T/open.log" ] && ok "open was never invoked" || bad "open was invoked: $(cat "$T/open.log")"


# C3: Control Plane leg. A stub answering /health with service=loki-control and
# a stub instance.json in a temp HOME; bare loki must print that URL and never
# open a browser or bind a dashboard port.
mkdir -p "$T/cp-home/.loki/control" "$T/cp-home/.loki/dashboard"
cp "$T/home/.loki/dashboard/dashboard.pid" "$T/home/.loki/dashboard/port" "$T/cp-home/.loki/dashboard/"
cat > "$T/cp.py" <<'PY'
import http.server, sys
portfile = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"service":"loki-control","status":"ok"}'
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
srv = http.server.HTTPServer(("127.0.0.1", 0), H)
open(portfile, "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
python3 "$T/cp.py" "$T/cp.port" & CP_PID=$!
for _ in $(seq 1 50); do [ -s "$T/cp.port" ] && break; sleep 0.1; done
CP_PORT="$(cat "$T/cp.port" 2>/dev/null)"
CP_URL="http://127.0.0.1:${CP_PORT}"
INST="$T/cp-home/.loki/control/instance.json"
printf '{"pid":%s,"port":%s,"url":"%s","version":"x","install_path":"/x","db":"/x"}\n' "$SLEEP_PID" "$CP_PORT" "$CP_URL" > "$INST"
chmod 600 "$INST"
cprun() { env -u CI -u LOKI_CONTROL_DEFAULT HOME="$T/cp-home" PATH="$T/bin:$PATH" "$@" 2>/dev/null; }

echo "TEST: Control Plane is the default for bare loki"
rm -f "$T/open.log"
out=$(cprun LOKI_NO_BROWSER=1 bash "$LOKI_BIN")
[ "$out" = "$CP_URL" ] && ok "LOKI_NO_BROWSER=1 prints the Control Plane URL" || bad "control output: '$out'"
out=$(cprun LOKI_HEADLESS=1 bash "$LOKI_BIN")
[ "$out" = "$CP_URL" ] && ok "LOKI_HEADLESS=1 prints the Control Plane URL" || bad "headless control output: '$out'"
out=$(cprun bash "$LOKI_BIN" --no-open)
[ "$out" = "$CP_URL" ] && ok "--no-open prints the Control Plane URL" || bad "--no-open control output: '$out'"
out=$(cprun LOKI_NO_BROWSER=1 bash "$LOKI_BIN" dashboard open)
[ "$out" = "$CP_URL" ] && ok "loki dashboard open reuses the Control Plane URL" || bad "dashboard open output: '$out'"
[ ! -s "$T/open.log" ] && ok "open recorded zero calls" || bad "open was invoked: $(cat "$T/open.log")"
out=$(cprun LOKI_CONTROL_DEFAULT=0 LOKI_HEADLESS=1 bash "$LOKI_BIN")
[ "$out" = "$URL" ] && ok "LOKI_CONTROL_DEFAULT=0 restores the classic dashboard" || bad "opt-out output: '$out'"
printf '{"pid":%s,"port":1,"url":"http://example.com:1","version":"x"}\n' "$SLEEP_PID" > "$INST"
out=$(cprun LOKI_NO_BROWSER=1 PATH="$T/bin:/usr/bin:/bin" bash "$LOKI_BIN")
[ "$out" = "$URL" ] && ok "non-loopback instance url is never trusted" || bad "non-loopback instance output: '$out'"
# TL should-fix: only a bare origin is trusted (empty path or "/"), never a
# path, query, fragment or userinfo.
for bad_url in "http://127.0.0.1:${CP_PORT}/x?\$(id)" "http://127.0.0.1:${CP_PORT}/x" "http://127.0.0.1:${CP_PORT}/?q=1" "http://127.0.0.1:${CP_PORT}/#f" "http://u:p@127.0.0.1:${CP_PORT}"; do
    printf '{"pid":%s,"port":%s,"url":"%s","version":"x"}\n' "$SLEEP_PID" "$CP_PORT" "$bad_url" > "$INST"
    out=$(cprun LOKI_NO_BROWSER=1 PATH="$T/bin:/usr/bin:/bin" bash "$LOKI_BIN")
    [ "$out" = "$URL" ] && ok "instance url with path/query/fragment/userinfo rejected: $bad_url" || bad "accepted '$bad_url': '$out'"
done
printf '{"pid":%s,"port":%s,"url":"%s/","version":"x"}\n' "$SLEEP_PID" "$CP_PORT" "$CP_URL" > "$INST"
out=$(cprun LOKI_NO_BROWSER=1 bash "$LOKI_BIN")
[ "$out" = "$CP_URL" ] && ok "bare origin with trailing slash accepted" || bad "trailing slash output: '$out'"

# [::1] leg: bind a stub on ::1 when the host supports it.
cat > "$T/cp6.py" <<'PY'
import http.server, socket, sys
class S(http.server.HTTPServer):
    address_family = socket.AF_INET6
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b'{"service":"loki-control","status":"ok"}'
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
srv = S(("::1", 0), H)
open(sys.argv[1], "w").write(str(srv.server_address[1]))
srv.serve_forever()
PY
python3 "$T/cp6.py" "$T/cp6.port" 2>/dev/null & CP6_PID=$!
for _ in $(seq 1 30); do [ -s "$T/cp6.port" ] && break; kill -0 "$CP6_PID" 2>/dev/null || break; sleep 0.1; done
CP6_PORT="$(cat "$T/cp6.port" 2>/dev/null)"
if [ -n "$CP6_PORT" ]; then
    CP6_URL="http://[::1]:${CP6_PORT}"
    printf '{"pid":%s,"port":%s,"url":"%s","version":"x"}\n' "$SLEEP_PID" "$CP6_PORT" "$CP6_URL" > "$INST"
    out=$(cprun LOKI_NO_BROWSER=1 bash "$LOKI_BIN")
    [ "$out" = "$CP6_URL" ] && ok "[::1] Control Plane URL accepted and health-checked" || bad "[::1] output: '$out'"
    kill "$CP6_PID" 2>/dev/null
else
    echo "  SKIP: ::1 not bindable on this host"
fi
bound=0
for p in "$STUB_PID" "$CP_PID" "$SLEEP_PID"; do
    if lsof -nP -a -p "$p" -iTCP -sTCP:LISTEN 2>/dev/null | grep -Eq ':573(7[4-9]|8[0-9]|9[0-9])[^0-9]'; then bound=1; fi
done
[ "$bound" -eq 0 ] && ok "no port in 57374-57399 bound by recorded PIDs" || bad "a recorded PID bound a dashboard port"

echo "TEST: the newcomer landing is kept behind LOKI_LANDING=1"
out=$(run LOKI_LANDING=1)
printf '%s' "$out" | grep -q "Loki Mode v" && ok "landing still reachable" || bad "landing missing"

echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
