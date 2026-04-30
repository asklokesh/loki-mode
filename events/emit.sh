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
        (
            flock -x 9
            printf '%s\n' "$line" >> "$events_path"
        ) 9>"$lock_target"
        return $?
    fi

    # Fallback: mkdir-based mutex. mkdir is atomic on POSIX.
    local lock_dir="${events_path}.lockdir"
    local attempts=0
    local max_attempts=500   # ~5s at 10ms sleep
    while ! mkdir "$lock_dir" 2>/dev/null; do
        attempts=$((attempts + 1))
        if [ "$attempts" -ge "$max_attempts" ]; then
            # Stale lock: if the dir is older than 30s, force-remove it.
            local age
            age=$(( $(date +%s) - $(stat -f%m "$lock_dir" 2>/dev/null \
                                    || stat -c%Y "$lock_dir" 2>/dev/null \
                                    || echo 0) ))
            if [ "$age" -gt 30 ]; then
                rmdir "$lock_dir" 2>/dev/null || rm -rf "$lock_dir" 2>/dev/null || true
                attempts=0
                continue
            fi
            # Give up -- best-effort write so observability never blocks.
            printf '%s\n' "$line" >> "$events_path" 2>/dev/null || true
            return 1
        fi
        # Sleep ~10ms (perl avoids `sleep 0.01` portability issues).
        perl -e 'select(undef,undef,undef,0.01)' 2>/dev/null || sleep 1
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
json_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r/\\r/g; s//\\b/g; s//\\f/g' | awk '{if(NR>1) printf "\\n"; printf "%s", $0}'
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

# Write event file
EVENT_FILE="$EVENTS_DIR/${TIMESTAMP//:/-}_$EVENT_ID.json"
echo "$EVENT" > "$EVENT_FILE"

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

# Output event ID
echo "$EVENT_ID"
