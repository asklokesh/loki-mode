#!/usr/bin/env bash
# BACKLOG 149 round 5: Loki's credentialed push and gh calls never load the
# agent's repo config.
#
# One plant at a time, each in a fresh agent repo. For every plant:
#   control  the OLD path (a credentialed `git push origin` from inside the
#            agent repo, or git run in the agent cwd the way gh's internal git
#            does) must record the canary credential -- proves the plant is
#            live, so the fixed assertion is not vacuous;
#   fixed    _loki_trusted_push / _loki_run_neutral must record nothing, and
#            the push must still reach the real remote with the credential.
# Plants: .git/hooks/pre-push, core.hooksPath, include.path, includeIf,
# url.pushInsteadOf, url.insteadOf, core.sshCommand, and (on the gh path)
# a repo-local credential.helper and core.fsmonitor.
# Synthetic credentials only; no network (every URL is rewritten to a local
# bare repo by the operator's global config).
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="${LOKI_TEST_RUN_SH:-$ROOT/autonomy/run.sh}"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-trusted-push.XXXXXX")" || exit 1
W="$(cd "$W" && pwd -P)"
trap 'rm -rf "$W" "$ISOLATED_GIT_HOME"' EXIT

awk '
    /^_LOKI_WITHHELD_TOKENS=""$/ { on = 1 }
    on { print }
    on && /^_loki_withhold_github_tokens\(\) \{$/ { last = 1 }
    last && /^}$/ { exit }
' "$RUN_SH" > "$W/withhold.sh"
grep -q '^_loki_trusted_push()' "$W/withhold.sh" \
    || { echo "FAIL: _loki_trusted_push not found in run.sh"; exit 1; }
log_warn() { :; }
log_info() { :; }
# shellcheck disable=SC1091
. "$W/withhold.sh"

CANARY="ghp_TRUSTEDPUSHCANARY000000000000"
SOCK="/tmp/loki-trusted-push-canary.sock"
REC="$W/plant.rec"
URL="https://github.com/octocat/hello.git"
SSH_URL="ssh://git@github.com/octocat/hello.git"
# The re-grant, modeled: the real (synthetic) credentials for one command.
cred() { GH_TOKEN="$CANARY" SSH_AUTH_SOCK="$SOCK" "$@"; }

# Operator side: global config (trusted) routes both origin forms to local
# bare repos; a fake `ssh` on PATH serves the ssh form locally.
export HOME="$W/home"
mkdir -p "$HOME" "$W/bin"
export PATH="$W/bin:$PATH"
export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0
unset GIT_SSH_COMMAND GH_TOKEN GITHUB_TOKEN SSH_AUTH_SOCK GIT_CONFIG_COUNT
# S-100: _loki_trusted_push resolves the default branch (gh repo view
# OWNER/REPO --jq) before pushing; the stub answers main.
printf '#!/bin/sh\n[ "$1 $2" = "repo view" ] && [ -n "${3:-}" ] && echo main\nexit 0\n' > "$W/bin/gh"
chmod +x "$W/bin/gh"
mkbare() {
    git init -q --bare "$1"
    printf '#!/bin/sh\necho "%s token=${GH_TOKEN:-none}" >> "%s"\n[ "${GH_TOKEN:-}" = "%s" ]\n' \
        "$2" "$W/$2.log" "$CANARY" > "$1/hooks/pre-receive"
    chmod +x "$1/hooks/pre-receive"
}
mkdir -p "$W/gh/octocat"
mkbare "$W/gh/octocat/hello.git" remote
mkbare "$W/attacker.git" attacker
# Host-level prefixes, so an agent's more specific (longer) rewrite would win
# on the old path, as it would against a real operator with no rewrite at all.
git config --global url."$W/gh/".insteadOf "https://github.com/"
git config --global url."ssh://moat.invalid/".insteadOf "ssh://git@github.com/"
git config --global user.email x@example.invalid
git config --global user.name x
git config --global init.defaultBranch main
printf '#!/bin/sh\nwhile [ $# -gt 1 ]; do shift; done\nexec ${1%%%% *} %s\n' "$W/gh/octocat/hello.git" > "$W/bin/ssh"
chmod +x "$W/bin/ssh"

