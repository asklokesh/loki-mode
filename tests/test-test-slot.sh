#!/usr/bin/env bash
# Guard for scripts/test-slot.sh: at most LOKI_ENGINE10_SLOTS (default 2) full
# test runs at once, a third waits and then runs, a slot is released on SIGTERM,
# a dead holder's slot is reclaimed, and removing the wait turns the guard red.
# Stub commands only; no bun, no real suite. Signals go to recorded PIDs only.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SLOT="$REPO_ROOT/scripts/test-slot.sh"
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# shellcheck disable=SC1091
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
unset LOKI_RUN_TMP
loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
T="$LOKI_RUN_TMP"
PIDS=""
cleanup() {
    local p
    for p in $PIDS; do kill "$p" 2>/dev/null || true; done
    loki_run_tmp_cleanup || echo "WARN: cleanup refused: $T"
}
trap cleanup EXIT

export LOKI_TEST_SLOT_POLL=0.1
unset LOKI_TEST_SLOT_HELD

# Stub: record start, wait for a release file, record done.
cat >"$T/stub.sh" <<'EOF'
#!/usr/bin/env bash
tag="$1"; d="$2"
echo "$tag" >>"$d/started"
while [ ! -f "$d/rel.$tag" ]; do sleep 0.1; done
echo "$tag" >>"$d/done"
EOF
chmod +x "$T/stub.sh"

# wait_for <seconds*10> <command...>: poll until the command succeeds
wait_for() {
    local n="$1" i=0; shift
    while [ "$i" -lt "$n" ]; do "$@" && return 0; sleep 0.1; i=$((i + 1)); done
    return 1
}
has_start() { grep -qx "$1" "$W/started" 2>/dev/null; }
slot_count() { find "$W/slots" -maxdepth 1 -name 'slot.*' 2>/dev/null | wc -l | tr -d ' '; }
waiting_line() { grep -q "waiting for a test slot" "$W/$1.err" 2>/dev/null; }
start() { # start <script> <tag>
    bash "$1" -- "$T/stub.sh" "$2" "$W" >"$W/$2.out" 2>"$W/$2.err" &
    LAST=$!
    PIDS="$PIDS $LAST"
}

newcase() { W="$T/case.$1"; mkdir -p "$W/slots"; : >"$W/started"; export LOKI_TEST_SLOT_DIR="$W/slots"; }

# scenario_three <script>: A and B run, C waits then runs after A is released.
scenario_three() {
    local script="$1" pa pb pc
    newcase "$2"
    export LOKI_ENGINE10_SLOTS=2
    start "$script" A; pa=$LAST
    start "$script" B; pb=$LAST
    wait_for 100 has_start A && wait_for 100 has_start B || return 1
    start "$script" C; pc=$LAST
    sleep 1
    # C must not have started while both slots are held
    has_start C && return 2
    waiting_line C || return 3
    : >"$W/rel.A"
    wait_for 100 has_start C || return 4
    : >"$W/rel.B"; : >"$W/rel.C"
    wait "$pa" "$pb" "$pc" 2>/dev/null
    [ "$(slot_count)" = 0 ] || return 5
    return 0
}

scenario_three "$SLOT" real; rc=$?
if [ "$rc" = 0 ]; then ok "three concurrent starts: two run, third waits with a visible line, then runs, all slots released"; else bad "three-start scenario failed at step $rc"; fi

# Mutation: delete the wait (acquire loop never waits) and the scenario must go red.
sed 's/^while ! try_acquire; do$/while false; do/' "$SLOT" >"$T/mutant-slot.sh"
if cmp -s "$SLOT" "$T/mutant-slot.sh"; then
    bad "mutation did not change the script (pattern drifted)"
else
    scenario_three "$T/mutant-slot.sh" mutant; rc=$?
    if [ "$rc" != 0 ]; then ok "mutation removing the wait is detected (step $rc)"; else bad "mutation removing the wait stayed green"; fi
fi

# SIGTERM of a holder releases its slot and lets the waiter run.
newcase term
export LOKI_ENGINE10_SLOTS=1
start "$SLOT" A; pa=$LAST
wait_for 100 has_start A || bad "term: A never started"
start "$SLOT" B; pb=$LAST
sleep 0.5
waiting_line B || bad "term: B did not announce waiting"
kill -TERM "$pa" 2>/dev/null
wait "$pa" 2>/dev/null; arc=$?
wait_for 100 has_start B && ok "SIGTERM of a holder frees its slot and the waiter runs (env override LOKI_ENGINE10_SLOTS=1 held B back)" || bad "term: B never started after A was terminated"
[ "$arc" = 143 ] && ok "terminated holder exits 143" || bad "terminated holder exit was $arc"
: >"$W/rel.A"; : >"$W/rel.B"
wait "$pb" 2>/dev/null
[ "$(slot_count)" = 0 ] && ok "no slot left after SIGTERM and normal exit" || bad "slots left behind: $(slot_count)"

