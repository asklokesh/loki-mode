#!/usr/bin/env bash
# Test: N-38 set_presence on existing user emits presence:refresh.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. first set: join (no refresh)
if run_py "
import tempfile
from forge.services.realtime import set_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    h = history(d, 'room', limit=10)
    types = [m['payload']['type'] for m in h]
    assert types == ['presence:join'], types
print('OK')" | grep -q '^OK$'; then pass "N-38 first set is join only"; else fail "join+refresh"; fi

# 2. repeat sets: one join + N refreshes
if run_py "
import tempfile
from forge.services.realtime import set_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    set_presence('room', 'u1', forge_dir=d)
    set_presence('room', 'u1', forge_dir=d)
    h = history(d, 'room', limit=10)
    types = [m['payload']['type'] for m in h]
    assert types == ['presence:join', 'presence:refresh', 'presence:refresh'], types
print('OK')" | grep -q '^OK$'; then pass "N-38 refresh on repeat"; else fail "wrong sequence"; fi

# 3. refresh carries the latest metadata
if run_py "
import tempfile
from forge.services.realtime import set_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', metadata={'v': 1}, forge_dir=d)
    set_presence('room', 'u1', metadata={'v': 2}, forge_dir=d)
    h = history(d, 'room', limit=10)
    refresh = [m for m in h if m['payload']['type'] == 'presence:refresh'][0]
    assert refresh['payload']['metadata'] == {'v': 2}, refresh
print('OK')" | grep -q '^OK$'; then pass "N-38 refresh carries metadata"; else fail "metadata stale"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
