#!/usr/bin/env bash
# shellcheck disable=SC2015,SC2016
# loki quickstart --explain-match: top 3 template scores plus a confidence label.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
QS="$REPO_ROOT/autonomy/quickstart.sh"

PASS=0; FAIL=0
ok()  { echo "  [PASS] $1"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }

run_qs() { timeout -k 5 60 bash -c 'source "$1"; shift; cmd_quickstart "$@"' _ "$QS" "$@" 2>&1 </dev/null; }

echo "T1 -- strong match prints 3 scored rows and a label"
out="$(run_qs 'a URL shortener with click stats' --dry-run --explain-match)"
rows="$(printf '%s\n' "$out" | grep -cE '^  [0-9]+\. .+ score [0-9]+$')"
[ "$rows" = "3" ] && ok "3 scored rows" || bad "expected 3 scored rows, got $rows"
printf '%s\n' "$out" | grep -q 'Match confidence: ' && ok "confidence label" || bad "no confidence label"

echo "T2 -- strength-0 brief says no strong match"
out="$(run_qs 'zzqx plumbing quux' --dry-run --explain-match)"
printf '%s\n' "$out" | grep -q 'no strong match, using a plain spec' && ok "no strong match line" || bad "missing no-strong-match line"

echo "T3 -- flag off output is unchanged"
out="$(run_qs 'a URL shortener with click stats' --dry-run)"
if printf '%s\n' "$out" | grep -qE 'Match confidence|score [0-9]+$'; then bad "explain output leaked without flag"; else ok "no explain output without flag"; fi

echo "T4 -- flag requires --dry-run and refuses --json"
run_qs 'a todo app' --explain-match >/dev/null; rc=$?
[ "$rc" = "2" ] && ok "needs --dry-run (exit 2)" || bad "expected exit 2 without --dry-run, got $rc"
run_qs 'a todo app' --dry-run --json --explain-match >/dev/null; rc=$?
[ "$rc" = "2" ] && ok "refuses --json (exit 2)" || bad "expected exit 2 with --json, got $rc"

echo "T5 -- bash 3.2"
if [ -x /bin/bash ]; then
    out="$(timeout -k 5 60 /bin/bash -c 'source "$1"; shift; cmd_quickstart "$@"' _ "$QS" 'a URL shortener with click stats' --dry-run --explain-match 2>&1 </dev/null)"
    if printf '%s\n' "$out" | grep -q 'Match confidence: '; then ok "works under /bin/bash"; else bad "fails under /bin/bash"; fi
fi

echo "Results: $PASS passed, $FAIL failed, $((PASS+FAIL)) total"
[ "$FAIL" -eq 0 ]
