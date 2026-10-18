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

# pr list stub: serves pr.url (same-repo PR by the pinned owner) and pr.fork (cross-repo PR by a stranger, same branch
# name) as gh's JSON, then applies the caller's --jq filter with real jq, so the script's owner filter is what is under test.
cat > "$W/prlist.sh" <<'PRL'
#!/bin/sh
f=""; prev=""
for a in "$@"; do [ "$prev" = "--jq" ] && f="$a"; prev="$a"; done
head=""; prev=""
for a in "$@"; do [ "$prev" = "--head" ] && head="$a"; prev="$a"; done
{
    [ -f "$W_PRURL" ] && jq -n --arg u "$(cat "$W_PRURL")" --arg h "$head" '{url:$u,isCrossRepository:false,headRepositoryOwner:{login:"octocat"},headRefName:$h,state:"OPEN"}'
    [ -f "$W_PRCLOSED" ] && jq -n --arg u "https://github.com/octocat/hello/pull/5" --arg h "$head" '{url:$u,isCrossRepository:false,headRepositoryOwner:{login:"octocat"},headRefName:$h,state:"CLOSED"}'
    # pr.fork holds the variant: cross (cross-repo flag only), owner (other owner only), both.
    [ -f "$W_PRFORK" ] && jq -n --arg u "https://github.com/octocat/hello/pull/99" --arg h "$head" --arg v "$(cat "$W_PRFORK")" \
        '{url:$u,isCrossRepository:($v!="owner"),headRepositoryOwner:{login:(if $v=="cross" then "octocat" else "stranger" end)},headRefName:$h,state:"OPEN"}'
} | jq -s -r "${f:-.}"
exit 0
PRL
# Stub gh: logs cwd, GH_REPO and argv; one open PR at most, kept in pr.url.
GHLOG="$W/gh.log"
cat > "$W/bin/gh" <<EOF
#!/bin/sh
echo "cwd=\$PWD GH_REPO=\${GH_REPO:-} token=\${GH_TOKEN:-none} \$*" >> "$GHLOG"
case "\$1 \$2" in
    "repo view") cat "$W/default" ;;
    "api repos/octocat/hello/git/ref/heads/loki/e10-resume")
        git -C "$BARE" rev-parse -q --verify refs/heads/loki/e10-resume 2>/dev/null ;;
    "pr list") W_PRURL="$W/pr.url" W_PRFORK="$W/pr.fork" W_PRCLOSED="$W/pr.closed" sh "$W/prlist.sh" "\$@" ;;
    "pr create") echo "$PRURL" > "$W/pr.url"; echo "Creating pull request"; echo "$PRURL" ;;
    "api user") [ -f "$W/user.fail" ] && exit 1; echo "loki-bot" ;;
    # Fork mode: noperm makes the pinned repo report permissions.push false; fork.parent is the parent the fork reports.
    "api repos/octocat/hello") if [ -f "$W/noperm" ]; then echo false; elif [ -f "$W/garbage" ]; then echo "<html>rate limited"; else echo true; fi ;;
    "api -X") echo "loki-bot/hello" ;;
    "api repos/loki-bot/hello") echo "true \$(cat "$W/fork.parent" 2>/dev/null || echo octocat/hello) loki-bot" ;;
    "api repos/octocat/hello/issues/9/comments") [ -f "$W/status.cid" ] && cat "$W/status.cid" ;;
    "issue comment"|"pr comment") [ "\$3" = 9 ] && echo 555 > "$W/status.cid" ;;
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
[ "$rc" -eq 0 ] && [ "$out" = "$(printf 'created\n%s' "$PRURL")" ] && ok "push-pr prints the created marker then the PR URL" \
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
[ "$rc" -eq 0 ] && [ "$out" = "$(printf 'reused\n%s' "$PRURL")" ] && [ "$(creates)" = "1" ] && ok "second call reuses the existing PR URL and prints the reused marker" \
    || bad "second call rc=$rc out=$out creates=$(creates)"

