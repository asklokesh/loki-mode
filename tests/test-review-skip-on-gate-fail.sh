#!/usr/bin/env bash
# Skipping the council on an already-failed gate must never approve anything.
#
# WHY. Measured council cost is 31s at 3 reviewers and 280-502s at 6-7. The
# deterministic gates that run BEFORE it cost ~6s combined (static_analysis 5s,
# security_scan 1s, lsp_diagnostics 1s, test_suite <1s). When one of those has
# already failed, `gate_failures` is non-empty and the iteration cannot be
# accepted regardless of the council's verdict -- so the review is spending up
# to 502s to describe a rejection that is already decided.
#
# THE SAFETY PROPERTY, which is the whole point of this file:
#
#   A skipped review is recorded as SKIPPED, never as a PASS.
#
# If a skip could register as a pass, this optimisation would convert every
# failing build into an approved one -- the single worst outcome available in
# this codebase. It is asserted directly, and pinned by mutation.
#
# Also asserted:
#   - default OFF (an opt-in knob, not a silent global behaviour change)
#   - the skip requires BOTH the flag and a non-empty gate_failures
#   - the failing gate still blocks (the skip removes review, not the block)

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$REPO_ROOT/autonomy/run.sh"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

echo "TEST: code review skip on prior gate failure"

# Drive the decision expression exactly as run.sh evaluates it.
decide() {
    local flag="$1" failures="$2"
    env LOKI_REVIEW_SKIP_ON_GATE_FAIL="$flag" _GF="$failures" bash -c '
        gate_failures="$_GF"
        _skip_review=false
        if [ "${LOKI_REVIEW_SKIP_ON_GATE_FAIL:-false}" = "true" ] \
           && [ -n "${gate_failures:-}" ]; then
            _skip_review=true
        fi
        printf "%s" "$_skip_review"
    '
}

# --- default is OFF ----------------------------------------------------------
# An opt-in latency/guidance trade must not change behaviour on upgrade.
[ "$(decide "" "test_suite,")" = "false" ] \
    && ok "unset flag does not skip (default off)" \
    || bad "the skip is on by default; upgrading silently drops review guidance"

[ "$(decide false "test_suite,")" = "false" ] \
    && ok "explicit false does not skip" \
    || bad "explicit false still skipped"

# --- the skip needs BOTH conditions -----------------------------------------
[ "$(decide true "")" = "false" ] \
    && ok "flag on but no gate failures -> review still runs" \
    || bad "review skipped with NO failing gate -- that drops review on green builds"

[ "$(decide true "test_suite,")" = "true" ] \
    && ok "flag on + a failed gate -> review is skipped" \
    || bad "the skip never fires, so it saves nothing"

# --- THE SAFETY PROPERTY -----------------------------------------------------
# A skip must record "skipped", never "pass". Asserted against the source: the
# emit call in the skip branch decides what the receipt and the completion
# decision see.
_skip_block="$(sed -n '/SKIP THE COUNCIL WHEN A DETERMINISTIC GATE/,/log_info "Quality gate: code review/p' "$RUN_SH")"

if [ -z "$_skip_block" ]; then
    bad "could not locate the skip branch; the assertions below prove nothing"
else
    case "$_skip_block" in
        *'emit_stage_complete "code_review" "skipped"'*)
            ok "a skipped review is recorded as SKIPPED" ;;
        *'emit_stage_complete "code_review" "pass"'*)
            bad "a skipped review records PASS -- this approves every failing build" ;;
        *)
            bad "the skip branch records no stage status at all" ;;
    esac

    # The skip branch must not clear the failure it is skipping over.
    case "$_skip_block" in
        *clear_gate_failure*)
            bad "the skip branch clears a gate failure -- it must only decline to review" ;;
        *) ok "the skip branch does not clear the failing gate" ;;
    esac

    # It must not touch gate_failures, which is what actually blocks.
    case "$_skip_block" in
        *'gate_failures='*)
            bad "the skip branch reassigns gate_failures -- it could erase the block" ;;
        *) ok "the skip branch leaves gate_failures intact (the block survives)" ;;
    esac
fi

# --- WIRING ------------------------------------------------------------------
# The decision logic above is a re-implementation. These assert run.sh carries
# it, since a correct rule nothing applies is the gap found nine times here.
if grep -q 'LOKI_REVIEW_SKIP_ON_GATE_FAIL' "$RUN_SH"; then
    ok "WIRING: run.sh reads LOKI_REVIEW_SKIP_ON_GATE_FAIL"
else
    bad "WIRING: the flag is absent from run.sh"
fi

if grep -q 'if \[ "$_skip_review" = "true" \]; then' "$RUN_SH"; then
    ok "WIRING: the review block branches on the skip decision"
else
    bad "WIRING: nothing consults _skip_review; the skip never fires"
fi

# BOTH conditions must be present in run.sh's OWN condition, not just in this
# file's re-implementation. Dropping the gate_failures test makes the flag skip
# review on GREEN builds too -- losing review entirely rather than deferring it.
# The decide() cases above could not see that: they test a copy of the logic,
# so weakening the original left them green. A re-implementation tests the rule;
# only reading the source tests the code.
if grep -q '&& \[ -n "${gate_failures:-}" \]; then' "$RUN_SH"; then
    ok "WIRING: run.sh requires a non-empty gate_failures to skip"
else
    bad "WIRING: the gate_failures condition is gone -- review would be skipped on passing builds"
fi

if grep -q '\[ "${LOKI_REVIEW_SKIP_ON_GATE_FAIL:-false}" = "true" \]' "$RUN_SH"; then
    ok "WIRING: run.sh requires the opt-in flag to skip"
else
    bad "WIRING: the flag condition is gone -- the skip is unconditional"
fi

# The elif is load-bearing: turning it into a plain `if` would run the council
# even when the skip fired, making the whole change a no-op.
if grep -q 'elif \[ "$PHASE_CODE_REVIEW" = "true" \]' "$RUN_SH"; then
    ok "WIRING: the review branch is an elif, so a skip really skips"
else
    bad "WIRING: review is not chained to the skip; it would run anyway"
fi

echo ""
echo "  Passed:     $PASS"
echo "  Failed:     $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
