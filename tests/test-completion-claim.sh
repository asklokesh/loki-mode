#!/usr/bin/env bash
# tests/test-completion-claim.sh -- completion-claim DROP-FIX regression suite
# (v7.28).
#
# THE BUG (verified on a real $25+ build that burned 12 extra iterations):
#   check_completion_promise() -> check_task_completion_signal() CONSUMES the
#   completion signal (rm -f .loki/signals/TASK_COMPLETION_CLAIMED) the FIRST
#   time it returns 0. The completion-promise elif chain in run_autonomous()
#   called check_completion_promise up to FIVE times per iteration (reverify
#   guard, code-review arm, evidence arm, held-out arm, success arm). The first
#   successful call consumed the claim, so every later arm saw nothing -- the
#   success arm never fired and the run iterated to max_iterations even though
#   the agent had legitimately claimed completion.
#
# THE FIX: evaluate the claim EXACTLY ONCE per iteration into a local
#   _completion_claimed, then have every arm test [ "$_completion_claimed" = 1 ].
#   Consumption semantics are deliberately preserved: the claim is consumed when
#   evaluated; if a gate rejects it, the agent must re-claim next iteration.
#
# This suite locks in the single-evaluation contract three ways:
#   (a) Functional: prove the helper consumes on first success (the root cause),
#       then prove the new single-evaluation contract -- ONE evaluation supports
#       BOTH a gate check and the success decision via the captured variable.
#   (b) Static wiring: the chain must contain exactly ONE call-with-argument
#       check_completion_promise (the upfront capture) and the arms must test
#       _completion_claimed, so a future edit cannot silently reintroduce the
#       multi-call drop.
#   (c) Gate-reject re-claim: after one evaluation consumes the signal, a fresh
#       signal written again is detected by the NEXT evaluation.
#
# Skips gracefully (exit 0) when python3/run.sh are unavailable.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0

ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# ---------------------------------------------------------------------------
# Environment guards (skip, do not fail, when prerequisites are missing).
# ---------------------------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP: python3 not available"
    exit 0
fi
if [ ! -f "$RUN_SH" ]; then
    echo "SKIP: run.sh not found at $RUN_SH"
    exit 0
fi

# Scoped, self-cleaning workspace (mktemp dir only -- never touches
# /tmp/loki-run-*, /tmp/swebench-pro-pilot, or port 57374).
WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-completion-claim.XXXXXX")"
cleanup() { rm -rf "$WORKROOT" 2>/dev/null || true; }
trap cleanup EXIT

# Write a valid TASK_COMPLETION_CLAIMED payload into <dir>/.loki/signals.
write_claim() {
    local dir="$1"
    mkdir -p "$dir/.loki/signals"
    cat > "$dir/.loki/signals/TASK_COMPLETION_CLAIMED" <<'JSON'
{"statement":"All PRD requirements implemented and tests passing","evidence":"diff + green test run","confidence":"high","source":"loki_complete_task"}
JSON
}

# Source run.sh in a clean subshell at <cwd> with log_* / emit_event_json
# stubbed quiet, then run an arbitrary snippet (passed as the function body of
# `body`). BASH_SOURCE != $0 so run.sh's main() does not execute on source.
in_run_sh() {
    local cwd="$1"; shift
    (
        cd "$cwd" || exit 1
        log_info()        { :; }
        log_warn()        { :; }
        log_error()       { :; }
        log_debug()       { :; }
        log_header()      { :; }
        log_step()        { :; }
        emit_event_json() { :; }
        # shellcheck disable=SC1090
        source "$RUN_SH" >/dev/null 2>&1
        "$@"
    )
}

# ===========================================================================
# Case 1 (a): root-cause -- the helper CONSUMES on first success.
#   With one signal present, the FIRST check_completion_promise returns 0 and
#   the SECOND returns 1 with the signal file gone. This is the unchanged helper
#   contract and the exact reason the single-evaluation pattern is required. It
#   holds both before and after the run_autonomous fix (the fix lives at the
#   call site, not in the helper).
# ===========================================================================
echo "Case 1: helper consumes the completion signal on first success"
c1="$WORKROOT/case1"; write_claim "$c1"
double_call() {
    local first second
    if check_completion_promise "/dev/null"; then first=0; else first=1; fi
    if check_completion_promise "/dev/null"; then second=0; else second=1; fi
    local present=1
    [ -f ".loki/signals/TASK_COMPLETION_CLAIMED" ] && present=0
    printf '%s %s %s\n' "$first" "$second" "$present"
}
res="$(in_run_sh "$c1" double_call 2>/dev/null)"
read -r c1_first c1_second c1_present <<< "$res"
if [ "$c1_first" = 0 ]; then
    ok "case1 first check_completion_promise detects the claim (rc 0)"
else
    bad "case1 first call" "expected rc 0, got '$c1_first'"
fi
if [ "$c1_second" = 1 ]; then
    ok "case1 second check_completion_promise returns 1 (signal consumed -- this is the drop)"
else
    bad "case1 second call" "expected rc 1 (consumed), got '$c1_second'"
fi
if [ "$c1_present" = 1 ]; then
    ok "case1 signal file is gone after first call (rm -f consumption)"
else
    bad "case1 signal presence" "expected signal removed, but it still exists"
fi

