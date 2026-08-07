#!/usr/bin/env bash
# The Quality page says which gates BLOCK, and never guesses.
#
# THE GAP. /api/gate-policy shipped with ZERO ui consumers -- the same
# inert-surface pattern as the six modules found earlier today: built, tested,
# and unreachable by the people it was built for. A user looking at eight gate
# cards could not tell which ones would actually stop a build, which is the only
# thing that distinguishes a gate from a suggestion.
#
# TEST 3 IS THE LOAD-BEARING ONE, and it is about an ABSENT measurement.
# audit_hits is null when a gate was never measured. Rendering that as "0 hits"
# claims the gate RAN and never fired -- an operator would reasonably promote a
# gate they believe has never blocked anything. The reporter refuses to emit 0
# there; the pixel must refuse too, or the guarantee dies at the last inch.
#
# TEST 4 is the second refusal: a gate the policy does not mention renders
# NOTHING. Defaulting to "advisory" would tell a user a BLOCKING gate is
# optional, which is the dangerous direction of that error.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/dashboard-ui/components/loki-quality-gates.js"
SHIPPED="$REPO_ROOT/dashboard/static/index.html"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the Quality page shows which gates block"

[ -f "$SRC" ] || { echo "  FAIL: $SRC missing"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "  SKIPPED: node not installed (not a pass)"; exit 0; }

# Drives the REAL _policyLine extracted from source, so this cannot drift from
# the implementation the way a hand-copied renderer would.
_render() {
    node -e "
const fs=require('fs');
const src=fs.readFileSync('$SRC','utf8');
const m=src.match(/_policyLine\(displayName\) \{[\s\S]*?\n  \}/);
if(!m){console.error('EXTRACT_FAILED');process.exit(2);}
const body=m[0].replace(/^\s*_policyLine\(displayName\) \{/,'').replace(/\}\s*\$/,'');
const fn=new Function('displayName', body);
const ctx={_policy:$1,_escapeHtml:String};
process.stdout.write(String(fn.call(ctx, '$2')||''));
" 2>/dev/null
}

_P='[{"gate":"code_review","mode":"blocking","audit_hits":6},{"gate":"magic_debate","mode":"advisory","audit_hits":0,"promote_with":"LOKI_GATE_MAGIC_DEBATE_BLOCKING=true"},{"gate":"test_coverage","mode":"advisory","audit_hits":null,"promote_with":"LOKI_COV_ENFORCE=1"}]'

# --- 1. A blocking gate says so, with its hit count -------------------------
_out="$(_render "$_P" "Blind Code Review")"
if printf '%s' "$_out" | grep -q "BLOCKS" && printf '%s' "$_out" | grep -q "6 hits"; then
    ok "a blocking gate renders BLOCKS with its hit count"
else
    bad "blocking gate line is wrong: $_out"
fi

# --- 2. An advisory gate names the knob that promotes it --------------------
# "advisory" with no next step is a dead end; the operator still has to grep.
_out="$(_render "$_P" "Magic Modules Debate")"
if printf '%s' "$_out" | grep -q "advisory" && printf '%s' "$_out" | grep -q "LOKI_GATE_MAGIC_DEBATE_BLOCKING=true"; then
    ok "an advisory gate names its promotion variable"
else
    bad "advisory gate line is wrong: $_out"
fi

# --- 3. THE GUARD: unmeasured renders "not measured", NEVER 0 --------------
_out="$(_render "$_P" "Test Suite")"
if printf '%s' "$_out" | grep -q "not measured"; then
    ok "an unmeasured gate renders 'not measured'"
else
    bad "unmeasured gate does not say so: $_out"
fi
if printf '%s' "$_out" | grep -qE "\b0 hits?\b"; then
    bad "an UNMEASURED gate rendered '0 hits' -- that claims it ran and never fired"
else
    ok "unmeasured never renders as 0 hits"
fi

# --- 4. THE SECOND REFUSAL: an unknown gate renders nothing ----------------
# Defaulting to "advisory" would tell a user a BLOCKING gate is optional.
_out="$(_render "$_P" "Anti-Sycophancy")"
if [ -z "$_out" ]; then
    ok "a gate absent from the policy renders nothing (not a guessed mode)"
else
    bad "an unknown gate was given a mode: $_out"
fi
_out="$(_render "null" "Blind Code Review")"
if [ -z "$_out" ]; then
    ok "no policy at all renders nothing (older server degrades cleanly)"
else
    bad "a missing policy still rendered a mode: $_out"
fi

# --- 5. The name mapping is EXPLICIT, not derived --------------------------
# "Test Suite" -> test_coverage and "Test Mutation" -> mutation_integrity are
# different gates that a lower()/replace() heuristic collides.
if grep -q "'Test Suite': 'test_coverage'" "$SRC" \
   && grep -q "'Test Mutation': 'mutation_integrity'" "$SRC"; then
    ok "the display-name mapping is explicit (no heuristic collision)"
else
    bad "the mapping is derived or incomplete -- Test Suite/Test Mutation will mis-map"
fi

# --- 6. The policy fetch cannot blank the page ------------------------------
# It is decoration on top of the gate list; a failing endpoint must leave the
# gates exactly as they were.
if sed -n '/GATE POLICY/,/^      }/p' "$SRC" | grep -q "catch"; then
    ok "a failing policy fetch is caught, not fatal to the gate list"
else
    bad "a policy-endpoint error would break the whole Quality page"
fi

# --- 7. It reached the SHIPPED bundle ---------------------------------------
# Source-only would pass while the served page stayed unchanged. grep -a: this
# file has very long lines and grep otherwise treats it as binary and prints
# NOTHING, which reads as a clean zero.
if [ -f "$SHIPPED" ]; then
    _ctl="$(grep -ac "Inter" "$SHIPPED" 2>/dev/null || echo 0)"
    if [ "${_ctl:-0}" -lt 5 ]; then
        bad "control string missing -- cannot measure the shipped bundle"
    elif grep -aq "gate-policy" "$SHIPPED"; then
        ok "the change is in the shipped bundle (control found $_ctl times)"
    else
        bad "the shipped bundle does not contain the policy line -- rebuild needed"
    fi
else
    bad "shipped bundle missing"
fi

# --- 8. Syntax --------------------------------------------------------------
node --check "$SRC" 2>/dev/null && ok "loki-quality-gates.js parses" \
    || bad "loki-quality-gates.js has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