# The plant: records which one fired and the credentials it could see.
PLANT="$W/plant.sh"
printf '#!/bin/sh\necho "$PLANT_TAG token=${GH_TOKEN:-none} sock=${SSH_AUTH_SOCK:-none}" >> "%s"\n' "$REC" > "$PLANT"
chmod +x "$PLANT"
mkhookdir() {
    mkdir -p "$1"
    printf '#!/bin/sh\nPLANT_TAG=%s %s\n' "$2" "$PLANT" > "$1/pre-push"
    chmod +x "$1/pre-push"
}

new_agent() {  # <name> <origin-url>: fresh agent repo with two branches
    local a="$W/agent-$1"
    git init -q "$a"
    git -C "$a" commit -q --allow-empty -m init
    git -C "$a" branch "loki/ctl-$1"
    git -C "$a" branch "loki/fix-$1"
    git -C "$a" remote add origin "$2"
    printf '%s\n' "$a"
}

plant() {  # <name> <agent>
    local n="$1" a="$2"
    case "$n" in
        hook) mkhookdir "$a/.git/hooks" hook ;;
        hookspath) mkhookdir "$W/hp-$n" hookspath; git -C "$a" config core.hooksPath "$W/hp-$n" ;;
        include)
            mkhookdir "$W/hp-$n" include
            printf '[core]\n\thooksPath = %s\n' "$W/hp-$n" > "$W/inc-$n"
            git -C "$a" config include.path "$W/inc-$n" ;;
        includeif)
            mkhookdir "$W/hp-$n" includeif
            printf '[core]\n\thooksPath = %s\n' "$W/hp-$n" > "$W/inc-$n"
            git -C "$a" config "includeIf.gitdir:$a/.git.path" "$W/inc-$n" ;;
        pushinsteadof) git -C "$a" config url."$W/attacker.git".pushInsteadOf "$URL" ;;
        insteadof) git -C "$a" config url."$W/attacker.git".insteadOf "$URL" ;;
        sshcommand)
            printf '#!/bin/sh\nPLANT_TAG=sshcommand %s\nexec ssh "$@"\n' "$PLANT" > "$W/plant-ssh"
            chmod +x "$W/plant-ssh"
            git -C "$a" config core.sshCommand "$W/plant-ssh" ;;
        credhelper)
            printf '#!/bin/sh\nPLANT_TAG=credhelper %s\necho password=planted\n' "$PLANT" > "$W/plant-cred"
            chmod +x "$W/plant-cred"
            git -C "$a" config credential.helper "!$W/plant-cred" ;;
        fsmonitor)
            printf '#!/bin/sh\nPLANT_TAG=fsmonitor %s\nexit 1\n' "$PLANT" > "$W/plant-fsmon"
            chmod +x "$W/plant-fsmon"
            git -C "$a" config core.fsmonitor "$W/plant-fsmon" ;;
    esac
}

fired_with_canary() {  # <tag>: the plant recorded the canary (attacker log for *insteadof)
    case "$1" in
        *insteadof) grep -q "token=$CANARY" "$W/attacker.log" 2>/dev/null ;;
        *) grep -q "^$1 token=$CANARY" "$REC" 2>/dev/null ;;
    esac
}
reset_logs() { : > "$REC"; : > "$W/attacker.log"; : > "$W/remote.log"; }

# --- push-path plants ---------------------------------------------------------
for n in hook hookspath include includeif pushinsteadof insteadof sshcommand; do
    origin="$URL"
    [ "$n" = sshcommand ] && origin="$SSH_URL"
    a="$(new_agent "$n" "$origin")"
    plant "$n" "$a"

    reset_logs
    ( cd "$a" && cred git push -q origin "loki/ctl-$n" ) >/dev/null 2>&1
    if fired_with_canary "$n"; then
        ok "[$n] control: the old in-repo credentialed push runs the plant with the credential"
    else
        bad "[$n] control: the plant did not fire on the old path (plant not live; rec: $(tr '\n' ',' < "$REC"))"
    fi

    reset_logs
    ( cd "$a" && _loki_trusted_push cred . "loki/fix-$n" ) >/dev/null 2>&1
    rc=$?
    if fired_with_canary "$n" || grep -q "token=$CANARY" "$REC"; then
        bad "[$n] fixed: a plant saw the credential ($(tr '\n' ',' < "$REC"; tr '\n' ',' < "$W/attacker.log"))"
    else
        ok "[$n] fixed: no plant saw the credential"
    fi
    if [ "$rc" -eq 0 ] && grep -qx "remote token=$CANARY" "$W/remote.log"; then
        ok "[$n] fixed: the push reached the real remote with the credential"
    else
        bad "[$n] fixed: the push did not reach the real remote (rc=$rc, remote log: $(tr '\n' ',' < "$W/remote.log"))"
    fi
