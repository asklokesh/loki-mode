#!/usr/bin/env bash
# A one-liner must produce acceptance criteria about what was ASKED FOR.
#
# THE DEFECT. Every one-liner got byte-identical Requirements and Success
# Criteria. "build a todo app" and "build a stripe billing dashboard with user
# login" produced the same acceptance criteria, and the user's own words appeared
# exactly ONCE, under Overview. So the completion council, the checklist and the
# evidence gate were all checking generic prose instead of the request.
#
# That is the weakest input shape getting the least specific help, which is
# backwards. A cheap model's output quality depends far more on how precisely the
# target is stated than on the model, so the one-liner path -- the shape most
# likely to be under-specified, and the one a new user reaches first -- is where
# derived criteria matter most.
#
# DETERMINISTIC BY DESIGN, and test 4 pins that. No model call: this runs before
# a provider is selected, must work with no API key, and must not add latency or
# cost to the first thing a new user does. It is keyword-to-obligation mapping,
# honest about being shallow. Anything cleverer belongs in the spec-interrogation
# grill, which runs after this and does call a model.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: a one-liner yields criteria derived from what was asked"

[ -f "$LOKI" ] || { echo "  FAIL: $LOKI missing"; exit 1; }

# Source only the two functions under test; autonomy/loki is a 33k-line CLI and
# executing it would run its dispatcher.
_fn="$(sed -n '/^_brief_acceptance_criteria()/,/^}/p' "$LOKI")"
_syn="$(sed -n '/^synthesize_brief_prd()/,/^}/p' "$LOKI")"
eval "$_fn"
eval "$_syn"

# --- 1. THE LOAD-BEARING ONE: different requests, different criteria ---------
A="$(_brief_acceptance_criteria 'build a todo app')"
B="$(_brief_acceptance_criteria 'build a stripe billing dashboard with user login')"
if [ "$A" != "$B" ]; then
    ok "two different briefs produce different acceptance criteria"
else
    bad "both briefs produced identical criteria -- the constants problem is back"
fi

# --- 2. The criteria are ABOUT the request ----------------------------------
if printf '%s' "$B" | grep -qi "payment path is wired"; then
    ok "a stripe brief yields a payment obligation"
else
    bad "a stripe brief did not yield a payment obligation"
fi
if printf '%s' "$B" | grep -qi "401 when logged out"; then
    ok "a login brief yields a real auth obligation"
else
    bad "a login brief did not yield an auth obligation"
fi
if printf '%s' "$A" | grep -qi "survives a page reload"; then
    ok "a todo brief yields a persistence obligation"
else
    bad "a todo brief did not yield a persistence obligation"
fi
# And it must NOT invent obligations the brief never implied.
if printf '%s' "$A" | grep -qi "payment"; then
    bad "a todo brief invented a payment obligation it was never asked for"
else
    ok "criteria absent from the request are not invented"
fi

# --- 3. Each criterion is CHECKABLE, not a platitude ------------------------
# "works well" is unfalsifiable; "returns 401 when logged out" can be run. Every
# emitted line must contain something observable.
_unfalsifiable=0
while IFS= read -r line; do
    [ -z "$line" ] && continue
    printf '%s' "$line" | grep -qiE "reload|restart|401|curl|status code|test mode|real query|real data|real content|inline error|different results" \
        || _unfalsifiable=$((_unfalsifiable+1))
done <<< "$B"
if [ "$_unfalsifiable" -eq 0 ]; then
    ok "every emitted criterion names something observable"
else
    bad "$_unfalsifiable criterion(s) are unfalsifiable platitudes"
fi

# --- 4. No model is called ---------------------------------------------------
# This must work with no API key and add no latency to a new user's first run.
# Checks EXECUTED lines, not the criterion prose. A first version grepped the
# whole function and matched the word "curl" inside a criterion that literally
# says an endpoint should be "callable with curl" -- flagging correct code for
# quoting a tool name. The question is whether the extractor RUNS anything, so
# the emitted strings (_bac "...") are stripped before matching.
_body="$(sed -n '/^_brief_acceptance_criteria()/,/^}/p' "$LOKI" \
         | grep -vE '^\s*#' | grep -vE '^\s*_bac "')"
if printf '%s' "$_body" | grep -qiE "curl |claude |codex |aider |provider_invoke|python3 |\\\$\(.*http"; then
    bad "the extractor shells out -- it must be pure bash, no model, no network"
else
    ok "pure bash: no model, no network, works with no API key"
fi

# --- 5. It reaches the actual PRD -------------------------------------------
# The extractor being correct is worthless if the synthesized PRD does not carry
# its output.
T="$(mktemp -d)"
synthesize_brief_prd "$T/p.md" "build a stripe billing dashboard with user login"
if grep -qi "payment path is wired" "$T/p.md"; then
    ok "the derived criteria appear in the synthesized PRD"
else
    bad "the PRD does not carry the derived criteria"
fi
# The generic baseline must survive too -- derived criteria ADD to it.
if grep -q "happy path works end to end" "$T/p.md"; then
    ok "the baseline criteria are kept, not replaced"
else
    bad "the derived criteria replaced the baseline instead of adding to it"
fi
rm -rf "$T"

# --- 6. An unmatched brief still produces a valid PRD -----------------------
# Nothing may break when no keyword matches; the baseline alone is a valid spec.
T="$(mktemp -d)"
synthesize_brief_prd "$T/q.md" "zzz qqq xyzzy"
if [ -s "$T/q.md" ] && grep -q "## Success Criteria" "$T/q.md"; then
    ok "a brief matching no keyword still yields a well-formed PRD"
else
    bad "an unmatched brief produced a malformed or empty PRD"
fi
rm -rf "$T"

# --- 7. Both one-liner paths use it -----------------------------------------
# `loki quick` had the identical defect and must not be left behind.
if grep -q '_derived="$(_brief_acceptance_criteria "$task_desc")"' "$LOKI"; then
    ok "loki quick also derives criteria"
else
    bad "loki quick still emits generic constants"
fi

# --- 8. Syntax and house style ----------------------------------------------
if bash -n "$LOKI" 2>/dev/null; then
    ok "autonomy/loki parses"
else
    bad "autonomy/loki has a syntax error"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
