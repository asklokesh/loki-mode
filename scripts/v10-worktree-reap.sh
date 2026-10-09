#!/usr/bin/env bash
# scripts/v10-worktree-reap.sh (AUTO-REAP, FC-99)
#
# Removes finished slice worktrees under <repo>/.claude/worktrees so they can
# never pile up and fill the disk (377 worktrees / 56G once did). Safe to run
# at any time; the merge path and worktree creation both call it.
#
# A worktree is removed, by exact path, with plain (non-force)
# `git worktree remove`, when it is clean, unlocked, not the worktree you are
# standing in, and one of:
#   merged  HEAD is an ancestor of the base ref (default origin/main), and its
#           HEAD reflog is older than REAP_MERGED_GRACE_SECS (default 1800), so
#           a worktree just cut from main is not mistaken for a merged one.
#   idle    HEAD reflog (<git-dir>/logs/HEAD mtime, never the index mtime: any
#           checkout bumps that) is older than REAP_IDLE_SECS (default 21600,
#           6h) and no active BOARD.md row names the worktree or its branch.
# A detached HEAD that is not on the base ref gets a local branch
# wt-save/<name> before removal. Branches are never deleted. Dirty or locked
# worktrees are never removed while fresh; locked ones are never touched; both
# are listed. A DIRTY worktree past the idle threshold (and not named by an
# active BOARD row) is salvaged first: untracked node_modules and .rv/ are
# deleted (symlinks unlinked, never followed), tracked loki-ts/dist changes are
# discarded (regenerable), and everything else is committed file by file to
# branch wt-save/<name> (asklokesh identity) before the non-force remove. No
# rm -rf, no --force, no process killing.
#
# Usage:
#   scripts/v10-worktree-reap.sh [--dry-run]
#   scripts/v10-worktree-reap.sh --check-floor   # exit 0 if the repo volume has
#       at least LOKI_WORKTREE_DISK_FLOOR_GB (default 40) free; else reap, then
#       re-check; exit 75 (refuse) if still under.
#
# Never removed: a worktree holding ignored files outside a regenerable allowlist
# (.env, build/ output; see precious_ignored) is kept and listed, because
# `git status` hides ignored files and a remove would destroy them; secret-shaped
# files are never committed. Also kept: mid-rebase/merge/cherry-pick/bisect, and
# any worktree where a file (outside node_modules, .rv, .git) changed within the
# idle window.
#
# Known limits: (1) a locked worktree whose owning agent is dead is kept, since
# the reaper cannot tell dead from alive; (2) worktrees created by the agent
# harness bypass the disk floor unless the dispatcher creates them through
# scripts/v10-worktree-add.sh.
#
# Env overrides: REAP_REPO (repo path), REAP_BASE, REAP_BOARD, REAP_NOW,
# REAP_IDLE_SECS, REAP_MERGED_GRACE_SECS, REAP_FREE_GB_OVERRIDE (stub free GB).
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

DRY=0
MODE=reap
for a in "$@"; do
    case "$a" in
        --dry-run) DRY=1 ;;
        --check-floor) MODE=floor ;;
        -h|--help) sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) printf 'unknown argument: %s\n' "$a" >&2; exit 64 ;;
    esac
done

REPO_IN="${REAP_REPO:-$PWD}"
COMMON="$(git -C "$REPO_IN" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
    printf 'not a git repository: %s\n' "$REPO_IN" >&2
    exit 64
}
case "$COMMON" in
    */.git) ROOT="${COMMON%/.git}" ;;
    *) printf 'cannot resolve primary checkout from %s\n' "$COMMON" >&2; exit 64 ;;
