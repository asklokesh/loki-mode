#!/usr/bin/env bash
# Regression test for the contrarian transcript audit-trail bug (bug-hunter 2,
# finding 6). The transcript fields contrarian_triggered/contrarian_flipped were
# re-derived from approve_count AFTER the anti-sycophancy block had already
# decremented it on a flip, so on rounds where the devil's advocate (DA) fired
# AND flipped the verdict, both were mis-recorded as false/false.
#
# This test exercises the REAL council_vote function (extracted verbatim from
# completion-council.sh via awk brace-counting, same strategy as
# test-council-write-transcript-threshold.sh). All external dependencies are
# stubbed, and council_write_transcript is stubbed to CAPTURE the
# contrarian_triggered ($3) and contrarian_flipped ($4) it receives. We assert
# all three cases so the test discriminates real behavior, not a constant:
#   1. unanimous + DA flips        -> triggered=true,  flipped=true  (the bug)
#   2. unanimous + DA confirms     -> triggered=true,  flipped=false
#   3. not unanimous (no DA)       -> triggered=false, flipped=false
#
# We also assert the LIVE vote is unchanged (the flip still drops approve_count
# below threshold -> council_vote returns 1 / CONTINUE).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COUNCIL_SH="$REPO_ROOT/autonomy/completion-council.sh"

PASS=0
FAIL=0
pass() { echo "PASS: $*"; PASS=$(( PASS + 1 )); }
fail() { echo "FAIL: $*"; FAIL=$(( FAIL + 1 )); }

# ---------------------------------------------------------------------------
# Extract the real council_vote() using brace-depth counting. Line-end `/^}/`
# matching fails because the embedded python3 heredoc contains top-level `}`.
# ---------------------------------------------------------------------------
EXTRACTED_FUNC_FILE="$(mktemp /tmp/council_vote_func_XXXXXX)"

awk '
/^council_vote\(\)/ { found=1; depth=0 }
found {
    print
    for (i=1; i<=length($0); i++) {
        c = substr($0, i, 1)
        if (c == "{") depth++
        else if (c == "}") { depth--; if (depth == 0) { exit } }
    }
}
' "$COUNCIL_SH" > "$EXTRACTED_FUNC_FILE"

if [ ! -s "$EXTRACTED_FUNC_FILE" ]; then
    echo "FATAL: could not extract council_vote from $COUNCIL_SH"
    rm -f "$EXTRACTED_FUNC_FILE"
    exit 1
fi

cleanup_all() { rm -f "$EXTRACTED_FUNC_FILE"; }
trap cleanup_all EXIT

# ---------------------------------------------------------------------------
# run_case <member_vote> <da_verdict> <council_size>
#   Sources the real council_vote with stubbed deps. Prints three lines:
#     CAPTURED triggered=<v> flipped=<v>
#     RETURN <council_vote return code>
#   council_member_review returns <member_vote> for every member; the DA returns
#   <da_verdict>; council_write_transcript echoes the triggered/flipped args it
#   was actually called with.
# ---------------------------------------------------------------------------
run_case() {
    local member_vote="$1"
    local da_verdict="$2"
    local size="$3"
    local extracted="$EXTRACTED_FUNC_FILE"
    local tmpdir
    tmpdir="$(mktemp -d)"

    bash - << RUNNER_HEREDOC
set -uo pipefail
COUNCIL_STATE_DIR="${tmpdir}"
COUNCIL_PRD_PATH=""
COUNCIL_SIZE=${size}
COUNCIL_SEVERITY_THRESHOLD="low"
COUNCIL_ERROR_BUDGET="0.0"
ITERATION_COUNT=1
TARGET_DIR="${tmpdir}"

# Logging / telemetry no-ops
log_header() { :; }
log_info()   { :; }
log_warn()   { :; }
emit_event_json() { :; }

# Evidence + per-member review stubs
council_gather_evidence() { :; }
council_member_review() { echo "${member_vote}"; }

# DA verdict stub
council_devils_advocate() { echo "${da_verdict}"; }

# Parse stub: echo the verdict back verbatim. The real council_vote feeds it
# both member-review output and the DA verdict, so a pass-through faithfully
# routes each ("APPROVE" -> APPROVE, "REJECT" -> REJECT).
_council_parse_vote() { echo "\$1"; }

# Capture the transcript audit fields (\$3 = triggered, \$4 = flipped)
council_write_transcript() {
    echo "CAPTURED triggered=\$3 flipped=\$4"
}

# shellcheck disable=SC1090
source "${extracted}"

council_vote
echo "RETURN \$?"
RUNNER_HEREDOC

    rm -rf "$tmpdir"
}

