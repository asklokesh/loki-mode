#!/usr/bin/env bash
# P0-DASH-LEAK2 regression. A test dashboard (worktree PYTHONPATH, orphaned) sat on the
# real default port 57374; `loki start` refused to reuse it but still printed and opened
# 57374. Guards:
#   1. A stub /health with the SAME version but a different package path (and one with no
#      package, and a non-HTML root) is never reused, by run.sh and by the CLI registry path.
#   2. The URL published for the launcher carries the bound port; the bg banner and the
#      `loki start` browser opener consume it and never guess LOKI_DASHBOARD_PORT/57374.
#   3. Test entry points that run the engine isolate the dashboard port (static).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")"
PIDS=""
cleanup() { for p in $PIDS; do kill "$p" 2>/dev/null; done; rm -rf -- "$WORK"; }
trap cleanup EXIT
PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL+1)); }

# --- stub dashboard: health JSON, root status and content type come from env ---
cat >"$WORK/stub.py" <<'PY'
import http.server, os, sys
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path == "/health":
            body, ct, code = os.environ["STUB_HEALTH"].encode(), "application/json", 200
        else:
            body, ct, code = b"<html></html>", os.environ.get("STUB_ROOT_CT", "text/html"), 200
        self.send_response(code); self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
s = http.server.HTTPServer(("127.0.0.1", 0), H)
print(s.server_address[1], flush=True)
s.serve_forever()
PY
VER="$(tr -d '[:space:]' <"$ROOT/VERSION")"
PKG="$(cd "$ROOT" && pwd -P)"
start_stub() { # $1=health json $2=root content-type ; sets STUB_PORT
    local out="$WORK/port.$RANDOM"
    STUB_HEALTH="$1" STUB_ROOT_CT="${2:-text/html}" python3 "$WORK/stub.py" >"$out" 2>/dev/null &
    local pid=$!; PIDS="$PIDS $pid"
    for _ in $(seq 1 40); do [ -s "$out" ] && break; sleep 0.1; done
    STUB_PORT="$(head -1 "$out")"
}

# shellcheck source=/dev/null
source <(sed -n '/^_loki_dashboard_reusable() {$/,/^}$/p' "$ROOT/autonomy/run.sh")
# shellcheck source=/dev/null
source <(sed -n '/^_loki_dashboard_port_is_ours() {$/,/^}$/p' "$ROOT/autonomy/loki")
export SCRIPT_DIR="$ROOT/autonomy" SKILL_DIR="$ROOT"

check() { # $1=label $2=expect(0|1) ; uses STUB_PORT
    local label="$1" want="$2" a b
    _loki_dashboard_reusable "$STUB_PORT"; a=$?
    _loki_dashboard_port_is_ours "$STUB_PORT"; b=$?
    [ "$a" = "$want" ] && ok "run.sh reuse: $label" || bad "run.sh reuse: $label (rc=$a want=$want)"
    [ "$b" = "$want" ] && ok "CLI registry reuse: $label" || bad "CLI registry reuse: $label (rc=$b want=$want)"
}
start_stub '{"status":"healthy","version":"'"$VER"'","package":"'"$PKG"'"}';                    check "same version + same package + html" 0
start_stub '{"status":"healthy","version":"'"$VER"'","package":"/some/worktree/checkout"}';     check "same version, other package path (the incident)" 1
start_stub '{"status":"healthy","version":"'"$VER"'"}';                                         check "no package field fails closed" 1
start_stub '{"status":"healthy","version":"0.0.1","package":"'"$PKG"'"}';                       check "other version" 1
start_stub '{"status":"healthy","version":"'"$VER"'","package":"'"$PKG"'"}' "application/json"; check "root is not text/html" 1
check_dead=0; _loki_dashboard_reusable 1 && check_dead=1; _loki_dashboard_port_is_ours 1 && check_dead=1
[ "$check_dead" = 0 ] && ok "curl error (nothing listening) fails closed" || bad "unreachable port was reused"

# --- 2. published URL carries the bound port; consumers use it ---
# shellcheck source=/dev/null
source <(sed -n '/^_loki_publish_dashboard_url() {$/,/^}$/p' "$ROOT/autonomy/run.sh")
( cd "$WORK" && _loki_publish_dashboard_url "http://127.0.0.1:57399/" ) 
[ "$(cat "$WORK/.loki/dashboard/url" 2>/dev/null)" = "http://127.0.0.1:57399/" ] \
    && ok "published URL file holds the bound port" || bad "URL not published"
RUN="$ROOT/autonomy/run.sh"; LOKI="$ROOT/autonomy/loki"
grep -q '_loki_publish_dashboard_url "http://127.0.0.1:${DASHBOARD_PORT}/"' "$RUN" \
    && grep -q '_loki_publish_dashboard_url "${url_scheme}://127.0.0.1:${DASHBOARD_PORT}/"' "$RUN" \
    && ok "start_dashboard publishes the URL on both the reuse and the fresh-start path" || bad "start_dashboard does not publish the URL"
grep -q 'Dashboard:${NC}  ${_bg_dash_line}' "$RUN" && ! grep -q 'Dashboard:${NC}  http://127.0.0.1:${DASHBOARD_PORT}/' "$RUN" \
    && ok "bg banner prints the published URL, not the requested port" || bad "bg banner still prints the guessed port"
sed 's/#.*//' "$LOKI" | grep -E 'loki_open_url +"\$_du"|_du="http://127.0.0.1:\$\{LOKI_DASHBOARD_PORT' >/dev/null \
    && bad "loki start opens the guessed default port" || ok "loki start opener no longer guesses the default port"
grep -q '.loki/dashboard/url' "$LOKI" && ok "loki start opener reads the published URL" || bad "opener does not read the published URL"

# --- 3. engine-running entry points isolate the dashboard port ---
grep -q 'LOKI_DASHBOARD=false' "$ROOT/scripts/first-run-gate.sh" \
    && ok "first-run-gate disables run.sh's dashboard (the 'skipl' leak source)" || bad "first-run-gate leaves the dashboard on"
grep -q 'LOKI_DASHBOARD_PORT' "$ROOT/tests/run-all-tests.sh" \
    && ok "run-all-tests.sh moves default-port suites off 57374-57399" || bad "run-all-tests.sh does not isolate the port"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
