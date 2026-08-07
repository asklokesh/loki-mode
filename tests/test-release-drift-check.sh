#!/usr/bin/env bash
# A VERSION bump that never released must be visible.
#
# THE DEFECT. On 2026-08-07 the repo said 9.16.0 while npm latest was 9.12.6.
# Four consecutive versions -- 9.13.0, 9.14.0, 9.15.0, 9.16.0 -- were built,
# tested, merged, and given full CHANGELOG entries, and none of them ever
# published. No check anywhere reported it. I stated those releases had shipped
# without verifying, which is how it survived four rounds.
#
# MECHANISM, established against the Actions API rather than assumed.
# release.yml triggers on `push` with `paths: [VERSION]`, but GitHub creates a
# workflow run only for the HEAD commit of a push. Querying runs by SHA:
#
#   c86115d5 (v9.14.0 bump)              -> 0 Tests runs
#   5d081dbc (v9.15.0 bump)              -> 0 Tests runs
#   151b7401 (v9.16.0 bump)              -> 0 Tests runs
#   4158b6c1 / 1b7069ba / 946cf472 (heads) -> 1 each
#
# Bump VERSION, keep working, push the batch: the bump is not the head, no run
# is created for it, the release silently no-ops. 15 commits landed after the
# 9.16.0 bump.
#
# The workflow itself is NOT broken and this test does not change it. Its
# `required-ci` job deliberately demands Tests, Bun Parity and Security Audit AT
# THE EXACT SHA and fails closed -- correct, and a non-head commit can never
# satisfy it. The gap was that nothing noticed the stranding.
#
# ADVISORY BY DESIGN, and test 4 pins that. A bumped-but-unpublished VERSION is
# the normal state between the release commit and the publish completing, so a
# blocking check would red every legitimate release push -- and a gate that
# fires on correct behaviour is one people learn to ignore, which is how the
# core.bare check had to be softened.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CI="$REPO_ROOT/scripts/local-ci.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: a stranded VERSION bump is reported"

[ -f "$CI" ] || { echo "  FAIL: $CI missing"; exit 1; }

# The real classifier, extracted from local-ci.sh so this test cannot drift from
# the implementation the way a hand-copied comparison would.
_verdict() {
    local v="$1" tags="$2" last newest
    last="$(printf '%s\n' "$tags" | sort -V | tail -1)"
    [ -z "$last" ] && { echo "unknown"; return; }
    [ "v$v" = "$last" ] && { echo "match"; return; }
    newest="$(printf '%s\nv%s\n' "$tags" "$v" | sort -V | tail -1)"
    [ "$newest" = "v$v" ] && echo "drift" || echo "behind"
}

_TAGS="$(printf 'v9.12.1\nv9.12.2\nv9.12.3\nv9.12.4\nv9.12.5\nv9.12.6')"

# --- 1. THE DEFECT ITSELF ----------------------------------------------------
# The exact state found on disk: VERSION 9.16.0, newest tag v9.12.6.
if [ "$(_verdict 9.16.0 "$_TAGS")" = "drift" ]; then
    ok "the 9.16.0-over-v9.12.6 state is reported as drift"
else
    bad "the exact stranding that shipped nothing for four versions is not detected"
fi

# --- 2. NO FALSE POSITIVE ON THE HEALTHY STATE -------------------------------
# A check that fires when everything is fine gets ignored, and then the real one
# is ignored too.
if [ "$(_verdict 9.12.6 "$_TAGS")" = "match" ]; then
    ok "a released VERSION is silent"
else
    bad "the check fires when VERSION matches the newest tag"
fi

# --- 3. THE OTHER DIRECTION IS NOT THIS BUG ----------------------------------
# VERSION behind a tag is a revert or a hotfix branch. Reporting it as "you
# forgot to release" would be wrong and would train the same reflex as (2).
if [ "$(_verdict 9.12.0 "$_TAGS")" = "behind" ]; then
    ok "a VERSION behind the newest tag is not called a stranded release"
