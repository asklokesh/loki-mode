#!/usr/bin/env bash
# Loki Mode -- portable file locking helper.
#
# Why this exists:
#   flock(1) is a Linux util-linux binary not shipped on macOS or BSDs.
#   Bash callers that depend on it either degrade to non-atomic PID checks
#   (race condition) or print a "flock not available" warning. This helper
#   gives every bash caller one cross-platform primitive.
#
# Strategy:
#   mkdir() is atomic on all POSIX filesystems -- exactly one concurrent
#   caller wins the create. We use <target>.lockdir as the mutex, write a
#   PID-stamped sentinel inside it for stale detection, and clean up via
#   trap so a killed holder cannot wedge later callers.
#
# Public API:
#   safe_acquire_lock <target> [timeout_seconds]   -> 0 on acquire, 1 on timeout
#   safe_release_lock <target>                     -> always 0
#   safe_with_lock   <target> <command...>         -> runs command under lock,
#                                                     returns command's exit code
#
# Stale-lock policy: a lockdir whose sentinel PID is no longer alive AND
# whose mtime is >30s old is reaped automatically.
#
# Acquire timing: poll every 50ms, default ceiling 5s.

# Guard against double-source.
if [ "${__LOKI_LOCK_SH_LOADED:-0}" = "1" ]; then
    return 0 2>/dev/null || true
fi
__LOKI_LOCK_SH_LOADED=1

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

# _loki_lock_sleep_50ms: portable 50ms sleep.
# perl is preinstalled on macOS + most Linux; bash builtin `read -t 0.05` is
# the fallback; final fallback is a 1s sleep (still correct, just slower).
_loki_lock_sleep_50ms() {
    perl -e 'select(undef,undef,undef,0.05)' 2>/dev/null \
        || read -r -t 0.05 _ < /dev/null 2>/dev/null \
        || sleep 1
}

# _loki_lock_mtime <path>: portable mtime in epoch seconds, "0" on failure.
_loki_lock_mtime() {
    stat -f%m "$1" 2>/dev/null \
        || stat -c%Y "$1" 2>/dev/null \
        || echo 0
}

# _loki_lock_is_stale <lockdir>: 0 if reapable, 1 otherwise.
# Stale = sentinel PID dead AND mtime >30s old. A bare lockdir with no
# sentinel (legacy / partial create) is treated as stale after 30s as well.
_loki_lock_is_stale() {
    local lockdir="$1"
    local sentinel="$lockdir/owner.pid"
    local now age pid
    now=$(date +%s 2>/dev/null || echo 0)
    age=$(( now - $(_loki_lock_mtime "$lockdir") ))
    if [ "$age" -le 30 ]; then
        return 1
    fi
    if [ -f "$sentinel" ]; then
        pid=$(cat "$sentinel" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            return 1
        fi
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

# safe_acquire_lock <target> [timeout_seconds=5]
# Acquires a mutex on <target>.lockdir. Returns 0 on acquire, 1 on timeout.
safe_acquire_lock() {
    local target="$1"
    local timeout_s="${2:-5}"
    local lockdir="${target}.lockdir"
    local target_dir
    target_dir=$(dirname "$target")
    [ -d "$target_dir" ] || mkdir -p "$target_dir" 2>/dev/null || true

    # 50ms poll interval -> 20 attempts/sec.
    local max_attempts=$(( timeout_s * 20 ))
    [ "$max_attempts" -lt 1 ] && max_attempts=1
    local attempts=0

    while ! mkdir "$lockdir" 2>/dev/null; do
        if _loki_lock_is_stale "$lockdir"; then
            rm -rf "$lockdir" 2>/dev/null || true
            continue
        fi
        attempts=$((attempts + 1))
        if [ "$attempts" -ge "$max_attempts" ]; then
            return 1
        fi
        _loki_lock_sleep_50ms
    done

    # Stamp sentinel for stale detection.
    echo "$$" > "$lockdir/owner.pid" 2>/dev/null || true
    return 0
}

# safe_release_lock <target>
# Releases the mutex on <target>.lockdir. Idempotent.
safe_release_lock() {
    local target="$1"
    local lockdir="${target}.lockdir"
    rm -rf "$lockdir" 2>/dev/null || true
    return 0
}

# safe_with_lock <target> <command> [args...]
# Runs <command args...> under an exclusive lock on <target>. Releases the
# lock automatically (trap-based) even on signal. Returns the command's
# exit code. If the lock cannot be acquired within 5s, returns 1 without
# running the command (caller can detect via $?).
safe_with_lock() {
    local target="$1"; shift
    if ! safe_acquire_lock "$target" 5; then
        return 1
    fi
    # Trap at caller scope so signal-driven termination still releases.
    # We keep this in the current shell (not a subshell) so the trap can
    # see the local $target. We carefully restore any prior EXIT trap.
    local rc=0
    local _prev_exit_trap
    _prev_exit_trap=$(trap -p EXIT 2>/dev/null)
    # shellcheck disable=SC2064
    trap "safe_release_lock '$target'" EXIT INT TERM HUP
    "$@"
    rc=$?
    safe_release_lock "$target"
    # Restore prior EXIT trap (or clear if none).
    if [ -n "$_prev_exit_trap" ]; then
        eval "$_prev_exit_trap"
    else
        trap - EXIT INT TERM HUP
    fi
    return $rc
}
