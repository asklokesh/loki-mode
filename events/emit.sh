#!/usr/bin/env bash
# Loki Mode Event Emitter - Bash helper for emitting events
#
# Usage:
#   ./emit.sh <type> <source> <action> [key=value ...]
#
# Examples:
#   ./emit.sh session cli start provider=claude
#   ./emit.sh task runner complete task_id=task-001
#   ./emit.sh error hook failed error="Command blocked"
#
# Environment:
#   LOKI_DIR - Path to .loki directory (default: .loki)
#
# Sourcing:
#   This script can also be sourced (LOKI_EMIT_LIB_ONLY=1) to expose the
#   safe_append_event_jsonl() helper without performing an emit.

# safe_append_event_jsonl <events_jsonl_path> <line>
#
# Cross-process serialized append to .loki/events.jsonl. POSIX append is
# atomic only for writes <PIPE_BUF (typically 4KB) and not all filesystems
# honor it; under parallel-worktree contention bare `>>` can interleave
# partial JSONL lines. This helper serializes appends across processes.
#
# Strategy (v7.5.10):
#   - Prefer flock(1) when available (Linux, util-linux). Uses an
#     exclusive lock on a sentinel FD bound to <events>.lock so the lock
#     is released automatically when the subshell exits.
#   - Fall back to a mkdir() mutex on macOS / BSDs where flock is not
#     installed by default. mkdir is atomic on POSIX -- exactly one
#     concurrent caller wins the create. We retry with backoff up to
#     ~5s, and treat a stale lockdir (>30s old) as abandonable.
#   - The newline is appended by the helper -- callers pass the JSON
#     payload only.
safe_append_event_jsonl() {
    local events_path="$1"
    local line="$2"
    local lock_target="${events_path}.lock"
    local events_dir
    events_dir="$(dirname "$events_path")"
    mkdir -p "$events_dir" 2>/dev/null || true

    if command -v flock >/dev/null 2>&1; then
        # flock path: bind FD 9 to the sentinel file (created if absent),
        # take an exclusive lock, append, release on subshell exit.
        #
        # `-w 5` is LOAD-BEARING: a bare `flock -x 9` blocks FOREVER. A holder
        # that is killed mid-write (a reaped CI run, a Ctrl-C'd build) leaves
        # every subsequent emit hung, and because emit.sh is spawned per CLI
        # invocation those hangs ACCUMULATE. Measured 2026-07-29: 59 orphaned
        # emit.sh processes, the oldest alive 21 HOURS, on a machine at 0% idle.
        # Observability must never outlive the thing it observes.
        (
            flock -w 5 -x 9 || exit 1
            printf '%s\n' "$line" >> "$events_path"
        ) 9>"$lock_target"
        local frc=$?
        if [ "$frc" -ne 0 ]; then
            # Lock unavailable within the timeout: append unlocked rather than
            # block. A rare interleaved line is strictly better than a hung CLI.
            printf '%s\n' "$line" >> "$events_path" 2>/dev/null || true
        fi
        return 0
    fi

    # Fallback: mkdir-based mutex. mkdir is atomic on POSIX. macOS ships NO
    # flock(1), so this is the path real users take -- it must be the robust one.
    local lock_dir="${events_path}.lockdir"
    local attempts=0
    local max_attempts=100   # ~1s at 10ms sleep
    local stale_after=30
    while ! mkdir "$lock_dir" 2>/dev/null; do
        # COUNT EVERY ITERATION, before any `continue` can skip the increment.
        #
        # This was the v8.1.0 fix's blind spot and it kept the P0 alive. Both
        # `continue` paths below (lock vanished mid-stat; stale lock reclaimed)
        # jumped PAST the increment that used to live at the bottom of the loop,
        # so `max_attempts` was unreachable on those paths and the loop spun
        # forever. Under concurrent emits the stale-reclaim path fires over and
        # over, which is precisely the pathological case.
        #
        # MEASURED 2026-07-30, AFTER the v8.1.0 fix shipped: 63 orphaned
        # emit.sh processes, oldest alive 10h51m, each burning ~5% CPU, machine
        # at load 63 on 14 cores. Every orphan started after the fix landed.
        # An unbounded wait whose only exit is a counter must increment that
        # counter on EVERY path, or the bound is decorative.
        attempts=$((attempts + 1))
        if [ "$attempts" -ge "$max_attempts" ]; then
            # Give up fast -- best-effort write so observability never blocks.
            printf '%s\n' "$line" >> "$events_path" 2>/dev/null || true
            return 0
        fi
        # Check staleness EVERY iteration, not only after exhausting attempts.
        # The old code waited for all 500 attempts before its first staleness
        # check, so a stale lock cost ~5s AND ~500 forked sleep helpers per
        # event; under concurrent emits the locks kept going stale and the
        # processes piled up. Measured before this fix: 10s and ~500 forks for
        # a SINGLE append against an already-stale lock.
        local age=0
        local mtime
        mtime=$(stat -f%m "$lock_dir" 2>/dev/null || stat -c%Y "$lock_dir" 2>/dev/null || echo "")
        if [ -n "$mtime" ]; then
            age=$(( $(date +%s) - mtime ))
        else
            # Lock vanished between the failed mkdir and the stat: retry at once.
            continue
        fi
        if [ "$age" -gt "$stale_after" ]; then
            rmdir "$lock_dir" 2>/dev/null || rm -rf "$lock_dir" 2>/dev/null || true
            continue
        fi
        # (attempt counting and the give-up branch moved to the TOP of the loop
        # so no `continue` can bypass them)
        # Sleep ~10ms WITHOUT forking when the shell supports fractional sleep
        # (bash's `read -t` needs no external process). perl/sleep are fallbacks.
        read -r -t 0.01 _unused_ < /dev/null 2>/dev/null \
            || perl -e 'select(undef,undef,undef,0.01)' 2>/dev/null \
            || sleep 1
    done
    # Critical section.
    printf '%s\n' "$line" >> "$events_path"
    local rc=$?
    rmdir "$lock_dir" 2>/dev/null || true
    return $rc
}

