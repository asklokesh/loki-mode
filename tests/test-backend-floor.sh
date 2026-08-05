#!/usr/bin/env bash
# test-backend-floor.sh -- M2 real-backend-as-floor scaffold.
#
# Proves the generated Express+SQLite backend PERSISTS (POST creates a row that
# survives to a later GET) and is verified by the FV-1 harness (functional_status
# = verified) -- the convergence that makes a static shell structurally impossible.
# A static shell would fail both. Includes the robustness case the FV harness
# caught: a PARTIAL post (a declared field omitted) must persist (201), not 500.
#
# GENERAL: runs on a THROWAWAY 'note' resource, no PRD knowledge.
# Requires node/npm + network for express/better-sqlite3 (skips cleanly if absent).
set -u
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GEN="$REPO_ROOT/autonomy/lib/contract-scaffold/generate.mjs"
FV="$REPO_ROOT/autonomy/lib/functional-verify.py"
PASS=0; FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

command -v node >/dev/null 2>&1 || { echo "SKIP: node not available"; exit 0; }
[ -f "$GEN" ] || { echo "FAIL: generate.mjs missing"; exit 1; }

DEMO="$(mktemp -d)"; trap 'rm -rf "$DEMO"; pkill -f "$DEMO/server/index.mjs" 2>/dev/null || true' EXIT

# Generate the real backend from templates (throwaway resource, no PRD).
node "$GEN" "$DEMO" note title:string body:string >/dev/null 2>&1 \
  && pass "generated a real backend from templates" || { fail "generate failed"; echo "RESULT: $PASS/$((PASS+FAIL))"; exit 1; }

node --check "$DEMO/server/index.mjs" 2>/dev/null \
  && pass "generated index.mjs is valid JS (no substitution corruption)" \
  || { fail "generated index.mjs has a syntax error"; echo "RESULT: $PASS passed, $FAIL failed"; exit 1; }

cd "$DEMO/server" || exit 1
if ! npm install --silent --no-audit --no-fund >/dev/null 2>&1; then
  echo "SKIP: npm install failed (offline?) -- generated code still syntax-verified"
  echo "RESULT: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]; exit
fi

# Pick a free-ish high port and make sure nothing lingers on it. PORT must be
# passed inline to the node process (a bare `PORT=x` shell var is NOT inherited
# by the backgrounded node child; the server would fall back to :3000).
APP_PORT=8971
pkill -f "index.mjs" 2>/dev/null || true
PORT="$APP_PORT" node index.mjs >"$DEMO/backend-floor.log" 2>&1 &
SRV=$!
PORT="$APP_PORT"
# Wait until the port actually serves HTTP 200 (check the CODE, not curl's exit,
# which can be 0 on a refused connection). Up to ~15s.
ready=""
for _ in $(seq 1 30); do
  code=$(curl -s -m1 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/notes" 2>/dev/null)
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  fail "server did not become ready on port $PORT (log: $(tail -1 "$DEMO/backend-floor.log"))"
  kill "$SRV" 2>/dev/null; echo "RESULT: $PASS passed, $FAIL failed"; exit 1
fi
pass "generated backend starts and serves"

# Persistence: seed row exists, POST grows the collection.
before=$(curl -s -m3 "http://127.0.0.1:$PORT/api/notes" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
curl -s -m3 -X POST "http://127.0.0.1:$PORT/api/notes" -H "Content-Type: application/json" -d '{"title":"t","body":"b"}' >/dev/null 2>&1
after=$(curl -s -m3 "http://127.0.0.1:$PORT/api/notes" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
if [ "${before:-0}" = "1" ] && [ "${after:-0}" = "2" ]; then
  pass "POST persists (seed 1 -> 2 after create)"
else
  fail "POST did not persist (before=$before after=$after)"
fi

# Robustness (the FV-caught bug): a PARTIAL post (body omitted) must persist, not 500.
code=$(curl -s -m3 -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:$PORT/api/notes" -H "Content-Type: application/json" -d '{"title":"partial"}')
[ "$code" = "201" ] && pass "partial POST (declared field omitted) persists (201, not 500)" \
  || fail "partial POST returned $code (expected 201)"

# The convergence: FV-1 verifies the real backend as functional.
echo "GET /api/notes, POST /api/notes, DELETE /api/notes/:id" > "$DEMO/spec.txt"
fv=$(python3 "$FV" "$DEMO/spec.txt" "http://127.0.0.1:$PORT" 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['functional_status'])" 2>/dev/null)
[ "$fv" = "verified" ] && pass "FV-1 harness reports functional_status=verified (real working backend)" \
  || fail "FV reported '$fv' (expected verified)"

kill "$SRV" 2>/dev/null
echo "----------------------------------------"
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
