#!/usr/bin/env bash
# Test: N-wave 8 (N-101..N-110)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# N-101: forge h alias -> help
help=$("$ROOT/bin/loki" forge h 2>&1)
if echo "$help" | grep -q "Subcommands:"; then
    pass "N-101 h alias -> help"
else
    fail "h alias broken"
fi

# N-102: x-generated-at carries .NNNZ ms
if run_py "
import re, tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    ts = spec['info']['x-generated-at']
    assert re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\$', ts), ts
print('OK')" | grep -q '^OK$'; then pass "N-102 ms precision"; else fail "no ms"; fi

# N-103: schedule with tags + metric carries tag label
if run_py "
import tempfile
from forge.services.schedules import create
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    create(d, name='h', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'},
           tags=['tenant:acme', 'env:prod'])
    out = render(d)
    assert 'tag=\"tenant:acme\"' in out, out
print('OK')" | grep -q '^OK$'; then pass "N-103 tag in metric"; else fail "no tag"; fi

# N-104: set_channel_cap with actor persists dict form
if run_py "
import tempfile, json, os
from forge.services.realtime.bus import set_channel_cap
with tempfile.TemporaryDirectory() as d:
    set_channel_cap('r', 42, forge_dir=d, actor='ops_alice')
    p = os.path.join(d, 'realtime', 'ring_caps.json')
    data = json.load(open(p))
    assert isinstance(data['r'], dict), data
    assert data['r']['actor'] == 'ops_alice'
print('OK')" | grep -q '^OK$'; then pass "N-104 actor persisted"; else fail "no actor"; fi

# N-105: list_templates(include_defaults=False) excludes built-ins
if run_py "
import tempfile
from forge.services.email import register_template, list_templates
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'custom', subject='hi', body_text='x')
    all_t = list_templates(d)
    only_overrides = list_templates(d, include_defaults=False)
    assert len(only_overrides) < len(all_t), (only_overrides, all_t)
    names = {t['name'] for t in only_overrides}
    assert 'custom' in names
    assert 'magic_link' not in names  # built-in default
print('OK')" | grep -q '^OK$'; then pass "N-105 excludes defaults"; else fail "still got defaults"; fi

# N-106: purge_runs keep_last_n
if run_py "
import json, os, tempfile, time
from forge.services.functions import purge_runs
with tempfile.TemporaryDirectory() as d:
    logs = os.path.join(d, 'functions', 'f', 'logs')
    os.makedirs(logs)
    for i in range(5):
        p = os.path.join(logs, f'r{i}.json')
        with open(p, 'w') as fp: json.dump({}, fp)
        os.utime(p, (time.time() - (5 - i) * 10, time.time() - (5 - i) * 10))
    n = purge_runs(d, 'f', keep_last_n=2)
    assert n == 3, n
    remaining = sorted(os.listdir(logs))
    assert remaining == ['r3.json', 'r4.json'], remaining
print('OK')" | grep -q '^OK$'; then pass "N-106 keep_last_n"; else fail "wrong keep"; fi

# N-107: weak_secrets(hard=True) raises on weak rows
if run_py "
import json, os, tempfile
from forge.services.secrets.vault import set_secret, weak_secrets, _vault_path, SecretError
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v')
    p = _vault_path(d)
    with open(p) as f: data = json.load(f)
    data['entries']['A']['alg'] = 'HMAC-XOR'
    with open(p, 'w') as f: json.dump(data, f)
    try:
        weak_secrets(d, hard=True)
        print('NO_RAISE')
    except SecretError as e:
        assert 'A' in str(e)
        print('OK')" | grep -q '^OK$'; then pass "N-107 hard raises"; else fail "no raise"; fi

# N-108: apply_proposal envelope includes dry_run_count
if run_py "
import tempfile
from forge.healing import apply_proposal
with tempfile.TemporaryDirectory() as d:
    res = apply_proposal(d, {'operations': [
        {'add_table': {'name': 'u', 'columns': [{'name': 'id', 'type': 'id'}]}}
    ]}, dry_run=True)
    assert res['dry_run_count'] == 1, res
print('OK')" | grep -q '^OK$'; then pass "N-108 dry_run_count"; else fail "missing"; fi

# N-109: doctor --once terminates after one cycle
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
set +e
TARGET_DIR="$tmp" timeout 5 "$ROOT/bin/loki" forge doctor --watch 5 --once > "$tmp/out.txt" 2>&1
ec=$?
set -e
if [[ "$ec" != "124" ]] && grep -q "schema.*loki.forge.doctor" "$tmp/out.txt"; then
    pass "N-109 --once terminates"
else
    fail "didn't stop (exit $ec)"
fi
rm -rf "$tmp"

# N-110: metrics --filter prefix= drops other metrics
tmp=$(mktemp -d)
PYTHONPATH="$ROOT" python3 - <<PY "$tmp"
import sys
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
provision(ForgeRequirements(none=False,
    tables=[TableSpec(name='items', columns=['id pk'])]),
    sys.argv[1] + '/.loki/forge')
PY
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --filter prefix=forge_tables_ > "$tmp/out.txt" 2>&1
if grep -q "^forge_tables_total" "$tmp/out.txt" \
   && ! grep -q "^forge_secrets" "$tmp/out.txt"; then
    pass "N-110 prefix filter"
else
    fail "filter wrong"
fi
rm -rf "$tmp"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
