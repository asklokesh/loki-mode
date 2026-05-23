#!/usr/bin/env bash
# Test: forge.services.payments - Stripe-shaped (Phase F-3).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. setup_provider rejects unknown provider
if run_py "
import tempfile
from forge.services.payments import setup_provider, PaymentsError
with tempfile.TemporaryDirectory() as d:
    try: setup_provider(d, 'square', api_key_ref='X')
    except PaymentsError: print('OK'); raise SystemExit
    raise AssertionError('square accepted')
" | grep -q '^OK$'; then pass "unknown provider rejected"; else fail "unknown provider accepted"; fi

# 2. setup_provider rejects raw secret in api_key_ref
if run_py "
import tempfile
from forge.services.payments import setup_provider, PaymentsError
with tempfile.TemporaryDirectory() as d:
    try: setup_provider(d, 'stripe', api_key_ref='sk_live_xxx!')
    except PaymentsError: print('OK'); raise SystemExit
    raise AssertionError('raw key accepted')
" | grep -q '^OK$'; then pass "raw api_key_ref rejected"; else fail "raw key accepted"; fi

# 3. setup_provider happy path
if run_py "
import os, tempfile
from forge.services.payments import setup_provider
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'stripe', api_key_ref='STRIPE_KEY',
                   webhook_secret_ref='STRIPE_WEBHOOK')
    p = os.path.join(d, 'payments', 'stripe.json')
    assert os.path.exists(p)
    assert (os.stat(p).st_mode & 0o777) == 0o600
print('OK')" | grep -q '^OK$'; then pass "stripe setup_provider"; else fail "setup_provider broken"; fi

# 4. create_product happy path + validation
if run_py "
import tempfile
from forge.services.payments import setup_provider, create_product, list_products, PaymentsError
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'stripe', api_key_ref='K')
    rec = create_product(d, 'stripe', name='Pro',
                         prices=[{'amount':1000,'currency':'usd','interval':'month'}])
    assert rec['name'] == 'Pro' and len(rec['prices']) == 1
    assert len(list_products(d, 'stripe')) == 1
    for bad in [{'amount': -1, 'currency':'usd'},
                {'amount': 1000, 'currency':'!@'},
                {'amount': 1000, 'currency':'usd', 'interval':'fortnight'}]:
        try: create_product(d, 'stripe', name='X', prices=[bad])
        except PaymentsError: continue
        raise AssertionError(f'accepted: {bad!r}')
print('OK')" | grep -q '^OK$'; then pass "product create + validation"; else fail "product validation broken"; fi

# 5. register_webhook
if run_py "
import os, tempfile
from forge.services.payments import setup_provider, register_webhook
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'stripe', api_key_ref='K')
    rec = register_webhook(d, 'stripe', target_function='handle_stripe',
                           events=['invoice.paid','customer.subscription.created'])
    assert rec['target_function'] == 'handle_stripe'
    assert len(rec['events']) == 2
print('OK')" | grep -q '^OK$'; then pass "register_webhook"; else fail "webhook register broken"; fi

# 6. record_webhook_event appends to jsonl
if run_py "
import os, tempfile, json
from forge.services.payments import setup_provider, record_webhook_event
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'stripe', api_key_ref='K')
    record_webhook_event(d, 'stripe', {'type':'invoice.paid','id':'evt_1'})
    record_webhook_event(d, 'stripe', {'type':'invoice.paid','id':'evt_2'})
    p = os.path.join(d, 'payments', 'stripe', 'webhook_events.jsonl')
    lines = open(p).readlines()
    assert len(lines) == 2, lines
print('OK')" | grep -q '^OK$'; then pass "webhook event log appends"; else fail "webhook log broken"; fi

# 7. verify_webhook_signature accepts valid
if run_py "
import hmac, hashlib, time
from forge.services.payments import verify_webhook_signature
secret = 'whsec_xxx'
ts = str(int(time.time()))
payload = b'{\"id\":\"evt_x\"}'
mac = hmac.new(secret.encode(), (ts+'.').encode() + payload, hashlib.sha256).hexdigest()
sig = f't={ts},v1={mac}'
assert verify_webhook_signature(secret, payload, sig) is True
print('OK')" | grep -q '^OK$'; then pass "verify_webhook_signature accepts valid"; else fail "valid sig rejected"; fi

# 8. verify_webhook_signature rejects bad signature
if run_py "
import time
from forge.services.payments import verify_webhook_signature
ts = str(int(time.time()))
sig = f't={ts},v1={\"0\"*64}'
assert verify_webhook_signature('s', b'p', sig) is False
print('OK')" | grep -q '^OK$'; then pass "verify_webhook_signature rejects bad"; else fail "bad sig accepted"; fi

# 9. verify_webhook_signature rejects stale ts
if run_py "
from forge.services.payments import verify_webhook_signature
old_ts = '1'  # 1970
sig = f't={old_ts},v1=abc'
assert verify_webhook_signature('s', b'p', sig) is False
print('OK')" | grep -q '^OK$'; then pass "verify rejects stale timestamp"; else fail "stale ts accepted"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
