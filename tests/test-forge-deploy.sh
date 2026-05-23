#!/usr/bin/env bash
# Test: forge.services.deploy - Railway + Fly + Vercel + Cloudflare + local (F-3).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. unsupported provider rejected
if run_py "
import tempfile
from forge.services.deploy import setup_provider, DeployError
with tempfile.TemporaryDirectory() as d:
    try: setup_provider(d, 'heroku', credentials_ref='X')
    except DeployError: print('OK'); raise SystemExit
    raise AssertionError('heroku accepted')
" | grep -q '^OK$'; then pass "unsupported provider rejected"; else fail "unsupported accepted"; fi

# 2. setup_provider happy path
if run_py "
import os, tempfile
from forge.services.deploy import setup_provider
with tempfile.TemporaryDirectory() as d:
    cfg = setup_provider(d, 'railway', credentials_ref='RAILWAY_TOKEN',
                         project_id='proj_123', region='us-west2')
    assert cfg['provider'] == 'railway'
    assert os.stat(os.path.join(d, 'deploy', 'railway.json')).st_mode & 0o777 == 0o600
print('OK')" | grep -q '^OK$'; then pass "setup_provider mode 0600"; else fail "setup_provider broken"; fi

# 3. plan for each provider returns expected schema
if run_py "
import tempfile
from forge.services.deploy import plan
with tempfile.TemporaryDirectory() as d:
    for prov in ['railway','fly','vercel','cloudflare','local']:
        p = plan(d, prov)
        assert p['schema'] == 'loki.forge.deploy.plan/v1'
        assert p['provider'] == prov
print('OK')" | grep -q '^OK$'; then pass "plan returns versioned schema per provider"; else fail "plan schema broken"; fi

# 4. plan reflects live db/buckets/functions/schedules/secrets
if run_py "
import tempfile, base64
from forge.services.database import open_engine, migrate_apply
from forge.services.storage import create_bucket
from forge.services.functions import deploy as fdeploy
from forge.services.schedules import create as screate
from forge.services.secrets import set_secret
from forge.services.deploy import plan
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'users','columns':['id pk']}}]})
    create_bucket(d, 'avatars')
    fdeploy(d, 'fn', 'bun', base64.b64encode(b'x').decode())
    screate(d, 'sched', '@hourly', {'type':'event','topic':'t'})
    set_secret(d, 'KEY', 'v')
    p = plan(d, 'railway')
    # Railway plan should have postgres + redis services because db + functions exist.
    svc = [s.get('plugin') or s.get('name') for s in p['services']]
    assert 'postgresql' in svc, svc
    assert 'redis' in svc, svc
    assert p['buckets'] == ['avatars']
    assert p['functions'] == ['fn']
    assert p['schedules'] == ['sched']
print('OK')" | grep -q '^OK$'; then pass "plan reflects live forge state"; else fail "plan doesn't pull state"; fi

# 5. promote requires provider configured
if run_py "
import tempfile
from forge.services.deploy import promote, DeployError
with tempfile.TemporaryDirectory() as d:
    try: promote(d, 'railway')
    except DeployError: print('OK'); raise SystemExit
    raise AssertionError('promote without setup accepted')
" | grep -q '^OK$'; then pass "promote requires setup"; else fail "promote bypassed setup"; fi

# 6. promote records to jsonl
if run_py "
import os, tempfile
from forge.services.deploy import setup_provider, promote
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'railway', credentials_ref='X')
    rec = promote(d, 'railway')
    assert rec['promotion_id']
    log = open(os.path.join(d, 'deploy', 'promotions.jsonl')).read()
    assert rec['promotion_id'] in log
print('OK')" | grep -q '^OK$'; then pass "promote records to jsonl"; else fail "promotion not recorded"; fi

# 7. rollback appends rollback record
if run_py "
import os, tempfile
from forge.services.deploy import setup_provider, promote, rollback
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'railway', credentials_ref='X')
    promote(d, 'railway')
    rb = rollback(d, 'railway')
    assert rb['ok'] is True
    log = open(os.path.join(d, 'deploy', 'promotions.jsonl')).read()
    assert 'rolled_back' in log
print('OK')" | grep -q '^OK$'; then pass "rollback appends record"; else fail "rollback broken"; fi

# 8. status returns history
if run_py "
import tempfile
from forge.services.deploy import setup_provider, promote, status
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'railway', credentials_ref='X')
    promote(d, 'railway')
    s = status(d, 'railway')
    assert s['last_status'] == 'planned'
    assert len(s['history']) == 1
print('OK')" | grep -q '^OK$'; then pass "status returns history"; else fail "status broken"; fi

# 9. cloudflare plan includes workers + r2 + d1
if run_py "
import tempfile, base64
from forge.services.database import open_engine, migrate_apply
from forge.services.storage import create_bucket
from forge.services.functions import deploy as fdeploy
from forge.services.deploy import plan
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'t','columns':['id pk']}}]})
    create_bucket(d, 'assets')
    fdeploy(d, 'worker1', 'bun', base64.b64encode(b'x').decode())
    p = plan(d, 'cloudflare')
    assert p['workers'] == ['worker1']
    assert p['r2_buckets'] == ['assets']
    assert p['d1_databases'] == ['forge']
print('OK')" | grep -q '^OK$'; then pass "cloudflare plan maps resources"; else fail "cloudflare plan wrong"; fi

# 10. invalid env rejected
if run_py "
import tempfile
from forge.services.deploy import setup_provider, promote, DeployError
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'railway', credentials_ref='X')
    try: promote(d, 'railway', from_env='dev', to_env='canary')
    except DeployError: print('OK'); raise SystemExit
    raise AssertionError('bad env accepted')
" | grep -q '^OK$'; then pass "invalid env rejected"; else fail "bad env accepted"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
