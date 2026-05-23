#!/usr/bin/env bash
# Test: X-55..X-60 wave.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# X-58 validate ---

# 1. validate accepts well-formed config
if run_py "
from forge.config import validate
r = validate({'schema_version': 1, 'tables': [{'name':'users','columns':['id pk']}]})
assert r['errors'] == [], r
print('OK')" | grep -q '^OK$'; then pass "X-58 validate accepts good config"; else fail "good config rejected"; fi

# 2. validate rejects table without name
if run_py "
from forge.config import validate
r = validate({'tables': [{'columns':['id pk']}]})
assert any('name' in e for e in r['errors']), r
print('OK')" | grep -q '^OK$'; then pass "X-58 missing name caught"; else fail "missing name not caught"; fi

# 3. validate warns on unknown key
if run_py "
from forge.config import validate
r = validate({'extra_key': 'x'})
assert any('unknown top-level' in w for w in r['warnings']), r
print('OK')" | grep -q '^OK$'; then pass "X-58 unknown key warning"; else fail "unknown key missed"; fi

# 4. validate rejects schedule missing fields
if run_py "
from forge.config import validate
r = validate({'schedules': [{'name': 'x'}]})
assert any('schedules' in e for e in r['errors']), r
print('OK')" | grep -q '^OK$'; then pass "X-58 schedule missing target"; else fail "schedule missed"; fi

# X-60 audit columns ---

# 5. audit_columns adds created_by/updated_by/version
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply, introspect
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{
        'name':'posts','columns':['id pk','title text'],
        'audit_columns': True}}]})
    snap = introspect(e)
    cols = [c['name'] for c in snap['tables'][0]['columns']]
    for x in ('created_by','updated_by','version'):
        assert x in cols, (x, cols)
print('OK')" | grep -q '^OK$'; then pass "X-60 audit_columns injects 3 cols"; else fail "audit_columns broken"; fi

# 6. audit_columns + soft_delete coexist
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply, introspect
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{
        'name':'posts','columns':['id pk'],
        'soft_delete': True, 'audit_columns': True}}]})
    cols = [c['name'] for c in introspect(e)['tables'][0]['columns']]
    for x in ('deleted_at','created_by','updated_by','version'):
        assert x in cols
print('OK')" | grep -q '^OK$'; then pass "X-60 audit + soft_delete"; else fail "combined broken"; fi

# X-59 email i18n ---

# 7. register_template with locale stores compound key
if run_py "
import tempfile
from forge.services.email import register_template, list_templates
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'welcome', subject='Bienvenue', body_text='Salut!', locale='fr')
    names = [t['name'] for t in list_templates(d)]
    assert 'welcome@fr' in names, names
print('OK')" | grep -q '^OK$'; then pass "X-59 locale stored under compound key"; else fail "locale key missing"; fi

# 8. send_template resolves locale fallback
if run_py "
import tempfile
from forge.services.email import setup_provider, register_template, send_template, list_sent
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'resend', api_key_ref='K', from_address='a@b.com')
    register_template(d, 'welcome', subject='Bonjour', body_text='Salut',
                       locale='fr')
    send_template(d, 'resend', template='welcome', to='u@x.com',
                  locale='fr-CA')  # exact miss; 'fr' lang fallback
    sent = list_sent(d, 'resend')[-1]
    assert 'Bonjour' in sent['subject']
print('OK')" | grep -q '^OK$'; then pass "X-59 locale lang fallback"; else fail "lang fallback broken"; fi

# 9. send_template falls back to default when no locale match
if run_py "
import tempfile
from forge.services.email import setup_provider, send_template, list_sent
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'resend', api_key_ref='K', from_address='a@b.com')
    send_template(d, 'resend', template='welcome', to='u@x.com',
                  context={'product_name':'Forge','user_name':'A','dashboard_url':'/'},
                  locale='ja')
    sent = list_sent(d, 'resend')[-1]
    # default 'welcome' subject is 'Welcome to {product_name}'
    assert 'Forge' in sent['subject']
print('OK')" | grep -q '^OK$'; then pass "X-59 default fallback"; else fail "default fallback broken"; fi

# X-57 job queue ---

# 10. enqueue + tick processes job
if run_py "
import tempfile
from forge.services.functions import job_enqueue, list_jobs, job_tick
with tempfile.TemporaryDirectory() as d:
    job_enqueue(d, function='send_email', payload={'to': 'x@y'})
    def fake_invoke(fd, name, payload=None): return {'ok': True}
    touched = job_tick(d, invoke=fake_invoke)
    assert touched and touched[0]['status'] == 'completed'
print('OK')" | grep -q '^OK$'; then pass "X-57 enqueue + tick completes"; else fail "job tick broken"; fi

# 11. job retries on failure + dead-letters
if run_py "
import tempfile
from forge.services.functions import job_enqueue, list_jobs, job_tick
with tempfile.TemporaryDirectory() as d:
    job_enqueue(d, function='retry_me', max_attempts=3)
    def fake(*a, **k): return {'ok': False, 'stderr': 'broken'}
    for _ in range(3): job_tick(d, invoke=fake)
    dead = list_jobs(d, status='dead')
    assert len(dead) == 1, dead
print('OK')" | grep -q '^OK$'; then pass "X-57 retries + dead-letter"; else fail "retry/DLQ broken"; fi

# 12. not_before_ts respected
if run_py "
import tempfile, time
from forge.services.functions import job_enqueue, job_tick
with tempfile.TemporaryDirectory() as d:
    job_enqueue(d, function='delayed', not_before_ts=int(time.time()) + 3600)
    touched = job_tick(d, invoke=lambda *a, **k: {'ok': True})
    assert touched == [], touched
print('OK')" | grep -q '^OK$'; then pass "X-57 not_before_ts honored"; else fail "scheduling delay broken"; fi

# X-55 forge_db_query_page tool ---

# 13. forge_db_query_page declared
if grep -q 'async def forge_db_query_page' "$ROOT/mcp/forge_tools.py"; then
    pass "X-55 MCP forge_db_query_page declared"
else
    fail "forge_db_query_page missing"
fi

# X-56 analytics endpoint ---

# 14. /api/forge/analytics declared
if grep -q '"/api/forge/analytics"' "$ROOT/dashboard/forge_router.py"; then
    pass "X-56 /api/forge/analytics declared"
else
    fail "analytics endpoint missing"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
