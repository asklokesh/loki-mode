#!/usr/bin/env bash
# Test: forge.services.schedules (Phase F-3).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. cron validate accepts standard expressions
if run_py "
from forge.services.schedules.cron import validate_expression
for ok in ['0 8 * * *','*/15 * * * *','@hourly','@daily','5,10,15 * * * *','0 0 1 1 *']:
    validate_expression(ok)
print('OK')" | grep -q '^OK$'; then pass "valid cron exprs accepted"; else fail "valid cron rejected"; fi

# 2. cron validate rejects junk
if run_py "
from forge.services.schedules.cron import validate_expression, CronError
for bad in ['','* * *','0 0 0 1 *','99 * * * *','0 24 * * *']:
    try: validate_expression(bad)
    except CronError: continue
    raise AssertionError(f'accepted: {bad!r}')
print('OK')" | grep -q '^OK$'; then pass "bad cron rejected"; else fail "bad cron accepted"; fi

# 3. next_fire_time returns future timestamp
if run_py "
import time
from forge.services.schedules.cron import next_fire_time
nf = next_fire_time('* * * * *', after_ts=time.time())
assert nf > time.time(), nf
nf2 = next_fire_time('@hourly', after_ts=time.time())
assert nf2 > time.time(), nf2
print('OK')" | grep -q '^OK$'; then pass "next_fire_time future"; else fail "next_fire_time broken"; fi

# 4. schedule create + list + get + delete
if run_py "
import tempfile
from forge.services.schedules import create, list_schedules, get, delete
with tempfile.TemporaryDirectory() as d:
    create(d, 'digest', '0 8 * * *', {'type':'function','name':'send_digest'})
    create(d, 'sweep', '@hourly', {'type':'event','topic':'cleanup'})
    assert len(list_schedules(d)) == 2
    g = get(d, 'digest')
    assert g['cron'] == '0 8 * * *'
    assert delete(d, 'digest') is True
    assert len(list_schedules(d)) == 1
print('OK')" | grep -q '^OK$'; then pass "schedule CRUD"; else fail "schedule CRUD broken"; fi

# 5. schedule rejects bad target
if run_py "
import tempfile
from forge.services.schedules import create, ScheduleError
with tempfile.TemporaryDirectory() as d:
    for bad in [{}, {'type':'invalid'}, {'type':'function'}, {'type':'url','url':'ftp://x'}]:
        try: create(d, 'x', '@hourly', bad)
        except ScheduleError: continue
        raise AssertionError(f'accepted: {bad!r}')
print('OK')" | grep -q '^OK$'; then pass "bad target rejected"; else fail "bad target accepted"; fi

# 6. duplicate schedule rejected
if run_py "
import tempfile
from forge.services.schedules import create, ScheduleError
with tempfile.TemporaryDirectory() as d:
    create(d, 'x', '@daily', {'type':'event','topic':'t'})
    try: create(d, 'x', '@daily', {'type':'event','topic':'t'})
    except ScheduleError: print('OK'); raise SystemExit
    raise AssertionError('duplicate accepted')
" | grep -q '^OK$'; then pass "duplicate schedule rejected"; else fail "duplicate accepted"; fi

# 7. update changes cron + reflows next_fire_ts
if run_py "
import tempfile
from forge.services.schedules import create, update, get
with tempfile.TemporaryDirectory() as d:
    create(d, 'x', '@daily', {'type':'event','topic':'t'})
    before = get(d, 'x')['next_fire_ts']
    update(d, 'x', cron='@hourly')
    after = get(d, 'x')['next_fire_ts']
    assert after != before
print('OK')" | grep -q '^OK$'; then pass "update reflows next_fire_ts"; else fail "update broken"; fi

# 8. tick fires due schedules
if run_py "
import tempfile, time, os, json
from forge.services.schedules import create, tick, list_runs
with tempfile.TemporaryDirectory() as d:
    create(d, 'x', '* * * * *', {'type':'event','topic':'t'})
    # Force the next_fire_ts to past:
    sched_path = os.path.join(d, 'schedules', 'schedules.json')
    with open(sched_path) as f: items = json.load(f)
    items[0]['next_fire_ts'] = int(time.time()) - 60
    with open(sched_path, 'w') as f: json.dump(items, f)
    fired = tick(d)
    assert len(fired) == 1, fired
    runs = list_runs(d)
    assert len(runs) == 1, runs
print('OK')" | grep -q '^OK$'; then pass "tick fires due schedules"; else fail "tick broken"; fi

# 9. tick does not fire when not due
if run_py "
import tempfile
from forge.services.schedules import create, tick
with tempfile.TemporaryDirectory() as d:
    create(d, 'x', '0 0 1 1 *', {'type':'event','topic':'t'})  # fires Jan 1
    fired = tick(d)
    assert fired == [], fired
print('OK')" | grep -q '^OK$'; then pass "tick respects future next_fire_ts"; else fail "tick over-fired"; fi

# 10. invoke callback applied
if run_py "
import tempfile, time, os, json
from forge.services.schedules import create, tick
with tempfile.TemporaryDirectory() as d:
    create(d, 'x', '* * * * *', {'type':'function','name':'f'})
    sched_path = os.path.join(d, 'schedules', 'schedules.json')
    items = json.load(open(sched_path))
    items[0]['next_fire_ts'] = int(time.time()) - 60
    json.dump(items, open(sched_path, 'w'))
    seen = []
    def cb(s): seen.append(s['name']); return {'ok': True}
    fired = tick(d, invoke=cb)
    assert seen == ['x'], seen
print('OK')" | grep -q '^OK$'; then pass "tick invokes callback"; else fail "callback not invoked"; fi

# 11. X-28: lint emits warnings for minute=*
if run_py "
from forge.services.schedules.cron import lint
r = lint('* * * * *')
assert r['errors'] == []
assert any('minute' in w for w in r['warnings']), r
assert 'next_fires' in r and len(r['next_fires']) == 3
print('OK')" | grep -q '^OK$'; then pass "X-28 cron lint: minute=* warning"; else fail "minute=* warning missing"; fi

# 12. X-28: lint warns for DOM>28
if run_py "
from forge.services.schedules.cron import lint
r = lint('0 0 30 * *')
assert any('day-of-month' in w for w in r['warnings']), r
print('OK')" | grep -q '^OK$'; then pass "X-28 cron lint: DOM>28 warning"; else fail "DOM warning missing"; fi

# 13. X-28: lint surfaces parse errors
if run_py "
from forge.services.schedules.cron import lint
r = lint('99 * * * *')
assert r['errors'], r
print('OK')" | grep -q '^OK$'; then pass "X-28 cron lint: parse error surfaced"; else fail "parse error not surfaced"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
