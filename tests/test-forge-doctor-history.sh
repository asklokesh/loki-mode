#!/usr/bin/env bash
# Test: N-53 doctor --history N rotates the last N reports.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. single run writes one report
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor --history 5 > /dev/null 2>&1 || true
count=$(ls -1 "$tmp/.loki/forge/doctor-history" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$count" == "1" ]]; then
    pass "N-53 one run -> one file"
else
    fail "got $count files"
fi
rm -rf "$tmp"

# 2. five runs with cap=3 keeps only 3
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
for i in 1 2 3 4 5; do
    TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor --history 3 > /dev/null 2>&1 || true
    sleep 1.1  # filenames differ by Z-stamped seconds
done
count=$(ls -1 "$tmp/.loki/forge/doctor-history" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$count" == "3" ]]; then
    pass "N-53 rotation caps at N"
else
    fail "got $count files"
fi
rm -rf "$tmp"

# 3. plain doctor (no --history) does not create the history dir
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor > /dev/null 2>&1 || true
if [[ ! -d "$tmp/.loki/forge/doctor-history" ]]; then
    pass "N-53 plain doctor no rotation"
else
    fail "rotation triggered without flag"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
