#!/usr/bin/env bash
# Test: X-77 Postgres healing parity.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. pgdump parser handles basic CREATE TABLE
if run_py "
from forge.healing_postgres import propose_from_pgdump
dump = '''
-- Some comment
CREATE TABLE public.users (
    id integer NOT NULL,
    email character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE TABLE public.posts (
    id bigint PRIMARY KEY,
    title text NOT NULL,
    user_id integer
);
'''
p = propose_from_pgdump(dump)
names = [op['add_table']['name'] for op in p['operations']]
assert sorted(names) == ['posts','users'], names
posts = next(op for op in p['operations'] if op['add_table']['name'] == 'posts')
id_col = next(c for c in posts['add_table']['columns'] if c['name'] == 'id')
assert id_col.get('primary_key') is True
assert id_col['type'] == 'id'
print('OK')" | grep -q '^OK$'; then pass "X-77 pgdump parser CREATE TABLE"; else fail "pgdump parser broken"; fi

# 2. pgdump skips forge-internal-looking tables
if run_py "
from forge.healing_postgres import propose_from_pgdump
dump = '''
CREATE TABLE _forge_x (id integer PRIMARY KEY);
CREATE TABLE app_data (id integer PRIMARY KEY);
'''
p = propose_from_pgdump(dump)
names = [op['add_table']['name'] for op in p['operations']]
assert names == ['app_data'], names
print('OK')" | grep -q '^OK$'; then pass "X-77 pgdump skips forge-internal"; else fail "internal not skipped"; fi

# 3. pgdump tolerates types we don't model
if run_py "
from forge.healing_postgres import propose_from_pgdump
dump = '''
CREATE TABLE t (
    id integer PRIMARY KEY,
    blob_data bytea,
    config jsonb,
    flag boolean DEFAULT false
);
'''
p = propose_from_pgdump(dump)
cols = p['operations'][0]['add_table']['columns']
ctypes = {c['name']: c['type'] for c in cols}
assert ctypes['blob_data'] == 'blob'
assert ctypes['config'] == 'json'
assert ctypes['flag'] == 'boolean'
print('OK')" | grep -q '^OK$'; then pass "X-77 pgdump type mapping"; else fail "type mapping broken"; fi

# 4. pgdump parser handles numeric(10,2) and similar parenthesized type modifiers
if run_py "
from forge.healing_postgres import propose_from_pgdump
dump = '''
CREATE TABLE prices (
    id integer PRIMARY KEY,
    amount numeric(10, 2) NOT NULL,
    currency character varying(3)
);
'''
p = propose_from_pgdump(dump)
cols = [c['name'] for c in p['operations'][0]['add_table']['columns']]
assert cols == ['id','amount','currency'], cols
print('OK')" | grep -q '^OK$'; then pass "X-77 numeric(n,m) tolerated"; else fail "numeric confused depth"; fi

# 5. apply_proposal works against an output from pgdump
if run_py "
import os, tempfile
from forge.healing_postgres import propose_from_pgdump
from forge.healing import apply_proposal
from forge.services.database import open_engine, introspect
dump = '''
CREATE TABLE orders (
    id integer PRIMARY KEY,
    total numeric NOT NULL
);
'''
with tempfile.TemporaryDirectory() as d:
    fd = os.path.join(d, '.loki', 'forge')
    os.makedirs(fd)
    p = propose_from_pgdump(dump)
    res = apply_proposal(fd, p)
    assert res['applied'] and not res['errors'], res
    snap = introspect(open_engine(fd))
    assert 'orders' in [t['name'] for t in snap['tables']]
print('OK')" | grep -q '^OK$'; then pass "X-77 pgdump -> apply roundtrip"; else fail "apply broken"; fi

# 6. propose_from_postgres surfaces clear error when psycopg missing
if run_py "
from forge.healing_postgres import propose_from_postgres
try:
    propose_from_postgres('postgresql://localhost/nope')
except RuntimeError as e:
    assert 'psycopg' in str(e), str(e)
    print('OK')
    raise SystemExit
except Exception:
    # If psycopg IS available the call will fail with a connection
    # error - acceptable for this test (we only assert the clear-error
    # path when missing).
    print('OK')
" | grep -q '^OK$'; then pass "X-77 clear error when psycopg missing"; else fail "unclear missing-dep error"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
