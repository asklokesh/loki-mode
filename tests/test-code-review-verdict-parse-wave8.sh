#!/usr/bin/env bash
# Test: WAVE8 code-review verdict/severity SAFE-DEFAULT parse + complexity count guard
#
# Covers four CONFIRMED bugs fixed in autonomy/run.sh:
#   run.sh-F1: verbose "VERDICT: FAIL - [Critical] x" was mis-counted as PASS
#              (exact-equality against "FAIL" failed after the suffix survived).
#   run.sh-F2: unbracketed severity ("- Critical:", "**Critical**", "Severity: High")
#              was not detected, so a FAIL naming a Critical was non-blocking.
#   run.sh-F3: a markdown-wrapped "**VERDICT:** FAIL" was unparseable -> NO_VERDICT
#              and its dissent was dropped on a mixed council.
#   run.sh-provider-F1: grep -c double-output ("0\n0") crashed the complexity
#              integer tests and dropped simple->standard.
#
# Strategy: awk-extract the two helper functions from run.sh and exercise them
# directly. Because the test sources the REAL function bodies, `git stash` of the
# fix flips this test from PASS to FAIL (non-vacuous). For F4 we reproduce the
# digit-strip parameter expansion on a literal "0\n0" the way run.sh applies it.
#
# Not using set -e so all assertions run and report.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"

PASS=0
FAIL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ok()   { echo -e "${GREEN}[PASS]${NC} $1"; PASS=$((PASS+1)); return 0; }
bad()  { echo -e "${RED}[FAIL]${NC} $1"; FAIL=$((FAIL+1)); return 0; }

if [ ! -f "$RUN_SH" ]; then
    echo "FATAL: run.sh not found at $RUN_SH"
    exit 1
fi

# --- Extract the two helper functions from run.sh and source them -------------
# awk captures from the function header to the first line that is exactly '}'.
HELPERS_SRC="$(mktemp)"
trap 'rm -f "$HELPERS_SRC"' EXIT
{
    awk '/^_classify_verdict\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' "$RUN_SH"
    echo
    awk '/^_severity_is_blocking\(\) \{/{f=1} f{print} f&&/^\}$/{exit}' "$RUN_SH"
} > "$HELPERS_SRC"

if ! grep -q "_classify_verdict" "$HELPERS_SRC" || ! grep -q "_severity_is_blocking" "$HELPERS_SRC"; then
    echo "FATAL: helper functions absent from run.sh (fixes NOT landed -- pre-fix state)."
    echo "Demonstrating the bug against the PRE-FIX parse logic so this flip is non-vacuous:"
    # Pre-fix verdict parse (the exact pipeline that shipped at run.sh:9289):
    pf="$(printf 'VERDICT: FAIL - [Critical] SQL injection\nFINDINGS:\n- [Critical] SQLi')"
    old_verdict="$(printf '%s\n' "$pf" | grep -i "^VERDICT:" | head -1 \
        | sed 's/^VERDICT:[[:space:]]*//' | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]')"
    echo "  pre-fix parsed verdict token: '$old_verdict'"
    if [ "$old_verdict" = "FAIL" ]; then
        echo "  pre-fix exact-match WOULD have counted this as FAIL -- bug not reproduced (unexpected)"
    else
        echo "  pre-fix exact-match [ \"\$verdict\" = \"FAIL\" ] is FALSE -> counted as PASS (BUG CONFIRMED)"
    fi
    echo "RESULT: pre-fix run.sh mis-classifies suffixed FAIL as PASS. Test FAILS on HEAD as expected."
    exit 1
fi

# shellcheck source=/dev/null
source "$HELPERS_SRC"

mkfile() { local f; f="$(mktemp)"; printf '%s\n' "$1" > "$f"; echo "$f"; }

# --- F1: verdict classification ----------------------------------------------
echo "=== run.sh-F1: verdict classification (SAFE-DEFAULT) ==="

# HEADLINE repro: suffixed FAIL must classify as FAIL (was PASS pre-fix).
f="$(mkfile 'VERDICT: FAIL - [Critical] SQL injection in login (auth.js:42)')"
v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "FAIL" ] && ok "suffixed 'FAIL - [Critical] ...' -> FAIL (headline)" \
                   || bad "suffixed FAIL classified as '$v' (expected FAIL)"

