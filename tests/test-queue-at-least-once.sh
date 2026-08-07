#!/usr/bin/env bash
# A crashed worker must not silently lose the user's build.
#
# THE DEFECT, proven against a real redis before the fix was written:
#
#   RPUSH loki-builds '{"spec":"build a todo app"}'   -> LLEN 1
#   LPOP  loki-builds                                 -> worker holds it
#   <worker OOM-killed / node evicted / kill -9>
#   LLEN  loki-builds                                 -> 0
#
# The build is gone and NOTHING records that it existed. For a product whose
# thesis is "we hand you a receipt you can check", silently losing the work is
# the worst available failure: no receipt, no error, no queue entry to retry.
#
# LMOVE pops and records in-flight in ONE atomic step, so a crash between the
# two is impossible. A dead worker leaves its item in <key>:processing, where an
# operator or a reaper can re-drive it.
#
# TEST 2 IS THE LOAD-BEARING ONE: the ack must happen ONLY after the build
# succeeds. Acking first restores the exact data loss this exists to prevent,
# and it would still pass a naive "does the queue drain" test.
#
# THIS SUITE SKIPS WITHOUT A REAL REDIS, DELIBERATELY. Both bugs found while
# building this were invisible to a mock: `redis-cli --no-raw` escapes the INNER
# quotes of a JSON payload, so the item was mangled AND the string handed to
# LREM no longer matched what redis stored, silently acking nothing. A fake
# would have passed. A skip that says why is honest; a green mock is not.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
QC="$REPO_ROOT/autonomy/queue-consumer.sh"

PASS=0; FAIL=0
ok()  { echo "  PASS: $1"; PASS=$((PASS+1)); }
bad() { echo "  FAIL: $1"; FAIL=$((FAIL+1)); }

echo "TEST: a crashed worker does not lose the build"

[ -f "$QC" ] || { echo "  FAIL: $QC missing"; exit 1; }

# --- Static assertions: run everywhere, no broker needed --------------------
# These are the ones that catch a regression even on a machine with no redis.

if grep -q "LMOVE" "$QC"; then
    ok "the consumer uses LMOVE (atomic pop + in-flight record)"
else
    bad "no LMOVE -- the pop is not atomic with recording the item"
fi
if grep -q "RPOPLPUSH" "$QC"; then
    ok "there is a pre-6.2 fallback (RPOPLPUSH)"
else
    bad "no fallback for redis < 6.2"
fi
# Order is the property, not the presence of an ack.
_consume="$(sed -n '/^redis_consume_one()/,/^}/p' "$QC")"
_run_at="$(printf '%s' "$_consume" | grep -n "run_build" | head -1 | cut -d: -f1)"
_ack_at="$(printf '%s' "$_consume" | grep -n "redis_ack" | head -1 | cut -d: -f1)"
if [ -n "$_run_at" ] && [ -n "$_ack_at" ] && [ "$_run_at" -lt "$_ack_at" ]; then
    ok "the ack comes AFTER run_build, not before"
else
    bad "ack ordering is wrong (run=$_run_at ack=$_ack_at) -- acking first loses the build on crash"
fi
if printf '%s' "$_consume" | grep -q 'rc" -eq 0'; then
    ok "the ack is conditional on a zero exit"
else
    bad "the item is acked regardless of outcome -- a failed build cannot be re-driven"
fi
# --no-raw mangles JSON. This is a real bug that shipped for one edit cycle.
_pop="$(sed -n '/^redis_pop()/,/^}/p' "$QC")"
if printf '%s' "$_pop" | grep -E "LMOVE|RPOPLPUSH" | grep -q -- "--no-raw"; then
    bad "LMOVE/RPOPLPUSH uses --no-raw, which escapes inner quotes and breaks both the payload and the ack"
else
    ok "the in-flight pop uses raw output (JSON survives intact)"
fi
# Opt-out, not opt-in: at-least-once must be the default.
if grep -q 'LOKI_QUEUE_ACK:-1' "$QC"; then
    ok "at-least-once is the DEFAULT (LOKI_QUEUE_ACK=0 opts out)"
else
    bad "at-least-once is not the default -- most users keep the lossy path"
fi

