#!/usr/bin/env bash
# Test: X-11 migration diff, X-19 memory bridge, X-22 schedule watchdog.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. X-11: render_diff on add_table spec
if run_py "
from forge.services.database.diff import render_diff
spec = {'summary':'add users','operations':[{'add_table':{
    'name':'users','columns':['id pk','email text unique notnull'],
    'rls':'own-row'}}]}
out = render_diff(spec)
assert out['added_tables'] and out['added_tables'][0]['name'] == 'users'
assert out['added_tables'][0]['rls'] == 'own-row'
print('OK')" | grep -q '^OK$'; then pass "X-11 diff: add_table"; else fail "diff add_table broken"; fi

# 2. X-11: render_diff handles drop / add_column / set_rls / create_index
if run_py "
from forge.services.database.diff import render_diff
spec = {'operations':[
    {'drop_table':'old_t'},
    {'add_column':{'table':'users','column':{'name':'name','type':'text'}}},
    {'set_rls':{'table':'posts','policy':'public','predicate':'TRUE'}},
    {'create_index':{'table':'users','columns':['email'],'unique':True}},
]}
out = render_diff(spec)
assert out['dropped_tables'] == ['old_t']
assert out['added_columns'][0]['table'] == 'users'
assert out['rls_changes'][0]['policy'] == 'public'
assert out['indices'][0]['unique'] is True
print('OK')" | grep -q '^OK$'; then pass "X-11 diff: all verbs"; else fail "diff verbs incomplete"; fi

# 3. X-22: watchdog status without prior ping
if run_py "
import tempfile
from forge.services.schedules import watchdog_status
with tempfile.TemporaryDirectory() as d:
    s = watchdog_status(d)
    assert s['ok'] is False and s['reason'] == 'never_ticked'
print('OK')" | grep -q '^OK$'; then pass "X-22 watchdog cold-start state"; else fail "watchdog cold state wrong"; fi

# 4. X-22: ping then status reports ok
if run_py "
import tempfile
from forge.services.schedules import watchdog_ping, watchdog_status
with tempfile.TemporaryDirectory() as d:
    watchdog_ping(d)
    s = watchdog_status(d, threshold_seconds=60)
    assert s['ok'] is True and s['stalled'] is False
    assert s['ticks_total'] == 1
print('OK')" | grep -q '^OK$'; then pass "X-22 ping + status"; else fail "ping/status broken"; fi

# 5. X-22: stalled when last tick > threshold
if run_py "
import json, os, tempfile, time
from forge.services.schedules import watchdog_ping, watchdog_status
with tempfile.TemporaryDirectory() as d:
    watchdog_ping(d)
    p = os.path.join(d, 'schedules', '.watchdog.json')
    cur = json.load(open(p))
    cur['last_tick_ts'] = int(time.time()) - 999
    open(p, 'w').write(json.dumps(cur))
    s = watchdog_status(d, threshold_seconds=60)
    assert s['stalled'] is True
print('OK')" | grep -q '^OK$'; then pass "X-22 stalled detection"; else fail "stalled not detected"; fi

# 6. X-22: tick() pings watchdog
if run_py "
import json, os, tempfile, time
from forge.services.schedules import create, tick
with tempfile.TemporaryDirectory() as d:
    create(d, 'demo', '* * * * *', {'type':'event','topic':'t'})
    tick(d)
    p = os.path.join(d, 'schedules', '.watchdog.json')
    assert os.path.exists(p), 'watchdog ping not written'
print('OK')" | grep -q '^OK$'; then pass "X-22 tick() pings watchdog"; else fail "tick didn't ping"; fi

# 7. X-19: record_migration_outcome writes jsonl
if run_py "
import os, tempfile
from forge.memory_bridge import record_migration_outcome, load_recent
with tempfile.TemporaryDirectory() as d:
    record_migration_outcome(d, migration_id='m1', summary='add users',
                              outcome='applied', sql_snippet='CREATE TABLE...')
    record_migration_outcome(d, migration_id='m2', summary='add posts',
                              outcome='applied')
    rs = load_recent(d, kind='migration_outcomes')
    assert len(rs) == 2
    assert rs[0]['migration_id'] == 'm1'
print('OK')" | grep -q '^OK$'; then pass "X-19 migration outcome recorded"; else fail "memory bridge broken"; fi

# 8. X-19: record_schema_decision works
if run_py "
import tempfile
from forge.memory_bridge import record_schema_decision, load_recent
with tempfile.TemporaryDirectory() as d:
    record_schema_decision(d, table_name='users',
                            columns_summary='id, email',
                            decision='uuid pk', rationale='multi-region',
                            outcome='success')
    rs = load_recent(d, kind='schema_decisions')
    assert len(rs) == 1
    assert rs[0]['table_name'] == 'users'
print('OK')" | grep -q '^OK$'; then pass "X-19 schema decision recorded"; else fail "schema decision broken"; fi

# 9. X-19: migrate_apply triggers memory bridge
if run_py "
import os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.memory_bridge import load_recent
with tempfile.TemporaryDirectory() as tdir:
    project = os.path.join(tdir, 'proj')
    forge_dir = os.path.join(project, '.loki', 'forge')
    os.makedirs(forge_dir)
    e = open_engine(forge_dir)
    migrate_apply(e, {'summary':'add t','operations':[{'add_table':{
        'name':'t','columns':['id pk']}}]})
    rs = load_recent(project, kind='migration_outcomes')
    assert len(rs) == 1
    assert rs[0]['outcome'] == 'applied'
print('OK')" | grep -q '^OK$'; then pass "X-19 migrate_apply auto-records"; else fail "auto-record broken"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