esac
ROOT="$(cd "$ROOT" && pwd -P)"
WT_DIR="$ROOT/.claude/worktrees"
BASE="${REAP_BASE:-origin/main}"
git -C "$ROOT" rev-parse --verify -q "$BASE^{commit}" >/dev/null 2>&1 || BASE=main
BOARD="${REAP_BOARD:-$ROOT/docs/v10/BOARD.md}"
IDLE_SECS="${REAP_IDLE_SECS:-21600}"
GRACE_SECS="${REAP_MERGED_GRACE_SECS:-1800}"
SELF="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null)" || SELF=""
if [ -n "$SELF" ]; then SELF="$(cd "$SELF" && pwd -P)"; fi
FAILED=0

now() { if [ -n "${REAP_NOW:-}" ]; then printf '%s\n' "$REAP_NOW"; else date +%s; fi; }

# Numeric stat field, portable (same validation as loki_run_tmp_stat_field).
file_mtime() {
    local v
    v="$(stat -c %Y -- "$1" 2>/dev/null)" || v=''
    case "$v" in '' | *[!0-9]*) v="$(stat -f %m -- "$1" 2>/dev/null)" || v='' ;; esac
    case "$v" in '' | *[!0-9]*) return 1 ;; esac
    printf '%s\n' "$v"
}

# 0 when a non-terminal BOARD row names this worktree dir or its branch.
board_active() {
    local name line
    [ -f "$BOARD" ] || return 1
    for name in "$@"; do
        [ -n "$name" ] || continue
        while IFS= read -r line; do
            case "$line" in
                *"$name"*)
                    case "$line" in
                        *ready@* | *building@* | *review@* | *review-blocked@* | *approved@* | *blocked@*) return 0 ;;
                    esac
                    ;;
            esac
        done <"$BOARD"
    done
    return 1
}

# Delete one untracked scratch path inside a worktree: unlink a symlink, else
# delete the tree depth-first (find -delete never follows symlinks).
scrub_path() {
    if [ -L "$1" ]; then rm -f -- "$1"; elif [ -d "$1" ]; then find "$1" -depth -delete; else rm -f -- "$1"; fi
}

# Make a dirty idle worktree removable without losing work. Returns non-zero
# (worktree kept) when anything cannot be done safely.
salvage() {
    local path="$1" name="$2" line x f save n out
    local -a files=()
    # 1. untracked node_modules / .rv scratch (never tracked files)
    while IFS= read -r line; do
        case "$line" in "?? "*) ;; *) continue ;; esac
        f="${line#?? }"
        f="${f%/}"
        case "${f##*/}" in
            node_modules | .rv)
                if [ -z "$(git -C "$path" ls-files -- "$f")" ]; then scrub_path "$path/$f"; fi
                ;;
        esac
    done < <(git -C "$path" status --porcelain 2>/dev/null)
    # 2. regenerable dist changes are discarded, not saved
    if git -C "$path" status --porcelain -- loki-ts/dist 2>/dev/null | grep -q '^.[MD]\|^[MD]'; then
        git -C "$path" checkout -- loki-ts/dist 2>/dev/null || return 1
    fi
    out="$(git -C "$path" status --porcelain 2>/dev/null)" || return 1
    [ -n "$out" ] || return 0
    # 3. save the rest on wt-save/<name>, staged file by file
    save="wt-save/$name"
    n=1
    while git -C "$ROOT" show-ref --verify -q "refs/heads/$save"; do
        n=$((n + 1))
        save="wt-save/$name-$n"
    done
    git -C "$path" checkout -q -b "$save" 2>/dev/null || return 1
    while IFS= read -r -d '' line; do
        x="${line:0:2}"
        f="${line:3}"
        files+=("$f")
        case "$x" in R* | C*)
            IFS= read -r -d '' f
            files+=("$f")
            ;;
        esac
    done < <(git -C "$path" status --porcelain -z --untracked-files=all 2>/dev/null)
    for f in "${files[@]}"; do
        git -C "$path" add -- ":(literal)$f" >/dev/null 2>&1
    done
    env GIT_AUTHOR_NAME=asklokesh GIT_AUTHOR_EMAIL=lokeshmure@live.com \
        GIT_COMMITTER_NAME=asklokesh GIT_COMMITTER_EMAIL=lokeshmure@live.com \
        git -C "$path" commit -q \
        -m "wt-save: uncommitted state at reap" \
        -m "Claude-Session: https://claude.ai/code/session_01GFNzL4TEfAXvX1KK5buE9w" >/dev/null 2>&1 || return 1
    [ -z "$(git -C "$path" status --porcelain 2>/dev/null)" ] || return 1
    printf 'SAVED dirty state -> %s\n' "$save"
}

