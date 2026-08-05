#!/usr/bin/env bash
# Focused regressions for provider deadlines and confined shell portability.

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="$ROOT/autonomy/run.sh"
TMPROOT="$(mktemp -d -t loki-deadline.XXXXXX)"
PASS=0
FAIL=0
cleanup() {
    for pid_file in "$TMPROOT/descendant.pid" "$TMPROOT/denied.pid" "$TMPROOT/idle-child.pid" "$TMPROOT/session-child.pid" "$TMPROOT/reparented-child.pid" "$TMPROOT/success-child.pid"; do
        [ -s "$pid_file" ] || continue
        pid="$(cat "$pid_file")"
        kill -9 -- "-$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
    done
    rm -rf "$TMPROOT" 2>/dev/null || true
}
trap cleanup EXIT
ok() { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$1"; }

DEADLINE_CODE="$(awk '/^_loki_with_deadline\(\)/,/^\}/' "$RUN_SH")"
MUTATION_CODE="$(awk '/^_loki_workspace_changed_since_iteration\(\)/,/^\}/' "$RUN_SH")"
SCRIPT_DIR="$ROOT/autonomy"
log_error() { :; }
eval "$DEADLINE_CODE"
eval "$MUTATION_CODE"

if ! command -v python3 >/dev/null 2>&1; then
    bad "hard deadline utility is unavailable"
else
    start=$(date +%s)
    LOKI_DEADLINE_KILL_GRACE=1 _loki_with_deadline 1 bash -c '
        trap "" TERM
        (trap "" TERM; while :; do sleep 10; done) &
        echo "$!" > "$1"
        wait
    ' _ "$TMPROOT/descendant.pid"
    rc=$?
    elapsed=$(( $(date +%s) - start ))
    if [ "$rc" -eq 124 ] && [ "$elapsed" -le 4 ]; then
        ok "TERM-ignoring provider is killed within deadline plus grace"
    else
        bad "hard deadline returned rc=$rc after ${elapsed}s"
    fi
    descendant="$(cat "$TMPROOT/descendant.pid" 2>/dev/null || true)"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        [ -z "$descendant" ] || ! kill -0 "$descendant" 2>/dev/null || sleep 0.05
    done
    if [ -n "$descendant" ] && kill -0 "$descendant" 2>/dev/null; then
        bad "deadline left a descendant process running"
    else
        ok "deadline reconciles the provider process session"
    fi
fi

session_child_file="$TMPROOT/session-child.pid"
repair_marker="$TMPROOT/repair-started"
overlap_marker="$TMPROOT/session-child-overlap"
start=$(date +%s)
session_output="$(_loki_with_deadline 1 bash -c '
    python3 -c '\''
import os, pathlib, signal, sys, time
os.setpgrp()
signal.signal(signal.SIGTERM, signal.SIG_IGN)
pathlib.Path(sys.argv[1]).write_text(str(os.getpid()))
repair = pathlib.Path(sys.argv[2])
while not repair.exists():
    time.sleep(0.01)
pathlib.Path(sys.argv[3]).write_text("overlap")
'\'' "$1" "$2" "$3" </dev/null >/dev/null 2>&1 &
    while [ ! -s "$1" ]; do sleep 0.01; done
    while :; do printf "active\n"; sleep 0.1; done
' _ "$session_child_file" "$repair_marker" "$overlap_marker" 2>&1)"
session_rc=$?
session_elapsed=$(( $(date +%s) - start ))
session_child="$(cat "$session_child_file" 2>/dev/null || true)"
: > "$repair_marker"
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$session_child" ] || ! kill -0 "$session_child" 2>/dev/null || sleep 0.05
done
sleep 0.2
if [ "$session_rc" -eq 124 ] && [ "$session_elapsed" -le 4 ] \
   && [ -n "$session_child" ] \
   && ! kill -0 "$session_child" 2>/dev/null \
   && [ ! -e "$overlap_marker" ]; then
    ok "deadline reconciles a separate process group before repair can begin"
else
    bad "attempt boundary returned rc=$session_rc after ${session_elapsed}s child=$session_child overlap=$([ -e "$overlap_marker" ] && printf yes || printf no) output=$session_output"
fi

# A fast intermediate forks a TERM-ignoring worker into a new session and then
# exits. The deadline must retain that worker's birth-token identity after it is
# reparented, kill it before returning, and prevent post-timeout mutation.
reparented_child_file="$TMPROOT/reparented-child.pid"
reparented_marker="$TMPROOT/reparented-repair-started"
delayed_mutation="$TMPROOT/reparented-delayed-mutation"
reparented_output="$(_loki_with_deadline 1 python3 - \
    "$reparented_child_file" "$reparented_marker" "$delayed_mutation" <<'PY' 2>&1
import os
import pathlib
import signal
import sys
import time

intermediate = os.fork()
if intermediate == 0:
    worker = os.fork()
    if worker != 0:
        os._exit(0)
    os.setsid()
    devnull = os.open(os.devnull, os.O_RDWR)
    for descriptor in (0, 1, 2):
        os.dup2(devnull, descriptor)
    if devnull > 2:
        os.close(devnull)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    pathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding="utf-8")
    marker = pathlib.Path(sys.argv[2])
    while not marker.exists():
        time.sleep(0.01)
    pathlib.Path(sys.argv[3]).write_text("late", encoding="utf-8")
    while True:
        time.sleep(1)
