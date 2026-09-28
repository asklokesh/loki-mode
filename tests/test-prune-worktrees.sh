#!/usr/bin/env bash
# tests/test-prune-worktrees.sh (S-154, E-96, E-101; GUARDS 5)
#
# scripts/prune-worktrees.sh must count a cherry-picked branch (every commit
# patch-equivalent on main, `git cherry` shows no "+" line) as merged, keep a
# branch with a unique commit, keep locked and dirty worktrees, remove only
# through `git worktree remove`, keep a worktree with a live process inside
# it or a commit less than 30 minutes old, keep one with eval results the
# archive doesn't have yet, remove one whose results ARE archived, and refuse
# everything when lsof itself cannot be trusted. It must never use file-age
# signals.
#
# PRUNE_WORKTREES_SCRIPT overrides the script under test (red/mutation proofs).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRUNE="${PRUNE_WORKTREES_SCRIPT:-$SCRIPT_DIR/../scripts/prune-worktrees.sh}"

PASS=0; FAIL=0
pass() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

TMP_ROOT="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
WORK="$(mktemp -d "$TMP_ROOT/loki-test-prune-worktrees.XXXXXX")" || exit 1
LIVE_PID=""
cleanup() {
    [ -n "$LIVE_PID" ] && kill "$LIVE_PID" 2>/dev/null
    rm -rf -- "$WORK"
}
trap cleanup EXIT

# Isolate git from the host's global/system config (hooks, signing).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

REPO="$WORK/repo"
WT="$REPO/.claude/worktrees"
g() { git -C "$REPO" "$@" >/dev/null 2>&1; }

NOW_TS="$(date +%s)"
OLD_TS=$((NOW_TS - 7200))          # 2 hours ago: clears the 30-minute gate
export LOKI_EVAL_ARCHIVE="$WORK/ext-archive"  # never used in this fixture; keeps $HOME out of it

git init -q -b main "$REPO" || exit 1
printf 'base\n' >"$REPO/base.txt"
# eval/loki10/results and .../archive are gitignored in the real repo too
# (eval/loki10/.gitignore); mirror that so a fixture's results.jsonl never
# makes the clean-tree check fire before the archived-results check does.
printf '.claude/\neval/loki10/results/\neval/loki10/archive/\n' >"$REPO/.gitignore"
g add base.txt .gitignore
GIT_AUTHOR_DATE="@$OLD_TS" GIT_COMMITTER_DATE="@$OLD_TS" g commit -q -m base
GIT_AUTHOR_DATE="@$OLD_TS" GIT_COMMITTER_DATE="@$OLD_TS" g commit -q --allow-empty -m "main moves on"

# add_wt NAME [now]: branch NAME from the first commit with one commit
# touching NAME.txt, committed 2 hours ago unless "now" is passed.
add_wt() {
    local name="$1" when="${2:-old}"
    g worktree add -q -b "$name" "$WT/$name" main~1
    printf '%s\n' "$name" >"$WT/$name/$name.txt"
    git -C "$WT/$name" add "$name.txt" >/dev/null 2>&1
    if [ "$when" = now ]; then
        git -C "$WT/$name" commit -q -m "$name change" >/dev/null 2>&1
    else
        GIT_AUTHOR_DATE="@$OLD_TS" GIT_COMMITTER_DATE="@$OLD_TS" \
            git -C "$WT/$name" commit -q -m "$name change" >/dev/null 2>&1
    fi
}

# Plain ancestor case: branched from main's current (backdated) tip, before
# any cherry-pick below moves main forward with a freshly-timestamped commit
# -- `git cherry-pick` re-stamps the committer date to now, so an ancestor
# defined after those would always read as "committed seconds ago".
g worktree add -q -b ancestor "$WT/ancestor" main

# Cherry-picked onto main: not an ancestor, but patch-equivalent.
for n in picked locked dirty unarchived archived live; do
    add_wt "$n"
    g cherry-pick "refs/heads/$n"
done
add_wt unique                       # one commit main never received
add_wt recent now                   # merged, but committed seconds ago
g cherry-pick "refs/heads/recent"
g worktree lock "$WT/locked"
printf 'wip\n' >"$WT/dirty/wip.txt" # untracked file makes it dirty

# E-101: eval results with no matching archived row -> KEEP.
mkdir -p "$WT/unarchived/eval/loki10/results/t1"
printf '%s\n' '{"run_id": "run-unarchived-1", "task": "t1"}' \
    >"$WT/unarchived/eval/loki10/results/t1/results.jsonl"

# E-101: eval results whose run_id IS already in this worktree's own
# in-repo archive -> the results check passes, so this one reaches
# WOULD-REMOVE (positive control: the check does not over-block).
mkdir -p "$WT/archived/eval/loki10/results/t1" "$WT/archived/eval/loki10/archive"
printf '%s\n' '{"run_id": "run-archived-1", "task": "t1"}' \
    >"$WT/archived/eval/loki10/results/t1/results.jsonl"
