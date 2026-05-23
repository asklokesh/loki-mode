#!/usr/bin/env bash
# Test: X-36 compliance presets + X-39 RLS DSL.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# X-36 compliance presets ---

# 1. default preset is permissive
if run_py "
import os
os.environ.pop('LOKI_COMPLIANCE_PRESET', None)
from forge.compliance import current_preset, validate_storage
p = current_preset()
assert p.name == 'default'
assert validate_storage(region='us-east-1', max_file_size=50*1024*1024) == []
print('OK')" | grep -q '^OK$'; then pass "X-36 default preset permissive"; else fail "default broken"; fi

# 2. healthcare requires us- region
if run_py "
import os
os.environ['LOKI_COMPLIANCE_PRESET'] = 'healthcare'
from forge.compliance import validate_storage
errs = validate_storage(region='eu-west-1', max_file_size=1*1024*1024)
assert errs and 'us-' in errs[0]
print('OK')" | grep -q '^OK$'; then pass "X-36 healthcare region prefix enforced"; else fail "healthcare region broken"; fi

# 3. healthcare 10MB file cap
if run_py "
import os
os.environ['LOKI_COMPLIANCE_PRESET'] = 'healthcare'
from forge.compliance import validate_storage
errs = validate_storage(region='us-east-1', max_file_size=50*1024*1024)
assert errs and '10' in errs[0]
print('OK')" | grep -q '^OK$'; then pass "X-36 healthcare 10MB cap"; else fail "healthcare cap broken"; fi

# 4. fintech requires webhook_secret_ref
if run_py "
import os
os.environ['LOKI_COMPLIANCE_PRESET'] = 'fintech'
from forge.compliance import validate_payments
assert validate_payments(webhook_secret_ref=None)
assert validate_payments(webhook_secret_ref='SECRET') == []
print('OK')" | grep -q '^OK$'; then pass "X-36 fintech webhook secret enforced"; else fail "fintech webhook broken"; fi

# 5. compliance propagates into create_bucket
if run_py "
import os, tempfile
os.environ['LOKI_COMPLIANCE_PRESET'] = 'healthcare'
from forge.services.storage import create_bucket, BucketError
with tempfile.TemporaryDirectory() as d:
    try: create_bucket(d, 'avatars', region='eu-west-1')
    except BucketError as e:
        assert 'us-' in str(e), str(e)
        print('OK')
        raise SystemExit
    raise AssertionError('eu region accepted under healthcare')
" | grep -q '^OK$'; then pass "X-36 create_bucket enforces healthcare"; else fail "healthcare bypassed"; fi

# 6. list_presets returns all 4
if run_py "
import os
os.environ.pop('LOKI_COMPLIANCE_PRESET', None)
from forge.compliance import list_presets
names = sorted(p['name'] for p in list_presets())
assert names == ['default', 'fintech', 'government', 'healthcare'], names
print('OK')" | grep -q '^OK$'; then pass "X-36 list_presets has 4"; else fail "list_presets wrong"; fi

# X-39 RLS DSL ---

# 7. equality compiles
if run_py "
from forge.services.database.rls_dsl import to_postgres
out = to_postgres('user_id = currentUser()')
assert 'user_id' in out and 'auth.uid()' in out
print('OK')" | grep -q '^OK$'; then pass "X-39 equality compiles"; else fail "equality broken"; fi

# 8. AND / OR / NOT
if run_py "
from forge.services.database.rls_dsl import to_postgres
out = to_postgres('user_id = currentUser() AND NOT is_archived = 1')
assert 'AND' in out and 'NOT' in out
print('OK')" | grep -q '^OK$'; then pass "X-39 boolean compiles"; else fail "boolean broken"; fi

# 9. IN with list (DSL uses single quotes for string literals)
if run_py "
from forge.services.database.rls_dsl import to_postgres
out = to_postgres(\"role IN ('admin', 'editor')\")
assert ' IN (' in out
assert \"'admin'\" in out
print('OK')" | grep -q '^OK$'; then pass "X-39 IN compiles"; else fail "IN broken"; fi

# 10. injection probe: raw SQL chars rejected
if run_py "
from forge.services.database.rls_dsl import to_postgres, RLSError
for bad in ['user_id = currentUser(); DROP TABLE users',
            'user_id = 1 -- comment',
            'user_id = \"admin\"']:
    try: to_postgres(bad)
    except RLSError: continue
    raise AssertionError(f'accepted: {bad!r}')
print('OK')" | grep -q '^OK$'; then pass "X-39 injection patterns rejected"; else fail "injection accepted"; fi

# 11. parenthesized precedence preserved
if run_py "
from forge.services.database.rls_dsl import to_postgres
out = to_postgres(\"(role = 'admin' OR user_id = currentUser())\")
assert 'OR' in out
print('OK')" | grep -q '^OK$'; then pass "X-39 parens preserved"; else fail "parens broken"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