# MASS-2: a stacked slice PR targets its parent slice's branch (--base, either order with --draft).
git -C "$A" branch loki/e10-stack
rm -f "$W/pr.url"; : > "$GHLOG"
out="$(p4 "$LIB" push-pr "$A" loki/e10-stack "E10 title" "$W/body.md" --base loki/e10-fix --draft 2>"$W/err")"; rc=$?
[ "$rc" -eq 0 ] && grep -q '^cwd=/ .* pr create --repo octocat/hello --head loki/e10-stack --title E10 title --body-file .* --draft --base loki/e10-fix$' "$GHLOG" \
    && ok "push-pr --base stacks the PR on the parent branch" || bad "stacked push-pr rc=$rc ($(tr '\n' '|' < "$GHLOG")) err=$(tr '\n' ' ' < "$W/err")"

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
refused "push-pr refuses a base that is not a branch name" "invalid base branch" \
    p4 "$LIB" push-pr "$A" loki/e10-stack t "$W/body.md" --base "a..b"
refused "push-pr refuses a base that reads as a flag" "invalid base branch" \
    p4 "$LIB" push-pr "$A" loki/e10-stack t "$W/body.md" --base --draft
refused "push-pr refuses an unknown flag" "unknown flag" \
    p4 "$LIB" push-pr "$A" loki/e10-stack t "$W/body.md" --head x
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

# E-67: issue-comment (a FAILED, no-diff run with no PR to comment on) posts to the issue instead.
: > "$GHLOG"
p4 "$LIB" issue-comment "octocat/hello#9" "$W/body.md" >/dev/null 2>&1 \
    && grep -q '^cwd=/ .* issue comment 9 --repo octocat/hello --body-file ' "$GHLOG" \
    && ok "issue-comment mode posts via gh issue comment, extracting the number" || bad "issue-comment mode ($(tr '\n' '|' < "$GHLOG"))"
: > "$GHLOG"
p4 "$LIB" issue-comment "42" "$W/body.md" >/dev/null 2>&1 \
    && grep -q '^cwd=/ .* issue comment 42 --repo octocat/hello --body-file ' "$GHLOG" \
    && ok "issue-comment mode accepts a bare issue number" || bad "issue-comment bare number ($(tr '\n' '|' < "$GHLOG"))"
# FV-gh-steer-3: issue-comment --update upserts ONE marker-tagged comment: create when absent, edit in place after.
printf '<!-- loki-status -->\nstate: planned\n' > "$W/status.md"
rm -f "$W/status.cid"; : > "$GHLOG"
p4 "$LIB" issue-comment --update "octocat/hello#9" "$W/status.md" >/dev/null 2>&1 \
    && grep -q ' issue comment 9 --repo octocat/hello --body-file ' "$GHLOG" \
    && ! grep -q 'X PATCH' "$GHLOG" \
    && ok "issue-comment --update creates the status comment when none carries the marker" || bad "issue-comment --update create ($(tr '\n' '|' < "$GHLOG"))"
: > "$GHLOG"
p4 "$LIB" issue-comment --update "octocat/hello#9" "$W/status.md" >/dev/null 2>&1 \
    && grep -q ' api -X PATCH repos/octocat/hello/issues/comments/555 -F body=@' "$GHLOG" \
    && ! grep -q ' issue comment ' "$GHLOG" \
    && ok "issue-comment --update edits the existing status comment, no duplicate" || bad "issue-comment --update edit ($(tr '\n' '|' < "$GHLOG"))"
# The PR receipt comment rides the same upsert with its own marker (a PR number is an issue number to the API).
printf '<!-- loki-receipt -->\n## Loki receipt\n' > "$W/receipt.md"
rm -f "$W/status.cid"; : > "$GHLOG"
p4 "$LIB" issue-comment --update "#9" "$W/receipt.md" >/dev/null 2>&1 \
    && grep -q ' pr comment 9 --repo octocat/hello --body-file ' "$GHLOG" \
    && ! grep -q ' issue comment ' "$GHLOG" \
    && grep -qF 'contains("<!-- loki-receipt -->")' "$GHLOG" \
    && ok "issue-comment --update accepts the receipt marker and searches by it" || bad "issue-comment --update receipt ($(tr '\n' '|' < "$GHLOG"))"
: > "$GHLOG"
p4 "$LIB" issue-comment --update "#9" "$W/receipt.md" >/dev/null 2>&1 \
    && grep -q ' api -X PATCH repos/octocat/hello/issues/comments/555 -F body=@' "$GHLOG" \
    && ok "a re-run edits the one receipt comment, no duplicate" || bad "issue-comment --update receipt edit ($(tr '\n' '|' < "$GHLOG"))"
touch "$W/user.fail"; : > "$GHLOG"
refused "a receipt upsert refuses to post when the gh user lookup fails (no duplicate)" "cannot resolve the gh user" \
    p4 "$LIB" issue-comment --update "#9" "$W/receipt.md"
