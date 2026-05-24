#!/usr/bin/env bash
# Test: wave 5 batch 2 (N-68..N-75)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# N-68: --history-prune drops old reports
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge/doctor-history"
# Create one fresh and one ancient file.
touch "$tmp/.loki/forge/doctor-history/doctor-fresh.json"
touch -d "60 days ago" "$tmp/.loki/forge/doctor-history/doctor-old.json"
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor --history-prune 30 > /dev/null 2>&1 || true
if [[ -f "$tmp/.loki/forge/doctor-history/doctor-fresh.json" \
   && ! -f "$tmp/.loki/forge/doctor-history/doctor-old.json" ]]; then
    pass "N-68 prune drops old keeps fresh"
else
    fail "prune wrong: $(ls "$tmp/.loki/forge/doctor-history")"
fi
rm -rf "$tmp"

# N-69: schedule with bus_channel routes events to custom channel
if run_py "
import tempfile
from forge.services.schedules import create, pause
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    create(d, name='hourly', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'},
           bus_channel='tenant.acme.schedules')
    pause(d, 'hourly')
    h = history(d, 'tenant.acme.schedules', limit=10)
    assert any(m['payload']['type'] == 'schedule:paused' for m in h), h
    # Default channel should NOT see it
    h2 = history(d, '_system.schedules', limit=10)
    assert not any(m['payload']['type'] == 'schedule:paused' for m in h2), h2
print('OK')" | grep -q '^OK$'; then pass "N-69 custom channel routing"; else fail "routing broken"; fi

# N-70: diff_proposal includes unchanged_tables
if run_py "
import tempfile
from forge.healing import write_proposal, diff_proposal
with tempfile.TemporaryDirectory() as d:
    write_proposal(d, {'operations': [{'add_table': {'name': 'a'}},
                                       {'add_table': {'name': 'b'}}]})
    diff = diff_proposal(d, {'operations': [{'add_table': {'name': 'a'}},
                                             {'add_table': {'name': 'c'}}]})
    assert diff['unchanged_tables'] == ['a'], diff
    assert diff['added_tables'] == ['c']
    assert diff['removed_tables'] == ['b']
print('OK')" | grep -q '^OK$'; then pass "N-70 unchanged_tables"; else fail "no unchanged"; fi

# N-71: channel_count returns size
if run_py "
import tempfile
from forge.services.realtime import channel_count
from forge.services.realtime.bus import publish, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    assert channel_count(d, 'room') == 0
    publish(d, 'room', {'x': 1})
    publish(d, 'room', {'x': 2})
    assert channel_count(d, 'room') == 2
print('OK')" | grep -q '^OK$'; then pass "N-71 channel_count"; else fail "wrong"; fi

# N-72: email template metrics
if run_py "
import tempfile
from forge.services.email import register_template
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'w', subject='hi', body_text='x')
    register_template(d, 'w', subject='hi', body_text='x', locale='fr')
    out = render(d)
    assert 'forge_email_templates_total' in out, out
    assert 'forge_email_template_locales' in out, out
print('OK')" | grep -q '^OK$'; then pass "N-72 email metrics"; else fail "missing"; fi

# N-73: purge_runs removes old run logs
if run_py "
import json, os, tempfile, time
from forge.services.functions import purge_runs
with tempfile.TemporaryDirectory() as d:
    logs = os.path.join(d, 'functions', 'f', 'logs')
    os.makedirs(logs)
    fresh = os.path.join(logs, 'fresh.json')
    old = os.path.join(logs, 'old.json')
    for p in (fresh, old):
        with open(p, 'w') as fp: json.dump({}, fp)
    old_ts = time.time() - 60 * 86400
    os.utime(old, (old_ts, old_ts))
    n = purge_runs(d, 'f', older_than_days=30)
    assert n == 1, n
    assert os.path.isfile(fresh)
    assert not os.path.isfile(old)
print('OK')" | grep -q '^OK$'; then pass "N-73 purge old"; else fail "purge wrong"; fi

# N-74: OpenAPI has top-level servers
if run_py "
import tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    assert isinstance(spec.get('servers'), list)
    assert spec['servers'][0]['url'].startswith('http'), spec['servers']
print('OK')" | grep -q '^OK$'; then pass "N-74 servers entry"; else fail "no servers"; fi

# N-75: --watch with interval < 1 is rejected
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
set +e
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor --watch 0 > "$tmp/out.txt" 2>&1
ec=$?
set -e
if [[ "$ec" == "2" ]] && grep -q "must be >=1s" "$tmp/out.txt"; then
    pass "N-75 watch 0 rejected"
else
    fail "watch 0 accepted (exit $ec)"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
