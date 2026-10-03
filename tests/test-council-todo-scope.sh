#!/usr/bin/env bash
# tests/test-council-todo-scope.sh
#
# PO3-COUNCIL-TODO: the completion council counts files carrying TODO/FIXME/
# HACK/XXX markers and blocks above 5. The count must cover the project's own
# source, not node_modules/.git/.loki/dist/build/vendor, and must match marker
# words, not substrings such as XXXLarge. Real project TODOs must still count.
#
# Each marker-count line is extracted from autonomy/completion-council.sh and
# run against a fixture, so the test exercises the shipped command.

set -uo pipefail

SCRIPT_DIR_TEST="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR_TEST/.." && pwd)"
SRC="$REPO_ROOT/autonomy/completion-council.sh"
export LOKI_NO_BROWSER=1

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s -- %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

TO=""
if command -v timeout >/dev/null 2>&1; then TO="timeout -k 5 60"
elif command -v gtimeout >/dev/null 2>&1; then TO="gtimeout -k 5 60"; fi

# Temp hygiene: the run-owned helper only, never raw mktemp.
RAW_TMP_CMD="mk""temp"
if grep -q 'loki_run_tmp_create' "${BASH_SOURCE[0]}" && ! grep -v '^[[:space:]]*#' "${BASH_SOURCE[0]}" | grep -q "$RAW_TMP_CMD"; then
    ok "uses loki_run_tmp_create and no raw temp-dir command"
else
    bad "temp hygiene" "must use loki_run_tmp_create and no raw temp-dir command"
fi

# shellcheck source=../eval/loki10/lib-tmp.sh
. "$REPO_ROOT/eval/loki10/lib-tmp.sh"
loki_run_tmp_create || exit 2
trap 'loki_run_tmp_cleanup' EXIT
SCRATCH="$LOKI_RUN_TMP"

# The marker-count assignment lines, verbatim from the source.
LINES="$SCRATCH/lines.txt"
grep -E '^[[:space:]]*(local )?todo_count=\$\(grep ' "$SRC" > "$LINES"
n_sites="$(wc -l < "$LINES" | tr -d ' ')"
if [ "$n_sites" = "3" ]; then ok "three todo_count sites found"; else bad "site count" "expected 3, got $n_sites"; fi

# run_count <fixture dir> <site line number> -> prints the count
run_count() {
    local dir="$1" idx="$2" line emit
    line="$(sed -n "${idx}p" "$LINES")"
    # shellcheck disable=SC2016  # evaluated by the child shell, not here
    emit='printf "%s" "$todo_count"'
    (cd "$dir" || exit 1; $TO bash -c "$line"$'\n'"$emit")
}

NM="$SCRATCH/nm"
mkdir -p "$NM/src" "$NM/node_modules/pkg"
i=1
while [ $i -le 6 ]; do printf '// TODO: dep %s\n' "$i" > "$NM/node_modules/pkg/f$i.js"; i=$((i + 1)); done
printf 'const a = 1;\n' > "$NM/src/clean.ts"

EX="$SCRATCH/ex"
mkdir -p "$EX"
for d in .git .loki dist build vendor; do
    mkdir -p "$EX/$d"
    printf '# FIXME generated\n' > "$EX/$d/x.py"
done

SUB="$SCRATCH/sub"
mkdir -p "$SUB/src"
i=1
while [ $i -le 6 ]; do
    printf 'const XXXLarge = 1; let todoList = []; // HACKER XXXL\n' > "$SUB/src/f$i.ts"; i=$((i + 1))
done

REAL="$SCRATCH/real"
mkdir -p "$REAL/src"
i=1
while [ $i -le 6 ]; do printf '// TODO: real work %s\n' "$i" > "$REAL/src/f$i.ts"; i=$((i + 1)); done

# Plurals: TODOs/FIXMEs are markers too (six files each).
PLT="$SCRATCH/plural-todo"
PLF="$SCRATCH/plural-fixme"
mkdir -p "$PLT/src" "$PLF/src"
i=1
while [ $i -le 6 ]; do
    printf '// 2 TODOs left here %s\n' "$i" > "$PLT/src/f$i.ts"
    printf '# open FIXMEs %s\n' "$i" > "$PLF/src/f$i.py"
    i=$((i + 1))
done

# Negative control: plural words inside identifiers must not count.
PLN="$SCRATCH/plural-neg"
mkdir -p "$PLN/src"
i=1
while [ $i -le 6 ]; do
    printf 'const TODOs_count = 1; let myTODOs = 2; const TODOS_LIST = 3; // HACKATHON FIXMEs_x\n' > "$PLN/src/f$i.ts"
    i=$((i + 1))
done

idx=1
while [ $idx -le 3 ]; do
    c="$(run_count "$PLT" $idx)"
    if [ "$c" = "6" ]; then ok "site $idx: TODOs plural counted"; else bad "site $idx TODOs plural" "count=$c want 6"; fi
    c="$(run_count "$PLF" $idx)"
    if [ "$c" = "6" ]; then ok "site $idx: FIXMEs plural counted"; else bad "site $idx FIXMEs plural" "count=$c want 6"; fi
    c="$(run_count "$PLN" $idx)"
    if [ "$c" = "0" ]; then ok "site $idx: TODOs_count/myTODOs/TODOS_LIST identifiers not counted"; else bad "site $idx plural negative" "count=$c want 0"; fi
    c="$(run_count "$NM" $idx)"
    if [ "$c" = "0" ]; then ok "site $idx: node_modules TODOs not counted"; else bad "site $idx node_modules" "count=$c want 0"; fi
    c="$(run_count "$EX" $idx)"
    if [ "$c" = "0" ]; then ok "site $idx: .git/.loki/dist/build/vendor not counted"; else bad "site $idx excludes" "count=$c want 0"; fi
    c="$(run_count "$SUB" $idx)"
    if [ "$c" = "0" ]; then ok "site $idx: XXXLarge/todoList substrings not counted"; else bad "site $idx substrings" "count=$c want 0"; fi
    c="$(run_count "$REAL" $idx)"
    if [ "$c" = "6" ]; then ok "site $idx: real src TODOs counted (positive control)"; else bad "site $idx positive control" "count=$c want 6"; fi
    if [ "$c" -gt 5 ] 2>/dev/null; then ok "site $idx: real TODOs exceed the >5 block threshold"; else bad "site $idx threshold" "count=$c"; fi
    idx=$((idx + 1))
done

printf '\nPassed: %s  Failed: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
