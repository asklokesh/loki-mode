#!/usr/bin/env bash
# Test: N-04 presence join/leave emitted on the bus.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. First set_presence emits presence:join on bus history
if run_py "
import tempfile, time
from forge.services.realtime import set_presence, clear_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    h = history(d, 'room', limit=10)
    joins = [m for m in h if m['payload'].get('type') == 'presence:join']
    assert len(joins) == 1, h
    assert joins[0]['payload']['user_id'] == 'u1'
    assert joins[0]['sender'] == '__presence__'
print('OK')" | grep -q '^OK$'; then pass "N-04 join emitted"; else fail "join not emitted"; fi

# 2. Repeat set_presence for same user does NOT re-emit join
if run_py "
import tempfile
from forge.services.realtime import set_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    set_presence('room', 'u1', forge_dir=d)  # refresh, no new join
    set_presence('room', 'u1', forge_dir=d)
    h = history(d, 'room', limit=10)
    joins = [m for m in h if m['payload'].get('type') == 'presence:join']
    assert len(joins) == 1, [m['payload'] for m in h]
print('OK')" | grep -q '^OK$'; then pass "N-04 join not duplicated"; else fail "duplicate joins"; fi

# 3. clear_presence emits presence:leave
if run_py "
import tempfile
from forge.services.realtime import set_presence, clear_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    clear_presence('room', 'u1', forge_dir=d)
    h = history(d, 'room', limit=10)
    leaves = [m for m in h if m['payload'].get('type') == 'presence:leave']
    assert len(leaves) == 1, h
    assert leaves[0]['payload']['user_id'] == 'u1'
print('OK')" | grep -q '^OK$'; then pass "N-04 leave emitted"; else fail "leave not emitted"; fi

# 4. clear_presence on unknown user does NOT emit
if run_py "
import tempfile
from forge.services.realtime import clear_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    clear_presence('room', 'never_joined', forge_dir=d)
    h = history(d, 'room', limit=10)
    assert h == [], h
print('OK')" | grep -q '^OK$'; then pass "N-04 absent leave silent"; else fail "spurious leave"; fi

# 5. backward compat: no forge_dir -> no emit, state still updates
if run_py "
from forge.services.realtime import set_presence, list_presence
from forge.services.realtime.bus import reset
reset()
set_presence('room2', 'u9')
p = list_presence('room2')
assert len(p) == 1 and p[0]['user_id'] == 'u9'
print('OK')" | grep -q '^OK$'; then pass "N-04 no-forge_dir back-compat"; else fail "back-compat broken"; fi

# 6. list_presence with forge_dir emits leave for stale entries
if run_py "
import tempfile, time
from forge.services.realtime import set_presence, list_presence
from forge.services.realtime.bus import history, reset
from forge.services.realtime import presence as p
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    # Force freshness window to expire by rewriting last_seen
    with p._LOCK:
        p._STATE['room']['u1']['last_seen'] = 0
    list_presence('room', forge_dir=d)
    h = history(d, 'room', limit=10)
    leaves = [m for m in h if m['payload'].get('type') == 'presence:leave']
    assert len(leaves) == 1, h
print('OK')" | grep -q '^OK$'; then pass "N-04 stale-expiry emits leave"; else fail "stale expiry silent"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