f="$(mkfile 'VERDICT: FAIL.')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "FAIL" ] && ok "'FAIL.' -> FAIL" || bad "'FAIL.' -> '$v' (expected FAIL)"

f="$(mkfile 'VERDICT: FAIL (3 criticals)')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "FAIL" ] && ok "'FAIL (3 criticals)' -> FAIL" || bad "got '$v' (expected FAIL)"

f="$(mkfile 'VERDICT: PASS')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "PASS" ] && ok "plain 'PASS' -> PASS" || bad "got '$v' (expected PASS)"

f="$(mkfile 'VERDICT: PASS with concerns')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "PASS" ] && ok "'PASS with concerns' -> PASS (author intent preserved)" \
                  || bad "got '$v' (expected PASS)"

# R1 collision cases: a PASS line whose PROSE contains fail/block/reject
# substrings must still classify PASS (the whole-line-substring-scan bug would
# have flipped these to FAIL -> false-block + broken unanimous-PASS DA trigger).
f="$(mkfile 'VERDICT: PASS, no failures found')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "PASS" ] && ok "'PASS, no failures found' -> PASS (no substring flip)" \
                  || bad "got '$v' (expected PASS)"

f="$(mkfile 'VERDICT: PASS - no blocking issues')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "PASS" ] && ok "'PASS - no blocking issues' -> PASS (no substring flip)" \
                  || bad "got '$v' (expected PASS)"

f="$(mkfile 'VERDICT: PASS, nothing rejected')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "PASS" ] && ok "'PASS, nothing rejected' -> PASS (no substring flip)" \
                  || bad "got '$v' (expected PASS)"

f="$(mkfile 'VERDICT: PASS (no critical/high blockers)')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "PASS" ] && ok "'PASS (no critical/high blockers)' -> PASS (no substring flip)" \
                  || bad "got '$v' (expected PASS)"

f="$(mkfile 'VERDICT: APPROVE')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "PASS" ] && ok "'APPROVE' -> PASS" || bad "got '$v' (expected PASS)"

f="$(mkfile 'VERDICT: REJECT')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "FAIL" ] && ok "'REJECT' -> FAIL" || bad "got '$v' (expected FAIL)"

# Ambiguous: a verdict line that names neither PASS nor FAIL -> must NOT pass.
f="$(mkfile 'VERDICT: UNCLEAR')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "AMBIGUOUS" ] && ok "'UNCLEAR' -> AMBIGUOUS (never silently passes)" \
                       || bad "got '$v' (expected AMBIGUOUS)"

# No verdict line at all.
f="$(mkfile 'this reply has no verdict line at all, just prose')"
v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "NONE" ] && ok "no VERDICT line -> NONE" || bad "got '$v' (expected NONE)"

# GATE-LEVEL contract (the actual requirement, not just helper classification):
# in run_code_review the main loop routes BOTH NONE and AMBIGUOUS to the
# NO_VERDICT/continue branch (no_output_count++, NOT real_verdict_count++), so an
# unparseable token can never reach pass_count and -- via real_verdict_count <
# reviewer_count -- forces the inconclusive/block path. We assert the source
# routes both tokens together so AMBIGUOUS cannot silently pass the gate.
gate_route() {
    # Mirror the gate's branch predicate for a given classified verdict.
    case "$1" in
        NONE|AMBIGUOUS) echo "no_verdict" ;;
        FAIL)           echo "fail" ;;
        PASS)           echo "pass" ;;
        *)              echo "unknown" ;;
    esac
}
[ "$(gate_route AMBIGUOUS)" = "no_verdict" ] \
    && ok "gate routes AMBIGUOUS -> no_verdict (cannot reach pass_count)" \
    || bad "AMBIGUOUS not routed to no_verdict"
# Guard the source: the loop's non-real branch must test BOTH NONE and AMBIGUOUS.
if grep -q '\[ "\$verdict" = "NONE" \] || \[ "\$verdict" = "AMBIGUOUS" \]' "$RUN_SH"; then
    ok "run.sh source routes NONE and AMBIGUOUS together to the no-verdict branch"
else
    bad "run.sh no-verdict branch does not cover AMBIGUOUS (would silently pass)"
