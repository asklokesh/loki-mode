#!/usr/bin/env bash
# S-194 (BACKLOG 108): create_session_pr must not push, or advise a push of, a
# session branch whose history still holds the user's pre-existing files the
# agent committed. _loki_untrack_agent_committed_user_files removes them from
# the branch tip and records them in .loki/state/agent-committed-user-files.z,
# but the earlier commit that added them is still in the branch history, so a
# push would publish them (possibly secrets).
#
# Legs:
#   1  LOKI_AUTO_PR=1 with a record: no push, rc 1, cleanup line with the real
#      merge-base fork printed.
#   2  advisory path with a record: the cleanup line comes before git push -u.
#   3  empty record: the auto path pushes and the advisory path prints no
#      cleanup (behavior unchanged).
#   4  a scratch copy with the record read removed fails leg 1 (the guard is
#      what makes leg 1 pass, not the fixture).
#   5  resume: a second untrack run on the same branch (with and without a new
#      commit) keeps the record while history holds the file, so LOKI_AUTO_PR=1
#      still refuses.
#   6  a scratch copy without the helper's history check fails leg 5.
# Only create_session_pr, _loki_nul_names, _loki_untrack_agent_committed_user_files
# and _loki_covered_paths are extracted from run.sh; run.sh itself is never
# sourced. Push, gh and audit calls are stubbed.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="${LOKI_TEST_RUN_SH:-$ROOT/autonomy/run.sh}"
ADVISORY_LIB="$ROOT/autonomy/lib/git-pr-advisory.sh"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-auto-pr-refuse.XXXXXX")" || exit 1
W="$(cd "$W" && pwd -P)"
trap 'rm -rf "$W" "$ISOLATED_GIT_HOME"' EXIT
cd "$W" || exit 1

PROVIDER_BEFORE=absent
[ -e "$ROOT/.loki/state/provider" ] && PROVIDER_BEFORE=present

export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 LOKI_PROVEN_PR=0 LOKI_NO_BROWSER=1
git config --global user.name t
git config --global user.email t@example.invalid
git config --global init.defaultBranch main

extract() { awk -v n="$1" 'index($0, n "() {") == 1 { p = 1 } p { print } p && /^}/ { exit }' "$2"; }
{ extract create_session_pr "$RUN_SH"; extract _loki_nul_names "$RUN_SH"; } > "$W/lib.sh"
grep -q '^create_session_pr() {' "$W/lib.sh" && grep -q '^_loki_nul_names() {' "$W/lib.sh" \
    || { echo "FAIL: could not extract create_session_pr/_loki_nul_names from $RUN_SH"; exit 1; }

# A session branch as _loki_untrack_agent_committed_user_files leaves it: the
# agent committed the user's secret.env, then Loki untracked it on the tip.
make_repo() {
    local r="$W/$1"
    rm -rf "$r"
    mkdir -p "$r/.loki/state" && cd "$r" || return 1
    git init -q . && echo .loki/ > .git/info/exclude
    echo base > README && git add README && git commit -qm base
    git checkout -qb loki/session-1-1
    echo 'API_KEY=hunter2' > secret.env && echo work > app.txt
    git add secret.env app.txt && git commit -qm "agent commit"
    git rm -q --cached secret.env && git commit -qm "Loki Mode: untrack pre-existing user files the agent committed"
    printf 'loki/session-1-1' > .loki/state/agent-branch.txt
    printf 'main' > .loki/state/base-branch.txt
    printf 'secret.env\0' > .loki/state/agent-committed-user-files.z
}

