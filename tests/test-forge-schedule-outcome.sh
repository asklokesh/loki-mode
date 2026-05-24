#!/usr/bin/env bash
# Test: N-12 list_schedules surfaces last_run_outcome.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. fresh schedule has no last_run_outcome yet
if run_py "
import tempfile
from forge.services.schedules import create, list_schedules
with tempfile.TemporaryDirectory() as d:
    create(d, name='hourly', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'})
    rows = list_schedules(d)
    assert rows[0].get('last_run_outcome') in (None, '', 'recorded'), rows[0]
print('OK')" | grep -q '^OK$'; then pass "N-12 fresh schedule unset"; else fail "stale outcome"; fi

# 2. after a successful tick, last_run_outcome == 'ok'
if run_py "
import tempfile, time
from forge.services.schedules import create, list_schedules
from forge.services.schedules.runner import tick
with tempfile.TemporaryDirectory() as d:
    create(d, name='hourly', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'})
    # Force the next_fire_ts into the past so tick fires.
    import json, os
    p = os.path.join(d, 'schedules', 'schedules.json')
    with open(p) as f: items = json.load(f)
    items[0]['next_fire_ts'] = int(time.time()) - 60
    with open(p, 'w') as f: json.dump(items, f)
    tick(d, invoke=lambda s: {'ok': True})
    rows = list_schedules(d)
    assert rows[0]['last_run_outcome'] == 'ok', rows[0]
    assert 'last_run_at' in rows[0]
print('OK')" | grep -q '^OK$'; then pass "N-12 ok recorded"; else fail "ok not recorded"; fi

# 3. error tick sets last_run_outcome=error + detail
if run_py "
import tempfile, time
from forge.services.schedules import create, list_schedules
from forge.services.schedules.runner import tick
with tempfile.TemporaryDirectory() as d:
    create(d, name='hourly', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'})
    import json, os
    p = os.path.join(d, 'schedules', 'schedules.json')
    with open(p) as f: items = json.load(f)
    items[0]['next_fire_ts'] = int(time.time()) - 60
    with open(p, 'w') as f: json.dump(items, f)
    def boom(s): raise RuntimeError('boom')
    tick(d, invoke=boom)
    rows = list_schedules(d)
    assert rows[0]['last_run_outcome'] == 'error', rows[0]
    assert 'boom' in (rows[0].get('last_run_detail') or '')
print('OK')" | grep -q '^OK$'; then pass "N-12 error recorded"; else fail "error not recorded"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
