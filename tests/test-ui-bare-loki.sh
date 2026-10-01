#!/usr/bin/env bash
# D51-A12: bare `loki` starts/reuses the local UI; headless prints the URL and
# never opens a browser. A "running dashboard" is faked with a live pid + port
# file, so no server starts and no browser can open (open is a logging stub).
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI_BIN="$(cd "$SCRIPT_DIR/.." && pwd)/autonomy/loki"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

T="$(mktemp -d "${TMPDIR:-/tmp}/loki-uibare.XXXXXXXX")"
sleep 60 & SLEEP_PID=$!
cleanup() { kill "$SLEEP_PID" 2>/dev/null; [ -n "$T" ] && [ -d "$T" ] && rm -rf -- "$T"; }
trap cleanup EXIT

mkdir -p "$T/home/.loki/dashboard" "$T/bin"
echo "$SLEEP_PID" > "$T/home/.loki/dashboard/dashboard.pid"
echo 59999 > "$T/home/.loki/dashboard/port"
printf '#!/bin/sh\necho "$@" >> "%s/open.log"\n' "$T" > "$T/bin/open"
chmod +x "$T/bin/open"
run() { env -u CI HOME="$T/home" PATH="$T/bin:$PATH" "$@" bash "$LOKI_BIN" 2>/dev/null; }

URL="http://127.0.0.1:59999/start"
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
