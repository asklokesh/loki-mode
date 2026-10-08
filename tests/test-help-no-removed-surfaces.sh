#!/usr/bin/env bash
# No help topic may name a removed surface or carry a hardcoded version stamp.
#
# Help text is the first thing a user reads, and it rots silently: a stamp such
# as "(v6.0.0)" outlives three majors, and a removed port or product keeps being
# advertised. This runs the REAL help output for the front page, the alias
# table and every top-level command the CLI resolves, then fails if any of it
# names the removed dashboard port, the removed standalone web product, or a
# parenthesised version stamp.
#
# Topics are enumerated by probing the CLI (as test-help-discoverability.sh
# does), not by parsing it, so a command that does not exist is skipped.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOKI="${LOKI_UNDER_TEST:-$REPO_ROOT/autonomy/loki}"

PASS=0
FAIL=0
ok()  { printf 'PASS: %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf 'FAIL: %s\n' "$1"; FAIL=$((FAIL + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/home" "$WORK/out" "$WORK/cwd"
export LOKI WORK LOKI_NO_BROWSER=1 HOME="$WORK/home"

START="$(grep -n '^main()' "$LOKI" | head -1 | cut -d: -f1)"
[ -n "$START" ] || { echo "FAIL: could not locate main() in $LOKI"; exit 1; }

awk -v start="$START" '
    NR > start && /^[[:space:]]+[a-z][a-z0-9|_-]*\)/ {
        s = $0; sub(/^[[:space:]]+/, "", s); sub(/\).*/, "", s)
        n = split(s, a, "|")
        for (i = 1; i <= n; i++) print a[i]
    }
' "$LOKI" | sort -u | grep -v -e '^-' -e '^$' > "$WORK/candidates.txt"
printf '%s\n' aliases >> "$WORK/candidates.txt"

# Each probe writes its captured output to a file; the worker always exits 0
# (BSD xargs aborts on 255). A candidate with no file is a failure, not a skip.
# shellcheck disable=SC2016
xargs -P 8 -n 1 bash -c '
    c="$1"
    mkdir -p "$WORK/cwd/$c" && cd "$WORK/cwd/$c" || exit 0
    timeout -k 5 60 "$LOKI" help "$c" </dev/null > "$WORK/out/$c.txt" 2>&1
    exit 0
' _ < "$WORK/candidates.txt"

PATTERN='57374|Purple Lab|\(v[0-9]+\.[0-9]+(\.[0-9]+)?\)'

real=0
while read -r c; do
    f="$WORK/out/$c.txt"
    if [ ! -f "$f" ]; then
        bad "help probe for '$c' left no result; the worker died"
        continue
    fi
    if grep -q "Unknown command" "$f"; then
        continue
    fi
    real=$((real + 1))
    hits="$(grep -nE "$PATTERN" "$f" | head -3)"
    if [ -n "$hits" ]; then
        bad "help for '$c' names a removed surface or a version stamp: $hits"
    fi
done < "$WORK/candidates.txt"

# The bare front page is its own topic.
front="$(cd "$WORK/cwd" && timeout -k 5 60 "$LOKI" help </dev/null 2>&1)"
if printf '%s' "$front" | grep -qE "$PATTERN"; then
    bad "the 'loki help' front page names a removed surface or a version stamp"
else
    real=$((real + 1))
fi

if [ "$real" -lt 50 ]; then
    bad "only $real help topics resolved; the probe is broken, not the CLI"
else
    ok "scanned the real help output of $real topics"
fi

printf '\nTotal: %d  Passed: %d  Failed: %d\n' "$((PASS + FAIL))" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