done

# --- gh-path plants: git as gh runs it internally (repo detection, status) ----
for n in credhelper fsmonitor; do
    a="$(new_agent "$n" "$URL")"
    plant "$n" "$a"
    probe() { printf 'protocol=https\nhost=moat-p9.invalid\n\n' | git credential fill; git status --porcelain; }
    reset_logs
    ( cd "$a" && cred probe ) >/dev/null 2>&1
    fired_with_canary "$n" \
        && ok "[$n] control: git in the agent cwd runs the plant with the credential" \
        || bad "[$n] control: the plant did not fire in the agent cwd (rec: $(tr '\n' ',' < "$REC"))"
    reset_logs
    ( cd "$a" && TARGET_DIR="$a" cred _loki_run_neutral "$(TARGET_DIR="$a" _loki_trusted_repo)" probe ) >/dev/null 2>&1
    grep -q "token=$CANARY" "$REC" \
        && bad "[$n] fixed: a plant saw the credential ($(tr '\n' ',' < "$REC"))" \
        || ok "[$n] fixed: git run the gh way (from /) loads no agent config"
done

# --- origin validation ------------------------------------------------------
for u in "https://github.com/o/r.git" "git@github.com:o/r.git" "ssh://git@github.com/o/r" "https://github.com/o/r"; do
    [ "$(_loki_github_repo_from_url "$u")" = "o/r" ] && ok "accepts $u" || bad "rejects valid $u"
done
for u in "https://evil.example/o/r.git" "https://x:tok@github.com/o/r.git" "https://github.com/o/r/extra" \
    "https://github.com/../r" "https://github.com/o" "file:///tmp/r" "https://github.com.evil/o/r" "https://github.com/o/r;x"; do
    _loki_github_repo_from_url "$u" >/dev/null 2>&1 && bad "accepts invalid $u" || ok "rejects $u"
done
a="$(new_agent badorigin "https://evil.example/o/r.git")"
reset_logs
( cd "$a" && _loki_trusted_push cred . "loki/fix-badorigin" ) >/dev/null 2>&1 \
    && bad "pushed to a non-GitHub origin" || ok "refuses to push to a non-GitHub origin"

# --- round 6: origin forms, refusal reasons, shallow repos -------------------
for u in "https://GitHub.com/o/r.git" "git@GITHUB.COM:o/r" "https://github.com/o/r/" "ssh://git@github.com/o/r.git/"; do
    [ "$(_loki_github_repo_from_url "$u")" = "o/r" ] && ok "accepts $u" || bad "rejects valid $u"
done
for u in "git@github.com-work:o/r.git" "ssh://git@github.com-work/o/r"; do
    _loki_github_repo_from_url "$u" >/dev/null 2>&1 && bad "accepts SSH host alias $u" || ok "rejects SSH host alias $u"
    case "$(_loki_origin_refusal "$u")" in
        *"SSH host alias"*) ok "refusal names the SSH host alias for $u" ;;
        *) bad "refusal for $u does not name the alias: $(_loki_origin_refusal "$u")" ;;
    esac
done
case "$(_loki_origin_refusal "https://gitlab.com/o/r.git")" in
    *"not on github.com"*) ok "refusal names a non-GitHub host" ;;
    *) bad "refusal for a GitLab origin is unclear: $(_loki_origin_refusal "https://gitlab.com/o/r.git")" ;;
esac
_loki_origin_refusal "https://x:ghp_SECRETINURL@github.com/o/r.git" | grep -q ghp_SECRETINURL \
    && bad "refusal echoes an embedded credential" || ok "refusal never echoes the URL"

