#!/usr/bin/env bash
# tests/shard-durations.tsv must stay in sync with tests/run-all-tests.sh's
# own run_test registrations, in both directions.
#
# WHY THIS MATTERS. The LPT bin-packer in run-all-tests.sh degrades safely when
# a suite is missing from the table (it falls back to a 30s default duration,
# per the comment above _shard_default_duration_s) -- so a stale table never
# drops a suite. But "degrades safely" is not "stays balanced": a table that
# silently drifted out of sync with the real suite list is exactly how one
# shard quietly grew to 325s while another sat at 124s (real Tests run
# 36338540948 before the S-134 rebalance). A row naming a suite that no longer
# exists is equally silent: it just sits there unused, telling nobody the
# table needs a re-measure.
#
# So this asserts both directions of the set membership, using the identical
# run_test-line extraction test-shard-coverage.sh already established as
# ground truth (grep the literal source line, not a re-parse of shell syntax).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$SCRIPT_DIR/run-all-tests.sh"
DURATIONS="$SCRIPT_DIR/shard-durations.tsv"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

_reg_file="$(mktemp)"
_tbl_file="$(mktemp)"
trap 'rm -f "$_reg_file" "$_tbl_file"' EXIT

grep -E '^[[:space:]]*run_test "' "$RUNNER" | sed -E 's/^[[:space:]]*run_test "//; s/".*$//' > "$_reg_file"
reg_total=$(wc -l < "$_reg_file" | tr -d ' ')

echo "T1 -- the runner declares suites (ground truth)"
if [ "$reg_total" -gt 100 ]; then
    ok "runner declares $reg_total suites"
else
    bad "expected >100 suites, found $reg_total -- is the parse still correct?"
fi

echo
echo "T2 -- the durations file exists and is readable"
if [ -f "$DURATIONS" ]; then
    ok "$DURATIONS exists"
else
    bad "$DURATIONS is missing"
fi

# Skip comments (#-prefixed) and blank lines, same rule the awk loader in
# run-all-tests.sh applies. Each surviving line must be name<TAB>seconds.
awk -F'\t' '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    { print $1 }
' "$DURATIONS" > "$_tbl_file"
tbl_total=$(wc -l < "$_tbl_file" | tr -d ' ')

echo
echo "T3 -- every registered suite has a row in shard-durations.tsv"
missing=$(comm -23 <(sort "$_reg_file") <(sort "$_tbl_file"))
missing_count=$(printf '%s' "$missing" | grep -c . || true)
if [ "$missing_count" -eq 0 ]; then
    ok "all $reg_total registered suites have a measured row"
else
    bad "$missing_count registered suite(s) missing a row: $(printf '%s' "$missing" | tr '\n' '|')"
fi

echo
echo "T4 -- every row in shard-durations.tsv names a currently-registered suite"
orphans=$(comm -13 <(sort "$_reg_file") <(sort "$_tbl_file"))
orphan_count=$(printf '%s' "$orphans" | grep -c . || true)
if [ "$orphan_count" -eq 0 ]; then
    ok "all $tbl_total table rows name a registered suite"
else
    bad "$orphan_count table row(s) name no registered suite: $(printf '%s' "$orphans" | tr '\n' '|')"
fi

echo
echo "T5 -- no duplicate suite name in the table (a lookup would only ever see one)"
dup_count=$(sort "$_tbl_file" | uniq -d | grep -c . || true)
if [ "$dup_count" -eq 0 ]; then
    ok "no duplicate row names"
else
    bad "$dup_count duplicate row name(s)"
fi

echo
echo "T6 -- every row's duration is a non-negative integer number of seconds"
bad_secs=$(awk -F'\t' '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    $2 !~ /^[0-9]+$/ { print $1 "=" $2 }
' "$DURATIONS")
bad_secs_count=$(printf '%s' "$bad_secs" | grep -c . || true)
if [ "$bad_secs_count" -eq 0 ]; then
    ok "every row's seconds field is a non-negative integer"
else
    bad "$bad_secs_count row(s) with a non-numeric seconds field: $(printf '%s' "$bad_secs" | tr '\n' '|')"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
