#!/usr/bin/env bash
# Test: N-43 bus.publish persists _meta envelope on every record.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. user message: _meta.source='user', system=False
if run_py "
import tempfile
from forge.services.realtime.bus import publish, history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    publish(d, 'room', {'text': 'hi'}, sender_user_id='u1')
    h = history(d, 'room', limit=10)
    assert h[0]['_meta']['source'] == 'user', h[0]
    assert h[0]['_meta']['system'] is False
print('OK')" | grep -q '^OK$'; then pass "N-43 user record"; else fail "user wrong"; fi

# 2. system sender __presence__: source='system', system=True
if run_py "
import tempfile
from forge.services.realtime.bus import publish, history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    publish(d, 'room', {'type': 'presence:join'},
            sender_user_id='__presence__')
    h = history(d, 'room', limit=10)
    assert h[0]['_meta']['source'] == 'system'
    assert h[0]['_meta']['system'] is True
print('OK')" | grep -q '^OK$'; then pass "N-43 system record"; else fail "system wrong"; fi

# 3. anonymous sender (None) treated as user
if run_py "
import tempfile
from forge.services.realtime.bus import publish, history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    publish(d, 'room', {'text': 'hi'})
    h = history(d, 'room', limit=10)
    assert h[0]['_meta']['system'] is False
print('OK')" | grep -q '^OK$'; then pass "N-43 anon -> user"; else fail "anon wrong"; fi

# 4. presence events naturally carry system meta (integration)
if run_py "
import tempfile
from forge.services.realtime import set_presence
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    set_presence('room', 'u1', forge_dir=d)
    h = history(d, 'room', limit=10)
    assert h[0]['_meta']['source'] == 'system', h[0]
print('OK')" | grep -q '^OK$'; then pass "N-43 presence integration"; else fail "presence not tagged"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
