#!/usr/bin/env bash
# Every web-app client path must resolve to a real FastAPI route.
#
# THE DEFECT, measured: ten client calls pointed at fully-implemented backends
# by the wrong URL. client.ts called /sessions/{id}/github/runs while the server
# served /sessions/{id}/github/actions/runs. Seven GitHub Actions calls and two
# deploy calls had drifted, and /deploy/{platform}/disconnect existed nowhere.
# The whole CI/CD panel and the whole deploy-connections panel were dead, with
# complete working backends sitting behind them.
#
# WHY IT WENT UNNOTICED: dead GETs fell through the SPA catch-all and returned
# 200 + text/html, so the client reported "API endpoint not available. Please
# restart the server with the latest version." That message blamed a stale
# server for a client typo and pointed every reader away from the real cause.
#
# WHY THIS GUARD IS NOT A REGEX. I wrote a regex differ first and it produced
# BOTH failure directions at once: a false positive (reported /sessions missing
# while 58 such routes exist) and a false negative (missed the /github/runs
# drift entirely). So this guard reads the ACTUAL FastAPI route table via
# server.app.routes, and parses the client with the TypeScript AST. No pattern
# matching on source text on either side.
#
# FOUR FATAL RULES, each exiting 2 rather than under-reporting. Under-reporting
# is the only outcome worse than failing, because it looks like success:
#   1. zero client calls captured        -> vacuous run, not a clean one
#   2. an unresolvable client path       -> refuse to guess
#   3. a partially-interpolated segment  -> never truncate; a SHORTENED path can
#      coincidentally match a real route, hiding the very drift we hunt
#   4. a non-literal HTTP method         -> { method: someVar } silently reading
#      as GET would let a POST drift pass against a matching GET route
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "test-verify-client-routes"

EXTRACT="$REPO_ROOT/tests/lib-extract-client-paths.mjs"
MATCH="$REPO_ROOT/tests/lib-match-client-routes.py"
CLIENT="$REPO_ROOT/web-app/src/api/client.ts"

# --- Preconditions. Each asserted individually so a skip can never masquerade
# --- as a pass. An absent tool is an UNMEASURED result, not a clean one.
for f in "$EXTRACT" "$MATCH" "$CLIENT"; do
    if [ -f "$f" ]; then
        pass "present: ${f#$REPO_ROOT/}"
    else
        fail "missing: ${f#$REPO_ROOT/} -- the contract cannot be checked"
    fi
done
if [ "$FAIL" -ne 0 ]; then
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

if command -v node >/dev/null 2>&1; then
    pass "node is available"
else
    fail "node unavailable: the client contract was NOT measured (unmeasured, not clean)"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

if [ -d "$REPO_ROOT/web-app/node_modules/typescript" ]; then
    pass "typescript is available (no new dependency)"
else
    fail "web-app/node_modules/typescript absent: cannot parse the client"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

WORK="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$WORK"' EXIT
PATHS_JSON="$WORK/client-paths.json"

# --- Extract every fetchJSON call from the client via the AST ---------------
if node "$EXTRACT" > "$PATHS_JSON" 2>"$WORK/extract.err"; then
    pass "the client parsed without error"
else
    fail "the TypeScript walk failed: $(head -c 200 "$WORK/extract.err")"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

# VACUITY GUARD. An empty capture satisfies every downstream assertion while
# measuring nothing at all.
CAPTURED="$(python3 -c "
import json
try:
    print(json.load(open('$PATHS_JSON')).get('captured', 0))
except Exception:
    print(0)
" 2>/dev/null)"
if [ "${CAPTURED:-0}" -gt 0 ]; then
    pass "captured $CAPTURED client calls (non-vacuous)"
else
    fail "zero client calls captured; every assertion below would be vacuous"
    echo "  $PASS passed, $FAIL failed"
    exit 1
fi

# --- Match against the REAL route table ------------------------------------
MATCH_OUT="$WORK/match.txt"
MATCH_RC=0
python3 "$MATCH" "$PATHS_JSON" > "$MATCH_OUT" 2>&1 || MATCH_RC=$?

# Echo the detail so a red run names the exact drifted lines, never a count.
sed 's/^/    /' "$MATCH_OUT"

case "$MATCH_RC" in
    0) pass "every client path resolves to a real FastAPI route" ;;
    1) fail "client paths drifted from the server route table (lines listed above)" ;;
    2) fail "the guard refused to report: a fatal rule fired (see above)" ;;
    *) fail "the matcher exited $MATCH_RC unexpectedly" ;;
esac

# --- The route table itself must be non-empty. A server that exposed zero
# --- /api routes would make "no drift" trivially true.
if grep -aqE 'server /api routes: [1-9]' "$MATCH_OUT"; then
    pass "the server route table is non-empty (the comparison had a right-hand side)"
else
    fail "no /api routes were read from server.app.routes; the comparison was vacuous"
fi

echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
