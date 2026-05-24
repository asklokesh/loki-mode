#!/usr/bin/env bash
# Test: N-40 deploy persists deployed_by_user_id on the version record.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. deploy with user_id persists it
if run_py "
import tempfile
from forge.services.functions import deploy, list_versions
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index',
           deployed_by_user_id='u_alice')
    vs = list_versions(d, 'hello')
    assert vs[0].get('deployed_by_user_id') == 'u_alice', vs[0]
print('OK')" | grep -q '^OK$'; then pass "N-40 user_id persisted"; else fail "not persisted"; fi

# 2. deploy without user_id omits the field (back-compat)
if run_py "
import tempfile
from forge.services.functions import deploy, list_versions
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    vs = list_versions(d, 'hello')
    assert 'deployed_by_user_id' not in vs[0], vs[0]
print('OK')" | grep -q '^OK$'; then pass "N-40 absent when unset"; else fail "spurious field"; fi

# 3. invalid (empty / wrong type) user_id rejected
if run_py "
import tempfile
from forge.services.functions import deploy, FunctionError
with tempfile.TemporaryDirectory() as d:
    try:
        deploy(d, name='hello', runtime='python',
               source_b64='cHJpbnQoIm9rIikK', entry='index',
               deployed_by_user_id='')
        print('NO_RAISE')
    except FunctionError as e:
        print('OK')" | grep -q '^OK$'; then pass "N-40 empty rejected"; else fail "empty accepted"; fi

# 4. successive deploys attribute each version independently
if run_py "
import tempfile
from forge.services.functions import deploy, list_versions
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index',
           deployed_by_user_id='u_alice')
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoImhpIikK', entry='index',
           deployed_by_user_id='u_bob')
    vs = list_versions(d, 'hello')
    assert vs[0]['deployed_by_user_id'] == 'u_alice'
    assert vs[1]['deployed_by_user_id'] == 'u_bob'
print('OK')" | grep -q '^OK$'; then pass "N-40 per-version attribution"; else fail "attribution mixed"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
