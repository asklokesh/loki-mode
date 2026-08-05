#!/usr/bin/env bash
# Test: Interrupted-run resume discoverability
#
# A run stopped by Ctrl-C / a crash / a closed laptop leaves NO PAUSE or STOP
# file -- only .loki/autonomy-state.json with status "interrupted" and the
# iteration it reached. Before this change both `loki resume` and `loki status`
# were blind to that shape: resume printed "No session to resume. Start a
# session with: loki start" and status printed no hint at all, so real saved
# progress was invisible and `loki next` (which maps interrupted -> cmd_resume)
# hit the same dead end.
#
# These tests assert the BEHAVIOUR in both directions. The false-positive
# direction is the load-bearing one: a resume hint on a run that has nothing to
# resume is worse than silence, because it promises progress that run.sh's
# load_state is about to reset to iteration 0.

set -uo pipefail
# Note: Not using -e to allow collecting all test results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI_BIN="$SCRIPT_DIR/../autonomy/loki"
PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-resume-disc.XXXXXX")"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

# A distinctive iteration number: a hardcoded string in the implementation
# cannot pass by accident, and it is not a value any default would produce.
DISTINCT_ITER=47

# Build a throwaway project dir containing a .loki/autonomy-state.json with the
# given status and iteration. Echoes the dir path.
# Usage: make_project <status> <iteration>
make_project() {
    local status="$1" iteration="$2"
    local dir
    dir="$(mktemp -d "$TMP_ROOT/proj.XXXXXX")"
    mkdir -p "$dir/.loki"
    cat > "$dir/.loki/autonomy-state.json" << EOF
{
    "retryCount": 0,
    "iterationCount": $iteration,
    "status": "$status",
    "lastExitCode": 130,
    "lastRun": "2026-08-02T11:22:33Z",
    "prdPath": "",
    "pid": 999999,
    "maxRetries": 3,
    "baseWait": 5
}
EOF
    printf '%s\n' "$dir"
}

# Run a loki subcommand with cwd inside a project dir. cmd_resume uses `exit 0`
# on several branches, so this must be a subprocess, never sourced.
# Usage: run_loki <project-dir> <subcommand...>
run_loki() {
    local dir="$1"; shift
    ( cd "$dir" && bash "$LOKI_BIN" "$@" 2>&1 )
}

echo "========================================"
echo "Resume Discoverability Tests"
echo "========================================"
echo "loki: $LOKI_BIN"
echo ""

# ===========================================
# Test 1: interrupted run -> resume surfaces it and names the right run
# ===========================================
log_test "loki resume on an interrupted run names the iteration and a command"
proj="$(make_project interrupted "$DISTINCT_ITER")"
out="$(run_loki "$proj" resume)"

if grep -qi "interrupted run found" <<< "$out"; then
    log_pass "resume announces the interrupted run"
else
    log_fail "resume did not announce the interrupted run. Got: $out"
fi

# The iteration number is the assertion that proves it READ THE STATE rather
# than printing a canned string.
if grep -q "$DISTINCT_ITER" <<< "$out"; then
    log_pass "resume reports the real iteration reached ($DISTINCT_ITER)"
else
    log_fail "resume did not report iteration $DISTINCT_ITER. Got: $out"
fi

if grep -q "loki start" <<< "$out"; then
    log_pass "resume prints a copy-pasteable resume command"
else
    log_fail "resume printed no resume command. Got: $out"
fi

# The old dead end must be gone: it sent the user away from their saved state.
if grep -q "No session to resume" <<< "$out"; then
    log_fail "resume still printed the dead-end 'No session to resume'. Got: $out"
else
    log_pass "resume no longer prints the dead-end 'No session to resume'"
fi

# ===========================================
# Test 2: interrupted run -> status surfaces the same hint
# ===========================================
log_test "loki status on an interrupted run surfaces the resume hint"
out="$(run_loki "$proj" status)"

if grep -qi "interrupted run found" <<< "$out" && grep -q "$DISTINCT_ITER" <<< "$out"; then
    log_pass "status surfaces the interrupted run and its iteration"
else
    log_fail "status did not surface the interrupted run. Got: $out"
fi