! grep -q ' comment 9 ' "$GHLOG" && ok "a failed receipt lookup posts nothing" || bad "a failed receipt lookup still posted ($(tr '\n' '|' < "$GHLOG"))"
rm -f "$W/user.fail"
printf 'no marker here\n' > "$W/nomark.md"
refused "issue-comment --update refuses a body without the marker" "must carry" p4 "$LIB" issue-comment --update "octocat/hello#9" "$W/nomark.md"
refused "issue-comment rejects a ref with no number" "cannot extract issue number" p4 "$LIB" issue-comment "octocat/hello" "$W/body.md"
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
lp "$LB" issue-comment "octocat/hello#9" "$W/body.md" >/dev/null 2>"$W/err" && grep -q "local origin" "$W/err" && [ ! -s "$GHLOG" ] \
    && ok "local: issue-comment is a no-op notice, rc 0, no gh" || bad "local issue-comment ($(tr '\n' ' ' < "$W/err"))"

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

# Region guard on its own: anchors present, one required trusted-push function
# dropped (renamed so the anchors still match). Must refuse with rc 3 before
# anything runs, even when the parent environment exports a same-named function.
mkdir -p "$W/fake2/autonomy/lib"
cp "$LIB" "$W/fake2/autonomy/lib/"
sed 's/^_loki_run_neutral() {$/_loki_run_neutral_dropped() {/' "$ROOT/autonomy/run.sh" > "$W/fake2/autonomy/run.sh"
grep -q '^_LOKI_WITHHELD_TOKENS=""$' "$W/fake2/autonomy/run.sh" && ! grep -q '^_loki_run_neutral() {$' "$W/fake2/autonomy/run.sh" \
    && ok "region guard fixture keeps anchors and drops _loki_run_neutral" || bad "region guard fixture is malformed"
: > "$GHLOG"; : > "$W/remote.log"
p4 "$W/fake2/autonomy/lib/engine10-push.sh" push-pr "$A" loki/e10-fix t "$W/body.md" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 3 ] && [ ! -s "$GHLOG" ] && [ ! -s "$W/remote.log" ] && grep -q "region lacks _loki_run_neutral" "$W/err" \
    && ok "dropped region function fails closed (rc 3, region lacks, no gh, no push)" || bad "dropped region function: rc=$rc err=$(tr '\n' ' ' < "$W/err")"
: > "$GHLOG"; : > "$W/remote.log"
(
    _loki_run_neutral() { echo "STUB from parent env" >&2; "$@"; }
    export -f _loki_run_neutral
    p4 "$W/fake2/autonomy/lib/engine10-push.sh" push-pr "$A" loki/e10-fix t "$W/body.md" >/dev/null 2>"$W/err"
); rc=$?
[ "$rc" -eq 3 ] && [ ! -s "$GHLOG" ] && [ ! -s "$W/remote.log" ] && grep -q "region lacks _loki_run_neutral" "$W/err" \
    && ok "exported same-name function does not satisfy the region guard (rc 3, no gh, no push)" || bad "exported function bypass: rc=$rc err=$(tr '\n' ' ' < "$W/err")"

# RECOVERY: push-pr is idempotent across an interrupted publish (docs/v10/ENGINE.md, "Recovery of an interrupted run").
#   A. interrupted after the push, before the PR exists -> rerun: no second push, one PR.
#   B. interrupted after the PR was created             -> rerun: no second push, no second PR.
#   C. a new commit on the branch                       -> pushed once, still one PR.
git -C "$A" branch loki/e10-resume
git -C "$A" push -q "$BARE" loki/e10-resume:refs/heads/loki/e10-resume
rm -f "$W/pr.url"; : > "$GHLOG"; : > "$W/remote.log"
pushes() { wc -l < "$W/remote.log" | tr -d ' '; }
out="$(p4 "$LIB" push-pr "$A" loki/e10-resume t "$W/body.md" 2>"$W/err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$(printf 'created\n%s' "$PRURL")" ] && [ "$(pushes)" = "0" ] && grep -q "push skipped" "$W/err" && [ "$(creates)" = "1" ] \
    && ok "recovery A: resume after push skips the push and opens one PR" || bad "recovery A: rc=$rc out=$out pushes=$(pushes) creates=$(creates)"
