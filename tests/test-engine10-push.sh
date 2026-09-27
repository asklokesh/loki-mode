#!/usr/bin/env bash
# E-11 (ENGINE.md section 7): autonomy/lib/engine10-push.sh, the P4 push child.
# Local bare remote behind a github.com insteadOf rewrite (operator global
# config), a stub gh on PATH, synthetic credentials only, no network.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/autonomy/lib/engine10-push.sh"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-e10-push.XXXXXX")" || exit 1
W="$(cd "$W" && pwd -P)"
trap 'rm -rf "$W" "$ISOLATED_GIT_HOME"' EXIT

CANARY="ghp_ENGINE10PUSHCANARY00000000000"
URL="https://github.com/octocat/hello.git"
PRURL="https://github.com/octocat/hello/pull/7"
SHA="0123456789abcdef0123456789abcdef01234567"
export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 LOKI_NO_BROWSER=1
unset GIT_SSH_COMMAND GH_TOKEN GITHUB_TOKEN SSH_AUTH_SOCK GIT_CONFIG_COUNT GH_REPO
mkdir -p "$W/bin" "$W/gh/octocat"
export PATH="$W/bin:$PATH"

git config --global url."$W/gh/".insteadOf "https://github.com/"
git config --global user.email x@example.invalid
git config --global user.name x
git config --global init.defaultBranch main

BARE="$W/gh/octocat/hello.git"
git init -q --bare "$BARE"
printf '#!/bin/sh\necho "remote token=${GH_TOKEN:-none}" >> "%s"\n' "$W/remote.log" > "$BARE/hooks/pre-receive"
chmod +x "$BARE/hooks/pre-receive"

# Stub gh: logs cwd, GH_REPO and argv; one open PR at most, kept in pr.url.
GHLOG="$W/gh.log"
cat > "$W/bin/gh" <<EOF
#!/bin/sh
echo "cwd=\$PWD GH_REPO=\${GH_REPO:-} token=\${GH_TOKEN:-none} \$*" >> "$GHLOG"
case "\$1 \$2" in
    "repo view") cat "$W/default" ;;
    "pr list") [ -f "$W/pr.url" ] && cat "$W/pr.url" ;;
    "pr create") echo "$PRURL" > "$W/pr.url"; echo "Creating pull request"; echo "$PRURL" ;;
esac
exit 0
EOF
chmod +x "$W/bin/gh"
echo main > "$W/default"

A="$W/agent"
git init -q "$A"
git -C "$A" commit -q --allow-empty -m init
git -C "$A" branch loki/e10-fix
git -C "$A" branch loki/e10-ctl
git -C "$A" branch trunk
git -C "$A" remote add origin "$URL"
REC="$W/hook.rec"
printf '#!/bin/sh\necho "hook token=${GH_TOKEN:-none}" >> "%s"\n' "$REC" > "$A/.git/hooks/pre-push"
chmod +x "$A/.git/hooks/pre-push"
printf 'body\n' > "$W/body.md"

p4() { GH_TOKEN="$CANARY" _LOKI_ORIGIN_PINNED=1 _LOKI_PINNED_ORIGIN="$URL" bash "$1" "${@:2}"; }
creates() { grep -c ' pr create ' "$GHLOG" 2>/dev/null || true; }

# Control: the planted hook is live on the old in-repo credentialed push.
: > "$REC"
( cd "$A" && GH_TOKEN="$CANARY" git push -q origin loki/e10-ctl ) >/dev/null 2>&1
grep -q "token=$CANARY" "$REC" && ok "control: planted pre-push hook sees the canary on an in-repo push" \
    || bad "control: planted hook did not fire (plant not live)"

# push-pr: push lands, hook records nothing, PR created as draft from /.
: > "$REC"; : > "$W/remote.log"; : > "$GHLOG"
out="$(p4 "$LIB" push-pr "$A" loki/e10-fix "E10 title" "$W/body.md" --draft 2>"$W/err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$PRURL" ] && ok "push-pr prints the PR URL" \
    || bad "push-pr rc=$rc out=$out err=$(tr '\n' ' ' < "$W/err")"
[ "$(git -C "$BARE" rev-parse -q --verify refs/heads/loki/e10-fix)" = "$(git -C "$A" rev-parse loki/e10-fix)" ] \
    && grep -qx "remote token=$CANARY" "$W/remote.log" && ok "push landed on the remote with the credential" \
    || bad "push did not land (remote log: $(tr '\n' ',' < "$W/remote.log"))"