# A shallow agent repo (clone --depth 1 of a two-commit history).
a="$(new_agent shallow-src "$URL")"
git -C "$a" commit -q --allow-empty -m second
# The origin already holds the full history, as it does for any real shallow
# clone (receive-pack refuses a shallow update onto history it never saw).
cred git -C "$a" push -q "$W/gh/octocat/hello.git" HEAD:refs/heads/shallow-base 2>/dev/null
git clone -q --depth 1 "file://$a" "$W/agent-shallow" 2>/dev/null
git -C "$W/agent-shallow" commit -q --allow-empty -m "agent work on a shallow clone"
git -C "$W/agent-shallow" remote set-url origin "$URL"
git -C "$W/agent-shallow" branch loki/fix-shallow
[ "$(git -C "$W/agent-shallow" rev-parse --is-shallow-repository)" = true ] \
    && ok "shallow fixture really is shallow" || bad "shallow fixture is not shallow (test proves nothing)"
reset_logs
( cd "$W/agent-shallow" && _loki_trusted_push cred . loki/fix-shallow ) >/dev/null 2>&1 \
    && grep -qx "remote token=$CANARY" "$W/remote.log" \
    && ok "a shallow agent repo's branch is pushed" \
    || bad "a shallow agent repo's branch was not pushed (remote log: $(tr '\n' ',' < "$W/remote.log"))"

# --- round 6: origin pinned before the first iteration ------------------------
a="$(new_agent pinned "$URL")"
(
    cd "$a" || exit 1
    TARGET_DIR="$a" _loki_pin_origin
    reset_logs
    _loki_trusted_push cred . loki/fix-pinned >/dev/null 2>&1 && grep -qx "remote token=$CANARY" "$W/remote.log" \
        && echo "UNCHANGED_PUSHED" || echo "UNCHANGED_NOT_PUSHED"
    # The agent repoints origin at another github.com repository. The route to
    # the attacker repo is in the (test) operator's global config, which the
    # trusted push does load, so a push there would be observable and never
    # touches the network.
    git config --global url."$W/attacker.git".insteadOf "https://github.com/attacker/other.git"
    git remote set-url origin "https://github.com/attacker/other.git"
    reset_logs
    _loki_trusted_push cred . loki/ctl-pinned >/dev/null 2>&1; echo "REPOINTED_RC=$?"
    [ -s "$W/attacker.log" ] && echo "ATTACKER_REACHED" || echo "ATTACKER_UNTOUCHED"
) > "$W/pin.out"
grep -qx UNCHANGED_PUSHED "$W/pin.out" && ok "pinned origin, unchanged: pushed" || bad "pinned origin, unchanged: not pushed ($(tr '\n' ' ' < "$W/pin.out"))"
grep -qx REPOINTED_RC=2 "$W/pin.out" && grep -qx ATTACKER_UNTOUCHED "$W/pin.out" \
    && ok "origin repointed to another GitHub repo during the run: push refused, nothing sent" \
    || bad "origin repointed during the run was not refused ($(tr '\n' ' ' < "$W/pin.out"))"

# --- round 6: proof-check resolves the repo when gh runs from / ---------------
# The gh stub behaves like real gh on the one point that matters: `gh repo
# view` with no argument resolves from the CWD's git remote and ignores
# GH_REPO, so from / it fails. `gh api` records what it was asked to post.
GHLOG="$W/gh.log"
cat > "$W/bin/gh" <<EOF
#!/bin/sh
case "\$1 \$2" in
    "auth status") exit 0 ;;
    "repo view") [ -n "\${3:-}" ] && [ "\${3#-}" = "\$3" ] && { echo main; exit 0; }  # S-100 lookup
                 git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repository" >&2; exit 1; }
                 echo "octocat/hello" ;;
    "pr view") echo "0123456789abcdef0123456789abcdef01234567" ;;
    "api "*) echo "api \$*" >> "$GHLOG" ;;
esac
exit 0
EOF
chmod +x "$W/bin/gh"
( cd / && gh repo view --json nameWithOwner >/dev/null 2>&1 ) \
    && bad "gh stub resolves repo view from / (it must not, like real gh)" \
    || ok "control: gh repo view with no argument fails from /, as real gh does"
