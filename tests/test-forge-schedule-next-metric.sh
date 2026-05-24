#!/usr/bin/env bash
# Test: N-44 metrics surface next_fire_ts per schedule.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

if run_py "
import tempfile
from forge.services.schedules import create
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    create(d, name='hourly', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'})
    out = render(d)
    assert 'forge_schedule_next_fire_ts' in out, out
    assert 'name=\"hourly\"' in out
    # Value is a non-negative integer
    line = [l for l in out.splitlines()
            if 'forge_schedule_next_fire_ts{' in l][0]
    val = int(line.split()[-1])
    assert val >= 0
print('OK')" | grep -q '^OK$'; then pass "N-44 next_fire_ts emitted"; else fail "missing"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
