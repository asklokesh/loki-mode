#!/usr/bin/env bash
# scripts/v10-worktree-add.sh (AUTO-REAP, FC-91)
#
# The one way to create a slice worktree: enforce the disk floor first (reaping
# finished worktrees if free space is low), then run `git worktree add` with the
# given arguments. Refuses (exit 75) when the repo volume stays under
# LOKI_WORKTREE_DISK_FLOOR_GB (default 40).
#
# Usage: scripts/v10-worktree-add.sh <git worktree add args...>
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$HERE/v10-worktree-reap.sh" --check-floor || exit $?
exec git worktree add "$@"
