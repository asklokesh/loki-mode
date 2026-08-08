#!/usr/bin/env bash
# What the build learned is visible, in the record's own words.
#
# THE GAP. /api/learnings held real records -- rootCause, fix, preventInFuture --
# with ZERO ui consumers. The system was learning from its own gate failures and
# showing nobody, which makes the memory UNFALSIFIABLE: a user cannot correct a
# learning they cannot see. Devin ships a "misleading knowledge" surface for
# exactly this reason.
#
# TEST 2 IS THE LOAD-BEARING ONE. The record's OWN words are rendered, not a
# summary. A paraphrased root cause is a second claim about a claim, and the
# whole point of a learning is that it quotes what actually happened.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/dashboard-ui/scripts/build-standalone.js"
SHIPPED="$REPO_ROOT/dashboard/static/index.html"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
echo "TEST: the build's learnings are visible"
[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "  SKIPPED: node not installed (not a pass)"; exit 0; }

_render() {
    node -e "
const src=require('fs').readFileSync('$SRC','utf8');
const m=src.match(/window\.loadLearnings = function \(\) \{[\s\S]*?\n    \};/);
if(!m){console.error('EXTRACT_FAILED');process.exit(2);}
const el={'learnings-panel':{style:{}},'learnings-list':{innerHTML:''}};
global.document={getElementById:(id)=>el[id]};
global.fetch=()=>Promise.resolve({ok:true,json:()=>Promise.resolve($1)});
global.window=global;
new Function('global', m[0]).call(global, global); global.loadLearnings();
setTimeout(()=>{process.stdout.write(el['learnings-list'].innerHTML+'||'+String(el['learnings-panel'].style.display||''));},60);
" 2>/dev/null
}

_REC='{"learnings":[{"timestamp":"2026-07-31T23:09:19Z","iteration":2,"trigger":"gate_failure","rootCause":"[Critical] [unverified] reviewer produced no valid verdict","fix":"pending: dev agent must address","preventInFuture":"add a regression test"}]}'

# --- 1. THE GAP: the endpoint has a consumer -------------------------------
grep -q "'/api/learnings'" "$SRC" && ok "the learnings endpoint is consumed" \
  || bad "/api/learnings still has no consumer -- learnings stay invisible"

# --- 2. THE LOAD-BEARING ONE: the record's OWN words --------------------
_out="$(_render "$_REC")"
if printf '%s' "$_out" | grep -q "reviewer produced no valid verdict"; then
    ok "the root cause is rendered verbatim, not summarised"
else
    bad "the record's own words are missing: $_out"
fi
if printf '%s' "$_out" | grep -q "unverified"; then
    ok "a corrected severity label survives into the UI"
else
    bad "the [unverified] tag was stripped -- a harness failure reads as a code defect"
fi
printf '%s' "$_out" | grep -q "add a regression test" \
  && ok "preventInFuture is shown (the actionable half)" \
  || bad "preventInFuture is dropped"

# --- 3. Degrades to silence -------------------------------------------------
_out="$(_render '{"learnings":[]}')"
printf '%s' "$_out" | grep -q '||block' \
  && bad "an empty learning set still showed the panel" \
  || ok "no learnings shows nothing rather than an empty table"
_body="$(sed -n '/window.loadLearnings = function/,/^    };/p' "$SRC")"
printf '%s' "$_body" | grep -q "catch" \
  && ok "a failing fetch is caught, not fatal to Insights" \
  || bad "an error would break the Insights section"

# --- 4. Absent fields are not invented -------------------------------------
_out="$(_render '{"learnings":[{"timestamp":null,"iteration":null,"trigger":null,"rootCause":null}]}')"
printf '%s' "$_out" | grep -q "not recorded" \
  && ok "an absent root cause reads 'not recorded', not blank" \
  || bad "an absent root cause was hidden or invented: $_out"

# --- 5. Shipped bundle (grep -a + positive control) ------------------------
_ctl="$(grep -ac "Inter" "$SHIPPED" 2>/dev/null || echo 0)"
if [ "${_ctl:-0}" -lt 5 ]; then
    bad "control string missing -- cannot measure the shipped bundle"
elif grep -aq "learnings-panel" "$SHIPPED"; then
    ok "the panel is in the shipped bundle (control found $_ctl times)"
else
    bad "the shipped bundle has no learnings panel -- rebuild needed"
fi

node --check "$SRC" 2>/dev/null && ok "build-standalone.js parses" || bad "syntax error"
echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
