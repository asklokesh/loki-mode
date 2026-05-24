#!/usr/bin/env bash
# Test: N-20 `loki forge doctor --watch` polls and emits diffs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. doctor (no --watch) still runs once and exits
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
set +e
TARGET_DIR="$tmp" timeout 10 "$ROOT/bin/loki" forge doctor > "$tmp/out.json" 2>&1
exit_code=$?
set -e
if grep -q '"schema": "loki.forge.doctor/v1"' "$tmp/out.json" \
   && [[ "$exit_code" != "124" ]]; then
    pass "N-20 plain doctor unchanged"
else
    fail "plain doctor broken (exit=$exit_code)"
fi
rm -rf "$tmp"

# 2. doctor --watch emits at least one timestamped block then is killed
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
set +e
TARGET_DIR="$tmp" timeout 4 "$ROOT/bin/loki" forge doctor --watch 1 > "$tmp/out.txt" 2>&1
set -e
if grep -qE '^---.*T.*Z ---$' "$tmp/out.txt" \
   && grep -q '"schema": "loki.forge.doctor/v1"' "$tmp/out.txt"; then
    pass "N-20 --watch prints timestamped doctor"
else
    fail "watch did not loop: $(head -20 "$tmp/out.txt")"
fi
rm -rf "$tmp"

# 3. doctor --watch uses default interval when only --watch passed
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
set +e
TARGET_DIR="$tmp" timeout 3 "$ROOT/bin/loki" forge doctor --watch > "$tmp/out.txt" 2>&1
set -e
if grep -qE '^---.*T.*Z ---$' "$tmp/out.txt"; then
    pass "N-20 --watch defaults interval"
else
    fail "no output with default interval"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
