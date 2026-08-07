#!/usr/bin/env bash
# An acceptance criterion must be citable, and its ID must be stable.
#
# WHY IDs AT ALL. Criteria were anonymous "- " bullets. A receipt could say
# "3 of 8 gates passed" but never "AC-PERSIST-001 is satisfied by this test at
# this line"; drift could not be tracked per criterion; and two runs of the same
# spec produced lists nothing could diff. The ID is what turns a criterion into
# a claim someone can check, which is the entire premise of shipping a receipt.
# Adopted from 8090's REQ-/AC- scheme (their requirements-writing-guide).
#
# TEST 2 IS THE LOAD-BEARING ONE. The ID must be derived from WHICH obligation
# fired, never from the criterion's position in the list. A positional counter
# looks identical on a single run and silently renumbers everything the moment a
# spec adds an earlier-matching keyword -- so a receipt citing AC-003 would point
# at a different criterion after an unrelated edit. That failure is invisible
# until someone tries to trust an old citation.
#
# TEST 4 covers the second intake path. A one-liner and a GitHub issue must use
# the SAME vocabulary, or "AC-AUTH-001" means two different things depending on
# how the work arrived.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
IP="$REPO_ROOT/autonomy/issue-providers.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: acceptance criteria carry stable, citable IDs"

[ -f "$LOKI" ] || { echo "  FAIL: $LOKI missing"; exit 1; }

# Runs the REAL function so this cannot drift from the implementation.
_ac_for() {
    bash -c 'source /dev/stdin <<< "$(sed -n "/^_brief_acceptance_criteria() {/,/^}/p" "$0")"; _brief_acceptance_criteria "$1"' \
        "$LOKI" "$1" 2>/dev/null
}

# --- 1. Every criterion carries an ID ---------------------------------------
_out="$(_ac_for "build a todo app with save and login and payments")"
_lines="$(printf '%s' "$_out" | grep -c '^- ' || true)"
_ided="$(printf '%s' "$_out" | grep -cE '^- AC-[A-Z]+-[0-9]{3}: ' || true)"
if [ "$_lines" -gt 0 ] && [ "$_lines" = "$_ided" ]; then
    ok "all $_lines criteria carry an AC-<AXIS>-NNN id"
else
    bad "$_ided of $_lines criteria have an id -- an anonymous criterion cannot be cited"
fi

# --- 2. THE LOAD-BEARING ONE: ids are content-derived, not positional --------
# Same axis must get the same id regardless of what else matched, and adding an
# earlier-matching criterion must not renumber a later one.
_ui_alone="$(_ac_for "a landing page for coffee" | grep -oE 'AC-[A-Z]+-[0-9]{3}' | head -1)"
_ui_with_others="$(_ac_for "build a todo app with save" | grep -oE 'AC-UI-[0-9]{3}' | head -1)"
if [ -n "$_ui_alone" ] && [ "$_ui_alone" = "$_ui_with_others" ]; then
    ok "the same axis keeps the same id when other criteria are present ($_ui_alone)"
else
    bad "ids shift with position ('$_ui_alone' vs '$_ui_with_others') -- an old citation would point at the wrong criterion"
fi

# And the reverse: a spec that matches MORE rules must not change the ids of the
# ones it shares with a smaller spec.
_small="$(_ac_for "stripe billing" | grep -oE 'AC-PAY-[0-9]{3}' | head -1)"
_large="$(_ac_for "stripe billing dashboard with login and an api" | grep -oE 'AC-PAY-[0-9]{3}' | head -1)"
if [ -n "$_small" ] && [ "$_small" = "$_large" ]; then
    ok "adding matching rules does not renumber an existing criterion"
else
    bad "PAY id changed from '$_small' to '$_large' when other rules matched"
fi

# --- 3. Ids are unique within one spec --------------------------------------
# A duplicate id is worse than none: a citation would be ambiguous.
_ids="$(_ac_for "todo app with save, login, api, stripe, search, dashboard, form" \
        | grep -oE 'AC-[A-Z]+-[0-9]{3}')"
_n="$(printf '%s\n' "$_ids" | grep -c . || true)"
_u="$(printf '%s\n' "$_ids" | sort -u | grep -c . || true)"
if [ "$_n" -gt 1 ] && [ "$_n" = "$_u" ]; then
    ok "all $_n ids in one spec are unique"
else
    bad "$_n ids but only $_u unique -- a citation would be ambiguous"
fi

# --- 4. The issue path uses the SAME vocabulary -----------------------------
# Two intake paths must not mint two meanings for AC-AUTH-001.
if [ -f "$IP" ]; then
    _issue='{"provider":"github","number":1,"title":"Fix login crash","body":"session expires on a protected route","labels":["bug"],"author":"x","url":"http://e/1","created_at":"2026-01-01"}'
    _iout="$(printf '%s' "$_issue" | bash -c "source '$IP' 2>/dev/null; generate_prd_from_issue" 2>/dev/null)"
    if printf '%s' "$_iout" | grep -qE '^- AC-[A-Z]+-[0-9]{3}: '; then
        ok "imported issues emit the same AC-<AXIS>-NNN shape"
    else
        bad "the issue path emits anonymous bullets -- only one intake is citable"
    fi
    # The shared axis must mean the same thing in both paths.
    if printf '%s' "$_iout" | grep -q 'AC-AUTH-'; then
        ok "a login issue yields AC-AUTH, the same axis a login brief yields"
    else
        bad "the issue path uses a different axis vocabulary than the brief path"
    fi
else
    bad "issue-providers.sh missing"
fi

# --- 5. Still deterministic: no model, no network ---------------------------
# The ids must not have introduced a provider call. This runs before a provider
# is selected and must work with no API key.
_body="$(sed -n '/^_brief_acceptance_criteria()/,/^}/p' "$LOKI" \
         | grep -vE '^\s*#' | grep -vE '^\s*_bac( [A-Z]+)? "')"
if printf '%s' "$_body" | grep -qiE "curl |claude |codex |aider |provider_invoke|python3 "; then
    bad "the id-emitting extractor shells out"
else
    ok "still pure bash: no model, no network"
fi

# --- 6. Syntax --------------------------------------------------------------
bash -n "$LOKI" 2>/dev/null && ok "autonomy/loki parses" || bad "autonomy/loki has a syntax error"
bash -n "$IP" 2>/dev/null && ok "issue-providers.sh parses" || bad "issue-providers.sh has a syntax error"

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
