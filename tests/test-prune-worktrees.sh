#!/usr/bin/env bash
# scripts/prune-worktrees.sh safety rules, run only against fixture repos built
# under the run-owned temp dir (never against this repository).
#  T1 four worktrees (live agent, dirty, merged clean, stale-mtime dirty):
#     --dry-run removes nothing; --apply removes only the merged clean one and
#     the worktree count drops by exactly 1.
#  T2 squash-merged branch is removed, unmerged branch is kept, a process whose
#     cwd is inside a merged worktree keeps it, a 0-commit worktree is kept
#     while young and removed once older than the age limit.
#  T3 mutation: with the dirty check dropped T1 must go red.
set -uo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
export LOKI_NO_BROWSER=1
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SRC_SH="$REPO_ROOT/scripts/prune-worktrees.sh"
# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
PIDS=""
cleanup() {
    local p
    for p in $PIDS; do kill "$p" 2>/dev/null || true; done
    loki_run_tmp_cleanup
}
trap cleanup EXIT
T="$LOKI_RUN_TMP"
PASS=0 FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

[ -f "$SRC_SH" ] || { echo "FAIL: $SRC_SH missing"; exit 1; }
command -v lsof >/dev/null 2>&1 || { echo "SKIP: lsof required"; exit 0; }

G() { git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false "$@"; }

# mkrepo <dir>: bare origin + clone with one commit on main pushed.
mkrepo() {
    local d="$1"
    mkdir -p "$d"
    G init -q --bare "$d/origin.git"
    G clone -q "$d/origin.git" "$d/repo" 2>/dev/null
    G -C "$d/repo" checkout -q -b main
    echo base >"$d/repo/base.txt"
    G -C "$d/repo" add base.txt
    G -C "$d/repo" commit -q -m base
    G -C "$d/repo" push -q origin main 2>/dev/null
}

# addwt <repo> <dir> <branch> [commit]: new worktree; with a 4th arg also commits a file.
addwt() {
    G -C "$1" worktree add -q -b "$3" "$2" main
    if [ -n "${4:-}" ]; then
        echo "$3" >"$2/$3.txt"
        G -C "$2" add "$3.txt"
        G -C "$2" commit -q -m "work $3"
    fi
}

wtcount() { G -C "$1" worktree list | wc -l | tr -d ' '; }
line_for() { printf '%s\n' "$1" | grep -F "($2)" | head -n 1; }

# scenario1 <script>: returns 0 when every T1 expectation holds.
scenario1() {
    local script="$1" d rc=0 out wts live_pid
    d="$(mktemp -d "$T/s1.XXXXXX")"
    mkrepo "$d"
    wts="$d/wts"; mkdir -p "$wts"
    sleep 300 & live_pid=$!
    PIDS="$PIDS $live_pid"
    addwt "$d/repo" "$wts/live" live 1
    addwt "$d/repo" "$wts/dirty" dirty 1
    addwt "$d/repo" "$wts/merged" merged 1
    addwt "$d/repo" "$wts/stale" stale 1
    local b
    for b in live dirty merged stale; do G -C "$d/repo" merge -q --no-edit "$b" 2>/dev/null; done
    G -C "$d/repo" push -q origin main 2>/dev/null
    G -C "$d/repo" worktree lock --reason "agent pid $live_pid" "$wts/live"
    echo "scratch" >"$wts/dirty/untracked.txt"
    echo "edit" >>"$wts/stale/stale.txt"
    touch -t 200001010000 "$wts/stale/stale.txt" "$wts/stale"
    [ "$(wtcount "$d/repo")" = 5 ] || { echo "  fixture count != 5"; rc=1; }

    out="$(bash "$script" "$d/repo" 2>&1)"
    case "$(line_for "$out" merged)" in REMOVE*) ;; *) echo "  dry-run: merged not REMOVE"; rc=1 ;; esac
    case "$(line_for "$out" live)" in KEEP*live*) ;; *) echo "  dry-run: live not KEEP/live"; rc=1 ;; esac
    case "$(line_for "$out" dirty)" in KEEP*dirty*) ;; *) echo "  dry-run: dirty not KEEP/dirty"; rc=1 ;; esac
    case "$(line_for "$out" stale)" in KEEP*dirty*) ;; *) echo "  dry-run: stale-mtime dirty not KEEP/dirty"; rc=1 ;; esac
    [ "$(wtcount "$d/repo")" = 5 ] || { echo "  dry-run changed the worktree count"; rc=1; }

    bash "$script" "$d/repo" --apply >/dev/null 2>&1
    [ "$(wtcount "$d/repo")" = 4 ] || { echo "  apply: count $(wtcount "$d/repo") != 4"; rc=1; }
    [ ! -d "$wts/merged" ] || { echo "  apply: merged dir still present"; rc=1; }
    G -C "$d/repo" rev-parse --verify -q refs/heads/merged >/dev/null && { echo "  apply: merged branch not deleted"; rc=1; }
    for b in live dirty stale; do
        [ -d "$wts/$b" ] || { echo "  apply: $b dir removed"; rc=1; }
        G -C "$d/repo" rev-parse --verify -q "refs/heads/$b" >/dev/null || { echo "  apply: $b branch deleted"; rc=1; }
    done
    kill "$live_pid" 2>/dev/null || true
    return $rc
}