grep -q "token=$CANARY" "$REC" && bad "planted pre-push hook recorded the canary" \
    || ok "planted pre-push hook recorded no canary"
grep -q '^cwd=/ GH_REPO=octocat/hello .* pr list --repo octocat/hello --head loki/e10-fix --state open' "$GHLOG" \
    && ok "check-before-create: gh pr list ran neutral (cwd /, GH_REPO pinned)" || bad "no neutral gh pr list ($(tr '\n' '|' < "$GHLOG"))"
grep -q '^cwd=/ .* pr create --repo octocat/hello --head loki/e10-fix --title E10 title --body-file .* --draft$' "$GHLOG" \
    && ok "gh pr create ran neutral with --draft" || bad "gh pr create args wrong ($(tr '\n' '|' < "$GHLOG"))"

# Second call reuses the open PR.
out="$(p4 "$LIB" push-pr "$A" loki/e10-fix "E10 title" "$W/body.md" 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$PRURL" ] && [ "$(creates)" = "1" ] && ok "second call reuses the existing PR URL" \
    || bad "second call rc=$rc out=$out creates=$(creates)"

# refused <label> <stderr-substring> <cmd...>: rc 2, the reason on stderr,
# nothing reached the remote and no PR was created.
refused() {
    local label="$1" want="$2" rc n0
    shift 2
    : > "$W/remote.log"; n0="$(creates)"
    "$@" >/dev/null 2>"$W/err"; rc=$?
    if [ "$rc" -eq 2 ] && grep -qF "$want" "$W/err" && [ ! -s "$W/remote.log" ] && [ "$(creates)" = "$n0" ]; then
        ok "$label"
    else
        bad "$label (rc=$rc err=$(tr '\n' ' ' < "$W/err"))"
    fi
}
refused "push to main is refused, nothing sent" "Not pushing branch 'main'" \
    p4 "$LIB" push-pr "$A" main t "$W/body.md"
echo trunk > "$W/default"
refused "push to the gh-resolved default branch (trunk) is refused, nothing sent" "it is the default branch of octocat/hello" \
    p4 "$LIB" push-pr "$A" trunk t "$W/body.md"
echo main > "$W/default"
refused "refuses without _LOKI_ORIGIN_PINNED=1" "origin not pinned" \
    env GH_TOKEN="$CANARY" bash "$LIB" push-pr "$A" loki/e10-fix t "$W/body.md"
refused "origin differing from the pin is refused" "origin changed during the run" \
    env GH_TOKEN="$CANARY" _LOKI_ORIGIN_PINNED=1 _LOKI_PINNED_ORIGIN="https://github.com/octocat/other.git" \
    bash "$LIB" push-pr "$A" loki/e10-fix t "$W/body.md"

# comment and status.
: > "$GHLOG"
p4 "$LIB" comment 7 "$W/body.md" >/dev/null 2>&1 \
    && grep -q '^cwd=/ .* pr comment 7 --repo octocat/hello --body-file ' "$GHLOG" \
    && ok "comment mode posts via gh pr comment" || bad "comment mode ($(tr '\n' '|' < "$GHLOG"))"
p4 "$LIB" status "$SHA" pending "deep verify running" >/dev/null 2>&1 \
    && grep -q "^cwd=/ .* api repos/octocat/hello/statuses/$SHA -f state=pending -f context=loki/deep-verify -f description=deep verify running$" "$GHLOG" \
    && ok "status mode posts a pending loki/deep-verify status" || bad "status mode ($(tr '\n' '|' < "$GHLOG"))"
refused "status rejects a bad state" "bad state" p4 "$LIB" status "$SHA" bogus d

# E-41: a local bare origin (the eval/loki10/harness.py shape, including its
# post-receive hook, which is how the harness scores "PR opened").
LB="$W/local/remote.git"
DECOY="$W/local/decoy.git"
git init -q --bare "$LB"
git init -q --bare "$DECOY"
printf '#!/bin/sh\nnow=$(date +%%s)\nwhile read -r old new ref; do\n  echo "$now $old $new $ref gh=${GH_TOKEN:-none} github=${GITHUB_TOKEN:-none} ghe=${GH_ENTERPRISE_TOKEN:-none}" >> "$GIT_DIR/pushes.log"\ndone\n' \
    > "$LB/hooks/post-receive"
