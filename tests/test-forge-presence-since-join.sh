#!/usr/bin/env bash
# Test: N-50 presence:refresh carries __since_join_ms.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. first set: join carries no since_join_ms
if run_py "
import tempfile
from forge.services.realtime import set_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    h = history(d, 'room', limit=10)
    assert h[0]['payload']['type'] == 'presence:join'
    assert '__since_join_ms' not in h[0]['payload'].get('metadata', {})
print('OK')" | grep -q '^OK$'; then pass "N-50 join has no since"; else fail "join had since"; fi

# 2. refresh after small sleep: since_join_ms >= 0
if run_py "
import tempfile, time
from forge.services.realtime import set_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    time.sleep(0.5)
    set_presence('room', 'u1', forge_dir=d)
    h = history(d, 'room', limit=10)
    refresh = [m for m in h if m['payload']['type'] == 'presence:refresh'][0]
    since = refresh['payload']['metadata'].get('__since_join_ms')
    assert isinstance(since, int) and since >= 400, since
print('OK')" | grep -q '^OK$'; then pass "N-50 refresh has since"; else fail "no since"; fi

# 3. join_at_ms is preserved across refreshes (record stays stable)
if run_py "
import tempfile, time
from forge.services.realtime import set_presence
from forge.services.realtime import presence as p
with tempfile.TemporaryDirectory() as d:
    set_presence('room', 'u1', forge_dir=d)
    first_join = p._STATE['room']['u1']['joined_at_ms']
    time.sleep(0.5)
    set_presence('room', 'u1', forge_dir=d)
    assert p._STATE['room']['u1']['joined_at_ms'] == first_join
print('OK')" | grep -q '^OK$'; then pass "N-50 joined_at preserved"; else fail "joined_at drifted"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
