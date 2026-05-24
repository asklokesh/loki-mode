#!/usr/bin/env bash
# Test: N-59 audit verify(scope=...) selects which half to run.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. scope='migrations' marks dashboard_audit='skipped'
if run_py "
import json, os, tempfile
from forge.audit_verify import verify
with tempfile.TemporaryDirectory() as d:
    rev = os.path.join(d, '.loki', 'quality', 'forge-migrations')
    os.makedirs(rev)
    with open(os.path.join(rev, 'mig_a.json'), 'w') as f:
        json.dump({'migration_id': 'mig_a', 'spec_hash': 'x' * 64}, f)
    r = verify(d, scope='migrations')
    assert r['dashboard_audit'] == 'skipped', r
    assert r['checked_reviews'] == 1
print('OK')" | grep -q '^OK$'; then pass "N-59 migrations only"; else fail "scope ignored"; fi

# 2. scope='chain' skips per-review walk (checked_reviews=0)
if run_py "
import json, os, tempfile
from forge.audit_verify import verify
with tempfile.TemporaryDirectory() as d:
    rev = os.path.join(d, '.loki', 'quality', 'forge-migrations')
    os.makedirs(rev)
    with open(os.path.join(rev, 'mig_a.json'), 'w') as f:
        json.dump({'migration_id': 'mig_a', 'spec_hash': 'x'}, f)
    r = verify(d, scope='chain')
    assert r['checked_reviews'] == 0, r
print('OK')" | grep -q '^OK$'; then pass "N-59 chain only"; else fail "reviews still walked"; fi

# 3. scope='all' (default) runs both
if run_py "
import json, os, tempfile
from forge.audit_verify import verify
with tempfile.TemporaryDirectory() as d:
    rev = os.path.join(d, '.loki', 'quality', 'forge-migrations')
    os.makedirs(rev)
    with open(os.path.join(rev, 'mig_a.json'), 'w') as f:
        json.dump({'migration_id': 'mig_a', 'spec_hash': 'x'}, f)
    r = verify(d)
    assert r['checked_reviews'] == 1
    assert r['dashboard_audit'] != 'skipped'
print('OK')" | grep -q '^OK$'; then pass "N-59 default = all"; else fail "default scope changed"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
