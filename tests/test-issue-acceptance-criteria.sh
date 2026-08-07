#!/usr/bin/env bash
# An imported issue must yield criteria about what the ISSUE says.
#
# THE DEFECT. The four acceptance criteria generated for an imported issue were
# byte-identical for every issue ever imported. "add a retry to the payment
# client" and "fix a typo in the README" produced the same criteria, so the
# completion council and the evidence gate were checking boilerplate rather than
# the request. Same shape as the one-liner defect, in a different intake path.
#
# TEST 4 EXISTS BECAUSE OF A REGRESSION I CAUSED. generate_prd_from_issue reads
# the issue JSON FROM STDIN and runs `python3 -c "..."`. Converting that to a
# quoted heredoc (<<'PYEOF') to escape bash's quoting rules parses cleanly and
# BREAKS THE FUNCTION -- the heredoc occupies stdin, json.loads gets the empty
# string, and every import dies. That form is load-bearing, not legacy, and this
# test pins it so the tidy-up cannot be repeated silently.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IP="$REPO_ROOT/autonomy/issue-providers.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: an imported issue yields criteria derived from the issue"

[ -f "$IP" ] || { echo "  FAIL: $IP missing"; exit 1; }

_prd_for() {
    printf '%s' "$1" | bash -c "source '$IP' 2>/dev/null; generate_prd_from_issue" 2>/dev/null
}

_BUG='{"provider":"github","number":42,"title":"Fix login crash on expired session","body":"Users see a crash when the session expires and they hit a protected route.","labels":["bug"],"author":"x","url":"http://e/1","created_at":"2026-01-01"}'
_TYPO='{"provider":"github","number":7,"title":"Update README typo","body":"Fix spelling in the install section.","labels":[],"author":"x","url":"http://e/7","created_at":"2026-01-01"}'

A="$(_prd_for "$_BUG")"
B="$(_prd_for "$_TYPO")"

# --- 1. The function still WORKS ---------------------------------------------
# Asserted first: everything below is meaningless if the import is broken.
if printf '%s' "$A" | grep -q "^# PRD: Fix login crash"; then
    ok "generate_prd_from_issue still produces a PRD"
else
    bad "generate_prd_from_issue is broken -- it produced no PRD"
fi

# --- 2. THE LOAD-BEARING ONE: different issues, different criteria -----------
_ac_a="$(printf '%s' "$A" | sed -n '/## Acceptance Criteria/,/^---/p')"
_ac_b="$(printf '%s' "$B" | sed -n '/## Acceptance Criteria/,/^---/p')"
if [ "$_ac_a" != "$_ac_b" ]; then
    ok "two different issues produce different acceptance criteria"
else
    bad "both issues produced identical criteria -- the boilerplate problem is back"
fi

# --- 3. The criteria are ABOUT the issue -------------------------------------
if printf '%s' "$A" | grep -qi "401/403"; then
    ok "a login issue yields an auth denied-case obligation"
else
    bad "a login issue did not yield an auth obligation"
fi
if printf '%s' "$A" | grep -qi "FAILS before the fix"; then
    ok "a bug report yields a reproduce-first obligation"
else
    bad "a bug report did not yield a reproduce-first obligation"
fi
# And it must not invent obligations the issue never implied.
if printf '%s' "$B" | grep -qi "payment path"; then
    bad "a typo issue invented a payment obligation"
else
    ok "criteria absent from the issue are not invented"
fi
# The generic four must survive; derived criteria ADD to them.
if printf '%s' "$B" | grep -q "Ensure backward compatibility"; then
    ok "the baseline criteria are kept, not replaced"
else
    bad "the derived criteria replaced the baseline instead of adding to it"
fi

# --- 4. THE REGRESSION GUARD: stdin must stay free --------------------------
# `python3 -c` keeps stdin available for the issue JSON. A heredoc would consume
# it. Verified the hard way: the heredoc version parses and then fails on every
# real import.
if grep -q 'python3 -c "' "$IP"; then
    ok "the PRD generator uses python3 -c, leaving stdin free for the issue JSON"
else
    bad "the generator no longer uses python3 -c -- if it is a heredoc, stdin is consumed and every import dies"
fi
# Behavioural twin of the above: prove stdin actually reaches the parser.
if printf '%s' "$_TYPO" | bash -c "source '$IP' 2>/dev/null; generate_prd_from_issue" 2>&1 | grep -q "README typo"; then
    ok "the issue JSON reaches the parser through stdin"
else
    bad "stdin is not reaching the parser"
fi

# --- 5. No model is called ---------------------------------------------------
# This runs at import time, before a provider is selected.
_seg="$(sed -n '/_ac_rules = \[/,/derived_ac = /p' "$IP")"
if printf '%s' "$_seg" | grep -qiE "requests|urllib|subprocess|openai|anthropic"; then
    bad "the derivation reaches for the network or a model"
else
    ok "pure python: no model, no network"
fi

# --- 6. Syntax and house style ----------------------------------------------
if bash -n "$IP" 2>/dev/null; then
    ok "issue-providers.sh parses"
else
    bad "issue-providers.sh has a syntax error"
fi
if ! grep -qP '[\x{1F300}-\x{1FAFF}\x{2014}\x{2013}]' "$IP" 2>/dev/null; then
    ok "no emoji and no em-dash"
else
    bad "emoji or em-dash present"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
