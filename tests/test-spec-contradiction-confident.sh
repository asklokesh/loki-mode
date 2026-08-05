#!/usr/bin/env bash
# test-spec-contradiction-confident.sh -- the confidence gate that stops a FLAKY
# single-LLM-sample spec-contradiction verdict from tripping the no-retry
# terminal exit (run.sh:16914 `return 20`). Evidence: the v8 benchmark showed the
# SAME spec judged contradictory ~1/3 of runs; a lone flaky sample must NOT
# terminal-fail an entire run.
#
# We extract spec_contradiction_confident and drive it with a stubbed
# re-sample sequence (spec_interrogation_run is a no-op; the count function is
# stubbed to a scripted series), so the test is hermetic -- no provider, no LLM.
#
# No emojis. No em dashes.

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SPEC="$SCRIPT_DIR/../autonomy/spec-interrogation.sh"
PASS=0
FAIL=0
fail() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }
ok() { PASS=$((PASS + 1)); }
[ -f "$SPEC" ] || { echo "FATAL: spec-interrogation.sh not found"; exit 2; }

# Extract just spec_contradiction_confident (def to its closing brace at col 0).
FN="$(awk '/^spec_contradiction_confident\(\) \{/{f=1} f{print} f&&/^}/{exit}' "$SPEC")"
[ -n "$FN" ] || { echo "FATAL: could not extract spec_contradiction_confident"; exit 2; }

# Drive the function with a scripted count sequence. $COUNTS is a space-separated
# list of the values spec_ledger_contradiction_unresolved_count returns on each
# successive call (the re-samples). spec_interrogation_run is a no-op stub.
run_confident() {
    # $1 = MIN_SAMPLES, $2 = space-separated count sequence for re-samples.
    # The count stub reads its call index from a FILE (a pipe like `| head -1` in
    # the function under test runs the count in a subshell, so an in-memory
    # counter would reset each call -- a file-backed index survives that).
    local min="$1" counts="$2"
    local idxf; idxf="$(mktemp)"; echo 0 > "$idxf"
    bash -c '
        set -u
        LOKI_SPEC_CONTRADICTION_MIN_SAMPLES="'"$min"'"
        spec_interrogation_run() { :; }   # no-op: no real grill
        _CQ="'"$counts"'"
        _IDXF="'"$idxf"'"
        spec_ledger_contradiction_unresolved_count() {
            local i; i="$(cat "$_IDXF")"; i=$((i + 1)); echo "$i" > "$_IDXF"
            printf "%s\n" "$(printf "%s\n" $_CQ | sed -n "${i}p")"
        }
        '"$FN"'
        if spec_contradiction_confident "/tmp/spec.md"; then echo CONFIDENT; else echo FLAKY; fi
    '
    rm -f "$idxf"
}

# 1. MIN_SAMPLES=1 -> legacy: confident immediately, no re-sampling.
[ "$(run_confident 1 "9 9 9")" = "CONFIDENT" ] && ok || fail "min=1 must be confident immediately (legacy behavior)"

# 2. MIN_SAMPLES=2, re-sample STILL sees the contradiction (count=1) -> confident (real).
[ "$(run_confident 2 "1")" = "CONFIDENT" ] && ok || fail "min=2, reproduced contradiction -> confident"

# 3. MIN_SAMPLES=2, re-sample does NOT see it (count=0) -> FLAKY (the bug we fix).
[ "$(run_confident 2 "0")" = "FLAKY" ] && ok || fail "min=2, non-reproduced -> FLAKY (must not terminal-fail)"

# 4. MIN_SAMPLES=3, needs 2 agreeing re-samples: [1, 0] -> the 2nd disagrees -> FLAKY.
[ "$(run_confident 3 "1 0")" = "FLAKY" ] && ok || fail "min=3, second re-sample disagrees -> FLAKY"

# 5. MIN_SAMPLES=3, both re-samples agree [1, 1] -> confident.
[ "$(run_confident 3 "1 1")" = "CONFIDENT" ] && ok || fail "min=3, both re-samples agree -> confident"

# 6. Fail-closed: an unparseable/empty count on a re-sample is treated as <1 -> FLAKY
#    (we never fabricate a clear, but an empty re-sample means "did not see it").
[ "$(run_confident 2 "")" = "FLAKY" ] && ok || fail "min=2, empty re-sample count -> FLAKY (not a fabricated clear)"

echo ""
echo "test-spec-contradiction-confident: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
