#!/usr/bin/env bash
# Test: loki_apply_tier_harness_policy() (model-equivalence harness policy).
# Asserts:
#   1. policy OFF by default -> no env change.
#   2. policy ON sets haiku -> MAX_ITERATIONS=8, council on, self-heal on.
#   3. operator override wins (a pre-set LOKI_MAX_ITERATIONS is NOT clobbered).
# No emojis. No em dashes.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_SH="$SCRIPT_DIR/../autonomy/run.sh"
PASSED=0
FAILED=0
log_pass() { echo "[PASS] $1"; PASSED=$((PASSED+1)); }
log_fail() { echo "[FAIL] $1"; FAILED=$((FAILED+1)); }

# run.sh has heavy top-level side effects, so extract ONLY the function body and
# eval it in this shell (awk from the def line to its closing brace at col 0).
FN_SRC="$(awk '/^loki_apply_tier_harness_policy\(\) \{/{f=1} f{print} f&&/^\}/{exit}' "$RUN_SH")"
if [ -z "$FN_SRC" ]; then
    echo "[FAIL] could not extract loki_apply_tier_harness_policy from run.sh"
    exit 1
fi
eval "$FN_SRC"

# --- 1. policy OFF by default -> no env change ---
(
    unset LOKI_TIER_HARNESS_POLICY LOKI_MAX_ITERATIONS LOKI_COUNCIL_ENABLED LOKI_SELF_HEAL
    loki_apply_tier_harness_policy haiku
    [ -z "${LOKI_MAX_ITERATIONS:-}" ] && [ -z "${LOKI_COUNCIL_ENABLED:-}" ] \
        && [ -z "${LOKI_SELF_HEAL:-}" ]
) && log_pass "policy off by default sets nothing" \
   || log_fail "policy off by default should set nothing"

# --- 2. policy ON, haiku -> 8 / council on / self-heal on ---
out="$(
    unset LOKI_MAX_ITERATIONS LOKI_COUNCIL_ENABLED LOKI_SELF_HEAL
    export LOKI_TIER_HARNESS_POLICY=1
    loki_apply_tier_harness_policy haiku
    echo "${LOKI_MAX_ITERATIONS:-}|${LOKI_COUNCIL_ENABLED:-}|${LOKI_SELF_HEAL:-}"
)"
[ "$out" = "8|true|1" ] \
    && log_pass "policy on: haiku -> 8|true|1" \
    || log_fail "policy on haiku expected 8|true|1, got '$out'"

# --- 2b. sonnet + opus rows from the stub table ---
out="$(
    unset LOKI_MAX_ITERATIONS LOKI_COUNCIL_ENABLED LOKI_SELF_HEAL
    export LOKI_TIER_HARNESS_POLICY=1
    loki_apply_tier_harness_policy sonnet
    echo "${LOKI_MAX_ITERATIONS:-}|${LOKI_COUNCIL_ENABLED:-}|${LOKI_SELF_HEAL:-}"
)"
[ "$out" = "5|true|1" ] \
    && log_pass "policy on: sonnet -> 5|true|1" \
    || log_fail "policy on sonnet expected 5|true|1, got '$out'"

out="$(
    unset LOKI_MAX_ITERATIONS LOKI_COUNCIL_ENABLED LOKI_SELF_HEAL
    export LOKI_TIER_HARNESS_POLICY=1
    loki_apply_tier_harness_policy opus
    echo "${LOKI_MAX_ITERATIONS:-}|${LOKI_COUNCIL_ENABLED:-}|${LOKI_SELF_HEAL:-}"
)"
[ "$out" = "3|true|0" ] \
    && log_pass "policy on: opus -> 3|true|0" \
    || log_fail "policy on opus expected 3|true|0, got '$out'"

# --- 3. operator override wins ---
out="$(
    export LOKI_TIER_HARNESS_POLICY=1
    export LOKI_MAX_ITERATIONS=99
    unset LOKI_COUNCIL_ENABLED LOKI_SELF_HEAL
    loki_apply_tier_harness_policy haiku
    echo "${LOKI_MAX_ITERATIONS:-}"
)"
[ "$out" = "99" ] \
    && log_pass "operator override wins: MAX_ITERATIONS stays 99" \
    || log_fail "operator override should win, expected 99, got '$out'"

echo
echo "Passed: $PASSED  Failed: $FAILED"
[ "$FAILED" -eq 0 ]
