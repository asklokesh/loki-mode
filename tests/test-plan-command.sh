#!/usr/bin/env bash
# Test: loki plan command
# Tests the dry-run PRD analysis and cost estimation feature.
#
# Note: Not using -e to allow collecting all test results

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"

PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; ((FAIL++)); }

echo "========================================"
echo "Loki Plan Command Tests"
echo "========================================"
echo ""

# Verify fixtures exist
SIMPLE_PRD="$SCRIPT_DIR/fixtures/sample-prd-simple.md"
COMPLEX_PRD="$SCRIPT_DIR/fixtures/sample-prd-complex.md"

if [ ! -f "$SIMPLE_PRD" ] || [ ! -f "$COMPLEX_PRD" ]; then
    echo -e "${RED}Error: Test fixture PRD files not found${NC}"
    exit 1
fi

# -------------------------------------------
# Test 1: loki plan without args shows usage error
# -------------------------------------------
((TOTAL++))
output=$("$LOKI" plan 2>&1) || actual_exit=$?
if echo "$output" | grep -qi "usage"; then
    log_pass "loki plan without args shows usage"
else
    log_fail "loki plan without args" "expected usage message"
fi

# -------------------------------------------
# Test 2: loki plan --help exits 0
# -------------------------------------------
((TOTAL++))
actual_exit=0
output=$("$LOKI" plan --help 2>&1) || actual_exit=$?
if [ "$actual_exit" -eq 0 ] && echo "$output" | grep -qi "dry-run"; then
    log_pass "loki plan --help exits 0 and shows description"
else
    log_fail "loki plan --help" "exit=$actual_exit or missing description"
fi

# -------------------------------------------
# Test 3: loki plan with nonexistent file
# -------------------------------------------
((TOTAL++))
actual_exit=0
output=$("$LOKI" plan /tmp/nonexistent-prd-xyz.md 2>&1) || actual_exit=$?
if [ "$actual_exit" -ne 0 ] && echo "$output" | grep -qi "not found"; then
    log_pass "loki plan with nonexistent file exits non-zero"
else
    log_fail "loki plan with nonexistent file" "exit=$actual_exit"
fi

# -------------------------------------------
# Test 4: loki plan with simple PRD shows output
# -------------------------------------------
((TOTAL++))
actual_exit=0
output=$("$LOKI" plan "$SIMPLE_PRD" 2>&1) || actual_exit=$?
if [ "$actual_exit" -eq 0 ] && echo "$output" | grep -qi "complexity"; then
    log_pass "loki plan with simple PRD shows complexity"
else
    log_fail "loki plan with simple PRD" "exit=$actual_exit or missing complexity"
fi

# -------------------------------------------
# Test 5: Simple PRD detected as simple/moderate
# -------------------------------------------
((TOTAL++))
if echo "$output" | grep -qi "SIMPLE\|MODERATE"; then
    log_pass "simple PRD detected as simple or moderate tier"
else
    log_fail "simple PRD complexity tier" "expected SIMPLE or MODERATE"
    echo "  Output (first 10 lines):"
    echo "$output" | head -10 | sed 's/^/    /'
fi

# -------------------------------------------
# Test 6: loki plan shows cost estimate
# -------------------------------------------
((TOTAL++))
if echo "$output" | grep -q '\$'; then
    log_pass "loki plan shows cost estimate with dollar sign"
else
    log_fail "loki plan cost estimate" "no dollar sign found in output"
fi

# -------------------------------------------
# Test 7: loki plan shows iteration count
# -------------------------------------------
((TOTAL++))
if echo "$output" | grep -qi "iteration"; then
    log_pass "loki plan shows iteration information"
else
    log_fail "loki plan iterations" "no iteration info found"
fi

# -------------------------------------------
# Test 8: loki plan with complex PRD
# -------------------------------------------
((TOTAL++))
actual_exit=0
output=$("$LOKI" plan "$COMPLEX_PRD" 2>&1) || actual_exit=$?
if [ "$actual_exit" -eq 0 ] && echo "$output" | grep -qi "COMPLEX\|ENTERPRISE"; then
    log_pass "complex PRD detected as complex or enterprise tier"
else
    log_fail "complex PRD complexity tier" "expected COMPLEX or ENTERPRISE, exit=$actual_exit"
    echo "  Output (first 15 lines):"
    echo "$output" | head -15 | sed 's/^/    /'
fi

# -------------------------------------------
# Test 9: Complex PRD detects integrations
# -------------------------------------------
((TOTAL++))
if echo "$output" | grep -qi "integration"; then
    log_pass "complex PRD detects external integrations"