chmod +x "$LB/hooks/post-receive"
printf '#!/bin/sh\nenv >> "%s"\n' "$W/lenv.dump" > "$LB/hooks/pre-receive"
chmod +x "$LB/hooks/pre-receive"
: > "$LB/pushes.log"
LA="$W/lagent"
git init -q "$LA"
git -C "$LA" commit -q --allow-empty -m init
git -C "$LA" commit -q --allow-empty -m fix
git -C "$LA" branch loki/e10-local
git -C "$LA" branch loki/e10-lctl
git -C "$LA" branch master
git -C "$LA" branch trunk
git -C "$LA" remote add origin "$LB"
LREC="$W/lhook.rec"
printf '#!/bin/sh\necho "hook token=${GH_TOKEN:-none}" >> "%s"\n' "$LREC" > "$LA/.git/hooks/pre-push"
chmod +x "$LA/.git/hooks/pre-push"
# Agent-written config redirecting any push to the pinned path into a decoy:
# the vector core.hooksPath=/dev/null does not stop on a push run in the agent repo.
git -C "$LA" config url."$DECOY".pushInsteadOf "$LB"
lp() { GH_TOKEN="$CANARY" GITHUB_TOKEN="$CANARY" GH_ENTERPRISE_TOKEN="$CANARY" GITHUB_ENTERPRISE_TOKEN="$CANARY" \
    SSH_AUTH_SOCK="$W/$CANARY.sock" GIT_ASKPASS="$W/$CANARY.askpass" GH_CONFIG_DIR="$W/$CANARY.gh" \
    _LOKI_ORIGIN_PINNED=1 _LOKI_PINNED_ORIGIN="$1" bash "$LIB" "${@:2}"; }
lref() { git -C "$1" rev-parse -q --verify "refs/heads/$2" 2>/dev/null; }

# Control: in the agent repo, a push to the pinned path lands in the decoy and
# fires the planted hook (both plants are live).
: > "$LREC"
( cd "$LA" && GH_TOKEN="$CANARY" git push -q "$LB" loki/e10-lctl ) >/dev/null 2>&1
[ -n "$(lref "$DECOY" loki/e10-lctl)" ] && [ -z "$(lref "$LB" loki/e10-lctl)" ] && grep -q "token=$CANARY" "$LREC" \
    && ok "control: agent pushInsteadOf and pre-push hook are live on an in-repo push" \
    || bad "control: local plants not live"

: > "$LREC"; : > "$GHLOG"
out="$(lp "$LB" push-pr "$LA" loki/e10-local "E41 title" "$W/body.md" --draft 2>"$W/err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "local://$LB#loki/e10-local" ] && ok "local push-pr prints local://<origin>#<branch>" \
    || bad "local push-pr rc=$rc out=$out err=$(tr '\n' ' ' < "$W/err")"
[ "$(lref "$LB" loki/e10-local)" = "$(git -C "$LA" rev-parse loki/e10-local)" ] \
    && ok "local push landed the branch on the pinned bare repo" || bad "local push did not land"
[ -z "$(lref "$DECOY" loki/e10-local)" ] && ok "agent pushInsteadOf did not redirect the push" \
    || bad "push was redirected to the decoy"
grep -q " refs/heads/loki/e10-local gh=none github=none ghe=none$" "$LB/pushes.log" 2>/dev/null \
    && ok "harness post-receive hook recorded the branch, with no token visible" \
    || bad "post-receive log wrong ($(tr '\n' '|' < "$LB/pushes.log" 2>/dev/null))"
[ -s "$W/lenv.dump" ] && ! grep -q "$CANARY" "$W/lenv.dump" \
    && ok "bare repo pre-receive hook saw no canary in its env (tokens, SSH agent, askpass, gh config)" \
    || bad "canary reached the bare repo hook env: $(grep "$CANARY" "$W/lenv.dump" 2>/dev/null | tr '\n' ' ')"
[ ! -s "$LREC" ] && ok "planted pre-push hook in the agent repo recorded nothing" || bad "planted hook ran: $(cat "$LREC")"
[ ! -s "$GHLOG" ] && ok "local push-pr never called gh" || bad "gh was called ($(tr '\n' '|' < "$GHLOG"))"