assert_case() {
    local label="$1"; shift
    local member_vote="$1"; shift
    local da_verdict="$1"; shift
    local size="$1"; shift
    local exp_triggered="$1"; shift
    local exp_flipped="$1"; shift
    local exp_return="$1"; shift

    local out
    out="$(run_case "$member_vote" "$da_verdict" "$size")"

    local captured ret
    captured="$(echo "$out" | grep '^CAPTURED' | head -1)"
    ret="$(echo "$out" | grep '^RETURN' | head -1 | awk '{print $2}')"

    local got_trig got_flip
    got_trig="$(echo "$captured" | sed -E 's/.*triggered=([a-z]+).*/\1/')"
    got_flip="$(echo "$captured" | sed -E 's/.*flipped=([a-z]+).*/\1/')"

    if [ "$got_trig" = "$exp_triggered" ] && [ "$got_flip" = "$exp_flipped" ]; then
        pass "$label: triggered=$got_trig flipped=$got_flip"
    else
        fail "$label: triggered=$got_trig flipped=$got_flip (expected triggered=$exp_triggered flipped=$exp_flipped)"
    fi

    if [ "$ret" = "$exp_return" ]; then
        pass "$label: live vote return=$ret (unchanged)"
    else
        fail "$label: live vote return=$ret (expected $exp_return)"
    fi
}

# ---------------------------------------------------------------------------
# Case 1 (the regression): 3-member unanimous APPROVE, DA returns REJECT (flip).
# Pre-fix this recorded triggered=false/flipped=false. Post-fix: true/true.
# Live vote: approve drops 3 -> 2, threshold = ceil(2/3*3) = 2, 2 >= 2 still
# APPROVED, so return 0. (The flip removes the unanimous-only safety margin but
# a 3-member council still meets the 2-vote quorum -- this is the live decision
# and the fix must NOT change it.)
# ---------------------------------------------------------------------------
assert_case "unanimous + DA flips" "APPROVE" "REJECT" 3 "true" "true" 0

# ---------------------------------------------------------------------------
# Case 1b: 2-member unanimous APPROVE, DA returns REJECT (flip). threshold =
# ceil(2/3*2) = 2; approve drops 2 -> 1, 1 < 2 -> REJECTED, return 1. This is
# the case where the flip changes the live outcome; verify it still does.
# ---------------------------------------------------------------------------
assert_case "unanimous + DA flips (2-member, outcome flips)" "APPROVE" "REJECT" 2 "true" "true" 1

# ---------------------------------------------------------------------------
# Case 2: 3-member unanimous APPROVE, DA confirms APPROVE. triggered=true,
# flipped=false. approve stays 3 >= 2 -> return 0.
# ---------------------------------------------------------------------------
assert_case "unanimous + DA confirms" "APPROVE" "APPROVE" 3 "true" "false" 0

# ---------------------------------------------------------------------------
# Case 3: 3-member, all REJECT -> not unanimous -> DA never fires.
# triggered=false, flipped=false. approve=0 < 2 -> return 1.
# ---------------------------------------------------------------------------
assert_case "not unanimous (no DA)" "REJECT" "APPROVE" 3 "false" "false" 1

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
