#!/usr/bin/env bash
# scripts/prune-worktrees.sh
#
# List git worktrees under .claude/worktrees/ whose branch is fully merged into
# main, and (only with --apply) remove the ones that are safe to remove.
#
# Safety model (a worktree is removed ONLY when ALL of these hold):
#   * Its path is under <repo>/.claude/worktrees/ (never touches the main
#     checkout or any external worktree).
#   * It is NOT the current worktree (never removes the tree you are standing in).
#   * It is NOT locked. `git worktree lock` is how an active Claude agent marks
#     "in use"; a locked worktree is skipped even if its branch looks merged.
#   * No process has its cwd inside it (`lsof -d cwd -Fn`, E-96). A process can
#     be working there with nothing committed yet.
#   * Its branch's last commit is at least 30 minutes old
#     (`git log -1 --format=%ct`, E-96) -- a just-committed branch may still
#     have an agent about to write more.
#   * It has no eval results the durable archive doesn't already have
#     (E-101): every run_id in any eval/loki10/results/*/results.jsonl under
#     the worktree must already appear in an archived copy (the worktree's own
#     eval/loki10/archive/, or $LOKI_EVAL_ARCHIVE), checked by run_id set
#     membership, not by file hash -- the archive holds a redacted copy, never
#     byte-identical to the source.
#   * Its branch is merged into main: the tip is an ancestor of main
#     (`git merge-base --is-ancestor`), or every commit is patch-equivalent on
#     main (`git cherry main <branch>` shows no "+" line, the cherry-pick case),
#     i.e. nothing unique left to lose.
#   * Its working tree is clean (`git -C <path> status --porcelain` empty).
#
# Any check that cannot run (lsof missing/broken, unreadable commit time,
# unparseable results/archive JSON) REFUSES that worktree rather than guessing
# either way. Signals come only from `git log --format=%ct` and lsof's live
# process table, never from a filesystem timestamp or `find`'s age flags
# (GUARDS 5): those broke the incident this script exists to prevent.
#
# Default mode is DRY RUN: it prints what it WOULD remove and changes nothing.
# Pass --apply to actually run `git worktree remove` (which also deletes the
# directory and prunes the admin metadata). We never `rm -rf` a worktree.
#
# Branch deletion is intentionally NOT performed: removing the worktree leaves
# the (merged) branch ref in place; deleting refs is a separate, riskier op left
# to the operator.
#
# LOKI_EVAL_ARCHIVE overrides the external eval archive dir checked for
# already-archived results (default $HOME/loki-ci-logs/eval, matching
# eval/loki10/harness.py).
#
# Usage:
#   scripts/prune-worktrees.sh            # dry run (default)
#   scripts/prune-worktrees.sh --apply    # actually remove safe worktrees
#   scripts/prune-worktrees.sh --base BR  # compare against BR instead of main
#   scripts/prune-worktrees.sh -h|--help

set -uo pipefail

APPLY=0
BASE="main"

