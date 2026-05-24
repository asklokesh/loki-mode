#!/usr/bin/env bash
# Test: N-48 list_secrets derives unused_for_days.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. fresh secret: unused_for_days is 0 (just created, never used)
if run_py "
import tempfile
from forge.services.secrets.vault import set_secret, list_secrets
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v')
    r = list_secrets(d)[0]
    assert r['unused_for_days'] == 0, r
print('OK')" | grep -q '^OK$'; then pass "N-48 fresh = 0 days"; else fail "wrong"; fi

# 2. last_used_at set 10 days ago -> 10
if run_py "
import json, os, tempfile, time
from forge.services.secrets.vault import set_secret, list_secrets, _vault_path
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v')
    p = _vault_path(d)
    with open(p) as f: data = json.load(f)
    data['entries']['A']['last_used_at'] = int(time.time()) - 10 * 86400
    with open(p, 'w') as f: json.dump(data, f)
    r = list_secrets(d)[0]
    assert r['unused_for_days'] == 10, r
print('OK')" | grep -q '^OK$'; then pass "N-48 ten days back"; else fail "wrong age"; fi

# 3. neither last_used_at nor created_at -> None
if run_py "
import json, os, tempfile
from forge.services.secrets.vault import set_secret, list_secrets, _vault_path
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'v')
    p = _vault_path(d)
    with open(p) as f: data = json.load(f)
    data['entries']['A'].pop('created_at', None)
    data['entries']['A'].pop('last_used_at', None)
    with open(p, 'w') as f: json.dump(data, f)
    r = list_secrets(d)[0]
    assert r['unused_for_days'] is None, r
print('OK')" | grep -q '^OK$'; then pass "N-48 no ref -> None"; else fail "wrong null"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
