#!/usr/bin/env bash
# Test: F-2.05 auto-users-table on auth detection + F-3.16 subscription sync.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# F-2.05 auto users table

# 1. detecting an auth provider also creates a users table
if run_py "
import tempfile
from forge.spec_detector import ForgeRequirements
from forge.provisioner import provision
from forge.services.database import open_engine, introspect
with tempfile.TemporaryDirectory() as d:
    req = ForgeRequirements(none=False, auth_providers=['google'])
    res = provision(req, d)
    names = [t['name'] for t in introspect(open_engine(d))['tables']]
    assert 'users' in names, names
print('OK')" | grep -q '^OK$'; then pass "F-2.05 auth provider -> users table"; else fail "users not provisioned"; fi

# 2. existing users table not re-created
if run_py "
import tempfile
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
from forge.services.database import open_engine, introspect
with tempfile.TemporaryDirectory() as d:
    # Operator already declared their own users schema.
    req = ForgeRequirements(none=False,
        tables=[TableSpec(name='users', columns=['id pk', 'username text notnull unique'])],
        auth_providers=['google'])
    provision(req, d)
    cols = [c['name'] for t in introspect(open_engine(d))['tables']
            if t['name'] == 'users' for c in t['columns']]
    # Operator's columns win; forge does NOT overwrite with its default schema.
    assert 'username' in cols, cols
    # email column from forge's default schema should NOT have been added.
    assert 'email' not in cols, cols
print('OK')" | grep -q '^OK$'; then pass "F-2.05 operator-declared users preserved"; else fail "operator schema overwritten"; fi

# 3. dryrun does not create users table
if run_py "
import os, tempfile
from forge.spec_detector import ForgeRequirements
from forge.provisioner import provision
with tempfile.TemporaryDirectory() as d:
    req = ForgeRequirements(none=False, auth_providers=['google'])
    provision(req, d, dryrun=True)
    # No db.sqlite should exist after a pure-dryrun.
    assert not os.path.exists(os.path.join(d, 'db.sqlite'))
print('OK')" | grep -q '^OK$'; then pass "F-2.05 dryrun does not write"; else fail "dryrun wrote"; fi

# F-3.16 subscription sync

# 4. subscription webhook upserts row
if run_py "
import os, tempfile
from forge.services.payments import setup_provider, record_webhook_event
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'stripe', api_key_ref='K')
    record_webhook_event(d, 'stripe', {
        'type': 'customer.subscription.created',
        'data': {'object': {'id': 'sub_1', 'customer': 'cus_a', 'status': 'active'}},
    })
    rows = open_engine(d).execute(
        'SELECT external_id, customer_id, status FROM subscriptions'
    )
    assert len(rows) == 1
    assert rows[0]['external_id'] == 'sub_1'
    assert rows[0]['status'] == 'active'
print('OK')" | grep -q '^OK$'; then pass "F-3.16 sub.created upserts"; else fail "sub sync broken"; fi

# 5. subsequent updates replace status (UPSERT semantics)
if run_py "
import tempfile
from forge.services.payments import setup_provider, record_webhook_event
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'stripe', api_key_ref='K')
    record_webhook_event(d, 'stripe', {
        'type': 'customer.subscription.created',
        'data': {'object': {'id': 'sub_1', 'customer': 'cus_a', 'status': 'active'}},
    })
    record_webhook_event(d, 'stripe', {
        'type': 'customer.subscription.updated',
        'data': {'object': {'id': 'sub_1', 'customer': 'cus_a', 'status': 'canceled'}},
    })
    rows = open_engine(d).execute('SELECT status FROM subscriptions')
    assert len(rows) == 1 and rows[0]['status'] == 'canceled', rows
print('OK')" | grep -q '^OK$'; then pass "F-3.16 status update overwrites"; else fail "update did not overwrite"; fi

# 6. non-subscription events do not create the table
if run_py "
import tempfile
from forge.services.payments import setup_provider, record_webhook_event
from forge.services.database import open_engine, introspect
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'stripe', api_key_ref='K')
    record_webhook_event(d, 'stripe', {
        'type': 'invoice.payment_failed',
        'data': {'object': {'id': 'in_1'}},
    })
    # Only the engine's internal tables should exist (subscriptions absent).
    names = [t['name'] for t in introspect(open_engine(d))['tables']]
    assert 'subscriptions' not in names, names
print('OK')" | grep -q '^OK$'; then pass "F-3.16 unrelated events skip sync"; else fail "table created for non-sub"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