# lrefused <label> <stderr-substring> <cmd...>: rc 2, reason on stderr, no
# new post-receive line, no local:// on stdout, no gh call.
lrefused() {
    local label="$1" want="$2" rc n0 o
    shift 2
    n0="$(wc -l < "$LB/pushes.log")"; : > "$GHLOG"
    o="$("$@" 2>"$W/err")"; rc=$?
    if [ "$rc" -eq 2 ] && grep -qF "$want" "$W/err" && [ "$(wc -l < "$LB/pushes.log")" = "$n0" ] \
        && [ "${o#*local://}" = "$o" ] && [ ! -s "$GHLOG" ]; then
        ok "$label"
    else
        bad "$label (rc=$rc out=$o err=$(tr '\n' ' ' < "$W/err"))"
    fi
}
lrefused "local: main is refused" "Not pushing branch 'main'" lp "$LB" push-pr "$LA" main t "$W/body.md"
lrefused "local: master is refused" "Not pushing branch 'master'" lp "$LB" push-pr "$LA" master t "$W/body.md"
git -C "$LB" symbolic-ref HEAD refs/heads/trunk
lrefused "local: the bare repo's own default branch (trunk) is refused" "default branch" \
    lp "$LB" push-pr "$LA" trunk t "$W/body.md"
git -C "$LB" symbolic-ref HEAD refs/heads/main
[ -z "$(lref "$LB" trunk)" ] && [ -z "$(lref "$LB" master)" ] && ok "local: no refused branch reached the bare repo" \
    || bad "a refused branch reached the bare repo"

: > "$GHLOG"
lp "$LB" status "$SHA" pending "deep verify running" >/dev/null 2>"$W/err" && grep -q "local origin" "$W/err" && [ ! -s "$GHLOG" ] \
    && ok "local: status is a no-op notice, rc 0, no gh" || bad "local status ($(tr '\n' ' ' < "$W/err"))"
lp "$LB" comment 7 "$W/body.md" >/dev/null 2>"$W/err" && grep -q "local origin" "$W/err" && [ ! -s "$GHLOG" ] \
    && ok "local: comment is a no-op notice, rc 0, no gh" || bad "local comment ($(tr '\n' ' ' < "$W/err"))"

# Not a local bare origin: never the local branch, always today's refusal.
NB="$W/local/nonbare"
git init -q "$NB"
git -C "$NB" commit -q --allow-empty -m init
lrefused "non-bare directory is refused (old path)" "pinned origin refused" lp "$NB" push-pr "$LA" loki/e10-local t "$W/body.md"
[ -z "$(lref "$NB" loki/e10-local)" ] && ok "non-bare directory received no branch" || bad "non-bare directory received the branch"
lp_rel() { ( cd "$W/local" && lp remote.git "$@" ); }
lrefused "relative path is refused (old path)" "pinned origin refused" lp_rel push-pr "$LA" loki/e10-local t "$W/body.md"
lrefused "scp-style host:path is refused (old path)" "pinned origin refused" lp "localhost:$LB" push-pr "$LA" loki/e10-local t "$W/body.md"
lrefused "file:// URL is refused (old path)" "pinned origin refused" lp "file://$LB" push-pr "$LA" loki/e10-local t "$W/body.md"
lrefused "a subdirectory of a bare repo is refused" "pinned origin refused" lp "$LB/objects" push-pr "$LA" loki/e10-local t "$W/body.md"
lrefused "a missing path is refused" "pinned origin refused" lp "$W/local/nope.git" push-pr "$LA" loki/e10-local t "$W/body.md"

# Missing anchors fail closed: same lib, run.sh without the start anchor.
mkdir -p "$W/fake/autonomy/lib"
cp "$LIB" "$W/fake/autonomy/lib/"
grep -v '^_LOKI_WITHHELD_TOKENS=""$' "$ROOT/autonomy/run.sh" > "$W/fake/autonomy/run.sh"
: > "$GHLOG"; : > "$W/remote.log"
p4 "$W/fake/autonomy/lib/engine10-push.sh" push-pr "$A" loki/e10-fix t "$W/body.md" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 3 ] && [ ! -s "$GHLOG" ] && [ ! -s "$W/remote.log" ] && grep -q anchors "$W/err" \
    && ok "missing anchors fail closed (rc 3, no gh, no push)" || bad "missing anchors: rc=$rc err=$(tr '\n' ' ' < "$W/err")"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
