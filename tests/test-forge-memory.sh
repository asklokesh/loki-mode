#!/usr/bin/env bash
# Test: memory/schemas.py forge entry types (X-04).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. ForgeSchemaDecision happy path
if run_py "
from memory.schemas import ForgeSchemaDecision
d = ForgeSchemaDecision(id='d1', project_hash='proj', table_name='users',
                        columns_summary='id, email, created_at',
                        decision='use uuid pk', rationale='multi-region',
                        alternatives_considered=['bigserial'], outcome='success')
assert d.validate() == []
roundtripped = ForgeSchemaDecision.from_dict(d.to_dict())
assert roundtripped.decision == 'use uuid pk'
print('OK')" | grep -q '^OK$'; then pass "ForgeSchemaDecision roundtrip"; else fail "schema decision broken"; fi

# 2. validate catches missing fields
if run_py "
from memory.schemas import ForgeSchemaDecision
d = ForgeSchemaDecision(id='x', project_hash='p', table_name='', columns_summary='', decision='')
errs = d.validate()
assert any('table_name' in e for e in errs)
assert any('decision' in e for e in errs)
print('OK')" | grep -q '^OK$'; then pass "schema decision validation"; else fail "validation missed"; fi

# 3. validate catches bad outcome
if run_py "
from memory.schemas import ForgeSchemaDecision
d = ForgeSchemaDecision(id='x', project_hash='p', table_name='t',
                        columns_summary='c', decision='d', outcome='partial')
assert any('outcome' in e for e in d.validate())
print('OK')" | grep -q '^OK$'; then pass "schema decision outcome enum"; else fail "outcome enum not enforced"; fi

# 4. ForgeMigrationOutcome happy path
if run_py "
from memory.schemas import ForgeMigrationOutcome
o = ForgeMigrationOutcome(id='m1', project_hash='proj', migration_id='abc',
                          summary='add users', outcome='applied',
                          sql_snippet='CREATE TABLE users ...')
assert o.validate() == []
print('OK')" | grep -q '^OK$'; then pass "migration outcome roundtrip"; else fail "outcome roundtrip broken"; fi

# 5. sql_snippet truncated to 512 in to_dict
if run_py "
from memory.schemas import ForgeMigrationOutcome
big = 'x' * 5000
o = ForgeMigrationOutcome(id='m1', project_hash='p', migration_id='abc',
                          summary='s', outcome='applied', sql_snippet=big)
d = o.to_dict()
assert len(d['sql_snippet']) == 512
print('OK')" | grep -q '^OK$'; then pass "sql_snippet caps at 512 chars"; else fail "sql_snippet cap broken"; fi

# 6. outcome enum enforced
if run_py "
from memory.schemas import ForgeMigrationOutcome
o = ForgeMigrationOutcome(id='m1', project_hash='p', migration_id='m',
                          summary='s', outcome='ok')
assert any('outcome' in e for e in o.validate())
print('OK')" | grep -q '^OK$'; then pass "outcome enum enforced"; else fail "bad outcome accepted"; fi

# 7. from_dict autoassigns id when missing
if run_py "
from memory.schemas import ForgeSchemaDecision
d = ForgeSchemaDecision.from_dict({'table_name':'x','decision':'y','columns_summary':'c'})
assert d.id and len(d.id) >= 16
print('OK')" | grep -q '^OK$'; then pass "from_dict autoassigns id"; else fail "id not auto-assigned"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