# Library-only mode: source this file to get safe_append_event_jsonl
# without executing the emit logic below.
if [ "${LOKI_EMIT_LIB_ONLY:-0}" = "1" ]; then
    return 0 2>/dev/null || exit 0
fi

set -euo pipefail

#-----------------------------------------------------------------------------
# SELF-REAPER: telemetry must never outlive the thing it observes.
#-----------------------------------------------------------------------------
# WHY A WATCHDOG AND NOT ANOTHER LOCK FIX. v8.1.0 fixed a specific unbounded
# wait (bare `flock -x`, and a staleness check that ran only after 500 attempts).
# It was a real fix and it was not sufficient: MEASURED 2026-07-30, AFTER that
# release, 63 orphaned emit.sh processes were alive on this machine, the oldest
# 10h51m, each burning ~5% CPU, contributing to load 63 on 14 cores. Every one
# of them started AFTER the fix landed, so whatever wedges emit.sh is not (only)
# the path that was fixed.
#
# The lesson is that patching each discovered hang is an arms race we keep
# losing, because a hang anywhere in this script has the same user-visible cost.
# emit.sh is FIRE-AND-FORGET telemetry: nothing waits on its result, and a
# dropped event is strictly cheaper than a wedged process. So instead of proving
# no path can block, we cap the lifetime of EVERY path.
#
# A background timer SIGKILLs this process after LOKI_EMIT_MAX_SECONDS (default
# 10). It is deliberately blunt: no cleanup hook, no graceful drain, because the
# failure mode being defended against is precisely "graceful paths did not run".
# The killer is disowned so it never becomes a job the parent shell waits on,
# and it exits immediately when the main process finishes normally.
#
# Set LOKI_EMIT_MAX_SECONDS=0 to disable (useful only when debugging emit.sh
# itself -- an operator who disables it is choosing the orphan risk knowingly).
_emit_max="${LOKI_EMIT_MAX_SECONDS:-10}"
case "$_emit_max" in ''|*[!0-9]*) _emit_max=10 ;; esac
if [ "$_emit_max" -gt 0 ]; then
    _emit_target=$$
    (
        # Poll rather than one long sleep so the watchdog exits promptly on the
        # normal path instead of lingering for the full window.
        _waited=0
        while [ "$_waited" -lt "$_emit_max" ]; do
            sleep 1
            kill -0 "$_emit_target" 2>/dev/null || exit 0
            _waited=$((_waited + 1))
        done
        # FORENSICS BEFORE THE KILL (issue #184).
        #
        # The watchdog bounds the damage but has never recorded WHY the hang
        # happened, which is why the cause is still unknown after two disproved
        # hypotheses (the lock-retry counter, and six synthetic race probes).
        # A SIGKILL destroys the only evidence that existed.
        #
        # Captures a stack sample and the process tree to a file, then kills. On
        # the next occurrence the reader gets a stack instead of a guess.
        #
        # Every part is bounded and best-effort: this runs INSIDE the watchdog,
        # so a capture that blocks would replace a bounded failure with an
        # unbounded one -- the exact thing the watchdog exists to prevent.
        # `sample` is macOS-only and absent on Linux; both branches are guarded
        # and neither is allowed to fail the watchdog.
        _emit_diag_dir="${LOKI_EMIT_DIAG_DIR:-${TMPDIR:-/tmp}}"
        _emit_diag="$_emit_diag_dir/loki-emit-hang-$_emit_target.txt"
        {
            echo "emit.sh watchdog fired after ${_emit_max}s on pid $_emit_target"
            echo "captured: $(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)"
            echo "--- ps ---"
            ps -o pid=,ppid=,pgid=,stat=,etime=,command= -p "$_emit_target" 2>/dev/null
            echo "--- children ---"
            ps -eo pid=,ppid=,stat=,command= 2>/dev/null | awk -v p="$_emit_target" '$2==p'
            echo "--- stack (macOS sample, 1s) ---"
            if command -v sample >/dev/null 2>&1; then
                sample "$_emit_target" 1 -mayDie 2>/dev/null | head -60
            else
                echo "(sample unavailable on this platform)"
            fi
        } > "$_emit_diag" 2>/dev/null || true
        kill -9 "$_emit_target" 2>/dev/null || true
    ) >/dev/null 2>&1 &
    # Disown so the watchdog is not a tracked job of the caller's shell.
    disown 2>/dev/null || true
