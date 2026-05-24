#!/usr/bin/env bash
# Test: N-07 function invoke verifies the deploy-time HMAC signature.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. verify_signature on a fresh deploy returns ok+verified
if run_py "
import tempfile
from forge.services.functions import deploy, verify_signature
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    v = verify_signature(d, 'hello')
    assert v['ok'] is True, v
    assert v['signature_present'] is True, v
    assert v['reason'] == 'verified', v
print('OK')" | grep -q '^OK$'; then pass "N-07 fresh deploy verifies"; else fail "fresh verify broken"; fi

# 2. tampering with source bytes flips ok=False with signature_mismatch
if run_py "
import os, tempfile
from forge.services.functions import deploy, verify_signature, source_path
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    src = source_path(d, 'hello')
    with open(src, 'wb') as f:
        f.write(b'print(\"hacked\")')
    v = verify_signature(d, 'hello')
    assert v['ok'] is False, v
    assert v['reason'] == 'signature_mismatch', v
print('OK')" | grep -q '^OK$'; then pass "N-07 tampered source rejected"; else fail "tamper not caught"; fi

# 3. invoke() on tampered source raises FunctionError before spawning
if run_py "
import tempfile
from forge.services.functions import deploy, invoke, source_path, FunctionError
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    src = source_path(d, 'hello')
    with open(src, 'wb') as f:
        f.write(b'print(\"hacked\")')
    try:
        invoke(d, 'hello')
        print('NO_RAISE')
    except FunctionError as e:
        msg = str(e)
        assert 'signature' in msg.lower(), msg
        print('OK')" | grep -q '^OK$'; then pass "N-07 invoke refuses tampered"; else fail "invoke ran tampered"; fi

# 4. invoke() on a fresh deploy still works (no regression)
if run_py "
import tempfile
from forge.services.functions import deploy, invoke
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='aW1wb3J0IGpzb24sc3lzOyBwcmludChqc29uLmR1bXBzKHsib2siOiBUcnVlfSkp',
           entry='index')
    r = invoke(d, 'hello')
    assert r['ok'] is True or r.get('error') == 'runtime_missing', r
print('OK')" | grep -q '^OK$'; then pass "N-07 normal invoke unaffected"; else fail "regression"; fi

# 5. version-with-no-signature passes (back-compat for legacy manifests)
if run_py "
import json, os, tempfile
from forge.services.functions import deploy, verify_signature
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    mp = os.path.join(d, 'functions', 'hello', 'manifest.json')
    with open(mp) as f: m = json.load(f)
    for v in m['versions']:
        v.pop('signature', None)
    with open(mp, 'w') as f: json.dump(m, f)
    v = verify_signature(d, 'hello')
    assert v['ok'] is True and v['signature_present'] is False, v
print('OK')" | grep -q '^OK$'; then pass "N-07 legacy unsigned back-compat"; else fail "legacy broke"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
