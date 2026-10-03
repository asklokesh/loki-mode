#!/usr/bin/env bash
# S-219 (PO-SESSION-COMMIT-1): commit_session_changes ran `git add -A ... || true`,
# so a failed add staged nothing and the function then took the "nothing
# staged" clean no-op, silently committing nothing with no warning.
#
# Legs:
#   1  a failing `git add -A` (nothing staged): rc 0, a "Left uncommitted"
#      warning naming the staging failure, and no new commit.
#   2  a partially failing add (stages the file, then exits non-zero): no
#      commit is made and the index is left clean.
#   3  control: a working add commits the session work; here git add itself
#      exits 1 (ignored .loki named by a pathspec), which must stay benign.
#   4  a scratch copy with the add rc check removed fails leg 1.
# Only commit_session_changes is extracted from run.sh; run.sh is never
# sourced. Every helper it calls is stubbed.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="${LOKI_TEST_RUN_SH:-$ROOT/autonomy/run.sh}"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-session-add-fail.XXXXXX")" || exit 1
W="$(cd "$W" && pwd -P)"
trap 'rm -rf "$W" "$ISOLATED_GIT_HOME"' EXIT

export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 LOKI_NO_BROWSER=1
git config --global user.name t
git config --global user.email t@example.invalid
git config --global init.defaultBranch main

extract() { awk -v n="$1" 'index($0, n "() {") == 1 { p = 1 } p { print } p && /^}/ { exit }' "$2"; }
extract commit_session_changes "$RUN_SH" > "$W/lib.sh"
grep -q '^commit_session_changes() {' "$W/lib.sh" \
    || { echo "FAIL: could not extract commit_session_changes from $RUN_SH"; exit 1; }

make_repo() {
    local r="$W/$1"
    rm -rf "$r"
    mkdir -p "$r/.loki/state" && cd "$r" || return 1
    git init -q . && echo .loki/ > .git/info/exclude
    echo base > README && git add README && git commit -qm base
    git checkout -qb loki/session-1-1
    printf 'loki/session-1-1' > .loki/state/agent-branch.txt
    echo work > app.txt
}

# run_csc <repo> <lib> <add mode: ok|fail|partial>: prints output then RC=<n>.
run_csc() (
    cd "$W/$1" || exit 99
    local mode="$3"
    log_warn() { echo "[WARN] $*"; }
    log_info() { echo "[INFO] $*"; }
    audit_agent_action() { return 0; }
    _loki_session_created_verify() { return 0; }
    _loki_snapshot_verify() { return 0; }
    _loki_advance_tracked_since_anchor() { return 0; }
    _loki_untrack_agent_committed_user_files() { return 0; }
    _commit_path_looks_secret() { return 1; }
    _commit_scan_secret_file() { return 1; }
    _LOKI_SNAPSHOT_THIS_RUN=1
    git() {
        if [ "$1" = add ]; then
            case "$mode" in
                fail) return 128 ;;
                partial) command git "$@" >/dev/null 2>&1; return 128 ;;
            esac
        fi
        command git "$@"
    }
    # shellcheck disable=SC1090
    . "$2"
    commit_session_changes
    echo "RC=$?"
)

head_of() { git -C "$W/$1" rev-parse HEAD; }

# Leg 1
make_repo r1 || exit 1
before="$(head_of r1)"
out="$(run_csc r1 "$W/lib.sh" fail 2>&1)"
if echo "$out" | grep -q '^RC=0$' && echo "$out" | grep -q 'Left uncommitted: .*stag'; then
    ok "failed add: rc 0 and a Left uncommitted staging warning"
else
    bad "failed add gave no staging warning: $out"
fi
[ "$(head_of r1)" = "$before" ] && ok "failed add: no commit made" || bad "failed add: a commit was made"

# Leg 2
make_repo r2 || exit 1
before="$(head_of r2)"
out="$(run_csc r2 "$W/lib.sh" partial 2>&1)"
[ "$(head_of r2)" = "$before" ] && ok "partial add: no commit made" || bad "partial add: a commit was made"
if [ -z "$(git -C "$W/r2" diff --cached --name-only)" ]; then ok "partial add: index left clean"; else bad "partial add: index left staged"; fi
echo "$out" | grep -q 'Left uncommitted: .*stag' && ok "partial add: warning printed" || bad "partial add: no warning: $out"

# Leg 3
make_repo r3 || exit 1
before="$(head_of r3)"
run_csc r3 "$W/lib.sh" ok >/dev/null 2>&1
[ "$(head_of r3)" != "$before" ] && ok "control: working add commits the session work" || bad "control: no commit"

# Leg 4: remove the add's rc check in a scratch copy.
mut="$W/lib-mut.sh"
awk '
    /^    if \[ "\$add_rc" -gt 1 \]; then$/ { skip = 1; next }
    skip && /^    fi$/ { skip = 0; next }
    skip { next }
    { print }
' "$W/lib.sh" > "$mut"
if cmp -s "$W/lib.sh" "$mut"; then
    bad "mutation anchor not found"
else
    make_repo r4 || exit 1
    out="$(run_csc r4 "$mut" fail 2>&1)"
    if echo "$out" | grep -q 'Left uncommitted: .*stag'; then bad "mutated copy still warns (test is not guarding)"; else ok "mutated copy (|| true restored) fails the warning leg"; fi
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