while True:
    print("active", flush=True)
    time.sleep(0.05)
PY
)"
reparented_rc=$?
reparented_child="$(cat "$reparented_child_file" 2>/dev/null || true)"
: > "$reparented_marker"
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$reparented_child" ] || ! kill -0 "$reparented_child" 2>/dev/null || sleep 0.05
done
sleep 0.25
if [ "$reparented_rc" -eq 124 ] \
   && [ -n "$reparented_child" ] \
   && ! kill -0 "$reparented_child" 2>/dev/null \
   && [ ! -e "$delayed_mutation" ]; then
    ok "deadline reconciles a reparented new-session lineage before repair"
else
    bad "reparented descendant escaped containment (rc=$reparented_rc child=$reparented_child alive=$(kill -0 "$reparented_child" 2>/dev/null && printf yes || printf no) mutation=$([ -e "$delayed_mutation" ] && printf yes || printf no) output=$reparented_output)"
fi

if python3 - "$ROOT/autonomy/lib/deadline.py" <<'PY'
import importlib.util
import signal
import sys

spec = importlib.util.spec_from_file_location("loki_deadline", sys.argv[1])
module = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(module)
signals = []
module._process_identity = lambda _pid: "new-birth-token"
module.os.kill = lambda pid, sig: signals.append((pid, sig))
module._signal_process((4242, "old-birth-token"), signal.SIGKILL)
assert signals == []
PY
then
    ok "deadline never signals a reused PID with a different birth token"
else
    bad "deadline process signaling ignored birth-token identity"
fi

# A zero-exit leader that leaves a descendant is not a successful attempt. The
# helper must reconcile the child, prove quiescence, and return rc=125 before a
# caller can begin its next action.
success_child_file="$TMPROOT/success-child.pid"
success_marker="$TMPROOT/success-next-action"
success_mutation="$TMPROOT/success-delayed-mutation"
_loki_with_deadline 5 python3 - \
    "$success_child_file" "$success_marker" "$success_mutation" <<'PY' \
    >/dev/null 2>&1
import os
import pathlib
import signal
import sys
import time

child = os.fork()
if child == 0:
    os.setsid()
    devnull = os.open(os.devnull, os.O_RDWR)
    for descriptor in (0, 1, 2):
        os.dup2(devnull, descriptor)
    if devnull > 2:
        os.close(devnull)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    pathlib.Path(sys.argv[1]).write_text(str(os.getpid()), encoding="utf-8")
    while not pathlib.Path(sys.argv[2]).exists():
        time.sleep(0.01)
    pathlib.Path(sys.argv[3]).write_text("late", encoding="utf-8")
    while True:
        time.sleep(1)

deadline = time.monotonic() + 0.2
while not pathlib.Path(sys.argv[1]).exists() and time.monotonic() < deadline:
    time.sleep(0.001)
raise SystemExit(0)
PY
success_rc=$?
success_child="$(cat "$success_child_file" 2>/dev/null || true)"
: > "$success_marker"
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$success_child" ] || ! kill -0 "$success_child" 2>/dev/null || sleep 0.05
done
sleep 0.25
if [ "$success_rc" -eq 125 ] \
   && [ -n "$success_child" ] \
   && ! kill -0 "$success_child" 2>/dev/null \
   && [ ! -e "$success_mutation" ]; then
    ok "zero-exit leader with a surviving descendant fails closed before next action"
else
    bad "zero-exit leader hid a surviving descendant (rc=$success_rc child=$success_child alive=$(kill -0 "$success_child" 2>/dev/null && printf yes || printf no) mutation=$([ -e "$success_mutation" ] && printf yes || printf no))"
fi

active_output="$(LOKI_DEADLINE_IDLE_TIMEOUT=1 _loki_with_deadline 4 bash -c '
    for value in 1 2 3 4 5; do
        printf "tick-%s\n" "$value"
        sleep 0.4
    done
