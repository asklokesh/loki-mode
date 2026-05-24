#!/usr/bin/env bash
# Test: N-41 secret get_secret stamps last_used_at, surfaced in list.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. fresh secret: last_used_at is None
if run_py "
import tempfile
from forge.services.secrets.vault import set_secret, list_secrets
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'val')
    rows = list_secrets(d)
    assert rows[0]['last_used_at'] is None, rows[0]
print('OK')" | grep -q '^OK$'; then pass "N-41 fresh -> None"; else fail "fresh has timestamp"; fi

# 2. get_secret stamps last_used_at
if run_py "
import tempfile
from forge.services.secrets.vault import set_secret, get_secret, list_secrets
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'val')
    get_secret(d, 'A')
    rows = list_secrets(d)
    assert isinstance(rows[0]['last_used_at'], int), rows[0]
    assert rows[0]['last_used_at'] > 0
print('OK')" | grep -q '^OK$'; then pass "N-41 get stamps"; else fail "no stamp"; fi

# 3. last_used_at monotonically updates on each get
if run_py "
import tempfile, time
from forge.services.secrets.vault import set_secret, get_secret, list_secrets
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'val')
    get_secret(d, 'A')
    t1 = list_secrets(d)[0]['last_used_at']
    time.sleep(1.1)
    get_secret(d, 'A')
    t2 = list_secrets(d)[0]['last_used_at']
    assert t2 >= t1, (t1, t2)
print('OK')" | grep -q '^OK$'; then pass "N-41 monotonic update"; else fail "regressed"; fi

# 4. get on missing secret does not crash
if run_py "
import tempfile
from forge.services.secrets.vault import get_secret
with tempfile.TemporaryDirectory() as d:
    assert get_secret(d, 'ghost') is None
print('OK')" | grep -q '^OK$'; then pass "N-41 missing safe"; else fail "missing crashed"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
