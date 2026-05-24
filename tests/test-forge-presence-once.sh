#!/usr/bin/env bash
# Test: N-18 presence:leave fires exactly once per logical transition.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. clear then list does not double-emit leave
if run_py "
import tempfile
from forge.services.realtime import set_presence, clear_presence, list_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    clear_presence('room', 'u1', forge_dir=d)
    list_presence('room', forge_dir=d)
    h = history(d, 'room', limit=10)
    leaves = [m for m in h if m['payload'].get('type') == 'presence:leave']
    assert len(leaves) == 1, len(leaves)
print('OK')" | grep -q '^OK$'; then pass "N-18 no double-leave"; else fail "double leave"; fi

# 2. gc_presence drains expired entries and emits one leave each
if run_py "
import tempfile
from forge.services.realtime import set_presence, gc_presence
from forge.services.realtime.bus import history, reset
from forge.services.realtime import presence as p
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    set_presence('room', 'u2', forge_dir=d)
    with p._LOCK:
        p._STATE['room']['u1']['last_seen'] = 0
        p._STATE['room']['u2']['last_seen'] = 0
    expired = gc_presence('room', forge_dir=d)
    assert set(expired) == {'u1', 'u2'}, expired
    h = history(d, 'room', limit=10)
    leaves = [m for m in h if m['payload'].get('type') == 'presence:leave']
    assert len(leaves) == 2, leaves
print('OK')" | grep -q '^OK$'; then pass "N-18 gc drains + emits"; else fail "gc broken"; fi

# 3. gc on a clean channel is a no-op (no spurious leaves)
if run_py "
import tempfile
from forge.services.realtime import set_presence, gc_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    expired = gc_presence('room', forge_dir=d)
    assert expired == [], expired
    h = history(d, 'room', limit=10)
    leaves = [m for m in h if m['payload'].get('type') == 'presence:leave']
    assert leaves == [], leaves
print('OK')" | grep -q '^OK$'; then pass "N-18 gc clean no-op"; else fail "gc spurious"; fi

# 4. running gc twice on already-expired state: second is a no-op
if run_py "
import tempfile
from forge.services.realtime import set_presence, gc_presence
from forge.services.realtime.bus import history, reset
from forge.services.realtime import presence as p
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    with p._LOCK:
        p._STATE['room']['u1']['last_seen'] = 0
    gc_presence('room', forge_dir=d)
    gc_presence('room', forge_dir=d)
    h = history(d, 'room', limit=10)
    leaves = [m for m in h if m['payload'].get('type') == 'presence:leave']
    assert len(leaves) == 1, leaves
print('OK')" | grep -q '^OK$'; then pass "N-18 second gc no-op"; else fail "double leave on second gc"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
