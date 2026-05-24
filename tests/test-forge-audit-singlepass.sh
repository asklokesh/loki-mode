#!/usr/bin/env bash
# Test: N-13 audit verify combines chain hash + review records in one pass.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. empty project: clean walk, no errors
if run_py "
import tempfile
from forge.audit_verify import verify
with tempfile.TemporaryDirectory() as d:
    r = verify(d)
    assert r['ok'] is True, r
    assert r['checked_reviews'] == 0
print('OK')" | grep -q '^OK$'; then pass "N-13 empty walk clean"; else fail "empty walk dirty"; fi

# 2. dashboard_audit field is present on the report shape (single-pass
#    invariant: the chain status is decided in the same call)
if run_py "
import tempfile
from forge.audit_verify import verify
with tempfile.TemporaryDirectory() as d:
    r = verify(d)
    assert 'dashboard_audit' in r, r
    assert r['dashboard_audit'] in ('ok', 'invalid', 'not_initialized'), r
print('OK')" | grep -q '^OK$'; then pass "N-13 dashboard_audit on report"; else fail "field missing"; fi

# 3. review-missing-chain warning surfaces when review exists but no chain
if run_py "
import json, os, tempfile
from forge.audit_verify import verify
with tempfile.TemporaryDirectory() as d:
    rev = os.path.join(d, '.loki', 'quality', 'forge-migrations')
    os.makedirs(rev, exist_ok=True)
    rec = {'migration_id': 'mig_abc', 'spec_hash': 'x' * 64}
    with open(os.path.join(rev, 'mig_abc.json'), 'w') as f:
        json.dump(rec, f)
    r = verify(d)
    # Without a ledger entry, we still emit a 'no corresponding ledger'
    # warning; the N-13 cross-ref is only checked when the chain is up.
    assert any('mig_abc' in w for w in r['warnings']), r['warnings']
print('OK')" | grep -q '^OK$'; then pass "N-13 review without ledger flagged"; else fail "review check missed"; fi

# 4. report exposes 'warnings' AND 'errors' arrays (contract for the CLI)
if run_py "
import tempfile
from forge.audit_verify import verify
with tempfile.TemporaryDirectory() as d:
    r = verify(d)
    assert isinstance(r.get('warnings'), list)
    assert isinstance(r.get('errors'), list)
print('OK')" | grep -q '^OK$'; then pass "N-13 report shape stable"; else fail "shape drift"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
