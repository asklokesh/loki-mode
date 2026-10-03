#!/usr/bin/env bash
# CPE24-L7: fresh-install smoke test for the Control Plane.
#
# Packs the repo with `npm pack`, installs the tarball into a temp prefix, starts the packaged
# Control Plane (packages/control-plane/dist/server.js) on a loopback port the OS picks
# (PORT=0, read back from its startup line, so there is no free-port race), and asserts:
#   - GET /health is 200 with service "loki-control"
#   - GET / is 200 and is byte-identical to the packaged Control Plane UI index
#   - the UI index does not reference the legacy dashboard (shipped legacy paths are
#     tests/test-legacy-dashboard-removed.sh's job)
#
# Install mode: `npm install --prefix TMP TARBALL --ignore-scripts --offline`. --ignore-scripts because
# the package's lifecycle hooks build from source (bun install, network); the Control Plane bundle is
# self-contained so no dependency fetch is needed. If npm cannot resolve the registry-only dependencies
# offline, the test falls back to extracting the tarball (same files) and says so.
#
# Honest skips (exit 0 with a SKIP line; set CP_SMOKE_REQUIRE=1 to make a skip a failure):
#   - bun is not installed
#   - the packed tarball has no packages/control-plane/dist/server.js or ui/dist/index.html
#     (an unbuilt tree: run `cd packages/control-plane && bun run build:all` first)
# Env: CP_SMOKE_ROOT overrides the repo root to pack.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${CP_SMOKE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
LEG_UI="dashboard""-ui"
LEG_STATIC="dashboard/""static"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

SERVER_PID=""
RUN_TMP=""
cleanup() {
    if [ -n "$SERVER_PID" ]; then
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    if [ -n "$RUN_TMP" ] && [ "$(cat "$RUN_TMP/.loki-run-owned" 2>/dev/null)" = "$RUN_TMP" ]; then
        rm -rf -- "$RUN_TMP"
    fi
}
trap cleanup EXIT

skip() {
    echo "SKIP: $1"
    if [ "${CP_SMOKE_REQUIRE:-0}" = "1" ]; then echo "FAIL: CP_SMOKE_REQUIRE=1 turns a skip into a failure"; exit 1; fi
    exit 0
}

command -v bun >/dev/null 2>&1 || skip "bun is not installed, the Control Plane bundle cannot run"
command -v npm >/dev/null 2>&1 || skip "npm is not installed"
command -v curl >/dev/null 2>&1 || skip "curl is not installed"

temp_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || exit 2
chmod 700 "$RUN_TMP"
printf '%s\n' "$RUN_TMP" > "$RUN_TMP/.loki-run-owned"
chmod 600 "$RUN_TMP/.loki-run-owned"
PACK_DIR="$RUN_TMP/pack"; PREFIX="$RUN_TMP/prefix"; DATA="$RUN_TMP/data"
mkdir -p "$PACK_DIR" "$PREFIX" "$DATA"

echo "T1 -- npm pack"
PACK_OUT="$(cd "$ROOT" && timeout -k 5 180 npm pack --ignore-scripts --pack-destination "$PACK_DIR" --silent 2>"$RUN_TMP/pack.err")"
TARBALL="$PACK_DIR/$(printf '%s\n' "$PACK_OUT" | tail -1)"
if [ -f "$TARBALL" ]; then ok "packed $(basename "$TARBALL")"; else bad "npm pack failed: $(tail -3 "$RUN_TMP/pack.err")"; exit 1; fi

if ! tar -tzf "$TARBALL" | grep -qx 'package/packages/control-plane/dist/server.js' \
    || ! tar -tzf "$TARBALL" | grep -qx 'package/packages/control-plane/ui/dist/index.html'; then
    skip "tarball has no Control Plane bundle or UI (unbuilt tree; run: cd packages/control-plane && bun run build:all)"
fi

echo "T2 -- install into a fresh prefix"
INSTALL_MODE=npm
if timeout -k 5 300 npm install --prefix "$PREFIX" "$TARBALL" --ignore-scripts --offline --no-audit --no-fund >"$RUN_TMP/install.log" 2>&1 \
    && [ -d "$PREFIX/node_modules/$(cd "$ROOT" && node -p 'require("./package.json").name')" ]; then
    PKG_DIR="$PREFIX/node_modules/$(cd "$ROOT" && node -p 'require("./package.json").name')"
    ok "npm install --ignore-scripts --offline succeeded"
else
    INSTALL_MODE=extract
    mkdir -p "$PREFIX/extract"
    if tar -xzf "$TARBALL" -C "$PREFIX/extract"; then
        PKG_DIR="$PREFIX/extract/package"
        ok "npm install needs the registry for optional dependencies; fell back to extracting the tarball (install mode: extract)"
    else
        bad "could not install or extract the tarball"; exit 1
    fi
fi
CP_DIR="$PKG_DIR/packages/control-plane"

echo "T3 -- start the packaged Control Plane"
LOG="$RUN_TMP/server.log"
(
    cd "$DATA" || exit 1
    LOKI_NO_BROWSER=1 PORT=0 LOKI_CONTROL_DB="$DATA/control.db" LOKI_CONTROL_HOST=127.0.0.1 \
        exec bun "$CP_DIR/dist/server.js"
) >"$LOG" 2>&1 &
SERVER_PID=$!
URL=""
for _ in $(seq 1 100); do
    URL="$(sed -n 's/^loki-control listening on \(http:\/\/[^ ]*\)$/\1/p' "$LOG" | head -1)"
    [ -n "$URL" ] && break
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.1
done
if [ -z "$URL" ]; then
    bad "server did not report a listening URL (pid $SERVER_PID); log: $(head -c 400 "$LOG")"
    echo "Smoke: $PASS passed, $FAIL failed"; exit 1
fi
ok "listening on $URL (pid $SERVER_PID, install mode: $INSTALL_MODE)"
URL="${URL%/}"

echo "T4 -- health and UI"
code="$(curl -s -o "$RUN_TMP/health.json" -w '%{http_code}' --max-time 10 "$URL/health")"
if [ "$code" = 200 ] && grep -q '"service":"loki-control"' "$RUN_TMP/health.json"; then ok "/health 200 service loki-control"; else bad "/health returned $code: $(head -c 200 "$RUN_TMP/health.json")"; fi
code="$(curl -s -o "$RUN_TMP/index.html" -w '%{http_code}' --max-time 10 "$URL/")"
if [ "$code" = 200 ]; then ok "UI index 200"; else bad "UI index returned $code"; fi
if cmp -s "$RUN_TMP/index.html" "$CP_DIR/ui/dist/index.html"; then ok "UI index is the packaged Control Plane UI"; else bad "UI index differs from packages/control-plane/ui/dist/index.html"; fi
if grep -q -e "$LEG_UI" -e "$LEG_STATIC" "$RUN_TMP/index.html"; then bad "UI index references the legacy dashboard"; else ok "UI index does not reference the legacy dashboard"; fi

echo ""
echo "Smoke: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
