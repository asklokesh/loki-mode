#!/usr/bin/env bash
# Test: N-54 schedule pause()/resume() flip enabled + emit events.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. pause flips enabled=False + emits schedule:paused
if run_py "
import tempfile
from forge.services.schedules import create, pause, get
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    create(d, name='hourly', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'})
    pause(d, 'hourly')
    assert get(d, 'hourly')['enabled'] is False
    h = history(d, '_system.schedules', limit=10)
    assert any(m['payload']['type'] == 'schedule:paused'
               for m in h), h
print('OK')" | grep -q '^OK$'; then pass "N-54 pause + event"; else fail "no pause"; fi

# 2. resume flips back + emits schedule:resumed
if run_py "
import tempfile
from forge.services.schedules import create, pause, resume, get
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    create(d, name='hourly', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'})
    pause(d, 'hourly'); resume(d, 'hourly')
    assert get(d, 'hourly')['enabled'] is True
    h = history(d, '_system.schedules', limit=10)
    types = [m['payload']['type'] for m in h]
    assert 'schedule:paused' in types and 'schedule:resumed' in types, types
print('OK')" | grep -q '^OK$'; then pass "N-54 resume + event"; else fail "no resume"; fi

# 3. pause is idempotent (already-paused still emits)
if run_py "
import tempfile
from forge.services.schedules import create, pause
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    create(d, name='hourly', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'})
    pause(d, 'hourly')
    pause(d, 'hourly')
    h = history(d, '_system.schedules', limit=10)
    pauses = [m for m in h if m['payload']['type'] == 'schedule:paused']
    assert len(pauses) == 2, len(pauses)
print('OK')" | grep -q '^OK$'; then pass "N-54 idempotent emits"; else fail "missing second event"; fi

# 4. unknown schedule raises ScheduleError
if run_py "
import tempfile
from forge.services.schedules import pause, ScheduleError
with tempfile.TemporaryDirectory() as d:
    try:
        pause(d, 'ghost')
        print('NO_RAISE')
    except ScheduleError as e:
        print('OK')" | grep -q '^OK$'; then pass "N-54 unknown raises"; else fail "ghost accepted"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