fi

# Configuration
LOKI_DIR="${LOKI_DIR:-.loki}"
EVENTS_DIR="$LOKI_DIR/events/pending"

# Ensure directory exists
mkdir -p "$EVENTS_DIR"

# Arguments
TYPE="${1:-state}"
SOURCE="${2:-cli}"
ACTION="${3:-unknown}"
if [ "$#" -ge 3 ]; then shift 3; else shift "$#"; fi

# Generate event ID and timestamp
EVENT_ID=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
# Try GNU date %N (nanoseconds) first, fall back to python3, then .000Z
if date --version >/dev/null 2>&1; then
    # GNU date (Linux)
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
elif command -v python3 >/dev/null 2>&1; then
    # macOS fallback: use python3 for milliseconds
    TIMESTAMP=$(python3 -c "from datetime import datetime, timezone; print(datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z')")
else
    # Final fallback: .000Z
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
fi

# JSON escape helper: handles \, ", and control characters including newlines
#
# The sed pass escapes backslash, double-quote, tab and carriage-return to
# their named short forms (\\ \" \t \r); the first awk pass collapses embedded
# newlines to \n. Every REMAINING C0 control byte (0x01-0x08, 0x0B-0x0C,
# 0x0E-0x1F -- which includes backspace 0x08 and form-feed 0x0C) is invalid raw
# inside a JSON string and is escaped as \uXXXX by the final awk pass (its map
# covers all of i=1..31). Without that escaping json.loads / JSON.parse reject
# the line and consumers (dashboard _read_events, learning aggregator) silently
# drop it. The named short forms emitted by sed are already two-char ASCII by
# the time the final pass runs, so they are never re-escaped.
#
# NOTE: backspace/form-feed are deliberately NOT escaped in the sed pass.
# Doing so requires embedding the raw control bytes in the sed pattern, which
# editors silently strip -- that left the two empty-pattern sed no-ops this
# helper previously carried. An empty sed regex reuses the LAST applied regex,
# so those entries were dead AND a latent corruption hazard. The final awk
# pass already escapes every byte in i=1..31 (backspace and form-feed included)
# to the six-char uXXXX unicode escape, producing valid JSON, so the
# named-short-form variants are unnecessary.
json_escape() {
    printf '%s' "$1" \
        | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r/\\r/g' \
        | awk '{if(NR>1) printf "\\n"; printf "%s", $0}' \
        | awk 'BEGIN{for(i=1;i<=31;i++)m[sprintf("%c",i)]=sprintf("\\u%04x",i)}
               {s=""; n=length($0);
                for(i=1;i<=n;i++){c=substr($0,i,1); s=s (c in m ? m[c] : c)}
                printf "%s", s}'
}