usage() {
    cat <<'EOF'
Usage: prune-worktrees.sh [--apply] [--base <branch>] [-h|--help]

Lists .claude/worktrees/* whose branch is fully merged into the base branch
(default: main) and whose tree is clean, then removes them ONLY with --apply.
Dry run by default. Locked worktrees and the current worktree are always kept.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --apply) APPLY=1; shift ;;
        --base) BASE="${2:?--base needs a branch name}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'Unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done

# Resolve the repo's main checkout (the common dir's parent), so .claude/worktrees
# is anchored to the canonical repo regardless of which worktree we run from.
if ! git rev-parse --git-dir >/dev/null 2>&1; then
    printf 'Not inside a git repository.\n' >&2
    exit 2
fi
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || true)"
# The main checkout root is the parent of the common .git dir. `git worktree
# list --porcelain` emits canonical (symlink-resolved) absolute paths, so we
# resolve MAIN_ROOT through the same canonicalization to make the prefix match
# reliably (notably on macOS where /var is a symlink to /private/var).
COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
[ -n "$COMMON_DIR" ] || COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || true)"
MAIN_ROOT=""
if [ -n "$COMMON_DIR" ]; then
    # Resolve the parent of the common .git dir to a physical path. `cd -P`
    # follows symlinks so the result matches porcelain's canonical paths.
    MAIN_ROOT="$(cd -P "$(dirname "$COMMON_DIR")" 2>/dev/null && pwd -P || true)"
fi
# Fall back to the toplevel (also canonical via show-toplevel) if needed.
[ -n "$MAIN_ROOT" ] || MAIN_ROOT="$TOPLEVEL"
WT_PREFIX="$MAIN_ROOT/.claude/worktrees/"

# Verify the base branch exists as a ref we can compare against.
if ! git rev-parse --verify --quiet "refs/heads/$BASE" >/dev/null 2>&1; then
    printf 'Base branch "%s" not found (refs/heads/%s). Use --base to pick another.\n' "$BASE" "$BASE" >&2
    exit 2
fi

CURRENT_WT=""
[ -n "$TOPLEVEL" ] && CURRENT_WT="$(cd "$TOPLEVEL" 2>/dev/null && pwd || true)"

# One lsof call for the whole run: every process's cwd, "n"-prefixed. Gated on
# CONTENT (at least one cwd line), never on exit status -- lsof's exit code is
# not a reliable "it worked" signal across platforms/permissions, but this
# process's own shell always has a cwd, so an empty result means lsof itself
# is missing, unsupported, or produced nothing usable.
LSOF_OK=0
LSOF_LIST=""
if command -v lsof >/dev/null 2>&1; then
    LSOF_LIST="$(lsof -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
    [ -n "$LSOF_LIST" ] && LSOF_OK=1
fi

live_process_inside() {  # PATH -> 0 if some process's cwd is PATH or under it
    local p="$1" line
    while IFS= read -r line; do
        case "$line" in
            "$p" | "$p"/*) return 0 ;;
        esac
    done <<<"$LSOF_LIST"
    return 1
}

# run_id membership, not byte-for-byte hashing: the archive holds a redacted
# copy of each row (eval/loki10/harness.py:redact_row), so it is never
# identical to the source results.jsonl. Exit 0: fully archived or nothing to
# check. Exit 1: real, un-archived rows exist (KEEP). Exit 2+: cannot verify
# (REFUSE) -- unreadable/unparseable JSON on either side.
ARCHIVED_OK_PY='
import glob, json, os, sys
path, ext_dir = sys.argv[1], sys.argv[2]
results = glob.glob(os.path.join(path, "eval/loki10/results/*/results.jsonl")) + \
    glob.glob(os.path.join(path, "eval/loki10/results/results.jsonl"))
if not results:
    sys.exit(0)
need = set()
for rf in results:
    try:
        with open(rf, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                row = json.loads(line)
                rid = row.get("run_id")
                if rid is None:
                    sys.exit(2)
                need.add(rid)
    except (OSError, ValueError):
        sys.exit(2)
have = set()
archives = glob.glob(os.path.join(path, "eval/loki10/archive/*.results.jsonl")) + \
    glob.glob(os.path.join(ext_dir, "*", "results.jsonl"))
for af in archives:
    try:
        with open(af, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                rid = row.get("run_id")
                if rid is not None:
                    have.add(rid)
    except OSError:
        continue
sys.exit(0 if need <= have else 1)
'
archived_ok() {  # PATH -> exit code per ARCHIVED_OK_PY above
    python3 -c "$ARCHIVED_OK_PY" "$1" "${LOKI_EVAL_ARCHIVE:-$HOME/loki-ci-logs/eval}"
}

# Parse `git worktree list --porcelain` into per-worktree records.
WT_PATH=""; WT_BRANCH=""; WT_LOCKED=0; WT_DETACHED=0
candidates=0; removable=0; removed=0; skipped=0

branch_merged() {
    local out
    git merge-base --is-ancestor "refs/heads/$1" "refs/heads/$BASE" 2>/dev/null && return 0
    out="$(git cherry "refs/heads/$BASE" "refs/heads/$1" 2>/dev/null)" || return 1
    # Any line starting with "+" is a commit with no equivalent on base.
    [[ $'\n'"$out" != *$'\n+'* ]]
}

process_record() {
    [ -n "$WT_PATH" ] || return 0
    local path="$WT_PATH" branch="$WT_BRANCH" locked="$WT_LOCKED" detached="$WT_DETACHED"

    # Only consider worktrees physically under .claude/worktrees/.
    case "$path/" in
        "$WT_PREFIX"*) ;;
        *) return 0 ;;
    esac
    candidates=$((candidates + 1))

    # Never the current worktree.
    if [ -n "$CURRENT_WT" ] && [ "$path" = "$CURRENT_WT" ]; then
        printf '  SKIP  %-55s (current worktree)\n' "$path"
        skipped=$((skipped + 1)); return 0
    fi
    # Never a locked worktree (active agent).
    if [ "$locked" -eq 1 ]; then
        printf '  SKIP  %-55s (locked)\n' "$path"
        skipped=$((skipped + 1)); return 0
    fi
    # No live process may have its cwd inside it (E-96). Refuse rather than
    # guess when the check itself is unusable (lsof missing/broken).
    if [ "$LSOF_OK" -ne 1 ]; then
        printf '  REFUSE %-55s (cannot check for a live process inside it: lsof unavailable)\n' "$path"
        skipped=$((skipped + 1)); return 0
    fi
    if live_process_inside "$path"; then
        printf '  SKIP  %-55s (a process has its cwd inside it)\n' "$path"
        skipped=$((skipped + 1)); return 0
    fi
    # Need a concrete branch to evaluate age and "merged".
    if [ "$detached" -eq 1 ] || [ -z "$branch" ]; then
        printf '  SKIP  %-55s (detached HEAD; no branch to test)\n' "$path"
        skipped=$((skipped + 1)); return 0
    fi
    # Its branch's last commit must be at least 30 minutes old (E-96): a
    # just-committed branch may still have an agent about to write more.
    commit_ts="$(git log -1 --format=%ct "refs/heads/$branch" -- 2>/dev/null)"
    case "$commit_ts" in
        '' | *[!0-9]*)
            printf '  REFUSE %-55s (cannot read last commit time for %s)\n' "$path" "$branch"
            skipped=$((skipped + 1)); return 0 ;;
    esac
    now_ts="$(date +%s)"
    if [ $((now_ts - commit_ts)) -lt 1800 ]; then
        printf '  KEEP  %-55s (branch %s committed less than 30 minutes ago)\n' "$path" "$branch"
        skipped=$((skipped + 1)); return 0
    fi
    # No un-archived eval results (E-101): a merged, clean tree still loses
    # results.jsonl, which is gitignored and so invisible to `git status`.
    archived_ok "$path"
    case $? in
        0) ;;
        1)
            printf '  KEEP  %-55s (un-archived eval results present)\n' "$path"
            skipped=$((skipped + 1)); return 0 ;;
        *)
            printf '  REFUSE %-55s (cannot verify eval results are archived)\n' "$path"
            skipped=$((skipped + 1)); return 0 ;;
    esac
    # Branch must be fully merged into the base: either its tip is an ancestor
    # of base, or every one of its commits is patch-equivalent on base
    # (`git cherry` prints no "+" line). The second case is how cherry-picked
    # slices land. A failing `git cherry` counts as not merged.
    if ! branch_merged "$branch"; then
        printf '  KEEP  %-55s (branch %s not merged into %s)\n' "$path" "$branch" "$BASE"
        skipped=$((skipped + 1)); return 0
    fi
    # Working tree must be clean.
    if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
        printf '  KEEP  %-55s (uncommitted changes present)\n' "$path"
        skipped=$((skipped + 1)); return 0
    fi

    removable=$((removable + 1))
    if [ "$APPLY" -eq 1 ]; then
        if git worktree remove "$path" 2>/dev/null; then
            printf '  REMOVED %-53s (branch %s, merged + clean)\n' "$path" "$branch"
            removed=$((removed + 1))
        else
            printf '  FAILED  %-53s (git worktree remove returned non-zero)\n' "$path"
        fi
    else
        printf '  WOULD-REMOVE %-48s (branch %s, merged + clean)\n' "$path" "$branch"
    fi
}

while IFS= read -r line; do
    case "$line" in
        worktree\ *)
            process_record
            WT_PATH="${line#worktree }"; WT_BRANCH=""; WT_LOCKED=0; WT_DETACHED=0 ;;
        branch\ refs/heads/*)
            WT_BRANCH="${line#branch refs/heads/}" ;;
        detached) WT_DETACHED=1 ;;
        locked*) WT_LOCKED=1 ;;
        "") : ;;  # blank line between records; defer flush to next "worktree "
    esac
done < <(git worktree list --porcelain)
process_record  # flush the final record

echo ""
if [ "$APPLY" -eq 1 ]; then
    printf 'Done. candidates=%d removable=%d removed=%d kept/skipped=%d\n' \
        "$candidates" "$removable" "$removed" "$skipped"
else
    printf 'Dry run. candidates=%d would-remove=%d kept/skipped=%d\n' \
        "$candidates" "$removable" "$skipped"
    [ "$removable" -gt 0 ] && printf 'Re-run with --apply to remove the %d worktree(s) above.\n' "$removable"
fi
exit 0
