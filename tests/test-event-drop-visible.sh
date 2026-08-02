#!/usr/bin/env bash
# tests/test-event-drop-visible.sh
#
# Regression test for SILENT EVENT LOSS in events/emit.sh.
#
# The bug: the flat-schema append to .loki/events.jsonl was called as
#   safe_append_event_jsonl "$EVENTS_LOG" "$FLAT_EVENT" 2>/dev/null || true
# and its result was never checked. The helper's exit code cannot carry the
# failure anyway -- BOTH best-effort fallback paths (the flock-timeout branch
# and the mkdir give-up branch) end in `printf ... || true; return 0`, so a
# failed append returns 0. With stderr also discarded, emit.sh printed an event
# id and exited 0 having written ZERO bytes.
#
# Why that matters: everything downstream reads .loki/events.jsonl --
# scripts/measure-run.sh, the dashboard (_read_events), and the stage-timing
# analysis. measure-run.sh skips unparseable/absent lines by design, so a
# dropped event does not surface as an error; the stage simply reports 0
# events. An ABSENT MEASUREMENT then gets read as the fact "the stage did not
# happen". The caller, meanwhile, received an id that looks like a receipt.
#
# The fix makes the loss VISIBLE WITHOUT making it FATAL, by comparing the
# events.jsonl size before and after the append:
#   - a warning naming the dropped event goes to STDERR
#   - STDOUT still carries only the event id (the caller contract:
#     `ID=$(bash emit.sh ...)`) -- a warning on stdout would corrupt callers
#   - the exit status stays 0 and the process never aborts, because emit.sh is
#     fire-and-forget telemetry on the hot path of every run
#
# Failure injection: `mkdir .loki/events.jsonl` makes the append fail with
# EISDIR. This is deliberate -- chmod-based injection is a NO-OP under root,
# which CI may run as, and would make this test silently vacuous there.
#
# Non-vacuity is asserted directly: test 5 reconstructs the pre-fix emit.sh by
# stripping the size-check block and proves it stays SILENT on the same input.
#
# Self-contained: mktemp sandbox, trap cleanup, no network, no processes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EMIT_SH="$REPO_ROOT/events/emit.sh"

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }

TMPDIR_TEST="$(mktemp -d "${TMPDIR:-/tmp}/loki-event-drop.XXXXXX")"
cleanup() { rm -rf "$TMPDIR_TEST" 2>/dev/null || true; }
trap cleanup EXIT

echo "=== test-event-drop-visible.sh ==="
echo "sandbox: $TMPDIR_TEST"
echo

# --- 1. a DROPPED event is reported on stderr -------------------------------
# EISDIR: appending to a directory fails for every uid, root included.
BROKEN="$TMPDIR_TEST/broken/.loki"
mkdir -p "$BROKEN/events.jsonl"

set +e
DROP_STDOUT="$(LOKI_DIR="$BROKEN" bash "$EMIT_SH" state runner phase_change k=v 2>"$TMPDIR_TEST/drop.err")"
DROP_RC=$?
set -e
DROP_STDERR="$(cat "$TMPDIR_TEST/drop.err")"

if printf '%s' "$DROP_STDERR" | grep -q 'WARNING'; then
    pass "(1) dropped event produced a stderr WARNING"
else
    fail "(1) dropped event was SILENT -- stderr was: [$DROP_STDERR]"
fi

# The warning must identify WHICH event vanished, or an operator cannot act.
if printf '%s' "$DROP_STDERR" | grep -q "$DROP_STDOUT"; then
    pass "(2) warning names the dropped event id ($DROP_STDOUT)"
else
    fail "(2) warning does not name the event id -- stderr: [$DROP_STDERR]"
fi

# --- 3. visibility must NOT be fatal ----------------------------------------
# emit.sh runs on the hot path of every iteration. A drop is cheap; an abort
# or a nonzero status that trips a caller's `set -e` is not.
if [ "$DROP_RC" -eq 0 ]; then
    pass "(3) emit.sh still exits 0 on a dropped event (never fatal)"
else
    fail "(3) emit.sh exited $DROP_RC on a dropped event -- telemetry became fatal"
fi

# STDOUT is the caller contract: `ID=$(bash emit.sh ...)`. It must stay clean.
if [ -n "$DROP_STDOUT" ] && [ "$(printf '%s' "$DROP_STDOUT" | wc -l | tr -d ' ')" = "0" ] \
   && ! printf '%s' "$DROP_STDOUT" | grep -q 'WARNING'; then
    pass "(3b) stdout still carries ONLY the event id (contract intact)"
else
    fail "(3b) stdout was polluted: [$DROP_STDOUT]"
fi

# --- 4. the healthy path stays SILENT ---------------------------------------
# A warning that fires on success is noise, and noise gets filtered out -- which
# would put us right back where we started.
OK_DIR="$TMPDIR_TEST/ok/.loki"
mkdir -p "$OK_DIR"

set +e
OK_STDOUT="$(LOKI_DIR="$OK_DIR" bash "$EMIT_SH" state runner phase_change k=v 2>"$TMPDIR_TEST/ok.err")"
OK_RC=$?
set -e
OK_STDERR="$(cat "$TMPDIR_TEST/ok.err")"

if [ -z "$OK_STDERR" ]; then
    pass "(4) successful emit produced NO stderr noise"
else
    fail "(4) successful emit warned anyway: [$OK_STDERR]"
fi

