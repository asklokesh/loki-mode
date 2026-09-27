# Temp directory and process cleanup (mandatory helpers)

Moved out of CLAUDE.md (S-78) to keep the root file short. Content unchanged.
CLAUDE.md still states the invariant; this file holds the runnable helpers.

## Test and Resource Cleanup (MANDATORY - NEVER SKIP)

**Before reporting ANY task as done, run ALL cleanup steps below. No exceptions.**

1. **Create one run-owned temp directory before the first temp write.** Keep
   every archive, package extraction, log, PID file, and test fixture for the
   task below this directory. Never use fixed names or shared globs under
   `/tmp`.

2. **Stop only processes started by the current task.** Retain their exact PIDs
   below `$LOKI_RUN_TMP` and signal those PIDs individually. Do not use
   `pkill`, a shared-port sweep, or a name-pattern kill as cleanup.

3. **Remove only the validated run-owned directory.** Use the helpers below.
   Cleanup fails closed unless the target is a direct child of the canonical
   temp root, has the exact ownership marker created with it, is owned by the
   current UID, still carries the private permissions the helper set (`700`
   for the directory, `600` for the marker), is not a symlink, and is not a
   Git worktree. Never replace this with a wildcard deletion under `/tmp` or
   `$TMPDIR`.

```bash
loki_run_tmp_create() {
    local temp_root marker

    if [ -n "${LOKI_RUN_TMP:-}" ]; then
        printf '%s\n' "LOKI_RUN_TMP is already set; refusing to replace it" >&2
        return 64
    fi

    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || {
        printf '%s\n' "Cannot resolve the temp root" >&2
        return 64
    }
    LOKI_RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || return 1
    marker="${LOKI_RUN_TMP}/.loki-run-owned"

    chmod 700 "$LOKI_RUN_TMP" || {
        rmdir "$LOKI_RUN_TMP" 2>/dev/null || true
        unset LOKI_RUN_TMP
        return 1
    }
    if ! printf '%s\n' "$LOKI_RUN_TMP" >"$marker" || ! chmod 600 "$marker"; then
        rm -f -- "$marker"
        rmdir "$LOKI_RUN_TMP" 2>/dev/null || true
        unset LOKI_RUN_TMP
        return 1
    fi
    export LOKI_RUN_TMP
}

# Read one numeric stat field portably. GNU uses -c, BSD uses -f, and each
# MISPARSES the other's flag: GNU -f means --file-system and still prints a
# filesystem block on stdout while exiting non-zero, so a bare `a || b`
# fallback captures that block and concatenates the real value onto it.
# Validate the captured value instead of trusting exit status or stream, so a
# usage string, a filesystem block, an empty result, or a concatenation of any
# of those is rejected on every platform.
loki_run_tmp_stat_field() {
    local gnu_fmt="$1" bsd_fmt="$2" target_path="$3" value

    value="$(stat -c "$gnu_fmt" -- "$target_path" 2>/dev/null)" || value=''
    case "$value" in
        '' | *[!0-9]*) value="$(stat -f "$bsd_fmt" -- "$target_path" 2>/dev/null)" || value='' ;;
    esac
    case "$value" in
        '' | *[!0-9]*) return 1 ;;
    esac
    printf '%s\n' "$value"
}

loki_run_tmp_cleanup() {
    local target temp_root marker marker_value target_real
    local target_uid marker_uid target_mode marker_mode current_uid

    target="${LOKI_RUN_TMP:-}"
    [ -n "$target" ] || return 0
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64

    case "$target" in
        "${temp_root}"/loki-run.*) ;;
        *)
            printf '%s\n' "Refusing cleanup outside the run-owned temp namespace: $target" >&2
            return 64
            ;;
    esac
    [ "$(dirname -- "$target")" = "$temp_root" ] || return 64
    [ -d "$target" ] && [ ! -L "$target" ] || return 64

    marker="${target}/.loki-run-owned"
    [ -f "$marker" ] && [ ! -L "$marker" ] || return 64
    IFS= read -r marker_value <"$marker" || return 64
    [ "$marker_value" = "$target" ] || return 64

    current_uid="$(id -u)" || return 64
    target_uid="$(loki_run_tmp_stat_field '%u' '%u' "$target")" || return 64
    marker_uid="$(loki_run_tmp_stat_field '%u' '%u' "$marker")" || return 64
    [ "$target_uid" = "$current_uid" ] && [ "$marker_uid" = "$current_uid" ] || return 64

    # Refuse anything readable, writable, or executable by group or other. Only
    # the low three permission digits are compared: GNU '%a' includes the
    # setuid/setgid/sticky digit and BSD '%Lp' does not, and `mktemp -d` under a
    # setgid temp root inherits g+s that a three-digit `chmod 700` preserves.
    # Comparing the raw value against "700" would therefore read 2700 on Linux,
    # refuse, and leak the very directory this helper exists to remove.
    target_mode="$(loki_run_tmp_stat_field '%a' '%Lp' "$target")" || return 64
    marker_mode="$(loki_run_tmp_stat_field '%a' '%Lp' "$marker")" || return 64
    # Keep the last three digits, zero-padded, then require exactly 700/600.
    target_mode="00${target_mode}"
    marker_mode="00${marker_mode}"
    [ "${target_mode#"${target_mode%???}"}" = "700" ] || return 64
    [ "${marker_mode#"${marker_mode%???}"}" = "600" ] || return 64

    target_real="$(cd "$target" 2>/dev/null && pwd -P)" || return 64
    [ "$target_real" = "$target" ] || return 64
    [ "$(dirname -- "$target_real")" = "$temp_root" ] || return 64

    # A linked worktree has a .git file; a primary worktree has a .git
    # directory. Refuse both, including a broken .git symlink.
    if [ -e "${target}/.git" ] || [ -L "${target}/.git" ]; then
        printf '%s\n' "Refusing to remove a Git worktree: $target" >&2
        return 64
    fi

    rm -rf -- "$target"
    [ ! -e "$target" ] || return 1
    unset LOKI_RUN_TMP
}
```

4. **Verify exact cleanup.** Confirm each recorded PID is gone and the saved
   `$LOKI_RUN_TMP` path no longer exists. Do not scan or delete other users'
   or runs' temp paths.

5. **Report cleanup status** to the user in the task completion message,
   including only the explicit run-owned path and process IDs handled.

## Feedback Loop Requirement (before documenting a new feature)

1. **Verify it exists** - check files, run commands, test endpoints.
2. **Run feedback loop** - Task tool with Opus to review claims for accuracy.
3. **Be factual only** - never document features that don't work yet.
4. **Mark planned features** - use "Coming Soon" or "Planned" labels.

```bash
# Before documenting "npm install -g loki-mode"
npm view loki-mode  # Does package exist on registry?
# Before documenting a CLI command
which loki && loki --help
# Before documenting a file path
ls -la path/to/file
```
