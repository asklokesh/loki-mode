#!/usr/bin/env bash
#===============================================================================
# Queue Consumer Tests (autonomy/queue-consumer.sh)
#
# Exercises the reference queue consumer end-to-end with NO real queue and NO
# real build. A fake `loki` PATH stub records its args and returns a configurable
# exit code; a fake `redis-cli` PATH stub serves a scripted item. Nothing real
# is started.
#
# Coverage:
#   1. file backend, oneshot: oldest item pulled, `loki start <spec>` called with
#      the right spec, item moved to done/.
#   2. file backend, oneshot: a terminal-failure build (exit 20) -> item moved to
#      failed/, NOT done/ (not acked).
#   3. file backend, oneshot: empty queue -> clean exit 0, loki never called.
#   4. JSON work item: {"spec":"owner/repo#7"} -> spec extracted, loki start
#      called with owner/repo#7.
#   5. redis backend, oneshot: item from a fake redis-cli LPOP -> loki start
#      called with that spec.
#   6. SIGTERM handling: a TERM during a build lets the current item finish and
#      ack (moved to done/), then the loop-mode consumer exits 0.
#===============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONSUMER="$PROJECT_DIR/autonomy/queue-consumer.sh"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1)); TOTAL=$((TOTAL + 1)); echo "  [PASS] $1"
}
fail() {
    FAIL=$((FAIL + 1)); TOTAL=$((TOTAL + 1)); echo "  [FAIL] $1"
    [ -n "${2:-}" ] && echo "         $2"
}

WORKROOT="$(mktemp -d "${TMPDIR:-/tmp}/loki-queueconsumer.XXXXXX")"
cleanup() { rm -rf "$WORKROOT" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "Queue Consumer Tests (autonomy/queue-consumer.sh)"
echo "================================================="
echo ""

# Sanity: the consumer must exist and parse.
if [ ! -f "$CONSUMER" ]; then
    fail "consumer not found at $CONSUMER"
    echo ""; echo "Results: $PASS/$TOTAL passed, $FAIL failed"; exit 1
fi
if bash -n "$CONSUMER"; then
    pass "consumer parses (bash -n)"
else
    fail "consumer failed bash -n"
    echo ""; echo "Results: $PASS/$TOTAL passed, $FAIL failed"; exit 1
fi

# -----------------------------------------------------------------------------
# Fake `loki` PATH stub. Records "start -- <spec>" to $LOKI_CALL_LOG and exits with
# $FAKE_LOKI_EXIT (default 0). Both are read from the environment at call time.
# -----------------------------------------------------------------------------
make_fake_loki() {
    local bindir="$1"
    mkdir -p "$bindir"
    cat > "$bindir/loki" <<'STUB'
#!/usr/bin/env bash
# Fake loki: log args, exit with FAKE_LOKI_EXIT (default 0).
printf '%s\n' "$*" >> "${LOKI_CALL_LOG:?LOKI_CALL_LOG must be set}"
exit "${FAKE_LOKI_EXIT:-0}"
STUB
    chmod +x "$bindir/loki"
}

# -----------------------------------------------------------------------------
# Fake `redis-cli` PATH stub. Serves a single scripted item on the FIRST LPOP /
# BLPOP, then "(nil)" / empty thereafter. The scripted item is read from
# $FAKE_REDIS_ITEM; a state file tracks whether it was already served.
# -----------------------------------------------------------------------------
make_fake_redis() {
    local bindir="$1"
    mkdir -p "$bindir"
    cat > "$bindir/redis-cli" <<'STUB'
#!/usr/bin/env bash
# Fake redis-cli. Recognizes LPOP and BLPOP; serves FAKE_REDIS_ITEM once.
state="${FAKE_REDIS_STATE:?FAKE_REDIS_STATE must be set}"
op=""
for a in "$@"; do
    case "$a" in
        LPOP|BLPOP) op="$a"; break ;;
    esac
done
if [ -f "$state" ]; then
    # Already served once -> empty queue.
    case "$op" in
        LPOP) echo "(nil)" ;;   # --no-raw style nil
        BLPOP) : ;;             # BLPOP timeout: print nothing
    esac
    exit 0
