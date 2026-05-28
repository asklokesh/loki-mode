#!/usr/bin/env bash
# Test: N-wave 15 (N-171..N-180)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }
HAVE_FASTAPI=$(python3 -c "import fastapi" 2>/dev/null && echo yes || echo no)

# N-171: compact and pretty share the same ETag
if [[ "$HAVE_FASTAPI" == "yes" ]]; then
    if run_py "
import tempfile, os
d = tempfile.mkdtemp(); os.chdir(d); os.makedirs('.loki/forge', exist_ok=True)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI(); register_forge_router(app)
c = TestClient(app)
a = c.get('/api/forge/openapi').headers['etag']
b = c.get('/api/forge/openapi?pretty=false').headers['etag']
assert a == b, (a, b)
print('OK')" | grep -q '^OK$'; then pass "N-171 etag stable across pretty"; else fail "etag differs"; fi
else pass "N-171 SKIP"; fi

# N-172: health etag served from cache (two calls same value)
if run_py "
import tempfile, os
d = tempfile.mkdtemp()
fd = os.path.join(d, '.loki', 'forge'); os.makedirs(fd, exist_ok=True)
from forge.health import compute_health
a = compute_health(fd)['openapi_etag']
b = compute_health(fd)['openapi_etag']
assert a == b and a, (a, b)
print('OK')" | grep -q '^OK$'; then pass "N-172 etag cached"; else fail "drift"; fi

# N-173: list_schedules(tag=[...]) OR match
if run_py "
import tempfile
from forge.services.schedules import create, list_schedules
with tempfile.TemporaryDirectory() as d:
    create(d, name='a', cron='0 * * * *', target={'type':'event','topic':'t'}, tags=['acme'])
    create(d, name='b', cron='0 * * * *', target={'type':'event','topic':'t'}, tags=['globex'])
    create(d, name='c', cron='0 * * * *', target={'type':'event','topic':'t'}, tags=['other'])
    got = sorted(s['name'] for s in list_schedules(d, tag=['acme', 'globex']))
    assert got == ['a', 'b'], got
print('OK')" | grep -q '^OK$'; then pass "N-173 tag list OR"; else fail "wrong"; fi

# N-174: list_templates(name=, include_defaults=False) composes
if run_py "
import tempfile
from forge.services.email import register_template, list_templates
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'w', subject='hi', body_text='x')
    register_template(d, 'w', subject='hi', body_text='x', locale='fr')
    rows = [r['name'] for r in list_templates(d, name='w', include_defaults=False)]
    assert set(rows) == {'w', 'w@fr'}, rows
    # magic_link is a built-in default -> excluded
    none = list_templates(d, name='magic_link', include_defaults=False)
    assert none == [], none
print('OK')" | grep -q '^OK$'; then pass "N-174 name + overrides"; else fail "wrong"; fi

# N-175: read_run_log rejects traversal
if run_py "
import json, os, tempfile
from forge.services.functions.logs import read_run_log
with tempfile.TemporaryDirectory() as d:
    logs = os.path.join(d, 'functions', 'f', 'logs'); os.makedirs(logs)
    with open(os.path.join(logs, 'good.json'), 'w') as fp:
        json.dump({'run_id': 'good'}, fp)
    assert read_run_log(d, 'f', 'good')['run_id'] == 'good'
    assert read_run_log(d, 'f', '../../etc/passwd') is None
    assert read_run_log(d, 'f', '') is None
print('OK')" | grep -q '^OK$'; then pass "N-175 traversal guard"; else fail "leak"; fi

# N-176: rotate_value allow_noop returns skipped
if run_py "
import tempfile
from forge.services.secrets.vault import set_secret, rotate_value
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'same')
    r = rotate_value(d, 'A', 'same', allow_noop=True)
    assert r['skipped'] is True and r['rotated'] is False, r
print('OK')" | grep -q '^OK$'; then pass "N-176 allow_noop skip"; else fail "wrong"; fi

# N-177: diff_proposal change_count
if run_py "
import tempfile
from forge.healing import write_proposal, diff_proposal
with tempfile.TemporaryDirectory() as d:
    write_proposal(d, {'operations': [{'add_table': {'name': 'a'}}]})
    diff = diff_proposal(d, {'operations': [{'add_table': {'name': 'b'}}]})
    # added=['b'], removed=['a'] -> 2
    assert diff['change_count'] == 2, diff
print('OK')" | grep -q '^OK$'; then pass "N-177 change_count"; else fail "wrong"; fi

# N-178: history-stats --human one-line
tmp=$(mktemp -d); mkdir -p "$tmp/.loki/forge/doctor-history"
printf 'x%.0s' {1..50} > "$tmp/.loki/forge/doctor-history/doctor-a.json"
out=$(TARGET_DIR="$tmp" "$ROOT/bin/loki" forge doctor --history-stats --human 2>&1)
if echo "$out" | grep -qE '^count=1 total_bytes=[0-9]+ avg_bytes=[0-9]+$'; then
    pass "N-178 human one-line"
else
    fail "wrong: $out"
fi
rm -rf "$tmp"

# N-179: --filter name=a,b OR exact match
tmp=$(mktemp -d)
PYTHONPATH="$ROOT" python3 - <<PY "$tmp"
import sys
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
provision(ForgeRequirements(none=False, tables=[TableSpec(name='items', columns=['id pk'])]), sys.argv[1] + '/.loki/forge')
PY
out=$(TARGET_DIR="$tmp" "$ROOT/bin/loki" forge metrics --filter name=forge_tables_total,forge_buckets_total 2>&1)
if echo "$out" | grep -q "^forge_tables_total" && echo "$out" | grep -q "^forge_buckets_total" && ! echo "$out" | grep -q "^forge_functions_total"; then
    pass "N-179 name comma OR"
else
    fail "wrong filter"
fi
rm -rf "$tmp"

# N-180: HEAD /api/forge/openapi returns ETag, no body
if [[ "$HAVE_FASTAPI" == "yes" ]]; then
    if run_py "
import tempfile, os
d = tempfile.mkdtemp(); os.chdir(d); os.makedirs('.loki/forge', exist_ok=True)
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI(); register_forge_router(app)
c = TestClient(app)
r = c.head('/api/forge/openapi')
assert r.status_code == 200, r.status_code
assert r.headers.get('etag'), dict(r.headers)
assert r.text == '', repr(r.text)
print('OK')" | grep -q '^OK$'; then pass "N-180 HEAD etag no body"; else fail "wrong"; fi
else pass "N-180 SKIP"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
