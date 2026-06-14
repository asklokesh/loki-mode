#!/usr/bin/env bash
# tests/test-completion-paused-block.sh -- the completion-block guard must
# reject a completion claim when code review escalated to the PAUSED state
# (v7.41.3).
#
# The bug: the guard at autonomy/run.sh ~14119 matched the BLOCKED token
# (code_review,) and the ESCALATED token (code_review_ESCALATED) but NOT the
# PAUSED token (code_review_PAUSED), which is the MOST severe state. PAUSED is
# written at run.sh:13953 when cr_count >= GATE_PAUSE_LIMIT, alongside touching
# .loki/PAUSE for human intervention. So on the iteration where the PAUSE limit
# trips AND the agent claims completion, the run returned a fulfilled completion
# and bypassed the human-intervention PAUSE -- verification theater for the
# worst-case state.
#
# This test reproduces the EXACT case statement from run.sh against the real
# token strings the code appends (code_review, / code_review_ESCALATED, /
# code_review_PAUSED,) and asserts:
#   - gate_failures has code_review_PAUSED  -> BLOCK (the fix)
#   - gate_failures has code_review_ESCALATED -> BLOCK (unchanged)
#   - gate_failures has code_review,        -> BLOCK (unchanged)
#   - gate_failures empty / unrelated       -> DO NOT BLOCK (unchanged)

set -uo pipefail

PASS=0; FAIL=0
ok()  { echo "ok: $1"; PASS=$((PASS+1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# Reproduces the run.sh completion-block guard verbatim. Echoes the resulting
# block decision: "code_review" when the guard blocks, "" when it does not.
gate_block_decision() {
    local gate_failures="$1"
    local _gate_block_for_completion=""
    case "${gate_failures:-}" in
        *code_review,*|*code_review_ESCALATED*|*code_review_PAUSED*) _gate_block_for_completion="code_review" ;;
    esac
    printf '%s' "$_gate_block_for_completion"
}

# Guard against drift: assert the case arm in run.sh actually carries the
# PAUSED token, so this reproduction stays faithful to the source.
RUN_SH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/autonomy/run.sh"
if grep -q '\*code_review_PAUSED\*) _gate_block_for_completion="code_review"' "$RUN_SH"; then
    ok "run.sh completion guard contains the code_review_PAUSED case arm"
else
    bad "run.sh completion guard MISSING the code_review_PAUSED case arm (source drifted from test)"
fi

# Also confirm the token the code writes really is code_review_PAUSED, (the
# string this guard must match) so the two stay in lockstep.
if grep -q 'gate_failures="${gate_failures}code_review_PAUSED,"' "$RUN_SH"; then
    ok "run.sh writes the code_review_PAUSED, token the guard matches"
else
    bad "run.sh no longer writes code_review_PAUSED, (token/guard mismatch)"
fi

# --- Case 1: PAUSED present -> BLOCK (the fix) ------------------------------
d="$(gate_block_decision 'code_review_PAUSED,')"
[ "$d" = "code_review" ] && ok "code_review_PAUSED -> completion BLOCKED" \
    || bad "code_review_PAUSED -> NOT blocked (regression: PAUSE bypassed)"

# Same, with other gates already accumulated before PAUSED.
d="$(gate_block_decision 'tests,lint,code_review_PAUSED,')"
[ "$d" = "code_review" ] && ok "mixed gates + code_review_PAUSED -> completion BLOCKED" \
    || bad "mixed gates + code_review_PAUSED -> NOT blocked"

# --- Case 2: ESCALATED present -> BLOCK (unchanged) -------------------------
d="$(gate_block_decision 'code_review_ESCALATED,')"
[ "$d" = "code_review" ] && ok "code_review_ESCALATED -> completion BLOCKED" \
    || bad "code_review_ESCALATED -> NOT blocked (regression)"

# --- Case 3: BLOCKED token present -> BLOCK (unchanged) ---------------------
d="$(gate_block_decision 'code_review,')"
[ "$d" = "code_review" ] && ok "code_review (BLOCKED) -> completion BLOCKED" \
    || bad "code_review (BLOCKED) -> NOT blocked (regression)"

# --- Case 4: no code_review gate -> DO NOT BLOCK (unchanged) ----------------
d="$(gate_block_decision '')"
[ -z "$d" ] && ok "empty gate_failures -> completion NOT blocked" \
    || bad "empty gate_failures -> blocked (false positive)"

d="$(gate_block_decision 'tests,lint,')"
[ -z "$d" ] && ok "unrelated gates only -> completion NOT blocked" \
    || bad "unrelated gates only -> blocked (false positive)"

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