# SIGINT (Ctrl-C) stops the wrapper promptly even when the child ignores INT
# and TERM, and frees the slot so the next waiter acquires it.
newcase int
export LOKI_ENGINE10_SLOTS=1
export LOKI_TEST_SLOT_GRACE=1
cat >"$T/stubint.sh" <<'EOF2'
#!/usr/bin/env bash
trap '' INT TERM
echo "$1" >>"$2/started"
while [ ! -f "$2/rel.$1" ]; do sleep 0.1; done
echo "$1" >>"$2/done"
EOF2
chmod +x "$T/stubint.sh"
# Job control gives the wrapper default signal dispositions, as a terminal
# Ctrl-C would; without it a background job starts with SIGINT ignored.
set -m
bash "$SLOT" -- "$T/stubint.sh" A "$W" >"$W/A.out" 2>"$W/A.err" &
pa=$!; PIDS="$PIDS $pa"
set +m
wait_for 100 has_start A || bad "int: A never started"
start "$SLOT" B; pb=$LAST
sleep 0.5
waiting_line B || bad "int: B did not announce waiting"
kill -INT "$pa" 2>/dev/null
i=0; while [ "$i" -lt 100 ] && kill -0 "$pa" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
if kill -0 "$pa" 2>/dev/null; then
    bad "SIGINT left the wrapper running (slot still held)"
    kill -KILL "$pa" 2>/dev/null
else
    wait "$pa" 2>/dev/null; arc=$?
    [ "$arc" = 130 ] && ok "SIGINT stops the wrapper within the grace period and exits 130" || bad "SIGINT exit was $arc"
fi
wait_for 100 has_start B && ok "after SIGINT the freed slot is acquired by the next waiter" || bad "int: B never acquired the slot after SIGINT"
: >"$W/rel.B"; wait "$pb" 2>/dev/null
unset LOKI_TEST_SLOT_GRACE
[ "$(slot_count)" = 0 ] && ok "no slot left after SIGINT case" || bad "slots left after SIGINT: $(slot_count)"

# Stale slot from a dead PID is reclaimed.
newcase stale
export LOKI_ENGINE10_SLOTS=2
true & dead=$!
wait "$dead" 2>/dev/null
mkdir "$W/slots/slot.1" "$W/slots/slot.2"
echo "$dead" >"$W/slots/slot.1/pid"
echo "$dead" >"$W/slots/slot.2/pid"
start "$SLOT" S; ps_=$LAST
start "$SLOT" T; pt=$LAST
if wait_for 100 has_start S && wait_for 100 has_start T; then ok "slots held by a dead PID are reclaimed"; else bad "stale slots were not reclaimed"; fi
waiting_line S && bad "stale reclaim printed a waiting line"
: >"$W/rel.S"; : >"$W/rel.T"
wait "$ps_" "$pt" 2>/dev/null

# A live holder's slot is never reclaimed.
newcase live
export LOKI_ENGINE10_SLOTS=1
sleep 30 & live=$!
PIDS="$PIDS $live"
mkdir "$W/slots/slot.1"; echo "$live" >"$W/slots/slot.1/pid"
start "$SLOT" L; pl=$LAST
sleep 1
has_start L && bad "live holder's slot was taken" || ok "a slot with a live holder is not reclaimed"
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null
wait_for 100 has_start L && ok "waiter runs once the live holder is gone" || bad "waiter never ran after holder exit"
: >"$W/rel.L"; wait "$pl" 2>/dev/null

# --full-only: a filtered run does not take or wait for a slot; exit code passes through.
newcase filtered
export LOKI_ENGINE10_SLOTS=1
sleep 30 & live=$!
PIDS="$PIDS $live"
mkdir "$W/slots/slot.1"; echo "$live" >"$W/slots/slot.1/pid"
if bash "$SLOT" --full-only -- bash -c 'exit 7' tests/foo.test.ts >/dev/null 2>&1; [ $? = 7 ]; then ok "filtered run bypasses the queue and keeps its exit code"; else bad "filtered run was queued or lost its exit code"; fi
mkdir -p "$W/bin"
printf '#!/bin/sh\necho ran-bun >"%s/bun.out"\n' "$W" >"$W/bin/bun"
chmod +x "$W/bin/bun"
PATH="$W/bin:$PATH" bash "$SLOT" --full-only -- bun test --timeout 15000 tests/engine10 >/dev/null 2>"$W/e10.err" &
pe=$!
PIDS="$PIDS $pe"
sleep 1
if grep -q "waiting for a test slot" "$W/e10.err" && [ ! -f "$W/bun.out" ]; then ok "bare tests/engine10 path counts as a full run and queues"; else bad "engine10 path was not queued"; fi
kill "$pe" 2>/dev/null; wait "$pe" 2>/dev/null
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null

# Child exit code passes through and the slot is released on error.
newcase rc
export LOKI_ENGINE10_SLOTS=2
bash "$SLOT" -- bash -c 'exit 5' >/dev/null 2>&1; rc=$?
if [ "$rc" = 5 ] && [ "$(slot_count)" = 0 ]; then ok "error exit passes through and releases the slot"; else bad "rc=$rc slots=$(slot_count)"; fi

echo "test-slot: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
