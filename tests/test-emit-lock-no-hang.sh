#!/usr/bin/env bash
# Test: telemetry must NEVER outlive the thing it observes.
#
# THE BUG (measured on the founder's machine, 2026-07-29)
#   `loki` spawns events/emit.sh per CLI invocation. Its append helper locked
#   events.jsonl two ways, and BOTH could hang:
#
#     1. `flock -x 9` with NO timeout. A holder killed mid-write (a reaped CI
#        run, a Ctrl-C'd build) left every later emit blocked FOREVER.
#     2. The mkdir-mutex fallback -- the path real users take, because macOS
#        ships no flock(1) -- checked staleness only AFTER exhausting all 500
#        attempts, forking a `perl` sleep helper on every one of them.
#
#   Observed: 59 orphaned emit.sh processes, oldest alive 21 HOURS, machine at
#   0% idle with fans at full. Measured cost of ONE append against an already
#   stale lock: 10 seconds and ~500 forked processes, returning rc=1.
#
#   This is the worst possible failure for a trust product: the layer that
#   proves work happened was itself hanging forever and burning the CPU.
#
# Proven directions:
#   STALE   : an append against a stale lock completes FAST and returns 0.
#             RED before the fix (10s, rc=1).
#   CLEAN   : the uncontended path stays fast (no regression).
#   WRITES  : the line actually lands -- degrading must not mean losing data.
#   NOFORK  : no fork storm; the sleep must not spawn a process per attempt.
#   SOURCE  : flock is invoked WITH a timeout, so the blocking form cannot
#             return via a future edit.
#   VANISH  : a lock dir that disappears mid-check does not wedge the loop.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMIT="$SCRIPT_DIR/../events/emit.sh"

PASS=0
FAIL=0
ok()  { printf '  PASS: %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL: %s\n' "$1"; FAIL=$((FAIL+1)); }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loki-emitlock-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

echo "=== emit.sh append lock: never hang ==="

# Run one append in a child shell so a hang cannot wedge this suite.
# Echoes "<rc> <elapsed_seconds>".
run_append() {
    local dir="$1"
    cat > "$dir/probe.sh" <<PROBE
LOKI_EMIT_LIB_ONLY=1 . "$EMIT"
S=\$(date +%s)
safe_append_event_jsonl "\$PWD/.loki/events.jsonl" '{"t":1}'
RC=\$?
E=\$(date +%s)
echo "\$RC \$((E-S))"
PROBE
    ( cd "$dir" && timeout 60 bash probe.sh 2>/dev/null ) || echo "TIMEOUT 60"
}

# ---- STALE: the exact shape that hung ------------------------------------
S1="$TMP/stale"
mkdir -p "$S1/.loki/events.jsonl.lockdir"
read -r rc elapsed <<<"$(run_append "$S1")"
if [ "$rc" = "TIMEOUT" ]; then
    bad "append HUNG against a stale lock (the original bug)"
elif [ "$rc" -eq 0 ] 2>/dev/null; then
    ok "stale lock: append returns 0 (was rc=1)"
else
    bad "stale lock: append returned rc=$rc, expected 0"
fi
if [ "$elapsed" != "TIMEOUT" ] && [ "${elapsed:-99}" -le 8 ] 2>/dev/null; then
    ok "stale lock: completed in ${elapsed}s (was 10s)"
else
    bad "stale lock: took ${elapsed}s -- staleness check is not running early"
fi
if [ -s "$S1/.loki/events.jsonl" ]; then
    ok "stale lock: the line was still written (no data loss)"
else
    bad "stale lock: nothing written -- degrading must not drop the event"
fi

# ---- CLEAN: uncontended path must stay fast ------------------------------
C="$TMP/clean"
mkdir -p "$C/.loki"
read -r crc celapsed <<<"$(run_append "$C")"
if [ "$crc" = "TIMEOUT" ]; then
    bad "uncontended append hung"
elif [ "$crc" -eq 0 ] 2>/dev/null && [ "${celapsed:-99}" -le 3 ] 2>/dev/null; then
    ok "uncontended append is fast (${celapsed}s) and returns 0"
else
    bad "uncontended append: rc=$crc elapsed=${celapsed}s"
fi

# ---- NOFORK: no process-per-attempt storm --------------------------------
# The old fallback forked a perl sleep helper on each of 500 attempts. Count
# perl processes spawned while one stale-lock append runs.
N="$TMP/nofork"
mkdir -p "$N/.loki/events.jsonl.lockdir"
# `grep -c` on a no-match exits 1, so `|| echo 0` appends a SECOND line and the
# arithmetic below sees "0\n0". Count with a pipeline that always emits exactly
# one integer.
count_perl() { ps -eo comm 2>/dev/null | grep '[p]erl' | wc -l | tr -d ' '; }
before="$(count_perl)"
run_append "$N" >/dev/null
after="$(count_perl)"
if [ "$after" -le $(( before + 20 )) ]; then
    ok "no fork storm (perl procs ${before} -> ${after}; old path forked ~500)"
else
    bad "fork storm: perl procs went ${before} -> ${after}"
fi

# ---- SOURCE: flock must never be called in its blocking form -------------
if grep -qE 'flock[[:space:]]+-w[[:space:]]*[0-9]' "$EMIT"; then
    ok "flock is invoked with a timeout (-w)"
else
    bad "flock has no -w timeout -- the infinite-block form is back"
fi
if grep -qE 'flock[[:space:]]+-x[[:space:]]+9[[:space:]]*$' "$EMIT"; then
    bad "a bare blocking 'flock -x 9' is present"
else
    ok "no bare blocking flock call remains"
fi

# ---- VANISH: lock dir disappearing mid-check must not wedge --------------
V="$TMP/vanish"
mkdir -p "$V/.loki/events.jsonl.lockdir"
( sleep 1; rmdir "$V/.loki/events.jsonl.lockdir" 2>/dev/null ) &
_vpid=$!
read -r vrc velapsed <<<"$(run_append "$V")"
wait "$_vpid" 2>/dev/null || true
if [ "$vrc" = "TIMEOUT" ]; then
    bad "append wedged when the lock dir vanished mid-check"
elif [ "$vrc" -eq 0 ] 2>/dev/null; then
    ok "lock dir vanishing mid-check is handled (rc=0, ${velapsed}s)"
else
    bad "vanishing lock: rc=$vrc"
fi

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
