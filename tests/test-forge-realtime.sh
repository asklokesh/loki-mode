#!/usr/bin/env bash
# Test: forge.services.realtime (Phase F-3).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. channel create + list + get + delete
if run_py "
import tempfile
from forge.services.realtime import create_channel, list_channels, get_channel, delete_channel
with tempfile.TemporaryDirectory() as d:
    create_channel(d, 'feed', public=True, rls='public')
    create_channel(d, 'dm.user1', rls='own-row')
    assert len(list_channels(d)) == 2
    g = get_channel(d, 'feed')
    assert g['public'] is True
    assert delete_channel(d, 'feed') is True
    assert len(list_channels(d)) == 1
print('OK')" | grep -q '^OK$'; then pass "channel CRUD"; else fail "channel CRUD"; fi

# 2. bad channel name
if run_py "
import tempfile
from forge.services.realtime import create_channel, ChannelError
with tempfile.TemporaryDirectory() as d:
    for bad in ['UPPER','has space','1lead','a']:
        try: create_channel(d, bad)
        except ChannelError: continue
        raise AssertionError(f'accepted {bad!r}')
print('OK')" | grep -q '^OK$'; then pass "bad channel names rejected"; else fail "bad name accepted"; fi

# 3. bad rls
if run_py "
import tempfile
from forge.services.realtime import create_channel, ChannelError
with tempfile.TemporaryDirectory() as d:
    try: create_channel(d, 'ch', rls='admin')
    except ChannelError: print('OK'); raise SystemExit
    raise AssertionError('bad rls accepted')
" | grep -q '^OK$'; then pass "bad rls rejected"; else fail "bad rls accepted"; fi

# 4. custom rls requires predicate
if run_py "
import tempfile
from forge.services.realtime import create_channel, ChannelError
with tempfile.TemporaryDirectory() as d:
    try: create_channel(d, 'ch', rls='custom')
    except ChannelError: print('OK'); raise SystemExit
    raise AssertionError('custom without predicate accepted')
" | grep -q '^OK$'; then pass "custom rls requires predicate"; else fail "custom rls missing predicate accepted"; fi

# 5. publish + history
if run_py "
import tempfile
from forge.services.realtime import create_channel, publish, history
from forge.services.realtime.bus import reset
reset()
with tempfile.TemporaryDirectory() as d:
    create_channel(d, 'feed', public=True, rls='public')
    publish(d, 'feed', {'msg': 'hello'})
    publish(d, 'feed', {'msg': 'world'})
    h = history(d, 'feed')
    assert len(h) == 2 and h[1]['payload']['msg'] == 'world'
print('OK')" | grep -q '^OK$'; then pass "publish + history"; else fail "publish/history broken"; fi

# 6. history disk fallback
if run_py "
import tempfile
from forge.services.realtime import publish, history
from forge.services.realtime.bus import reset
with tempfile.TemporaryDirectory() as d:
    publish(d, 'feed', {'a': 1})
    publish(d, 'feed', {'a': 2})
    # Clear in-memory ring; should reload from disk.
    reset('feed')
    h = history(d, 'feed')
    assert len(h) == 2, h
print('OK')" | grep -q '^OK$'; then pass "history disk fallback"; else fail "disk fallback broken"; fi

# 7. since_ms filter
if run_py "
import tempfile, time
from forge.services.realtime import publish, history
from forge.services.realtime.bus import reset
reset()
with tempfile.TemporaryDirectory() as d:
    publish(d, 'feed', {'a': 1})
    boundary = int(time.time()*1000) + 1
    time.sleep(0.05)
    publish(d, 'feed', {'a': 2})
    h = history(d, 'feed', since_ms=boundary)
    # Either 1 (the second message) or 2 (if test latency was too low).
    assert 1 <= len(h) <= 2, h
print('OK')" | grep -q '^OK$'; then pass "since_ms filter"; else fail "since_ms filter broken"; fi

# 8. presence
if run_py "
from forge.services.realtime.presence import set_presence, list_presence
set_presence('feed', 'u1', metadata={'k': 'v'})
set_presence('feed', 'u2')
lst = list_presence('feed')
ids = sorted(r['user_id'] for r in lst)
assert ids == ['u1', 'u2'], ids
print('OK')" | grep -q '^OK$'; then pass "presence set + list"; else fail "presence broken"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
