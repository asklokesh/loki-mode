#!/usr/bin/env bash
# RECOVERY: engine10-push.sh push-pr is idempotent across an interrupted publish.
# Fault injection with a counting gh stub and a local bare remote (github.com insteadOf rewrite):
#   A. publish interrupted after the push, before the PR exists  -> rerun: no second push, one PR.
#   B. publish interrupted after the PR was created             -> rerun: no second push, no second PR.
#   C. a new commit on the branch                                -> rerun pushes the new commit, still one PR.
# Contract: docs/contracts/recovery.md
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="$ROOT/autonomy/lib/engine10-push.sh"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-recovery-push.XXXXXX")" || exit 1
W="$(cd "$W" && pwd -P)"
trap 'rm -rf "$W" "$ISOLATED_GIT_HOME"' EXIT

URL="https://github.com/octocat/hello.git"
PRURL="https://github.com/octocat/hello/pull/7"
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
printf '#!/bin/sh\necho push >> "%s"\n' "$W/pushes.log" > "$BARE/hooks/pre-receive"
chmod +x "$BARE/hooks/pre-receive"

GHLOG="$W/gh.log"
cat > "$W/bin/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$GHLOG"
case "\$1 \$2" in
    "repo view") echo main ;;
    "api repos/octocat/hello/git/ref/heads/loki/e10-fix")
        git -C "$BARE" rev-parse -q --verify refs/heads/loki/e10-fix 2>/dev/null ;;
    "pr list") [ -f "$W/pr.url" ] && cat "$W/pr.url" ;;
    "pr create") echo "$PRURL" > "$W/pr.url"; echo "$PRURL" ;;
esac
exit 0
EOF
chmod +x "$W/bin/gh"

A="$W/agent"
git init -q "$A"
git -C "$A" commit -q --allow-empty -m init
git -C "$A" branch loki/e10-fix
git -C "$A" remote add origin "$URL"
printf 'body\n' > "$W/body.md"

p4() { GH_TOKEN="x-synthetic" _LOKI_ORIGIN_PINNED=1 _LOKI_PINNED_ORIGIN="$URL" bash "$LIB" push-pr "$A" loki/e10-fix "t" "$W/body.md"; }
creates() { grep -c '^pr create ' "$GHLOG" 2>/dev/null || true; }
pushes() { wc -l < "$W/pushes.log" 2>/dev/null | tr -d ' ' || echo 0; }

: > "$W/pushes.log"; : > "$GHLOG"

# A. first attempt dies after the push: simulate by pushing the branch to the remote directly.
git -C "$A" push -q "$BARE" loki/e10-fix:refs/heads/loki/e10-fix
: > "$W/pushes.log"
out="$(p4 2>"$W/err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$PRURL" ] && ok "A: resume after push opens the PR" || bad "A: rc=$rc out=$out err=$(tr '\n' ' ' < "$W/err")"
[ "$(pushes)" = "0" ] && grep -q "push skipped" "$W/err" && ok "A: push skipped, remote already at the commit" || bad "A: pushed again (pushes=$(pushes))"
[ "$(creates)" = "1" ] && ok "A: exactly one PR create" || bad "A: creates=$(creates)"

# B. second attempt after the PR exists (interrupted before pr.opened was recorded).
out="$(p4 2>"$W/err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$PRURL" ] && [ "$(creates)" = "1" ] && [ "$(pushes)" = "0" ] \
    && ok "B: rerun reuses the PR, no second PR, no second push" || bad "B: rc=$rc out=$out creates=$(creates) pushes=$(pushes)"

# C. a new commit is a different revision: it IS pushed, still one PR.
git -C "$A" checkout -q loki/e10-fix
git -C "$A" commit -q --allow-empty -m second
out="$(p4 2>"$W/err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$(pushes)" = "1" ] && [ "$(creates)" = "1" ] \
    && [ "$(git -C "$BARE" rev-parse loki/e10-fix)" = "$(git -C "$A" rev-parse loki/e10-fix)" ] \
    && ok "C: a new commit is pushed once; still one PR" || bad "C: rc=$rc pushes=$(pushes) creates=$(creates)"

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
