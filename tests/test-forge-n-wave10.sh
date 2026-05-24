#!/usr/bin/env bash
# Test: N-wave 10 (N-121..N-130)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# N-121: prefix AND exclude compose
tmp=$(mktemp -d)
PYTHONPATH="$ROOT" python3 - <<PY "$tmp"
import sys
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
provision(ForgeRequirements(none=False,
    tables=[TableSpec(name='items', columns=['id pk'])]),
    sys.argv[1] + '/.loki/forge')
PY
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics \
    --filter prefix=forge_ --filter exclude=forge_secrets_ > "$tmp/out.txt" 2>&1
if grep -q "^forge_tables_total" "$tmp/out.txt" \
   && ! grep -q "^forge_secrets" "$tmp/out.txt"; then
    pass "N-121 filters compose"
else
    fail "compose wrong"
fi
rm -rf "$tmp"

# N-122: openapi_generated_at caches (two compute_health calls return
# the same value)
if run_py "
import tempfile
from forge.health import compute_health
with tempfile.TemporaryDirectory() as d:
    a = compute_health(d)['openapi_generated_at']
    b = compute_health(d)['openapi_generated_at']
    assert a == b, (a, b)
print('OK')" | grep -q '^OK$'; then pass "N-122 ts cached"; else fail "ts drifted"; fi

# N-123: single tag routes to per-tag channel
if run_py "
import tempfile
from forge.services.schedules import create, pause
from forge.services.realtime.bus import history, reset
with tempfile.TemporaryDirectory() as d:
    reset()
    create(d, name='h', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'},
           tags=['acme'])
    pause(d, 'h')
    h = history(d, '_system.schedules.acme', limit=10)
    assert any(m['payload']['type'] == 'schedule:paused' for m in h), h
print('OK')" | grep -q '^OK$'; then pass "N-123 per-tag channel"; else fail "no routing"; fi

# N-124: is_default helper
if run_py "
from forge.services.email import is_default
from forge.services.email.templates import DEFAULT_TEMPLATES
name = next(iter(DEFAULT_TEMPLATES))
assert is_default(name) is True
assert is_default('custom_unknown') is False
print('OK')" | grep -q '^OK$'; then pass "N-124 is_default"; else fail "wrong"; fi

# N-125: purge_runs records purges.jsonl
if run_py "
import json, os, tempfile, time
from forge.services.functions import purge_runs
with tempfile.TemporaryDirectory() as d:
    logs = os.path.join(d, 'functions', 'f', 'logs')
    os.makedirs(logs)
    for i in range(3):
        p = os.path.join(logs, f'r{i}.json')
        with open(p, 'w') as fp: json.dump({}, fp)
    purge_runs(d, 'f', keep_last_n=1)
    p = os.path.join(logs, 'purges.jsonl')
    assert os.path.isfile(p)
    rec = json.loads(open(p).readline())
    assert rec['mode'] == 'keep_last_n', rec
    assert rec['removed'] == 2, rec
print('OK')" | grep -q '^OK$'; then pass "N-125 purge audit"; else fail "no purges.jsonl"; fi

# N-126: list_rotations(name=...) filters
if run_py "
import tempfile
from forge.services.secrets.vault import set_secret, rotate_value, list_rotations
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v'); set_secret(d, 'B', 'v')
    rotate_value(d, 'A', 'v2')
    rotate_value(d, 'B', 'v2')
    rotate_value(d, 'A', 'v3')
    only_a = list_rotations(d, name='A')
    assert len(only_a) == 2, only_a
    assert all(r['name'] == 'A' for r in only_a)
print('OK')" | grep -q '^OK$'; then pass "N-126 rotations filter"; else fail "no filter"; fi

# N-127: applied/v2 ops include attempt_ms
if run_py "
import tempfile
from forge.healing import apply_proposal
with tempfile.TemporaryDirectory() as d:
    res = apply_proposal(d, {'operations': [
        {'add_table': {'name': 'u', 'columns': [{'name': 'id', 'type': 'id'}]}}
    ]})
    assert isinstance(res['ops'][0].get('attempt_ms'), int), res
print('OK')" | grep -q '^OK$'; then pass "N-127 attempt_ms"; else fail "missing"; fi

# N-128: --history-list lists files
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge/doctor-history"
touch "$tmp/.loki/forge/doctor-history/doctor-a.json"
touch "$tmp/.loki/forge/doctor-history/doctor-b.json"
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor --history-list > "$tmp/out.txt" 2>&1
if grep -q "doctor-a.json" "$tmp/out.txt" && grep -q "doctor-b.json" "$tmp/out.txt"; then
    pass "N-128 --history-list"
else
    fail "no listing: $(cat "$tmp/out.txt")"
fi
rm -rf "$tmp"

# N-129: --no-help drops HELP/TYPE lines
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --no-help > "$tmp/out.txt" 2>&1
if ! grep -q "^# HELP" "$tmp/out.txt" && ! grep -q "^# TYPE" "$tmp/out.txt"; then
    pass "N-129 no-help drops"
else
    fail "still emits"
fi
rm -rf "$tmp"

# N-130: --json accepted (no-op) and produces JSON
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit --json > "$tmp/out.json" 2>&1 || true
if grep -q '"warnings"' "$tmp/out.json" || grep -q '"ok"' "$tmp/out.json"; then
    pass "N-130 --json accepted"
else
    fail "json broke"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
