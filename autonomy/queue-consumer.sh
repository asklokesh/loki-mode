#!/usr/bin/env bash
# shellcheck disable=SC2155  # Declare and assign separately (acceptable in this codebase)
#===============================================================================
# Loki Mode - Reference Queue Consumer
#
# A pluggable reference queue-consumer entrypoint for the Helm worker modes:
#
#   deployment -- long-running consumer. Loops forever, pulling one work item at
#                 a time, running `loki start <spec>`, and acking on success.
#   serverless -- one-shot consumer (LOKI_QUEUE_ONESHOT=1). Pulls EXACTLY one
#                 item, runs it, exits with that build's exit code. Intended for
#                 a KEDA ScaledJob that creates one Job per queued item.
#
# A "work item" is a Loki spec ref accepted by `loki start`: a path/brief, a
# GitHub issue ref (owner/repo#N), or a JSON object {"spec": "..."} (the spec
# field is extracted; any other JSON keys are ignored by this reference consumer).
#
# Backends (LOKI_QUEUE_BACKEND):
#   redis  -- REAL. Default when redis-cli is on PATH. BLPOP/LPOP a Redis list
#             (LOKI_QUEUE_KEY). At-most-once: a popped item is removed from the
#             queue before the build runs, so a crashed build does NOT requeue
#             automatically (this is a reference consumer, not a broker with
#             visibility timeouts -- see HONESTY below).
#   file   -- REAL. Always-available fallback for testing / airgapped clusters.
#             Pops the OLDEST file from LOKI_QUEUE_DIR/pending atomically (mv to
#             LOKI_QUEUE_DIR/processing), runs it, then moves it to done/ on
#             success or failed/ on terminal failure.
#
# HONESTY (do not overstate this):
#   - Only redis and file are shipped. SQS, Pub/Sub, RabbitMQ, Kafka, etc. are
#     BRING-YOUR-OWN: override queue.command in values.yaml with your own
#     consumer. They are documented, not implemented here.
#   - The redis backend is at-most-once (LPOP-then-run). It has no visibility
#     timeout / dead-letter requeue. If a build crashes after the item is popped,
#     that item is lost from the queue. For at-least-once delivery use the file
#     backend (a crashed build leaves the item in processing/ for manual
#     re-drive) or bring a real broker.
#   - The file backend's atomicity relies on `mv` being atomic within a single
#     filesystem (true for a normal PVC). Two consumers racing the same pending
#     dir is safe (mv either wins or fails-and-skips), but is not load-balanced.
#
# Robustness:
#   - SIGTERM-graceful: a TERM/INT received mid-build lets the CURRENT item
#     finish and ack, then exits cleanly (no half-acked item).
#   - Bounded empty-poll backoff in loop mode; one-shot returns 0 on empty.
#   - Never silently crash-loops: every exit path logs a reason.
#   - set -u safe throughout.
#
# Environment:
#   LOKI_QUEUE_BACKEND   redis | file        (default: redis if redis-cli present, else file)
#   LOKI_QUEUE_ONESHOT   1 = process one item then exit (serverless); else loop (deployment)
#   LOKI_QUEUE_KEY       redis list key      (default: loki-builds)
#   LOKI_QUEUE_URL       redis-cli -u URL    (default: $REDIS_URL or redis://127.0.0.1:6379)
#   LOKI_QUEUE_DIR       file backend root   (default: .loki/queue)
#   LOKI_QUEUE_POLL_SEC  loop-mode empty-poll wait, seconds (default: 5)
#   LOKI_QUEUE_BLOCK_SEC redis BLPOP block timeout, seconds (default: 5)
#   LOKI_TERMINAL_EXIT   run.sh terminal-failure exit code (default: 20)
#===============================================================================

set -uo pipefail

LOG_PREFIX="[queue-consumer]"

log() { printf '%s %s\n' "$LOG_PREFIX" "$*" >&2; }

# --- configuration with safe defaults -----------------------------------------
QUEUE_KEY="${LOKI_QUEUE_KEY:-loki-builds}"
QUEUE_DIR="${LOKI_QUEUE_DIR:-.loki/queue}"
POLL_SEC="${LOKI_QUEUE_POLL_SEC:-5}"
BLOCK_SEC="${LOKI_QUEUE_BLOCK_SEC:-5}"
TERMINAL_EXIT="${LOKI_TERMINAL_EXIT:-20}"
ONESHOT="${LOKI_QUEUE_ONESHOT:-0}"
REDIS_URL_DEFAULT="${REDIS_URL:-redis://127.0.0.1:6379}"
QUEUE_URL="${LOKI_QUEUE_URL:-$REDIS_URL_DEFAULT}"

# Allow the loki binary to be overridden for tests (PATH stub) or vendored paths.
LOKI_BIN="${LOKI_BIN:-loki}"