fi
: > "$state"   # mark served
case "$op" in
    LPOP)  printf '"%s"\n' "${FAKE_REDIS_ITEM:-}" ;;   # --no-raw quotes the value
    BLPOP) printf '%s\n%s\n' "loki-builds" "${FAKE_REDIS_ITEM:-}" ;;  # key, then value
    *) exit 0 ;;
esac
STUB
    chmod +x "$bindir/redis-cli"
}

# =============================================================================
# Test 1: file backend oneshot -- oldest item -> loki start <spec> -> done/
# =============================================================================
echo "Test 1: file oneshot pulls oldest item, calls loki start, moves to done/"
T1="$WORKROOT/t1"
BIN1="$T1/bin"
QDIR1="$T1/queue"
make_fake_loki "$BIN1"
mkdir -p "$QDIR1/pending"
# Two items; item-a is older (created first, older mtime).
printf 'owner/repo#1' > "$QDIR1/pending/item-a"
sleep 1
printf 'owner/repo#2' > "$QDIR1/pending/item-b"

LOG1="$T1/calls.log"; : > "$LOG1"
PATH="$BIN1:$PATH" \
    LOKI_CALL_LOG="$LOG1" FAKE_LOKI_EXIT=0 \
    LOKI_QUEUE_BACKEND=file LOKI_QUEUE_ONESHOT=1 LOKI_QUEUE_DIR="$QDIR1" \
    bash "$CONSUMER"
rc1=$?

if [ "$rc1" -ne 0 ]; then
    fail "Test 1 exit code" "expected 0, got $rc1"
elif ! grep -qx 'start -- owner/repo#1' "$LOG1"; then
    fail "Test 1 wrong/no loki call" "log=[$(cat "$LOG1")]"
elif [ -f "$QDIR1/done/item-a" ] && [ ! -f "$QDIR1/pending/item-a" ]; then
    # item-b must remain pending (oneshot processes exactly one)
    if [ -f "$QDIR1/pending/item-b" ]; then
        pass "oldest item processed (loki start -- owner/repo#1), moved to done/, item-b untouched"
    else
        fail "Test 1 processed more than one item" "item-b not in pending"
    fi
else
    fail "Test 1 item-a not moved to done/" "done=$(ls "$QDIR1/done" 2>/dev/null) pending=$(ls "$QDIR1/pending" 2>/dev/null)"
fi

# =============================================================================
# Test 2: file backend oneshot -- terminal failure (exit 20) -> failed/, no ack
# =============================================================================
echo "Test 2: file oneshot, build exit 20 -> moved to failed/, not done/"
T2="$WORKROOT/t2"
BIN2="$T2/bin"
QDIR2="$T2/queue"
make_fake_loki "$BIN2"
mkdir -p "$QDIR2/pending"
printf 'broken-spec' > "$QDIR2/pending/item-x"
LOG2="$T2/calls.log"; : > "$LOG2"
PATH="$BIN2:$PATH" \
    LOKI_CALL_LOG="$LOG2" FAKE_LOKI_EXIT=20 \
    LOKI_QUEUE_BACKEND=file LOKI_QUEUE_ONESHOT=1 LOKI_QUEUE_DIR="$QDIR2" \
    bash "$CONSUMER"
rc2=$?

if [ "$rc2" -ne 20 ]; then
    fail "Test 2 exit code should propagate terminal failure" "expected 20, got $rc2"
elif [ -f "$QDIR2/failed/item-x" ] && [ ! -f "$QDIR2/done/item-x" ]; then
    pass "terminal-failed item moved to failed/ (not done/), oneshot exited 20"
else
    fail "Test 2 item not in failed/" "failed=$(ls "$QDIR2/failed" 2>/dev/null) done=$(ls "$QDIR2/done" 2>/dev/null) processing=$(ls "$QDIR2/processing" 2>/dev/null)"
fi

