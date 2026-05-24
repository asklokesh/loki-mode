#!/usr/bin/env bash
# Test: N-08 list_secrets surfaces kdf + kdf_iterations + fallback flag.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. New entries carry kdf + kdf_iterations
if run_py "
import tempfile
from forge.services.secrets.vault import set_secret, list_secrets
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'API_KEY', 'sk-test')
    rows = list_secrets(d)
    assert len(rows) == 1
    r = rows[0]
    assert 'kdf' in r and 'kdf_iterations' in r and 'fallback' in r, r
    assert r['kdf'] in ('raw32', 'none'), r
    assert isinstance(r['kdf_iterations'], int), r
print('OK')" | grep -q '^OK$'; then pass "N-08 list surfaces kdf fields"; else fail "fields missing"; fi

# 2. fallback flag flips True for HMAC-XOR rows
if run_py "
import json, os, tempfile
from forge.services.secrets.vault import set_secret, list_secrets, _vault_path
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'API_KEY', 'x')
    p = _vault_path(d)
    with open(p) as f: data = json.load(f)
    data['entries']['API_KEY']['alg'] = 'HMAC-XOR'
    data['entries']['API_KEY']['kdf'] = 'none'
    data['entries']['API_KEY']['kdf_iterations'] = 0
    with open(p, 'w') as f: json.dump(data, f)
    rows = list_secrets(d)
    assert rows[0]['fallback'] is True, rows[0]
    assert rows[0]['kdf'] == 'none'
print('OK')" | grep -q '^OK$'; then pass "N-08 fallback flag for HMAC-XOR"; else fail "fallback not flagged"; fi

# 3. legacy entries without kdf field still report sensibly
if run_py "
import json, os, tempfile
from forge.services.secrets.vault import set_secret, list_secrets, _vault_path
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v')
    p = _vault_path(d)
    with open(p) as f: data = json.load(f)
    # Simulate an entry written before N-08 landed.
    data['entries']['A'].pop('kdf', None)
    data['entries']['A'].pop('kdf_iterations', None)
    with open(p, 'w') as f: json.dump(data, f)
    rows = list_secrets(d)
    # AES-GCM is the default; legacy AES-GCM rows infer raw32.
    if rows[0]['alg'] == 'AES-GCM-256':
        assert rows[0]['kdf'] == 'raw32', rows[0]
        assert rows[0]['fallback'] is False
    else:
        assert rows[0]['kdf'] == 'none', rows[0]
        assert rows[0]['fallback'] is True
    assert rows[0]['kdf_iterations'] == 0
print('OK')" | grep -q '^OK$'; then pass "N-08 legacy entries inferred"; else fail "legacy missing field"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
