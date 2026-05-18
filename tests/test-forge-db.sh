#!/usr/bin/env bash
# Test: forge.services.database engine + migrate + introspect (v7.6.0 Phase F-1).
# Unit test in an ephemeral temp dir so we never touch any project state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

run_py() {
    PYTHONPATH="$ROOT" python3 -c "$1" 2>&1
}

# 1. open_engine creates db.sqlite and PRAGMA table_info works
if run_py "
import os, tempfile
from forge.services.database import open_engine, introspect
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    assert os.path.exists(os.path.join(d, 'db.sqlite'))
    snap = introspect(e)
    assert snap['tables'] == []
    e.close()
print('OK')" | grep -q '^OK$'; then
    pass "open_engine creates db.sqlite + introspect on empty db"
else
    fail "open_engine basic flow broke"
fi

# 2. migrate_apply with add_table
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply, introspect
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    res = migrate_apply(e, {
        'summary': 'add users',
        'operations': [{'add_table': {
            'name': 'users',
            'columns': ['id pk', 'email text unique notnull', 'created_at timestamp default(now())'],
            'rls': 'own-row',
        }}]
    })
    assert res['migration_id']
    snap = introspect(e)
    names = [t['name'] for t in snap['tables']]
    assert 'users' in names, names
    cols = next(t for t in snap['tables'] if t['name']=='users')['columns']
    col_names = [c['name'] for c in cols]
    assert col_names == ['id', 'email', 'created_at'], col_names
    e.close()
print('OK')" | grep -q '^OK$'; then
    pass "migrate_apply add_table + introspect roundtrip"
else
    fail "migrate_apply round-trip failed"
fi

# 3. migrate_apply is idempotent (same spec_hash -> already_applied)
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    spec = {'summary':'add t','operations':[{'add_table':{'name':'t','columns':['id pk']}}]}
    r1 = migrate_apply(e, spec)
    r2 = migrate_apply(e, spec)
    assert r1['migration_id'] == r2['migration_id']
    assert r2.get('already_applied') is True, r2
    e.close()
print('OK')" | grep -q '^OK$'; then
    pass "migrate_apply is idempotent on same spec"
else
    fail "migrate_apply idempotency broken"
fi

# 4. RLS recorded; introspect surfaces it
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply, introspect
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{
        'name':'posts','columns':['id pk','user_id integer'],'rls':'own-or-public'}}]})
    snap = introspect(e)
    p = next(t for t in snap['tables'] if t['name']=='posts')
    assert p['rls']['declared'] is True
    assert p['rls']['policies'] and p['rls']['policies'][0]['policy_name'] == 'own-or-public'
    e.close()
print('OK')" | grep -q '^OK$'; then
    pass "RLS policy recorded + introspected"
else
    fail "RLS round-trip failed"
fi

# 5. execute() rejects multi-statement
if run_py "
import tempfile
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    try:
        e.execute('SELECT 1; DROP TABLE x')
    except ValueError as ex:
        assert 'single statement' in str(ex)
        print('OK')
        raise SystemExit
    raise AssertionError('multi-statement accepted')
" | grep -q '^OK$'; then
    pass "execute() rejects multi-statement"
else
    fail "execute() accepted multi-statement"
fi

# 6. execute() rejects writes without allow_writes
if run_py "
import tempfile
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    try:
        e.execute('DELETE FROM x')
    except PermissionError:
        print('OK')
        raise SystemExit
    raise AssertionError('DELETE accepted without allow_writes')
" | grep -q '^OK$'; then
    pass "execute() rejects writes without allow_writes=True"
else
    fail "execute() allowed unauthorised write"
fi

# 7. PRAGMA read forms allowed (introspection requirement)
if run_py "
import tempfile
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    rows = e.execute('PRAGMA database_list')
    assert isinstance(rows, list)
print('OK')" | grep -q '^OK$'; then
    pass "PRAGMA read form allowed without allow_writes"
else
    fail "PRAGMA read form blocked"
fi

# 8. PRAGMA write forms still blocked
if run_py "
import tempfile
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    try:
        e.execute('PRAGMA foreign_keys=OFF')
    except PermissionError:
        print('OK')
        raise SystemExit
    raise AssertionError('PRAGMA write accepted')
" | grep -q '^OK$'; then
    pass "PRAGMA write form blocked"
else
    fail "PRAGMA write form leaked through"
fi

# 9. Unsafe identifier rejected
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    try:
        migrate_apply(e, {'operations':[{'add_table':{
            'name':'users; DROP TABLE x','columns':['id pk']}}]})
    except ValueError:
        print('OK')
        raise SystemExit
    raise AssertionError('unsafe table name accepted')
" | grep -q '^OK$'; then
    pass "unsafe identifier rejected"
else
    fail "unsafe identifier slipped past validator"
fi

# 10. migrate_rollback inverts add_table
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply, migrate_rollback, introspect
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    r = migrate_apply(e, {'operations':[{'add_table':{'name':'t','columns':['id pk']}}]})
    res = migrate_rollback(e, r['migration_id'])
    assert res['ok'], res
    snap = introspect(e)
    assert 't' not in [t['name'] for t in snap['tables']]
print('OK')" | grep -q '^OK$'; then
    pass "migrate_rollback inverts add_table"
else
    fail "rollback did not invert add_table"
fi

# 11. The 'id pk' shorthand does NOT produce duplicate PRIMARY KEY (BUG-3 regression)
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    # Both ways to declare a PK column: must work without 'more than one primary key'.
    migrate_apply(e, {'operations':[{'add_table':{
        'name':'a','columns':[{'name':'id','type':'id','primary_key':True}]}}]})
    migrate_apply(e, {'operations':[{'add_table':{
        'name':'b','columns':['id pk']}}]})
print('OK')" | grep -q '^OK$'; then
    pass "BUG-3 fix: id/pk alias does not double-emit PRIMARY KEY"
else
    fail "BUG-3 regression: duplicate PRIMARY KEY surfaced"
fi

# 12. RLS policy names with hyphens accepted (BUG-1 regression)
if run_py "
import tempfile
from forge.services.database import open_engine, migrate_apply
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{
        'name':'posts','columns':['id pk'],'rls':'own-or-public'}}]})
print('OK')" | grep -q '^OK$'; then
    pass "BUG-1 fix: hyphenated RLS policy names accepted"
else
    fail "BUG-1 regression: hyphenated RLS rejected"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
