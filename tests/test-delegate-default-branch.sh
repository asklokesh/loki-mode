#!/usr/bin/env bash
# on_run_complete never pushes the repository's ACTUAL default branch,
# not only main/master. The default branch is resolved from the pinned origin
# (gh repo view OWNER/REPO --json defaultBranchRef, run from / with GH_REPO);
# if it cannot be resolved the push is refused (fail closed).
#
# Cases (default branch "develop" on the stub GitHub):
#   develop  -> refused, the reason names the default branch, nothing pushed
#   feature  -> pushed and a PR opened
#   feature, default branch unresolvable -> refused, reason says so
# Synthetic credentials only; no network (global insteadOf routes github.com
# to a local bare repo, gh is a stub on PATH).
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-git-home.sh" || exit 1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_SH="${LOKI_TEST_RUN_SH:-$ROOT/autonomy/run.sh}"
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

W="$(mktemp -d "${TMPDIR:-/tmp}/loki-default-branch.XXXXXX")" || exit 1
W="$(cd "$W" && pwd -P)"
trap 'rm -rf "$W" "$ISOLATED_GIT_HOME"' EXIT

awk '
    /^_LOKI_WITHHELD_TOKENS=""$/ { on = 1 }
    /^on_run_complete\(\) \{$/ { on = 1; last = 1 }
    on { print }
    last && /^}$/ { exit }
' "$RUN_SH" > "$W/fns.sh"
grep -q '^on_run_complete()' "$W/fns.sh" && grep -q '^_loki_trusted_push()' "$W/fns.sh" \
    || { echo "FAIL: on_run_complete or _loki_trusted_push not found in run.sh"; exit 1; }
log_warn() { echo "[WARN] $*" >&2; }
log_info() { echo "[INFO] $*" >&2; }
# shellcheck disable=SC1091
. "$W/fns.sh"

export HOME="$W/home"
mkdir -p "$HOME" "$W/bin"
export PATH="$W/bin:$PATH"
export GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 LOKI_NO_BROWSER=1
unset GIT_SSH_COMMAND GH_TOKEN GITHUB_TOKEN SSH_AUTH_SOCK GIT_CONFIG_COUNT GH_REPO GITHUB_PR LOKI_DELEGATE_PR
git init -q --bare "$W/gh/octocat/hello.git"
git config --global url."$W/gh/".insteadOf "https://github.com/"
git config --global user.email x@example.invalid
git config --global user.name x
git config --global init.defaultBranch main

# gh stub: repo view needs an explicit OWNER/REPO (real gh ignores GH_REPO for
# a bare `repo view` and fails from /). STUB_DEFAULT empty = lookup fails.
GHLOG="$W/gh.log"
cat > "$W/bin/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$GHLOG"
case "\$1 \$2" in
    "auth status") exit 0 ;;
    "repo view")
        [ "\$3" = "octocat/hello" ] || exit 1
        [ -n "\${STUB_DEFAULT:-}" ] || { echo "HTTP 502" >&2; exit 1; }
        # Like real gh: the bare name only through --jq, JSON otherwise.
        case " \$* " in
            *" --jq .defaultBranchRef.name "*) echo "\$STUB_DEFAULT" ;;
            *) echo "{\\"defaultBranchRef\\":{\\"name\\":\\"\$STUB_DEFAULT\\"}}" ;;
        esac ;;
    "pr list") ;;
    "pr create") echo "https://github.com/octocat/hello/pull/7" ;;
esac
exit 0
EOF
chmod +x "$W/bin/gh"

A="$W/agent"
git init -q "$A"
git -C "$A" commit -q --allow-empty -m init
git -C "$A" remote add origin "https://github.com/octocat/hello.git"
git -C "$A" branch develop
git -C "$A" branch feature
TARGET_DIR="$A" _loki_pin_origin

run_case() {  # <branch> <stub-default> -> writes $W/out, sets rc
    git -C "$A" checkout -q "$1"
    : > "$GHLOG"
    ( cd "$A" && export TARGET_DIR="$A" STUB_DEFAULT="$2" && on_run_complete ) > "$W/out" 2>&1
}
pushed() { git -C "$W/gh/octocat/hello.git" rev-parse -q --verify "refs/heads/$1" >/dev/null 2>&1; }

run_case develop develop
if pushed develop; then
    bad "default branch develop was pushed ($(tr '\n' ' ' < "$W/out"))"
else
    ok "agent on the default branch (develop): push refused"
fi
grep -q "default branch" "$W/out" && grep -q "develop" "$W/out" \
    && ok "refusal gives a visible reason naming the default branch" \
    || bad "no visible reason for the refusal ($(tr '\n' ' ' < "$W/out"))"
grep -q "^pr create" "$GHLOG" && bad "a PR was opened from the default branch" || ok "no PR opened from the default branch"

run_case feature develop
pushed feature && ok "agent on feature (default develop): pushed" \
    || bad "feature branch was not pushed ($(tr '\n' ' ' < "$W/out"))"
grep -q "pull/7" "$W/out" && ok "feature: PR opened" || bad "feature: no PR ($(tr '\n' ' ' < "$W/out"))"

git -C "$A" branch feature2
run_case feature2 ""
pushed feature2 && bad "pushed although the default branch could not be resolved" \
    || ok "default branch unresolvable: push refused (fail closed)"
grep -q "could not resolve" "$W/out" && ok "unresolvable: visible reason" \
    || bad "unresolvable: no visible reason ($(tr '\n' ' ' < "$W/out"))"

# create_session_pr (LOKI_AUTO_PR=1) takes its branch from agent-writable
# state and calls the shared push directly: the refusal must live there.
csp_push() {  # <branch> <stub-default>: create_session_pr's exact push line
    : > "$GHLOG"
    ( cd "$A" && export STUB_DEFAULT="$2" && _loki_trusted_push _loki_with_github_tokens . "$1" ) > "$W/out" 2>&1
}
git -C "$A" branch trunk
csp_push trunk trunk; rc=$?
[ "$rc" -eq 2 ] && ! pushed trunk && ok "create_session_pr path: default branch trunk refused (rc=2)" \
    || bad "create_session_pr path pushed default branch trunk (rc=$rc, $(tr '\n' ' ' < "$W/out"))"
csp_push main main; rc=$?
[ "$rc" -eq 2 ] && ! pushed main && ok "create_session_pr path: main refused (rc=2)" \
    || bad "create_session_pr path pushed main (rc=$rc)"
git -C "$A" branch feature3
csp_push feature3 trunk; rc=$?
[ "$rc" -eq 0 ] && pushed feature3 && ok "create_session_pr path: feature3 pushed" \
    || bad "create_session_pr path: feature3 not pushed (rc=$rc, $(tr '\n' ' ' < "$W/out"))"
git -C "$A" branch feature4
csp_push feature4 ""; rc=$?
[ "$rc" -eq 2 ] && ! pushed feature4 && ok "create_session_pr path: unresolvable default refused" \
    || bad "create_session_pr path: pushed with unresolvable default (rc=$rc)"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
