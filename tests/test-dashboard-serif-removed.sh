#!/usr/bin/env bash
# The product chrome runs sans, and this check cannot produce a false green.
#
# THE DESIGN CHANGE. Loki's dashboard rendered headings in Fraunces, a serif
# display face. Linear, Vercel, Sentry and Ona all run sans, dense type in
# product chrome; a serif reads editorial, not operational. The token layer for
# this already existed -- loki-unified-styles.js emits --loki-font-serif and
# --loki-font-family -- and 8 sites bypassed it by hardcoding the family.
#
# THE MEASUREMENT TRAP IS THE REAL SUBJECT OF THIS TEST.
#
# dashboard/static/index.html has lines over 577 chars, so grep treats it as
# BINARY and suppresses output. Measured on the pre-fix artifact:
#
#     grep -c  "Fraunces" dashboard/static/index.html   ->   (empty)
#     grep -ac "Fraunces" dashboard/static/index.html   ->   11
#
# A gate written the obvious way reports "0 occurrences" for a file containing
# 11 and passes forever. Worse, it passes IDENTICALLY whether the file is clean,
# dirty, or missing -- there is no state in which it fails.
#
# So every assertion here uses grep -a AND carries a POSITIVE CONTROL: a string
# that MUST be present. If the control comes back absent, the measurement itself
# is broken and the suite fails rather than reporting a clean result. An absent
# measurement is not evidence of absence.
#
# ASSERTED AGAINST THE SHIPPED ARTIFACT, not the sources. dashboard/static/ is
# what `loki web` serves and what npm/Docker users load; a source-only check
# would pass while the served page still shipped the serif.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SHIPPED="$REPO_ROOT/dashboard/static/index.html"
UI="$REPO_ROOT/dashboard-ui"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: product chrome runs sans, measured without a false green"

[ -f "$SHIPPED" ] || { echo "  FAIL: $SHIPPED missing"; exit 1; }

_acount() { grep -ac "$1" "$2" 2>/dev/null || echo 0; }

# --- 1. THE POSITIVE CONTROL, first ------------------------------------------
# Everything below is meaningless if grep cannot read this file. Inter is the
# sans family the chrome now uses; it MUST be present in the shipped bundle.
_control="$(_acount "Inter" "$SHIPPED")"
if [ "${_control:-0}" -gt 10 ]; then
    ok "measurement works: the control string is found $_control times"
else
    bad "CONTROL FAILED (found $_control) -- grep cannot read this artifact, so every result below is meaningless"
    echo ""
    echo "  Passed: $PASS   Failed: $FAIL"
    exit 1
fi

# --- 2. Prove the trap is real, so nobody 'simplifies' the -a away -----------
# Without -a, grep suppresses output on this file. If a future edit drops the
# -a, this assertion is what explains why the suite went quiet.
_naive="$(grep -c "Inter" "$SHIPPED" 2>/dev/null || true)"
if [ -z "$_naive" ] || [ "${_naive:-0}" = "0" ]; then
    ok "grep WITHOUT -a reports '${_naive:-empty}' for a string present $_control times (the trap is real)"
else
    ok "grep without -a happens to work here ($_naive); -a is still required for safety"
fi

# --- 3. THE CHANGE: no serif family in the shipped chrome -------------------
# One occurrence is expected and correct: the retained TYPOGRAPHY token
# definition, kept for marketing surfaces and deliberately unused in chrome.
_fraunces="$(_acount "Fraunces" "$SHIPPED")"
if [ "${_fraunces:-9}" -le 1 ]; then
    ok "the shipped bundle carries at most the retained token definition ($_fraunces)"
else
    bad "$_fraunces Fraunces references in the shipped bundle -- the serif is still in product chrome"
fi

# --- 4. The font is no longer DOWNLOADED -------------------------------------
# A render-blocking request for a face nothing uses costs every user a round
# trip. Removing the declarations but keeping the <link> would look fixed and
# still pay the cost.
if grep -ao "fonts.googleapis.com[^\"']*" "$SHIPPED" 2>/dev/null | grep -qa "Fraunces"; then
    bad "the Google Fonts request still downloads Fraunces"
else
    ok "Fraunces is no longer requested from Google Fonts"
fi

# --- 5. Source parity: components must not re-introduce it ------------------
# The shipped artifact is generated. If a component still hardcodes the family,
# the next build reintroduces it.
_src_hits="$(grep -rln "Fraunces" "$UI" --include='*.js' --include='*.html' 2>/dev/null \
             | grep -v node_modules | grep -v '/dist/' | grep -v 'loki-unified-styles.js' | wc -l | tr -d ' ')"
if [ "${_src_hits:-1}" -eq 0 ]; then
    ok "no component or page source hardcodes the serif family"
else
    bad "$_src_hits source file(s) still hardcode Fraunces -- the next build undoes this"
    grep -rln "Fraunces" "$UI" --include='*.js' --include='*.html' 2>/dev/null \
        | grep -v node_modules | grep -v '/dist/' | grep -v 'loki-unified-styles.js' | sed 's/^/         /'
fi

# --- 6. The token layer is intact, not deleted ------------------------------
# The fix is "stop bypassing the token", not "delete the token". Marketing
# surfaces still need it, and removing it would break --loki-font-serif.
if grep -aq "loki-font-serif" "$SHIPPED"; then
    ok "the serif TOKEN survives for marketing surfaces"
else
    bad "--loki-font-serif was removed entirely -- marketing surfaces lose their face"
fi

# --- 7. Nav intact: the right artifact was built -----------------------------
# Guards a build that succeeds and emits the wrong bundle. That happened once
# here (running build-standalone alone instead of build:all).
_nav="$(_acount "Spec Checklist" "$SHIPPED")"
if [ "${_nav:-0}" -ge 1 ]; then
    ok "the shipped bundle still contains its navigation"
else
    bad "navigation is missing -- the wrong artifact was built"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
