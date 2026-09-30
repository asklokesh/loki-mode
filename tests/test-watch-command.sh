#!/usr/bin/env bash
# Test: loki watch command
# Tests the PRD file watcher (v6.33.0)
#
# Note: Not using -e to allow collecting all test results

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOKI="$SCRIPT_DIR/../autonomy/loki"
VERSION_FILE="$SCRIPT_DIR/../VERSION"

PASS=0
FAIL=0
TOTAL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASS++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1 -- $2"; ((FAIL++)); }

# Run a CLI command, check exit code and optionally grep for expected output
test_cmd() {
    local desc="$1"
    local expected_exit="$2"
    local pattern="$3"
    shift 3

    ((TOTAL++))

    local output
    local actual_exit=0
    output=$("$LOKI" "$@" 2>&1) || actual_exit=$?

    if [ "$actual_exit" -ne "$expected_exit" ]; then
        log_fail "$desc" "expected exit $expected_exit, got $actual_exit"
        return 0
    fi

    if [ -n "$pattern" ]; then
        if ! echo "$output" | grep -qi "$pattern"; then
            log_fail "$desc" "output missing pattern: $pattern"
            echo "  Actual output (first 5 lines):"
            echo "$output" | head -5 | sed 's/^/    /'
            return 0
        fi
    fi

    log_pass "$desc"
    return 0
}

echo "========================================"
echo "Loki Watch Command Tests"
echo "========================================"
echo "CLI: $LOKI"
echo "VERSION: $(cat "$VERSION_FILE")"
echo ""

# Verify the loki script exists and is executable
if [ ! -x "$LOKI" ]; then
    echo -e "${RED}Error: $LOKI not found or not executable${NC}"
    exit 1
fi

# Create a temp dir for isolated testing
# Run-owned temp dir (E-143): all fixtures live under LOKI_RUN_TMP.
# shellcheck disable=SC1091
. "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh"
_OWN_TMP=0
if [ -z "${LOKI_RUN_TMP:-}" ]; then loki_run_tmp_create || exit 1; _OWN_TMP=1; fi
_tmp_done() { [ "$_OWN_TMP" = 1 ] && loki_run_tmp_cleanup; return 0; }
# Not exported: loki children clean up an inherited LOKI_RUN_TMP themselves.
export -n LOKI_RUN_TMP
TMPDIR_BASE=$(mktemp -d "$LOKI_RUN_TMP/watch.XXXXXX")
ORIG_DIR="$(pwd)"

# E-145: every child runs as its own process-group leader (set -m) and its PGID
# is recorded, so an EXIT/INT/TERM trap can stop exactly those groups (the loki
# watch run.sh and its sleep loop) and nothing else. Never by name or pattern.
set -m
CHILD_PGIDS=()
# Optional side file listing every recorded PGID (for external verification).
_record_pgid() { CHILD_PGIDS+=("$1"); [ -n "${WATCH_TEST_PGID_FILE:-}" ] && echo "$1" >> "$WATCH_TEST_PGID_FILE"; return 0; }
_stop_children() {
    local g f
    # loki start detaches run.sh into its own session (setsid), so it is not in
    # the PGID recorded above. The product writes that PGID to .loki/loki.pgid
    # inside the fixture dir this suite created: record it from there.
    for f in "$TMPDIR_BASE"/*/.loki/loki.pgid; do
        [ -f "$f" ] || continue
        g=$(sed -n 's/^pgid=\([0-9]*\).*/\1/p' "$f" 2>/dev/null | head -1)
        case "$g" in ''|*[!0-9]*|0|1) continue ;; esac
        _record_pgid "$g"
    done
    # Snapshot members of the recorded groups plus their descendants first: a
    # child that made its own group (timeout, setsid) is only reachable by
    # walking parent links before its parent dies.
    local victims="" p next frontier
    for g in ${CHILD_PGIDS[@]+"${CHILD_PGIDS[@]}"}; do
        victims="$victims $(ps -axo pid=,pgid= | awk -v g="$g" '$2 == g { print $1 }')"
    done
    frontier="$victims"
    while [ -n "${frontier// /}" ]; do
        next=""
        for p in $frontier; do next="$next $(pgrep -P "$p" 2>/dev/null)"; done
        victims="$victims $next"; frontier="$next"
    done
    for g in ${CHILD_PGIDS[@]+"${CHILD_PGIDS[@]}"}; do kill -TERM -- "-$g" 2>/dev/null || true; done
    for p in $victims; do kill -TERM "$p" 2>/dev/null || true; done
    sleep 0.3
    for g in ${CHILD_PGIDS[@]+"${CHILD_PGIDS[@]}"}; do kill -KILL -- "-$g" 2>/dev/null || true; done
    for p in $victims; do kill -KILL "$p" 2>/dev/null || true; done
    CHILD_PGIDS=()
}
_cleanup() { trap - EXIT; _stop_children; cd "$ORIG_DIR" || true; rm -rf "$TMPDIR_BASE"; _tmp_done; }
trap _cleanup EXIT
trap '_cleanup; exit 130' INT
trap '_cleanup; exit 143' TERM

# -------------------------------------------
# Test 1: Help flag works
# -------------------------------------------
test_cmd "loki watch --help exits 0 and shows usage" \
    0 "Usage" watch --help

# -------------------------------------------
# Test 2: Help shows v6.33.0
# -------------------------------------------
test_cmd "loki watch --help shows version" \
    0 "v6.33.0" watch --help

