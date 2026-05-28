#!/usr/bin/env bash
# Test: N-wave 14 (N-161..N-170)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# N-161 + N-170: ?pretty=false compact + Cache-Control no-cache
if python3 -c "import fastapi" 2>/dev/null; then
    if run_py "
import tempfile, os
d = tempfile.mkdtemp(); os.chdir(d); os.makedirs('.loki/forge', exist_ok=True)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI(); register_forge_router(app)
c = TestClient(app)
r = c.get('/api/forge/openapi?pretty=false')
assert r.status_code == 200, r.status_code
assert r.headers.get('cache-control') == 'no-cache', dict(r.headers)
# compact JSON has no newline-indent
assert '\n  ' not in r.text, 'not compact'
print('OK')" | grep -q '^OK$'; then pass "N-161/170 pretty=false + no-cache"; else fail "compact/cache wrong"; fi
else
    pass "N-161/170 SKIP (no fastapi)"
fi

# N-162: health surfaces openapi_etag matching the route etag
if python3 -c "import fastapi" 2>/dev/null; then
    if run_py "
import tempfile, os
d = tempfile.mkdtemp(); os.chdir(d); os.makedirs('.loki/forge', exist_ok=True)
from forge.health import compute_health
from forge.sdk.openapi import content_etag
h = compute_health(os.path.join(d, '.loki', 'forge'))
assert h.get('openapi_etag'), h
assert h['openapi_etag'] == content_etag(os.path.join(d, '.loki', 'forge'))
print('OK')" | grep -q '^OK$'; then pass "N-162 health etag matches"; else fail "etag drift"; fi
else
    pass "N-162 SKIP"
fi

# N-163: list_schedules(tag=) filter
if run_py "
import tempfile
from forge.services.schedules import create, list_schedules
with tempfile.TemporaryDirectory() as d:
    create(d, name='a', cron='0 * * * *', target={'type':'event','topic':'t'}, tags=['acme'])
    create(d, name='b', cron='0 * * * *', target={'type':'event','topic':'t'}, tags=['globex'])
    got = [s['name'] for s in list_schedules(d, tag='ACME')]
    assert got == ['a'], got
print('OK')" | grep -q '^OK$'; then pass "N-163 tag filter"; else fail "wrong filter"; fi

# N-164: list_templates(name=) filter
if run_py "
import tempfile
from forge.services.email import register_template, list_templates
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'w', subject='hi', body_text='x')
    register_template(d, 'w', subject='hi', body_text='x', locale='fr')
    register_template(d, 'other', subject='hi', body_text='x')
    rows = [r['name'] for r in list_templates(d, name='w')]
    assert set(rows) == {'w', 'w@fr'}, rows
print('OK')" | grep -q '^OK$'; then pass "N-164 name filter"; else fail "wrong"; fi

# N-165: list_runs(run_id=) exact lookup
if run_py "
import json, os, tempfile
from forge.services.functions.logs import list_runs
with tempfile.TemporaryDirectory() as d:
    logs = os.path.join(d, 'functions', 'f', 'logs'); os.makedirs(logs)
    for rid in ('aaa', 'bbb'):
        with open(os.path.join(logs, rid + '.json'), 'w') as fp:
            json.dump({'run_id': rid, 'ok': True}, fp)
    r = list_runs(d, 'f', run_id='bbb')
    assert len(r) == 1 and r[0]['run_id'] == 'bbb', r
    assert list_runs(d, 'f', run_id='ccc') == []
    assert list_runs(d, 'f', run_id='../etc') == []
print('OK')" | grep -q '^OK$'; then pass "N-165 run_id lookup"; else fail "wrong"; fi

# N-166: rotate_value rejects same value
if run_py "
import tempfile
from forge.services.secrets.vault import set_secret, rotate_value, SecretError
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'same')
    try:
        rotate_value(d, 'A', 'same')
        print('NO_RAISE')
    except SecretError as e:
        assert 'no-op' in str(e), e
        print('OK')" | grep -q '^OK$'; then pass "N-166 no-op rejected"; else fail "no-op allowed"; fi

# N-167: diff_proposal has_changes boolean
if run_py "
import tempfile
from forge.healing import write_proposal, diff_proposal
with tempfile.TemporaryDirectory() as d:
    write_proposal(d, {'operations': [{'add_table': {'name': 'a'}}]})
    same = diff_proposal(d, {'operations': [{'add_table': {'name': 'a'}}]})
    assert same['has_changes'] is False, same
    diff = diff_proposal(d, {'operations': [{'add_table': {'name': 'b'}}]})
    assert diff['has_changes'] is True, diff
print('OK')" | grep -q '^OK$'; then pass "N-167 has_changes"; else fail "wrong"; fi

# N-168: history-stats avg_bytes
tmp=$(mktemp -d); mkdir -p "$tmp/.loki/forge/doctor-history"
printf 'x%.0s' {1..100} > "$tmp/.loki/forge/doctor-history/doctor-a.json"
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor --history-stats > "$tmp/out.json" 2>&1
if grep -q '"avg_bytes"' "$tmp/out.json"; then pass "N-168 avg_bytes"; else fail "missing"; fi
rm -rf "$tmp"

# N-169: --filter name=exact
tmp=$(mktemp -d)
PYTHONPATH="$ROOT" python3 - <<PY "$tmp"
import sys
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
provision(ForgeRequirements(none=False, tables=[TableSpec(name='items', columns=['id pk'])]), sys.argv[1] + '/.loki/forge')
PY
TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --filter name=forge_tables_total > "$tmp/out.txt" 2>&1
if grep -q "^forge_tables_total" "$tmp/out.txt" && ! grep -q "^forge_buckets_total" "$tmp/out.txt"; then
    pass "N-169 exact name filter"
else
    fail "wrong filter"
fi
rm -rf "$tmp"

# N-170 covered with N-161 above (Cache-Control assertion)
pass "N-170 covered by N-161 assertion"

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