# =============================================================================
# Test 3: file backend oneshot -- empty queue -> clean exit 0, no loki call
# =============================================================================
echo "Test 3: file oneshot, empty queue -> exit 0, loki never called"
T3="$WORKROOT/t3"
BIN3="$T3/bin"
QDIR3="$T3/queue"
make_fake_loki "$BIN3"
mkdir -p "$QDIR3/pending"   # empty
LOG3="$T3/calls.log"; : > "$LOG3"
PATH="$BIN3:$PATH" \
    LOKI_CALL_LOG="$LOG3" FAKE_LOKI_EXIT=0 \
    LOKI_QUEUE_BACKEND=file LOKI_QUEUE_ONESHOT=1 LOKI_QUEUE_DIR="$QDIR3" \
    bash "$CONSUMER"
rc3=$?

if [ "$rc3" -eq 0 ] && [ ! -s "$LOG3" ]; then
    pass "empty queue oneshot exited 0 with no loki call"
else
    fail "Test 3 empty-queue behavior" "rc=$rc3 log=[$(cat "$LOG3")]"
fi

# =============================================================================
# Test 4: JSON work item -- {"spec":"owner/repo#7"} -> loki start -- owner/repo#7
# =============================================================================
echo "Test 4: JSON item {\"spec\":...} -> spec extracted for loki start"
T4="$WORKROOT/t4"
BIN4="$T4/bin"
QDIR4="$T4/queue"
make_fake_loki "$BIN4"
mkdir -p "$QDIR4/pending"
printf '{"spec":"owner/repo#7","note":"ignored"}' > "$QDIR4/pending/item-json"
LOG4="$T4/calls.log"; : > "$LOG4"
PATH="$BIN4:$PATH" \
    LOKI_CALL_LOG="$LOG4" FAKE_LOKI_EXIT=0 \
    LOKI_QUEUE_BACKEND=file LOKI_QUEUE_ONESHOT=1 LOKI_QUEUE_DIR="$QDIR4" \
    bash "$CONSUMER"
rc4=$?

if [ "$rc4" -eq 0 ] && grep -qx 'start -- owner/repo#7' "$LOG4"; then
    pass "JSON item spec extracted; loki start -- owner/repo#7"
else
    fail "Test 4 JSON spec extraction" "rc=$rc4 log=[$(cat "$LOG4")]"
fi

# =============================================================================
# Test 5: redis backend oneshot -- fake redis-cli serves one item
# =============================================================================
echo "Test 5: redis oneshot pulls one item from fake redis-cli, calls loki start"
T5="$WORKROOT/t5"
BIN5="$T5/bin"
make_fake_loki "$BIN5"
make_fake_redis "$BIN5"
LOG5="$T5/calls.log"; : > "$LOG5"
REDIS_STATE5="$T5/redis.state"
PATH="$BIN5:$PATH" \
    LOKI_CALL_LOG="$LOG5" FAKE_LOKI_EXIT=0 \
    FAKE_REDIS_ITEM="owner/repo#42" FAKE_REDIS_STATE="$REDIS_STATE5" \
    LOKI_QUEUE_BACKEND=redis LOKI_QUEUE_ONESHOT=1 LOKI_QUEUE_KEY=loki-builds \
    bash "$CONSUMER"
rc5=$?

if [ "$rc5" -eq 0 ] && grep -qx 'start -- owner/repo#42' "$LOG5"; then
    pass "redis oneshot: spec from LPOP -> loki start owner/repo#42"
else
    fail "Test 5 redis oneshot" "rc=$rc5 log=[$(cat "$LOG5")]"
fi

# Redis empty-queue oneshot: second run (state file present) -> no call, exit 0.
LOG5b="$T5/calls-b.log"; : > "$LOG5b"
PATH="$BIN5:$PATH" \
    LOKI_CALL_LOG="$LOG5b" FAKE_LOKI_EXIT=0 \
    FAKE_REDIS_ITEM="owner/repo#42" FAKE_REDIS_STATE="$REDIS_STATE5" \
    LOKI_QUEUE_BACKEND=redis LOKI_QUEUE_ONESHOT=1 LOKI_QUEUE_KEY=loki-builds \
    bash "$CONSUMER"
rc5b=$?
if [ "$rc5b" -eq 0 ] && [ ! -s "$LOG5b" ]; then
    pass "redis oneshot on empty queue: exit 0, no loki call"
