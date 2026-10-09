#!/usr/bin/env bash
# tests/test-worktree-reap.sh -- AUTO-REAP (FC-99): scripts/v10-worktree-reap.sh removes finished slice
# worktrees (never force), saves dirty/detached state to wt-save/<name> first, keeps fresh, locked and
# unmerged-fresh ones, refuses new worktrees under the disk floor; the pulse fires WORKTREE_SPRAWL above 20.
# REAP_SCRIPT overrides the script under test (red proof).
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REAP="${REAP_SCRIPT:-$SCRIPT_DIR/../scripts/v10-worktree-reap.sh}"
PULSE="$SCRIPT_DIR/../scripts/v10-pulse.sh"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/../eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 1
trap 'loki_run_tmp_cleanup' EXIT
T="$LOKI_RUN_TMP"

PASS=0
FAIL=0
ok() { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com

ORIGIN="$T/origin.git"
P="$T/primary"
git init -q --bare -b main "$ORIGIN"
git clone -q "$ORIGIN" "$P" 2>/dev/null
mkdir -p "$P/loki-ts/dist"
echo one >"$P/a.txt"
echo built >"$P/loki-ts/dist/a.js"
printf '.env\nbuild/\n' >"$P/.gitignore"
git -C "$P" add a.txt loki-ts/dist/a.js .gitignore
git -C "$P" commit -q -m base
git -C "$P" branch -M main
git -C "$P" push -q origin main 2>/dev/null
git -C "$P" fetch -q origin
WT="$P/.claude/worktrees"
mkdir -p "$WT"
OLD=202001010000

age_old() {
    touch -t "$OLD" "$(git -C "$1" rev-parse --absolute-git-dir)/logs/HEAD"
    find "$1" -name .git -prune -o -type f -exec touch -t "$OLD" {} +
}
mkwt_branch() { # name: new branch worktree with one unmerged commit
    git -C "$P" worktree add -q -b "slice-$1" "$WT/$1" origin/main 2>/dev/null
    echo "$1" >"$WT/$1/$1.txt"
    git -C "$WT/$1" add "$1.txt"
    git -C "$WT/$1" commit -q -m "work $1"
}
mkwt_merged() { git -C "$P" worktree add -q -b "slice-$1" "$WT/$1" origin/main 2>/dev/null; }

mkwt_merged merged-old
age_old "$WT/merged-old"
mkwt_merged merged-fresh
mkwt_branch idle-clean
age_old "$WT/idle-clean"
mkwt_branch detached-idle
git -C "$WT/detached-idle" checkout -q --detach
age_old "$WT/detached-idle"
DET_SHA="$(git -C "$WT/detached-idle" rev-parse HEAD)"
mkwt_branch dirty-idle
echo wip >"$WT/dirty-idle/wip.txt"
echo more >>"$WT/dirty-idle/a.txt"
mkdir -p "$WT/dirty-idle/.rv" "$T/real-nm"
echo scratch >"$WT/dirty-idle/.rv/s.txt"
echo keep >"$T/real-nm/marker"
ln -s "$T/real-nm" "$WT/dirty-idle/node_modules"
age_old "$WT/dirty-idle"
mkwt_branch dist-only
echo regenerated >>"$WT/dist-only/loki-ts/dist/a.js"
age_old "$WT/dist-only"
mkwt_branch dirty-fresh
echo wip >"$WT/dirty-fresh/wip.txt"
mkwt_branch locked-old
age_old "$WT/locked-old"
git -C "$P" worktree lock "$WT/locked-old"
mkwt_branch fresh-unmerged
mkwt_branch env-idle
echo SECRET >"$WT/env-idle/.env"
age_old "$WT/env-idle"
mkwt_branch build-idle
mkdir "$WT/build-idle/build"
echo out >"$WT/build-idle/build/out.txt"
age_old "$WT/build-idle"
mkwt_merged env-merged
echo SECRET >"$WT/env-merged/.env"
age_old "$WT/env-merged"
mkwt_branch env-dirty
echo SECRET >"$WT/env-dirty/.env"
echo wip >"$WT/env-dirty/wip.txt"
age_old "$WT/env-dirty"
mkwt_branch mid-merge
age_old "$WT/mid-merge"
: >"$(git -C "$WT/mid-merge" rev-parse --absolute-git-dir)/MERGE_HEAD"
mkwt_branch recent-file
age_old "$WT/recent-file"
touch "$WT/recent-file/recent-file.txt"

cd "$T" || exit 1
OUT="$(REAP_REPO="$P" REAP_BASE=origin/main bash "$REAP" 2>&1)"
rc=$?
printf '%s\n' "$OUT"
check "reaper exits 0 (rc=$rc)" '[ "$rc" = 0 ]'

gone() { [ ! -e "$WT/$1" ]; }
check "merged clean worktree removed" 'gone merged-old'
check "merged-old branch ref kept" 'git -C "$P" show-ref --verify -q refs/heads/slice-merged-old'
check "merged but fresh worktree kept" '! gone merged-fresh'
check "idle unmerged clean removed" 'gone idle-clean'
check "idle unmerged branch kept" 'git -C "$P" show-ref --verify -q refs/heads/slice-idle-clean'
check "detached unmerged idle removed" 'gone detached-idle'
check "detached unmerged got wt-save ref at its HEAD" '[ "$(git -C "$P" rev-parse refs/heads/wt-save/detached-idle 2>/dev/null)" = "$DET_SHA" ]'
check "dirty idle worktree removed" 'gone dirty-idle'
check "dirty idle saved on wt-save branch with its files" 'git -C "$P" show wt-save/dirty-idle:wip.txt 2>/dev/null | grep -q wip'
check "dirty idle saved tracked edit too" 'git -C "$P" show wt-save/dirty-idle:a.txt 2>/dev/null | grep -q more'
check "untracked .rv not saved" '! git -C "$P" ls-tree -r --name-only wt-save/dirty-idle | grep -q "^.rv/"'
check "node_modules symlink not saved" '! git -C "$P" ls-tree -r --name-only wt-save/dirty-idle | grep -q node_modules'
check "node_modules symlink unlinked, not followed (target intact)" '[ -f "$T/real-nm/marker" ]'
check "save commit uses asklokesh identity" '[ "$(git -C "$P" log -1 --format=%an wt-save/dirty-idle)" = asklokesh ]'
check "save commit message and session line" 'git -C "$P" log -1 --format=%B wt-save/dirty-idle | grep -q "^wt-save: uncommitted state at reap" && git -C "$P" log -1 --format=%B wt-save/dirty-idle | grep -q "^Claude-Session: "'
check "dist-only dirt removed without a save branch" 'gone dist-only && ! git -C "$P" show-ref --verify -q refs/heads/wt-save/dist-only'
check "dist change was discarded, not committed" '[ "$(git -C "$P" show slice-dist-only:loki-ts/dist/a.js)" = built ]'
check "dirty fresh kept and listed" '! gone dirty-fresh && grep -q "^LISTED dirty .*dirty-fresh" <<<"$OUT"'
check "locked worktree kept" '! gone locked-old'
check "locked worktree listed" 'grep -q "^LISTED locked .*locked-old" <<<"$OUT"'
check "fresh unmerged kept" '! gone fresh-unmerged'
check "tracked dist in primary untouched" '[ "$(cat "$P/loki-ts/dist/a.js")" = built ]'

check "idle clean worktree holding .env kept (ignored file would be destroyed)" '! gone env-idle && [ -f "$WT/env-idle/.env" ]'
check "precious-ignored worktree listed" 'grep -q "^LISTED precious-ignored .*env-idle" <<<"$OUT"'
check "idle worktree with build/ output kept" '! gone build-idle && [ -f "$WT/build-idle/build/out.txt" ]'
check "merged worktree holding .env kept" '! gone env-merged && [ -f "$WT/env-merged/.env" ]'
check "dirty worktree with .env kept, not salvaged" '! gone env-dirty && ! git -C "$P" show-ref --verify -q refs/heads/wt-save/env-dirty'
check ".env is never committed to any ref" '[ -z "$(git -C "$P" log --all --format=%H -- .env)" ]'
check "mid-merge worktree kept" '! gone mid-merge && grep -q "^KEPT in-progress-MERGE_HEAD .*mid-merge" <<<"$OUT"'
check "recent file change keeps an idle-reflog worktree" '! gone recent-file'

# BOARD active row protects an idle unmerged worktree
mkwt_branch board-held
age_old "$WT/board-held"
printf '| S-1 | x | slice-board-held @ abc | f | LOW | building@2026-10-08T00:00Z | n |\n' >"$T/BOARD.md"
REAP_REPO="$P" REAP_BASE=origin/main REAP_BOARD="$T/BOARD.md" bash "$REAP" >/dev/null 2>&1
check "idle worktree named by an active BOARD row kept" '! gone board-held'

# Disk floor
mkwt_branch floor-idle
age_old "$WT/floor-idle"
REAP_FREE_GB_OVERRIDE=5 REAP_REPO="$P" REAP_BASE=origin/main bash "$REAP" --check-floor >"$T/f1.out" 2>&1
frc=$?
check "floor: 5G free vs 40G floor refuses with rc 75 (rc=$frc)" '[ "$frc" = 75 ] && grep -q REFUSED "$T/f1.out"'
check "floor: reaper ran first and freed the idle worktree" 'grep -q "^REMOVED idle .*floor-idle" "$T/f1.out" && gone floor-idle'
REAP_FREE_GB_OVERRIDE=100 REAP_REPO="$P" REAP_BASE=origin/main bash "$REAP" --check-floor >/dev/null 2>&1
frc=$?
check "floor: 100G free passes with rc 0 (rc=$frc)" '[ "$frc" = 0 ]'
REAP_FREE_GB_OVERRIDE=30 LOKI_WORKTREE_DISK_FLOOR_GB=20 REAP_REPO="$P" REAP_BASE=origin/main bash "$REAP" --check-floor >/dev/null 2>&1
frc=$?
check "floor: env override lowers the floor (rc=$frc)" '[ "$frc" = 0 ]'

# Pulse WORKTREE_SPRAWL
pulse_list() {
    local n="$1" i out=""
    for i in $(seq 1 "$n"); do out="${out}worktree /repo/.claude/worktrees/wf-${i}
HEAD dead

"; done
    printf '%s' "$out"
}
run_pulse_n() {
    PULSE_REPO_ROOT="$P" PULSE_MAIN_REF=main PULSE_NPM_CMD=false PULSE_GH_CMD=false PULSE_GH_FALLBACK_CMD=false \
        PULSE_GH_STREAK_CMD=false PULSE_GOVERNOR_CMD=false PULSE_MOAT_RESULT='' \
        PULSE_WORKTREE_LIST="$(pulse_list "$1")" timeout -k 5 90 bash "$PULSE" 2>/dev/null
}
P21="$(run_pulse_n 21)"
P20="$(run_pulse_n 20)"
check "pulse: 21 worktrees fires WORKTREE_SPRAWL" 'grep -q "^VIOLATION: WORKTREE_SPRAWL" <<<"$P21"'
check "pulse: 20 worktrees does not fire WORKTREE_SPRAWL" 'grep -q "Worktrees under .claude/worktrees: 20" <<<"$P20" && ! grep -q "^VIOLATION: WORKTREE_SPRAWL" <<<"$P20"'

echo "worktree-reap: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