' 2>&1)"
active_rc=$?
if [ "$active_rc" -eq 0 ] \
   && printf '%s\n' "$active_output" | grep -q 'tick-5'; then
    ok "active output renews the idle lease"
else
    bad "active output lease returned rc=$active_rc output=$active_output"
fi

channel_error="$TMPROOT/channel-error.log"
channel_output="$(_loki_with_deadline 3 bash -c '
    printf "stdout-only\n"
    printf "stderr-only\n" >&2
' 2> "$channel_error")"
channel_rc=$?
if [ "$channel_rc" -eq 0 ] \
   && [ "$channel_output" = "stdout-only" ] \
   && [ "$(cat "$channel_error")" = "stderr-only" ]; then
    ok "deadline forwarding preserves stdout and stderr channels"
else
    bad "deadline forwarding mixed stdout and stderr"
fi

idle_child_file="$TMPROOT/idle-child.pid"
start=$(date +%s)
idle_output="$(LOKI_DEADLINE_IDLE_TIMEOUT=1 _loki_with_deadline 5 bash -c '
    trap "" TERM
    (trap "" TERM; while :; do sleep 10; done) &
    echo "$!" > "$1"
    wait
' _ "$idle_child_file" 2>&1)"
idle_rc=$?
idle_elapsed=$(( $(date +%s) - start ))
# The idle path floors at idle_timeout(1) + kill_grace(2) + quiescence(0.2) = 3.2s,
# so the old `-le 3` bound could only pass on the lucky side of second-truncation.
# What the bound was really proving is that the IDLE deadline fired and not the
# hard cap, so assert that directly: strictly under hard_seconds(5).
if [ "$idle_rc" -eq 124 ] && [ "$idle_elapsed" -lt 5 ] \
   && printf '%s\n' "$idle_output" | grep -q '"reason":"idle_timeout"'; then
    ok "silent provider hits the idle deadline"
else
    bad "idle deadline returned rc=$idle_rc after ${idle_elapsed}s output=$idle_output"
fi
idle_child="$(cat "$idle_child_file" 2>/dev/null || true)"
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$idle_child" ] || ! kill -0 "$idle_child" 2>/dev/null || sleep 0.05
done
if [ -n "$idle_child" ] && kill -0 "$idle_child" 2>/dev/null; then
    bad "idle deadline left a descendant process running"
else
    ok "idle deadline reconciles the provider process session"
fi

start=$(date +%s)
hard_output="$(LOKI_DEADLINE_IDLE_TIMEOUT=1 _loki_with_deadline 2 bash -c '
    while :; do printf "active\n"; sleep 0.2; done
' 2>&1)"
hard_rc=$?
hard_elapsed=$(( $(date +%s) - start ))
if [ "$hard_rc" -eq 124 ] && [ "$hard_elapsed" -le 4 ] \
   && printf '%s\n' "$hard_output" | grep -q '"reason":"hard_timeout"'; then
    ok "hard cap wins despite continuous activity"
else
    bad "hard cap returned rc=$hard_rc after ${hard_elapsed}s output=$hard_output"
fi

if [ "$(uname -s)" = "Darwin" ] && [ -x /usr/bin/sandbox-exec ]; then
    /usr/bin/sandbox-exec \
        -p '(version 1) (allow default) (deny signal)' \
        python3 "$ROOT/autonomy/lib/deadline.py" 1 1 -- bash -c '
            trap "" TERM
            echo "$$" > "$1"
            sleep 5
        ' _ "$TMPROOT/denied.pid"
    denied_rc=$?
    if [ "$denied_rc" -eq 125 ]; then
        ok "Seatbelt signal denial fails closed"
    else
        bad "Seatbelt signal denial returned rc=$denied_rc"
    fi
    denied_pid="$(cat "$TMPROOT/denied.pid" 2>/dev/null || true)"
    if [ -n "$denied_pid" ]; then
        kill -9 -- "-$denied_pid" 2>/dev/null \
            || kill -9 "$denied_pid" 2>/dev/null \
            || true
    fi
fi

external_child_file="$TMPROOT/external-child.pid"
python3 "$ROOT/autonomy/lib/deadline.py" 60 1 -- bash -c '
    trap "" TERM
    echo "$$" > "$1"
    while :; do sleep 10; done
' _ "$external_child_file" &
deadline_helper=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -s "$external_child_file" ] && break
    sleep 0.05
