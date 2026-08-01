#!/usr/bin/env bash
# `loki why` must not contradict the completion summary.
#
# v8.14.0 made the summary's cap advice rework-aware: on a CONVERGING run,
# raising LOKI_MAX_ITERATIONS is right; on a THRASHING run it buys more
# thrashing at full price. The summary then tells the user to run `loki why`
# for detail -- and `loki why` gave the old, naive "raise the cap" line with no
# rework awareness at all.
#
# Two surfaces, contradictory advice, and the one the summary points AT was the
# wrong one. Both now read the same attribution, so a user cannot be told
# opposite things about a single run.
#
# THE FALLBACK MATTERS: when no efficiency records exist the static line stays.
# Guessing which case applies with no data would be worse than generic advice.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"

passed=0
failed=0
ok() { echo "  PASS: $1"; passed=$((passed + 1)); }
ko() { echo "  FAIL: $1"; failed=$((failed + 1)); shift; [[ $# -gt 0 ]] && echo "        $*"; }

echo "TEST: loki why is rework-aware on the iteration cap"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/loki-whyrw-XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

# $1 = case name, rest = per-iteration statuses. The writer only ever emits
# "completed" or "failed" (run.sh: exit_code 0 -> completed, else failed), so
# those are the only values a fixture should use.
mk() {
    local d="$SCRATCH/$1"; shift
    rm -rf "$d"; mkdir -p "$d/.loki/metrics/efficiency"
    printf '{"status":"max_iterations_reached","iteration":3,"exit_code":20}\n' \
        > "$d/.loki/autonomy-state.json"
    local n=1 st
    for st in "$@"; do
        printf '{"iteration":%d,"model":"sonnet","cost_usd":1.2,"status":"%s"}\n' \
            "$n" "$st" > "$d/.loki/metrics/efficiency/iteration-$n.json"
        n=$((n + 1))
    done
    printf '%s' "$d"
}

why_advice() { (cd "$1" && bash "$LOKI" why 2>/dev/null | grep "What to do" || true); }

# --- 1. THRASHING: must NOT simply tell the user to raise the cap ------------
d="$(mk thrash failed failed failed)"
out="$(why_advice "$d")"
if [[ "$out" == *"buys more of the same"* ]]; then
    ok "a thrashing run is warned that raising the cap buys more thrashing"
else
    ko "a thrashing run is warned that raising the cap buys more thrashing" \
       "got: ${out:-<empty>}"
fi
[[ "$out" == *"3 of 3"* ]] \
    && ok "the thrashing advice quotes the actual split" \
    || ko "the thrashing advice quotes the actual split" "got: ${out:-<empty>}"
[[ "$out" == *"3.60"* ]] \
    && ok "the thrashing advice quotes what the rework cost" \
    || ko "the thrashing advice quotes what the rework cost" "got: ${out:-<empty>}"

# --- 2. CONVERGING: raising the cap IS the right advice ---------------------
d="$(mk converge completed completed completed failed)"
out="$(why_advice "$d")"
[[ "$out" == *"Converging"* && "$out" == *"LOKI_MAX_ITERATIONS"* ]] \
    && ok "a converging run is told to raise the cap" \
    || ko "a converging run is told to raise the cap" "got: ${out:-<empty>}"
# It must NOT carry the thrashing warning, or the advice is self-contradictory.
[[ "$out" != *"buys more of the same"* ]] \
    && ok "a converging run does not get the thrashing warning" \
    || ko "a converging run does not get the thrashing warning" "got: $out"

# --- 3. THE FALLBACK. No records: keep the static line, do not guess. -------
d="$SCRATCH/nodata"; rm -rf "$d"; mkdir -p "$d/.loki"
printf '{"status":"max_iterations_reached","iteration":3,"exit_code":20}\n' \
    > "$d/.loki/autonomy-state.json"
out="$(why_advice "$d")"
if [[ "$out" == *"LOKI_MAX_ITERATIONS"* ]]; then
    ok "with no records the static advice still renders (no crash, no guess)"
else
    ko "with no records the static advice still renders" "got: ${out:-<empty>}"
fi
[[ "$out" != *"of 0 iterations"* ]] \
    && ok "no records means no fabricated 0-of-0 split" \
    || ko "no records means no fabricated 0-of-0 split" "got: $out"

# --- 4. a corrupt record must not break the command -------------------------
d="$(mk corrupt completed failed)"
printf 'not json at all\n' > "$d/.loki/metrics/efficiency/iteration-9.json"
out="$(why_advice "$d")"
[[ -n "$out" ]] \
    && ok "a corrupt efficiency record does not break loki why" \
    || ko "a corrupt efficiency record does not break loki why"

# --- 5. other outcomes are untouched ----------------------------------------
# Only the iteration-cap branch changed; a different terminal must keep its
# own guidance rather than inheriting cap advice.
d="$(mk other completed)"
printf '{"status":"budget_exceeded","iteration":3,"exit_code":20}\n' \
    > "$d/.loki/autonomy-state.json"
out="$(why_advice "$d")"
[[ "$out" != *"buys more of the same"* ]] \
    && ok "a non-cap outcome keeps its own advice" \
    || ko "a non-cap outcome keeps its own advice" "got: $out"

echo ""
echo "  Passed:     $passed"
echo "  Failed:     $failed"
[[ $failed -eq 0 ]] || exit 1
