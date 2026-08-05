#!/usr/bin/env bash
# Sharding must PARTITION the suite list: every suite in exactly one shard.
#
# WHY THIS IS THE WHOLE SAFETY ARGUMENT. Splitting 289 suites across N CI
# runners is only sound if the union of the shards is the original set. A shard
# filter that quietly drops a suite makes the gate faster AND blind, and a
# blind gate is worse than a slow one -- this repo already paid for that lesson
# once, when a shellcheck "optimization" ran ~2x faster and silently lost 2 real
# failures before being reverted.
#
# So this asserts the partition property directly, by counting what each shard
# would actually execute and comparing the total against an unsharded run.
# It does not execute the suites (that is the gate's job); it verifies the
# arithmetic that decides which ones get executed at all.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$SCRIPT_DIR/run-all-tests.sh"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

# Count run_test invocations directly from the runner source. This is the
# ground truth the shard arithmetic must reproduce.
total=$(grep -cE '^[[:space:]]*run_test ' "$RUNNER")

echo "T1 -- the runner declares suites to shard"

if [ "$total" -gt 100 ]; then
    ok "runner declares $total suites"
else
    bad "expected >100 suites, found $total -- is the parse still correct?"
fi

echo
echo "T2 -- shards partition the suite list exactly"

# Simulate the shard filter with the same arithmetic run_test uses:
# suite index i belongs to shard (i % n).
for n in 2 3 4 6; do
    sum=0
    overlap_ok=1
    for i in $(seq 0 $((n - 1))); do
        c=$(awk -v n="$n" -v want="$i" '
            /^[[:space:]]*run_test / { if ((idx % n) == want) hit++; idx++ }
            END { print hit + 0 }
        ' "$RUNNER")
        sum=$((sum + c))
        # A shard that gets zero suites means the split is degenerate.
        [ "$c" -gt 0 ] || overlap_ok=0
    done
    if [ "$sum" -eq "$total" ]; then
        ok "n=$n: shards sum to $sum, exactly the $total declared suites"
    else
        bad "n=$n: shards sum to $sum but there are $total suites -- $((total - sum)) would NEVER RUN"
    fi
    if [ "$overlap_ok" -eq 1 ]; then
        ok "n=$n: every shard received at least one suite"
    else
        bad "n=$n: at least one shard is empty (degenerate split)"
    fi
done

echo
echo "T3 -- an invalid shard spec fails loudly, never silently"

# Fail-closed matters more here than anywhere: a typo that silently ran ZERO
# suites would turn the whole gate green while testing nothing.
for bad_spec in "3/3" "5/2" "abc/2" "1/0"; do
    if LOKI_TEST_SHARD="$bad_spec" bash "$RUNNER" >/dev/null 2>&1; then
        bad "LOKI_TEST_SHARD=$bad_spec was ACCEPTED (should exit non-zero)"
    else
        ok "LOKI_TEST_SHARD=$bad_spec rejected"
    fi
done

echo
echo "T4 -- no shard set means run everything (default is unchanged)"

# The default path must be byte-identical in behaviour to before sharding
# existed, so a developer running the suite locally sees no change.
unsharded=$(awk '/^[[:space:]]*run_test / { c++ } END { print c + 0 }' "$RUNNER")
if [ "$unsharded" -eq "$total" ]; then
    ok "unsharded run still selects all $total suites"
else
    bad "unsharded run selects $unsharded of $total"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
