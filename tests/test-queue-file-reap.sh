#!/usr/bin/env bash
# The FILE queue backend must recover from a crashed worker.
#
# THE DEFECT, reproduced before the fix was written:
#
#   mkdir -p /tmp/fq/{pending,processing,done,failed}
#   echo '{"spec":"x"}' > /tmp/fq/processing/item-dead.json
#   LOKI_QUEUE_BACKEND=file LOKI_QUEUE_DIR=/tmp/fq queue-consumer.sh --reap
#   -> "ERROR: --reap is redis-only"   exit 2, item stranded FOREVER
#
# The redis backend got a visibility-timeout reaper; the file backend did not.
# A worker that died mid-build stranded its item, so an unattended fleet on the
# file backend stalled on every dead worker.
#
# TEST 2 IS THE LOAD-BEARING ONE. Requeuing a FRESH item means a live build gets
# built twice -- worse than the stranding this fixes. A reaper that requeued
# everything would pass a naive "does the item come back" test.
#
# TEST 4 GUARDS THE CLAIM STAMP. `mv` is a rename(2) and PRESERVES mtime, so an
# item that waited in pending/ behind a backlog longer than the timeout arrives
# in processing/ already looking stale. Without the touch-on-claim in
# file_claim_oldest, the reaper requeues it out from under a running worker --
# and it fires on exactly the busy queues that need a reaper.
#
# No broker needed: this suite runs everywhere, unlike the redis one.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
QC="$REPO_ROOT/autonomy/queue-consumer.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: the file backend recovers a crashed worker's item"

[ -f "$QC" ] || { echo "  FAIL: $QC missing"; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/loki-fqreap.XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# Fresh queue dir per case, so one case cannot leak into the next.
mkq() {
    Q="$WORK/q$1"
    rm -rf "$Q"
    mkdir -p "$Q/pending" "$Q/processing" "$Q/done" "$Q/failed"
}
reap() { LOKI_QUEUE_BACKEND=file LOKI_QUEUE_DIR="$Q" bash "$QC" --reap 2>/dev/null; }
# Count regular files across both dirs: an item must never be DELETED.
total() { find "$Q/pending" "$Q/processing" -type f 2>/dev/null | wc -l | tr -d ' '; }

# --- 1: a STALE item is requeued -------------------------------------------
mkq 1
printf '%s' '{"spec":"x"}' > "$Q/processing/item-dead.json"
touch -t 202001010000 "$Q/processing/item-dead.json"   # far older than any timeout
before="$(total)"
out="$(reap)"; rc=$?

if [ "$rc" -eq 0 ]; then
    ok "--reap exits 0 on the file backend (was 2: 'reap is redis-only')"
else
    bad "--reap exited $rc on the file backend; the item is still stranded"
fi
if [ -f "$Q/pending/item-dead.json" ] && [ ! -e "$Q/processing/item-dead.json" ]; then
    ok "a stale item is moved from processing/ back to pending/"
else
    bad "the stale item was not requeued (pending/ miss or still in processing/)"
fi
if [ "$(total)" = "$before" ]; then
    ok "the item still exists after reaping (nothing was deleted)"
else
    bad "file count changed $before -> $(total): the reaper destroyed an item"
fi
case "$out" in
    *"requeued 1"*"left 0"*) ok "stdout reports what it did: $out" ;;
    *) bad "stdout did not report requeued/left counts: '$out'" ;;
esac

# --- 2: THE SAFETY GUARD -- a FRESH item is NEVER requeued ------------------
# A live build requeued means the user's work is built twice.
mkq 2
printf '%s' '{"spec":"live"}' > "$Q/processing/item-live.json"   # mtime = now
before="$(total)"
out="$(reap)"

if [ -f "$Q/processing/item-live.json" ] && [ ! -e "$Q/pending/item-live.json" ]; then
    ok "a FRESH item is left in flight (a live build is never built twice)"
else
    bad "the reaper requeued a running build -- the user gets it built twice"
fi
[ "$(total)" = "$before" ] && ok "the fresh item was not deleted either" \
                           || bad "file count changed on the fresh path"
case "$out" in
    *"requeued 0"*"left 1"*) ok "stdout reports the fresh item as left in flight" ;;
    *) bad "stdout wrong for the fresh case: '$out'" ;;
esac

# --- 3: the timeout is the knob, and it is honoured -------------------------
# Age must strictly EXCEED the timeout, matching redis_reap's `-gt`. An item
# whose age equals the timeout is still in flight, so a 2s-old item is reaped at
# VISIBILITY_SEC=1 but not at VISIBILITY_SEC=7200. Both directions are asserted:
# a one-sided check passes on a reaper that ignores the knob and reaps always.
mkq 3
printf '%s' '{"spec":"x"}' > "$Q/processing/item-a.json"
touch -t "$(date -v-2S '+%Y%m%d%H%M.%S' 2>/dev/null || date -d '2 seconds ago' '+%Y%m%d%H%M.%S')" \
      "$Q/processing/item-a.json" 2>/dev/null
LOKI_QUEUE_BACKEND=file LOKI_QUEUE_DIR="$Q" LOKI_QUEUE_VISIBILITY_SEC=1 \
    bash "$QC" --reap >/dev/null 2>&1