printf '{"honesty":{"headline":"VERIFIED"},"run_id":"r1"}\n' > "$W/proof.json"
a="$(new_agent proofcheck "$URL")"
: > "$GHLOG"
# shellcheck disable=SC1091
( cd "$a" && export TARGET_DIR="$a" && . "$ROOT/autonomy/lib/proof-check.sh" \
    && cred post_verified_completion_check "$W/proof.json" "https://github.com/octocat/hello/pull/1" ) >/dev/null 2>&1
grep -q "repos/octocat/hello/check-runs" "$GHLOG" \
    && ok "proof-check posts the check-run for the origin repo when gh runs from /" \
    || bad "proof-check did not post (could not resolve the repo from /; gh log: $(tr '\n' ',' < "$GHLOG"))"

# --- FC-TRUSTED-PUSH-PARTIAL-CLONE: a --filter=blob:none agent repo ------------
# upload-pack on a partial clone dies serving objects it never downloaded, so
# the temp repo is seeded with the origin as a promisor remote first. The
# origin is the same local bare repo the operator's insteadOf routes URL to.
PC_ORIGIN="$W/gh/octocat/hello.git"
git -C "$PC_ORIGIN" config uploadpack.allowFilter true
git -C "$PC_ORIGIN" config uploadpack.allowAnySHA1InWant true
PC_SEED="$W/pc-seed"
git init -q "$PC_SEED"
echo base > "$PC_SEED/a.txt"; git -C "$PC_SEED" add a.txt; git -C "$PC_SEED" commit -q -m base
echo two > "$PC_SEED/b.txt"; git -C "$PC_SEED" add b.txt; git -C "$PC_SEED" commit -q -m two
# A blob only in history (deleted at the tip) is never downloaded by the
# blob:none clone's checkout, so serving it from the clone is what dies.
echo old > "$PC_SEED/old.txt"; git -C "$PC_SEED" add old.txt; git -C "$PC_SEED" commit -q -m old
git -C "$PC_SEED" rm -q old.txt; git -C "$PC_SEED" commit -q -m "drop old"
cred git -C "$PC_SEED" push -q "$PC_ORIGIN" HEAD:refs/heads/pc-base 2>/dev/null
git clone -q --filter=blob:none -b pc-base "file://$PC_ORIGIN" "$W/agent-partial" 2>/dev/null
git -C "$W/agent-partial" checkout -q -b loki/fix-partial
echo agent > "$W/agent-partial/c.txt"
git -C "$W/agent-partial" add c.txt
git -C "$W/agent-partial" commit -q -m "agent work on a partial clone"
git -C "$W/agent-partial" remote set-url origin "$URL"
[ "$(git -C "$W/agent-partial" config --get remote.origin.promisor)" = true ] \
    && ok "partial-clone fixture really is a partial clone" || bad "partial-clone fixture is not partial (test proves nothing)"
reset_logs
( cd "$W/agent-partial" && _loki_trusted_push cred . loki/fix-partial ) >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ] && [ -n "$(git -C "$PC_ORIGIN" rev-parse -q --verify refs/heads/loki/fix-partial)" ]; then
    ok "a partial-clone agent repo's branch is pushed"
else
    bad "a partial-clone agent repo's branch was not pushed (rc=$rc)"
fi
# The non-partial path must not seed a promisor remote.
LB_SEEN="$W/lb.seen"; : > "$LB_SEEN"
git() {
    if [ "${1:-}" = -C ] && [ "${3:-}" = config ]; then
        case "${4:-}" in remote.loki-base.*) echo x >> "$LB_SEEN" ;; esac
    fi
    command git "$@"
}
( cd "$W/agent-partial" && _loki_trusted_push cred . loki/fix-partial ) >/dev/null 2>&1
unset -f git
[ -s "$LB_SEEN" ] \
    && ok "wrapper control: the partial path seeds loki-base" || bad "wrapper control: no loki-base seeding seen on the partial path"
