#!/usr/bin/env bash
# scripts/test-slot.sh -- cap concurrent FULL bun test / engine10 runs per machine.
#
# Usage: bash scripts/test-slot.sh [--full-only] -- <command> [args...]
#   Takes one of LOKI_ENGINE10_SLOTS (default 2) slots, runs the command as a
#   child, and releases the slot on normal exit, error, SIGTERM, SIGINT and
#   SIGHUP. A start with no free slot prints "waiting for a test slot" and polls
#   until one frees; it is never killed or failed for waiting.
#   --full-only: take a slot only for a full run (no path filter, or exactly
#   tests/engine10); a filtered `bun test <file>` runs immediately.
#
# Why this file: no existing script owns "how many full suites at once". It is
# the one entrypoint loki-ts/package.json `test` and `test:engine10` call, so
# scripts/local-ci.sh (bun run test) is covered without further wiring.
#
# Portable counting lock: one mkdir-made directory per slot (atomic on macOS
# bash 3.2 and Linux; flock is not on macOS). The holder pid is recorded in
# <slot>/pid. A slot whose recorded pid is dead is reclaimed by an atomic mv
# to a private name; nothing is ever signalled by name or pattern, and the
# only process signalled is the child this script started and recorded.
#
# Env: LOKI_ENGINE10_SLOTS (positive int, default 2), LOKI_TEST_SLOT_DIR
# (default $HOME/.cache/loki-test-slots, per user), LOKI_TEST_SLOT_POLL
# (seconds, default 2), LOKI_TEST_SLOT_GRACE (seconds a signalled child gets to
# exit on TERM before KILL, default 10). LOKI_TEST_SLOT_HELD=1 marks a run already inside a slot
# so a nested `bun run test` never deadlocks on its own parent.
set -uo pipefail

FULL_ONLY=0
if [ "${1:-}" = "--full-only" ]; then FULL_ONLY=1; shift; fi
[ "${1:-}" = "--" ] && shift
if [ "$#" -eq 0 ]; then
    echo "usage: test-slot.sh [--full-only] -- <command> [args...]" >&2
    exit 2
fi

is_full_run() {
    local i=0 skip=0 a
    for a in "$@"; do
        i=$((i + 1))
        if [ "$skip" = 1 ]; then skip=0; continue; fi
        case "$a" in
            --timeout | -t | --test-name-pattern | --rerun-each | --preload | --coverage-reporter) skip=1; continue ;;
            -*) continue ;;
        esac
        if [ "$i" -le 2 ] && { [ "$a" = bun ] || [ "$a" = test ]; }; then continue; fi
        case "$a" in
            tests/engine10 | tests/engine10/) continue ;;
        esac
        return 1
    done
    return 0
}

if [ "${LOKI_TEST_SLOT_HELD:-}" = 1 ]; then
    exec "$@"
fi
if [ "$FULL_ONLY" = 1 ] && ! is_full_run "$@"; then
    exec "$@"
fi

SLOTS="${LOKI_ENGINE10_SLOTS:-2}"
case "$SLOTS" in '' | *[!0-9]* | 0*) SLOTS=2 ;; esac
POLL="${LOKI_TEST_SLOT_POLL:-2}"
case "$POLL" in '' | *[!0-9.]*) POLL=2 ;; esac
DIR="${LOKI_TEST_SLOT_DIR:-$HOME/.cache/loki-test-slots}"
mkdir -p "$DIR" || { echo "test-slot: cannot create $DIR" >&2; exit 2; }

GRACE="${LOKI_TEST_SLOT_GRACE:-10}"
case "$GRACE" in '' | *[!0-9]*) GRACE=10 ;; esac
MYSLOT=""
CHILD=""

pid_alive() { kill -0 "$1" 2>/dev/null; }

# reclaim_if_dead <slotdir>: succeed after moving a dead-holder slot aside
# atomically and removing it; fail (leave it alone) when the holder is alive.
reclaim_if_dead() {
    local s="$1" p aside
    p="$(cat "$s/pid" 2>/dev/null)" || p=""
    case "$p" in
        '')
            # No pid yet: the holder may be between mkdir and the pid write.
            # Treat as held while the dir is younger than a minute.
            [ -d "$s" ] || return 0
            [ -z "$(find "$s" -maxdepth 0 -mmin -1 2>/dev/null)" ] || return 1
            ;;
        *[!0-9]*) return 1 ;;
        *) pid_alive "$p" && return 1 ;;
    esac
    aside="$DIR/.stale.$$.$RANDOM"
    mv "$s" "$aside" 2>/dev/null || return 1
    # If the slot we moved was just re-taken by a live holder, put it back.
    if [ -n "$p" ] && [ "$(cat "$aside/pid" 2>/dev/null)" != "$p" ]; then
        mv "$aside" "$s" 2>/dev/null && return 1
    fi
    rm -rf -- "${aside:?}"
    return 0
}

take() {
    printf '%s\n' "$$" >"$1/pid"
    MYSLOT="$1"
}

try_acquire() {
    local i=1 s
    while [ "$i" -le "$SLOTS" ]; do
        s="$DIR/slot.$i"
        if mkdir "$s" 2>/dev/null; then take "$s"; return 0; fi
        if reclaim_if_dead "$s" && mkdir "$s" 2>/dev/null; then take "$s"; return 0; fi
        i=$((i + 1))
    done
    return 1
}

release() {
    # trap EXIT can fire in subshells; only the owning shell releases.
    [ "${BASH_SUBSHELL:-0}" = 0 ] || return 0
    if [ -n "$MYSLOT" ] && [ "$(cat "$MYSLOT/pid" 2>/dev/null)" = "$$" ]; then
        rm -rf -- "${MYSLOT:?}"
    fi
    MYSLOT=""
}

on_signal() {
    local sig="$1"
    if [ -n "$CHILD" ]; then
        # A background child of a non-interactive bash starts with SIGINT
        # ignored (and bun test ignores SIGTERM for long stretches), so the
        # signal received is never forwarded as-is: send TERM to the recorded
        # child, then KILL it if it is still alive after the grace period.
        kill -TERM "$CHILD" 2>/dev/null || true
        local ticks=0 max=$((GRACE * 10))
        while [ "$ticks" -lt "$max" ] && kill -0 "$CHILD" 2>/dev/null; do
            sleep 0.1
            ticks=$((ticks + 1))
        done
        if kill -0 "$CHILD" 2>/dev/null; then kill -KILL "$CHILD" 2>/dev/null || true; fi
        wait "$CHILD" 2>/dev/null || true
    fi
    release
    case "$sig" in TERM) exit 143 ;; INT) exit 130 ;; *) exit 129 ;; esac
}
trap release EXIT
trap 'on_signal TERM' TERM
trap 'on_signal INT' INT
trap 'on_signal HUP' HUP

WAITED=0
while ! try_acquire; do
    if [ "$WAITED" = 0 ]; then
        echo "test-slot: waiting for a test slot (all $SLOTS in use; limit set by LOKI_ENGINE10_SLOTS)" >&2
        WAITED=1
    fi
    sleep "$POLL" &
    wait $!
done
[ "$WAITED" = 1 ] && echo "test-slot: got a test slot" >&2

export LOKI_TEST_SLOT_HELD=1
"$@" &
CHILD=$!
wait "$CHILD"
rc=$?
CHILD=""
exit "$rc"
