#!/usr/bin/env bash
#
# prune-worktrees.sh - safely remove merged or abandoned agent worktrees.
#
# Usage:
#   bash scripts/prune-worktrees.sh [repo-path]           # dry run (default)
#   bash scripts/prune-worktrees.sh [repo-path] --apply   # remove
#
# A worktree is KEPT when any of these hold (checked in this order):
#   live    locked with a lock reason naming a live PID, OR a process has its
#           cwd inside it (lsof), OR a .loki / .claude marker file holds a live PID
#   dirty   `git status --porcelain` is not empty (untracked files included)
#   locked  locked for any other reason
# A clean, not-live worktree is REMOVED only when:
#   merged     the branch has >= 1 commit of its own and its tip is an ancestor
#              of origin/main, or (squash merge) `git diff <tip> origin/main --
#              <files the branch changed>` is empty
#   abandoned  the branch has 0 commits of its own AND the HEAD reflog is older
#              than LOKI_PRUNE_ZERO_COMMIT_MAX_AGE_SECS (default 7200)
# Directory mtime is never consulted. Removal is `git worktree remove` (no
# --force) followed by `git branch -d`; never -D, never rm -rf.
# The first (main) worktree and detached-HEAD worktrees are never touched.
# Base ref can be overridden with LOKI_PRUNE_BASE (default origin/main).
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

REPO="."
APPLY=0
for a in "$@"; do
    case "$a" in
        --apply) APPLY=1 ;;
        --dry-run) APPLY=0 ;;
        -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "unknown option: $a" >&2; exit 2 ;;
        *) REPO="$a" ;;
    esac
done

BASE="${LOKI_PRUNE_BASE:-origin/main}"
MAX_AGE="${LOKI_PRUNE_ZERO_COMMIT_MAX_AGE_SECS:-7200}"
git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo: $REPO" >&2; exit 2; }
git -C "$REPO" rev-parse --verify -q "$BASE^{commit}" >/dev/null || { echo "base ref $BASE not found" >&2; exit 2; }

# Snapshot every process cwd once: "pid<TAB>path" lines.
CWD_LIST=""
LSOF_OK=1
if command -v lsof >/dev/null 2>&1; then
    CWD_LIST="$(lsof -a -d cwd -Fpn 2>/dev/null | awk '/^p/{p=substr($0,2)} /^n/{print p "\t" substr($0,2)}')"
    [ -n "$CWD_LIST" ] || LSOF_OK=0
else
    LSOF_OK=0
fi

pid_alive() { case "$1" in ''|*[!0-9]*) return 1 ;; esac; kill -0 "$1" 2>/dev/null; }

# Echo a reason when the worktree is live, else nothing.
live_reason() {
    local wt="$1" lock="$2" real tok f pid
    if [ -n "$lock" ]; then
        for tok in $(printf '%s' "$lock" | tr -c 'A-Za-z0-9' ' '); do
            if pid_alive "$tok"; then echo "locked with live pid $tok"; return; fi
        done
    fi
    real="$(cd "$wt" 2>/dev/null && pwd -P)" || real="$wt"
    if [ -n "$CWD_LIST" ]; then
        pid="$(printf '%s\n' "$CWD_LIST" | awk -F'\t' -v w="$real" '$2==w || index($2, w "/")==1 {print $1; exit}')"
        if [ -n "$pid" ]; then echo "process $pid has its cwd inside"; return; fi
    fi
    while IFS= read -r f; do
        pid=""
        read -r pid _ <"$f" 2>/dev/null || true
        if pid_alive "$pid"; then echo "marker ${f#"$wt"/} holds live pid $pid"; return; fi
    done < <(find "$wt/.loki" "$wt/.claude" -maxdepth 3 -type f \( -name '*.pid' -o -name 'pid' -o -name '*.lock' \) 2>/dev/null)
}

is_dirty() { [ -n "$(git -C "$1" status --porcelain 2>/dev/null)" ]; }

