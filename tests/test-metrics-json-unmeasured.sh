#!/usr/bin/env bash
# Test: loki metrics --json on unmeasured state (S-147 / BACKLOG 118)
#
# Guards against cmd_metrics (autonomy/loki) reporting a fabricated 0 for
# tokens.total / agent_activity.total_iterations, and a fabricated
# time_saved_hours, when nothing was ever recorded. Unrecorded must be null
# (unknown), and real recorded values must still come through unchanged.
#
# Not using -e so all cases run and get reported.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"

PASS=0
FAIL=0
TOTAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; ((FAIL++)); }

if [ ! -x "$LOKI" ]; then
    echo -e "${RED}Error: $LOKI not found or not executable${NC}"
    exit 1
fi

TMPDIR_BASE=$(mktemp -d /tmp/loki-test-metrics-unmeasured-XXXXXX)
trap 'rm -rf "$TMPDIR_BASE"' EXIT INT TERM

# json_get FIELD_PATH <<<"$json"   (field path is a python expression suffix, e.g. "['tokens']['total']")
json_get() {
    python3 -c "import json,sys; d=json.load(sys.stdin); print(d$1)" 2>/dev/null
}

run_metrics_json() {
    local loki_dir="$1"
    LOKI_DIR="$loki_dir" timeout -k 10 30 "$LOKI" metrics --json 2>&1
}

# -------------------------------------------
# Case 1: empty .loki -- total_iterations must be null, not 0
# -------------------------------------------
EMPTY_DIR="$TMPDIR_BASE/empty/.loki"
mkdir -p "$EMPTY_DIR"
((TOTAL++))
output=$(run_metrics_json "$EMPTY_DIR")
val=$(json_get "['agent_activity']['total_iterations']" <<<"$output")
if [ "$val" = "None" ]; then
    log_pass "empty .loki: total_iterations is null"
else
    log_fail "empty .loki: total_iterations is null" "got: $val"
fi

# -------------------------------------------
# Case 2: empty .loki -- tokens.total must be null, not 0
# -------------------------------------------
((TOTAL++))
val=$(json_get "['tokens']['total']" <<<"$output")
if [ "$val" = "None" ]; then
    log_pass "empty .loki: tokens.total is null"
else
    log_fail "empty .loki: tokens.total is null" "got: $val"
fi

# -------------------------------------------
# Case 3: empty .loki -- time_saved.hours must not be a fabricated number
# -------------------------------------------
((TOTAL++))
val=$(json_get "['time_saved']['hours']" <<<"$output")
if [ "$val" = "None" ]; then
    log_pass "empty .loki: time_saved.hours is null, not fabricated"
else
    log_fail "empty .loki: time_saved.hours is null, not fabricated" "got: $val"
fi

# -------------------------------------------
# Case 4: empty .loki -- exit code is still 0 (does not crash on nulls)
# -------------------------------------------
((TOTAL++))
actual_exit=0
LOKI_DIR="$EMPTY_DIR" timeout -k 10 30 "$LOKI" metrics --json >/dev/null 2>&1 || actual_exit=$?
if [ "$actual_exit" -eq 0 ]; then
    log_pass "empty .loki: exit code 0"
else
    log_fail "empty .loki: exit code 0" "got exit $actual_exit"
fi

# -------------------------------------------
# Case 5: empty .loki -- text mode does not crash either
# -------------------------------------------
((TOTAL++))
actual_exit=0
text_output=$(LOKI_DIR="$EMPTY_DIR" timeout -k 10 30 "$LOKI" metrics 2>&1) || actual_exit=$?
if [ "$actual_exit" -eq 0 ] && echo "$text_output" | grep -qi "unknown"; then
    log_pass "empty .loki: text report shows unknown time saved, no crash"
else
    log_fail "empty .loki: text report shows unknown time saved, no crash" "exit=$actual_exit output=$(echo "$text_output" | head -3)"
fi

# -------------------------------------------
# Case 6: real recorded data -- values come through unchanged (not nulled)
# -------------------------------------------
REAL_DIR="$TMPDIR_BASE/real/.loki"
mkdir -p "$REAL_DIR/metrics/efficiency"
cat > "$REAL_DIR/metrics/efficiency/iteration-1.json" <<'JSON'
{"model": "sonnet", "duration_seconds": 30, "cost_usd": 0.5, "input_tokens": 1000, "output_tokens": 500}
JSON
cat > "$REAL_DIR/metrics/efficiency/iteration-2.json" <<'JSON'
{"model": "opus", "duration_seconds": 45, "cost_usd": 1.5, "input_tokens": 2000, "output_tokens": 800}
JSON

real_output=$(run_metrics_json "$REAL_DIR")

((TOTAL++))
val=$(json_get "['agent_activity']['total_iterations']" <<<"$real_output")
if [ "$val" = "2" ]; then
    log_pass "real data: total_iterations is 2 (unchanged)"
else
    log_fail "real data: total_iterations is 2 (unchanged)" "got: $val"
fi

((TOTAL++))
val=$(json_get "['tokens']['total']" <<<"$real_output")
if [ "$val" = "4300" ]; then
    log_pass "real data: tokens.total is 4300 (unchanged)"
else
    log_fail "real data: tokens.total is 4300 (unchanged)" "got: $val"
fi

((TOTAL++))
val=$(json_get "['time_saved']['hours']" <<<"$real_output")
if [ "$val" = "0.5" ]; then
    log_pass "real data: time_saved.hours is 0.5 (unchanged formula)"
else
    log_fail "real data: time_saved.hours is 0.5 (unchanged formula)" "got: $val"
fi

# -------------------------------------------
# Case 7: context/tracking.json present but empty / all-zero (its seeded
# initial state) -- tokens.total must still be null, not a fabricated 0
# -------------------------------------------
for ctx_body in '{}' '{"totals": {"total_input": 0, "total_output": 0, "total_cost_usd": 0.0, "compaction_count": 0, "iterations_tracked": 0}}'; do
    CTX_DIR="$TMPDIR_BASE/ctx-$TOTAL/.loki"
    mkdir -p "$CTX_DIR/context"
    printf '%s\n' "$ctx_body" > "$CTX_DIR/context/tracking.json"
    ((TOTAL++))
    val=$(json_get "['tokens']['total']" <<<"$(run_metrics_json "$CTX_DIR")")
    if [ "$val" = "None" ]; then
        log_pass "empty context tracking ($ctx_body): tokens.total is null"
    else
        log_fail "empty context tracking ($ctx_body): tokens.total is null" "got: $val"
    fi
done

# -------------------------------------------
# Case 8: context/tracking.json with real totals -- tokens come through
# -------------------------------------------
CTX_REAL="$TMPDIR_BASE/ctx-real/.loki"
mkdir -p "$CTX_REAL/context"
printf '%s\n' '{"totals": {"total_input": 700, "total_output": 300, "total_cost_usd": 0.25, "iterations_tracked": 1}}' > "$CTX_REAL/context/tracking.json"
((TOTAL++))
val=$(json_get "['tokens']['total']" <<<"$(run_metrics_json "$CTX_REAL")")
if [ "$val" = "1000" ]; then
    log_pass "real context tracking: tokens.total is 1000"
else
    log_fail "real context tracking: tokens.total is 1000" "got: $val"
fi

echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
echo "========================================"

[ "$FAIL" -eq 0 ]
