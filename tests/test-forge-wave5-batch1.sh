#!/usr/bin/env bash
# Test: wave 5 batch 1 (N-61..N-67)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# N-61: metrics --json emits prev_timestamp on the second call
tmp=$(mktemp -d)
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --json > "$tmp/a.json" 2>&1
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --json > "$tmp/b.json" 2>&1
if PYTHONPATH="$ROOT" python3 -c "
import json
a = json.load(open('$tmp/a.json'))
b = json.load(open('$tmp/b.json'))
assert a['prev_timestamp'] is None, a
assert isinstance(b['prev_timestamp'], int)
assert b['prev_timestamp'] == a['timestamp'], (a, b)
print('OK')" | grep -q '^OK$'; then pass "N-61 prev_timestamp threads"; else fail "no prev"; fi
rm -rf "$tmp"

# N-62: forge audit --scope chain skips reviews
tmp=$(mktemp -d)
rev="$tmp/.loki/quality/forge-migrations"
mkdir -p "$rev"
echo '{"migration_id":"m","spec_hash":"x"}' > "$rev/m.json"
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit --scope chain > "$tmp/out.json" 2>&1 || true
if grep -q '"checked_reviews": 0' "$tmp/out.json"; then
    pass "N-62 --scope chain"
else
    fail "scope chain didn't skip"
fi
rm -rf "$tmp"

# N-63: secrets stale buckets emit
if run_py "
import json, os, tempfile, time
from forge.services.secrets.vault import set_secret, _vault_path
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v')
    p = _vault_path(d)
    with open(p) as f: data = json.load(f)
    data['entries']['A']['created_at'] = int(time.time()) - 100 * 86400
    with open(p, 'w') as f: json.dump(data, f)
    out = render(d)
    assert 'bucket=\"30d\"' in out, out
    assert 'bucket=\"90d\"' in out, out
print('OK')" | grep -q '^OK$'; then pass "N-63 stale buckets"; else fail "no stale"; fi

# N-64: list_functions exposes last_deployed_by_user_id
if run_py "
import tempfile
from forge.services.functions import deploy, list_functions
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index',
           deployed_by_user_id='u_alice')
    m = list_functions(d)[0]
    assert m['last_deployed_by_user_id'] == 'u_alice', m
    assert 'last_deployed_at' in m
print('OK')" | grep -q '^OK$'; then pass "N-64 attribution at top"; else fail "missing"; fi

# N-65: gc_presence_with_count returns dict
if run_py "
import tempfile
from forge.services.realtime import (
    set_presence, gc_presence_with_count,
)
from forge.services.realtime import presence as p
with tempfile.TemporaryDirectory() as d:
    set_presence('room', 'u1', forge_dir=d)
    set_presence('room', 'u2', forge_dir=d)
    with p._LOCK:
        p._STATE['room']['u1']['last_seen'] = 0
    r = gc_presence_with_count('room', forge_dir=d)
    assert r['evicted'] == ['u1'], r
    assert r['remaining'] == 1, r
print('OK')" | grep -q '^OK$'; then pass "N-65 gc_with_count dict"; else fail "shape wrong"; fi

# N-66: OpenAPI ops have tags + spec has tag manifest
if run_py "
import tempfile
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    req = ForgeRequirements(none=False,
        tables=[TableSpec(name='items', columns=['id pk'])])
    provision(req, d)
    spec = generate(d)
    assert spec.get('tags'), spec
    op = spec['paths']['/db/v1/items']['get']
    assert 'db' in op.get('tags', []), op
print('OK')" | grep -q '^OK$'; then pass "N-66 tags present"; else fail "no tags"; fi

# N-67: unrevoke_preset removes audit lines
if run_py "
import tempfile
from forge.services.storage import (
    register_transform_preset, revoke_transform_preset,
    unrevoke_preset, list_revoked_presets,
)
with tempfile.TemporaryDirectory() as d:
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 50, 'h': 50}}]})
    revoke_transform_preset(d, 'images', 'thumb')
    assert unrevoke_preset(d, 'images', 'thumb') is True
    trail = list_revoked_presets(d, 'images')
    assert not any(r['name'] == 'thumb' for r in trail), trail
    # Re-register without force should now succeed
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 99, 'h': 99}}]})
print('OK')" | grep -q '^OK$'; then pass "N-67 unrevoke clears block"; else fail "unrevoke broken"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
