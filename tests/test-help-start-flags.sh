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
bash "$LOKI" help 2>&1 | sed -n "/^Options for 'start':/,/^Deprecated alias/p" > "$WORK/front.txt"
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
for flag in --simple --complex --skip-memory --provider --budget --fresh-prd; do
    check "start help still lists $flag" grep -q -e "$flag" "$WORK/start.txt"
done

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
