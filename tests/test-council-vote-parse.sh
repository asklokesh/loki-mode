#!/usr/bin/env bash
#
# test-council-vote-parse.sh -- regression tests for v7.41.3 council VOTE parsing
#
# Covers two verified bugs in autonomy/completion-council.sh:
#
#   BUG A (HIGH): the council subcalls used `| tail -20` before parsing. A
#   thorough reviewer that emits VOTE: then many ISSUES lines would have its own
#   VOTE: line truncated out of the captured window, so the parser found no VOTE
#   and a real APPROVE silently became a REJECT. Fixed by full capture (no tail).
#
#   BUG B (MED/HIGH): the VOTE regex was not word-bounded and not markdown
#   tolerant, so `VOTE: APPROVED`, `VOTE: APPROVE_WITH_CONCERNS`, `VOTE: APPROVE
#   pending` all extracted APPROVE (hedged read as clean approve) while
#   `**VOTE:** APPROVE` did not match at all (-> default REJECT). Fixed with a
#   word-bounded, markdown-tolerant matcher that prefers the conservative
#   outcome when ambiguous.
#
# The test sources the REAL `_council_parse_vote` from completion-council.sh so
# it cannot drift from production behavior. It also replicates the BUG A path by
# feeding a VOTE-at-top, 30-issue verdict through the same parser to prove the
# vote survives now that tail-truncation is gone.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

if [ ! -f "$COUNCIL_SH" ]; then
    echo "FAIL: cannot find $COUNCIL_SH"
    exit 1
fi

# Source the real parser. The council script only defines functions at load, so
# sourcing is side-effect free for our purpose. Suppress any banner output.
# shellcheck source=/dev/null
source "$COUNCIL_SH" >/dev/null 2>&1 || true

if ! type _council_parse_vote >/dev/null 2>&1; then
    echo "FAIL: _council_parse_vote not defined after sourcing $COUNCIL_SH"
    exit 1
fi

PASS=0
FAIL=0

# assert_parse <label> <input> <expected>
# expected of "" means: parser must return empty (unparseable/conservative)
assert_parse() {
    local label="$1" input="$2" expected="$3"
    local got
    got=$(_council_parse_vote "$input")
    if [ "$got" = "$expected" ]; then
        PASS=$((PASS + 1))
        printf 'PASS  %-50s -> [%s]\n' "$label" "$got"
    else
        FAIL=$((FAIL + 1))
        printf 'FAIL  %-50s -> got [%s] expected [%s]\n' "$label" "$got" "$expected"
    fi
}

echo "=== BUG B: word-boundary + markdown tolerance ==="
assert_parse "canonical VOTE: APPROVE"            "VOTE: APPROVE"                 "APPROVE"
assert_parse "no-space VOTE:APPROVE"              "VOTE:APPROVE"                  "APPROVE"
assert_parse "markdown-bold **VOTE:** APPROVE"    "**VOTE:** APPROVE"             "APPROVE"
assert_parse "markdown-bold **VOTE: APPROVE**"    "**VOTE: APPROVE**"            "APPROVE"
assert_parse "blockquote > VOTE: APPROVE"         "> VOTE: APPROVE"               "APPROVE"
# hedged / non-canonical tokens MUST NOT count as a clean APPROVE
assert_parse "APPROVED hedged (unparseable)"      "VOTE: APPROVED"                ""
assert_parse "APPROVE_WITH_CONCERNS (unparseable)" "VOTE: APPROVE_WITH_CONCERNS"  ""
# trailing prose after a space-bounded canonical token is still APPROVE
assert_parse "APPROVE pending (space-bounded)"    "VOTE: APPROVE pending"         "APPROVE"
assert_parse "REJECT"                             "VOTE: REJECT"                  "REJECT"
assert_parse "CANNOT_VALIDATE"                    "VOTE: CANNOT_VALIDATE"         "CANNOT_VALIDATE"
assert_parse "lowercase vote (unparseable)"       "vote: approve"                 ""
assert_parse "no VOTE line at all (unparseable)"  "REASON: looks good to me"      ""

echo
echo "=== BUG A: long issue list must NOT truncate the VOTE ==="
# Construct a realistic thorough-reviewer verdict: VOTE at the top, REASON, then
# 30 ISSUES lines. Under the old `| tail -20` the VOTE line would be cut off and
# the parser would default to REJECT. With full capture it must still be APPROVE.
build_long_verdict() {
    printf 'VOTE: APPROVE\n'
    printf 'REASON: All acceptance criteria met; the issues below are nitpicks.\n'
    local i
    for i in $(seq 1 30); do
        printf 'ISSUES: LOW:minor nitpick number %d that a thorough reviewer noted\n' "$i"
    done
}
LONG_VERDICT="$(build_long_verdict)"
LINE_COUNT=$(printf '%s\n' "$LONG_VERDICT" | wc -l | tr -d ' ')
echo "  (verdict has $LINE_COUNT lines; VOTE is on line 1, well outside a tail-20 window)"
assert_parse "long-issue-list, VOTE at top"       "$LONG_VERDICT"                 "APPROVE"

# Sanity: prove the OLD tail-20 behavior WOULD have dropped the vote, so the test
# is meaningful. (This asserts the bug existed, using the literal old pipeline.)
echo
echo "=== BUG A: demonstrate the old tail-20 path lost the vote ==="
OLD_TRUNCATED=$(printf '%s\n' "$LONG_VERDICT" | tail -20)
OLD_PATH_RESULT=$(_council_parse_vote "$OLD_TRUNCATED")
# tail -20 keeps only the last 20 lines (all ISSUES), so VOTE is gone -> empty
if [ -z "$OLD_PATH_RESULT" ]; then
    PASS=$((PASS + 1))
    echo "PASS  old tail-20 pipeline yields empty (would have defaulted to REJECT)"
else
    FAIL=$((FAIL + 1))
    echo "FAIL  old tail-20 pipeline unexpectedly yielded [$OLD_PATH_RESULT]"
fi

echo
echo "=== Contrarian (anti-sycophancy) conservative tie-break ==="
# Mirrors the live logic at the devil's-advocate site: ONLY a clean canonical
# APPROVE confirms the unanimous approval; anything else overrides to re-iterate.
contrarian_confirms() {
    # echoes "confirm" or "override"
    local cv
    cv=$(_council_parse_vote "$1")
    if [ "$cv" = "APPROVE" ]; then echo "confirm"; else echo "override"; fi
}
assert_contrarian() {
    local label="$1" input="$2" expected="$3"
    local got
    got=$(contrarian_confirms "$input")
    if [ "$got" = "$expected" ]; then
        PASS=$((PASS + 1))
        printf 'PASS  %-50s -> %s\n' "$label" "$got"
    else
        FAIL=$((FAIL + 1))
        printf 'FAIL  %-50s -> got %s expected %s\n' "$label" "$got" "$expected"
    fi
}
assert_contrarian "DA clean APPROVE confirms"        "VOTE: APPROVE"      "confirm"
assert_contrarian "DA REJECT overrides"              "VOTE: REJECT"       "override"
assert_contrarian "DA CANNOT_VALIDATE overrides"     "VOTE: CANNOT_VALIDATE" "override"
assert_contrarian "DA hedged APPROVED overrides"     "VOTE: APPROVED"     "override"
assert_contrarian "DA unparseable overrides"         "(model returned prose, no vote)" "override"

echo
echo "================================================================"
echo "RESULT: $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
    exit 1
fi
echo "ALL TESTS PASSED"
exit 0
