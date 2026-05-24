#!/usr/bin/env bash
# Test: N-46 metrics --json emits top-level timestamp.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --json > "$tmp/out.json" 2>&1
if PYTHONPATH="$ROOT" python3 -c "
import json, time
d = json.load(open('$tmp/out.json'))
ts = d['timestamp']
assert isinstance(ts, int)
# Within a 5-minute window of now (covers slow CI hosts)
now = int(time.time())
assert abs(now - ts) < 300, (now, ts)
print('OK')" | grep -q '^OK$'; then pass "N-46 timestamp present + sane"; else fail "missing or wrong"; fi
rm -rf "$tmp"

# 2. successive scrapes have monotonically non-decreasing timestamps
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --json > "$tmp/a.json" 2>&1
sleep 1.1
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --json > "$tmp/b.json" 2>&1
if PYTHONPATH="$ROOT" python3 -c "
import json
a = json.load(open('$tmp/a.json'))['timestamp']
b = json.load(open('$tmp/b.json'))['timestamp']
assert b >= a, (a, b)
print('OK')" | grep -q '^OK$'; then pass "N-46 monotonic"; else fail "regressed"; fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
