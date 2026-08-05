#!/usr/bin/env bash
# Test: emit.sh self-reaper (telemetry never outlives what it observes)
#
# WHY THIS TEST EXISTS. v8.1.0 fixed one unbounded wait in emit.sh. AFTER that
# release shipped, 63 orphaned emit.sh processes were measured alive on a dev
# machine, oldest 10h51m, each burning ~5% CPU. Patching each individual hang is
# an arms race; the watchdog caps EVERY path instead.
#
# The invariant under test is deliberately cause-independent: whatever wedges
# emit.sh -- a lock race, a stuck stat, an NFS stall, a future regression -- the
# process must not survive past its deadline. That is what makes this testable
# without reproducing any specific race, which the race-based probes could not do
# (they passed identically on pre-fix and fixed code, proving nothing).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Overridable so this test can be pointed at an ALTERNATE emit.sh -- specifically
# a pre-fix copy, to confirm the test actually fails without the watchdog. A test
# that passes against both the fixed and unfixed implementation proves nothing,
# which is exactly how the earlier race-based probes wasted an investigation.
EMIT="${LOKI_EMIT_UNDER_TEST:-$REPO_ROOT/events/emit.sh}"

PASS=0
FAIL=0
pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }
fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-emit-reaper.XXXXXX")"
cleanup() {
    pkill -9 -f "$WORK" 2>/dev/null || true
    rm -rf "$WORK" 2>/dev/null || true
}
trap cleanup EXIT

echo "T1 -- a wedged emit.sh is killed at its deadline"

# Wedge emit.sh deterministically WITHOUT relying on a race: hold the append
# lock with a live, non-stale holder. The staleness reclaim (30s) cannot fire
# inside the 3s deadline, so the emit genuinely blocks -- which is exactly the
# state the 63 orphans were observed in.
# The serialized append targets $LOKI_DIR/events.jsonl (emit.sh:283), NOT the
# per-event files under events/pending/. Holding the wrong lock is why the first
# version of this test reported "terminated in 0s" -- the non-vacuity assertion
# caught that the wedge was never actually applied.
#
# PLATFORM SPLIT, and it is load-bearing. emit.sh takes one of two mutually
# exclusive paths: `flock` when flock(1) exists (Linux/CI), and a mkdir mutex
# otherwise (macOS ships no flock(1), so that is the path real Mac users take).
# Holding only the lockdir wedges ONLY the mkdir path -- which is why this test
# passed on macOS and then failed its own non-vacuity check on ubuntu CI with
# "emit returned in 0s -- it never blocked". Wedge whichever path this platform
# actually takes; the non-vacuity assertion below is what caught the gap.
mkdir -p "$WORK/.loki/events/pending"
EVENTS_FILE="$WORK/.loki/events.jsonl"
LOCKDIR="$EVENTS_FILE.lockdir"

if command -v flock >/dev/null 2>&1; then
    # flock path: emit.sh binds FD 9 to $EVENTS_FILE.lock and takes an exclusive
    # lock with `-w 5`. Hold that same lock for longer than emit's own deadline
    # so the emit genuinely waits on it.
    LOCK_TARGET="$EVENTS_FILE.lock"
    : > "$LOCK_TARGET"
    ( flock -x 9; sleep 30 ) 9>"$LOCK_TARGET" &
    TOUCHER=$!
    # Give the holder a moment to actually acquire before the emit starts,
    # otherwise the emit can win the lock and the wedge never applies.
    sleep 1
else
    mkdir -p "$LOCKDIR"
    # Keep mtime CURRENT so the lock never looks stale for the test's duration.
    ( while :; do touch "$LOCKDIR" 2>/dev/null || true; sleep 0.2; done ) &
    TOUCHER=$!
fi

start=$(date +%s)
(
    cd "$WORK" || exit 1
    LOKI_DIR="$WORK/.loki" LOKI_EMIT_MAX_SECONDS=3 \
        bash "$EMIT" test_event cli probe key=value
) >/dev/null 2>&1 &
EMIT_PID=$!

# Independent backstop: if the reaper does NOT work, this kills the test's own
# child so the suite cannot hang forever. Its firing is what marks the failure.
( sleep 12; kill -9 $EMIT_PID 2>/dev/null ) &
BACKSTOP=$!

wait $EMIT_PID 2>/dev/null
end=$(date +%s)
elapsed=$((end - start))
kill -9 $TOUCHER $BACKSTOP 2>/dev/null || true

if [ "$elapsed" -le 8 ]; then
    pass "wedged emit terminated in ${elapsed}s (deadline 3s, tolerance 8s)"
else
    fail "wedged emit ran ${elapsed}s -- watchdog did not reap it"
fi

# NON-VACUITY. If emit.sh returned instantly it might never have blocked at all,
# in which case the test would pass without exercising the watchdog. A genuinely
# wedged process must take at least about its deadline.
if [ "$elapsed" -ge 2 ]; then
    pass "non-vacuity: emit actually blocked (${elapsed}s >= 2s), so the reaper is what ended it"
else
    fail "non-vacuity: emit returned in ${elapsed}s -- it never blocked, watchdog untested"
fi

echo
echo "T2 -- the watchdog does not kill a HEALTHY emit"

# The reaper must be invisible on the normal path. A watchdog that also kills
# successful runs would silently drop telemetry, trading one bug for a quieter one.
rm -rf "$WORK/.loki"
mkdir -p "$WORK/.loki/events/pending"
start2=$(date +%s)
(
    cd "$WORK" || exit 1
    LOKI_DIR="$WORK/.loki" LOKI_EMIT_MAX_SECONDS=10 \
        bash "$EMIT" test_event cli healthy key=value
) >/dev/null 2>&1
rc2=$?
end2=$(date +%s)
elapsed2=$((end2 - start2))

if [ "$rc2" -eq 0 ]; then
    pass "healthy emit exited 0 (not killed by its own watchdog)"
else
    fail "healthy emit exited $rc2 -- watchdog interfered with the normal path"
fi

if [ "$elapsed2" -lt 5 ]; then
    pass "healthy emit was fast (${elapsed2}s), so the watchdog adds no latency"
else
    fail "healthy emit took ${elapsed2}s -- watchdog is delaying the normal path"
fi

# The event must actually have been written: a "fast, exit 0" run that wrote
# nothing would satisfy the two checks above while doing no work.
if find "$WORK/.loki" -name "*.json*" -type f 2>/dev/null | grep -q .; then
    pass "healthy emit actually wrote an event (not a silent no-op)"
else
    fail "healthy emit wrote no event file -- it exited 0 without doing its job"
fi

echo
echo "T3 -- no watchdog process outlives the emit it guards"

# The orphan class this whole fix targets: leftover background processes. The
# watchdog itself must not become one.
sleep 2
strays=$(pgrep -f "$WORK" 2>/dev/null | wc -l | tr -d ' ')
if [ "$strays" = "0" ]; then
    pass "no stray processes remain after both emits"
else
    fail "$strays stray process(es) still alive -- the watchdog leaks"
fi

echo
echo "==============================================================="
echo "Results: $PASS passed, $FAIL failed, $((PASS + FAIL)) total"
[ "$FAIL" -eq 0 ]