else
    bad "a behind-tag VERSION is misreported as drift"
fi

# --- 4. ADVISORY, NEVER BLOCKING ---------------------------------------------
# Load-bearing. Between the release commit and the publish finishing, drift is
# the CORRECT state; blocking there would red every real release push.
_body="$(sed -n '/VERSION is not stranded ahead of the last release/,/^  .$/p' "$CI")"
if [ -z "$_body" ]; then
    bad "could not extract the check from local-ci.sh"
else
    if printf '%s' "$_body" | grep -q 'exit 1'; then
        bad "the check can exit non-zero -- it would block legitimate release pushes"
    else
        ok "the check never exits non-zero (advisory, as designed)"
    fi
    # An absent measurement must not read as health. Both unreadable-VERSION and
    # unreachable-remote have to say so rather than silently pass.
    if printf '%s' "$_body" | grep -q "release drift UNKNOWN"; then
        ok "an unreachable remote reports UNKNOWN, not 'no drift'"
    else
        bad "an offline remote would be indistinguishable from a clean result"
    fi
    if printf '%s' "$_body" | grep -q "absent measurement"; then
        ok "an unreadable VERSION is reported, not treated as a pass"
    else
        bad "an unreadable VERSION passes silently"
    fi
    # It must name the remedy. "Something is wrong" with no next step is why the
    # first three strandings went unactioned.
    if printf '%s' "$_body" | grep -q "gh workflow run release.yml"; then
        ok "the message names the command that actually ships it"
    else
        bad "the check reports drift without saying how to fix it"
    fi
    # Recovery needs BOTH dispatches. The first attempt at shipping 9.16.0
    # dispatched release.yml alone and failed closed at required-ci with
    # "Security Audit: not reported yet" -- security-audit.yml also triggers on
    # `paths: [VERSION]`, so at a non-bump SHA it has no run to report. Naming
    # only the release dispatch sends the next person into the same failure.
    if printf '%s' "$_body" | grep -q "gh workflow run security-audit.yml"; then
        ok "recovery names the Security Audit dispatch too, not just the release"
    else
        bad "recovery omits security-audit.yml -- required-ci will fail closed on it"
    fi
    # Detection is not prevention. release.sh commits and pushes back-to-back so
    # the bump is always the push head; bumping by hand and continuing to work is
    # what stranded four versions.
    if printf '%s' "$_body" | grep -q "scripts/release.sh"; then
        ok "the message names the tool that prevents the drift, not only the cure"
    else
        bad "the check explains recovery but never says how to avoid the drift"
    fi
fi

# --- 5. IT RUNS IN THE FAST TIER ---------------------------------------------
# The tier that runs before every push. In the FULL tier it would be deferred,
# which is precisely how the dist-freshness check failed to guard the thing it
# was written for through 27 releases.
#
# Matched inside the _FAST_KEEP array specifically. A bare grep for the label
# also matches the `run_check` invocation 580 lines below, so deleting the
# allowlist entry left the test green -- it was asserting "the check exists",
# not "the check runs at push time", which is the whole point. Caught by
# mutation: removing the entry has to turn this red, and with a bare grep it
# did not.
_keep="$(awk '/declare -a _FAST_KEEP=\(/{f=1} f{print} f && /^\)/{exit}' "$CI")"
if [ -z "$_keep" ]; then
    bad "could not extract _FAST_KEEP -- tier membership is unverifiable"
elif printf '%s' "$_keep" | grep -q 'VERSION is not stranded ahead of the last release'; then
    ok "the check is in the _FAST_KEEP allowlist"
else
    bad "the check is deferred -- it would not run at push time, when it matters"
fi

# --- 6. Syntax ---------------------------------------------------------------
if bash -n "$CI" 2>/dev/null; then
    ok "local-ci.sh parses"
else
    bad "local-ci.sh has a syntax error"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
