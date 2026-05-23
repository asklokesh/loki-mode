#!/usr/bin/env bash
# Test: Lemon Squeezy + Paddle adapters + Stripe Connect (F-4).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. Lemon Squeezy setup + create product
if run_py "
import tempfile
from forge.services.payments import lemon_squeezy as ls
with tempfile.TemporaryDirectory() as d:
    ls.setup_provider(d, api_key_ref='LS_KEY', store_id='42')
    p = ls.create_product(d, name='Pro',
                          prices=[{'amount':1500,'currency':'usd','interval':'month'}])
    assert p['name'] == 'Pro'
    assert len(ls.list_products(d)) == 1
print('OK')" | grep -q '^OK$'; then pass "lemon-squeezy setup + product"; else fail "ls setup broken"; fi

# 2. Lemon Squeezy signature verification
if run_py "
import hashlib, hmac
from forge.services.payments.lemon_squeezy import verify_webhook_signature
secret = 'ls_test_secret'
payload = b'{\"meta\":{\"event_name\":\"order_created\"}}'
sig = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
assert verify_webhook_signature(secret, payload, sig) is True
assert verify_webhook_signature(secret, payload, '0' * 64) is False
print('OK')" | grep -q '^OK$'; then pass "lemon-squeezy sig verify"; else fail "ls sig broken"; fi

# 3. Paddle setup
if run_py "
import tempfile
from forge.services.payments import paddle
with tempfile.TemporaryDirectory() as d:
    paddle.setup_provider(d, api_key_ref='PADDLE_KEY', vendor_id='99')
    paddle.create_product(d, name='Basic',
                          prices=[{'amount':500,'currency':'eur','interval':'month'}])
    assert len(paddle.list_products(d)) == 1
print('OK')" | grep -q '^OK$'; then pass "paddle setup + product"; else fail "paddle setup broken"; fi

# 4. Paddle signature verification
if run_py "
import hashlib, hmac, time
from forge.services.payments.paddle import verify_webhook_signature
secret = 'paddle_secret'
ts = str(int(time.time()))
payload = b'{\"data\":{}}'
mac = hmac.new(secret.encode(), (ts + ':').encode() + payload, hashlib.sha256).hexdigest()
sig = f'ts={ts};h1={mac}'
assert verify_webhook_signature(secret, payload, sig) is True
sig_bad = f'ts={ts};h1={\"0\"*64}'
assert verify_webhook_signature(secret, payload, sig_bad) is False
print('OK')" | grep -q '^OK$'; then pass "paddle sig verify"; else fail "paddle sig broken"; fi

# 5. Paddle rejects stale ts
if run_py "
from forge.services.payments.paddle import verify_webhook_signature
assert verify_webhook_signature('s', b'p', 'ts=1;h1=abc') is False
print('OK')" | grep -q '^OK$'; then pass "paddle rejects stale ts"; else fail "paddle stale ts accepted"; fi

# 6. Stripe Connect record_account
if run_py "
import tempfile
from forge.services.payments.stripe_connect import record_account, list_accounts
with tempfile.TemporaryDirectory() as d:
    record_account(d, 'acct_123', 'user_1', country='US')
    record_account(d, 'acct_456', 'user_2', country='DE')
    assert len(list_accounts(d)) == 2
    assert len(list_accounts(d, owner_user_id='user_1')) == 1
print('OK')" | grep -q '^OK$'; then pass "stripe connect record + list"; else fail "stripe connect broken"; fi

# 7. Stripe Connect rejects bad account_id
if run_py "
import tempfile
from forge.services.payments.stripe_connect import record_account, ConnectError
with tempfile.TemporaryDirectory() as d:
    try: record_account(d, 'bogus', 'u')
    except ConnectError: print('OK'); raise SystemExit
    raise AssertionError('bogus accepted')
" | grep -q '^OK$'; then pass "stripe connect rejects bad id"; else fail "bogus id accepted"; fi

# 8. Stripe Connect status updates + effective status
if run_py "
import tempfile
from forge.services.payments.stripe_connect import record_account, update_status, get_effective_status
with tempfile.TemporaryDirectory() as d:
    record_account(d, 'acct_X', 'u')
    update_status(d, 'acct_X', 'enabled')
    update_status(d, 'acct_X', 'restricted')
    assert get_effective_status(d, 'acct_X') == 'restricted'
print('OK')" | grep -q '^OK$'; then pass "stripe connect status walk"; else fail "status walk broken"; fi

# 9. Stripe Connect rejects bad status
if run_py "
import tempfile
from forge.services.payments.stripe_connect import record_account, update_status, ConnectError
with tempfile.TemporaryDirectory() as d:
    record_account(d, 'acct_x', 'u')
    try: update_status(d, 'acct_x', 'super_active')
    except ConnectError: print('OK'); raise SystemExit
    raise AssertionError('bad status accepted')
" | grep -q '^OK$'; then pass "stripe connect rejects bad status"; else fail "bad status accepted"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
