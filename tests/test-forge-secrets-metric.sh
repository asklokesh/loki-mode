#!/usr/bin/env bash
# Test: N-55 metrics surface forge_secrets_total + forge_secrets_weak.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. no vault -> total/weak = 0
if run_py "
import tempfile
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    out = render(d)
    assert 'forge_secrets_total 0' in out, out
    assert 'forge_secrets_weak 0' in out
print('OK')" | grep -q '^OK$'; then pass "N-55 empty -> zero"; else fail "wrong"; fi

# 2. two secrets, one fallback -> total=2 weak=1
if run_py "
import json, os, tempfile
from forge.services.secrets.vault import set_secret, _vault_path
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'x'); set_secret(d, 'B', 'y')
    p = _vault_path(d)
    with open(p) as f: data = json.load(f)
    data['entries']['A']['alg'] = 'AES-GCM-256'
    data['entries']['A']['kdf'] = 'raw32'
    data['entries']['B']['alg'] = 'HMAC-XOR'
    data['entries']['B']['kdf'] = 'none'
    with open(p, 'w') as f: json.dump(data, f)
    out = render(d)
    assert 'forge_secrets_total 2' in out, out
    assert 'forge_secrets_weak 1' in out, out
print('OK')" | grep -q '^OK$'; then pass "N-55 counts correct"; else fail "counts wrong"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
