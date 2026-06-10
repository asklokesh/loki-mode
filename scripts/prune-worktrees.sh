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
#   * Its branch tip is an ancestor of main (`git merge-base --is-ancestor`),
#     i.e. fully merged with nothing unique left to lose.
#   * Its working tree is clean (`git -C <path> status --porcelain` empty).
#
# Default mode is DRY RUN: it prints what it WOULD remove and changes nothing.
# Pass --apply to actually run `git worktree remove` (which also deletes the
# directory and prunes the admin metadata). We never `rm -rf` a worktree.
#
# Branch deletion is intentionally NOT performed: removing the worktree leaves
# the (merged) branch ref in place; deleting refs is a separate, riskier op left
# to the operator.
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

# Parse `git worktree list --porcelain` into per-worktree records.
WT_PATH=""; WT_BRANCH=""; WT_LOCKED=0; WT_DETACHED=0
candidates=0; removable=0; removed=0; skipped=0

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
    # Need a concrete branch to evaluate "merged".
    if [ "$detached" -eq 1 ] || [ -z "$branch" ]; then
        printf '  SKIP  %-55s (detached HEAD; no branch to test)\n' "$path"
        skipped=$((skipped + 1)); return 0
    fi
    # Branch must be fully merged into the base (its tip an ancestor of base).
    if ! git merge-base --is-ancestor "refs/heads/$branch" "refs/heads/$BASE" 2>/dev/null; then
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