# Backend selection: explicit env wins; else redis if redis-cli is present; else file.
select_backend() {
    if [ -n "${LOKI_QUEUE_BACKEND:-}" ]; then
        printf '%s' "$LOKI_QUEUE_BACKEND"
        return 0
    fi
    if command -v redis-cli >/dev/null 2>&1; then
        printf '%s' "redis"
    else
        printf '%s' "file"
    fi
}

# --- graceful shutdown --------------------------------------------------------
# A TERM/INT sets a flag. The loop checks it between items. If it arrives during
# a build, the build is allowed to finish and ack; only then do we exit. This
# guarantees no item is left half-processed by our own shutdown.
STOP_REQUESTED=0
request_stop() {
    STOP_REQUESTED=1
    log "shutdown signal received; will exit after the current item finishes"
}
trap request_stop TERM INT

# --- spec extraction ----------------------------------------------------------
# A work item may be a bare spec ref or a JSON object {"spec": "..."}. Extract
# the spec string. Bare refs pass through unchanged. JSON is parsed with python3
# (already a runtime dependency); if python3 is unavailable or parsing fails, the
# raw item is used as-is (a bare ref is the common case).
extract_spec() {
    local item="$1"
    # Trim leading/trailing whitespace/newlines.
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    case "$item" in
        '{'*)
            if command -v python3 >/dev/null 2>&1; then
                local parsed
                parsed="$(printf '%s' "$item" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    s = d.get("spec", "") if isinstance(d, dict) else ""
    sys.stdout.write(str(s))
except Exception:
    pass
' 2>/dev/null)"
                if [ -n "$parsed" ]; then
                    printf '%s' "$parsed"
                    return 0
                fi
            fi
            # Fall through: not parseable, return raw (caller may still reject).
            printf '%s' "$item"
            ;;
        *)
            printf '%s' "$item"
            ;;
    esac
}

# --- run one build ------------------------------------------------------------
# Runs `loki start <spec>` for the given spec. Returns the build's exit code.
# An empty spec is treated as a terminal failure (a queue item with no spec is
# malformed; we do not silently run a no-spec codebase-analysis off the queue).
run_build() {
    local spec="$1"
    if [ -z "$spec" ]; then
        log "ERROR: empty spec extracted from work item; treating as terminal failure"
        return "$TERMINAL_EXIT"
    fi
    # Flag-injection guard: a queue item is untrusted (it came off the queue). A
    # spec that begins with '-' would be parsed by `loki start` as a FLAG, not a
    # PRD path / issue ref / brief (e.g. an item "--ship" would silently switch
    # the build into auto-merge-PR mode). A leading-dash item is never a valid
    # spec, so reject it as malformed rather than letting it steer the build.
    # (The whole item is already a single argv element -- quoting holds -- so this
    # is the remaining surface: a single known flag token.)
    case "$spec" in
        -*)
            log "ERROR: work-item spec starts with '-' (would be parsed as a loki flag): $spec -- treating as terminal failure"
            return "$TERMINAL_EXIT"
            ;;
    esac
    log "starting build: spec=$spec"
    # End-of-options separator so even a future leading-dash that slips past the
    # guard cannot be read as a flag (cmd_start gained a `--` handler).
    "$LOKI_BIN" start -- "$spec"
    local rc=$?
    log "build finished: spec=$spec exit=$rc"
    return "$rc"
}

# =============================================================================
# Redis backend
# =============================================================================
redis_cli() {
    redis-cli -u "$QUEUE_URL" "$@"
}

# Pop one item from the redis list. In loop mode use BLPOP (blocks up to
# BLOCK_SEC, then returns empty so we can check the stop flag); in one-shot use
# LPOP (non-blocking, exits immediately on an empty queue).
# Prints the popped item to stdout, or nothing if the queue was empty.
redis_pop() {
    if [ "$ONESHOT" = "1" ]; then
        redis-cli -u "$QUEUE_URL" --no-raw LPOP "$QUEUE_KEY" 2>/dev/null | _redis_unquote
    else
        # BLPOP returns two lines: the key name, then the value. Take the value.
        redis-cli -u "$QUEUE_URL" BLPOP "$QUEUE_KEY" "$BLOCK_SEC" 2>/dev/null | sed -n '2p'
    fi
}

# --no-raw LPOP wraps the value in quotes; strip a single surrounding pair and
# a literal "(nil)" sentinel. (BLPOP path uses raw output and skips this.)
_redis_unquote() {
    local line
    IFS= read -r line || true
    [ "$line" = "(nil)" ] && return 0
    # Strip one leading and trailing double quote if present.
    line="${line#\"}"
    line="${line%\"}"
    printf '%s' "$line"
}

redis_consume_one() {
    local item
    item="$(redis_pop)"
    if [ -z "$item" ]; then
        return 100  # sentinel: queue empty
    fi
    local spec
    spec="$(extract_spec "$item")"
    run_build "$spec"
    return $?
}

