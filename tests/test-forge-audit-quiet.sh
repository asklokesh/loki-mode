#!/usr/bin/env bash
# Test: N-27 `loki forge audit --quiet` collapses report to counts.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. plain audit still emits the full report
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit > "$tmp/out.json" 2>&1 || true
if grep -q '"warnings"' "$tmp/out.json" && grep -q '"errors"' "$tmp/out.json"; then
    pass "N-27 plain emits warnings + errors"
else
    fail "plain missing fields"
fi
rm -rf "$tmp"

# 2. --quiet collapses to counts only
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit --quiet > "$tmp/out.json" 2>&1 || true
if grep -q '"ok"' "$tmp/out.json" \
   && grep -q '"errors_count"' "$tmp/out.json" \
   && grep -q '"warnings_count"' "$tmp/out.json" \
   && ! grep -q '"warnings":' "$tmp/out.json"; then
    pass "N-27 --quiet only emits counts"
else
    fail "quiet still chatty: $(cat "$tmp/out.json")"
fi
rm -rf "$tmp"

# 3. --quiet still exits 0 when ok=true
tmp=$(mktemp -d)
set +e
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit --quiet > "$tmp/out.json" 2>&1
exit_code=$?
set -e
if grep -q '"ok": true' "$tmp/out.json" && [[ "$exit_code" == "0" ]]; then
    pass "N-27 --quiet exits 0 on ok"
else
    fail "exit $exit_code on ok"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