out="$(p4 "$LIB" push-pr "$A" loki/e10-resume t "$W/body.md" 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$(printf 'reused\n%s' "$PRURL")" ] && [ "$(creates)" = "1" ] && [ "$(pushes)" = "0" ] \
    && ok "recovery B: rerun reuses the PR, no second PR, no second push" || bad "recovery B: rc=$rc creates=$(creates) pushes=$(pushes)"
git -C "$A" checkout -q loki/e10-resume
git -C "$A" commit -q --allow-empty -m second
out="$(p4 "$LIB" push-pr "$A" loki/e10-resume t "$W/body.md" 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$(pushes)" = "1" ] && [ "$(creates)" = "1" ] \
    && [ "$(git -C "$BARE" rev-parse loki/e10-resume)" = "$(git -C "$A" rev-parse loki/e10-resume)" ] \
    && ok "recovery C: a new commit is pushed once, still one PR" || bad "recovery C: rc=$rc pushes=$(pushes) creates=$(creates)"

# M-21 N3/N4: pr-ready (reused wave PR: replace body, mark ready) and the shared owner-filtered PR lookup.
git -C "$A" branch loki/e10-ready
editready() { grep -c " pr \(edit\|ready\) " "$GHLOG" 2>/dev/null || true; }
echo "$PRURL" > "$W/pr.url"; rm -f "$W/pr.fork"; : > "$GHLOG"; : > "$REC"
out="$(p4 "$LIB" pr-ready "$A" loki/e10-ready "$W/body.md" "$PRURL" 2>"$W/err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$PRURL" ] \
    && grep -q "^cwd=/ GH_REPO=octocat/hello .* pr edit $PRURL --repo octocat/hello --body-file $W/body.md\$" "$GHLOG" \
    && grep -q "^cwd=/ GH_REPO=octocat/hello .* pr ready $PRURL --repo octocat/hello\$" "$GHLOG" \
    && [ "$(grep -n ' pr edit ' "$GHLOG" | cut -d: -f1)" -lt "$(grep -n ' pr ready ' "$GHLOG" | cut -d: -f1)" ] \
    && ok "pr-ready edits the body then marks the same-owner PR ready, neutral cwd and pinned repo" \
    || bad "pr-ready happy path rc=$rc out=$out ($(tr '\n' '|' < "$GHLOG")) err=$(tr '\n' ' ' < "$W/err")"
grep -q "$CANARY" "$W/err" && bad "pr-ready leaked the canary on stderr" || ok "pr-ready stderr carries no canary"
[ ! -s "$REC" ] && ok "pr-ready ran no repo hook (no canary in the planted pre-push hook)" || bad "pr-ready triggered a repo hook"
for b in main master HEAD; do
    : > "$GHLOG"
    p4 "$LIB" pr-ready "$A" "$b" "$W/body.md" "$PRURL" >/dev/null 2>"$W/err"; rc=$?
    [ "$rc" -eq 2 ] && grep -qE "refusing to edit a PR for default branch|invalid branch" "$W/err" && [ "$(editready)" = "0" ] \
        && ok "pr-ready refuses default branch $b, no edit or ready" || bad "pr-ready $b: rc=$rc edits=$(editready)"
done
# FORK: a stranger's cross-repo PR with the same branch name is never edited or readied.
echo "$PRURL" > "$W/pr.url"; echo both > "$W/pr.fork"; : > "$GHLOG"
p4 "$LIB" pr-ready "$A" loki/e10-ready "$W/body.md" "https://github.com/octocat/hello/pull/99" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 2 ] && grep -q "refusing: PR" "$W/err" && [ "$(editready)" = "0" ] \
    && ok "pr-ready refuses a URL that is the fork PR, never edits or readies" || bad "pr-ready fork url: rc=$rc edits=$(editready) err=$(tr '\n' ' ' < "$W/err")"
for v in both cross owner; do
    rm -f "$W/pr.url"; echo "$v" > "$W/pr.fork"; : > "$GHLOG"
    p4 "$LIB" pr-ready "$A" loki/e10-ready "$W/body.md" "https://github.com/octocat/hello/pull/99" >/dev/null 2>"$W/err"; rc=$?
    [ "$rc" -eq 2 ] && grep -q "no open PR from octocat/hello" "$W/err" && [ "$(editready)" = "0" ] \
        && ok "pr-ready with only a fork PR ($v) finds no PR and never edits or readies" || bad "pr-ready fork only ($v): rc=$rc edits=$(editready) err=$(tr '\n' ' ' < "$W/err")"
