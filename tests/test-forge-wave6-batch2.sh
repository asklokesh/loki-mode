#!/usr/bin/env bash
# Test: wave 6 batch 2 (N-83..N-90)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# N-83: --watch watermark refuses a second --watch
tmp=$(mktemp -d)
mkdir -p "$tmp/.loki/forge"
# Simulate the first watch by writing a watermark with a live pid (our own
# shell). The second --watch must refuse because that pid is alive.
echo $$ > "$tmp/.loki/forge/.doctor-watch.pid"
set +e
TARGET_DIR="$tmp" timeout 3 "$ROOT/bin/loki" forge doctor --watch 1 > "$tmp/w2.txt" 2>&1
ec=$?
set -e
if [[ "$ec" == "2" ]] && grep -q "already running" "$tmp/w2.txt"; then
    pass "N-83 second watch refused"
else
    fail "second watch accepted (exit $ec): $(head -3 "$tmp/w2.txt")"
fi
rm -rf "$tmp"

# N-84: rotate_value records rotated_by_user_id
if run_py "
import json, os, tempfile
from forge.services.secrets.vault import set_secret, rotate_value
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v1')
    rotate_value(d, 'A', 'v2', rotated_by_user_id='u_alice')
    p = os.path.join(d, 'secrets', 'rotations.jsonl')
    with open(p) as f:
        line = f.readline().strip()
    rec = json.loads(line)
    assert rec['rotated_by_user_id'] == 'u_alice', rec
print('OK')" | grep -q '^OK$'; then pass "N-84 rotated_by recorded"; else fail "no actor"; fi

# N-85: set_channel_cap limits the ring
if run_py "
import tempfile
from forge.services.realtime.bus import (
    set_channel_cap, publish, history, reset,
)
with tempfile.TemporaryDirectory() as d:
    reset()
    set_channel_cap('room', 3)
    for i in range(10):
        publish(d, 'room', {'i': i})
    h = history(d, 'room', limit=100)
    assert len(h) == 3, len(h)
    # Last 3 messages survive
    assert [m['payload']['i'] for m in h] == [7, 8, 9]
print('OK')" | grep -q '^OK$'; then pass "N-85 cap enforced"; else fail "cap ignored"; fi

# N-86: --scope comma list accepted as 'all'
tmp=$(mktemp -d)
rev="$tmp/.loki/quality/forge-migrations"
mkdir -p "$rev"
echo '{"migration_id":"m","spec_hash":"x"}' > "$rev/m.json"
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge audit --scope chain,migrations > "$tmp/out.json" 2>&1 || true
if grep -q '"checked_reviews": 1' "$tmp/out.json"; then
    pass "N-86 comma scope = all"
else
    fail "comma scope wrong"
fi
rm -rf "$tmp"

# N-87: unrevoke_preset returns int count
if run_py "
import tempfile
from forge.services.storage import (
    register_transform_preset, revoke_transform_preset,
    unrevoke_preset,
)
with tempfile.TemporaryDirectory() as d:
    register_transform_preset(d, 'images',
        {'name': 'thumb', 'ops': [{'resize': {'w': 50, 'h': 50}}]})
    revoke_transform_preset(d, 'images', 'thumb')
    n = unrevoke_preset(d, 'images', 'thumb')
    assert isinstance(n, int) and n == 1, n
    # Re-call returns 0 (nothing left to remove)
    assert unrevoke_preset(d, 'images', 'thumb') == 0
print('OK')" | grep -q '^OK$'; then pass "N-87 returns count"; else fail "wrong return"; fi

# N-88: apply_proposal emits v2 schema with ops[]
if run_py "
import tempfile
from forge.healing import apply_proposal
with tempfile.TemporaryDirectory() as d:
    res = apply_proposal(d, {'operations': [
        {'add_table': {'name': 'u',
            'columns': [{'name': 'id', 'type': 'id'}]}}
    ]})
    assert res['schema'] == 'loki.forge.healing.applied/v2', res
    assert isinstance(res.get('ops'), list)
    assert res['ops'][0]['target'] == 'u'
    assert res['ops'][0]['ok'] in (True, False)
print('OK')" | grep -q '^OK$'; then pass "N-88 v2 envelope"; else fail "no v2"; fi

# N-89: per-tag externalDocs
if run_py "
import tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    for tag in spec['tags']:
        assert 'externalDocs' in tag, tag
        assert tag['externalDocs']['url'].startswith('http')
print('OK')" | grep -q '^OK$'; then pass "N-89 externalDocs"; else fail "no externalDocs"; fi

# N-90: help block lists every subcommand
help=$("$ROOT/bin/loki" forge --help 2>&1 || true)
missing=""
for cmd in status metrics doctor backup restore promote audit bootstrap lint; do
    if ! echo "$help" | grep -qE "^  $cmd"; then
        missing="$missing $cmd"
    fi
done
if [[ -z "$missing" ]]; then
    pass "N-90 help lists all subcommands"
else
    fail "missing in help:$missing"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
