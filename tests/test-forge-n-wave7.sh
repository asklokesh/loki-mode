#!/usr/bin/env bash
# Test: N-wave 7 (N-91..N-100)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# N-91: `forge m` aliases to metrics
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge m > "$tmp/out.txt" 2>&1 || true
if grep -q '^# HELP' "$tmp/out.txt" || grep -q "forge state directory" "$tmp/out.txt"; then
    pass "N-91 m alias works"
else
    fail "alias broken"
fi
rm -rf "$tmp"

# N-92: OpenAPI info.x-generated-at present
if run_py "
import re, tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    ts = spec['info'].get('x-generated-at')
    assert isinstance(ts, str), spec['info']
    assert re.match(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', ts), ts
print('OK')" | grep -q '^OK$'; then pass "N-92 x-generated-at"; else fail "missing ts"; fi

# N-93: schedules update rejects invalid bus_channel
if run_py "
import tempfile
from forge.services.schedules import create, update, ScheduleError
with tempfile.TemporaryDirectory() as d:
    create(d, name='h', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'})
    try:
        update(d, 'h', bus_channel='Invalid!')
        print('NO_RAISE')
    except ScheduleError as e:
        assert 'bus_channel' in str(e)
        print('OK')" | grep -q '^OK$'; then pass "N-93 update validates"; else fail "update accepted"; fi

# N-94: set_channel_cap with forge_dir persists, load_channel_caps rehydrates
if run_py "
import tempfile
from forge.services.realtime.bus import (
    set_channel_cap, load_channel_caps, _RING,
)
with tempfile.TemporaryDirectory() as d:
    set_channel_cap('room', 42, forge_dir=d)
    _RING.clear()
    caps = load_channel_caps(d)
    assert caps.get('room') == 42, caps
print('OK')" | grep -q '^OK$'; then pass "N-94 caps persisted"; else fail "no persist"; fi

# N-95: email locales bucket gauges
if run_py "
import tempfile
from forge.services.email import register_template
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'w', subject='hi', body_text='x')
    register_template(d, 'w', subject='hi', body_text='x', locale='fr')
    out = render(d)
    assert 'forge_email_locales_bucket' in out, out
    assert 'bucket=\"2-5\"' in out, out
print('OK')" | grep -q '^OK$'; then pass "N-95 bucket emitted"; else fail "no bucket"; fi

# N-96: list_runs since_ts filters
if run_py "
import json, os, tempfile
from forge.services.functions.logs import list_runs
with tempfile.TemporaryDirectory() as d:
    logs = os.path.join(d, 'functions', 'f', 'logs')
    os.makedirs(logs)
    for i, ts in enumerate(['2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z']):
        with open(os.path.join(logs, f'r{i}.json'), 'w') as fp:
            json.dump({'run_id': f'r{i}', 'started_at': ts, 'ok': True}, fp)
    import time
    cutoff = int(time.mktime(time.strptime('2026-03-01T00:00:00Z', '%Y-%m-%dT%H:%M:%SZ')))
    r = list_runs(d, 'f', since_ts=cutoff)
    assert len(r) == 1, r
    assert r[0]['run_id'] == 'r1'
print('OK')" | grep -q '^OK$'; then pass "N-96 since_ts filter"; else fail "no filter"; fi

# N-97: weak_secrets filtered by unused_for_days
if run_py "
import json, os, tempfile, time
from forge.services.secrets.vault import set_secret, weak_secrets, _vault_path
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v'); set_secret(d, 'B', 'v')
    p = _vault_path(d)
    with open(p) as f: data = json.load(f)
    data['entries']['A']['alg'] = 'HMAC-XOR'
    data['entries']['A']['created_at'] = int(time.time()) - 100 * 86400
    data['entries']['B']['alg'] = 'HMAC-XOR'
    with open(p, 'w') as f: json.dump(data, f)
    rows = weak_secrets(d, unused_for_days=90)
    assert len(rows) == 1, rows
    assert rows[0]['name'] == 'A'
print('OK')" | grep -q '^OK$'; then pass "N-97 weak+stale filter"; else fail "wrong subset"; fi

# N-98: metrics --label rejects invalid keys
tmp=$(mktemp -d)
set +e
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --label 'bad-key=v' > "$tmp/out.txt" 2>&1
ec=$?
set -e
if [[ "$ec" == "2" ]] && grep -q "invalid label key" "$tmp/out.txt"; then
    pass "N-98 bad label rejected"
else
    fail "bad label accepted (exit $ec)"
fi
rm -rf "$tmp"

# N-99: apply_proposal dry_run reports without writing
if run_py "
import tempfile
from forge.healing import apply_proposal
from forge.services.database import open_engine, introspect
with tempfile.TemporaryDirectory() as d:
    res = apply_proposal(d, {'operations': [
        {'add_table': {'name': 'u', 'columns': [{'name': 'id', 'type': 'id'}]}}
    ]}, dry_run=True)
    assert all(op.get('dry_run') for op in res['ops']), res
    snap = introspect(open_engine(d))
    table_names = [t['name'] for t in snap.get('tables', [])
                   if not t['name'].startswith('_')]
    assert 'u' not in table_names, table_names
print('OK')" | grep -q '^OK$'; then pass "N-99 dry_run no-write"; else fail "wrote"; fi

# N-100: doctor --watch --max-iterations terminates
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
set +e
TARGET_DIR="$tmp" timeout 8 "$ROOT/bin/loki" forge doctor --watch 1 --max-iterations 2 > "$tmp/out.txt" 2>&1
ec=$?
set -e
if [[ "$ec" != "124" ]]; then
    pass "N-100 max-iterations terminates"
else
    fail "watch never stopped"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
