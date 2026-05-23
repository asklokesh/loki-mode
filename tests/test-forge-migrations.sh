#!/usr/bin/env bash
# Test: forge.migrations - supabase + insforge importers (F-4).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. supabase parse_dump finds CREATE TABLE
if run_py "
from forge.migrations.supabase import parse_dump
sql = '''
CREATE TABLE public.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL UNIQUE,
    created_at timestamptz DEFAULT now()
);
'''
parsed = parse_dump(sql)
assert len(parsed['tables']) == 1
t = parsed['tables'][0]
assert t['name'] == 'users'
names = [c['name'] for c in t['columns']]
assert names == ['id','email','created_at'], names
print('OK')" | grep -q '^OK$'; then pass "supabase parse_dump"; else fail "parse_dump broken"; fi

# 2. supabase import end-to-end
if run_py "
import os, tempfile
from forge.migrations import import_from_supabase
from forge.services.database import open_engine, introspect
with tempfile.TemporaryDirectory() as d:
    sql_path = os.path.join(d, 'dump.sql')
    with open(sql_path, 'w') as f:
        f.write('''
CREATE TABLE posts (id bigint PRIMARY KEY, title text NOT NULL);
CREATE TABLE comments (id bigint PRIMARY KEY, body text);
''')
    forge_dir = os.path.join(d, '.loki', 'forge')
    os.makedirs(forge_dir, exist_ok=True)
    rep = import_from_supabase(forge_dir, sql_path)
    assert len(rep['applied']) == 2, rep
    snap = introspect(open_engine(forge_dir))
    names = sorted(t['name'] for t in snap['tables'])
    assert names == ['comments','posts'], names
print('OK')" | grep -q '^OK$'; then pass "supabase end-to-end import"; else fail "supabase import broken"; fi

# 3. supabase skips forge-internal-looking tables
if run_py "
from forge.migrations.supabase import parse_dump
sql = '''
CREATE TABLE _forge_internal (id int PRIMARY KEY);
CREATE TABLE forge_metadata (id int PRIMARY KEY);
CREATE TABLE app_users (id int PRIMARY KEY);
'''
parsed = parse_dump(sql)
names = [t['name'] for t in parsed['tables']]
assert names == ['app_users'], names
print('OK')" | grep -q '^OK$'; then pass "skips forge-internal tables"; else fail "internal tables not skipped"; fi

# 4. supabase strips comments
if run_py "
from forge.migrations.supabase import parse_dump
sql = '''
-- comment that mentions CREATE TABLE fake
/* CREATE TABLE another_fake */
CREATE TABLE real (id int PRIMARY KEY);
'''
parsed = parse_dump(sql)
names = [t['name'] for t in parsed['tables']]
assert names == ['real'], names
print('OK')" | grep -q '^OK$'; then pass "supabase strips comments"; else fail "comment stripping broken"; fi

# 5. insforge import end-to-end
if run_py "
import json, os, tempfile
from forge.migrations import import_from_insforge
from forge.services.database import open_engine, introspect
from forge.services.storage import list_buckets
from forge.services.schedules import list_schedules
with tempfile.TemporaryDirectory() as d:
    export_path = os.path.join(d, 'export.json')
    json.dump({
        'tables': [{
            'name': 'users',
            'columns': [
                {'name':'id','type':'integer','primary_key':True},
                {'name':'email','type':'text','unique':True,'not_null':True}
            ],
        }],
        'buckets': [{'name':'uploads','public':False}],
        'schedules': [{'name':'digest','cron':'@daily',
                        'target':{'type':'event','topic':'send'}}],
        'secrets': ['STRIPE_KEY','SENDGRID_KEY'],
    }, open(export_path, 'w'))
    forge_dir = os.path.join(d, '.loki', 'forge')
    os.makedirs(forge_dir, exist_ok=True)
    rep = import_from_insforge(forge_dir, export_path)
    assert len(rep['applied_tables']) == 1
    assert rep['applied_buckets'] == ['uploads']
    assert rep['applied_schedules'] == ['digest']
    assert rep['deferred_secrets'] == ['STRIPE_KEY','SENDGRID_KEY']
    assert 'users' in [t['name'] for t in introspect(open_engine(forge_dir))['tables']]
print('OK')" | grep -q '^OK$'; then pass "insforge end-to-end import"; else fail "insforge import broken"; fi

# 6. insforge import handles missing file gracefully
if run_py "
import tempfile
from forge.migrations import import_from_insforge
with tempfile.TemporaryDirectory() as d:
    r = import_from_insforge(d, '/nonexistent')
    assert r['ok'] is False
print('OK')" | grep -q '^OK$'; then pass "insforge missing-file safe"; else fail "missing file crashes"; fi

# 7. supabase import handles missing file gracefully
if run_py "
import tempfile
from forge.migrations import import_from_supabase
with tempfile.TemporaryDirectory() as d:
    r = import_from_supabase(d, '/nonexistent')
    assert r['ok'] is False
print('OK')" | grep -q '^OK$'; then pass "supabase missing-file safe"; else fail "missing file crashes"; fi

# 8. supabase parses numeric(10,2) without depth confusion
if run_py "
from forge.migrations.supabase import parse_dump
sql = '''
CREATE TABLE pricing (
    id int PRIMARY KEY,
    amount numeric(10, 2) NOT NULL,
    currency varchar(3)
);
'''
parsed = parse_dump(sql)
cols = [c['name'] for c in parsed['tables'][0]['columns']]
assert cols == ['id','amount','currency'], cols
print('OK')" | grep -q '^OK$'; then pass "supabase handles type(n,m)"; else fail "numeric(n,m) confused depth"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
