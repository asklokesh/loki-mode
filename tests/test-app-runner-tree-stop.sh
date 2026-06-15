#!/usr/bin/env bash
#===============================================================================
# Test: app-runner non-setsid subtree stop + crash-count reset
#
# Covers two fixes in autonomy/app-runner.sh:
#
#   BUG 1 (HIGH, default macOS path): the non-setsid stop fallback used
#          `pkill -TERM -P <pid>` which reaches ONLY ONE level of children, so
#          deep workers (npm -> sh -> node -> workers) survived as orphans and
#          kept the listening port bound, blocking the next start. The fix walks
#          the descendant tree transitively (_app_runner_collect_descendants /
#          _app_runner_kill_tree) and signals the whole subtree.
#
#   BUG 3 (MEDIUM): _APP_RUNNER_CRASH_COUNT was never reset, so 5 CUMULATIVE
#          (non-consecutive) recovered crashes tripped the breaker on a HEALTHY
#          app. The fix resets the count to 0 on a confirmed-healthy observation
#          (compose-healthy path and process-alive path).
#
# Safety proof: the descendant walk only ever follows parent->child links from
# OUR pid, so an unrelated SIBLING process started before the tree MUST survive
# the stop. (Group-kill is deliberately NOT used in the non-setsid path because
# the app inherits the orchestrator's process group.)
#===============================================================================

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Stub loki logging primitives so we can source app-runner.sh standalone.
log_error() { :; }
log_info()  { :; }
log_warn()  { :; }
log_step()  { :; }

PASS=0
FAIL=0

note_pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS+1)); }
note_fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL+1)); }

finish() {
    printf '\nResult: %d passed, %d failed\n' "$PASS" "$FAIL"
    [ "$FAIL" -eq 0 ]
}

# shellcheck disable=SC1091
TARGET_DIR=""
source "$REPO_ROOT/autonomy/app-runner.sh"

