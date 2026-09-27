#!/usr/bin/env bash
# E-26 (ENGINE.md section 13): autonomy/lib/engine10-push-gitlab.sh, the P4
# GitLab MR push child. Local bare remote behind a gitlab.com insteadOf
# rewrite (isolated global config), a stub glab on PATH, synthetic
# credentials only, no network.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIB="${E10_PUSH_GITLAB_LIB:-$ROOT/autonomy/lib/engine10-push-gitlab.sh}"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-e10-pushgl.XXXXXX")" || exit 1
W="$(cd "$W" && pwd -P)"
trap 'rm -rf "$W" "$ISOLATED_GIT_HOME"' EXIT

CANARY="glpat-ENGINE10GITLABCANARY0000"
URL="https://gitlab.com/grp/sub/proj.git"
MRURL="https://gitlab.com/grp/sub/proj/-/merge_requests/7"
# file only: a push that escapes the insteadOf rewrite fails before any network.
export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 LOKI_NO_BROWSER=1 GIT_ALLOW_PROTOCOL=file
unset GIT_SSH_COMMAND GITLAB_TOKEN GITLAB_HOST GL_HOST SSH_AUTH_SOCK GIT_CONFIG_COUNT
mkdir -p "$W/bin" "$W/gl/grp/sub"
export PATH="$W/bin:$PATH"

git config --global url."$W/gl/".insteadOf "https://gitlab.com/"
git config --global user.email x@example.invalid
git config --global user.name x
git config --global init.defaultBranch main

BARE="$W/gl/grp/sub/proj.git"
git init -q --bare "$BARE"
printf '#!/bin/sh\necho "remote token=${GITLAB_TOKEN:-none}" >> "%s"\n' "$W/remote.log" > "$BARE/hooks/pre-receive"
chmod +x "$BARE/hooks/pre-receive"

# Stub glab: logs cwd, host and argv; at most one open MR, kept in mr.url.
GLLOG="$W/glab.log"
cat > "$W/bin/glab" <<EOF
#!/bin/sh
echo "cwd=\$PWD host=\${GITLAB_HOST:-} token=\${GITLAB_TOKEN:-none} \$*" >> "$GLLOG"
case "\$1 \$2" in
    "api projects/grp%2Fsub%2Fproj") printf '{"default_branch":"%s"}\n' "\$(cat "$W/default")" ;;
    "mr list") if [ -f "$W/mr.url" ]; then printf '[{"web_url":"%s"}]\n' "\$(cat "$W/mr.url")"; else echo '[]'; fi ;;
    "mr create") echo "$MRURL" > "$W/mr.url"; echo "Creating merge request"; echo "$MRURL" ;;
esac
exit 0
EOF
chmod +x "$W/bin/glab"
echo main > "$W/default"

A="$W/agent"
git init -q "$A"
git -C "$A" commit -q --allow-empty -m init
git -C "$A" branch loki/e10-fix
git -C "$A" branch loki/e10-ctl
git -C "$A" branch trunk
git -C "$A" remote add origin "$URL"
REC="$W/hook.rec"
printf '#!/bin/sh\necho "hook token=${GITLAB_TOKEN:-none}" >> "%s"\n' "$REC" > "$A/.git/hooks/pre-push"
chmod +x "$A/.git/hooks/pre-push"
printf 'body line\n' > "$W/body.md"

p4() { GITLAB_TOKEN="$CANARY" GITLAB_HOST=evil.example _LOKI_ORIGIN_PINNED=1 _LOKI_PINNED_ORIGIN="$URL" bash "$LIB" "$@"; }
creates() { grep -c ' mr create ' "$GLLOG" 2>/dev/null || true; }

# Control: the planted hook is live on an in-repo credentialed push.
: > "$REC"
( cd "$A" && GITLAB_TOKEN="$CANARY" git push -q origin loki/e10-ctl ) >/dev/null 2>&1
grep -q "token=$CANARY" "$REC" && ok "control: planted pre-push hook sees the canary on an in-repo push" \
    || bad "control: planted hook did not fire (plant not live)"

