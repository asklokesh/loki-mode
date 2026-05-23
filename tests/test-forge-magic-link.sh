#!/usr/bin/env bash
# Test: forge.services.auth.magic_link (X-20).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. issue mints a token
if run_py "
import tempfile
from forge.services.auth import magic_link_issue
with tempfile.TemporaryDirectory() as d:
    res = magic_link_issue(d, 'user@example.com')
    assert isinstance(res['token'], str) and len(res['token']) >= 32
    assert res['email'] == 'user@example.com'
    assert res['expires_at'] > 0
print('OK')" | grep -q '^OK$'; then pass "issue mints token"; else fail "issue broken"; fi

# 2. invalid email rejected
if run_py "
import tempfile
from forge.services.auth import magic_link_issue
from forge.services.auth.magic_link import MagicLinkError
with tempfile.TemporaryDirectory() as d:
    for bad in ['noemail','@nope.com','user@','user @example.com']:
        try: magic_link_issue(d, bad)
        except MagicLinkError: continue
        raise AssertionError(f'accepted: {bad!r}')
print('OK')" | grep -q '^OK$'; then pass "invalid email rejected"; else fail "bad email accepted"; fi

# 3. redirect_url must be http(s) when provided
if run_py "
import tempfile
from forge.services.auth import magic_link_issue
from forge.services.auth.magic_link import MagicLinkError
with tempfile.TemporaryDirectory() as d:
    try: magic_link_issue(d, 'u@x.com', redirect_url='javascript:alert(1)')
    except MagicLinkError: print('OK'); raise SystemExit
    raise AssertionError('javascript: accepted')
" | grep -q '^OK$'; then pass "javascript: redirect rejected"; else fail "js redirect accepted"; fi

# 4. redeem happy path returns JWT
if run_py "
import tempfile
from forge.services.auth import magic_link_issue, magic_link_redeem, verify_token
with tempfile.TemporaryDirectory() as d:
    token = magic_link_issue(d, 'u@x.com')['token']
    res = magic_link_redeem(d, token)
    assert res['ok'] is True
    assert res['email'] == 'u@x.com'
    claims = verify_token(d, res['token'])
    assert claims['email'] == 'u@x.com'
    assert claims['via'] == 'magic-link'
print('OK')" | grep -q '^OK$'; then pass "redeem returns valid JWT"; else fail "redeem broken"; fi

# 5. single-use: second redeem fails
if run_py "
import tempfile
from forge.services.auth import magic_link_issue, magic_link_redeem
with tempfile.TemporaryDirectory() as d:
    token = magic_link_issue(d, 'u@x.com')['token']
    magic_link_redeem(d, token)
    res = magic_link_redeem(d, token)
    assert res['ok'] is False and res['error'] == 'consumed_or_unknown'
print('OK')" | grep -q '^OK$'; then pass "single-use enforced"; else fail "token reused"; fi

# 6. unknown token rejected
if run_py "
import tempfile
from forge.services.auth import magic_link_redeem
with tempfile.TemporaryDirectory() as d:
    res = magic_link_redeem(d, 'x' * 40)
    assert res['ok'] is False
print('OK')" | grep -q '^OK$'; then pass "unknown token rejected"; else fail "unknown token accepted"; fi

# 7. expired token rejected
if run_py "
import json, os, tempfile, time
from forge.services.auth import magic_link_issue, magic_link_redeem
with tempfile.TemporaryDirectory() as d:
    token = magic_link_issue(d, 'u@x.com', ttl_seconds=30)['token']
    # Patch the record to be expired.
    p = os.path.join(d, 'auth', 'magic_links.jsonl')
    lines = open(p).readlines()
    rec = json.loads(lines[0])
    rec['expires_at'] = int(time.time()) - 1
    open(p, 'w').write(json.dumps(rec) + '\n')
    res = magic_link_redeem(d, token)
    assert res['ok'] is False and res['error'] == 'expired', res
print('OK')" | grep -q '^OK$'; then pass "expired token rejected"; else fail "expired token accepted"; fi

# 8. redeem creates the user lazily
if run_py "
import tempfile
from forge.services.auth import magic_link_issue, magic_link_redeem, list_users
with tempfile.TemporaryDirectory() as d:
    assert list_users(d) == []
    token = magic_link_issue(d, 'new@x.com')['token']
    magic_link_redeem(d, token)
    users = list_users(d)
    assert len(users) == 1
    assert users[0]['email'] == 'new@x.com'
print('OK')" | grep -q '^OK$'; then pass "redeem creates user lazily"; else fail "user not created"; fi

# 9. malformed token shape rejected
if run_py "
import tempfile
from forge.services.auth import magic_link_redeem
with tempfile.TemporaryDirectory() as d:
    assert magic_link_redeem(d, '')['ok'] is False
    assert magic_link_redeem(d, 'short')['ok'] is False
    assert magic_link_redeem(d, 123)['ok'] is False  # type: ignore
print('OK')" | grep -q '^OK$'; then pass "malformed token rejected"; else fail "malformed accepted"; fi

# 10. X-32: rate-limit per email (5/hour default)
if run_py "
import tempfile
from forge.services.auth import magic_link_issue
from forge.services.auth.magic_link import MagicLinkError
from forge.services.gateway.rate_limit import reset as _rlreset
_rlreset()
with tempfile.TemporaryDirectory() as d:
    # Burn the 5 mints/hour budget.
    for _ in range(5):
        magic_link_issue(d, 'u@x.com', rate_limit_per_hour=5)
    try:
        magic_link_issue(d, 'u@x.com', rate_limit_per_hour=5)
    except MagicLinkError as e:
        assert 'rate limit' in str(e), str(e)
        print('OK')
        raise SystemExit
    raise AssertionError('rate limit not enforced')
" | grep -q '^OK$'; then pass "X-32: magic-link rate-limit per email"; else fail "rate-limit broken"; fi

# 11. X-32: separate emails do not share budget
if run_py "
import tempfile
from forge.services.auth import magic_link_issue
from forge.services.gateway.rate_limit import reset as _rlreset
_rlreset()
with tempfile.TemporaryDirectory() as d:
    for _ in range(5): magic_link_issue(d, 'a@x.com', rate_limit_per_hour=5)
    # b@ should still be allowed.
    magic_link_issue(d, 'b@x.com', rate_limit_per_hour=5)
print('OK')" | grep -q '^OK$'; then pass "X-32: separate emails separate buckets"; else fail "buckets shared"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
