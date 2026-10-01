#!/usr/bin/env bash
# P0-DASH-STATIC regression: `loki start` opened a browser onto
# {"error":"dashboard_frontend_not_found"}.
#   (a) STATIC_DIR is the first candidate that CONTAINS index.html, so an empty
#       dir earlier in the order is skipped.
#   (b) A running dashboard is reused only when /health version == CLI VERSION
#       and GET / is 200 text/html.
#   (c) No frontend anywhere: GET / is text/html (built-in page), never JSON.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-run.XXXXXXXX")"
SERVER_PID=""
cleanup() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
    rm -rf -- "$WORK"
}
trap cleanup EXIT

PASS=0; FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL+1)); }

# --- (a) + (c-unit): pure helpers lifted from server.py by AST (no fastapi needed) ---
PYOUT="$(ROOT="$ROOT" WORK="$WORK" python3 - <<'PY'
import ast, os
root, work = os.environ["ROOT"], os.environ["WORK"]
src = open(os.path.join(root, "dashboard", "server.py")).read()
want = {"_static_candidates", "_pick_static_dir", "_fallback_page"}
nodes = [n for n in ast.parse(src).body if isinstance(n, ast.FunctionDef) and n.name in want]
assert {n.name for n in nodes} == want, "helpers missing from server.py"
pkg = os.path.join(work, "pkg", "dashboard")
os.makedirs(os.path.join(pkg, "static"))                        # package static: EMPTY
os.makedirs(os.path.join(work, "skill", "dashboard", "static"))
open(os.path.join(work, "skill", "dashboard", "static", "index.html"), "w").write("<html>ok</html>")
g = {"os": os, "DASHBOARD_DIR": pkg, "PROJECT_ROOT": os.path.dirname(pkg), "_version": "9.9.9"}
exec(compile(ast.Module(body=nodes, type_ignores=[]), "server_helpers", "exec"), g)
c = g["_static_candidates"](skill_dir=os.path.join(work, "skill"), home=os.path.join(work, "nohome"))
assert c[0] == os.path.join(pkg, "static"), c
print("A1", g["_pick_static_dir"](c) == os.path.join(work, "skill", "dashboard", "static"))
open(os.path.join(pkg, "static", "index.html"), "w").write("<html>pkg</html>")
print("A2", g["_pick_static_dir"](c) == os.path.join(pkg, "static"))
c2 = g["_static_candidates"](skill_dir="", home=os.path.join(work, "nohome"))
os.remove(os.path.join(pkg, "static", "index.html"))
print("A3", g["_pick_static_dir"](c2) is None)
page = g["_fallback_page"]()
print("C1", "npm install -g loki-mode@latest" in page and "/docs" in page and "9.9.9" in page and page.lstrip().startswith("<!doctype html>"))
PY
)" || { bad "python helper extraction failed"; PYOUT=""; }
chk() { printf '%s\n' "$PYOUT" | grep -qx "$1 True"; }
chk A1 && ok "(a) empty package static skipped, later dir with index.html chosen" || bad "(a) empty static dir not skipped"
chk A2 && ok "(a) package dir with index.html wins when present" || bad "(a) package dir not preferred"
chk A3 && ok "(a) no candidate with index.html -> None" || bad "(a) empty dirs accepted as frontend"
chk C1 && ok "(c) fallback page is html with version, /docs, npm install command" || bad "(c) fallback page content wrong"

# --- (b) reuse decision from run.sh with a stub curl ---
mkdir -p "$WORK/cli/autonomy"
PKGP="$(cd "$WORK/cli" && pwd -P)"
printf '10.5.99\n' >"$WORK/cli/VERSION"
SCRIPT_DIR="$WORK/cli/autonomy"
# shellcheck source=/dev/null
source <(sed -n '/^_loki_dashboard_reusable() {$/,/^}$/p' "$ROOT/autonomy/run.sh")
declare -F _loki_dashboard_reusable >/dev/null || bad "(b) _loki_dashboard_reusable not found in run.sh"
STUB_HEALTH=""; STUB_PROBE=""
curl() {
    case "$*" in
        *"/health"*) printf '%s' "$STUB_HEALTH" ;;
        *) printf '%s' "$STUB_PROBE" ;;
    esac
}
STUB_HEALTH='{"status":"healthy","service":"loki-dashboard","version":"10.5.99","package":"'"$PKGP"'"}'
STUB_PROBE='200 text/html; charset=utf-8'
_loki_dashboard_reusable 1 && ok "(b) same version + same package + html root is reused" || bad "(b) matching dashboard not reused"
STUB_HEALTH='{"status":"healthy","service":"loki-dashboard","version":"10.5.32","package":"'"$PKGP"'"}'
_loki_dashboard_reusable 1 && bad "(b) wrong-version dashboard was reused" || ok "(b) wrong-version dashboard not reused"
STUB_HEALTH='{"status":"healthy","service":"loki-dashboard","version":"10.5.99","package":"/gone/old/install"}'
_loki_dashboard_reusable 1 && bad "(b) same-version dashboard from another package path was reused" || ok "(b) same version, different package path not reused"
STUB_HEALTH='{"status":"healthy","service":"loki-dashboard"}'
_loki_dashboard_reusable 1 && bad "(b) versionless (old) dashboard was reused" || ok "(b) versionless old dashboard not reused"
STUB_HEALTH='{"status":"healthy","service":"loki-dashboard","version":"10.5.99","package":"'"$PKGP"'"}'
STUB_PROBE='503 application/json'
_loki_dashboard_reusable 1 && bad "(b) dashboard serving JSON 503 at / was reused" || ok "(b) dashboard without working UI not reused"
unset -f curl