else
    fail "Test 5b redis empty oneshot" "rc=$rc5b log=[$(cat "$LOG5b")]"
fi

# =============================================================================
# Test 6: SIGTERM during a build -> current item finishes + acked, loop exits 0
# =============================================================================
echo "Test 6: SIGTERM mid-build lets current item ack, loop exits 0"
T6="$WORKROOT/t6"
BIN6="$T6/bin"
QDIR6="$T6/queue"
mkdir -p "$BIN6" "$QDIR6/pending"
# Fake loki that sleeps briefly (so we can SIGTERM mid-build), logs, exits 0.
cat > "$BIN6/loki" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${LOKI_CALL_LOG:?}"
sleep 2
exit 0
STUB
chmod +x "$BIN6/loki"
printf 'owner/repo#99' > "$QDIR6/pending/item-term"
LOG6="$T6/calls.log"; : > "$LOG6"

# Launch the LOOP-mode consumer in the background, then SIGTERM it while the
# (sleeping) build is in flight. The graceful path must let the build finish,
# move the item to done/, and exit 0.
PATH="$BIN6:$PATH" \
    LOKI_CALL_LOG="$LOG6" \
    LOKI_QUEUE_BACKEND=file LOKI_QUEUE_DIR="$QDIR6" LOKI_QUEUE_POLL_SEC=1 \
    bash "$CONSUMER" &
consumer_pid=$!
# Wait for the build to actually start (loki logged its call) before signalling.
waited=0
while [ ! -s "$LOG6" ] && [ "$waited" -lt 50 ]; do
    sleep 0.1; waited=$((waited + 1))
done
kill -TERM "$consumer_pid" 2>/dev/null
wait "$consumer_pid"
rc6=$?

if [ "$rc6" -eq 0 ] && [ -f "$QDIR6/done/item-term" ] && grep -qx 'start -- owner/repo#99' "$LOG6"; then
    pass "SIGTERM mid-build: item finished + moved to done/, consumer exited 0"
elif [ ! -s "$LOG6" ]; then
    fail "Test 6 build never started before SIGTERM (timing)" "rc=$rc6"
else
    fail "Test 6 graceful shutdown" "rc=$rc6 done=$(ls "$QDIR6/done" 2>/dev/null) processing=$(ls "$QDIR6/processing" 2>/dev/null)"
fi

# Test 7: flag-injection guard -- a work item that is a single loki flag (e.g.
# "--ship") must be REJECTED as malformed (terminal failure), NOT passed to
# loki start where it would be parsed as a flag and silently change build mode.
QDIR7=$(mktemp -d "${TMPDIR:-/tmp}/loki-qc7-XXXXXX")
BIN7=$(mktemp -d "${TMPDIR:-/tmp}/loki-qc7-bin-XXXXXX")
make_fake_loki "$BIN7"
mkdir -p "$QDIR7/pending"
LOG7="$QDIR7/loki-calls.log"
: > "$LOG7"
printf -- '--ship\n' > "$QDIR7/pending/evil-flag.txt"
PATH="$BIN7:$PATH" \
    LOKI_QUEUE_BACKEND=file LOKI_QUEUE_DIR="$QDIR7" LOKI_QUEUE_ONESHOT=1 \
    LOKI_CALL_LOG="$LOG7" FAKE_LOKI_EXIT=0 \
    bash "$CONSUMER" >/dev/null 2>&1
rc7=$?
# loki must NOT have been invoked at all (no 'start' logged), and the item must
# be treated as a terminal failure (moved to failed/, exit 20).
if [ ! -s "$LOG7" ] && [ -f "$QDIR7/failed/evil-flag.txt" ] && [ "$rc7" -eq 20 ]; then
    pass "flag-injection guard: '--ship' item rejected (no loki call, moved to failed/, exit 20)"
else
    fail "Test 7 flag-injection guard" "rc=$rc7 log=[$(cat "$LOG7" 2>/dev/null)] failed=$(ls "$QDIR7/failed" 2>/dev/null)"
fi
rm -rf "$QDIR7" "$BIN7"

echo ""
echo "================================================="
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
