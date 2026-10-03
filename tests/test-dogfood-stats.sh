#!/usr/bin/env bash
# PO5-DOGFOOD-HONEST: dogfood-stats.sh labels its figure as a keyword match,
# supports --help, and rejects unknown flags. Runs against a fixture repo.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/../scripts/dogfood-stats.sh"
export LOKI_NO_BROWSER=1

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
nogrep() { ! grep -q "$1" "$2"; }

TMP="$(mktemp -d)"
cleanup() {
    rm -f "$TMP/out" "$TMP/err" "$TMP/json.out" 2>/dev/null
    if [ -d "$TMP/repo" ]; then
        rm -rf "$TMP/repo" 2>/dev/null
    fi
    rmdir "$TMP" 2>/dev/null
}
trap cleanup EXIT

mkdir "$TMP/repo"
(
    cd "$TMP/repo" || exit 1
    git init -q .
    git config user.email t@example.invalid
    git config user.name t
    git config commit.gpgsign false
    echo a > a.txt; git add a.txt; git commit -q -m "feat: manual change"
    echo b >> a.txt; git add a.txt; git commit -q -m "autonomous run fix"
) || { echo "fixture setup failed"; exit 1; }

run() { (cd "$TMP/repo" && bash "$SCRIPT" "$@"); }

run --help >"$TMP/out" 2>"$TMP/err"; rc=$?
check "--help exits 0" [ "$rc" -eq 0 ]
check "--help prints Usage on stdout" grep -q '^Usage:' "$TMP/out"
check "--help computes no stats" nogrep 'Total commits' "$TMP/out"
run -h >"$TMP/out" 2>/dev/null; rc=$?
if [ "$rc" -eq 0 ] && grep -q '^Usage:' "$TMP/out"; then ok "-h works"; else bad "-h broken"; fi

run --bogus >"$TMP/out" 2>"$TMP/err"; rc=$?
check "unknown flag exits 2" [ "$rc" -eq 2 ]
check "unknown flag usage on stderr" grep -q '^Usage:' "$TMP/err"
check "unknown flag computes no stats" nogrep 'Total commits' "$TMP/out"

run >"$TMP/out" 2>&1; rc=$?
if [ "$rc" -eq 0 ] && grep -q 'Total commits' "$TMP/out"; then ok "text report runs"; else bad "text report failed rc=$rc"; fi
check "text labels keyword-matched" grep -q 'keyword-matched' "$TMP/out"

run --json >"$TMP/json.out" 2>/dev/null; rc=$?
check "--json exits 0" [ "$rc" -eq 0 ]
if python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["method"]=="commit-subject keyword match"; assert d["total_commits"]==2; assert d["autonomous_commits"]==1' "$TMP/json.out" 2>/dev/null; then
    ok "JSON valid with method key and fixture counts"
else
    bad "JSON invalid or missing method"
fi

echo "Passed: $PASS Failed: $FAIL"
[ "$FAIL" -eq 0 ]
