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
echo "T2 -- shards partition the suite list exactly (duration-balanced LPT)"

# the shard filter is no longer plain `idx % n` -- it is a
# duration-balanced greedy longest-first (LPT) packing over
# tests/shard-durations.tsv, computed inside run-all-tests.sh itself. Rather
# than re-implement that packing a second time here (a second copy is exactly
# how the two drift apart), this drives the REAL runtime path with
# LOKI_TEST_LIST=1, which prints each selected suite's name and returns
# without executing it. The ground truth for "is this a real suite name" is
# the same run_test-line extraction T1 already trusts.
_reg_names_file="$(mktemp)"
trap 'rm -f "$_reg_names_file"' EXIT
grep -E '^[[:space:]]*run_test "' "$RUNNER" | sed -E 's/^[[:space:]]*run_test "//; s/".*$//' > "$_reg_names_file"

for n in 2 3 4 6 8; do
    union_file="$(mktemp)"
    empty_shard=0
    for i in $(seq 0 $((n - 1))); do
        # run_test's LOKI_TEST_LIST path prints a plain "echo $test_name" with
        # no color codes, so grep -Fxf's exact-line match against the real
        # suite names already discards every banner/summary line untouched --
        # no ANSI stripping needed (an earlier draft added one; \x1b in sed is
        # a GNU-ism this repo's own "no platform-divergent construct" suite
        # would flag).
        shard_names="$(LOKI_TEST_SHARD="$i/$n" LOKI_TEST_LIST=1 bash "$RUNNER" 2>/dev/null \
            | grep -Fxf "$_reg_names_file" -)" || true
        if [ -z "$shard_names" ]; then
            empty_shard=1
        else
            printf '%s\n' "$shard_names" >> "$union_file"
        fi
    done
    count=$(wc -l < "$union_file" | tr -d ' ')
    dupcount=$(sort "$union_file" | uniq -d | wc -l | tr -d ' ')
    missing=$(comm -23 <(sort "$_reg_names_file") <(sort "$union_file") | wc -l | tr -d ' ')
    if [ "$count" -eq "$total" ] && [ "$dupcount" -eq 0 ] && [ "$missing" -eq 0 ]; then
        ok "n=$n: shards sum to $count, exactly the $total declared suites (0 dup, 0 missing)"
    else
        bad "n=$n: union=$count dup=$dupcount missing=$missing (want union=$total dup=0 missing=0)"
    fi
    if [ "$empty_shard" -eq 0 ]; then
        ok "n=$n: every shard received at least one suite"
    else
        bad "n=$n: at least one shard is empty (degenerate split)"
    fi
    rm -f "$union_file"
done

echo
echo "T5 -- the five heaviest named suites land in five distinct n=8 shards"

# S-81 requirement: the five heaviest suites must never share a shard at n=8.
# True by construction (LPT places the heaviest n suites first, one per empty
# shard), but assert it directly. The five are DERIVED from the duration table,
# restricted to registered suites: a hardcoded list went stale when heavier
# suites were measured, and then a tie-rotation shift from one new registration
# (FC-SHARD-WATCHLIST-STALE) put two of its light members in one shard.
_watch_suites=()
while IFS= read -r _w; do _watch_suites+=("$_w"); done < <(
    awk -F'\t' 'NR==FNR { reg[$0]=1; next } !/^#/ && NF>=2 && ($1 in reg) { print $2 "\t" $1 }' \
        "$_reg_names_file" "$SCRIPT_DIR/shard-durations.tsv" \
        | sort -t"$(printf '\t')" -k1,1nr -k2,2 | head -5 | cut -f2)
_watch_shards=()
for i in $(seq 0 7); do
    shard_names="$(LOKI_TEST_SHARD="$i/8" LOKI_TEST_LIST=1 bash "$RUNNER" 2>/dev/null | grep -Fxf "$_reg_names_file" -)" || true
    for w in "${_watch_suites[@]}"; do
        if printf '%s\n' "$shard_names" | grep -Fxq -- "$w"; then
            _watch_shards+=("$i:$w")
        fi
    done
done
_distinct=$(printf '%s\n' "${_watch_shards[@]}" | cut -d: -f1 | sort -u | wc -l | tr -d ' ')
if [ "${#_watch_shards[@]}" -eq 5 ] && [ "$_distinct" -eq 5 ]; then
    ok "all 5 watched suites found, each in its own shard: ${_watch_shards[*]}"
else
    bad "expected 5 watched suites in 5 distinct shards, got: ${_watch_shards[*]:-none found}"
fi

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
echo "T4 -- the real runner selects every suite: unsharded, and via n=4/n=8 dry-run union"

# S-137 (S-81 review follow-up): this used to recompute two counts by parsing
# run_test lines out of the source text -- the exact same static grep T1
# already trusts -- and compare them to EACH OTHER. Both sides read the same
# source text, never the runtime, so a real selection bug (the LPT packing
# silently dropping a suite from every shard, say) could never turn this red.
# Drive the real runner instead, through the same LOKI_TEST_LIST dry-run path
# T2 already trusts, so a runtime bug shows up here too.

# Unsharded (no LOKI_TEST_SHARD set) is the path a developer runs locally by
# default; it must still select every registered suite.
unsharded_names="$(env -u LOKI_TEST_SHARD LOKI_TEST_LIST=1 bash "$RUNNER" 2>/dev/null | grep -Fxf "$_reg_names_file" -)" || true
unsharded_count=$(printf '%s\n' "$unsharded_names" | sort -u | grep -c .)
if [ "$unsharded_count" -eq "$total" ]; then
    ok "unsharded real run selects all $total registered suites"
else
    bad "unsharded real run selected $unsharded_count of $total registered suites"
fi

# Cross-check by actually enumerating every shard through the real dry-run
# path at n=4 and n=8 and comparing the union against the registration list
# -- not a second static count.
for n in 4 8; do
    union_file="$(mktemp)"
    for i in $(seq 0 $((n - 1))); do
        LOKI_TEST_SHARD="$i/$n" LOKI_TEST_LIST=1 bash "$RUNNER" 2>/dev/null \
            | grep -Fxf "$_reg_names_file" - >> "$union_file" || true
    done
    ucount=$(sort -u "$union_file" | wc -l | tr -d ' ')
    if [ "$ucount" -eq "$total" ]; then
        ok "n=$n: real dry-run union covers all $total registered suites"
    else
        bad "n=$n: real dry-run union covers $ucount of $total registered suites"
    fi
    rm -f "$union_file"
done

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