# Echo "merged: ..." or "abandoned: ..." when removable, else "keep: ...".
judge() {
    local wt="$1" br="$2" tip created own mb files now ct
    tip="$(git -C "$REPO" rev-parse --verify -q "refs/heads/$br")" || { echo "keep: branch ref missing"; return; }
    created="$(git -C "$REPO" reflog show --format=%H "refs/heads/$br" 2>/dev/null | tail -n 1)"
    own=1
    # No branch reflog: cannot prove the branch has its own commits.
    if [ -z "$created" ] || [ "$created" = "$tip" ]; then own=0; fi
    if [ "$own" = 1 ]; then
        if git -C "$REPO" merge-base --is-ancestor "$tip" "$BASE" 2>/dev/null; then
            echo "merged: tip is an ancestor of $BASE"; return
        fi
        mb="$(git -C "$REPO" merge-base "$tip" "$BASE" 2>/dev/null)"
        if [ -n "$mb" ]; then
            files="$(git -C "$REPO" diff --name-only "$mb" "$tip" 2>/dev/null)"
            if [ -n "$files" ]; then
                # shellcheck disable=SC2086
                if (set -f; IFS=$'\n'; git -C "$REPO" diff --quiet "$tip" "$BASE" -- $files 2>/dev/null); then
                    echo "merged: squash, content of the changed files matches $BASE"; return
                fi
            fi
        fi
        echo "keep: branch has commits not on $BASE"; return
    fi
    ct="$(git -C "$wt" reflog show -1 --format=%ct HEAD 2>/dev/null)"
    case "$ct" in ''|*[!0-9]*) echo "keep: 0 commits and no HEAD reflog time"; return ;; esac
    now="$(date +%s)"
    if [ $((now - ct)) -gt "$MAX_AGE" ]; then
        echo "abandoned: 0 commits, HEAD reflog $((now - ct))s old (> ${MAX_AGE}s)"
    else
        echo "keep: 0 commits but HEAD reflog only $((now - ct))s old (<= ${MAX_AGE}s)"
    fi
}

REMOVE_N=0 KEEP_N=0 FAIL_N=0 FIRST=1
decide() {
    local wt="$1" br="$2" lock="$3" lockflag="$4" prunable="$5" r v
    if [ "$FIRST" = 1 ]; then FIRST=0; return; fi
    if [ -z "$br" ]; then echo "KEEP $wt (detached): detached HEAD"; KEEP_N=$((KEEP_N + 1)); return; fi
    if [ -n "$prunable" ] || [ ! -d "$wt" ]; then
        echo "KEEP $wt ($br): directory missing, use git worktree prune"; KEEP_N=$((KEEP_N + 1)); return
    fi
    r="$(live_reason "$wt" "$lock")"
    if [ -n "$r" ]; then echo "KEEP $wt ($br): live, $r"; KEEP_N=$((KEEP_N + 1)); return; fi
    if [ "$LSOF_OK" = 0 ]; then echo "KEEP $wt ($br): cannot list process cwds (lsof unavailable)"; KEEP_N=$((KEEP_N + 1)); return; fi
    if is_dirty "$wt"; then echo "KEEP $wt ($br): dirty (uncommitted or untracked files)"; KEEP_N=$((KEEP_N + 1)); return; fi
    if [ "$lockflag" = 1 ]; then echo "KEEP $wt ($br): locked"; KEEP_N=$((KEEP_N + 1)); return; fi
    v="$(judge "$wt" "$br")"
    case "$v" in
        keep:*) echo "KEEP $wt ($br): ${v#keep: }"; KEEP_N=$((KEEP_N + 1)) ;;
        *)
            if [ "$APPLY" = 0 ]; then
                echo "REMOVE $wt ($br): would remove, $v"; REMOVE_N=$((REMOVE_N + 1))
            elif git -C "$REPO" worktree remove "$wt" 2>/dev/null; then
                echo "REMOVE $wt ($br): removed, $v"; REMOVE_N=$((REMOVE_N + 1))
                git -C "$REPO" branch -d "$br" >/dev/null 2>&1 || echo "  note: branch $br kept (git branch -d declined)"
            else
                echo "KEEP $wt ($br): git worktree remove declined ($v)"; KEEP_N=$((KEEP_N + 1)); FAIL_N=$((FAIL_N + 1))
            fi
            ;;
    esac
}

# Parse `git worktree list --porcelain`; records are blank-line separated.
wt="" br="" lock="" lockflag=0 prunable=""
flush() {
    if [ -n "$wt" ]; then decide "$wt" "$br" "$lock" "$lockflag" "$prunable"; fi
    wt="" br="" lock="" lockflag=0 prunable=""
}
while IFS= read -r line; do
    case "$line" in
        "worktree "*) wt="${line#worktree }" ;;
        "branch refs/heads/"*) br="${line#branch refs/heads/}" ;;
        "locked") lockflag=1 ;;
        "locked "*) lockflag=1; lock="${line#locked }" ;;
        "prunable"*) prunable=1 ;;
        "") flush ;;
    esac
done < <(git -C "$REPO" worktree list --porcelain; echo)
flush

mode="dry run"; [ "$APPLY" = 1 ] && mode="apply"
echo "summary ($mode): remove=$REMOVE_N keep=$KEEP_N"
[ "$FAIL_N" = 0 ]
