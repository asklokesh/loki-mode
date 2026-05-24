#!/usr/bin/env bash
# Test: N-21 invoke() includes verify_signature result on response.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. signed deploy: signature.verified=True, signature_present=True
if run_py "
import tempfile
from forge.services.functions import deploy, invoke
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    r = invoke(d, 'hello')
    assert 'signature' in r, r
    assert r['signature']['verified'] is True, r['signature']
    assert r['signature']['signature_present'] is True
print('OK')" | grep -q '^OK$'; then pass "N-21 signed -> verified True"; else fail "missing sig info"; fi

# 2. legacy unsigned version: verified=False signature_present=False
if run_py "
import json, os, tempfile
from forge.services.functions import deploy, invoke
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    mp = os.path.join(d, 'functions', 'hello', 'manifest.json')
    with open(mp) as f: m = json.load(f)
    for v in m['versions']:
        v.pop('signature', None)
    with open(mp, 'w') as f: json.dump(m, f)
    r = invoke(d, 'hello')
    assert r['signature']['verified'] is False
    assert r['signature']['signature_present'] is False
print('OK')" | grep -q '^OK$'; then pass "N-21 legacy unsigned reported"; else fail "legacy info wrong"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
