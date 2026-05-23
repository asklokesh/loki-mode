#!/usr/bin/env bash
# Test: X-61..X-67 wave.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# X-61 search

# 1. search by table name
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
from forge.search import search
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'users','columns':['id pk']}}]})
    migrate_apply(e, {'operations':[{'add_table':{'name':'posts','columns':['id pk']}}]})
    res = search(d, 'user')
    names = [r['name'] for r in res]
    assert 'users' in names, names
print('OK')" | grep -q '^OK$'; then pass "X-61 search finds table"; else fail "table search broken"; fi

# 2. search ranks exact matches first
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
from forge.search import search
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'user_settings','columns':['id pk']}}]})
    migrate_apply(e, {'operations':[{'add_table':{'name':'users','columns':['id pk']}}]})
    res = search(d, 'users')
    # exact match 'users' should outrank substring 'user_settings'
    assert res[0]['name'] == 'users', res
print('OK')" | grep -q '^OK$'; then pass "X-61 exact match wins"; else fail "ranking broken"; fi

# 3. search returns multi-kind
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
from forge.services.storage import create_bucket
from forge.search import search
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'avatars_table','columns':['id pk']}}]})
    create_bucket(d, 'avatars-bucket')
    res = search(d, 'avatar')
    kinds = {r['kind'] for r in res}
    assert 'bucket' in kinds and 'table' in kinds, kinds
print('OK')" | grep -q '^OK$'; then pass "X-61 cross-service search"; else fail "cross-service broken"; fi

# X-62 init

# 4. forge.scaffold.init creates a yaml file
if run_py "
import os, tempfile
from forge.scaffold import init
with tempfile.TemporaryDirectory() as d:
    res = init(d)
    assert res['created'] is True
    text = open(os.path.join(d, 'forge.yaml')).read()
    assert 'schema_version: 1' in text
    assert 'compliance_preset' in text
print('OK')" | grep -q '^OK$'; then pass "X-62 init writes forge.yaml"; else fail "init broken"; fi

# 5. init refuses to overwrite
if run_py "
import os, tempfile
from forge.scaffold import init
with tempfile.TemporaryDirectory() as d:
    init(d)
    res = init(d)
    assert res['created'] is False
print('OK')" | grep -q '^OK$'; then pass "X-62 init refuses overwrite"; else fail "overwrite happened"; fi

# 6. init force=True overwrites
if run_py "
import os, tempfile
from forge.scaffold import init
with tempfile.TemporaryDirectory() as d:
    init(d)
    res = init(d, force=True)
    assert res['created'] is True
print('OK')" | grep -q '^OK$'; then pass "X-62 force overwrites"; else fail "force broken"; fi

# X-63 fk adjacency

# 7. introspect emits fk_graph
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply, introspect
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'users','columns':['id pk']}}]})
    migrate_apply(e, {'operations':[{'add_table':{'name':'posts',
        'columns':['id pk','user_id integer notnull references=users.id']}}]})
    snap = introspect(e)
    assert 'fk_graph' in snap
    g = snap['fk_graph']
    assert any(fk['table']=='posts' and fk['references_table']=='users' for fk in g), g
print('OK')" | grep -q '^OK$'; then pass "X-63 fk_graph emitted"; else fail "fk_graph missing"; fi

# X-64 versioning

# 8. download by version returns prior content
if run_py "
import tempfile
from forge.services.storage import create_bucket, upload, download
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    upload(d, 'bucket-a', 'doc.txt', b'v1 content')
    upload(d, 'bucket-a', 'doc.txt', b'v2 content')
    upload(d, 'bucket-a', 'doc.txt', b'v3 content')
    blob_head, _ = download(d, 'bucket-a', 'doc.txt')
    blob_v1, _ = download(d, 'bucket-a', 'doc.txt', version=1)
    blob_v3, _ = download(d, 'bucket-a', 'doc.txt', version=3)
    assert blob_head == b'v3 content'
    assert blob_v1 == b'v1 content'
    assert blob_v3 == b'v3 content'
print('OK')" | grep -q '^OK$'; then pass "X-64 download by version"; else fail "versioning broken"; fi

# 9. version out of range rejected
if run_py "
import tempfile
from forge.services.storage import create_bucket, upload, download, BucketError
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    upload(d, 'bucket-a', 'doc.txt', b'v1')
    try: download(d, 'bucket-a', 'doc.txt', version=99)
    except BucketError: print('OK'); raise SystemExit
    raise AssertionError('out-of-range accepted')
" | grep -q '^OK$'; then pass "X-64 out-of-range rejected"; else fail "out-of-range accepted"; fi

# X-65 alert hook

# 10. alert hook fires on throttle
if run_py "
from forge.services.gateway import check
from forge.services.gateway.rate_limit import set_alert_hook, reset
reset()
fired = []
set_alert_hook(lambda e: fired.append(e))
check('k', cost=10, capacity=1, refill_per_sec=0)  # over cap, throttled
assert fired and fired[0]['api_key_id'] == 'k', fired
set_alert_hook(None)
print('OK')" | grep -q '^OK$'; then pass "X-65 alert hook fires on throttle"; else fail "alert hook broken"; fi

# 11. alert hook silent on allowed
if run_py "
from forge.services.gateway import check
from forge.services.gateway.rate_limit import set_alert_hook, reset
reset()
fired = []
set_alert_hook(lambda e: fired.append(e))
check('k', cost=1, capacity=10, refill_per_sec=1)  # allowed
assert fired == [], fired
set_alert_hook(None)
print('OK')" | grep -q '^OK$'; then pass "X-65 hook silent when allowed"; else fail "hook fired on allowed"; fi

# X-66 explain

# 12. explain returns plan
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'t','columns':['id pk','name text']}}]})
    rows = e.explain('SELECT * FROM t WHERE name = ?', params=['x'])
    assert isinstance(rows, list)
    assert len(rows) >= 1
print('OK')" | grep -q '^OK$'; then pass "X-66 explain returns plan"; else fail "explain broken"; fi

# 13. explain rejects writes
if run_py "
import tempfile
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    try: e.explain('DELETE FROM x')
    except PermissionError: print('OK'); raise SystemExit
    raise AssertionError('write accepted')
" | grep -q '^OK$'; then pass "X-66 explain rejects writes"; else fail "writes accepted"; fi

# X-67 secret export

# 14. export requires confirm_destructive
if run_py "
import tempfile
from forge.services.secrets import export_secrets, SecretError
with tempfile.TemporaryDirectory() as d:
    try: export_secrets(d)
    except SecretError: print('OK'); raise SystemExit
    raise AssertionError('export without confirm accepted')
" | grep -q '^OK$'; then pass "X-67 requires confirm"; else fail "export bypassed"; fi

# 15. export with confirm returns clear values
if run_py "
import tempfile
from forge.services.secrets import set_secret, export_secrets
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'val-a')
    set_secret(d, 'B', 'val-b')
    out = export_secrets(d, confirm_destructive=True)
    assert out['A'] == 'val-a' and out['B'] == 'val-b', out
print('OK')" | grep -q '^OK$'; then pass "X-67 export returns clear values"; else fail "export broken"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
