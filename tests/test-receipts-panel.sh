#!/usr/bin/env bash
# The Evidence Receipt is reachable from the dashboard.
#
# THE GAP. /api/proofs serves 9 receipts with a verdict, a file count, a cost
# and an HTML view of the receipt itself. NOTHING in the dashboard read it --
# only /api/proofs/summary, which feeds the header badge. So the product's
# strongest claim ("we hand you a receipt you can check yourself") had no
# surface: a user could see the COUNT of receipts and never open one.
#
# Measured before the fix: `grep -oE "'/api/proofs[^']*'" build-standalone.js`
# returned exactly one line, /api/proofs/summary. The list, the detail and the
# HTML route had zero consumers.
#
# TEST 3 IS THE LOAD-BEARING ONE. An absent cost renders "-", never "$0.00".
# A fabricated zero reads as "this run was free", which is a claim; the receipt
# records cost as UNKNOWN when it was not measured, and the pixel must keep that
# distinction or the honesty dies at the last inch.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/dashboard-ui/scripts/build-standalone.js"
SHIPPED="$REPO_ROOT/dashboard/static/index.html"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the evidence receipt is reachable from the dashboard"

[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "  SKIPPED: node not installed (not a pass)"; exit 0; }

# --- 1. THE GAP: the list endpoint now has a consumer -----------------------
_routes="$(grep -oE "'/api/proofs[^']*'" "$SRC" 2>/dev/null | sort -u)"
if printf '%s' "$_routes" | grep -q "'/api/proofs'"; then
    ok "the receipt LIST endpoint is consumed"
else
    bad "/api/proofs still has no consumer -- receipts remain unreachable"
fi
if printf '%s' "$_routes" | grep -q "/api/proofs/summary"; then
    ok "the summary badge still works (not regressed)"
else
    bad "the header badge lost its data source"
fi

# --- 2. The receipt ITSELF is openable --------------------------------------
# A list that cannot open the underlying evidence is a table of adjectives.
# Matched on the PROPERTY (a link to the per-receipt html route) rather than an
# exact string: the expression spans a line break, and my first pattern missed
# it against correct code. Same wording-vs-property trap as two guards earlier
# today.
if grep -q 'api/proofs/.*encodeURIComponent' "$SRC" && grep -q "/html" "$SRC"; then
    ok "each row links to the receipt's own HTML view"
else
    bad "no link to the receipt itself -- the user can see rows but not evidence"
fi
if grep -q "encodeURIComponent" "$SRC"; then
    ok "the run id is encoded into the link (no injection via a crafted id)"
else
    bad "run id interpolated raw into a URL"
fi

# --- 3. THE GUARD: an absent value is "-", never a fabricated zero ----------
# Extracts the REAL cost/files/verdict expressions from loadReceipts and
# evaluates those. The first version hand-wrote the same expressions in the
# test, which made the assertion VACUOUS: mutating the source to fabricate
# $0.00 left the test green because it was exercising its own correct copy.
# Same trap as the Slack separator guard earlier today.
# Calls the REAL loadReceipts with a stubbed fetch and DOM, then reads the row
# it actually rendered. The first version hand-wrote the cost/files expressions
# in the test, which made the assertion VACUOUS -- mutating the source to
# fabricate $0.00 left the test green because it exercised its own correct copy.
# The second tried to regex the expressions out and truncated the multi-line
# ternaries. Driving the function is the only version that cannot drift.
_render() {
    node -e "
const fs=require('fs');
const src=fs.readFileSync('$SRC','utf8');
const m=src.match(/window\.loadReceipts = function \(\) \{[\s\S]*?\n    \};/);
if(!m){console.error('EXTRACT_FAILED');process.exit(2);}
const rows=[$1];
const el={'receipts-panel':{style:{}},'receipts-list':{innerHTML:''},'receipts-note':{textContent:''}};
global.document={getElementById:(id)=>el[id]};
global.fetch=()=>Promise.resolve({ok:true,json:()=>Promise.resolve(rows)});
global.window=global;
new Function('global', m[0]).call(global, global);
global.loadReceipts();
setTimeout(()=>{process.stdout.write(el['receipts-list'].innerHTML);},50);
" 2>/dev/null
}
_out="$(_render '{"cost_usd":null,"files_changed":null}')"
if ! printf '%s' "$_out" | grep -q '\$0.00'; then
    ok "an unmeasured cost renders '-', not \$0.00"
else
    bad "unmeasured cost was fabricated (expected '-'): $_out"
fi
if printf '%s' "$_out" | grep -q '>- files<'; then
    ok "an absent file count renders '-', not 0"
else
    bad "absent file count was fabricated: $_out"
fi
if printf '%s' "$_out" | grep -q '>UNKNOWN<'; then
    ok "a missing verdict reads UNKNOWN, not blank or passing"
else
    bad "a missing verdict was not surfaced: $_out"
fi
# And a REAL zero must still render as zero -- the guard must not swallow it.
_out="$(_render '{"cost_usd":0,"files_changed":0}')"
if printf '%s' "$_out" | grep -q '\$0.00' && printf '%s' "$_out" | grep -q '>0 files<'; then
    ok "a genuine zero still renders as zero (the guard is not over-broad)"
else
    bad "a real measured zero was hidden as '-': $_out"
fi

# --- 4. Degrades to SILENCE, never to a wrong surface ----------------------
# The panel starts hidden and is only shown once rows arrive. An endpoint that
# is absent (older server) or errors must leave the page as it was.
if grep -q 'id="receipts-panel"' "$SRC" && grep -q 'display:none' "$SRC"; then
    ok "the panel is hidden until data arrives"
else
    bad "the panel renders before it has data"
fi
_body="$(sed -n '/window.loadReceipts = function/,/^    };/p' "$SRC")"
if printf '%s' "$_body" | grep -q "catch"; then
    ok "a failing receipts fetch is caught, not fatal to the Trust page"
else
    bad "an error would break the Trust section"
fi
if printf '%s' "$_body" | grep -q "if (!rows.length) return"; then
    ok "zero receipts shows nothing rather than an empty table"
else
    bad "an empty receipt set renders a misleading empty surface"
fi

# --- 5. It tells the user how to check it themselves ------------------------
# A receipt nobody can re-verify is a claim.
if grep -q "loki proof verify" "$SRC"; then
    ok "the panel names the command that re-verifies a receipt"
else
    bad "the panel shows receipts without saying how to check them"
fi

# --- 6. It reached the SHIPPED bundle ---------------------------------------
# grep -a with a positive control: this file has very long lines, and grep
# otherwise treats it as binary and prints NOTHING, which reads as a clean zero.
if [ -f "$SHIPPED" ]; then
    _ctl="$(grep -ac "Inter" "$SHIPPED" 2>/dev/null || echo 0)"
    if [ "${_ctl:-0}" -lt 5 ]; then
        bad "control string missing -- cannot measure the shipped bundle"
    elif grep -aq "receipts-panel" "$SHIPPED"; then
        ok "the panel is in the shipped bundle (control found $_ctl times)"
    else
        bad "the shipped bundle has no receipts panel -- rebuild needed"
    fi
else
    bad "shipped bundle missing"
fi

# --- 7. Syntax --------------------------------------------------------------
node --check "$SRC" 2>/dev/null && ok "build-standalone.js parses" \
    || bad "build-standalone.js has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