# Build payload JSON
ACTION_ESC=$(json_escape "$ACTION")
PAYLOAD="{\"action\":\"$ACTION_ESC\""
for arg in "$@"; do
    key="${arg%%=*}"
    value="${arg#*=}"
    key_escaped=$(json_escape "$key")
    value_escaped=$(json_escape "$value")
    PAYLOAD="$PAYLOAD,\"$key_escaped\":\"$value_escaped\""
done
PAYLOAD="$PAYLOAD}"

# Build full event JSON (escape type/source for safe embedding)
TYPE_ESC=$(json_escape "$TYPE")
SOURCE_ESC=$(json_escape "$SOURCE")
EVENT=$(cat <<EOF
{
  "id": "$EVENT_ID",
  "type": "$TYPE_ESC",
  "source": "$SOURCE_ESC",
  "timestamp": "$TIMESTAMP",
  "payload": $PAYLOAD,
  "version": "1.0"
}
EOF
)

# Write event file atomically.
#
# A bare `echo "$EVENT" > "$EVENT_FILE"` is NON-atomic: a reader (bus.py
# get_pending_events / from_dict, dashboard) that globs `*.json` mid-write sees
# a truncated/partial file and either fails json.loads (event silently dropped)
# or, worse, reads a half-written record. Write to a sibling temp file in the
# SAME directory (so rename(2) is an atomic same-filesystem operation) and then
# rename into place; a `.tmp` suffix keeps the in-progress file out of the
# `*.json` glob readers use. Clean up the temp on any failure so partials never
# linger.
EVENT_FILE="$EVENTS_DIR/${TIMESTAMP//:/-}_$EVENT_ID.json"
EVENT_TMP="$EVENT_FILE.tmp"
if printf '%s\n' "$EVENT" > "$EVENT_TMP" && mv -f "$EVENT_TMP" "$EVENT_FILE"; then
    :
else
    rm -f "$EVENT_TMP" 2>/dev/null || true
fi

# Rotate events.jsonl if it exceeds 50MB (keep 1 backup)
EVENTS_LOG="$LOKI_DIR/events.jsonl"
if [ -f "$EVENTS_LOG" ]; then
    # Check file size (in bytes)
    FILE_SIZE=$(stat -f%z "$EVENTS_LOG" 2>/dev/null || stat -c%s "$EVENTS_LOG" 2>/dev/null || echo 0)
    MAX_SIZE=$((50 * 1024 * 1024))  # 50MB
    if [ "$FILE_SIZE" -gt "$MAX_SIZE" ]; then
        mv "$EVENTS_LOG" "$EVENTS_LOG.1" 2>/dev/null || true
    fi
fi