# Prove the success case really recorded a line a consumer can read back.
OK_JSONL="$OK_DIR/events.jsonl"
if [ -s "$OK_JSONL" ] && python3 -c "
import json,sys
lines=[l for l in open('$OK_JSONL') if l.strip()]
assert len(lines)==1, 'expected 1 record, got %d' % len(lines)
d=json.loads(lines[0])
assert d['type']=='state', d
assert d['data']['action']=='phase_change', d
assert d['data']['k']=='v', d
" 2>/dev/null; then
    pass "(4b) successful emit wrote exactly one readable record"
else
    fail "(4b) successful emit did not produce a readable record"
fi

if [ "$OK_RC" -eq 0 ] && [ -n "$OK_STDOUT" ]; then
    pass "(4c) successful emit exits 0 and prints an id"
else
    fail "(4c) successful emit rc=$OK_RC stdout=[$OK_STDOUT]"
fi

# --- 5. non-vacuity: the PRE-FIX script is silent on the same input ---------
# Reconstruct the old swallow-and-continue behavior by deleting the whole
# size-check block: the `_size_before` capture, and the `_size_after` capture
# through the `fi` that closes the warning. Deleting by LINE RANGE (rather than
# grepping out individual lines) matters -- dropping only the `_size_*` lines
# would leave the `if`/`printf` behind comparing two now-unset variables, which
# still warns, and the reconstruction would silently not be the pre-fix script.
# If the old script ALSO warns, this test proves nothing.
OLD_EMIT="$TMPDIR_TEST/emit-old.sh"
python3 - "$EMIT_SH" "$OLD_EMIT" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
lines = open(src).readlines()
start = next(i for i, l in enumerate(lines) if l.startswith('_size_before='))
after = next(i for i, l in enumerate(lines) if l.startswith('_size_after='))
end = next(i for i in range(after, len(lines)) if lines[i].rstrip() == 'fi')
kept = lines[:start] + lines[start + 1:after] + lines[end + 1:]
assert not any('WARNING: event' in l for l in kept), 'reconstruction still warns'
open(dst, 'w').writelines(kept)
PY

OLD_DIR="$TMPDIR_TEST/old/.loki"
mkdir -p "$OLD_DIR/events.jsonl"
set +e
LOKI_DIR="$OLD_DIR" bash "$OLD_EMIT" state runner phase_change k=v \
    >/dev/null 2>"$TMPDIR_TEST/old.err"
set -e
OLD_STDERR="$(grep 'WARNING: event' "$TMPDIR_TEST/old.err" 2>/dev/null || true)"

if [ -z "$OLD_STDERR" ]; then
    pass "(5) non-vacuity: PRE-FIX emit.sh dropped the event SILENTLY"
else
    fail "(5) non-vacuity: PRE-FIX emit.sh also warned -- test is vacuous"
fi

# --- 6. the opt-out works ---------------------------------------------------
QUIET_DIR="$TMPDIR_TEST/quiet/.loki"
mkdir -p "$QUIET_DIR/events.jsonl"
set +e
LOKI_EMIT_QUIET=1 LOKI_DIR="$QUIET_DIR" bash "$EMIT_SH" state runner phase_change k=v \
    >/dev/null 2>"$TMPDIR_TEST/quiet.err"
QUIET_RC=$?
set -e
if [ "$QUIET_RC" -eq 0 ] && [ ! -s "$TMPDIR_TEST/quiet.err" ]; then
    pass "(6) LOKI_EMIT_QUIET=1 suppresses the warning"
else
    fail "(6) LOKI_EMIT_QUIET=1 did not suppress: [$(cat "$TMPDIR_TEST/quiet.err")]"
fi

# --- 7. no FALSE POSITIVE when the size probe itself cannot run -------------
# The check measures success by comparing events.jsonl size before/after. If
# `stat` is unavailable or fails, an earlier draft defaulted BOTH readings to 0,
# they compared equal, and every SUCCESSFUL emit warned. A warning that cries
# wolf on the hot path is worse than no warning -- it trains people to filter
# exactly the channel meant to surface real loss. An unmeasurable size is not
# evidence of a drop, so the emit must stay silent AND still record its line.
STAT_DIR="$TMPDIR_TEST/nostat"
mkdir -p "$STAT_DIR/.loki" "$STAT_DIR/fakebin"
printf '#!/bin/sh\nexit 1\n' > "$STAT_DIR/fakebin/stat"
chmod +x "$STAT_DIR/fakebin/stat"

set +e
( cd "$STAT_DIR" && PATH="$STAT_DIR/fakebin:$PATH" LOKI_DIR=.loki \
    bash "$EMIT_SH" state runner phase_change k=v ) \
    >/dev/null 2>"$TMPDIR_TEST/nostat.err"
STAT_RC=$?
set -e

if [ "$STAT_RC" -eq 0 ] && [ ! -s "$TMPDIR_TEST/nostat.err" ]; then
    pass "(7) a broken size probe does NOT warn on a successful emit"
else
    fail "(7) false positive with unusable stat: [$(cat "$TMPDIR_TEST/nostat.err")]"
fi

if [ -s "$STAT_DIR/.loki/events.jsonl" ]; then
    pass "(7b) the event was still recorded despite the unusable size probe"
else
    fail "(7b) event was lost when stat was unusable"
fi

echo
if [ "$FAILS" -eq 0 ]; then
    echo "=== ALL TESTS PASSED ==="
    exit 0
else
    echo "=== $FAILS TEST(S) FAILED ==="
    exit 1
fi
