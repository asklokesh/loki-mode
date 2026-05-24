#!/usr/bin/env bash
# Test: N-22 weak_secrets returns just the HMAC-XOR fallback rows.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. empty vault -> []
if run_py "
import tempfile
from forge.services.secrets.vault import weak_secrets
with tempfile.TemporaryDirectory() as d:
    assert weak_secrets(d) == []
print('OK')" | grep -q '^OK$'; then pass "N-22 empty -> []"; else fail "non-empty"; fi

# 2. mixed: only HMAC-XOR rows surface (we mutate entries directly
#    so the test is independent of whether AES-GCM is available)
if run_py "
import json, os, tempfile
from forge.services.secrets.vault import set_secret, weak_secrets, _vault_path
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'x')
    set_secret(d, 'B', 'y')
    p = _vault_path(d)
    with open(p) as f: data = json.load(f)
    # Force A to look like a strong entry and B to look like fallback.
    data['entries']['A']['alg'] = 'AES-GCM-256'
    data['entries']['A']['kdf'] = 'raw32'
    data['entries']['B']['alg'] = 'HMAC-XOR'
    data['entries']['B']['kdf'] = 'none'
    with open(p, 'w') as f: json.dump(data, f)
    w = weak_secrets(d)
    names = [r['name'] for r in w]
    assert names == ['B'], names
    assert w[0]['fallback'] is True
print('OK')" | grep -q '^OK$'; then pass "N-22 only fallback rows"; else fail "wrong rows"; fi

# 3. all AES-GCM -> []
if run_py "
import tempfile
from forge.services.secrets.vault import set_secret, weak_secrets, list_secrets
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'x')
    rows = list_secrets(d)
    # Only run this check when crypto is actually available; HMAC-XOR
    # fallback environments would legitimately have fallback rows.
    if all(r['alg'] == 'AES-GCM-256' for r in rows):
        assert weak_secrets(d) == []
print('OK')" | grep -q '^OK$'; then pass "N-22 all strong -> []"; else fail "false weak"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