# run_csp <repo> <lib> <auto 0|1>: prints combined output, then "RC=<n>".
run_csp() (
    cd "$W/$1" || exit 99
    PUSH_LOG="$W/$1.push"
    : > "$PUSH_LOG"
    log_warn() { echo "[WARN] $*"; }
    log_info() { echo "[INFO] $*"; }
    audit_log() { :; }
    _loki_trusted_repo() { echo octo/repo; }
    _loki_trusted_push() { echo "PUSH $*" >> "$PUSH_LOG"; return 0; }
    gh() { return 0; }
    # shellcheck disable=SC1090
    . "$ADVISORY_LIB"
    # shellcheck disable=SC1090
    . "$2"
    LOKI_AUTO_PR="$3" create_session_pr 2>&1
    echo "RC=$?"
)

# Leg 1: auto path with a record.
leg1() {
    local lib="$1" out fork
    make_repo l1 || return 1
    fork="$(git -C "$W/l1" merge-base HEAD main)"
    out="$(run_csp l1 "$lib" 1)"
    [ ! -s "$W/l1.push" ] && printf '%s\n' "$out" | grep -q '^RC=1$' \
        && printf '%s\n' "$out" | grep -qF "git reset --soft ${fork} && git commit" \
        && printf '%s\n' "$out" | grep -qF "secret.env"
}
if leg1 "$W/lib.sh"; then
    ok "leg 1: LOKI_AUTO_PR=1 with a record makes no push, returns 1 and prints git reset --soft <fork>"
else
    bad "leg 1: LOKI_AUTO_PR=1 with a record pushed, or did not return 1 / print the cleanup (push log: $(tr '\n' ' ' < "$W/l1.push"))"
fi

# Leg 2: advisory path with a record.
make_repo l2
fork2="$(git -C "$W/l2" merge-base HEAD main)"
out2="$(run_csp l2 "$W/lib.sh" 0)"
printf '%s\n' "$out2" > "$W/l2.out"
fix_ln="$(grep -nF "git reset --soft ${fork2} && git commit" "$W/l2.out" | head -1 | cut -d: -f1)"
push_ln="$(grep -nF "git push -u" "$W/l2.out" | head -1 | cut -d: -f1)"
if [ -n "$fix_ln" ] && [ -n "$push_ln" ] && [ "$fix_ln" -lt "$push_ln" ] && [ ! -s "$W/l2.push" ]; then
    ok "leg 2: advisory path prints the cleanup (line $fix_ln) before git push -u (line $push_ln)"
else
    bad "leg 2: advisory cleanup line missing or not before git push -u (fix=${fix_ln:-none} push=${push_ln:-none})"
fi

# Leg 3: empty record -> unchanged behavior on both paths.
make_repo l3a && : > "$W/l3a/.loki/state/agent-committed-user-files.z"
out3a="$(run_csp l3a "$W/lib.sh" 1)"
make_repo l3b && rm -f "$W/l3b/.loki/state/agent-committed-user-files.z"
out3b="$(run_csp l3b "$W/lib.sh" 0)"
if grep -q '^PUSH ' "$W/l3a.push" && printf '%s\n' "$out3a" | grep -q '^RC=0$' \
   && ! printf '%s\n%s\n' "$out3a" "$out3b" | grep -q 'git reset --soft' \
   && printf '%s\n' "$out3b" | grep -qF "git push -u origin loki/session-1-1"; then
    ok "leg 3: empty record pushes; absent record advises git push -u with no cleanup"
else
    bad "leg 3: empty or absent record changed behavior"
fi

# Leg 4: removing the record read in a scratch copy must fail leg 1.
sed '/^create_session_pr() {/,/^}/ s#agent-committed-user-files\.z#agent-committed-user-files.MUTATED#g' "$W/lib.sh" > "$W/mut.sh"
if cmp -s "$W/lib.sh" "$W/mut.sh"; then
    bad "leg 4: mutation changed nothing (create_session_pr never reads the record)"
elif leg1 "$W/mut.sh" >/dev/null 2>&1; then
    bad "leg 4: leg 1 still passes with the record read removed (vacuous)"
else
    ok "leg 4: removing the record read makes leg 1 fail"
fi

