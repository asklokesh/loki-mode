#!/usr/bin/env bash
# Test: X-46 S3-compatible storage gateway + X-42 RLS materialization.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. X-46 configure happy path
if run_py "
import os, tempfile
from forge.services.storage import configure_gateway
with tempfile.TemporaryDirectory() as d:
    cfg = configure_gateway(d, provider='r2',
        endpoint='https://acc.r2.cloudflarestorage.com',
        bucket='forge-prod',
        access_key_ref='R2_ACCESS',
        secret_key_ref='R2_SECRET')
    assert cfg['provider'] == 'r2'
    p = os.path.join(d, 'storage', '.gateway.json')
    assert os.stat(p).st_mode & 0o777 == 0o600
print('OK')" | grep -q '^OK$'; then pass "X-46 configure r2"; else fail "configure broken"; fi

# 2. X-46 unsupported provider rejected
if run_py "
import tempfile
from forge.services.storage import configure_gateway
with tempfile.TemporaryDirectory() as d:
    try: configure_gateway(d, provider='gcs', endpoint='https://x', bucket='b')
    except ValueError: print('OK'); raise SystemExit
    raise AssertionError('gcs accepted')
" | grep -q '^OK$'; then pass "X-46 unsupported rejected"; else fail "unsupported accepted"; fi

# 3. X-46 non-fs requires endpoint+bucket
if run_py "
import tempfile
from forge.services.storage import configure_gateway
with tempfile.TemporaryDirectory() as d:
    try: configure_gateway(d, provider='s3', bucket='b')
    except ValueError: print('OK'); raise SystemExit
    raise AssertionError('missing endpoint accepted')
" | grep -q '^OK$'; then pass "X-46 endpoint required for non-fs"; else fail "endpoint validation broken"; fi

# 4. X-46 fs is default when no config
if run_py "
import tempfile
from forge.services.storage import get_gateway_config
with tempfile.TemporaryDirectory() as d:
    cfg = get_gateway_config(d)
    assert cfg['provider'] == 'fs'
print('OK')" | grep -q '^OK$'; then pass "X-46 default provider fs"; else fail "default not fs"; fi

# 5. X-46 SigV4 presigned URL well-formed
if run_py "
from forge.services.storage import s3_presigned_url
url = s3_presigned_url(access_key='AKIA' + 'X' * 16,
    secret_key='sk' + 'y' * 38,
    endpoint='https://s3.us-east-1.amazonaws.com',
    bucket='my-bucket', key='users/123/avatar.png',
    region='us-east-1', method='GET', expires_in=300)
assert 'X-Amz-Algorithm=AWS4-HMAC-SHA256' in url
assert 'X-Amz-Signature=' in url
assert 'X-Amz-Expires=300' in url
assert 'my-bucket' in url
print('OK')" | grep -q '^OK$'; then pass "X-46 SigV4 URL well-formed"; else fail "SigV4 URL broken"; fi

# 6. X-46 expires_in bounds enforced
if run_py "
from forge.services.storage import s3_presigned_url
for bad in [0, -1, 7*24*3600+1]:
    try: s3_presigned_url(access_key='a', secret_key='b',
        endpoint='https://x', bucket='b', key='k', expires_in=bad)
    except ValueError: continue
    raise AssertionError(f'accepted {bad}')
print('OK')" | grep -q '^OK$'; then pass "X-46 expires_in bounds"; else fail "expires_in bounds broken"; fi

# 7. X-42: deploy plan emits rls_policies
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
from forge.services.deploy import setup_provider, plan
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{
        'name':'posts','columns':['id pk','user_id integer notnull'],
        'rls':'own-row'}}]})
    setup_provider(d, 'railway', credentials_ref='RAILWAY_TOKEN')
    p = plan(d, 'railway')
    assert 'rls_policies' in p
    assert any(pol['table'] == 'posts' for pol in p['rls_policies']), p['rls_policies']
print('OK')" | grep -q '^OK$'; then pass "X-42 deploy plan emits RLS DDL"; else fail "rls_policies not in plan"; fi

# 8. X-42: RLS DDL contains a CREATE POLICY statement
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
from forge.services.deploy import setup_provider, plan
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{
        'name':'posts','columns':['id pk','user_id integer notnull'],
        'rls':'own-row'}}]})
    setup_provider(d, 'fly', credentials_ref='FLY_TOKEN')
    p = plan(d, 'fly')
    pol = p['rls_policies'][0]
    assert 'CREATE POLICY' in pol['ddl']
    assert 'ENABLE ROW LEVEL SECURITY' in pol['ddl']
print('OK')" | grep -q '^OK$'; then pass "X-42 RLS DDL well-formed"; else fail "DDL malformed"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
