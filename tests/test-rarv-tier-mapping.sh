#!/usr/bin/env bash
# test-rarv-tier-mapping.sh
#
# Characterization (parity-anchor) test for get_rarv_tier() and
# get_rarv_phase_name() in autonomy/run.sh.
#
# WHY THIS EXISTS
# ---------------
# The RARV cycle maps the iteration counter to a model tier via `iteration % 4`:
#   step 0 -> planning   (REASON)
#   step 1 -> development (ACT)
#   step 2 -> development (REFLECT)
#   step 3 -> fast        (VERIFY)
#
# ITERATION_COUNT is 0-initialised and incremented at the TOP of the loop, so
# the first in-loop pass calls get_rarv_tier with 1 (ACT/development), not 0
# (REASON/planning). That offset is INTENTIONAL, not a bug:
#   - For the default Claude provider, planning and development both resolve to
#     opus, so the offset is behaviorally inert (only codex effort differs, on
#     the LOKI_LEGACY_TIER_SWITCHING=true opt-in path).
#   - The mapping is parity-locked to loki-ts/src/runner/rarv.ts, which mirrors
#     the identical `% 4` mapping (and normalizes negatives). Changing the bash
#     modulo would break the bash/Bun parity matrix.
#
# This test pins the cyclic mapping so a future refactor cannot silently shift
# it (and thereby break parity). It is an extract-style test: it sources ONLY
# the two pure functions out of run.sh by line range, so it does not execute the
# orchestrator. Non-vacuous: it asserts DISTINCT outputs across the cycle and
# would fail if the mapping were shifted, inverted, or collapsed.
#
# Exit: 0 if all assertions pass, 1 on first failure.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="${REPO_ROOT}/autonomy/run.sh"

if [ ! -f "$RUN_SH" ]; then
    echo "FAIL: cannot find autonomy/run.sh at $RUN_SH"
    exit 1
fi

# Extract the two pure functions by their definition markers. We pull from the
# `get_rarv_tier() {` line through the close of `get_rarv_phase_name`, which are
# contiguous in run.sh. awk tracks brace depth so we stop at the matching close
# of the SECOND function and never pull unrelated code.
extracted="$(awk '
    /^get_rarv_tier\(\) \{/ { capture=1 }
    capture { print }
    capture && /^get_rarv_phase_name\(\) \{/ { in_second=1 }
    in_second && /^\}/ { exit }
' "$RUN_SH")"

# Sanity: both function definitions must be present in the extract, otherwise
# the source drifted and the test would be vacuous.
if ! grep -q 'get_rarv_tier() {' <<<"$extracted" \
   || ! grep -q 'get_rarv_phase_name() {' <<<"$extracted"; then
    echo "FAIL: could not extract both RARV functions from run.sh (source drift?)"
    exit 1
fi

# Provide the global the functions default to so the extract is self-contained.
ITERATION_COUNT=0

# Source the extracted functions into THIS shell.
# shellcheck disable=SC1090
eval "$extracted"

fail=0
assert_eq() {
    local got="$1" want="$2" label="$3"
    if [ "$got" != "$want" ]; then
        echo "FAIL: $label -> got '$got', want '$want'"
        fail=1
    else
        echo "ok: $label -> $got"
    fi
}

# --- get_rarv_tier across a full cycle and into the second cycle ---
assert_eq "$(get_rarv_tier 0)"  "planning"    "tier(0)=planning (REASON)"
assert_eq "$(get_rarv_tier 1)"  "development" "tier(1)=development (ACT)"
assert_eq "$(get_rarv_tier 2)"  "development" "tier(2)=development (REFLECT)"
assert_eq "$(get_rarv_tier 3)"  "fast"        "tier(3)=fast (VERIFY)"
assert_eq "$(get_rarv_tier 4)"  "planning"    "tier(4)=planning (cycle wraps)"
assert_eq "$(get_rarv_tier 5)"  "development" "tier(5)=development (cycle wraps)"
assert_eq "$(get_rarv_tier 7)"  "fast"        "tier(7)=fast (cycle wraps)"
assert_eq "$(get_rarv_tier 8)"  "planning"    "tier(8)=planning (cycle wraps)"

# --- get_rarv_phase_name agrees with the tier on the SAME index ---
# (no logged-vs-selected inconsistency; this is the consistency invariant)
assert_eq "$(get_rarv_phase_name 0)" "REASON"  "phase(0)=REASON"
assert_eq "$(get_rarv_phase_name 1)" "ACT"     "phase(1)=ACT"
assert_eq "$(get_rarv_phase_name 2)" "REFLECT" "phase(2)=REFLECT"
assert_eq "$(get_rarv_phase_name 3)" "VERIFY"  "phase(3)=VERIFY"
assert_eq "$(get_rarv_phase_name 4)" "REASON"  "phase(4)=REASON (cycle wraps)"

# --- default-arg path: with no arg, defaults to $ITERATION_COUNT (==0 here) ---
assert_eq "$(get_rarv_tier)"       "planning" "tier() defaults to ITERATION_COUNT(0)=planning"
assert_eq "$(get_rarv_phase_name)" "REASON"   "phase() defaults to ITERATION_COUNT(0)=REASON"

# --- distinctness invariant: the cycle must produce >=3 distinct tiers and
#     >=4 distinct phase names (guards against a collapse-to-one-value refactor)
distinct_tiers="$(printf '%s\n' \
    "$(get_rarv_tier 0)" "$(get_rarv_tier 1)" "$(get_rarv_tier 2)" "$(get_rarv_tier 3)" \
    | sort -u | wc -l | tr -d ' ')"
assert_eq "$distinct_tiers" "3" "cycle yields 3 distinct tiers (planning/development/fast)"

distinct_phases="$(printf '%s\n' \
    "$(get_rarv_phase_name 0)" "$(get_rarv_phase_name 1)" \
    "$(get_rarv_phase_name 2)" "$(get_rarv_phase_name 3)" \
    | sort -u | wc -l | tr -d ' ')"
assert_eq "$distinct_phases" "4" "cycle yields 4 distinct phase names"

if [ "$fail" -ne 0 ]; then
    echo "RESULT: FAIL"
    exit 1
fi
echo "RESULT: PASS (RARV tier/phase mapping locked; parity-anchored to loki-ts/src/runner/rarv.ts)"
exit 0