if [ -f "$Q/pending/item-a.json" ]; then
    ok "an item older than VISIBILITY_SEC is reaped (the knob is honoured)"
else
    bad "VISIBILITY_SEC=1 did not reap a 2s-old item: the timeout knob is ignored"
fi

mkq 3b
printf '%s' '{"spec":"x"}' > "$Q/processing/item-b.json"
touch -t "$(date -v-2S '+%Y%m%d%H%M.%S' 2>/dev/null || date -d '2 seconds ago' '+%Y%m%d%H%M.%S')" \
      "$Q/processing/item-b.json" 2>/dev/null
reap >/dev/null
if [ -f "$Q/processing/item-b.json" ]; then
    ok "the SAME item under the default 7200s timeout is left alone"
else
    bad "a 2s-old item was reaped at a 7200s timeout: the timeout is not read"
fi

# --- 4: a BACKLOGGED item keeps its claim time, not its enqueue time --------
# Regression guard for the touch-on-claim in file_claim_oldest. `mv` preserves
# mtime, so without the stamp this item looks stale the instant it is claimed.
mkq 4
printf '%s' '{"spec":"backlogged"}' > "$Q/pending/item-old.json"
touch -t 202001010000 "$Q/pending/item-old.json"   # sat in the backlog for years
claim_probe="$(
    QUEUE_DIR="$Q"
    # Source only the function under test; the script runs main() at load.
    eval "$(sed -n '/^file_claim_oldest()/,/^}/p' "$QC")"
    log() { :; }
    file_claim_oldest
)"
if [ -n "$claim_probe" ] && [ -f "$Q/processing/item-old.json" ]; then
    out="$(reap)"
    if [ -f "$Q/processing/item-old.json" ] && [ ! -e "$Q/pending/item-old.json" ]; then
        ok "a just-claimed backlogged item is NOT reaped (claim time, not enqueue time)"
    else
        bad "a backlogged item was reaped the moment it was claimed -- a live build, requeued"
    fi
else
    bad "could not claim the backlogged item; probe setup failed"
fi

# --- 5: a name collision never overwrites an item ---------------------------
# The item is not lost and the pending copy is not clobbered.
mkq 5
printf '%s' 'IN-PROCESSING' > "$Q/processing/dup.json"
touch -t 202001010000 "$Q/processing/dup.json"
printf '%s' 'IN-PENDING' > "$Q/pending/dup.json"
before="$(total)"
out="$(reap)"

if [ "$(cat "$Q/pending/dup.json" 2>/dev/null)" = "IN-PENDING" ] \
   && [ -f "$Q/processing/dup.json" ]; then
    ok "a pending/ name collision leaves both items intact (never overwrite)"
else
    bad "a name collision destroyed an item"
fi
[ "$(total)" = "$before" ] && ok "collision case deleted nothing" \
                           || bad "file count changed $before -> $(total) on collision"

# --- 6: an unreadable mtime KEEPS the item, and the reaper survives ---------
# Reproduces a LINUX-ONLY hazard on any platform. `stat -f` means
# --file-system on GNU coreutils and EXITS 0 printing a mount point, so a
# `-f`-first probe returns non-numeric output on every Linux worker. Stubbing
# `stat` to print a non-number and exit 0 is exactly that condition.
# MEASURED against the unguarded version: the arithmetic aborts the reaper
# under `set -uo pipefail` (rc=1, empty stdout, nothing reaped) -- a DEAD
# reaper, not a duplicate build. Either way the item must stay put.
mkq 6
printf '%s' '{"spec":"live"}' > "$Q/processing/item-live.json"
STUB="$WORK/stub6"
mkdir -p "$STUB"
printf '#!/bin/sh\necho /tmp\nexit 0\n' > "$STUB/stat"
chmod +x "$STUB/stat"
before="$(total)"
out="$(PATH="$STUB:$PATH" LOKI_QUEUE_BACKEND=file LOKI_QUEUE_DIR="$Q" \
       bash "$QC" --reap 2>/dev/null)"
if [ -f "$Q/processing/item-live.json" ] && [ ! -e "$Q/pending/item-live.json" ]; then
    ok "a non-numeric mtime KEEPS the item (never fail open into a duplicate build)"
else
    bad "a non-numeric mtime requeued a live item -- the guard fails OPEN"
fi
[ "$(total)" = "$before" ] && ok "the unreadable-mtime item was not deleted" \
                           || bad "file count changed on the unreadable-mtime path"
case "$out" in
    *"requeued 0"*) ok "stdout reports 0 requeued when the claim time is unreadable" ;;
    *) bad "stdout wrong for the unreadable-mtime case: '$out'" ;;
esac

# --- 7: an empty / absent processing dir says so, and does not error --------
mkq 7
out="$(reap)"; rc=$?
[ "$rc" -eq 0 ] && ok "an empty queue reaps cleanly (exit 0)" \
                || bad "an empty queue exited $rc"
case "$out" in
    *"nothing in flight"*) ok "an empty queue says 'nothing in flight'" ;;
    *) bad "empty queue message wrong: '$out'" ;;
esac

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
