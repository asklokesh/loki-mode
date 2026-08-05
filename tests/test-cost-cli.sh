#!/usr/bin/env bash
# Test: cost/estimate CLI reachability.
#
# WHY THIS EXISTS. autonomy/lib/cost-summary.py and tools/estimate-run.py both
# shipped with no CLI caller: `grep -rn "cost-summary\|estimate-run" autonomy/loki
# bin/loki` returned nothing. A tool nobody can invoke is not a shipped feature.
# This repo has been bitten by that class before (auto_detect_provider sat
# unwired from v5.0.0 to v8.64.0), so the wiring gets a test that RUNS the
# commands rather than grepping for the strings.
#
# The load-bearing assertion is the honesty one: a workspace with no efficiency
# records must report UNKNOWN, never $0.00. Unmeasured is not free -- that
# confusion shipped to users on four separate surfaces (v8.51.0-v8.54.0), and a
# fifth reader of the same records must not reintroduce it.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
BASH_COMP="$REPO_ROOT/completions/loki.bash"
ZSH_COMP="$REPO_ROOT/completions/_loki"

PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED+1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED+1)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-cost-cli.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Fixture A: a workspace WITH measured efficiency records.
WS_MEASURED="$WORK/measured"
mkdir -p "$WS_MEASURED/.loki/metrics/efficiency"
cat > "$WS_MEASURED/.loki/metrics/efficiency/iteration-1.json" <<'EOF'
{"iteration": 1, "cost_usd": 0.42, "input_tokens": 1000, "output_tokens": 500,
 "cache_read_tokens": 9000, "cache_creation_tokens": 200}
EOF
cat > "$WS_MEASURED/.loki/metrics/efficiency/iteration-2.json" <<'EOF'
{"iteration": 2, "cost_usd": 0.61, "input_tokens": 1200, "output_tokens": 700,
 "cache_read_tokens": 11000, "cache_creation_tokens": 100}
EOF

# Fixture B: a workspace with .loki/ but NO efficiency records at all.
WS_EMPTY="$WORK/empty"
mkdir -p "$WS_EMPTY/.loki"

echo "========================================"
echo "Cost / Estimate CLI Tests"
echo "========================================"
echo "loki: $LOKI"
echo ""

if [ ! -x "$LOKI" ] && [ ! -f "$LOKI" ]; then
    echo -e "${RED}[FAIL]${NC} missing $LOKI"
    exit 1
fi

# ===========================================
# Test 1: loki cost --detail on a measured workspace prints a summary
# ===========================================
log_test "loki cost --detail on a workspace WITH efficiency records"
out="$(cd "$WS_MEASURED" && bash "$LOKI" cost --detail 2>&1)"
rc=$?

if [ $rc -ne 0 ]; then
    log_fail "loki cost --detail exited $rc (expected 0). Output: $out"
elif ! grep -q "Cost summary" <<<"$out"; then
    log_fail "loki cost --detail printed no summary header. Output: $out"
elif ! grep -q '\$1\.03' <<<"$out"; then
    log_fail "loki cost --detail did not total the two records (\$0.42+\$0.61). Output: $out"
elif ! grep -q "Cache ratio" <<<"$out"; then
    log_fail "loki cost --detail omitted the cache hit ratio. Output: $out"
else
    log_pass "loki cost --detail summarizes measured records (total, cache ratio)"
fi

# ===========================================
# Test 2: --json passthrough is real, parseable JSON
# ===========================================
log_test "loki cost --detail --json emits parseable JSON"
jout="$(cd "$WS_MEASURED" && bash "$LOKI" cost --detail --json 2>/dev/null)"
if ! python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('iterations_measured')==2 else 1)" <<<"$jout" 2>/dev/null; then
    log_fail "loki cost --detail --json did not emit JSON with iterations_measured=2. Output: $jout"
else
    log_pass "loki cost --detail --json emits parseable JSON (iterations_measured=2)"
fi

# ===========================================
# Test 3: THE HONESTY RULE. No records => UNKNOWN, never a fabricated $0.00.
# ===========================================
log_test "loki cost --detail on a workspace with NO records reports UNKNOWN"
eout="$(cd "$WS_EMPTY" && bash "$LOKI" cost --detail 2>&1)"
erc=$?

if [ $erc -ne 0 ]; then
    log_fail "loki cost --detail on an empty workspace exited $erc (expected 0 -- 'no data' is an honest answer, not a tool failure). Output: $eout"
elif ! grep -q "Total cost:  UNKNOWN" <<<"$eout"; then
    log_fail "empty workspace did not report 'Total cost: UNKNOWN'. Output: $eout"
elif grep -qE 'Total cost: +\$0\.00' <<<"$eout"; then
    log_fail "empty workspace reported a FABRICATED \$0.00 total. Unmeasured is not free. Output: $eout"
else
    log_pass "empty workspace reports UNKNOWN, not a fabricated \$0.00 (unmeasured is not free)"
fi

# ===========================================
# Test 3b: --last with --detail is REJECTED, not silently discarded.
# A flag that looks accepted but does nothing is the same family of dishonesty
# as a fabricated $0.00.
# ===========================================
log_test "loki cost --detail --last N rejects rather than silently ignoring --last"
lout="$(cd "$WS_MEASURED" && bash "$LOKI" cost --detail --last 5 2>&1)"
lrc=$?
if [ $lrc -eq 0 ]; then
    log_fail "--detail --last 5 exited 0; --last was silently discarded. Output: $lout"