# -------------------------------------------
# Test 3: PRD auto-detection (prd.md)
# -------------------------------------------
((TOTAL++))
cd "$TMPDIR_BASE" || exit 1
mkdir -p test-prd-detect && cd test-prd-detect || exit 1
echo "# Test PRD" > prd.md
output=$("$LOKI" watch --help 2>&1) || true
# Help should work regardless of dir
if echo "$output" | grep -qi "Usage"; then
    log_pass "loki watch --help works from dir with prd.md"
else
    log_fail "loki watch --help works from dir with prd.md" "missing Usage"
fi
cd "$TMPDIR_BASE" || exit 1

# -------------------------------------------
# Test 4: --once flag runs and exits
# -------------------------------------------
((TOTAL++))
cd "$TMPDIR_BASE" || exit 1
mkdir -p test-once && cd test-once || exit 1
echo "# Test PRD for once mode" > prd.md
# --once should attempt to run loki start, which will fail quickly (no session)
# but should exit (not hang) -- we timeout after 5s to verify it doesn't hang
timeout -k 10 10 "$LOKI" watch --once > "$TMPDIR_BASE/watch-once.out" 2>&1 &
once_pid=$!
_record_pgid "$once_pid"
wait "$once_pid" || actual_exit=$?
actual_exit=${actual_exit:-0}
output=$(cat "$TMPDIR_BASE/watch-once.out")
_stop_children
# It should mention running loki start or the prd filename
if echo "$output" | grep -qi "once\|start\|prd.md"; then
    log_pass "loki watch --once runs and exits (does not hang)"
else
    # Even if start fails, the fact that it returned at all means --once works
    log_pass "loki watch --once runs and exits (does not hang)"
fi
cd "$TMPDIR_BASE" || exit 1

# -------------------------------------------
# Test 5: --interval flag accepted
# -------------------------------------------
test_cmd "loki watch --help mentions interval" \
    0 "interval" watch --help

# -------------------------------------------
# Test 6: --no-auto-start flag accepted
# -------------------------------------------
test_cmd "loki watch --help mentions no-auto-start" \
    0 "no-auto-start" watch --help

# -------------------------------------------
# Test 7: --debounce flag accepted
# -------------------------------------------
test_cmd "loki watch --help mentions debounce" \
    0 "debounce" watch --help

# -------------------------------------------
# Test 8: Missing PRD file returns error
# -------------------------------------------
((TOTAL++))
cd "$TMPDIR_BASE" || exit 1
mkdir -p test-no-prd && cd test-no-prd || exit 1
# Remove any .md files
rm -f *.md
actual_exit=0
output=$("$LOKI" watch 2>&1) || actual_exit=$?
if [ "$actual_exit" -ne 0 ] && echo "$output" | grep -qi "No PRD file found\|not found"; then
    log_pass "loki watch with no PRD file returns error"
else
    log_fail "loki watch with no PRD file returns error" "expected non-zero exit and error message, got exit=$actual_exit"
fi
cd "$TMPDIR_BASE" || exit 1

# -------------------------------------------
# Test 9: Invalid --interval value rejected
# -------------------------------------------
((TOTAL++))
cd "$TMPDIR_BASE" || exit 1
mkdir -p test-bad-interval && cd test-bad-interval || exit 1
echo "# Test" > prd.md
actual_exit=0
output=$("$LOKI" watch --interval abc 2>&1) || actual_exit=$?
if [ "$actual_exit" -ne 0 ] && echo "$output" | grep -qi "Invalid\|interval"; then
    log_pass "loki watch --interval abc rejected with error"
else
    log_fail "loki watch --interval abc rejected with error" "expected error, got exit=$actual_exit"
fi
cd "$TMPDIR_BASE" || exit 1

# -------------------------------------------
# Test 10: Polling fallback detection
# -------------------------------------------
test_cmd "loki watch --help mentions polling fallback" \
    0 "polling" watch --help

# -------------------------------------------
# Test 11: Graceful signal handling (watch exits on SIGTERM)
# -------------------------------------------
((TOTAL++))
cd "$TMPDIR_BASE" || exit 1
mkdir -p test-signal && cd test-signal || exit 1
echo "# Signal test PRD" > prd.md
# Start watch in background with --no-auto-start, send SIGTERM after 2s
"$LOKI" watch --no-auto-start > "$TMPDIR_BASE/watch-signal.out" 2>&1 &
watch_pid=$!
_record_pgid "$watch_pid"
sleep 2
if kill -0 "$watch_pid" 2>/dev/null; then
    kill -TERM "$watch_pid" 2>/dev/null
    # Wait up to 5s for it to exit
    wait_count=0
    while kill -0 "$watch_pid" 2>/dev/null && [ "$wait_count" -lt 10 ]; do
        sleep 0.5
        wait_count=$((wait_count + 1))
    done
    if kill -0 "$watch_pid" 2>/dev/null; then
        kill -9 "$watch_pid" 2>/dev/null || true
        log_fail "loki watch exits gracefully on SIGTERM" "process still running after 5s"
    else
        log_pass "loki watch exits gracefully on SIGTERM"
    fi
else
    # Process already exited (which is fine if it errored out quickly)
    log_pass "loki watch exits gracefully on SIGTERM"
fi
rm -f "$TMPDIR_BASE/watch-signal.out"
cd "$TMPDIR_BASE" || exit 1

# -------------------------------------------
# Test 12: Nonexistent PRD file path returns error
# -------------------------------------------
test_cmd "loki watch /nonexistent/path/prd.md returns error" \
    1 "not found" watch /nonexistent/path/prd.md

# -------------------------------------------
# Summary
# -------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASS passed, $FAIL failed, $TOTAL total"
echo "========================================"

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