printf '%s\n' '{"run_id": "run-archived-1", "arm": "v10", "task": "t1"}' \
    >"$WT/archived/eval/loki10/archive/run1.results.jsonl"

# E-96: a live process with its cwd inside the worktree -> SKIP, never removed.
bash -c 'cd "$1" && exec sleep 300' _ "$WT/live" &
LIVE_PID=$!
# lsof reads the live process table; give it a moment to be visible.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    lsof -d cwd -Fn 2>/dev/null | grep -qF "$WT/live" && break
    sleep 0.3
done

# Sanity: the cherry-picked branch really is not an ancestor of main.
if git -C "$REPO" merge-base --is-ancestor refs/heads/picked refs/heads/main; then
    fail "fixture: picked must not be an ancestor of main"
fi

out="$(cd "$REPO" && bash "$PRUNE" 2>&1)"; rc=$?
printf '%s\n' "$out" | sed 's/^/    | /'

[ "$rc" -eq 0 ] && pass "dry run exits 0" || fail "dry run exits 0 (rc=$rc)"
line_for() { printf '%s\n' "$out" | grep -F "$WT/$1 " || printf '%s\n' "$out" | grep -F "$WT/$1"; }
expect() { # expect NAME VERB
    case "$(line_for "$1")" in
        *"$2"*) pass "$1 -> $2" ;;
        *) fail "$1 -> $2 (got: $(line_for "$1"))" ;;
    esac
}
expect picked WOULD-REMOVE
expect ancestor WOULD-REMOVE
expect unique KEEP
expect locked SKIP
expect dirty KEEP
expect recent KEEP
expect live SKIP
expect unarchived KEEP
expect archived WOULD-REMOVE

# Unsupported check refuses (E-96): a broken lsof must block removal instead
# of guessing, even for a worktree (`picked`) the real lsof above just let
# through. Run this before the real --apply, while removable candidates
# still exist, so "nothing removed" is an actual assertion.
STUBBIN="$WORK/stubbin"
mkdir -p "$STUBBIN"
cat >"$STUBBIN/lsof" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$STUBBIN/lsof"
out="$(cd "$REPO" && PATH="$STUBBIN:$PATH" bash "$PRUNE" 2>&1)"
case "$(printf '%s\n' "$out" | grep -F "$WT/picked" || true)" in
    *REFUSE*) pass "broken lsof: picked refused, not evaluated" ;;
    *) fail "broken lsof: picked not refused (got: $out)" ;;
esac
out="$(cd "$REPO" && PATH="$STUBBIN:$PATH" bash "$PRUNE" --apply 2>&1)"
if [ -d "$WT/picked" ] && [ -d "$WT/ancestor" ] && [ -d "$WT/archived" ]; then
    pass "broken lsof --apply: removed nothing"
else
    fail "broken lsof --apply: removed something despite an unusable lsof check"
fi

# --apply removes only the removable ones, through git worktree remove
# (which also drops the admin entry, so nothing is left "prunable").
out="$(cd "$REPO" && bash "$PRUNE" --apply 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && pass "--apply exits 0" || fail "--apply exits 0 (rc=$rc)"
list="$(git -C "$REPO" worktree list --porcelain)"
for n in picked ancestor archived; do
    if [ ! -e "$WT/$n" ] && ! printf '%s\n' "$list" | grep -qF "$WT/$n"; then
        pass "--apply removed $n (dir and worktree entry gone)"
    else
        fail "--apply removed $n"
    fi
done
for n in unique locked dirty recent live unarchived; do
    if [ -d "$WT/$n" ] && printf '%s\n' "$list" | grep -qF "$WT/$n"; then
        pass "--apply kept $n"
    else
        fail "--apply kept $n"
    fi
done
[ -f "$WT/dirty/wip.txt" ] && pass "dirty worktree's uncommitted file survives" \
    || fail "dirty worktree's uncommitted file survives"

kill "$LIVE_PID" 2>/dev/null; wait "$LIVE_PID" 2>/dev/null; LIVE_PID=""

# Removal path: git worktree remove only, never rm -rf (comment lines excluded:
# the header documents that it never uses rm -rf).
if grep -nvE '^[[:space:]]*#' "$PRUNE" | grep -E 'rm[[:space:]]+-[A-Za-z]*r'; then
    fail "script deletes with rm -r instead of git worktree remove"
else
    pass "script never deletes with rm -r"
fi
grep -q 'git worktree remove' "$PRUNE" && pass "script removes via git worktree remove" \
    || fail "script removes via git worktree remove"

# GUARDS 5: no file-age signals (stat, mtime, -mmin, -newer) anywhere in it.
if grep -nE '(^|[^A-Za-z0-9_-])(stat|mtime|-mmin|-newer)([^A-Za-z0-9_]|$)' "$PRUNE"; then
    fail "script uses a file-age signal (GUARDS 5)"
else
    pass "script uses no file-age signal (GUARDS 5)"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