# --- Live assertions: require a real broker ---------------------------------
_PORT="${LOKI_TEST_REDIS_PORT:-6399}"
if ! command -v redis-cli >/dev/null 2>&1 \
   || ! redis-cli -p "$_PORT" ping >/dev/null 2>&1; then
    echo ""
    echo "  SKIPPED the live checks: no redis on port $_PORT."
    echo "  This is a SKIP, not a pass. Both bugs found building this were"
    echo "  invisible without a real broker (--no-raw quote escaping broke the"
    echo "  payload and silently acked nothing). Start one with:"
    echo "    redis-server --port $_PORT --save '' --appendonly no"
    echo ""
    echo "  Passed: $PASS   Failed: $FAIL"
    [ "$FAIL" -eq 0 ]
    exit $?
fi

_R() { redis-cli -p "$_PORT" "$@"; }
_K="loki-attest-$$"
_R DEL "$_K" "${_K}:processing" >/dev/null

# Load the real functions rather than reimplementing them.
_env() {
    QUEUE_URL="redis://127.0.0.1:$_PORT" QUEUE_KEY="$_K" ONESHOT=1 bash -c "
        source <(sed -n '/^_redis_unquote()/,/^}/p;/^redis_pop()/,/^}/p;/^redis_ack()/,/^}/p' '$QC')
        $1
    "
}

# --- LIVE 1: the item survives a crash -------------------------------------
_R RPUSH "$_K" '{"spec":"build a todo app"}' >/dev/null
_item="$(_env 'redis_pop')"
if [ "$(_R LLEN "${_K}:processing")" = "1" ]; then
    ok "a popped item is recorded in-flight (survives a worker crash)"
else
    bad "the item vanished on pop -- the crash would lose the build"
fi
if [ "$_item" = '{"spec":"build a todo app"}' ]; then
    ok "the payload survives intact (no escaped quotes)"
else
    bad "the payload was mangled: $_item"
fi

# --- LIVE 2: THE GUARD -- a crash leaves it recoverable --------------------
# No ack (simulating the crash): the item must still be there.
if [ "$(_R LLEN "${_K}:processing")" = "1" ]; then
    ok "without an ack the item stays recoverable"
else
    bad "the item was cleared without an ack"
fi
# Re-drive is a single LMOVE back.
_R LMOVE "${_K}:processing" "$_K" RIGHT LEFT >/dev/null
if [ "$(_R LLEN "$_K")" = "1" ] && [ "$(_R LLEN "${_K}:processing")" = "0" ]; then
    ok "the in-flight item can be re-driven back onto the queue"
else
    bad "re-drive failed: main=$(_R LLEN "$_K") processing=$(_R LLEN "${_K}:processing")"
fi

# --- LIVE 3: a successful ack actually clears it ---------------------------
# The bug that shipped for one edit cycle: LREM against a mangled string is a
# silent no-op, so processing/ grew without bound and every item looked stuck.
_item="$(_env 'redis_pop')"
_env "redis_ack '$_item'" >/dev/null 2>&1
if [ "$(_R LLEN "${_K}:processing")" = "0" ]; then
    ok "an ack removes the item from the in-flight list"
else
    bad "the ack was a silent no-op -- in-flight grows forever and items look stuck"
fi

# --- LIVE 4: the opt-out really opts out -----------------------------------
_R DEL "$_K" "${_K}:processing" >/dev/null
_R RPUSH "$_K" '{"spec":"x"}' >/dev/null
LOKI_QUEUE_ACK=0 QUEUE_URL="redis://127.0.0.1:$_PORT" QUEUE_KEY="$_K" ONESHOT=1 bash -c "
    source <(sed -n '/^_redis_unquote()/,/^}/p;/^redis_pop()/,/^}/p;/^redis_ack()/,/^}/p' '$QC')
    redis_pop
" >/dev/null 2>&1
if [ "$(_R LLEN "${_K}:processing")" = "0" ]; then
    ok "LOKI_QUEUE_ACK=0 restores the legacy path (no in-flight list)"
else
    bad "the opt-out still writes an in-flight record"
fi

_R DEL "$_K" "${_K}:processing" >/dev/null

echo ""
echo "  Passed: $PASS   Failed: $FAIL"
[ "$FAIL" -eq 0 ]
