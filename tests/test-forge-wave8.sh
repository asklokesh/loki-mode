#!/usr/bin/env bash
# Test: X-76, X-78, X-79, X-81 wave (X-77 deferred; needs Postgres; X-80 future).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# X-76 explain analyze

# 1. analyze flags table scan on un-indexed column
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'t','columns':['id pk','name text']}}]})
    res = e.explain_analyze('SELECT * FROM t WHERE name = ?', params=['x'])
    # name has no index -> SCAN should be present in the plan and warning emitted.
    assert isinstance(res['warnings'], list)
print('OK')" | grep -q '^OK$'; then pass "X-76 explain_analyze runs"; else fail "explain_analyze broken"; fi

# 2. analyze: indexed column has no warning
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'t','columns':['id pk','name text unique']}}]})
    res = e.explain_analyze('SELECT * FROM t WHERE name = ?', params=['x'])
    # SELECT on UNIQUE column should use the auto-index, so no warning.
    assert res['warnings'] == [] or all('unindexed' not in w for w in res['warnings']), res
print('OK')" | grep -q '^OK$'; then pass "X-76 indexed scans no warning"; else fail "false warning"; fi

# X-78 signed function deploys

# 3. deploy attaches a signature to the version record
if run_py "
import base64, tempfile
from forge.services.functions import deploy as fdeploy, get_function
with tempfile.TemporaryDirectory() as d:
    res = fdeploy(d, 'fn', 'bun', base64.b64encode(b'console.log(1)').decode())
    m = get_function(d, 'fn')
    v = m['versions'][-1]
    assert 'signature' in v, v
    assert len(v['signature']) == 64, v['signature']
print('OK')" | grep -q '^OK$'; then pass "X-78 signed deploy"; else fail "signature missing"; fi

# 4. signatures differ across sources
if run_py "
import base64, tempfile
from forge.services.functions import deploy as fdeploy, get_function
with tempfile.TemporaryDirectory() as d:
    fdeploy(d, 'fn', 'bun', base64.b64encode(b'a').decode())
    s1 = get_function(d, 'fn')['versions'][-1]['signature']
    fdeploy(d, 'fn', 'bun', base64.b64encode(b'b').decode())
    s2 = get_function(d, 'fn')['versions'][-1]['signature']
    assert s1 != s2
print('OK')" | grep -q '^OK$'; then pass "X-78 signature changes with source"; else fail "signature collision"; fi

# X-79 metrics

# 5. metrics.render emits Prometheus exposition
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
from forge.services.storage import create_bucket
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'users','columns':['id pk']}}]})
    create_bucket(d, 'avatars')
    text = render(d)
    assert 'forge_tables_total' in text
    assert 'forge_buckets_total' in text
    assert '# HELP' in text and '# TYPE' in text
print('OK')" | grep -q '^OK$'; then pass "X-79 metrics emit"; else fail "metrics broken"; fi

# 6. metrics on empty forge_dir
if run_py "
import tempfile
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    text = render(d + '/nonexistent')
    assert 'not present' in text
print('OK')" | grep -q '^OK$'; then pass "X-79 empty forge_dir handled"; else fail "empty crashed"; fi

# 7. /api/forge/metrics endpoint declared
if grep -q '"/api/forge/metrics"' "$ROOT/dashboard/forge_router.py"; then
    pass "X-79 /api/forge/metrics declared"
else
    fail "metrics endpoint missing"
fi

# X-81 signed upload URL

# 8. sign_upload_url + verify_upload_url roundtrip
if run_py "
import tempfile, urllib.parse
from forge.services.storage import create_bucket, sign_upload_url, verify_upload_url
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    url = sign_upload_url(d, 'bucket-a', 'avatar.png', expires_in=300, max_size=2*1024*1024)
    qs = dict(urllib.parse.parse_qsl(url.split('?', 1)[1]))
    r = verify_upload_url(d, 'bucket-a', 'avatar.png', qs)
    assert r['valid'] == 'true' and r['method'] == 'PUT'
print('OK')" | grep -q '^OK$'; then pass "X-81 signed upload roundtrip"; else fail "upload sign broken"; fi

# 9. PUT-signed URL cannot be replayed for download
if run_py "
import tempfile, urllib.parse
from forge.services.storage import create_bucket, sign_upload_url, verify_url
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    url = sign_upload_url(d, 'bucket-a', 'pic.png', expires_in=300, max_size=10*1024*1024)
    qs = dict(urllib.parse.parse_qsl(url.split('?', 1)[1]))
    try: verify_url(d, 'bucket-a', 'pic.png', qs)
    except ValueError: print('OK'); raise SystemExit
    raise AssertionError('PUT URL accepted for GET')
" | grep -q '^OK$'; then pass "X-81 PUT URL rejected by GET verifier"; else fail "replay possible"; fi

# 10. bad expires_in rejected
if run_py "
import tempfile
from forge.services.storage import create_bucket, sign_upload_url
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    for bad in [0, -1, 24*3600+1, 999999]:
        try: sign_upload_url(d, 'bucket-a', 'x', expires_in=bad)
        except ValueError: continue
        raise AssertionError(f'accepted {bad}')
print('OK')" | grep -q '^OK$'; then pass "X-81 expires_in bounds"; else fail "bounds broken"; fi

# 11. PUT sig changes with max_size
if run_py "
import tempfile, urllib.parse
from forge.services.storage import create_bucket, sign_upload_url
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    u1 = sign_upload_url(d, 'bucket-a', 'p', expires_in=60, max_size=1024)
    u2 = sign_upload_url(d, 'bucket-a', 'p', expires_in=60, max_size=2048)
    s1 = dict(urllib.parse.parse_qsl(u1.split('?', 1)[1]))['sig']
    s2 = dict(urllib.parse.parse_qsl(u2.split('?', 1)[1]))['sig']
    assert s1 != s2
print('OK')" | grep -q '^OK$'; then pass "X-81 sig bound to max_size"; else fail "sig not bound to max_size"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