# ===========================================
# Test 3 (FALSE-POSITIVE DIRECTION): a TERMINAL run gets no resume hint.
# This is the case that matters. An empty .loki is the easy negative; a
# finished run is the one where a bogus hint would point at nothing, because
# load_state resets iterationCount to 0 for every terminal status.
# ===========================================
log_test "terminal statuses do NOT produce a bogus resume hint"
terminal_clean=0
terminal_total=0
for terminal_status in council_approved failed max_iterations_reached exited running; do
    ((terminal_total++))
    tproj="$(make_project "$terminal_status" "$DISTINCT_ITER")"
    tout="$(run_loki "$tproj" resume)"
    if grep -qi "interrupted run found" <<< "$tout"; then
        log_fail "status '$terminal_status' wrongly produced a resume hint. Got: $tout"
    elif grep -q "$DISTINCT_ITER" <<< "$tout"; then
        log_fail "status '$terminal_status' wrongly advertised iteration $DISTINCT_ITER. Got: $tout"
    else
        ((terminal_clean++))
    fi
done

if [ "$terminal_clean" -eq "$terminal_total" ]; then
    log_pass "no resume hint for any of $terminal_total terminal/non-resumable statuses"
fi

# "running" deserves its own named assertion: it is the status an uncatchable
# SIGKILL leaves behind, it LOOKS resumable, and load_state resets it to 0
# without LOKI_DURABLE_STATE=1. Promising a resume there would be a fabrication.
log_test "'running' (crashed, uncatchable kill) does NOT promise a resume"
rproj="$(make_project running "$DISTINCT_ITER")"
rout="$(run_loki "$rproj" resume)"
if grep -qi "interrupted run found" <<< "$rout"; then
    log_fail "'running' wrongly produced an interrupted-resume hint. Got: $rout"
else
    log_pass "'running' produces no interrupted-resume hint"
fi

# ===========================================
# Test 4: no .loki at all -> honest "nothing here", no hint
# ===========================================
log_test "a directory with no .loki produces no resume hint"
empty_dir="$(mktemp -d "$TMP_ROOT/empty.XXXXXX")"
out="$(run_loki "$empty_dir" resume)"

if grep -qi "interrupted run found" <<< "$out"; then
    log_fail "resume invented a hint with no .loki present. Got: $out"
else
    log_pass "resume prints no hint when there is no .loki"
fi

if grep -qi "no .loki directory found\|no session to resume" <<< "$out"; then
    log_pass "resume still says plainly that there is nothing to resume"
else
    log_fail "resume gave no honest 'nothing to resume' message. Got: $out"
fi

# ===========================================
# Test 5 (REGRESSION GUARD): an explicit PAUSE still behaves as before
# ===========================================
log_test "an explicit PAUSE signal still takes the original path"
pproj="$(make_project interrupted "$DISTINCT_ITER")"
touch "$pproj/.loki/PAUSE"
out="$(run_loki "$pproj" resume)"

if grep -q "PAUSE signal cleared" <<< "$out"; then
    log_pass "PAUSE is still cleared by resume (unchanged behaviour)"
else
    log_fail "PAUSE handling regressed. Got: $out"
fi

if [ ! -f "$pproj/.loki/PAUSE" ]; then
    log_pass "PAUSE file removed"
else
    log_fail "PAUSE file was not removed"
fi

# ===========================================
# Test 6: help text mentions interrupted runs, so the path is discoverable
# before the user needs it
# ===========================================
log_test "help text mentions interrupted runs"
help_out="$(bash "$LOKI_BIN" help 2>&1)"
if grep -qi "resume.*interrupted" <<< "$help_out"; then
    log_pass "loki help describes resume as covering interrupted runs"
else
    log_fail "loki help does not mention interrupted runs for resume"
fi

resume_help="$(bash "$LOKI_BIN" resume --help 2>&1)"
if grep -qi "interrupted" <<< "$resume_help"; then
    log_pass "loki resume --help explains the interrupted case"
else
    log_fail "loki resume --help does not explain the interrupted case"
fi

echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"

# --- the key save_state ACTUALLY writes ---------------------------------------
# run.sh:6707 writes "iteration". Reading only "iterationCount" made every REAL
# interrupted run report iteration 0, while a fixture using the other spelling
# kept the suite green. A test that only ever sees its own fixture cannot catch
# a field-name mismatch with the production writer.
_prodws="$(mktemp -d "${TMPDIR:-/tmp}/loki-resume-prodkey-XXXXXX")"
mkdir -p "$_prodws/.loki"
printf '{"status":"interrupted","iteration":7,"lastRun":"2026-08-02T09:14:02Z"}\n' \
    > "$_prodws/.loki/autonomy-state.json"
_prodout="$(cd "$_prodws" && bash "$LOKI_BIN" resume 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g')"
rm -rf "$_prodws"
case "$_prodout" in
    *"iteration 7"*)
        log_pass "reads the iteration key save_state actually writes" ;;
    *"iteration 0"*)
        log_fail "reports iteration 0 for a real run: reading the wrong key" ;;
    *)  log_fail "no iteration reported: $(printf '%s' "$_prodout" | head -1)" ;;
esac

echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
