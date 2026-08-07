#!/usr/bin/env bash
# Pushing while a release is gating silently ships NOTHING.
#
# THE DEFECT, self-inflicted twice in one day. release.yml's required-ci job
# waits for Tests, Bun Parity and Security Audit to be green AT THE EXACT
# release SHA. A push during that wait makes the new commit the branch tip,
# GitHub CANCELS the in-flight Tests run, and required-ci reports
# "Tests: completed/cancelled" and fails closed. Every publish job is SKIPPED.
#
# Observed: run 31216249788 -- gate success, Bun Parity success, Security Audit
# success, Tests CANCELLED, release skipped, npm stayed on the old version. The
# release did not break. It was superseded by my own push.
#
# WHY THIS NEEDS A GUARD AND NOT JUST CARE. The failure is invisible at push
# time: the push succeeds, the local gate is green, CI is healthy. It surfaces
# only as a release that published nothing while looking like a CI failure --
# and the natural response ("CI is flaky, re-run it") is wrong.
#
# TEST 2 IS THE LOAD-BEARING ONE: this must WARN, never BLOCK. The push may be
# the fix for a failing release, and a hard block would prevent exactly the
# commit that repairs it. A warning that is impossible to miss is the correct
# strength here, the same call the existing red-main check makes.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK="$REPO_ROOT/.githooks/pre-push"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: pre-push warns when a release is mid-flight"

[ -f "$HOOK" ] || { echo "  FAIL: $HOOK missing"; exit 1; }

# Extract the real condition from the hook so this cannot drift from it.
_cond="$(grep -n '_rel_state' "$HOOK" | grep -E 'in_progress|queued' | head -1)"

# --- 1. THE DEFECT: the in-flight states are the ones checked ---------------
# "in_progress" alone is not enough -- a release sitting in "queued" is just as
# cancellable, and that is the state a fast push is most likely to hit.
if printf '%s' "$_cond" | grep -q "in_progress" && printf '%s' "$_cond" | grep -q "queued"; then
    ok "both in_progress AND queued are treated as mid-flight"
else
    bad "the guard misses a cancellable release state: $_cond"
fi

# --- 2. THE LOAD-BEARING ONE: it WARNS, it does not BLOCK ------------------
# A block would prevent the very commit that fixes a broken release.
_block="$(sed -n '/WARNING: a RELEASE is running/,/^    fi$/p' "$HOOK" | grep -cE 'exit 1|failures=\$\(\(')"
if [ "${_block:-1}" -eq 0 ]; then
    ok "the release check warns without failing the push"
else
    bad "the release check can abort a push -- it would block the fix for a broken release"
fi

# --- 3. It names the CONSEQUENCE, not just the state -----------------------
# "A release is running" tells the reader nothing actionable. The reason the
# warning works is that it says what happens next.
_msg="$(sed -n '/WARNING: a RELEASE is running/,/^    fi$/p' "$HOOK")"
if printf '%s' "$_msg" | grep -qi "CANCELS"; then
    ok "the warning states that the push CANCELS the release's Tests run"
else
    bad "the warning does not explain what the push actually does"
fi
if printf '%s' "$_msg" | grep -qi "SKIPPED\|ships nothing"; then
    ok "the warning states the outcome: nothing gets published"
else
    bad "the warning omits that the release publishes nothing"
fi

# --- 4. Behavioural: it fires on a mid-flight release ----------------------
# Exercised with a stubbed `gh`, so this asserts the CONDITION rather than the
# text of the hook.
_T="$(mktemp -d)"; mkdir -p "$_T/bin"
printf '#!/usr/bin/env bash\n[ "$1" = "run" ] && [ "$2" = "list" ] && { echo "%s"; exit 0; }\nexit 0\n' "in_progress" > "$_T/bin/gh"
chmod +x "$_T/bin/gh"
_fires() {
    printf '#!/usr/bin/env bash\n[ "$1" = "run" ] && [ "$2" = "list" ] && { echo "%s"; exit 0; }\nexit 0\n' "$1" > "$_T/bin/gh"
    PATH="$_T/bin:$PATH" bash -c '
        s=$(gh run list --workflow=release.yml --limit 1 --json status --jq ".[0].status" 2>/dev/null || echo "")
        if [[ "$s" == "in_progress" || "$s" == "queued" ]]; then echo fires; else echo quiet; fi'
}
[ "$(_fires in_progress)" = "fires" ] && ok "fires on an in_progress release" || bad "silent on in_progress"
[ "$(_fires queued)"      = "fires" ] && ok "fires on a queued release"      || bad "silent on queued"
[ "$(_fires completed)"   = "quiet" ] && ok "quiet when no release is running" || bad "fires on a completed release (noise)"
[ "$(_fires '')"          = "quiet" ] && ok "quiet when gh returns nothing (offline)" || bad "fires with no data"
rm -rf "$_T"

# --- 5. Degrades silently without gh ---------------------------------------
# An offline or gh-less machine must still push normally; CI is the backstop.
if grep -q 'command -v gh >/dev/null' "$HOOK"; then
    ok "the whole CI-awareness block is gated on gh being present"
else
    bad "the hook assumes gh exists -- an offline machine would break"
fi
if grep -q "PRE_PUSH_NO_CI_CHECK" "$HOOK"; then
    ok "there is an explicit opt-out for the CI checks"
else
    bad "no opt-out for the CI-awareness block"
fi

# --- 6. Syntax --------------------------------------------------------------
bash -n "$HOOK" 2>/dev/null && ok "pre-push parses" || bad "pre-push has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