: > "$LB_SEEN"
git() {
    if [ "${1:-}" = -C ] && [ "${3:-}" = config ]; then
        case "${4:-}" in remote.loki-base.*) echo x >> "$LB_SEEN" ;; esac
    fi
    command git "$@"
}
( cd "$W/agent-shallow" && _loki_trusted_push cred . loki/fix-shallow ) >/dev/null 2>&1
unset -f git
[ ! -s "$LB_SEEN" ] && ok "a non-partial agent repo creates no loki-base remote" || bad "a non-partial agent repo seeded loki-base"

# --- FC-TRUSTED-PUSH-PARTIAL-CLONE, private origin + thin pack ---------------
# The agent modified a large file, so its pack is thin: a delta against a blob
# the temp repo only knows by id, lazy-fetched from the origin during the agent
# fetch. The origin refuses token-less reads (packObjectsHook in the test's
# global config, scoped to the origin repo). The agent-dir upload-pack must run
# with no credentials and no HOME, so it also never sees that hook.
PD_SEED="$W/pd-seed"
git init -q "$PD_SEED"
seq 1 20000 > "$PD_SEED/big.txt"; git -C "$PD_SEED" add big.txt; git -C "$PD_SEED" commit -q -m big
cred git -C "$PD_SEED" push -q "$PC_ORIGIN" HEAD:refs/heads/pd-base 2>/dev/null
git clone -q --filter=blob:none -b pd-base "file://$PC_ORIGIN" "$W/agent-delta" 2>/dev/null
git -C "$W/agent-delta" checkout -q -b loki/fix-delta
sed 's/^10000$/changed/' "$W/agent-delta/big.txt" > "$W/big.new" && cp "$W/big.new" "$W/agent-delta/big.txt"
git -C "$W/agent-delta" commit -q -am "agent edits one line of a large file"
git -C "$W/agent-delta" remote set-url origin "$URL"
printf '#!/bin/sh\ncase "$(pwd -P)" in "%s") [ "${GH_TOKEN:-}" = "%s" ] || { echo "origin refuses token-less read" >&2; exit 1; } ;; esac\nexec "$@"\n' "$PC_ORIGIN" "$CANARY" > "$W/deny-hook.sh"
chmod +x "$W/deny-hook.sh"
git config --global uploadpack.packObjectsHook "$W/deny-hook.sh"
git clone -q --no-checkout "file://$PC_ORIGIN" "$W/ctl-tokenless" >/dev/null 2>&1 \
    && bad "control: the origin served a token-less read (hook not live)" || ok "control: the origin refuses a token-less read"
cred git clone -q --no-checkout "file://$PC_ORIGIN" "$W/ctl-token" >/dev/null 2>&1 \
    && ok "control: the origin serves a read with the token" || bad "control: the origin refused a read with the token"
# Spy on the agent-dir upload-pack: log its environment, then run real git.
REAL_GIT="$(command -v git)"
mkdir -p "$W/shimbin"
printf '#!/bin/sh\n[ "$1" = upload-pack ] && env > "%s"\nexec "%s" "$@"\n' "$W/up.env" "$REAL_GIT" > "$W/shimbin/git"
chmod +x "$W/shimbin/git"
rm -f "$W/up.env"
reset_logs
( export PATH="$W/shimbin:$PATH"; cd "$W/agent-delta" && _loki_trusted_push cred . loki/fix-delta ) >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ] && [ -n "$(git -C "$PC_ORIGIN" rev-parse -q --verify refs/heads/loki/fix-delta)" ]; then
    ok "a thin-pack branch from a partial clone reaches a private origin"
else
    bad "a thin-pack branch from a partial clone did not reach a private origin (rc=$rc)"
fi
if [ -s "$W/up.env" ] && ! grep -qE '^(GH_TOKEN|GITHUB_TOKEN|SSH_AUTH_SOCK|HOME|GIT_CONFIG[A-Z_]*)=' "$W/up.env" \
    && grep -qx 'GIT_NO_LAZY_FETCH=1' "$W/up.env"; then
    ok "the agent-dir upload-pack ran with a scrubbed env (no token, socket, HOME or git config env; no lazy fetch)"
else
    bad "the agent-dir upload-pack env was not scrubbed or not observed ($(cat "$W/up.env" 2>/dev/null | tr '\n' ' '))"
fi
git config --global --unset uploadpack.packObjectsHook

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