# ===========================================================================
# Case 2 (a): the NEW single-evaluation contract.
#   Evaluate the claim ONCE into _completion_claimed (exactly as the fixed
#   run_autonomous block does), then prove that ONE evaluation supports BOTH a
#   downstream gate decision AND the success decision -- which the old multi-call
#   chain could not, because the second consumer always saw nothing.
# ===========================================================================
echo "Case 2: one evaluation supports a gate check + the success decision"
c2="$WORKROOT/case2"; write_claim "$c2"
single_eval_chain() {
    # Mirror the fixed block: evaluate once, capture, reuse everywhere.
    local _completion_claimed=0
    if check_completion_promise "/dev/null"; then _completion_claimed=1; fi
    # Arm 1 (a gate arm): would inspect the claim ...
    local gate_saw=0
    if [ "$_completion_claimed" = 1 ]; then gate_saw=1; fi
    # Arm 2 (success arm): ... and the success arm sees the SAME claim.
    local success=0
    if [ "$_completion_claimed" = 1 ]; then success=1; fi
    printf '%s %s %s\n' "$_completion_claimed" "$gate_saw" "$success"
}
res="$(in_run_sh "$c2" single_eval_chain 2>/dev/null)"
read -r c2_claimed c2_gate c2_success <<< "$res"
if [ "$c2_claimed" = 1 ]; then
    ok "case2 single evaluation captures the claim into _completion_claimed"
else
    bad "case2 capture" "expected _completion_claimed=1, got '$c2_claimed'"
fi
if [ "$c2_gate" = 1 ] && [ "$c2_success" = 1 ]; then
    ok "case2 the SAME captured claim drives both a gate arm and the success arm"
else
    bad "case2 reuse" "gate=$c2_gate success=$c2_success (both must be 1 -- the drop fix)"
fi

# ===========================================================================
# Case 3 (b): static wiring -- lock out a regression to the multi-call pattern.
#   The fixed chain must have EXACTLY ONE call-with-argument
#   check_completion_promise (the upfront capture) and the arms must test
#   _completion_claimed.
# ===========================================================================
echo "Case 3: static wiring assertions (single evaluation + variable-tested arms)"
# (i) exactly one call-with-argument check_completion_promise in run.sh.
cap_calls="$(grep -c 'check_completion_promise "\$iter_output"' "$RUN_SH" 2>/dev/null || echo 0)"
if [ "${cap_calls:-0}" = 1 ]; then
    ok "case3 exactly ONE check_completion_promise \"\$iter_output\" capture (got $cap_calls)"
else
    bad "case3 single-evaluation" "expected exactly 1 capture call, got $cap_calls (multi-call drop reintroduced?)"
fi
# (ii) the chain arms must test the captured variable (>=4 arm references:
#      reverify guard, code-review arm, evidence arm, held-out arm, success arm).
arm_refs="$(grep -c '\[ "\$_completion_claimed" = 1 \]' "$RUN_SH" 2>/dev/null || echo 0)"
if [ "${arm_refs:-0}" -ge 4 ]; then
    ok "case3 completion arms test _completion_claimed (got $arm_refs references)"
else
    bad "case3 arm wiring" "expected >=4 _completion_claimed arm tests, got $arm_refs"
fi
# (iii) the upfront capture assigns the variable.
if grep -Eq '_completion_claimed=1' "$RUN_SH"; then
    ok "case3 capture assigns _completion_claimed=1 on a detected claim"
else
    bad "case3 capture assignment" "no _completion_claimed=1 assignment found in run.sh"
fi

# ===========================================================================
# Case 4 (c): gate-reject re-claim semantics.
#   After one evaluation consumes the signal, writing a FRESH signal again is
#   detected by the NEXT evaluation. This is the documented intent: a rejected
#   claim must be re-asserted by the agent next iteration.
# ===========================================================================
echo "Case 4: a fresh signal after consumption is re-detected next evaluation"
c4="$WORKROOT/case4"; write_claim "$c4"
reclaim_flow() {
    local first reclaim
    # First evaluation consumes the original claim.
    if check_completion_promise "/dev/null"; then first=0; else first=1; fi
    # Agent re-claims next iteration: write a fresh signal.
    cat > ".loki/signals/TASK_COMPLETION_CLAIMED" <<'JSON'
{"statement":"re-claim after gate rejection","evidence":"more work done","confidence":"high","source":"loki_complete_task"}
JSON
    # Next evaluation must detect the fresh claim.
    if check_completion_promise "/dev/null"; then reclaim=0; else reclaim=1; fi
    printf '%s %s\n' "$first" "$reclaim"
}
res="$(in_run_sh "$c4" reclaim_flow 2>/dev/null)"
read -r c4_first c4_reclaim <<< "$res"
if [ "$c4_first" = 0 ]; then
    ok "case4 first evaluation consumes the original claim (rc 0)"
else
    bad "case4 first eval" "expected rc 0, got '$c4_first'"
fi
if [ "$c4_reclaim" = 0 ]; then
    ok "case4 a freshly re-written signal is re-detected next evaluation (rc 0)"
else
    bad "case4 re-claim" "expected rc 0 on re-claim, got '$c4_reclaim'"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================================================"
printf 'test-completion-claim: %d passed, %d failed\n' "$PASS" "$FAIL"
echo "============================================================"
[ "$FAIL" -eq 0 ]