elif ! grep -q -- "--last is not supported with --detail" <<<"$lout"; then
    log_fail "--detail --last 5 did not explain the conflict. Output: $lout"
else
    log_pass "--detail --last N is rejected with an explanation (not silently ignored)"
fi

# ===========================================
# Test 3c: LOKI_DIR is honored, so --detail describes the same workspace the
# budget view does. LOKI_DIR is genuinely relocatable (autonomy/serve.sh
# exports a non-default), so a hardcoded "." would read the wrong workspace.
# ===========================================
log_test "loki cost --detail honors a relocated LOKI_DIR"
rout="$(cd "$WS_EMPTY" && LOKI_DIR="$WS_MEASURED/.loki" bash "$LOKI" cost --detail 2>&1)"
if ! grep -q "2 found, 2 measured" <<<"$rout"; then
    log_fail "--detail ignored LOKI_DIR and read the cwd workspace instead. Output: $rout"
else
    log_pass "--detail reads the workspace LOKI_DIR points at, not a hardcoded ."
fi

# ===========================================
# Test 4: loki estimate WITHOUT --iterations explains the requirement
# ===========================================
log_test "loki estimate without --iterations explains what is required"
nout="$(cd "$WS_MEASURED" && bash "$LOKI" estimate 2>&1)"
nrc=$?

if [ $nrc -eq 0 ]; then
    log_fail "loki estimate without --iterations exited 0 (expected non-zero). Output: $nout"
elif ! grep -q -- "--iterations is required" <<<"$nout"; then
    log_fail "loki estimate did not state that --iterations is required. Output: $nout"
elif ! grep -q -- "loki estimate --iterations" <<<"$nout"; then
    log_fail "loki estimate did not show a runnable example. Output: $nout"
elif grep -qi "Traceback" <<<"$nout"; then
    log_fail "loki estimate leaked a python traceback. Output: $nout"
else
    log_pass "loki estimate without --iterations explains the requirement (no traceback)"
fi

# ===========================================
# Test 5: loki estimate --iterations N projects from measured history
# ===========================================
log_test "loki estimate --iterations 10 projects a total"
pout="$(cd "$WS_MEASURED" && bash "$LOKI" estimate --iterations 10 2>&1)"
prc=$?

if [ $prc -ne 0 ]; then
    log_fail "loki estimate --iterations 10 exited $prc (expected 0). Output: $pout"
elif ! grep -qi "estimate" <<<"$pout"; then
    log_fail "loki estimate produced no estimate output. Output: $pout"
elif ! grep -q "Projected for 10" <<<"$pout"; then
    log_fail "loki estimate did not project for the requested 10 iterations. Output: $pout"
else
    log_pass "loki estimate --iterations 10 projects from measured per-iteration cost"
fi

# ===========================================
# Test 6: a non-numeric --iterations is rejected, not passed through
# ===========================================
log_test "loki estimate --iterations <non-numeric> is rejected cleanly"
bout="$(cd "$WS_MEASURED" && bash "$LOKI" estimate --iterations abc 2>&1)"
brc=$?
if [ $brc -eq 0 ]; then
    log_fail "loki estimate accepted a non-numeric --iterations. Output: $bout"
elif grep -qi "Traceback" <<<"$bout"; then
    log_fail "non-numeric --iterations leaked a python traceback. Output: $bout"
else
    log_pass "loki estimate rejects a non-numeric --iterations without a traceback"
fi

# ===========================================
# Test 7: both commands are dispatchable (not "Unknown command")
# ===========================================
log_test "cost and estimate are real dispatch arms"
disp_ok=0
for c in cost estimate; do
    hout="$(cd "$WS_MEASURED" && bash "$LOKI" "$c" --help 2>&1)"
    if grep -qi "Unknown command" <<<"$hout"; then
        log_fail "'loki $c' is not dispatched (Unknown command)"
    else
        disp_ok=$((disp_ok+1))
    fi
done
[ $disp_ok -eq 2 ] && log_pass "both 'loki cost' and 'loki estimate' dispatch"

# ===========================================
# Test 8: both appear in loki --help
# ===========================================
log_test "cost and estimate appear in loki --help"
help_out="$(cd "$WORK" && bash "$LOKI" --help 2>&1)"
help_missing=""
grep -qw "cost" <<<"$help_out" || help_missing="$help_missing cost"
grep -qw "estimate" <<<"$help_out" || help_missing="$help_missing estimate"
if [ -n "$help_missing" ]; then
    log_fail "missing from loki --help:$help_missing"
else
    log_pass "both cost and estimate appear in loki --help"
fi

# ===========================================
# Test 9: both appear in BOTH shell completions
# ===========================================
log_test "cost and estimate appear in bash AND zsh completions"
comp_missing=""
for c in cost estimate; do
    grep -qE "(^|[ \"'])${c}([ \"']|$)" "$BASH_COMP" || comp_missing="$comp_missing bash:$c"
    grep -q "'${c}:" "$ZSH_COMP" || comp_missing="$comp_missing zsh:$c"
done
if [ -n "$comp_missing" ]; then
    log_fail "missing from completions:$comp_missing"
else
    log_pass "both cost and estimate appear in bash and zsh completions"
fi

echo ""
echo "========================================"
echo -e "Passed: ${GREEN}${PASSED}${NC}   Failed: ${RED}${FAILED}${NC}"
echo "========================================"

[ $FAILED -eq 0 ] || exit 1
exit 0
