#!/usr/bin/env bash
# Test: forge.services.email (X-23).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. setup_provider happy path for each provider
if run_py "
import os, tempfile
from forge.services.email import setup_provider
with tempfile.TemporaryDirectory() as d:
    for prov in ('resend','sendgrid','postmark'):
        cfg = setup_provider(d, prov, api_key_ref=f'{prov.upper()}_KEY',
                              from_address=f'noreply@{prov}.example.com',
                              from_name='Forge App')
        assert cfg['provider'] == prov
        p = os.path.join(d, 'email', f'{prov}.json')
        assert (os.stat(p).st_mode & 0o777) == 0o600
print('OK')" | grep -q '^OK$'; then pass "setup_provider for all 3 providers"; else fail "setup_provider broken"; fi

# 2. unsupported provider rejected
if run_py "
import tempfile
from forge.services.email import setup_provider, EmailError
with tempfile.TemporaryDirectory() as d:
    try: setup_provider(d, 'mailtrap', api_key_ref='K', from_address='a@b.com')
    except EmailError: print('OK'); raise SystemExit
    raise AssertionError('mailtrap accepted')
" | grep -q '^OK$'; then pass "unsupported provider rejected"; else fail "unsupported accepted"; fi

# 3. invalid from_address rejected
if run_py "
import tempfile
from forge.services.email import setup_provider, EmailError
with tempfile.TemporaryDirectory() as d:
    try: setup_provider(d, 'resend', api_key_ref='K', from_address='not-an-email')
    except EmailError: print('OK'); raise SystemExit
    raise AssertionError('bad from accepted')
" | grep -q '^OK$'; then pass "bad from_address rejected"; else fail "bad from accepted"; fi

# 4. send records to sent.jsonl with status=recorded when no dispatch fn
if run_py "
import tempfile
from forge.services.email import setup_provider, send, list_sent
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'resend', api_key_ref='K', from_address='a@b.com')
    rec = send(d, 'resend', to='u@x.com', subject='hi',
               body_text='hello')
    assert rec['status'] == 'recorded'
    assert rec['to'] == 'u@x.com'
    assert len(list_sent(d, 'resend')) == 1
print('OK')" | grep -q '^OK$'; then pass "send records with no dispatch fn"; else fail "send broken"; fi

# 5. send rejects bad email
if run_py "
import tempfile
from forge.services.email import setup_provider, send, EmailError
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'resend', api_key_ref='K', from_address='a@b.com')
    try: send(d, 'resend', to='nope', subject='s', body_text='b')
    except EmailError: print('OK'); raise SystemExit
    raise AssertionError('bad to accepted')
" | grep -q '^OK$'; then pass "send rejects bad to"; else fail "bad to accepted"; fi

# 6. magic_link.issue with email_provider dispatches
if run_py "
import tempfile
from forge.services.email import setup_provider
from forge.services.auth import magic_link_issue
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'resend', api_key_ref='K', from_address='a@b.com')
    res = magic_link_issue(d, 'u@x.com', email_provider='resend',
                            link_template='https://app/auth/magic?token={token}')
    assert 'email_record_id' in res or 'email_error' in res
print('OK')" | grep -q '^OK$'; then pass "magic-link wires through email"; else fail "magic-link email wire broken"; fi

# 7. send rejects unsupported provider
if run_py "
import tempfile
from forge.services.email import send, EmailError
with tempfile.TemporaryDirectory() as d:
    try: send(d, 'mailtrap', to='u@x.com', subject='s', body_text='b')
    except EmailError: print('OK'); raise SystemExit
    raise AssertionError('mailtrap accepted')
" | grep -q '^OK$'; then pass "send rejects unsupported provider"; else fail "unsupported send accepted"; fi

# 8. list_sent respects limit
if run_py "
import tempfile
from forge.services.email import setup_provider, send, list_sent
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'resend', api_key_ref='K', from_address='a@b.com')
    for i in range(5):
        send(d, 'resend', to=f'u{i}@x.com', subject='s', body_text='b')
    assert len(list_sent(d, 'resend', limit=3)) == 3
print('OK')" | grep -q '^OK$'; then pass "list_sent honors limit"; else fail "limit broken"; fi

# 9. X-33: default templates available without explicit register
if run_py "
import tempfile
from forge.services.email import list_templates, DEFAULT_TEMPLATES
with tempfile.TemporaryDirectory() as d:
    names = [t['name'] for t in list_templates(d)]
    assert set(DEFAULT_TEMPLATES) <= set(names), names
print('OK')" | grep -q '^OK$'; then pass "X-33 default templates loaded"; else fail "defaults missing"; fi

# 10. X-33: register_template overrides defaults
if run_py "
import tempfile
from forge.services.email import register_template, list_templates
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'magic_link', subject='Sign in to MyApp',
                      body_text='Click {link}')
    t = next(t for t in list_templates(d) if t['name'] == 'magic_link')
    assert t['subject'] == 'Sign in to MyApp'
print('OK')" | grep -q '^OK$'; then pass "X-33 register override"; else fail "override not applied"; fi

# 11. X-33: bad template name rejected
if run_py "
import tempfile
from forge.services.email import register_template, EmailError
with tempfile.TemporaryDirectory() as d:
    try: register_template(d, 'BadName', subject='s', body_text='t')
    except EmailError: print('OK'); raise SystemExit
    raise AssertionError('bad name accepted')
" | grep -q '^OK$'; then pass "X-33 bad template name rejected"; else fail "bad name accepted"; fi

# 12. X-33: send_template substitutes context
if run_py "
import tempfile
from forge.services.email import setup_provider, send_template, list_sent
with tempfile.TemporaryDirectory() as d:
    setup_provider(d, 'resend', api_key_ref='K', from_address='a@b.com')
    send_template(d, 'resend', template='welcome', to='u@x.com',
                  context={'product_name': 'Forgy', 'user_name': 'Alice',
                          'dashboard_url': 'https://app/x'})
    sent = list_sent(d, 'resend')[-1]
    assert 'Forgy' in sent['subject'], sent['subject']
print('OK')" | grep -q '^OK$'; then pass "X-33 send_template substitution"; else fail "substitution broken"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