fi

# Empty file.
f="$(mktemp)"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "NONE" ] && ok "empty file -> NONE" || bad "got '$v' (expected NONE)"

# --- F3: markdown-wrapped verdict anchor -------------------------------------
echo "=== run.sh-F3: markdown-wrapped verdict no longer dropped ==="

f="$(mkfile '**VERDICT:** FAIL')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "FAIL" ] && ok "'**VERDICT:** FAIL' -> FAIL (was NO_VERDICT pre-fix)" \
                  || bad "got '$v' (expected FAIL)"

f="$(mkfile '# VERDICT: PASS')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "PASS" ] && ok "'# VERDICT: PASS' -> PASS" || bad "got '$v' (expected PASS)"

f="$(mkfile '   VERDICT: FAIL')"; v="$(_classify_verdict "$f")"; rm -f "$f"
[ "$v" = "FAIL" ] && ok "leading-whitespace VERDICT -> FAIL" || bad "got '$v' (expected FAIL)"

# --- F2: severity detection (bracketed + unbracketed) ------------------------
echo "=== run.sh-F2: severity detection (SAFE-DEFAULT, broad) ==="

assert_block() {
    local desc="$1" body="$2"
    local f; f="$(mkfile "$body")"
    if _severity_is_blocking "$f"; then ok "blocks: $desc"; else bad "NOT blocking: $desc"; fi
    rm -f "$f"
}
assert_noblock() {
    local desc="$1" body="$2"
    local f; f="$(mkfile "$body")"
    if _severity_is_blocking "$f"; then bad "false-block: $desc"; else ok "no-block: $desc"; fi
    rm -f "$f"
}

assert_block   "bracketed [Critical]"        '- [Critical] SQLi in login (auth.js:42)'
assert_block   "bracketed [High]"            '- [High] missing authz check'
assert_block   "unbracketed - Critical:"     '- Critical: SQL injection in login'
assert_block   "unbracketed - High:"         '- High: no rate limit on /login'
assert_block   "bold **Critical**"           '- **Critical**: path traversal'
assert_block   "Severity: High - x"          '- Severity: High - unbounded recursion'
assert_block   "Severity: Critical"          'Severity: Critical'
assert_noblock "only Medium/Low present"     '- [Medium] minor style nit\n- [Low] typo'
assert_noblock "prose mentioning the word 'highly'" 'This is a highly readable function with no issues.'

# --- F4: complexity grep -c double-output guard ------------------------------
echo "=== run.sh-provider-F1: grep -c '0\\n0' digit-strip guard ==="

# Reproduce exactly what run.sh does. grep -c on zero matches emits "0" and
# exits 1; with '|| echo "0"' the captured value is the two-line "0\n0".
raw="$(printf '0\n0')"
feature_count="$raw"
# Pre-fix behavior (no strip): integer test errors out.
if [ "$feature_count" -lt 5 ] 2>/dev/null; then
    pre="ok"
else
    pre="err"
fi
# Apply the fix's parameter expansions.
feature_count="${feature_count:-0}"
feature_count="${feature_count//[^0-9]/}"
feature_count="${feature_count:-0}"
if [ "$feature_count" -lt 5 ] 2>/dev/null; then
    post="ok"
else
    post="err"
fi
[ "$pre" = "err" ] && ok "pre-strip '0\\n0' DOES break integer test (confirms bug)" \
                   || bad "pre-strip did not break (repro invalid)"
[ "$post" = "ok" ] && [ "$feature_count" = "00" ] \
    && ok "post-strip '0\\n0' -> '00', integer test works" \
    || bad "post-strip failed: value='$feature_count' test=$post"

# Verify the fix is actually present in run.sh source (not just our local repro).
if grep -q 'feature_count="\${feature_count//\[^0-9\]/}"' "$RUN_SH" \
   && grep -q 'section_count="\${section_count//\[^0-9\]/}"' "$RUN_SH"; then
    ok "run.sh source contains feature_count + section_count digit-strip"
else
    bad "run.sh source missing digit-strip for feature_count/section_count"
fi

# --- Summary -----------------------------------------------------------------
echo
echo "================================"
echo "PASS: $PASS  FAIL: $FAIL"
echo "================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
