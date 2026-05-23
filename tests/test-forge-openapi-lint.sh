#!/usr/bin/env bash
# Test: X-47 OpenAPI generator + X-48 migration linter + X-45 audit chain
# + X-43 oauth template + X-41 compliance surfaced in status.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. X-47: OpenAPI generate produces 3.1 spec
if run_py "
import json, os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'users',
        'columns':['id pk','email text notnull']}}]})
    spec = generate(d)
    assert spec['openapi'] == '3.1.0'
    assert '/db/v1/users' in spec['paths']
    assert 'Users' in spec['components']['schemas']
    sch = spec['components']['schemas']['Users']
    assert 'email' in sch['properties']
    assert 'id' in sch['required']
print('OK')" | grep -q '^OK$'; then pass "X-47 OpenAPI generate"; else fail "OpenAPI broken"; fi

# 2. X-47: write_to creates file
if run_py "
import json, os, tempfile
from forge.services.database import open_engine, migrate_apply
from forge.sdk.openapi import write_to
with tempfile.TemporaryDirectory() as d:
    e = open_engine(d)
    migrate_apply(e, {'operations':[{'add_table':{'name':'t','columns':['id pk']}}]})
    out = os.path.join(d, 'spec.json')
    res = write_to(d, out)
    assert os.path.isfile(out)
    spec = json.load(open(out))
    assert spec['openapi'] == '3.1.0'
print('OK')" | grep -q '^OK$'; then pass "X-47 OpenAPI write_to"; else fail "write_to broken"; fi

# 3. X-48 lint: flag add_table over forge-internal
if run_py "
from forge.services.database.lint import lint_spec
report = lint_spec({'operations':[{'add_table':{
    'name':'_forge_migrations','columns':['id pk']}}]})
assert any('forge-internal' in e for e in report['errors']), report
print('OK')" | grep -q '^OK$'; then pass "X-48 lint blocks internal-shadow"; else fail "internal shadow allowed"; fi

# 4. X-48 lint: warn on no PK
if run_py "
from forge.services.database.lint import lint_spec
report = lint_spec({'operations':[{'add_table':{
    'name':'misc','columns':['title text']}}]})
assert any('primary key' in w for w in report['warnings']), report
print('OK')" | grep -q '^OK$'; then pass "X-48 lint warns missing PK"; else fail "missing PK not warned"; fi

# 5. X-48 lint: warn on NOT NULL + no DEFAULT for add_column
if run_py "
from forge.services.database.lint import lint_spec
report = lint_spec({'operations':[{'add_column':{
    'table':'users','column':{'name':'name','type':'text','notnull':True}}}]})
assert any('backfill' in w for w in report['warnings']), report
print('OK')" | grep -q '^OK$'; then pass "X-48 lint warns NOT NULL backfill"; else fail "backfill warning missing"; fi

# 6. X-48 lint: error on bad index name
if run_py "
from forge.services.database.lint import lint_spec
report = lint_spec({'operations':[{'create_index':{
    'table':'users','columns':['email'],'name':'INVALID NAME'}}]})
assert any('invalid name' in e for e in report['errors']), report
print('OK')" | grep -q '^OK$'; then pass "X-48 lint rejects bad index name"; else fail "bad index name accepted"; fi

# 7. X-48 lint: drop forge-internal is an error
if run_py "
from forge.services.database.lint import lint_spec
report = lint_spec({'operations':[{'drop_table':'_forge_migrations'}]})
assert any('forge-internal' in e for e in report['errors']), report
print('OK')" | grep -q '^OK$'; then pass "X-48 lint blocks drop-internal"; else fail "drop internal allowed"; fi

# 8. X-43: oauth_exchange template emits valid base64 of non-empty source
if run_py "
import base64
from forge.services.auth.oauth_exchange_template import emit_template_b64, TEMPLATE_TS
src = base64.b64decode(emit_template_b64()).decode('utf-8')
assert src == TEMPLATE_TS
assert 'token_url' in src and 'access_token' in src
print('OK')" | grep -q '^OK$'; then pass "X-43 oauth template emits b64"; else fail "oauth template broken"; fi

# 9. X-41: compliance surfaced in `loki forge status` JSON
tmp=$(mktemp -d)
(
    cd "$tmp"
    LOKI_COMPLIANCE_PRESET=healthcare "$ROOT/bin/loki" forge status 2>&1
) > "$tmp/out.log"
results=$(cat "$tmp/out.log")
rm -rf "$tmp"
verify_out=$(echo "$results" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert 'compliance' in d, d
assert d['compliance']['name'] == 'healthcare', d['compliance']
print('OK')
" 2>&1 || true)
if echo "$verify_out" | grep -q '^OK$'; then
    pass "X-41 status surfaces compliance preset"
else
    fail "compliance not in status JSON"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