done
external_child="$(cat "$external_child_file" 2>/dev/null || true)"
if [ -n "$external_child" ] && python3 -c '
import os, sys
helper, child = map(int, sys.argv[1:])
assert os.getpgid(child) == child
assert os.getsid(child) == child
assert os.getsid(child) != os.getsid(helper)
' "$deadline_helper" "$external_child"; then
    ok "provider attempt has a dedicated process session"
else
    bad "provider attempt session boundary is missing"
fi
kill -TERM "$deadline_helper" 2>/dev/null || true
wait "$deadline_helper" 2>/dev/null
external_rc=$?
if [ "$external_rc" -eq 143 ]; then
    ok "supervisor TERM is forwarded through the deadline helper"
else
    bad "deadline helper returned rc=$external_rc after supervisor TERM"
fi
if [ -n "$external_child" ] && kill -0 "$external_child" 2>/dev/null; then
    bad "supervisor TERM left the provider process session running"
else
    ok "supervisor TERM leaves no provider process behind"
fi

repo="$TMPROOT/repo"
mkdir -p "$repo/.loki/state"
git -C "$repo" init -q
git -C "$repo" config user.name test
git -C "$repo" config user.email test@example.invalid
printf 'base\n' > "$repo/app.txt"
git -C "$repo" add app.txt
git -C "$repo" commit -qm base
sha="$(git -C "$repo" rev-parse HEAD)"
if TARGET_DIR="$repo" _loki_workspace_changed_since_iteration "$sha"; then
    bad "clean workspace reported a mutation"
else
    ok "clean workspace is recognized as unchanged"
fi
printf 'runtime\n' > "$repo/.loki/state/runtime.txt"
if TARGET_DIR="$repo" _loki_workspace_changed_since_iteration "$sha"; then
    bad "build-local runtime state reported a source mutation"
else
    ok "build-local runtime state is ignored"
fi
printf 'changed\n' > "$repo/app.txt"
if TARGET_DIR="$repo" _loki_workspace_changed_since_iteration "$sha"; then
    ok "source edit is recognized as a mutation"
else
    bad "source edit was missed"
fi

if grep -nE '<\(|>\(|/dev/fd' "$RUN_SH" >/dev/null 2>&1; then
    bad "run.sh still relies on descriptor-backed path substitution"
else
    ok "run.sh confined helpers avoid descriptor-backed path substitution"
fi
if grep -q 'provider_deadline_no_mutation' "$RUN_SH" \
   && grep -q 'provider_failure_no_mutation' "$RUN_SH"; then
    ok "supervised provider failure short-circuits when no source changed"
else
    bad "supervised no-mutation failure short-circuit is missing"
fi

PIPELINE_CODE="$(awk '/^_loki_provider_pipeline_exit_code\(\)/,/^\}/' "$RUN_SH")"
eval "$PIPELINE_CODE"
pipeline_log="$TMPROOT/provider-pipeline.log"
LOKI_DEADLINE_IDLE_TIMEOUT=1 _loki_with_deadline 5 bash -c '
    trap "printf provider-final\\n; exit 1" TERM
    sleep 10
' 2>&1 | tee "$pipeline_log" | python3 -c 'import sys; list(sys.stdin); raise SystemExit(1)'
pipeline_status=("${PIPESTATUS[@]}")
pipeline_resolved="$(_loki_provider_pipeline_exit_code \
    "${pipeline_status[0]:-125}" "${pipeline_status[1]:-125}" \
    "${pipeline_status[2]:-125}")"
if [ "$pipeline_resolved" = 124 ] \
   && [ "${pipeline_status[0]:-}" = 124 ] \
   && grep -q '"type":"loki_provider_deadline"' "$pipeline_log" \
   && grep -q '"reason":"idle_timeout"' "$pipeline_log" \
   && [ "$(_loki_provider_pipeline_exit_code 124 0 1)" = 124 ] \
   && [ "$(_loki_provider_pipeline_exit_code 125 0 1)" = 125 ] \
   && [ "$(_loki_provider_pipeline_exit_code 0 0 1)" = 1 ] \
   && grep -q '_loki_provider_pipe_status=("${PIPESTATUS\[@\]}")' "$RUN_SH"; then
    ok "provider deadline provenance wins over tee and parser status"
else
    bad "provider deadline provenance can be masked by the output pipeline"
fi
if grep -q 'provider_deadline_partial_mutation' "$RUN_SH" \
   && grep -q 'iteration-${ITERATION_COUNT}-provider-deadline' "$RUN_SH" \
   && grep -q 'starting the repair attempt without reviewing known-incomplete work' "$RUN_SH"; then
    ok "timed-out partial attempt checkpoints and skips expensive gates before repair"
else
    bad "timed-out partial attempt is not checkpointed before repair"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
