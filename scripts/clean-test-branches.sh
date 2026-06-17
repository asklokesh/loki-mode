#!/usr/bin/env bash
#
# clean-test-branches.sh
#
# Safely prunes leftover TEST / harness branches from a git repo. Test runs
# and manual scratch experiments can leave debris branches behind (worktree
# helpers, merge-conflict fixtures, sandbox experiments). This script removes
# ONLY branches matching a known debris allowlist and refuses to run anywhere
# it could damage real work.
#
# Hard safety rules (all enforced):
#   1. Refuses to operate on the real loki-mode repo (the repo that contains
#      this script). Test debris never belongs there.
#   2. Refuses to delete protected branches (main, master, develop, and any
#      feat/*, fix/*, release/*, hotfix/* branch).
#   3. Refuses to run while a live loki run is active (pgrep -f loki-run-),
#      because an in-flight run may legitimately own sandbox branches.
#   4. Deletes ONLY branches matching the debris patterns below.
#   5. Never touches the currently checked-out branch.
#
# Usage:
#   bash scripts/clean-test-branches.sh <repo-path>          # dry run (default)
#   bash scripts/clean-test-branches.sh <repo-path> --apply  # actually delete
#
# Exit codes: 0 = success (or nothing to do); nonzero = refused or error.
#
# Requires bash 4+ (uses mapfile and [[ =~ ]]). On macOS the system
# /bin/bash is 3.2; invoke via homebrew bash or `bash scripts/clean-test-branches.sh`.

set -uo pipefail

# --- debris branch patterns (extended-regex, anchored per-branch) ------------
# These match the test/harness naming conventions only. Add new patterns here
# as new debris classes are discovered; keep them specific.
DEBRIS_PATTERNS=(
    '^case[0-9]+[a-z]*$'              # case1, case2, case3a, case21 ...
    '^conflict-[0-9]+$'              # conflict-10527 (merge-conflict fixtures)
    '^loki-prdstub-[A-Za-z0-9]+$'    # loki-prdstub-BsoWju (PRD-stub temp)
    '^loki-pgtest-reap-[A-Za-z0-9]+$' # loki-pgtest-reap-0ReuUA (pg-reap temp)
    '^loki-pgtest-[A-Za-z0-9]+$'     # loki-pgtest-XXXXXX
    '^loki-prdstub-bin-[A-Za-z0-9]+$'
    '^test-loki-fs$'                 # manual filesystem scratch branch
    '^loki-test-wt-[0-9]+$'          # loki-test-wt-$$ (e2e worktree test)
    '^test-wt-[0-9]+$'
)

# --- protected branch patterns (never deleted, even if also debris-like) -----
PROTECTED_PATTERNS=(
    '^main$' '^master$' '^develop$' '^HEAD$'
    '^feat/' '^fix/' '^release/' '^hotfix/' '^chore/' '^docs/'
)

die() { echo "ERROR: $*" >&2; exit 1; }

REPO="${1:-}"
MODE="${2:-}"
[ -n "$REPO" ] || die "usage: $0 <repo-path> [--apply]"
[ -d "$REPO/.git" ] || die "not a git repo: $REPO"

APPLY=0
[ "$MODE" = "--apply" ] && APPLY=1

# Rule 1: never operate on this repo (the real loki-mode checkout).
SELF_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ABS="$(cd "$REPO" && pwd)"
if [ "$REPO_ABS" = "$SELF_REPO" ]; then
    die "refusing to run on the real loki-mode repo ($REPO_ABS). This script is for test-sandbox repos only."
fi
# Defense in depth: also refuse if the target looks like the loki-mode source
# tree (has VERSION + autonomy/loki), regardless of path.
if [ -f "$REPO_ABS/VERSION" ] && [ -f "$REPO_ABS/autonomy/loki" ]; then
    die "target looks like the loki-mode source tree ($REPO_ABS); refusing for safety."
fi

# Rule 3: refuse while a live loki run is active.
if pgrep -f "loki-run-" >/dev/null 2>&1; then
    die "a live loki run is active (pgrep -f loki-run-); refusing to prune branches mid-run."
fi

is_protected() {
    local b="$1" p
    for p in "${PROTECTED_PATTERNS[@]}"; do
        [[ "$b" =~ $p ]] && return 0
    done
    return 1
}

is_debris() {
    local b="$1" p
    for p in "${DEBRIS_PATTERNS[@]}"; do
        [[ "$b" =~ $p ]] && return 0
    done
    return 1
}

current_branch="$(git -C "$REPO_ABS" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")"

mapfile -t all_branches < <(git -C "$REPO_ABS" for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null)

to_delete=()
for b in "${all_branches[@]}"; do
    [ -n "$b" ] || continue
    [ "$b" = "$current_branch" ] && continue   # never the checked-out branch
    is_protected "$b" && continue              # never protected branches
    is_debris "$b" && to_delete+=("$b")
done

if [ "${#to_delete[@]}" -eq 0 ]; then
    echo "No debris branches found in $REPO_ABS. Nothing to do."
    exit 0
fi

echo "Repo:    $REPO_ABS"
echo "Current: ${current_branch:-<detached>}"
echo "Debris branches matched (${#to_delete[@]}):"
for b in "${to_delete[@]}"; do echo "  - $b"; done

if [ "$APPLY" -ne 1 ]; then
    echo ""
    echo "DRY RUN. Re-run with --apply to delete these branches:"
    echo "  bash $0 $REPO_ABS --apply"
    exit 0
fi

echo ""
deleted=0
for b in "${to_delete[@]}"; do
    if git -C "$REPO_ABS" branch -D "$b" >/dev/null 2>&1; then
        echo "deleted: $b"
        deleted=$((deleted + 1))
    else
        echo "FAILED to delete: $b" >&2
    fi
done
echo ""
echo "Deleted $deleted of ${#to_delete[@]} debris branches from $REPO_ABS."
exit 0