# Append a flat-schema record to .loki/events.jsonl for dashboard consumption.
#
# The dashboard reads .loki/events.jsonl directly (dashboard/server.py
# _read_events) and run.sh's emit_event/emit_event_json write the FLAT schema
# {"timestamp","type","data"} -- NOT the nested pending schema written to the
# per-event file above. Without this append, events emitted via emit.sh land
# only in the pending dir and stay INVISIBLE to the dashboard.
#
# Mapping: data = the existing PAYLOAD object (mirrors emit_event_json, where
# `data` is a JSON object). PAYLOAD is already newline-free (built on lines
# 127-135), so the record is a single compact line. The helper appends its own
# trailing newline. `|| true` keeps observability from ever aborting the emit
# under `set -e` (matches autonomy/run.sh:9896).
#
# `source` IS part of the dashboard schema. The earlier comment here asserted
# the opposite and dropped it, but dashboard/server.py:6686 reads
# `data.source` and defaults it to "unknown", then exposes the tally as
# `signalsBySource`. So every emit.sh-routed event was attributed to "unknown"
# and the whole by-source breakdown was meaningless -- an attribution silently
# lost rather than an error anyone could see.
#
# Spliced in rather than appended blindly: PAYLOAD always opens with
# {"action":..., so inserting after the brace keeps a single valid object and
# preserves any key=value pairs the caller passed.
SOURCE_ESC="$(json_escape "$SOURCE")"
FLAT_PAYLOAD="{\"source\":\"$SOURCE_ESC\",${PAYLOAD#\{}"
FLAT_EVENT="{\"timestamp\":\"$TIMESTAMP\",\"type\":\"$TYPE_ESC\",\"data\":$FLAT_PAYLOAD}"
# An ABSENT size reading is the empty string, NOT 0 -- see the vacuity note
# below. A missing file legitimately measures 0 bytes; a `stat` that could not
# run measures NOTHING, and the two must not collapse to the same value.
_size_before=$(stat -f%z "$EVENTS_LOG" 2>/dev/null || stat -c%s "$EVENTS_LOG" 2>/dev/null || echo "")
[ -n "$_size_before" ] || _size_before=0
safe_append_event_jsonl "$EVENTS_LOG" "$FLAT_EVENT" 2>/dev/null || true

# VERIFY THE APPEND LANDED. A dropped event is an ABSENT MEASUREMENT, and an
# absent measurement read as a fact is how "0 events for a stage" gets reported
# as "the stage did not happen".
#
# The helper's exit code cannot be trusted for this: BOTH best-effort fallback
# paths (the flock-timeout branch at line 62 and the mkdir give-up branch at
# line 91) end in `printf ... || true; return 0`, so a failed append returns 0.
# Measured on an unwritable events.jsonl: emit.sh printed an id and exited 0
# having written ZERO bytes. Compare the file size instead -- it is the only
# signal that reflects what a downstream reader will actually see.
#
# NOT FATAL, BY CONSTRUCTION. emit.sh is fire-and-forget telemetry on the hot
# path of every run; nothing waits on its result and a wedged or aborted emit
# costs far more than a dropped line. So this only makes the loss VISIBLE:
#   - the warning goes to STDERR, never stdout. Line 312's `echo "$EVENT_ID"`
#     is the caller contract (`ID=$(bash emit.sh ...)`); anything else on
#     stdout corrupts it.
#   - the whole check sits in an `if`, so a failing `stat` cannot trip `set -e`.
#   - the exit status is unchanged: a dropped event still exits 0.
# Set LOKI_EMIT_QUIET=1 to suppress the warning (the drop still happens; you
# are only choosing not to hear about it).
#
# GUARD AGAINST VACUITY. If `stat` cannot run, the old `|| echo 0` made BOTH
# readings 0, they compared equal, and every SUCCESSFUL emit warned. A warning
# that cries wolf on the hot path is worse than none -- it is exactly what
# trains people to filter the channel that was supposed to surface real loss.
# An empty reading means "not measured", and an absent measurement is never
# evidence of a drop, so we stay silent rather than guess. Verified: with a
# `stat` forced to exit 1, a healthy emit is silent and still writes its line.
_size_after=$(stat -f%z "$EVENTS_LOG" 2>/dev/null || stat -c%s "$EVENTS_LOG" 2>/dev/null || echo "")
if [ "${LOKI_EMIT_QUIET:-0}" != "1" ] && [ -n "$_size_after" ] && [ "$_size_after" = "$_size_before" ]; then
    printf '[loki-events] WARNING: event %s (type=%s) was NOT recorded in %s -- downstream counts will under-report\n' \
        "$EVENT_ID" "$TYPE" "$EVENTS_LOG" >&2
fi

# Output event ID
echo "$EVENT_ID"
