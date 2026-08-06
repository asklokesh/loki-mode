#!/usr/bin/env bash
# First-run funnel coverage.
#
# WHY THIS EXISTS. The funnel was built well and pointed away from users.
# `loki_emit_funnel_once` / `loki_emit_first_run_blocked` (autonomy/telemetry.sh)
# already sent a once-per-machine, bounded-enum, opt-out-respecting signal -- but
# `first_run_blocked` fired from exactly ONE call site, inside doctor's failure
# branch. Every other way a first run dies emitted nothing:
#
#   - the four provider_offer_gate exits (loki start / demo / quick / quickstart)
#   - the auth preflight in run.sh, reached only AFTER the user confirms the spend
#
# `first_start_attempted` still fired, so the data said a first run was ATTEMPTED
# and nothing about whether it survived. An attempt that died for want of a
# provider CLI was indistinguishable from one that shipped a working build. With
# ~19k npm downloads in 30 days and zero user-filed bugs, that blind spot IS the
# adoption question: we could not tell whether trials failed on capability,
# discoverability or trust.
#
# These assertions are about WIRING, not about network delivery. They prove the
# emit is reachable from each wall and that what it sends stays bounded. They
# deliberately never enable analytics or send anything.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0; FAIL=0
ok()   { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: first-run funnel covers the walls users actually hit"

# --- 1. The provider gate reports, from ONE site covering all four callers ----
# Emitting from the gate rather than from each caller is the point: four copies
# drift, and a future caller of the gate would be silently uninstrumented.
if grep -q '_provider_gate_emit_blocked' "$REPO_ROOT/autonomy/provider-offer.sh"; then
    ok "provider_offer_gate reports a blocked first run"
else
    bad "provider_offer_gate does not report -- start/demo/quick/quickstart exit 2 silently"
fi

# Both failure paths must report: the declined-install path AND the
# installed-but-still-absent path. Missing either leaves a real wall dark.
_gate_body="$(sed -n '/^provider_offer_gate()/,/^}/p' "$REPO_ROOT/autonomy/provider-offer.sh")"
_gate_emits="$(printf '%s' "$_gate_body" | grep -c '_provider_gate_emit_blocked')"
if [ "$_gate_emits" -ge 2 ]; then
    ok "both gate failure paths report (declined install, and install-then-still-absent)"
else
    bad "only $_gate_emits of 2 gate failure paths report"
fi

# The gate's success path must stay silent -- a funnel that fires on success
# would make "blocked" meaningless.
if printf '%s' "$_gate_body" | grep -q 'detect_any_provider && return 0'; then
    ok "the success path returns without reporting"
else
    bad "the gate's success path changed shape; re-check that success stays silent"
fi

# --- 2. The post-consent auth wall reports -----------------------------------
# This is the worst-placed failure in the product: the user has already answered
# every prompt and confirmed the spend before seeing it.
_auth_emits="$(grep -c 'loki_emit_first_run_blocked "not_logged_in"' "$REPO_ROOT/autonomy/run.sh")"
if [ "$_auth_emits" -ge 2 ]; then
    ok "both auth-preflight refusals report (logged out, and expired)"
else
    bad "only $_auth_emits of 2 auth-preflight refusals report"
fi

# --- 3. The enum stays bounded ------------------------------------------------
# The privacy claim rests on this. A blocker key must resolve to a fixed enum,
# never to caller-supplied text that could carry a path or a hostname.
# shellcheck source=/dev/null
if source "$REPO_ROOT/autonomy/telemetry.sh" 2>/dev/null && declare -f _loki_known_blocker >/dev/null 2>&1; then
    if [ "$(_loki_known_blocker not_logged_in)" = "not_logged_in" ]; then
        ok "not_logged_in is a first-class enum value"
    else
        bad "not_logged_in collapses to 'other' -- the most common post-install failure is unactionable"
    fi

    if [ "$(_loki_known_blocker no_provider)" = "no_provider" ]; then
        ok "no_provider is preserved (install something)"
    else
        bad "no_provider does not survive the enum"
    fi

    # not_logged_in and no_provider are the two halves of the same wall and need
    # OPPOSITE fixes. Merging them would make the data useless for deciding
    # whether to improve install or improve auth.
    if [ "$(_loki_known_blocker not_logged_in)" != "$(_loki_known_blocker no_provider)" ]; then
        ok "install-vs-authenticate stay distinguishable"
    else
        bad "not_logged_in and no_provider collapse together"
    fi

    # The actual leak guard: anything unrecognized -- notably anything
    # path-shaped -- must become 'other', never pass through.
    _leaky="$(_loki_known_blocker "/Users/someone/.nvm/versions/node/v18.1.0")"
    if [ "$_leaky" = "other" ]; then
        ok "an unrecognized path-shaped key is reduced to 'other' (no environment leak)"
    else
        bad "a path-shaped blocker key survived as '$_leaky'"
    fi
else
    bad "could not source telemetry.sh to check the enum"
fi

# --- 4. Diagnostics must never break the command they describe ----------------
# Every emit is backgrounded, output-suppressed and </dev/null, so a hung or
# missing telemetry path cannot stall or fail a user's build.
if grep -q 'loki_emit_first_run_blocked "no_provider" >/dev/null 2>&1 </dev/null &' "$REPO_ROOT/autonomy/provider-offer.sh"; then
    ok "the gate emit is backgrounded and cannot block the exit path"
else
    bad "the gate emit is not backgrounded -- telemetry could stall a refusal"
fi

if grep -q 'loki_emit_first_run_blocked "not_logged_in" >/dev/null 2>&1 </dev/null &' "$REPO_ROOT/autonomy/run.sh"; then
    ok "the auth emit is backgrounded and cannot block the exit path"
else
    bad "the auth emit is not backgrounded -- telemetry could stall a refusal"
fi

# Guarded by declare -f, so a build with telemetry.sh absent still runs.
if grep -q 'declare -f loki_emit_first_run_blocked' "$REPO_ROOT/autonomy/provider-offer.sh"; then
    ok "the emit is guarded, so an absent telemetry.sh cannot break the gate"
else
    bad "the emit is unguarded -- an absent telemetry.sh would error"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
