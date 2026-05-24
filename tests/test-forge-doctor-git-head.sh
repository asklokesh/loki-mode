#!/usr/bin/env bash
# Test: N-39 `loki forge doctor` includes git_head in the report.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. inside this repo's working tree: git_head is a 40-char hex SHA
mkdir -p "$ROOT/.loki/forge"
TARGET_DIR="$ROOT" "$ROOT/bin/loki" forge doctor > "$ROOT/.loki/forge/out.json" 2>&1 || true
if grep -qE '"git_head": "[0-9a-f]{40}"' "$ROOT/.loki/forge/out.json"; then
    pass "N-39 git_head emitted as SHA"
else
    fail "no git_head: $(grep git_head "$ROOT/.loki/forge/out.json")"
fi
rm -f "$ROOT/.loki/forge/out.json"

# 2. outside any repo (force git ceiling): git_head is null
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
(cd "$tmp" && GIT_CEILING_DIRECTORIES="$(dirname "$tmp")" \
  TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor) > "$tmp/out.json" 2>&1 || true
if grep -q '"git_head": null' "$tmp/out.json"; then
    pass "N-39 outside repo -> null"
else
    fail "no null git_head: $(grep git_head "$tmp/out.json")"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