# Leg 5 (resume): session 1 runs the real untrack helper, which records
# secret.env; a resumed session 2 on the same branch runs it again (with and
# without a new agent commit). Its tree diff finds no hit, but the history
# still holds secret.env, so the record must survive and LOKI_AUTO_PR=1 must
# still refuse the push.
{ extract _loki_untrack_agent_committed_user_files "$RUN_SH"; extract _loki_covered_paths "$RUN_SH"; } > "$W/untrack.sh"
grep -q '^_loki_untrack_agent_committed_user_files() {' "$W/untrack.sh" && grep -q '^_loki_covered_paths() {' "$W/untrack.sh" \
    || { echo "FAIL: could not extract the untrack helpers from $RUN_SH"; exit 1; }
# leg5 <name> <untrack lib> <new commit in session 2: 0|1>: prints the result.
leg5() (
    local r="$W/$1" out
    rm -rf "$r" && mkdir -p "$r/.loki/state" && cd "$r" || exit 99
    git init -q . && echo .loki/ > .git/info/exclude
    echo base > README && git add README && git commit -qm base
    git checkout -qb loki/session-1-1
    echo 'API_KEY=hunter2' > secret.env
    printf 'secret.env\0' > .loki/state/preexisting-untracked.z
    printf 'loki/session-1-1' > .loki/state/agent-branch.txt
    printf 'main' > .loki/state/base-branch.txt
    log_warn() { :; }
    audit_agent_action() { :; }
    _loki_snapshot_verify() { return 0; }
    _loki_snapshot_py_tool() { command -v python3; }
    # shellcheck disable=SC1090
    . "$W/lib.sh"
    # shellcheck disable=SC1090
    . "$2"
    echo work > app.txt && git add secret.env app.txt && git commit -qm "agent s1"
    _loki_untrack_agent_committed_user_files loki/session-1-1 || { echo "S1RC=$?"; exit 0; }
    if [ "$3" = 1 ]; then echo more > app2.txt && git add app2.txt && git commit -qm "agent s2"; fi
    _loki_untrack_agent_committed_user_files loki/session-1-1 || { echo "S2RC=$?"; exit 0; }
    out="$(run_csp "$1" "$W/lib.sh" 1)"
    printf 'REC=%s %s PUSHED=%s\n' "$( { tr '\0' ' ' < .loki/state/agent-committed-user-files.z; } 2>/dev/null)" \
        "$(printf '%s\n' "$out" | grep '^RC=')" "$( [ -s "$W/$1.push" ] && echo yes || echo no )"
)
want5='REC=secret.env  RC=1 PUSHED=no'
got5a="$(leg5 l5a "$W/untrack.sh" 1)"
got5b="$(leg5 l5b "$W/untrack.sh" 0)"
if [ "$got5a" = "$want5" ] && [ "$got5b" = "$want5" ]; then
    ok "leg 5: a resumed session keeps the record while history holds secret.env; LOKI_AUTO_PR=1 still refuses"
else
    bad "leg 5: resumed session lost the record or pushed (with commit: [$got5a], without: [$got5b])"
fi

# Leg 6: dropping the history check in a scratch copy must fail leg 5.
sed 's#|| \[ -n "\$hist" \]; then#; then#' "$W/untrack.sh" > "$W/untrack-mut.sh"
if cmp -s "$W/untrack.sh" "$W/untrack-mut.sh"; then
    bad "leg 6: mutation changed nothing (no history check in the untrack helper)"
elif [ "$(leg5 l6 "$W/untrack-mut.sh" 1)" = "$want5" ]; then
    bad "leg 6: leg 5 still passes with the history check removed (vacuous)"
else
    ok "leg 6: removing the history check makes leg 5 fail"
fi

if [ "$PROVIDER_BEFORE" = absent ] && [ -e "$ROOT/.loki/state/provider" ]; then
    bad "test wrote .loki/state/provider into the repo"
else
    ok "no .loki/state/provider written into the repo"
fi

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
