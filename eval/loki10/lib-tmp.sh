#!/usr/bin/env bash
# Run-owned temp directory helpers, copied verbatim from the pattern in the
# repo CLAUDE.md (see docs/dev/tmp-cleanup.md). Sourced by run.sh and
# test-harness.sh; never sweep /tmp or kill by name.

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

loki_run_tmp_validate_dir() {
    local target temp_root marker marker_value target_real
    local target_uid marker_uid target_mode marker_mode current_uid

    target="${1:-}"
    [ -n "$target" ] || return 64
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

    target_mode="$(loki_run_tmp_stat_field '%a' '%Lp' "$target")" || return 64
    marker_mode="$(loki_run_tmp_stat_field '%a' '%Lp' "$marker")" || return 64
    target_mode="00${target_mode}"
    marker_mode="00${marker_mode}"
    [ "${target_mode#"${target_mode%???}"}" = "700" ] || return 64
    [ "${marker_mode#"${marker_mode%???}"}" = "600" ] || return 64

    target_real="$(cd "$target" 2>/dev/null && pwd -P)" || return 64
    [ "$target_real" = "$target" ] || return 64
    [ "$(dirname -- "$target_real")" = "$temp_root" ] || return 64

    if [ -e "${target}/.git" ] || [ -L "${target}/.git" ]; then
        printf '%s\n' "Refusing to remove a Git worktree: $target" >&2
        return 64
    fi

    return 0
}

loki_run_tmp_cleanup() {
    local target="${LOKI_RUN_TMP:-}"
    [ -n "$target" ] || return 0
    loki_run_tmp_validate_dir "$target" || return 64
    rm -rf -- "$target"
    [ ! -e "$target" ] || return 1
    unset LOKI_RUN_TMP
}

# Same contract as loki_run_tmp_validate_dir for a hermetic test home
# (loki-test-home-*): the marker is the seeded .gitconfig, matched by content.
loki_test_home_validate_dir() {
    local target="${1:-}" temp_root marker target_real current_uid target_uid marker_uid mode seed
    [ -n "$target" ] || return 64
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64
    case "$target" in
        "${temp_root}"/loki-test-home-*) ;;
        *) return 64 ;;
    esac
    [ "$(dirname -- "$target")" = "$temp_root" ] || return 64
    [ -d "$target" ] && [ ! -L "$target" ] || return 64
    marker="${target}/.gitconfig"
    [ -f "$marker" ] && [ ! -L "$marker" ] || return 64
    seed="$(printf '[user]\n\tname = loki-test\n\temail = loki-test@example.invalid\n')"
    [ "$(cat -- "$marker" 2>/dev/null)" = "$seed" ] || return 64
    current_uid="$(id -u)" || return 64
    target_uid="$(loki_run_tmp_stat_field '%u' '%u' "$target")" || return 64
    marker_uid="$(loki_run_tmp_stat_field '%u' '%u' "$marker")" || return 64
    [ "$target_uid" = "$current_uid" ] && [ "$marker_uid" = "$current_uid" ] || return 64
    mode="$(loki_run_tmp_stat_field '%a' '%Lp' "$target")" || return 64
    mode="00${mode}"
    [ "${mode#"${mode%???}"}" = "700" ] || return 64
    target_real="$(cd "$target" 2>/dev/null && pwd -P)" || return 64
    [ "$target_real" = "$target" ] || return 64
    if [ -e "${target}/.git" ] || [ -L "${target}/.git" ]; then
        return 64
    fi
    return 0
}

loki_run_tmp_df_avail() {
    df -Pk "$1" 2>/dev/null | awk 'NR==2 {print $4}'
}

# Guarded reaper for dirs a killed run left in the temp root. Dry-run unless
# the first argument is "apply". Prints WOULD-REAP/REAPED/SKIP/REFUSE lines;
# never kills a process. A candidate is a direct child of the resolved temp
# root named loki-run.* or loki-test-home-*, at least 6h old (mtime),
# validated by the same contract as loki_run_tmp_cleanup, with no open file
# or cwd inside (lsof). Without lsof it skips everything.
loki_run_tmp_reap() {
    local mode="${1:-dry}" min_age="${LOKI_TMP_REAP_MIN_AGE:-21600}"
    local temp_root cand base now mtime age out rc before="" after kind own reaped=0

    if ! command -v lsof >/dev/null 2>&1; then
        printf '%s\n' "lsof not found: skipping every candidate, nothing reaped" >&2
        return 0
    fi
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64
    own="${LOKI_RUN_TMP:-}"
    now="$(date +%s)"
    [ "$mode" = "apply" ] && before="$(loki_run_tmp_df_avail "$temp_root")"

    while IFS= read -r cand; do
        [ -n "$cand" ] || continue
        base="$(basename -- "$cand")"
        case "$base" in
            loki-run.*) kind=run ;;
            loki-test-home-*) kind=home ;;
            *) continue ;;
        esac
        if [ -L "$cand" ]; then printf 'REFUSE symlink %s\n' "$cand"; continue; fi
        if [ ! -d "$cand" ]; then printf 'REFUSE not-a-directory %s\n' "$cand"; continue; fi
        if [ "$kind" = run ]; then
            loki_run_tmp_validate_dir "$cand" >/dev/null 2>&1 || { printf 'REFUSE no-valid-marker %s\n' "$cand"; continue; }
        else
            loki_test_home_validate_dir "$cand" >/dev/null 2>&1 || { printf 'REFUSE no-valid-marker %s\n' "$cand"; continue; }
        fi
        if [ -n "$own" ] && [ "$cand" = "$own" ]; then printf 'SKIP own-run %s\n' "$cand"; continue; fi
        mtime="$(loki_run_tmp_stat_field '%Y' '%m' "$cand")" || { printf 'SKIP no-mtime %s\n' "$cand"; continue; }
        age=$((now - mtime))
        if [ "$age" -lt "$min_age" ]; then printf 'SKIP young %s\n' "$cand"; continue; fi
        out="$(lsof -F p +D "$cand" 2>/dev/null)"; rc=$?
        if [ -n "$out" ] || [ "$rc" -eq 0 ]; then printf 'SKIP in-use %s\n' "$cand"; continue; fi
        if [ "$rc" -ne 1 ]; then printf 'SKIP lsof-failed %s\n' "$cand"; continue; fi
        if [ "$mode" = "apply" ]; then
            rm -rf -- "$cand"
            if [ -e "$cand" ]; then printf 'SKIP remove-failed %s\n' "$cand"; continue; fi
            printf 'REAPED %s\n' "$cand"
        else
            printf 'WOULD-REAP %s\n' "$cand"
        fi
        reaped=$((reaped + 1))
    done <<EOF
$(find "$temp_root" -mindepth 1 -maxdepth 1 \( -name 'loki-run.*' -o -name 'loki-test-home-*' \) 2>/dev/null)
EOF

    if [ "$mode" = "apply" ]; then
        after="$(loki_run_tmp_df_avail "$temp_root")"
        printf 'reaped=%s df_avail_kb before=%s after=%s delta=%s\n' "$reaped" "$before" "$after" "$((after - before))"
    else
        printf 'dry-run: %s candidate(s); nothing deleted (use apply to delete)\n' "$reaped"
    fi
}