# Track every pid we spawn so we can guarantee cleanup even if the test aborts.
SPAWNED_PIDS=()
cleanup() {
    local p
    for p in "${SPAWNED_PIDS[@]:-}"; do
        [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true
    done
    # Best-effort sweep of any leftover descendants.
    for p in "${SPAWNED_PIDS[@]:-}"; do
        if [ -n "$p" ]; then
            local -a _d=()
            local _x
            while IFS= read -r _x; do [ -n "$_x" ] && _d+=("$_x"); done \
                < <(_app_runner_collect_descendants "$p" 2>/dev/null)
            _app_runner_signal_pids KILL "$p" "${_d[@]:-}" 2>/dev/null || true
        fi
    done
}
trap cleanup EXIT

#------------------------------------------------------------------------------
# Build a real multi-level sleeper tree: parent -> child -> grandchild.
#
# We need the spawned background process to actually FORK children (not just
# exec a single sleep) so the test exercises transitive descendant collection.
# A bash subshell that backgrounds nested subshells gives us a genuine
# parent->child->grandchild chain whose leaves are sleeps.
#------------------------------------------------------------------------------
spawn_tree() {
    # The outer process backgrounds a child which backgrounds a grandchild.
    # Each level uses `<cmd> & wait` (NOT a trailing bare command) so bash does
    # NOT apply its last-command exec optimization, which would otherwise
    # collapse levels and hide the deeper workers. This models the real
    # npm -> sh -> node -> workers chain the BUG 1 fix must reach.
    # stdio is redirected to /dev/null so the backgrounded sleeper tree does NOT
    # inherit (and hold open) the test's stdout, which would block a process
    # capturing the test output.
    bash -c '
        (
            (
                sleep 120 &
                wait
            ) &
            sleep 120 &
            wait
        ) &
        sleep 120 &
        wait
    ' >/dev/null 2>&1 &
    printf '%s\n' "$!"
}

wait_for_tree() {
    # Wait until the root has at least one descendant (the fork settled).
    local root="$1"
    local i=0
    while [ "$i" -lt 50 ]; do
        if [ -n "$(_app_runner_collect_descendants "$root")" ]; then
            return 0
        fi
        sleep 0.1
        i=$(( i + 1 ))
    done
    return 1
}

#==============================================================================
# TEST 1: descendant collection finds the full multi-level tree
#==============================================================================
ROOT_PID=$(spawn_tree)
SPAWNED_PIDS+=("$ROOT_PID")

if wait_for_tree "$ROOT_PID"; then
    mapfile -t DESC < <(_app_runner_collect_descendants "$ROOT_PID")
    # Expect at least 2 descendants (child + grandchild; bash -c adds wrapper
    # subshells too, so the real count is typically higher).
    if [ "${#DESC[@]}" -ge 2 ]; then
        note_pass "collect_descendants finds multi-level tree (${#DESC[@]} descendants)"
    else
        note_fail "collect_descendants found only ${#DESC[@]} descendants (want >= 2)"
    fi
    # Record the snapshot for the post-kill assertion below.
    KILL_SNAPSHOT=("$ROOT_PID" "${DESC[@]}")
else
    note_fail "tree did not spawn descendants in time"
    KILL_SNAPSHOT=("$ROOT_PID")
fi

#==============================================================================
# TEST 2 (BUG 1): the non-setsid stop reaps the ENTIRE tree.
# SAFETY: an unrelated sibling started independently MUST survive.
#==============================================================================
# Start an unrelated sibling that has NO ancestral relationship to ROOT_PID.
sleep 120 >/dev/null 2>&1 &
SIBLING_PID=$!
SPAWNED_PIDS+=("$SIBLING_PID")

# Sanity: sibling is alive and is NOT in the root's descendant set.
SIBLING_IN_TREE=false
for d in "${KILL_SNAPSHOT[@]:-}"; do
    [ "$d" = "$SIBLING_PID" ] && SIBLING_IN_TREE=true
done
if kill -0 "$SIBLING_PID" 2>/dev/null && [ "$SIBLING_IN_TREE" = false ]; then
    note_pass "sibling is alive and outside the target tree (pre-kill)"
else
    note_fail "sibling precondition failed (alive=$(kill -0 "$SIBLING_PID" 2>/dev/null && echo y || echo n) in_tree=$SIBLING_IN_TREE)"
fi

# Drive the REAL shipped function (app_runner_stop) on the non-setsid path, not
# a re-implementation that can drift. Set up the globals it reads and a temp
# TARGET_DIR so its .loki writes land in a throwaway dir.
STOP_DIR="$(mktemp -d -t loki-stop.XXXXXX)"
TARGET_DIR="$STOP_DIR"
_APP_RUNNER_DIR=""
_app_runner_dir
_APP_RUNNER_IS_DOCKER=false
_APP_RUNNER_HAS_SETSID=false
_APP_RUNNER_METHOD="npm run dev"
_APP_RUNNER_PID="$ROOT_PID"
echo "$ROOT_PID" > "$_APP_RUNNER_DIR/app.pid"
app_runner_stop
sleep 0.3
rm -rf "$STOP_DIR"

# Assert EVERY member of the captured tree snapshot is gone.
LEAKED=()
for p in "${KILL_SNAPSHOT[@]:-}"; do
    [ -n "$p" ] || continue
    if kill -0 "$p" 2>/dev/null; then
        LEAKED+=("$p")
    fi
done
if [ "${#LEAKED[@]}" -eq 0 ]; then
    note_pass "non-setsid stop reaped the ENTIRE multi-level tree (no orphans)"
else
    note_fail "tree members survived the stop (leaked: ${LEAKED[*]})"
fi

# Assert the unrelated sibling SURVIVED (kill scope safety proof).
if kill -0 "$SIBLING_PID" 2>/dev/null; then
    note_pass "SAFETY: unrelated sibling survived the subtree stop"
else
    note_fail "SAFETY VIOLATION: stop killed an unrelated sibling process"
fi
kill -KILL "$SIBLING_PID" 2>/dev/null || true

#==============================================================================
# TEST 3 (safety): collect/kill on a bogus root (0/1/empty/non-numeric) is a
# no-op and never sweeps unrelated processes.
#==============================================================================
sleep 120 >/dev/null 2>&1 &
GUARD_SIBLING=$!
SPAWNED_PIDS+=("$GUARD_SIBLING")
for bogus in "" 0 1 abc; do
    out=$(_app_runner_collect_descendants "$bogus")
    if [ -n "$out" ]; then
        note_fail "collect_descendants('$bogus') returned pids (should be empty): $out"
    fi
done
# signal_pids must skip empty/0/1 sentinels and never touch an unrelated pid.
_app_runner_signal_pids KILL "" 0 1
if kill -0 "$GUARD_SIBLING" 2>/dev/null; then
    note_pass "SAFETY: signal_pids on empty/0/1 sentinels left unrelated process alive"
else
    note_fail "SAFETY VIOLATION: signal_pids on bogus sentinels killed an unrelated process"
fi
kill -KILL "$GUARD_SIBLING" 2>/dev/null || true

#==============================================================================
# TEST 3b (BUG 1, the motivating case): a deep worker that TRAPS SIGTERM, under
# an intermediate ancestor that dies on TERM, must STILL be reaped by the stop.
#
# This is the case a naive fix misses: the worker ignores TERM and survives the
# TERM phase, its ancestors die, the worker reparents to init, and a fix that
# re-walks from the (now dead) root finds nothing and SKIPS the KILL phase. The
# snapshot-once design captures the worker pre-signal and SIGKILLs it (SIGKILL
# cannot be trapped), so the port-holder cannot survive.
#==============================================================================
# Outer (dies on TERM) -> child wait (dies on TERM) -> grandchild traps TERM.
bash -c '
    (
        bash -c "trap \"\" TERM; sleep 120 & wait" &
        wait
    ) &
    wait
' >/dev/null 2>&1 &
TRAP_ROOT=$!
SPAWNED_PIDS+=("$TRAP_ROOT")

# Wait for the trapping grandchild to exist, and remember the full snapshot.
TRAP_OK=false
for _i in $(seq 1 50); do
    mapfile -t TRAP_DESC < <(_app_runner_collect_descendants "$TRAP_ROOT")
    if [ "${#TRAP_DESC[@]}" -ge 2 ]; then TRAP_OK=true; break; fi
    sleep 0.1
done
TRAP_SNAPSHOT=("$TRAP_ROOT" "${TRAP_DESC[@]:-}")

if [ "$TRAP_OK" = true ]; then
    # Drive the real stop on the non-setsid path.
    TRAP_DIR="$(mktemp -d -t loki-trap.XXXXXX)"
    TARGET_DIR="$TRAP_DIR"
    _APP_RUNNER_DIR=""
    _app_runner_dir
    _APP_RUNNER_IS_DOCKER=false
    _APP_RUNNER_HAS_SETSID=false
    _APP_RUNNER_METHOD="npm run dev"
    _APP_RUNNER_PID="$TRAP_ROOT"
    echo "$TRAP_ROOT" > "$_APP_RUNNER_DIR/app.pid"
    app_runner_stop
    sleep 0.3
    rm -rf "$TRAP_DIR"

    TRAP_LEAKED=()
    for p in "${TRAP_SNAPSHOT[@]:-}"; do
        [ -n "$p" ] || continue
        kill -0 "$p" 2>/dev/null && TRAP_LEAKED+=("$p")
    done
    if [ "${#TRAP_LEAKED[@]}" -eq 0 ]; then
        note_pass "BUG 1 motivating: TERM-trapping reparented worker was force-killed"
    else
        note_fail "BUG 1 motivating: TERM-trapping worker survived stop (leaked: ${TRAP_LEAKED[*]})"
    fi
else
    note_fail "BUG 1 motivating: trap tree did not spawn the deep worker in time"
fi
# Belt-and-braces cleanup of the trap tree.
for p in "${TRAP_SNAPSHOT[@]:-}"; do [ -n "$p" ] && kill -KILL "$p" 2>/dev/null || true; done

#==============================================================================
# TEST 4 (BUG 3): crash count resets on a confirmed-healthy watchdog tick.
# Process-alive path (no docker mock needed).
#==============================================================================
WD_DIR="$(mktemp -d -t loki-wd.XXXXXX)"
TARGET_DIR="$WD_DIR"
# Reset module globals into the non-docker, process-alive shape.
_APP_RUNNER_IS_DOCKER=false
_APP_RUNNER_METHOD="npm run dev"
_APP_RUNNER_DIR=""        # forces app_runner_watchdog -> _app_runner_dir to set it
_app_runner_dir

# Spawn a healthy long-lived process and register it as the app.
sleep 120 >/dev/null 2>&1 &
HEALTHY_PID=$!
SPAWNED_PIDS+=("$HEALTHY_PID")
_APP_RUNNER_PID="$HEALTHY_PID"
echo "$HEALTHY_PID" > "$_APP_RUNNER_DIR/app.pid"

# Simulate 4 prior recovered crashes (one below the breaker threshold of 5).
_APP_RUNNER_CRASH_COUNT=4

# A healthy watchdog tick should observe the process alive and reset the count.
app_runner_watchdog
if [ "$_APP_RUNNER_CRASH_COUNT" -eq 0 ]; then
    note_pass "BUG 3: crash count reset to 0 on healthy process-alive watchdog tick"
else
    note_fail "BUG 3: crash count not reset (got $_APP_RUNNER_CRASH_COUNT, want 0)"
fi
kill -KILL "$HEALTHY_PID" 2>/dev/null || true
rm -rf "$WD_DIR"

#==============================================================================
# TEST 5 (BUG 3 intent): breaker still fires on 5 CONSECUTIVE deaths.
# Verifies the reset did not neuter the circuit breaker.
#==============================================================================
WD_DIR2="$(mktemp -d -t loki-wd2.XXXXXX)"
TARGET_DIR="$WD_DIR2"
_APP_RUNNER_IS_DOCKER=false
_APP_RUNNER_METHOD="npm run dev"
_APP_RUNNER_DIR=""
_app_runner_dir
# Point at a dead pid so the watchdog sees a crash. Use a pid that is very
# unlikely to exist; if it happens to exist, kill -0 succeeding would skew the
# test, so pick one and verify it's dead.
DEAD_PID=999999
while kill -0 "$DEAD_PID" 2>/dev/null; do DEAD_PID=$(( DEAD_PID + 1 )); done
# Pre-load the count at 4 with the process already dead: ONE more dead tick
# reaches 5 and must mark crashed (return 1) WITHOUT a reset in between.
_APP_RUNNER_CRASH_COUNT=4
_APP_RUNNER_PID="$DEAD_PID"
echo "$DEAD_PID" > "$_APP_RUNNER_DIR/app.pid"
# Stub app_runner_start so the breaker path is the only outcome we measure and
# no real app is launched. (Not reached at count>=5, but safe.)
app_runner_start() { return 0; }
if app_runner_watchdog; then
    note_fail "BUG 3 intent: breaker did not fire at 5 consecutive crashes (returned 0)"
else
    if grep -q '"status": "crashed"' "$_APP_RUNNER_DIR/state.json" 2>/dev/null; then
        note_pass "BUG 3 intent: breaker fires at 5 consecutive crashes (state=crashed)"
    else
        note_fail "BUG 3 intent: breaker returned non-zero but state not 'crashed'"
    fi
fi
rm -rf "$WD_DIR2"

finish
