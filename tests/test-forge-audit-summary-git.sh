#!/usr/bin/env bash
# Test: N-47 audit --summary appends git_head when in a repo.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. inside this repo: git_head SHA appended
TARGET_DIR="$ROOT" "$ROOT/bin/loki" forge audit --summary > /tmp/n47.txt 2>&1 || true
if grep -qE 'git_head=[0-9a-f]{40}$' /tmp/n47.txt; then
    pass "N-47 SHA appended in repo"
else
    fail "no git_head: $(cat /tmp/n47.txt)"
fi
rm -f /tmp/n47.txt

# 2. outside any repo (ceiling): git_head absent
tmp=$(mktemp -d)
(cd "$tmp" && GIT_CEILING_DIRECTORIES="$(dirname "$tmp")" \
  TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit --summary) > "$tmp/out.txt" 2>&1 || true
if ! grep -q 'git_head=' "$tmp/out.txt"; then
    pass "N-47 omitted outside repo"
else
    fail "spurious git_head: $(cat "$tmp/out.txt")"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