# push-mr: push lands, hook records nothing, MR created as draft from /.
: > "$REC"; : > "$W/remote.log"; : > "$GLLOG"
out="$(p4 push-mr "$A" loki/e10-fix "E10 title" "$W/body.md" --draft 2>"$W/err")"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$MRURL" ] && ok "push-mr prints the MR URL" \
    || bad "push-mr rc=$rc out=$out err=$(tr '\n' ' ' < "$W/err")"
[ "$(git -C "$BARE" rev-parse -q --verify refs/heads/loki/e10-fix)" = "$(git -C "$A" rev-parse loki/e10-fix)" ] \
    && grep -qx "remote token=$CANARY" "$W/remote.log" && ok "push landed on the remote with the credential" \
    || bad "push did not land (remote log: $(tr '\n' ',' < "$W/remote.log"))"
if grep -q "token=$CANARY" "$REC"; then bad "planted pre-push hook recorded the canary"; else ok "planted pre-push hook recorded no canary"; fi
grep -q '^cwd=/ host=gitlab.com .* mr list --repo grp/sub/proj --source-branch loki/e10-fix --output json$' "$GLLOG" \
    && ok "check-before-create: glab mr list ran neutral (cwd /, host gitlab.com)" || bad "no neutral glab mr list ($(tr '\n' '|' < "$GLLOG"))"
grep -q '^cwd=/ host=gitlab.com .* mr create --repo grp/sub/proj --source-branch loki/e10-fix --title E10 title --description body line --yes --draft$' "$GLLOG" \
    && ok "glab mr create ran neutral with --draft" || bad "glab mr create args wrong ($(tr '\n' '|' < "$GLLOG"))"

# Second call reuses the open MR.
out="$(p4 push-mr "$A" loki/e10-fix "E10 title" "$W/body.md" 2>/dev/null)"; rc=$?
[ "$rc" -eq 0 ] && [ "$out" = "$MRURL" ] && [ "$(creates)" = "1" ] && ok "second call reuses the existing MR URL" \
    || bad "second call rc=$rc out=$out creates=$(creates)"

# refused <label> <stderr-substring> <cmd...>: rc 2, the reason on stderr,
# nothing reached the remote and no MR was created.
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
pin() { local u="$1"; shift; env GITLAB_TOKEN="$CANARY" _LOKI_ORIGIN_PINNED=1 _LOKI_PINNED_ORIGIN="$u" bash "$LIB" "$@"; }

refused "push to main is refused, nothing sent" "never pushes directly to a default branch" \
    p4 push-mr "$A" main t "$W/body.md"
echo trunk > "$W/default"
refused "push to the glab-resolved default branch (trunk) is refused" "it is the default branch of grp/sub/proj" \
    p4 push-mr "$A" trunk t "$W/body.md"
echo main > "$W/default"
refused "refuses without _LOKI_ORIGIN_PINNED=1" "origin not pinned" \
    env GITLAB_TOKEN="$CANARY" bash "$LIB" push-mr "$A" loki/e10-fix t "$W/body.md"
refused "agent origin differing from the pin is refused" "origin changed during the run" \
    pin "https://gitlab.com/grp/other.git" push-mr "$A" loki/e10-fix t "$W/body.md"
for u in "https://gitlab.example.com/grp/sub/proj.git" "https://gitlab.com.evil.example/grp/proj.git" \
    "https://github.com/grp/proj.git" "https://tok@gitlab.com/grp/proj.git" "https://gitlab.com:8443/grp/proj.git" \
    "git@gitlab.com-work:grp/proj.git" "https://gitlab.com/proj.git" "https://gitlab.com/grp/../proj.git"; do
    git -C "$A" remote set-url origin "$u"
    refused "non-gitlab.com origin refused: $u" "pinned origin refused" pin "$u" push-mr "$A" loki/e10-fix t "$W/body.md"
done
git -C "$A" remote set-url origin "$URL"
: > "$W/default"
refused "unresolvable default branch fails closed" "could not resolve the default branch" \
    p4 push-mr "$A" loki/e10-fix t "$W/body.md"
echo main > "$W/default"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
