#!/usr/bin/env bash
# Test: N-26 schedule last_run_outcome surfaces in /metrics.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. fresh schedule with no run yet -> outcome="none"
if run_py "
import tempfile
from forge.services.schedules import create
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    create(d, name='hourly', cron='0 * * * *', target={'type': 'event', 'topic': 'noop'})
    out = render(d)
    assert 'forge_schedule_last_outcome' in out, out
    assert 'outcome=\"none\"' in out, out
print('OK')" | grep -q '^OK$'; then pass "N-26 fresh -> none"; else fail "no metric"; fi

# 2. after a tick: outcome reflects ok
if run_py "
import tempfile, time, os, json
from forge.services.schedules import create
from forge.services.schedules.runner import tick
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    create(d, name='hourly', cron='0 * * * *', target={'type': 'event', 'topic': 'noop'})
    p = os.path.join(d, 'schedules', 'schedules.json')
    with open(p) as f: items = json.load(f)
    items[0]['next_fire_ts'] = int(time.time()) - 60
    with open(p, 'w') as f: json.dump(items, f)
    tick(d, invoke=lambda s: {'ok': True})
    out = render(d)
    assert 'outcome=\"ok\"' in out, out
print('OK')" | grep -q '^OK$'; then pass "N-26 ok recorded"; else fail "ok missing"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
