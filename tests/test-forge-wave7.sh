#!/usr/bin/env bash
# Test: X-70..X-75 wave.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# X-70 secrets declaration

# 1. forge.yaml with secrets list applies (without storing values)
if run_py "
import os, tempfile
try: import yaml
except ImportError:
    print('OK'); raise SystemExit
from forge.config import apply
from forge.services.secrets import set_secret, get_rotation_policy
with tempfile.TemporaryDirectory() as d:
    yaml.safe_dump({
        'secrets': [
            {'name': 'STRIPE_KEY', 'rotation': {'cron': '@monthly', 'action': 'alert'}}
        ],
    }, open(os.path.join(d, 'forge.yaml'), 'w'))
    set_secret(os.path.join(d, '.loki', 'forge'), 'STRIPE_KEY', 'sk_test_xxx')
    res = apply(d)
    # Rotation policy applied since secret value was set first.
    assert any('secret_rotation' in a for a in res['applied']), res
    p = get_rotation_policy(os.path.join(d, '.loki', 'forge'), 'STRIPE_KEY')
    assert p and p['cron'] == '@monthly', p
print('OK')" | grep -q '^OK$'; then pass "X-70 secrets rotation from yaml"; else fail "secrets yaml broken"; fi

# X-71 tail endpoint

# 2. /api/forge/tail endpoint declared
if grep -q '"/api/forge/tail"' "$ROOT/dashboard/forge_router.py"; then
    pass "X-71 /api/forge/tail declared"
else
    fail "tail endpoint missing"
fi

# X-72 db seed

# 3. seed inserts rows idempotently
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply, seed
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'roles',
        'columns':['id pk','name text notnull']}}]})
    res = seed(e, [{'table':'roles','rows':[
        {'name':'admin'}, {'name':'user'}, {'name':'guest'}
    ]}])
    assert res['applied'][0]['rows_inserted'] == 3
    rows = e.execute('SELECT name FROM roles ORDER BY name')
    assert [r['name'] for r in rows] == ['admin','guest','user']
    # Idempotent re-apply.
    res2 = seed(e, [{'table':'roles','rows':[
        {'name':'admin'}, {'name':'user'}, {'name':'guest'}
    ]}])
    assert res2['skipped'] and res2['applied'] == []
print('OK')" | grep -q '^OK$'; then pass "X-72 seed inserts + idempotent"; else fail "seed broken"; fi

# 4. seed rejects unsafe table names
if run_py "
import tempfile
from forge.services.database import open_engine, seed
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    res = seed(e, [{'table':'evil; DROP TABLE x','rows':[{'name':'x'}]}])
    assert res['errors'], res
print('OK')" | grep -q '^OK$'; then pass "X-72 seed rejects unsafe table"; else fail "unsafe table accepted"; fi

# X-73 lifecycle

# 5. set_lifecycle stores delete_after_days
if run_py "
import tempfile
from forge.services.storage import create_bucket, set_lifecycle, list_buckets
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    set_lifecycle(d, 'bucket-a', delete_after_days=30)
    b = list_buckets(d)[0]
    assert b['delete_after_days'] == 30
print('OK')" | grep -q '^OK$'; then pass "X-73 lifecycle policy set"; else fail "lifecycle broken"; fi

# 6. lifecycle bound enforced
if run_py "
import tempfile
from forge.services.storage import create_bucket, set_lifecycle, BucketError
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    for bad in (0, -1, 100000):
        try: set_lifecycle(d, 'bucket-a', delete_after_days=bad)
        except BucketError: continue
        raise AssertionError(f'accepted {bad}')
print('OK')" | grep -q '^OK$'; then pass "X-73 days bounds enforced"; else fail "days bounds broken"; fi

# 7. garbage_collect_lifecycle prunes old objects
if run_py "
import json, os, tempfile, time
from forge.services.storage import (
    create_bucket, set_lifecycle, upload, garbage_collect_lifecycle,
    list_objects,
)
with tempfile.TemporaryDirectory() as d:
    create_bucket(d, 'bucket-a')
    set_lifecycle(d, 'bucket-a', delete_after_days=1)
    upload(d, 'bucket-a', 'a.txt', b'x')
    upload(d, 'bucket-a', 'b.txt', b'y')
    # Force one object's uploaded_at to 10 days ago.
    import hashlib
    idx_a = os.path.join(d, 'storage', 'bucket-a', '_index',
        hashlib.sha256(b'a.txt').hexdigest() + '.json')
    rec = json.load(open(idx_a))
    rec['uploaded_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ',
        time.gmtime(time.time() - 10 * 86400))
    json.dump(rec, open(idx_a, 'w'))
    res = garbage_collect_lifecycle(d, 'bucket-a')
    assert res['pruned'] == 1, res
print('OK')" | grep -q '^OK$'; then pass "X-73 GC prunes stale"; else fail "GC broken"; fi

# X-74 yaml compose

# 8. forge.local.yaml override merges
if run_py "
import os, tempfile
try: import yaml
except ImportError:
    print('OK'); raise SystemExit
from forge.config import apply
with tempfile.TemporaryDirectory() as d:
    yaml.safe_dump({'tables': [{'name':'a','columns':['id pk']}]},
                   open(os.path.join(d, 'forge.yaml'), 'w'))
    os.makedirs(os.path.join(d, '.loki'))
    yaml.safe_dump({'tables': [{'name':'b','columns':['id pk']}]},
                   open(os.path.join(d, '.loki', 'forge.local.yaml'), 'w'))
    res = apply(d)
    applied_tables = [a.get('table') for a in res['applied'] if 'table' in a]
    assert sorted(applied_tables) == ['a','b'], applied_tables
print('OK')" | grep -q '^OK$'; then pass "X-74 yaml override merges"; else fail "override broken"; fi

# X-75 cron describe

# 9. describe every minute
if run_py "
from forge.services.schedules import describe_expression
assert describe_expression('* * * * *') == 'every minute'
print('OK')" | grep -q '^OK$'; then pass "X-75 every minute"; else fail "every minute wrong"; fi

# 10. describe @hourly
if run_py "
from forge.services.schedules import describe_expression
assert describe_expression('@hourly') == 'hourly at :00'
print('OK')" | grep -q '^OK$'; then pass "X-75 @hourly"; else fail "hourly wrong"; fi

# 11. describe daily at HH:MM
if run_py "
from forge.services.schedules import describe_expression
assert 'daily at 08:30 UTC' == describe_expression('30 8 * * *')
print('OK')" | grep -q '^OK$'; then pass "X-75 daily"; else fail "daily wrong"; fi

# 12. describe weekly
if run_py "
from forge.services.schedules import describe_expression
assert 'weekly on Monday' in describe_expression('0 9 * * 1')
print('OK')" | grep -q '^OK$'; then pass "X-75 weekly"; else fail "weekly wrong"; fi

# 13. describe monthly
if run_py "
from forge.services.schedules import describe_expression
assert 'monthly on day 1' in describe_expression('0 0 1 * *')
print('OK')" | grep -q '^OK$'; then pass "X-75 monthly"; else fail "monthly wrong"; fi

# 14. */N minutes
if run_py "
from forge.services.schedules import describe_expression
assert 'every 15 minutes' == describe_expression('*/15 * * * *')
print('OK')" | grep -q '^OK$'; then pass "X-75 every N minutes"; else fail "every N wrong"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