done
echo both > "$W/pr.fork"
echo "$PRURL" > "$W/pr.url"; : > "$GHLOG"
p4 "$LIB" pr-ready "$A" loki/e10-ready "$W/body.md" "https://github.com/octocat/hello/pull/8" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 2 ] && [ "$(editready)" = "0" ] && ok "pr-ready refuses when the passed URL is not the lookup result" || bad "pr-ready url mismatch: rc=$rc"
# A closed same-owner PR is not an open PR to edit.
rm -f "$W/pr.url" "$W/pr.fork"; echo 1 > "$W/pr.closed"; : > "$GHLOG"
p4 "$LIB" pr-ready "$A" loki/e10-ready "$W/body.md" "https://github.com/octocat/hello/pull/5" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 2 ] && [ "$(editready)" = "0" ] && ok "pr-ready ignores a non-OPEN PR" || bad "pr-ready closed: rc=$rc edits=$(editready)"
rm -f "$W/pr.closed"
# push-pr reuse: the fork PR is not reused; a new PR is created.
for v in both cross owner; do
    rm -f "$W/pr.url"; echo "$v" > "$W/pr.fork"; : > "$GHLOG"; n0="$(creates)"
    out="$(p4 "$LIB" push-pr "$A" loki/e10-ready "E10 title" "$W/body.md" 2>"$W/err")"; rc=$?
    [ "$rc" -eq 0 ] && [ "$out" = "$(printf 'created\n%s' "$PRURL")" ] && [ "$(creates)" = "$((n0 + 1))" ] \
        && ok "push-pr does not reuse a stranger's fork PR ($v) with the same branch name" || bad "push-pr fork reuse ($v): rc=$rc out=$out"
done
rm -f "$W/pr.fork"
# Local bare origin: no PR exists, so pr-ready is a no-op that exits 0 without calling gh.
LB="$W/localbare.git"; git init -q --bare "$LB"
: > "$GHLOG"
out="$(GH_TOKEN="$CANARY" _LOKI_ORIGIN_PINNED=1 _LOKI_PINNED_ORIGIN="$LB" bash "$LIB" pr-ready "$A" loki/e10-ready "$W/body.md" "$PRURL" 2>"$W/err")"; rc=$?
[ "$rc" -eq 0 ] && [ -z "$out" ] && [ ! -s "$GHLOG" ] && grep -q "local origin: no PR to mark ready" "$W/err" \
    && ok "pr-ready on a local origin is a no-op (exit 0, no gh)" || bad "pr-ready local: rc=$rc out=$out gh=$(tr '\n' '|' < "$GHLOG")"
refused "pr-ready needs the pr-url argument" "usage: pr-ready" p4 "$LIB" pr-ready "$A" loki/e10-ready "$W/body.md"

# Fork mode: no push access to the pinned repo. The branch goes to the user's verified fork, never upstream, and the
# PR is opened upstream from loki-bot:<branch>; a draft run stops at the fork (exit 4); status comments are skipped.
FORK="$W/gh/loki-bot/hello.git"; mkdir -p "$W/gh/loki-bot"; git init -q --bare "$FORK"
git -C "$A" branch loki/e10-fk
touch "$W/noperm"; rm -f "$W/pr.url" "$W/fork.parent"; : > "$GHLOG"
out="$(p4 "$LIB" push-pr "$A" loki/e10-fk "E10 title" "$W/body.md" 2>"$W/err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$(printf 'created\n%s' "$PRURL")" ] \
    && [ "$(git -C "$FORK" rev-parse -q --verify refs/heads/loki/e10-fk)" = "$(git -C "$A" rev-parse loki/e10-fk)" ] \
    && ! git -C "$BARE" rev-parse -q --verify refs/heads/loki/e10-fk >/dev/null \
    && grep -q ' pr create --repo octocat/hello --head loki-bot:loki/e10-fk --title E10 title --body-file ' "$GHLOG" \
    && ok "fork mode: no push access pushes to the verified fork and opens the PR upstream from user:branch" \
    || bad "fork mode push-pr rc=$rc out=$out err=$(tr '\n' ' ' < "$W/err") gh=$(tr '\n' '|' < "$GHLOG")"
