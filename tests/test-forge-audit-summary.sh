#!/usr/bin/env bash
# Test: N-36 `loki forge audit --summary` emits one-line summary.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. --summary emits exactly one line with the expected k=v pairs
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit --summary > "$tmp/out.txt" 2>&1 || true
if [[ "$(wc -l < "$tmp/out.txt")" == "1" ]] \
   && grep -qE '^ok=(true|false) checks=[0-9]+ warns=[0-9]+ errs=[0-9]+ dashboard_audit=' "$tmp/out.txt"; then
    pass "N-36 summary is one line k=v"
else
    fail "summary malformed: $(cat "$tmp/out.txt")"
fi
rm -rf "$tmp"

# 2. exit 0 when ok=true
tmp=$(mktemp -d)
set +e
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit --summary > "$tmp/out.txt" 2>&1
ec=$?
set -e
if grep -q '^ok=true' "$tmp/out.txt" && [[ "$ec" == "0" ]]; then
    pass "N-36 exit 0 on ok"
else
    fail "exit $ec"
fi
rm -rf "$tmp"

# 3. plain audit still emits JSON (regression)
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit > "$tmp/out.json" 2>&1 || true
if grep -q '"warnings"' "$tmp/out.json"; then
    pass "N-36 plain audit JSON preserved"
else
    fail "plain audit broke"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
