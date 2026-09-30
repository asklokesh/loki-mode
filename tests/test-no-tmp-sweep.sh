#!/usr/bin/env bash
# E-140 guard: no script or test may remove run-owned temp dirs by glob.
# Incident 2026-09-30: a pattern sweep of loki-* under TMPDIR deleted another
# agent's live loki-run.* dir. Part 1 plants two run-owned dirs and checks that
# every suspected cleanup path leaves the foreign one (B) untouched. Part 2 is a
# static scan for rm of a TMPDIR or loki-run glob.
set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0
ok()  { echo "PASS: $1"; PASS=$((PASS + 1)); }
bad() { echo "FAIL: $1"; FAIL=$((FAIL + 1)); }

# shellcheck disable=SC1091
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
unset LOKI_RUN_TMP
loki_run_tmp_create || { echo "FAIL: cannot create run tmp"; exit 1; }
PARENT="$LOKI_RUN_TMP"
trap 'loki_run_tmp_cleanup || echo "WARN: cleanup refused: $PARENT"' EXIT

# plant <name>: run-owned dir shaped like loki_run_tmp_create output
plant() {
    local d
    d="$(mktemp -d "$PARENT/loki-run.$1.XXXXXXXX")" || return 1
    chmod 700 "$d"
    printf '%s\n' "$d" >"$d/.loki-run-owned"
    chmod 600 "$d/.loki-run-owned"
    : >"$d/payload"
    printf '%s\n' "$d"
}
intact() { [ -d "$1" ] && [ -f "$1/payload" ] && [ "$(cat "$1/.loki-run-owned" 2>/dev/null)" = "$1" ]; }

# Part 1a: the helper, with LOKI_RUN_TMP=A, removes only A.
A="$(plant a)"; B="$(plant b)"
( export TMPDIR="$PARENT" LOKI_RUN_TMP="$A"; loki_run_tmp_cleanup ) >/dev/null 2>&1
if [ ! -e "$A" ]; then ok "helper removed its own dir A"; else bad "helper did not remove A"; fi
if intact "$B"; then ok "helper left foreign dir B intact"; else bad "helper damaged B"; fi

# Part 1b: scripts/cleanup-test-processes.sh (the former sweeper) must not touch
# A or B in non-aggressive modes. --aggressive is not executed here: it also
# kills processes by name.
A="$(plant a2)"
for mode in default --dry-run; do
    args=()
    [ "$mode" = "default" ] || args=("$mode")
    ( export TMPDIR="$PARENT" LOKI_RUN_TMP="$A"; bash "$REPO_ROOT/scripts/cleanup-test-processes.sh" ${args[@]+"${args[@]}"} ) >/dev/null 2>&1
    if intact "$A" && intact "$B"; then ok "cleanup-test-processes.sh $mode left A and B intact"
    else bad "cleanup-test-processes.sh $mode removed a run-owned dir"; fi
done
( export TMPDIR="$PARENT"; unset LOKI_RUN_TMP; bash "$REPO_ROOT/scripts/cleanup-test-processes.sh" ) >/dev/null 2>&1
if intact "$A" && intact "$B"; then ok "cleanup-test-processes.sh with no LOKI_RUN_TMP left both intact"
else bad "unset-var run removed a dir"; fi

# Part 1c: the helper refuses a dir with a missing marker and never widens.
C="$(plant c)"; rm -f "$C/.loki-run-owned"
( export TMPDIR="$PARENT" LOKI_RUN_TMP="$C"; loki_run_tmp_cleanup ) >/dev/null 2>&1
if [ -d "$C" ] && intact "$B"; then ok "helper refuses markerless dir, B intact"; else bad "helper removed markerless dir or B"; fi

# Part 2: static scan. An rm -r/-f whose target is a glob under TMPDIR, /tmp or
# loki-run.* is forbidden. Allowlist: the guard-rule fixtures and this file.
ALLOW='^(tests/test-v10-guard\.sh|tests/test-no-tmp-sweep\.sh):'
scan() {
    grep -nE '(^|[;&|({[:space:]])rm[[:space:]]+(-[a-zA-Z]+[[:space:]]+)*(--[[:space:]]+)?[^;&|]*((TMPDIR|/tmp|/private/tmp)[^[:space:];&|]*/(loki-\*|loki-run[^[:space:]]*\*|test-\*|\*)|loki-run\.?\*)' "$@" 2>/dev/null \
        | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#'
}
# find <tmp root> ... -name <loki-*|loki-run.*|test-*> ... (-delete | -exec rm)
scan_find() {
    grep -nE '(^|[;&|({[:space:]])find[[:space:]]+[^;&|]*(TMPDIR|/tmp|/private/tmp)[^;&|]*-i?name[[:space:]]+["'"'"']?(loki-|loki-run\.|test-)[^;&|]*(-delete|-exec[[:space:]]+rm)' "$@" 2>/dev/null \
        | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#'
}
scan_all() { scan "$@"; scan_find "$@"; }
cd "$REPO_ROOT" || exit 1
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(find tests scripts eval loki-ts/tests -type f \( -name '*.sh' -o -name '*.bash' \) -not -path '*/node_modules/*' 2>/dev/null)
HITS="$(scan_all "${FILES[@]}" | grep -vE "$ALLOW" || true)"
if [ -z "$HITS" ]; then ok "no rm of a TMPDIR or loki-run glob in scripts/tests"
else bad "rm of a TMPDIR or loki-run glob found:"; printf '%s\n' "$HITS"; fi

# Positive control: the scan must flag known-bad shapes.
CTRL="$PARENT/control.sh"
cat >"$CTRL" <<'CTL'
rm -rf "${TMPDIR:-/tmp}"/loki-*
rm -rf /tmp/loki-run.*
rm -rf "$TMPDIR"/*
find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'loki-*' -delete
find /tmp -maxdepth 1 -name "loki-run.*" -exec rm -rf {} +
CTL
n="$(scan_all "$CTRL" | wc -l | tr -d ' ')"
if [ "$n" -eq 5 ]; then ok "static scan flags all 5 known-bad shapes"; else bad "static scan positive control caught $n of 5"; fi

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