# --- (c-live) real server with no frontend anywhere: GET / is text/html ---
PYBIN=""
for p in "$HOME/.loki/dashboard-venv/bin/python" python3; do
    if command -v "$p" >/dev/null 2>&1 && "$p" -c 'import fastapi, uvicorn' 2>/dev/null; then PYBIN="$p"; break; fi
done
if [ -z "$PYBIN" ]; then
    echo "SKIP: (c-live) fastapi/uvicorn not importable; helper-level (c) check above still ran"
else
    # Package copy with symlinks to everything except an EMPTY dashboard/static.
    PKG="$WORK/livepkg"; mkdir -p "$PKG/dashboard/static" "$WORK/home"
    for e in "$ROOT"/*; do b="$(basename "$e")"; case "$b" in dashboard|dashboard-ui) ;; *) ln -s "$e" "$PKG/$b" ;; esac; done
    for e in "$ROOT"/dashboard/*; do b="$(basename "$e")"; [ "$b" = static ] || ln -s "$e" "$PKG/dashboard/$b"; done
    PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
    ( cd "$WORK" && HOME="$WORK/home" LOKI_NO_BROWSER=1 PYTHONPATH="$PKG" LOKI_DASHBOARD_PORT="$PORT" \
        LOKI_DASHBOARD_HOST=127.0.0.1 exec timeout -k 5 90 "$PYBIN" -m dashboard.server >"$WORK/server.log" 2>&1 ) &
    SERVER_PID=$!
    up=0
    for _ in $(seq 1 40); do
        if curl -sf --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then up=1; break; fi
        sleep 0.5
    done
    if [ "$up" = 1 ]; then
        got="$(curl -s -o "$WORK/body" -w '%{http_code} %{content_type}' --max-time 3 "http://127.0.0.1:$PORT/")"
        case "$got" in
            *"text/html"*) ok "(c) live: GET / without frontend is text/html ($got)" ;;
            *) bad "(c) live: GET / returned '$got' (expected text/html)" ;;
        esac
        grep -q "dashboard_frontend_not_found" "$WORK/body" && bad "(c) live: developer JSON leaked to browser"
        HJ="$(curl -s --max-time 3 "http://127.0.0.1:$PORT/health")"
        case "$HJ" in
            *'"version"'*'"package"'*) ok "(b) live: /health reports version and package path" ;;
            *) bad "(b) live: /health lacks version/package: $HJ" ;;
        esac
    else
        bad "(c) live: server did not start; $(tail -3 "$WORK/server.log" 2>/dev/null)"
    fi
fi

# --- port-in-use check must test LISTEN sockets only (CLOSE_WAIT browser sockets are not a server) ---
# Source check: every dashboard port probe in the CLI and run.sh is LISTEN-scoped.
for f in "$ROOT/autonomy/loki" "$ROOT/autonomy/run.sh"; do
    sed 's/#.*//' "$f" | grep -E 'lsof +-i +:?"?\$' >/dev/null \
        && bad "unscoped 'lsof -i :PORT' port probe remains in $(basename "$f")" \
        || ok "no unscoped lsof port probe in $(basename "$f")"
done
# Semantics: a lingering non-listening socket on a port is invisible to the LISTEN form.
if command -v lsof >/dev/null 2>&1; then
    LSOUT="$(python3 - <<'PY'
import socket, subprocess
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", 0)); s.listen(1); port = s.getsockname()[1]
c = socket.create_connection(("127.0.0.1", port)); a, _ = s.accept()
s.close()          # listener gone; the accepted + client sockets still reference the port
c.close()          # peer closes first: the accepted socket lingers in CLOSE_WAIT
def n(args): return subprocess.run(["lsof", "-nP"] + args, capture_output=True).returncode
print("ANY", n(["-i", ":%d" % port]), "LISTEN", n(["-iTCP:%d" % port, "-sTCP:LISTEN"]))
PY
)"
    case "$LSOUT" in
        "ANY 0 LISTEN 1") ok "lingering socket holds the port for plain lsof -i but not for the LISTEN form" ;;
        *) bad "unexpected lsof semantics: $LSOUT" ;;
    esac
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