else
    log_fail "complex PRD integrations" "no integrations mentioned"
fi

# -------------------------------------------
# Test 10: loki plan --json outputs valid JSON
# -------------------------------------------
((TOTAL++))
actual_exit=0
json_output=$("$LOKI" plan "$SIMPLE_PRD" --json 2>&1) || actual_exit=$?
if [ "$actual_exit" -eq 0 ] && echo "$json_output" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null; then
    log_pass "loki plan --json outputs valid JSON"
else
    log_fail "loki plan --json" "invalid JSON or exit=$actual_exit"
fi

# -------------------------------------------
# Test 11: JSON output has expected fields
# -------------------------------------------
((TOTAL++))
has_fields=$(echo "$json_output" | python3 -c "
import json, sys
d = json.load(sys.stdin)
required = ['complexity', 'iterations', 'tokens', 'cost', 'time', 'execution_plan', 'quality_gates', 'provider']
missing = [k for k in required if k not in d]
print('OK' if not missing else 'MISSING: ' + ', '.join(missing))
" 2>/dev/null)
if [ "$has_fields" = "OK" ]; then
    log_pass "JSON output contains all required fields"
else
    log_fail "JSON output fields" "$has_fields"
fi

# -------------------------------------------
# Test 12: JSON cost is a number > 0
# -------------------------------------------
((TOTAL++))
cost_check=$(echo "$json_output" | python3 -c "
import json, sys
d = json.load(sys.stdin)
c = d.get('cost', {}).get('total_usd', 0)
print('OK' if isinstance(c, (int, float)) and c > 0 else 'BAD')
" 2>/dev/null)
if [ "$cost_check" = "OK" ]; then
    log_pass "JSON cost.total_usd is a positive number"
else
    log_fail "JSON cost value" "expected positive number"
fi

# -------------------------------------------
# Test 13: loki plan --verbose shows per-iteration table
# -------------------------------------------
((TOTAL++))
actual_exit=0
output=$("$LOKI" plan "$SIMPLE_PRD" --verbose 2>&1) || actual_exit=$?
if [ "$actual_exit" -eq 0 ] && echo "$output" | grep -qi "per-iteration"; then
    log_pass "loki plan --verbose shows per-iteration breakdown"
else
    log_fail "loki plan --verbose" "missing per-iteration breakdown"
fi

# -------------------------------------------
# Test 14: loki plan --json --verbose includes iteration_details
# -------------------------------------------
((TOTAL++))
actual_exit=0
json_verbose=$("$LOKI" plan "$SIMPLE_PRD" --json --verbose 2>&1) || actual_exit=$?
has_details=$(echo "$json_verbose" | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('OK' if 'iteration_details' in d and len(d['iteration_details']) > 0 else 'MISSING')
" 2>/dev/null)
if [ "$has_details" = "OK" ]; then
    log_pass "JSON --verbose includes iteration_details array"
else
    log_fail "JSON --verbose iteration_details" "$has_details"
fi

# -------------------------------------------
# Test 15: Complex PRD has more iterations than simple
# -------------------------------------------
((TOTAL++))
simple_iters=$(echo "$json_output" | python3 -c "import json,sys; print(json.load(sys.stdin)['iterations']['estimated'])" 2>/dev/null)
complex_json=$("$LOKI" plan "$COMPLEX_PRD" --json 2>&1)
complex_iters=$(echo "$complex_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['iterations']['estimated'])" 2>/dev/null)
if [ -n "$simple_iters" ] && [ -n "$complex_iters" ] && [ "$complex_iters" -gt "$simple_iters" ]; then
    log_pass "complex PRD estimates more iterations ($complex_iters) than simple ($simple_iters)"
else
    log_fail "iteration comparison" "simple=$simple_iters complex=$complex_iters"
fi

# -------------------------------------------
# Test 16: Complex PRD costs more than simple
# -------------------------------------------
((TOTAL++))
simple_cost=$(echo "$json_output" | python3 -c "import json,sys; print(json.load(sys.stdin)['cost']['total_usd'])" 2>/dev/null)
complex_cost=$(echo "$complex_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['cost']['total_usd'])" 2>/dev/null)
cost_cmp=$(python3 -c "print('OK' if float('$complex_cost') > float('$simple_cost') else 'BAD')" 2>/dev/null)
if [ "$cost_cmp" = "OK" ]; then
    log_pass "complex PRD estimates higher cost (\$$complex_cost) than simple (\$$simple_cost)"
else
    log_fail "cost comparison" "simple=\$$simple_cost complex=\$$complex_cost"
fi

# ===========================================
# v7.29.0 slice A: LOKI_COMPLEXITY honoring (keystone) + demo cost confirm
# ===========================================

TEMPLATES_DIR="$SCRIPT_DIR/../templates"
TODO_PRD="$TEMPLATES_DIR/simple-todo-app.md"

# Portable timeout: prefer GNU timeout / gtimeout; fall back to no-op wrapper
# (the tested code paths are designed never to hang, so the fallback is safe;
# the timeout is an extra guard, not the assertion itself).
TIMEOUT_BIN=""
if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN="timeout"
elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN="gtimeout"
fi
run_guarded() {
    # run_guarded <seconds> <cmd...>
    local secs="$1"; shift
    if [ -n "$TIMEOUT_BIN" ]; then
        "$TIMEOUT_BIN" "$secs" "$@"
    else
        "$@"
    fi
}

# -------------------------------------------
# Test 17: LOKI_COMPLEXITY=simple forces tier in JSON on a complex PRD
# -------------------------------------------
((TOTAL++))
forced_json=$(LOKI_COMPLEXITY=simple "$LOKI" plan "$COMPLEX_PRD" --json 2>/dev/null)
forced_tier=$(echo "$forced_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['complexity']['tier'])" 2>/dev/null)
forced_reason=$(echo "$forced_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['complexity']['reasons'][0])" 2>/dev/null)
if [ "$forced_tier" = "simple" ] && echo "$forced_reason" | grep -q "forced via LOKI_COMPLEXITY=simple"; then
    log_pass "LOKI_COMPLEXITY=simple forces tier=simple in JSON with honest reason"
else
    log_fail "LOKI_COMPLEXITY=simple force (json)" "tier=$forced_tier reason=$forced_reason"
fi

# -------------------------------------------
# Test 18: Forcing simple lowers cost vs the unforced complex run (same PRD)
# -------------------------------------------
((TOTAL++))
unforced_cost=$("$LOKI" plan "$COMPLEX_PRD" --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['cost']['total_usd'])" 2>/dev/null)
forced_cost=$(echo "$forced_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['cost']['total_usd'])" 2>/dev/null)
cost_drop=$(python3 -c "print('OK' if float('$forced_cost') < float('$unforced_cost') else 'BAD')" 2>/dev/null)
if [ "$cost_drop" = "OK" ]; then
    log_pass "forced simple lowers cost (\$$forced_cost) vs unforced complex (\$$unforced_cost)"
else
    log_fail "forced simple cost drop" "forced=\$$forced_cost unforced=\$$unforced_cost"
fi

# -------------------------------------------
# Test 19: LOKI_COMPLEXITY=simple forces tier in formatted (non-JSON) output
# -------------------------------------------
((TOTAL++))
forced_fmt=$(LOKI_COMPLEXITY=simple "$LOKI" plan "$COMPLEX_PRD" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')
if echo "$forced_fmt" | grep -q "Tier: SIMPLE (forced via LOKI_COMPLEXITY=simple)"; then
    log_pass "LOKI_COMPLEXITY=simple shows forced note in formatted output"
else
    log_fail "forced note (formatted)" "missing 'Tier: SIMPLE (forced via ...)'"
fi

# -------------------------------------------
# Test 20: LOKI_COMPLEXITY=standard aliases to moderate tier
# -------------------------------------------
((TOTAL++))
std_tier=$(LOKI_COMPLEXITY=standard "$LOKI" plan "$SIMPLE_PRD" --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['complexity']['tier'])" 2>/dev/null)
if [ "$std_tier" = "moderate" ]; then
    log_pass "LOKI_COMPLEXITY=standard aliases to moderate tier"
else
    log_fail "standard->moderate alias" "tier=$std_tier"
fi

# -------------------------------------------
# Test 21: Invalid LOKI_COMPLEXITY value is ignored (content tier used)
# -------------------------------------------
((TOTAL++))
content_tier=$("$LOKI" plan "$COMPLEX_PRD" --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['complexity']['tier'])" 2>/dev/null)
bogus_tier=$(LOKI_COMPLEXITY=bogus "$LOKI" plan "$COMPLEX_PRD" --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['complexity']['tier'])" 2>/dev/null)
auto_tier=$(LOKI_COMPLEXITY=auto "$LOKI" plan "$COMPLEX_PRD" --json 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['complexity']['tier'])" 2>/dev/null)
if [ "$bogus_tier" = "$content_tier" ] && [ "$auto_tier" = "$content_tier" ]; then
    log_pass "invalid/auto LOKI_COMPLEXITY ignored (content tier=$content_tier preserved)"
else
    log_fail "invalid value ignored" "content=$content_tier bogus=$bogus_tier auto=$auto_tier"
fi

# -------------------------------------------
# Test 22: Regression -- unforced plan on the demo PRD is unchanged
# (simple, $1.86, 4 iters; the override is opt-in via the env var only)
# -------------------------------------------
((TOTAL++))
if [ -f "$TODO_PRD" ]; then
    todo_json=$("$LOKI" plan "$TODO_PRD" --json 2>/dev/null)
    todo_tier=$(echo "$todo_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['complexity']['tier'])" 2>/dev/null)
    todo_cost=$(echo "$todo_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['cost']['total_usd'])" 2>/dev/null)
    todo_iters=$(echo "$todo_json" | python3 -c "import json,sys; print(json.load(sys.stdin)['iterations']['estimated'])" 2>/dev/null)
    if [ "$todo_tier" = "simple" ] && [ "$todo_cost" = "1.86" ] && [ "$todo_iters" = "4" ]; then
        log_pass "demo PRD unforced plan unchanged (simple, \$1.86, 4 iters)"
    else
        log_fail "demo PRD regression" "tier=$todo_tier cost=\$$todo_cost iters=$todo_iters"
    fi
else
    log_fail "demo PRD regression" "templates/simple-todo-app.md not found"
fi

# -------------------------------------------
# Test 23: loki demo --help is unchanged (no new flags leaked into help)
# -------------------------------------------
((TOTAL++))
demo_help=$("$LOKI" demo --help 2>&1)
if echo "$demo_help" | grep -q "Build a real project from a bundled template" \
    && echo "$demo_help" | grep -q -- "--dry-run     Show what would happen without running" \
    && ! echo "$demo_help" | grep -q -- "--yes"; then
    log_pass "loki demo --help unchanged (no --yes leaked into help)"
else
    log_fail "demo --help unchanged" "help text drifted"
fi

# -------------------------------------------
# Test 24: loki demo --dry-run renders the SIMPLE-tier estimate block, exits 0,
# and spends nothing (no runner entry)
# -------------------------------------------
((TOTAL++))
DEMO_TMP_24=$(mktemp -d 2>/dev/null || echo "/tmp/loki-plan-demo24-$$")
dry_exit=0
dry_out=$(TMPDIR="$DEMO_TMP_24" run_guarded 30 "$LOKI" demo --dry-run 2>&1 | sed 's/\x1b\[[0-9;]*m//g') || dry_exit=$?
if [ "$dry_exit" -eq 0 ] \
    && echo "$dry_out" | grep -q "Estimate (SIMPLE tier, the path this demo actually runs):" \
    && echo "$dry_out" | grep -q 'Cost:        ~\$1.86' \
    && echo "$dry_out" | grep -q "\[dry-run\] Would run:"; then
    log_pass "loki demo --dry-run renders SIMPLE estimate block and exits 0"
else
    log_fail "demo --dry-run estimate" "exit=$dry_exit"
fi
rm -rf "$DEMO_TMP_24"

# -------------------------------------------
# Test 25: loki demo non-TTY without --yes prints the estimate, refuses with an
# honest message, exits 2, and does NOT hang (piped stdin, guarded by timeout).
# -------------------------------------------
((TOTAL++))
DEMO_TMP_25=$(mktemp -d 2>/dev/null || echo "/tmp/loki-plan-demo25-$$")
nt_exit=0
nt_out=$(TMPDIR="$DEMO_TMP_25" run_guarded 15 "$LOKI" demo </dev/null 2>&1 | sed 's/\x1b\[[0-9;]*m//g') || nt_exit=$?
if [ "$nt_exit" -eq 2 ] \
    && echo "$nt_out" | grep -q "Estimate (SIMPLE tier, the path this demo actually runs):" \
    && echo "$nt_out" | grep -q "demo needs confirmation; re-run with --yes to proceed non-interactively"; then
    log_pass "loki demo non-TTY without --yes refuses (exit 2), prints estimate, no hang"
else
    log_fail "demo non-TTY refuse" "exit=$nt_exit (124=timeout/hang)"
fi
rm -rf "$DEMO_TMP_25"

# -------------------------------------------
# Summary
# -------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed (of $TOTAL)"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
