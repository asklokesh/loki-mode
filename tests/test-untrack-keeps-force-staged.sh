#!/usr/bin/env bash
# S-220 (PO-SESSION-COMMIT-1): _loki_untrack_agent_committed_user_files used a
# global `git reset -q` before committing the untrack, which also dropped files
# an agent had force-staged (git add -f of an ignored agent file), so the
# session commit that follows silently left them out.
#
# Legs:
#   1  the untrack still removes the user's file from the branch tip.
#   2  a force-staged agent file is still staged afterwards (index keeps it).
#   3  the force-staged file is not inside the untrack commit.
#   4  a scratch copy with the global `git reset -q` restored fails leg 2.
# Only the untrack helper and its two local helpers are extracted from run.sh;
# run.sh is never sourced.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="${LOKI_TEST_RUN_SH:-$ROOT/autonomy/run.sh}"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-untrack-staged.XXXXXX")" || exit 1
W="$(cd "$W" && pwd -P)"
trap 'rm -rf "$W" "$ISOLATED_GIT_HOME"' EXIT

export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 LOKI_NO_BROWSER=1
git config --global user.name t
git config --global user.email t@example.invalid
git config --global init.defaultBranch main

extract() { awk -v n="$1" 'index($0, n "() {") == 1 { p = 1 } p { print } p && /^}/ { exit }' "$2"; }
build_lib() {
    { extract _loki_untrack_agent_committed_user_files "$1"; extract _loki_nul_names "$1"; extract _loki_covered_paths "$1"; } > "$2"
    grep -q '^_loki_untrack_agent_committed_user_files() {' "$2" \
        || { echo "FAIL: could not extract the untrack helper from $1"; exit 1; }
}

make_repo() {
    local r="$W/$1"
    rm -rf "$r"
    mkdir -p "$r/.loki/state" && cd "$r" || return 1
    git init -q . && echo .loki/ > .git/info/exclude
    echo staged-ignored.txt > .gitignore
    echo base > README && git add README .gitignore && git commit -qm base
    printf 'main' > .loki/state/base-branch.txt
    git checkout -qb loki/session-1-1
    echo secret > user.env
    echo work > app.txt
    git add user.env app.txt && git commit -qm "agent commit"
    printf 'user.env\0' > .loki/state/preexisting-untracked.z
    echo agent > staged-ignored.txt
    git add -f staged-ignored.txt
}

run_untrack() (
    cd "$W/$1" || exit 99
    # shellcheck disable=SC1090
    . "$2"
    log_warn() { echo "[WARN] $*"; }
    _loki_snapshot_verify() { return 0; }
    _loki_snapshot_py_tool() { command -v python3; }
    audit_agent_action() { return 0; }
    _loki_untrack_agent_committed_user_files loki/session-1-1
    echo "RC=$?"
)

build_lib "$RUN_SH" "$W/lib.sh"
make_repo r1 || exit 1
out="$(run_untrack r1 "$W/lib.sh" 2>&1)"
cd "$W/r1" || exit 1
if echo "$out" | grep -q '^RC=0$'; then ok "untrack returns 0"; else bad "untrack rc: $out"; fi
if git ls-tree -r --name-only HEAD | grep -qx user.env; then bad "user.env still on the branch tip"; else ok "user.env removed from the branch tip"; fi
if git diff --cached --name-only | grep -qx staged-ignored.txt; then ok "force-staged agent file still staged"; else bad "force-staged agent file dropped from the index"; fi
if git show --name-only --format= HEAD | grep -qx staged-ignored.txt; then bad "force-staged file leaked into the untrack commit"; else ok "untrack commit holds only the removal"; fi

# Mutation: restore a global reset right after the record is written.
mut="$W/lib-mut.sh"
awk '/^    mv -f "\$rec.new" "\$rec"$/ { print; print "    git reset -q >/dev/null 2>&1 || true"; next } { print }' "$W/lib.sh" > "$mut"
if cmp -s "$W/lib.sh" "$mut"; then
    bad "mutation anchor not found"
else
    make_repo r2 || exit 1
    run_untrack r2 "$mut" >/dev/null 2>&1
    cd "$W/r2" || exit 1
    if git diff --cached --name-only | grep -qx staged-ignored.txt; then
        bad "mutated copy still keeps the staged file (test is not guarding)"
    else
        ok "mutated copy (global reset restored) fails the keep-staged leg"
    fi
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
