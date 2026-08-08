#!/usr/bin/env bash
# The absence of a spend cap must be visible before the bill is.
#
# THE GAP. /api/budget reports budget_limit and it ships NULL: LOKI_BUDGET_LIMIT
# is unset by default, so a long run has no automatic stop. Nothing in the UI
# said so -- the endpoint had ZERO consumers -- and the only place that fact
# surfaced was a bill.
#
# The default itself is defensible: a run killed mid-flight at a threshold the
# user never chose is worse than one that keeps going. What is not defensible is
# leaving it invisible.
#
# TEST 1 IS THE LOAD-BEARING ONE. The NO-CAP state must render as prominently as
# a cap. A banner that only appears when a limit exists would show nothing in
# exactly the situation the user most needs to know about -- the silent-danger
# direction of that error.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/dashboard-ui/scripts/build-standalone.js"
SHIPPED="$REPO_ROOT/dashboard/static/index.html"
PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }
echo "TEST: the spend-cap state is visible"
[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "  SKIPPED: node not installed (not a pass)"; exit 0; }

_render() {
    node -e "
const src=require('fs').readFileSync('$SRC','utf8');
const m=src.match(/window\.loadBudget = function \(\) \{[\s\S]*?\n    \};/);
if(!m){console.error('EXTRACT_FAILED');process.exit(2);}
const el={style:{},innerHTML:''};
global.document={getElementById:()=>el};
global.fetch=()=>Promise.resolve({ok:true,json:()=>Promise.resolve($1)});
global.window=global; new Function('global', m[0]).call(global, global); global.loadBudget();
setTimeout(()=>process.stdout.write(el.innerHTML+'||'+String(el.style.display||'')),50);
" 2>/dev/null
}

# --- 1. THE LOAD-BEARING ONE: no cap is stated, not omitted ----------------
_out="$(_render '{"budget_limit":null,"current_cost":12.5}')"
printf '%s' "$_out" | grep -qi "No spend cap" \
  && ok "the NO-CAP state is stated plainly" \
  || bad "no cap renders nothing -- the dangerous state is the silent one: $_out"
printf '%s' "$_out" | grep -q "||block" \
  && ok "the banner is actually shown when there is no cap" \
  || bad "the banner stayed hidden with no cap set"
printf '%s' "$_out" | grep -q "LOKI_BUDGET_LIMIT" \
  && ok "it names the variable that sets a cap" \
  || bad "it reports no cap without saying how to set one"

# --- 2. A real cap and an exceeded cap both render -------------------------
_out="$(_render '{"budget_limit":50,"current_cost":12.5,"remaining":37.5,"exceeded":false}')"
printf '%s' "$_out" | grep -q '\$50.00' && printf '%s' "$_out" | grep -q '\$37.50' \
  && ok "a set cap shows the limit and what remains" \
  || bad "cap state is wrong: $_out"
_out="$(_render '{"budget_limit":10,"current_cost":12.5,"exceeded":true}')"
printf '%s' "$_out" | grep -qi "exceeded" \
  && ok "an exceeded budget says so" \
  || bad "exceeded state is not surfaced: $_out"

# --- 3. THE GUARD: an unmeasured cost is not fabricated as $0.00 -----------
_out="$(_render '{"budget_limit":null,"current_cost":null}')"
printf '%s' "$_out" | grep -q "not measured" \
  && ok "an unmeasured spend reads 'not measured'" \
  || bad "unmeasured spend was fabricated: $_out"
printf '%s' "$_out" | grep -q '\$0.00' \
  && bad "an unmeasured spend rendered \$0.00 -- that claims the run was free" \
  || ok "unmeasured never renders as \$0.00"

# --- 4. Degrades to silence -------------------------------------------------
_body="$(sed -n '/window.loadBudget = function/,/^    };/p' "$SRC")"
printf '%s' "$_body" | grep -q "catch" \
  && ok "a failing fetch is caught, not fatal to the Cost page" \
  || bad "an error would break the Cost section"

# --- 5. Shipped bundle (grep -a + positive control) ------------------------
_ctl="$(grep -ac "Inter" "$SHIPPED" 2>/dev/null || echo 0)"
if [ "${_ctl:-0}" -lt 5 ]; then
    bad "control string missing -- cannot measure the shipped bundle"
elif grep -aq "budget-banner" "$SHIPPED"; then
    ok "the banner is in the shipped bundle (control found $_ctl times)"
else
    bad "the shipped bundle has no budget banner -- rebuild needed"
fi

node --check "$SRC" 2>/dev/null && ok "build-standalone.js parses" || bad "syntax error"
echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
