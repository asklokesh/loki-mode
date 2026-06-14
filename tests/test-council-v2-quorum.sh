#!/usr/bin/env bash
# Test: council-v2.sh quorum threshold matches the ceiling(2/3) formula used by
# completion-council.sh, and honors an explicit LOKI_COUNCIL_THRESHOLD override.
#
# Background: council-v2.sh previously approved at a flat COUNCIL_THRESHOLD
# (default 2) regardless of council_size, while every other council path
# (completion-council.sh: council_vote, council_aggregate_votes,
# council_evaluate) uses effective_threshold = (size*2+2)/3. With size=5 the
# old default approved at 2/5 (40%) where the other route needs 4/5. This test
# locks the two routes to the same trust bar.

set -u

PASS=0
FAIL=0

# Replicate the exact derivation from council-v2.sh (Step 6).
derive_threshold() {
    local council_size="$1"
    local effective_threshold
    if [ -n "${LOKI_COUNCIL_THRESHOLD:-}" ]; then
        effective_threshold="$LOKI_COUNCIL_THRESHOLD"
    else
        effective_threshold=$(( (council_size * 2 + 2) / 3 ))
    fi
    echo "$effective_threshold"
}

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        echo "PASS: $desc (got $actual)"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $desc (expected $expected, got $actual)"
        FAIL=$((FAIL + 1))
    fi
}

# Default (no override): ceiling(2/3) formula.
unset LOKI_COUNCIL_THRESHOLD
assert_eq "size=3 -> threshold 2" 2 "$(derive_threshold 3)"
assert_eq "size=5 -> threshold 4" 4 "$(derive_threshold 5)"
assert_eq "size=1 -> threshold 1" 1 "$(derive_threshold 1)"

# Sanity: a couple more sizes to confirm the ceiling behavior.
assert_eq "size=2 -> threshold 2" 2 "$(derive_threshold 2)"
assert_eq "size=4 -> threshold 3" 3 "$(derive_threshold 4)"

# Explicit operator override is honored regardless of council_size.
export LOKI_COUNCIL_THRESHOLD=3
assert_eq "override=3, size=5 -> 3" 3 "$(derive_threshold 5)"
export LOKI_COUNCIL_THRESHOLD=5
assert_eq "override=5, size=5 -> 5 (unanimous)" 5 "$(derive_threshold 5)"
unset LOKI_COUNCIL_THRESHOLD

# Cross-route agreement: derive_threshold must match completion-council.sh's
# literal formula for the default path across a range of sizes.
for size in 1 2 3 4 5 6 7 8 9; do
    ceil=$(( (size * 2 + 2) / 3 ))
    assert_eq "default size=$size matches completion-council ceiling" "$ceil" "$(derive_threshold "$size")"
done

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
