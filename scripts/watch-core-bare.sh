#!/usr/bin/env bash
# Detect (and record) the recurring core.bare mutation on the parent checkout.
#
# THE FAULT. /Users/lokesh/git/lokimode-anthropic is a NON-BARE repository: it
# has a .git directory, a checked-out working tree, and a .git/index. Something
# is nevertheless setting core.bare=true on it. Twice observed:
#
#   05:33  set to false by hand, `git status` verified working
#   06:44  found true again -- 71 minutes later
#
# While it is true, `git status`, `git log` and any gh CI inspection from that
# directory fail with "this operation must be run in a work tree". Worktrees
# keep working, which is why the fault can go unnoticed until someone tries to
# inspect the parent.
#
# WHAT WAS ALREADY RULED OUT, by direct test rather than by reasoning:
#   - no code in this repository writes core.bare (repo-wide grep)
#   - `git worktree list`                 does not flip it
#   - `git worktree prune --dry-run`      does not flip it
#   - `git worktree add` / `remove`       does not flip it
#
# So the trigger is external to this repo and not reproducible on demand. This
# script exists because an unattributable event that recurs is worth CATCHING
# rather than re-diagnosing from scratch each time: it records WHEN the flip
# happened and what the config looked like, which is the evidence a future
# diagnosis needs and which nothing currently preserves.
#
# READ-ONLY BY DEFAULT when run standalone: it reports and records without
# restoring, because an unattended auto-repair loop would hide the recurrence,
# and the recurrence is the finding. Pass --restore to also set
# core.bare=false after recording -- this is what local CI does, because
# leaving the parent checkout unusable (git status/log broken) until a human
# notices is worse than the alternative: the gate still fails non-zero, the
# MUTATED line is still logged, and the config is still backed up, so the
# recurrence is still preserved as evidence even though the checkout is
# usable again by the time the gate reports failure.
#
# Usage:
#   scripts/watch-core-bare.sh            check once, report, exit 1 if mutated
#   scripts/watch-core-bare.sh --restore  also restore after recording
#
# Exit codes: 0 healthy, 1 mutation detected (restored, or restore not
# requested), 65 mutation detected but restore was requested and failed,
# 66 repo not found.

set -uo pipefail

REPO="${LOKI_PARENT_REPO:-/Users/lokesh/git/lokimode-anthropic}"
LOG="${LOKI_CORE_BARE_LOG:-$HOME/loki-ci-logs/core-bare-watch.log}"
RESTORE=0
[ "${1:-}" = "--restore" ] && RESTORE=1

if [ ! -d "$REPO/.git" ]; then
    printf 'watch-core-bare: %s has no .git directory\n' "$REPO" >&2
    exit 66
fi

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

bare="$(git -C "$REPO" config --get core.bare 2>/dev/null)"
stamp="$(date '+%Y-%m-%d %H:%M:%S')"
mtime="$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$REPO/.git/config" 2>/dev/null \
         || stat -c '%y' "$REPO/.git/config" 2>/dev/null)"

# A non-bare repo is one with a working tree. .git/index is the durable marker:
# a genuinely bare repo has no index because it tracks no checkout.
has_index="no"
[ -f "$REPO/.git/index" ] && has_index="yes"

if [ "$bare" = "true" ] && [ "$has_index" = "yes" ]; then
    printf 'MUTATED: core.bare=true on a repo that HAS a working tree (.git/index present)\n'
    printf '  repo:         %s\n' "$REPO"
    printf '  detected at:  %s\n' "$stamp"
    printf '  config mtime: %s\n' "$mtime"
    printf '  effect:       git status/log fail with "must be run in a work tree"\n'
    {
        printf '%s\tMUTATED\tconfig_mtime=%s\trepo=%s\n' "$stamp" "$mtime" "$REPO"
    } >> "$LOG" 2>/dev/null || true
    if [ "$RESTORE" = "1" ]; then
        cp "$REPO/.git/config" "$REPO/.git/config.bak-$(date +%s)" 2>/dev/null || true
        git -C "$REPO" config core.bare false 2>/dev/null
        after="$(git -C "$REPO" config --get core.bare 2>/dev/null)"
        printf '  restored:     core.bare=%s\n' "$after"
        if [ "$after" = "false" ]; then
            printf '%s\tRESTORED\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG" 2>/dev/null || true
        else
            printf '  RESTORE FAILED: core.bare is still not false\n'
            printf '%s\tRESTORE_FAILED\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG" 2>/dev/null || true
            printf '  log:          %s\n' "$LOG"
            exit 65
        fi
    else
        printf '  NOT restored (read-only by default; pass --restore to repair)\n'
    fi
    printf '  log:          %s\n' "$LOG"
    exit 1
fi

printf 'healthy: core.bare=%s  working_tree=%s  config_mtime=%s\n' \
       "${bare:-unset}" "$has_index" "$mtime"
exit 0
