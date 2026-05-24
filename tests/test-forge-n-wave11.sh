#!/usr/bin/env bash
# Test: N-wave 11 (N-131..N-140)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# N-131: openapi_cached_until present
if run_py "
import tempfile
from forge.health import compute_health
with tempfile.TemporaryDirectory() as d:
    h = compute_health(d)
    assert 'openapi_cached_until' in h, h
print('OK')" | grep -q '^OK$'; then pass "N-131 cached_until field"; else fail "missing"; fi

# N-132: tag case normalized
if run_py "
import tempfile
from forge.services.schedules import create, get
with tempfile.TemporaryDirectory() as d:
    create(d, name='h', cron='0 * * * *',
           target={'type': 'event', 'topic': 'noop'},
           tags=['Acme'])
    s = get(d, 'h')
    assert s['tags'] == ['acme'], s
print('OK')" | grep -q '^OK$'; then pass "N-132 lowered"; else fail "case kept"; fi

# N-133: force-drop default writes dropped_defaults.jsonl
if run_py "
import json, os, tempfile
from forge.services.email import unset_template
from forge.services.email.templates import DEFAULT_TEMPLATES
name = next(iter(DEFAULT_TEMPLATES))
with tempfile.TemporaryDirectory() as d:
    unset_template(d, name, force=True)
    audit = os.path.join(d, 'email', 'dropped_defaults.jsonl')
    assert os.path.isfile(audit), os.listdir(d)
    rec = json.loads(open(audit).readline())
    assert rec['name'] == name and rec['forced'] is True
print('OK')" | grep -q '^OK$'; then pass "N-133 audit trail"; else fail "no audit"; fi

# N-134: purges.jsonl caps at 1000
if run_py "
import json, os, tempfile, time
from forge.services.functions import purge_runs
from forge.services.functions.logs import _record_purge
with tempfile.TemporaryDirectory() as d:
    logs = os.path.join(d, 'functions', 'f', 'logs')
    os.makedirs(logs)
    for i in range(1100):
        _record_purge(d, 'f', 'keep_last_n', i, 0)
    p = os.path.join(logs, 'purges.jsonl')
    with open(p) as fp:
        lines = fp.readlines()
    assert len(lines) == 1000, len(lines)
print('OK')" | grep -q '^OK$'; then pass "N-134 purges cap"; else fail "uncapped"; fi

# N-135: list_rotations since_ts filter
if run_py "
import tempfile, time
from forge.services.secrets.vault import set_secret, rotate_value, list_rotations
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v')
    rotate_value(d, 'A', 'v2')
    cutoff = int(time.time()) + 60
    assert list_rotations(d, since_ts=cutoff) == []
    assert len(list_rotations(d, since_ts=0)) >= 1
print('OK')" | grep -q '^OK$'; then pass "N-135 since_ts"; else fail "filter wrong"; fi

# N-136: total_attempt_ms on v2 envelope
if run_py "
import tempfile
from forge.healing import apply_proposal
with tempfile.TemporaryDirectory() as d:
    res = apply_proposal(d, {'operations': [
        {'add_table': {'name': 'u', 'columns': [{'name': 'id', 'type': 'id'}]}},
        {'add_table': {'name': 'o', 'columns': [{'name': 'id', 'type': 'id'}]}},
    ]})
    assert isinstance(res['total_attempt_ms'], int), res
print('OK')" | grep -q '^OK$'; then pass "N-136 total_attempt_ms"; else fail "missing"; fi

# N-137: --history-list --json
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge/doctor-history"
touch "$tmp/.loki/forge/doctor-history/doctor-a.json"
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor --history-list --json > "$tmp/out.json" 2>&1
if grep -q '"schema": "loki.forge.doctor.history' "$tmp/out.json"; then
    pass "N-137 history --json"
else
    fail "wrong json"
fi
rm -rf "$tmp"

# N-138: --filter prefix accepts comma list
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
    --filter prefix=forge_tables,forge_buckets > "$tmp/out.txt" 2>&1
if grep -q "forge_tables_total" "$tmp/out.txt" \
   && grep -q "forge_buckets_total" "$tmp/out.txt" \
   && ! grep -q "forge_secrets_" "$tmp/out.txt"; then
    pass "N-138 comma prefix"
else
    fail "wrong filter"
fi
rm -rf "$tmp"

# N-139: audit --summary includes scope
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit --summary --scope all > "$tmp/out.txt" 2>&1 || true
if grep -q "scope=all" "$tmp/out.txt"; then
    pass "N-139 scope in summary"
else
    fail "no scope: $(cat "$tmp/out.txt")"
fi
rm -rf "$tmp"

# N-140: x-generated-at-epoch-ms emitted
if run_py "
import tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    ms = spec['info'].get('x-generated-at-epoch-ms')
    assert isinstance(ms, int) and ms > 1700000000000, ms
print('OK')" | grep -q '^OK$'; then pass "N-140 epoch ms"; else fail "missing"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