# Prints the first ignored file that is NOT a known-regenerable cache. Git
# status hides ignored files, but a non-force remove destroys them (.env,
# build/ output), and wt-save never captures them. Any such file makes the
# worktree precious: it is kept and listed, never removed, and secret-shaped
# files are never committed anywhere. Allowlist (regenerable): node_modules,
# .rv, __pycache__, .pytest_cache, .mypy_cache, .ruff_cache, .DS_Store, and
# loki-ts/dist.
precious_ignored() {
    local f seg skip
    while IFS= read -r -d '' f; do
        skip=0
        case "$f" in loki-ts/dist/*) skip=1 ;; esac
        if [ "$skip" = 0 ]; then
            local IFS=/
            for seg in $f; do
                case "$seg" in
                    node_modules | .rv | __pycache__ | .pytest_cache | .mypy_cache | .ruff_cache | .DS_Store) skip=1 ;;
                esac
            done
        fi
        if [ "$skip" = 0 ]; then printf '%s\n' "$f"; return 0; fi
    done < <(git -C "$1" ls-files -o -i --exclude-standard -z 2>/dev/null)
    return 0
}

# 0 when any file outside node_modules, .rv and .git changed inside the idle window.
recent_file_change() {
    local mins out
    mins=$(((IDLE_SECS + 59) / 60))
    out="$(find "$1" \( -name node_modules -o -name .rv -o -name .git \) -prune -o -type f -mmin "-$mins" -print -quit 2>/dev/null)"
    [ -n "$out" ]
}

reap_one() {
    local path="$1" head="$2" branch="$3" locked="$4"
    local name st gitdir logf mt age reason save n precious
    reason=""
    name="${path##*/}"
    if [ "$locked" = 1 ]; then printf 'LISTED locked %s\n' "$path"; return 0; fi
    if [ -n "$SELF" ] && [ "$path" = "$SELF" ]; then printf 'KEPT current %s\n' "$path"; return 0; fi
    if [ ! -d "$path" ]; then printf 'KEPT missing-dir %s\n' "$path"; return 0; fi
    if ! st="$(git -C "$path" status --porcelain 2>/dev/null)"; then
        printf 'LISTED status-failed %s\n' "$path"
        return 0
    fi
    gitdir="$(git -C "$path" rev-parse --absolute-git-dir 2>/dev/null)" || {
        printf 'KEPT no-gitdir %s\n' "$path"
        return 0
    }
    logf="$gitdir/logs/HEAD"
    mt="$(file_mtime "$logf")" || { printf 'KEPT no-reflog %s\n' "$path"; return 0; }
    age=$(($(now) - mt))
    for n in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do
        if [ -e "$gitdir/$n" ]; then printf 'KEPT in-progress-%s %s\n' "$n" "$path"; return 0; fi
    done
    if precious="$(precious_ignored "$path")" && [ -n "$precious" ]; then
        printf 'LISTED precious-ignored %s (e.g. %s)\n' "$path" "$precious"
        return 0
    fi
    # Idle clock: the reflog must be old AND no file (outside node_modules,
    # .rv, .git) may have changed within the idle window.
    if [ "$age" -ge "$IDLE_SECS" ] && recent_file_change "$path"; then age=0; fi
    if [ -n "$st" ]; then
        if [ "$age" -lt "$IDLE_SECS" ]; then printf 'LISTED dirty %s\n' "$path"; return 0; fi
        if board_active "$name" "$branch"; then printf 'LISTED dirty-board-active %s\n' "$path"; return 0; fi
        if [ "$DRY" = 1 ]; then printf 'WOULD-SAVE-REMOVE dirty-idle %s\n' "$path"; return 0; fi
        salvage "$path" "$name" || { printf 'LISTED dirty-save-failed %s\n' "$path"; return 0; }
        reason=dirty-idle
    elif git -C "$ROOT" merge-base --is-ancestor "$head" "$BASE" 2>/dev/null; then
        if [ "$age" -lt "$GRACE_SECS" ]; then printf 'KEPT fresh-merged %s\n' "$path"; return 0; fi
        reason=merged
    elif [ "$age" -ge "$IDLE_SECS" ]; then
        if board_active "$name" "$branch"; then printf 'KEPT board-active %s\n' "$path"; return 0; fi
        reason=idle
    else
        printf 'KEPT fresh %s\n' "$path"
        return 0
    fi
    if [ "$DRY" = 1 ]; then printf 'WOULD-REMOVE %s %s\n' "$reason" "$path"; return 0; fi
    if [ -z "$branch" ] && [ "$reason" = idle ]; then
        save="wt-save/$name"
        n=1
        while git -C "$ROOT" show-ref --verify -q "refs/heads/$save"; do
            n=$((n + 1))
            save="wt-save/$name-$n"
        done
        git -C "$ROOT" branch "$save" "$head" >/dev/null 2>&1 || {
            printf 'KEPT save-failed %s\n' "$path"
            return 0
        }
        printf 'SAVED %s -> %s\n' "$head" "$save"
    fi
    if git -C "$ROOT" worktree remove "$path" >/dev/null 2>&1; then
        printf 'REMOVED %s %s\n' "$reason" "$path"
    else
        printf 'KEPT remove-refused %s\n' "$path"
        FAILED=1
    fi
}

