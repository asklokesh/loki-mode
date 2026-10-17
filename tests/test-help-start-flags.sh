#!/usr/bin/env bash
# `loki help` / `loki start --help` must not advertise flags the Loki 10 start path refuses
# (133-E3: --parallel, --sandbox, --github, --detach and the background flags).
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="$REPO_ROOT/autonomy/loki"
export LOKI_NO_BROWSER=1

PASS=0
FAIL=0
check() { local msg="$1"; shift; if "$@"; then ok "$msg"; else bad "$msg"; fi; }
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home"
export HOME="$WORK/home"

# Front page: only the 'Options for start' block.
bash "$LOKI" help all 2>&1 | sed -n "/^Options for 'start':/,/^Deprecated alias/p" > "$WORK/front.txt"
bash "$LOKI" start --help 2>&1 | sed -n '/^Options:/,/^Issue-mode options/p' > "$WORK/start.txt"
bash "$LOKI" start --help 2>&1 | sed -n '/^Examples:/,$p' > "$WORK/examples.txt"

check "front page start options captured" test -s "$WORK/front.txt"
check "start --help options captured" test -s "$WORK/start.txt"

# The refusal message must name the flags the help no longer advertises.
for flag in --parallel --sandbox --github --detach; do
    check "bin/loki refusal names $flag" grep -q -e "$flag" "$REPO_ROOT/bin/loki"
done

for flag in --parallel --sandbox --github --detach --bg --background; do
    for f in front start examples; do
        if grep -q -e "^ *loki start .*${flag}\b" -e "^ *${flag}\b" -e "^ *--[a-z-]*, ${flag}\b" "$WORK/$f.txt"; then
            bad "$f help advertises refused flag $flag"
        else
            ok "$f help does not advertise $flag"
        fi
    done
done

# Flags still listed must be ones start.ts accepts.
for flag in --simple --complex --skip-memory --provider --budget --cost --fresh-prd; do
    check "start help still lists $flag" grep -q -e "$flag" "$WORK/start.txt"
done

# --- loki start --deploy passthrough (TEN-DEPLOY-09) ---
# A copy of autonomy/loki with cmd_deploy and cmd_github replaced by recorders. Siblings are
# symlinked so the copy resolves its libs; no provider and no cloud CLI is ever run.
mkdir -p "$WORK/repo/autonomy"
for e in "$REPO_ROOT"/* "$REPO_ROOT"/.[!.]*; do
    [ -e "$e" ] || continue
    [ "$(basename "$e")" = autonomy ] || ln -s "$e" "$WORK/repo/$(basename "$e")" 2>/dev/null
done
for e in "$REPO_ROOT"/autonomy/*; do
    [ "$(basename "$e")" = loki ] || ln -s "$e" "$WORK/repo/autonomy/$(basename "$e")"
done
export REC_DEPLOY="$WORK/rec-deploy" REC_GITHUB="$WORK/rec-github"
SL="$WORK/repo/autonomy/loki"
{
    sed '$d' "$LOKI"
    echo 'cmd_deploy() { printf "%s\n" "$*" >> "$REC_DEPLOY"; return "${REC_DEPLOY_RC:-0}"; }'
    echo 'cmd_github() { printf "%s\n" "$*" >> "$REC_GITHUB"; return 0; }'
    echo 'main "$@"'
} > "$SL"
run_deploy() { rm -f "$REC_DEPLOY" "$REC_GITHUB"; bash "$SL" start "$@" >"$WORK/out.txt" 2>&1; echo $?; }

run_deploy --deploy --domain x.com --env-file .env --help >/dev/null
check "start --deploy forwards --domain and --env-file to cmd_deploy" \
    grep -qx -e '--execute --env-file .env --domain x.com' "$REC_DEPLOY"
run_deploy --deploy --destination staging --canary --help >/dev/null
check "start --deploy forwards --destination and --canary" \
    grep -qx -e '--execute --destination staging --canary' "$REC_DEPLOY"
run_deploy --deploy --github --help >/dev/null
check "start --deploy --github runs github publish after deploy" grep -qx -e 'publish' "$REC_GITHUB"
rm -f "$REC_DEPLOY" "$REC_GITHUB"
REC_DEPLOY_RC=3 bash "$SL" start --deploy --github --help >/dev/null 2>&1; rc=$?
check "failed deploy exits non-zero and skips github publish" test "$rc" -eq 3 -a ! -e "$REC_GITHUB"
rc="$(run_deploy --deploy --domain --env-file .env --help)"
check "flag-shaped --domain value exits 2" test "$rc" -eq 2
check "flag-shaped --domain value never deploys" test ! -e "$REC_DEPLOY"
rc="$(run_deploy --domain x.com --help)"
check "--domain without --deploy exits 2" test "$rc" -eq 2
check "start --help lists --domain" grep -q -e '--domain' "$WORK/start.txt"
check "start --help lists --env-file for deploy" grep -q -e 'env-file.*deploy\|deploy.*env-file' "$WORK/start.txt"

# chat /deploy text names the same deploy flags and the live-URL verify (TEN-DEPLOY-09b)
CHAT="$REPO_ROOT/autonomy/lib/chat.sh"
check "chat /deploy help lists --domain and --env-file" \
    grep -q -e '/deploy .*--env-file .*--domain' "$CHAT"
check "chat system prompt names loki verify --url" grep -q -e '_LOKI_CHAT_SYSTEM_PROMPT=.*loki verify --url' "$CHAT"
check "docs/DEPLOYMENT.md has the brief to verified URL section" \
    grep -q -e '^## From brief to verified URL' "$REPO_ROOT/docs/DEPLOYMENT.md"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