if scenario1 "$SRC_SH"; then ok "T1 apply removes only the merged clean worktree (count 5 -> 4)"; else bad "T1 apply removes only the merged clean worktree"; fi

# T2: squash, unmerged, cwd-live, zero-commit.
d2="$(mktemp -d "$T/s2.XXXXXX")"
mkrepo "$d2"
r="$d2/repo"; w="$d2/wts"; mkdir -p "$w"
addwt "$r" "$w/sq" sq 1
G -C "$r" checkout -q sq -- sq.txt && G -C "$r" commit -q -m "squashed sq"
addwt "$r" "$w/open" open 1
addwt "$r" "$w/cwdlive" cwdlive 1
G -C "$r" merge -q --no-edit cwdlive 2>/dev/null
G -C "$r" push -q origin main 2>/dev/null
addwt "$r" "$w/zero" zero
( cd "$w/cwdlive" && exec sleep 300 ) & PIDS="$PIDS $!"
sleep 1
out="$(bash "$SRC_SH" "$r" 2>&1)"
case "$(line_for "$out" sq)" in REMOVE*squash*) ok "T2 squash-merged branch is removable" ;; *) bad "T2 squash-merged branch is removable"; echo "$out" ;; esac
case "$(line_for "$out" open)" in KEEP*) ok "T2 unmerged branch is kept" ;; *) bad "T2 unmerged branch is kept" ;; esac
case "$(line_for "$out" cwdlive)" in KEEP*cwd*) ok "T2 process cwd inside keeps the worktree" ;; *) bad "T2 process cwd inside keeps the worktree" ;; esac
case "$(line_for "$out" zero)" in KEEP*young*|KEEP*only*) ok "T2 young 0-commit worktree is kept" ;; *) bad "T2 young 0-commit worktree is kept"; echo "$out" ;; esac
out="$(LOKI_PRUNE_ZERO_COMMIT_MAX_AGE_SECS=0 bash "$SRC_SH" "$r" 2>&1)"
case "$(line_for "$out" zero)" in REMOVE*abandoned*) ok "T2 old clean 0-commit worktree is abandoned" ;; *) bad "T2 old clean 0-commit worktree is abandoned"; echo "$out" ;; esac
n_before="$(wtcount "$r")"
LOKI_PRUNE_ZERO_COMMIT_MAX_AGE_SECS=0 bash "$SRC_SH" "$r" --apply >/dev/null 2>&1
if [ "$(wtcount "$r")" = "$((n_before - 2))" ] && [ -d "$w/cwdlive" ] && [ -d "$w/open" ]; then ok "T2 apply removed exactly squash + zero, kept open + cwdlive"; else bad "T2 apply removed exactly squash + zero"; fi

# T3: mutation, drop the dirty check; T1 must go red.
MUT="$T/prune-mutant.sh"
sed 's/^is_dirty() {/is_dirty() { return 1;/' "$SRC_SH" >"$MUT"
if grep -q '^is_dirty() { return 1;' "$MUT"; then
    if scenario1 "$MUT" >/dev/null 2>&1; then bad "T3 dropping the dirty check must turn T1 red"; else ok "T3 dropping the dirty check turns T1 red"; fi
else
    bad "T3 mutation did not apply"
fi

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