do_reap() {
    local path="" head="" branch="" locked=0 line
    FAILED=0
    while IFS= read -r line; do
        case "$line" in
            "worktree "*) path="${line#worktree }"; head=""; branch=""; locked=0 ;;
            "HEAD "*) head="${line#HEAD }" ;;
            "branch "*) branch="${line#branch refs/heads/}" ;;
            "locked"*) locked=1 ;;
            "")
                case "$path" in
                    "$WT_DIR"/*) if [ -n "$head" ]; then reap_one "$path" "$head" "$branch" "$locked"; fi ;;
                esac
                path=""
                ;;
        esac
    done < <(
        git -C "$ROOT" worktree list --porcelain 2>/dev/null
        printf '\n'
    )
    return "$FAILED"
}

free_gb() {
    local kb
    if [ -n "${REAP_FREE_GB_OVERRIDE:-}" ]; then printf '%s\n' "$REAP_FREE_GB_OVERRIDE"; return 0; fi
    kb="$(df -Pk "$ROOT" 2>/dev/null | awk 'NR==2 {print $4}')"
    case "$kb" in '' | *[!0-9]*) return 1 ;; esac
    printf '%s\n' $((kb / 1048576))
}

if [ "$MODE" = floor ]; then
    FLOOR="${LOKI_WORKTREE_DISK_FLOOR_GB:-40}"
    have="$(free_gb)" || { printf 'REFUSED: cannot read free space for %s\n' "$ROOT" >&2; exit 75; }
    if [ "$have" -ge "$FLOOR" ]; then exit 0; fi
    printf 'free space %sG is under the %sG floor; reaping first\n' "$have" "$FLOOR" >&2
    do_reap >&2
    have="$(free_gb)" || exit 75
    if [ "$have" -ge "$FLOOR" ]; then exit 0; fi
    printf 'REFUSED: %sG free is still under the %sG floor (LOKI_WORKTREE_DISK_FLOOR_GB); no new worktree\n' "$have" "$FLOOR" >&2
    exit 75
fi

do_reap
