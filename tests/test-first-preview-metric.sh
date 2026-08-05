#!/usr/bin/env bash
# tests/test-first-preview-metric.sh -- guards the time-to-first-preview metric
# written by _write_health() (autonomy/app-runner.sh).
#
# WHY THIS METRIC EXISTS
#   The single number that most predicts whether someone keeps using a
#   spec-to-product builder is how long they wait before seeing their app
#   actually running. Gates, councils, and receipts are all invisible until
#   there is something on screen. The runner already recorded `started_at`
#   (when it launched the app) and `checked_at` (when a probe ran), but nothing
#   anchored to the START OF THE RUN -- so the number a user actually feels
#   could not be derived from what was stored.
#
# WHAT THIS GUARDS (the properties that make the number trustworthy)
#   1. Written on the first healthy probe, as elapsed seconds from run start.
#   2. WRITE-ONCE: a later restart must NOT overwrite it. Without this a warm
#      restart would silently replace a real 4-minute first preview with a
#      2-second one and flatter the metric.
#   3. NOT written when the app is unhealthy (a failed probe is not a preview).
#   4. NOT written when the baseline is missing -- a direct app-runner call
#      outside a run must record nothing rather than invent a start time.
#   5. NOT written when the baseline is absurd (clock change / stale export),
#      because an untrustworthy number is worse than an absent one.
#
# Drives the REAL _write_health from the real app-runner.sh.
# No emojis. No em dashes.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PASS=0
FAIL=0
ok() { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1 -- $2"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-first-preview-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Extract _write_health from the real source rather than reimplementing it, so
# this test cannot pass against a copy that has drifted from what ships.
FN_SRC="$WORK/write_health.sh"
awk '/^_write_health\(\) \{/,/^\}/' "$REPO_ROOT/autonomy/app-runner.sh" > "$FN_SRC"
if ! grep -q "seconds_to_first_preview" "$FN_SRC"; then
    echo "FATAL: could not extract _write_health (or it lost the metric)"
    exit 2
fi
# shellcheck source=/dev/null
. "$FN_SRC"

fresh_dir() {
    _APP_RUNNER_DIR="$WORK/run-$1"
    mkdir -p "$_APP_RUNNER_DIR"
}
fp_file() { echo "$_APP_RUNNER_DIR/first-preview.json"; }

# --- 1. healthy + valid baseline -> metric recorded --------------------------
fresh_dir a
export _LOKI_RUN_START_EPOCH=$(( $(date +%s) - 42 ))
_write_health "true"
if [ -f "$(fp_file)" ]; then
    secs="$(grep -o '"seconds_to_first_preview": *[0-9]*' "$(fp_file)" | grep -o '[0-9]*$')"
    if [ "${secs:-0}" -ge 40 ] && [ "${secs:-0}" -le 60 ]; then
        ok "records elapsed seconds on first healthy probe (${secs}s)"
    else
        bad "records elapsed seconds on first healthy probe" "got '${secs}', expected ~42"
    fi
else
    bad "records elapsed seconds on first healthy probe" "first-preview.json not written"
fi

# --- 2. WRITE-ONCE: a restart must not overwrite the real number -------------
# This is the load-bearing property: without it a warm restart silently
# replaces a genuine slow first preview with a fast one.
first_content="$(cat "$(fp_file)")"
export _LOKI_RUN_START_EPOCH=$(( $(date +%s) - 1 ))
_write_health "true"
if [ "$(cat "$(fp_file)")" = "$first_content" ]; then
    ok "write-once: a later healthy probe does not overwrite the first"
else
    bad "write-once: a later healthy probe does not overwrite the first" \
        "value changed to $(cat "$(fp_file)")"
fi

# --- 3. unhealthy probe -> no metric ----------------------------------------
fresh_dir b
export _LOKI_RUN_START_EPOCH=$(( $(date +%s) - 10 ))
_write_health "false"
if [ -f "$(fp_file)" ]; then
    bad "unhealthy probe records nothing" "wrote a preview time for a failed probe"
else
    ok "unhealthy probe records nothing"
fi

# --- 4. missing baseline -> no metric (never invent a start time) ------------
fresh_dir c
unset _LOKI_RUN_START_EPOCH
_write_health "true"
if [ -f "$(fp_file)" ]; then
    bad "missing baseline records nothing" "invented a start time"
else
    ok "missing baseline records nothing"
fi

# --- 5. absurd baseline -> no metric ----------------------------------------
# A future-dated baseline (clock change / stale export) yields a negative
# elapsed; an untrustworthy number is worse than an absent one.
fresh_dir d
export _LOKI_RUN_START_EPOCH=$(( $(date +%s) + 500 ))
_write_health "true"
if [ -f "$(fp_file)" ]; then
    bad "absurd baseline records nothing" "recorded a negative/nonsense elapsed"
else
    ok "absurd baseline records nothing"
fi

# --- 6. health.json itself still written in every case ----------------------
# The metric is an ADD-ON; it must never interfere with the existing contract.
for d in a b c d; do
    if [ ! -f "$WORK/run-$d/health.json" ]; then
        bad "health.json still written (run-$d)" "missing"
        continue
    fi
done
ok "health.json still written in every case (metric is additive)"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