# =============================================================================
# File backend
# =============================================================================
# Layout under LOKI_QUEUE_DIR:
#   pending/     work items waiting to be processed (one file each)
#   processing/  the item currently being processed (atomically mv'd here)
#   done/        successfully processed items
#   failed/      terminally-failed items (exit == TERMINAL_EXIT or empty spec)
file_init_dirs() {
    mkdir -p "$QUEUE_DIR/pending" "$QUEUE_DIR/processing" "$QUEUE_DIR/done" "$QUEUE_DIR/failed" 2>/dev/null || {
        log "ERROR: cannot create queue directories under $QUEUE_DIR"
        return 1
    }
}

# Claim the oldest pending file by atomically mv'ing it to processing/. Prints
# the claimed processing-path on success; prints nothing if pending is empty.
# The mv is the atomic claim: if a racing consumer grabbed it first, mv fails and
# we move on to the next candidate.
file_claim_oldest() {
    local f base dest
    # Oldest by mtime. `ls -tr` lists oldest first; restrict to regular files.
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        [ -f "$f" ] || continue
        base="$(basename "$f")"
        dest="$QUEUE_DIR/processing/$base"
        if mv "$f" "$dest" 2>/dev/null; then
            printf '%s' "$dest"
            return 0
        fi
        # mv failed (another consumer claimed it): try the next candidate.
    done <<EOF
$(ls -tr "$QUEUE_DIR/pending" 2>/dev/null | while IFS= read -r n; do printf '%s/pending/%s\n' "$QUEUE_DIR" "$n"; done)
EOF
    return 0  # nothing claimed
}

file_consume_one() {
    file_init_dirs || return 1
    local claimed
    claimed="$(file_claim_oldest)"
    if [ -z "$claimed" ]; then
        return 100  # sentinel: queue empty
    fi
    local base
    base="$(basename "$claimed")"
    local item
    item="$(cat "$claimed" 2>/dev/null)"
    local spec
    spec="$(extract_spec "$item")"
    run_build "$spec"
    local rc=$?
    if [ "$rc" -eq 0 ]; then
        mv "$claimed" "$QUEUE_DIR/done/$base" 2>/dev/null || log "WARN: could not move $base to done/"
    elif [ "$rc" -eq "$TERMINAL_EXIT" ]; then
        mv "$claimed" "$QUEUE_DIR/failed/$base" 2>/dev/null || log "WARN: could not move $base to failed/"
        log "item $base TERMINAL-FAILED (exit $rc); moved to failed/, not acked"
    else
        # Transient crash: leave it in processing/ for manual re-drive. We do NOT
        # auto-requeue (no retry counter in a flat dir); honest at-least-once.
        log "item $base crashed (exit $rc); left in processing/ for re-drive"
    fi
    return "$rc"
}

# =============================================================================
# Driver
# =============================================================================
consume_one() {
    case "$1" in
        redis) redis_consume_one ;;
        file)  file_consume_one ;;
        *)
            log "ERROR: unknown LOKI_QUEUE_BACKEND='$1' (supported: redis, file)"
            return 2
            ;;
    esac
}

main() {
    local backend
    backend="$(select_backend)"

    # Fail fast on a misconfigured redis backend rather than crash-looping.
    if [ "$backend" = "redis" ] && ! command -v redis-cli >/dev/null 2>&1; then
        log "ERROR: LOKI_QUEUE_BACKEND=redis but redis-cli is not on PATH"
        return 2
    fi
    if [ "$backend" != "redis" ] && [ "$backend" != "file" ]; then
        log "ERROR: unknown LOKI_QUEUE_BACKEND='$backend' (supported: redis, file)"
        return 2
    fi

    if [ "$ONESHOT" = "1" ]; then
        log "mode=oneshot backend=$backend (serverless: process one item then exit)"
        consume_one "$backend"
        local rc=$?
        if [ "$rc" -eq 100 ]; then
            log "queue empty; nothing to process; exiting 0"
            return 0
        fi
        return "$rc"
    fi

    log "mode=loop backend=$backend (deployment: process items until SIGTERM)"
    while [ "$STOP_REQUESTED" -ne 1 ]; do
        consume_one "$backend"
        local rc=$?
        if [ "$rc" -eq 100 ]; then
            # Empty queue. The redis BLPOP path already blocked; sleep only for
            # the file backend (it polls). A pending stop check happens at loop
            # top, so we never sleep through a shutdown longer than one interval.
            if [ "$backend" = "file" ]; then
                sleep "$POLL_SEC"
            fi
            continue
        fi
        if [ "$rc" -eq 2 ]; then
            # Configuration error: do not hot-loop. Surface and exit non-zero.
            log "fatal configuration error; exiting"
            return 2
        fi
        # rc is a build result (0 success, TERMINAL_EXIT terminal, other crash).
        # Build outcomes are normal operation, not consumer errors: keep looping.
    done
    log "stopped gracefully after current item; exiting 0"
    return 0
}

main "$@"