git -C "$A" branch loki/e10-fkd; rm -f "$W/pr.url"; n0="$(creates)"
p4 "$LIB" push-pr "$A" loki/e10-fkd "E10 title" "$W/body.md" --draft >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 4 ] && grep -q '^fork-only: pushed loki/e10-fkd to loki-bot/hello' "$W/err" && [ "$(creates)" = "$n0" ] \
    && git -C "$FORK" rev-parse -q --verify refs/heads/loki/e10-fkd >/dev/null \
    && ok "fork mode: a draft run pushes to the fork only and opens no PR upstream (exit 4)" \
    || bad "fork mode draft rc=$rc creates=$(creates)/$n0 err=$(tr '\n' ' ' < "$W/err")"
git -C "$A" branch loki/e10-fkp; echo stranger/hello > "$W/fork.parent"; n0="$(creates)"
p4 "$LIB" push-pr "$A" loki/e10-fkp "E10 title" "$W/body.md" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 2 ] && grep -q 'could not be created or verified' "$W/err" && [ "$(creates)" = "$n0" ] \
    && ! git -C "$FORK" rev-parse -q --verify refs/heads/loki/e10-fkp >/dev/null \
    && ok "fork mode: a fork whose parent is not the pinned repo is refused, nothing pushed" \
    || bad "fork mode parent mismatch rc=$rc err=$(tr '\n' ' ' < "$W/err")"
rm -f "$W/fork.parent"; git -C "$A" branch loki/e10-fko
LOKI_PR_FORK=0 p4 "$LIB" push-pr "$A" loki/e10-fko "E10 title" "$W/body.md" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 0 ] && git -C "$BARE" rev-parse -q --verify refs/heads/loki/e10-fko >/dev/null \
    && ! git -C "$FORK" rev-parse -q --verify refs/heads/loki/e10-fko >/dev/null \
    && ok "LOKI_PR_FORK=0 keeps the direct push to the pinned origin" || bad "LOKI_PR_FORK=0 rc=$rc err=$(tr '\n' ' ' < "$W/err")"
rm -f "$W/status.cid"; : > "$GHLOG"
p4 "$LIB" issue-comment --update "octocat/hello#9" "$W/status.md" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 0 ] && ! grep -q 'issue comment\|pr comment\|PATCH' "$GHLOG" && grep -q 'not commenting on its issue 9' "$W/err" \
    && ok "no push access: the status comment is not posted on someone else's issue" || bad "status comment without push: rc=$rc gh=$(tr '\n' '|' < "$GHLOG")"
printf '<!-- loki-status -->\nissue text quoting <!-- loki-receipt -->\n' > "$W/quoted.md"; : > "$GHLOG"
p4 "$LIB" issue-comment --update "octocat/hello#9" "$W/quoted.md" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 0 ] && ! grep -q 'issue comment\|pr comment\|PATCH' "$GHLOG" \
    && ok "no push access: a status body quoting the receipt marker is still not posted" || bad "quoted marker: rc=$rc gh=$(tr '\n' '|' < "$GHLOG")"
printf '<!-- loki-receipt -->\nreceipt\n' > "$W/receipt.md"; : > "$GHLOG"
p4 "$LIB" issue-comment --update "octocat/hello#9" "$W/receipt.md" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 0 ] && grep -q ' pr comment 9 ' "$GHLOG" \
    && ok "no push access: the receipt comment on the user's own PR is still posted" || bad "receipt comment without push: rc=$rc gh=$(tr '\n' '|' < "$GHLOG")"
rm -f "$W/noperm"
touch "$W/garbage"; git -C "$A" branch loki/e10-fkg
p4 "$LIB" push-pr "$A" loki/e10-fkg "E10 title" "$W/body.md" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 0 ] && git -C "$BARE" rev-parse -q --verify refs/heads/loki/e10-fkg >/dev/null \
    && ! git -C "$FORK" rev-parse -q --verify refs/heads/loki/e10-fkg >/dev/null \
    && ok "a garbage permission probe keeps the direct push (fail open)" || bad "garbage probe rc=$rc err=$(tr '\n' ' ' < "$W/err")"
rm -f "$W/status.cid"; : > "$GHLOG"
p4 "$LIB" issue-comment --update "octocat/hello#9" "$W/status.md" >/dev/null 2>"$W/err"; rc=$?
[ "$rc" -eq 0 ] && ! grep -q 'issue comment\|pr comment\|PATCH' "$GHLOG" \
    && ok "a garbage permission probe posts no status comment (fail closed)" || bad "garbage probe comment: rc=$rc gh=$(tr '\n' '|' < "$GHLOG")"
rm -f "$W/garbage"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
