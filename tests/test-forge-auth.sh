#!/usr/bin/env bash
# Test: forge.services.auth - JWT, providers, users (v7.6.0 Phase F-2).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. JWT sign + verify round-trip
if run_py "
import tempfile
from forge.services.auth import sign_token, verify_token
with tempfile.TemporaryDirectory() as d:
    tok = sign_token(d, {'sub':'u1','role':'admin'}, ttl_seconds=60)
    claims = verify_token(d, tok)
    assert claims['sub']=='u1' and claims['role']=='admin'
    assert 'exp' in claims and 'iat' in claims and 'jti' in claims
print('OK')" | grep -q '^OK$'; then
    pass "JWT sign + verify round-trip"
else
    fail "JWT round-trip broken"
fi

# 2. JWT rejects tampered signature
if run_py "
import tempfile
from forge.services.auth import sign_token, verify_token
with tempfile.TemporaryDirectory() as d:
    tok = sign_token(d, {'sub':'u'})
    h, p, s = tok.split('.')
    tampered = h + '.' + p + '.AAAAAAAAAA'
    try:
        verify_token(d, tampered)
    except ValueError as e:
        if 'signature' in str(e):
            print('OK')
            raise SystemExit
    raise AssertionError('tampered token accepted')
" | grep -q '^OK$'; then
    pass "JWT rejects tampered signature"
else
    fail "JWT accepted tampered signature"
fi

# 3. JWT rejects expired token
if run_py "
import tempfile, time
from forge.services.auth import sign_token, verify_token
with tempfile.TemporaryDirectory() as d:
    tok = sign_token(d, {'sub':'u'}, ttl_seconds=1)
    time.sleep(2)
    try:
        verify_token(d, tok)
    except ValueError as e:
        if 'expired' in str(e):
            print('OK')
            raise SystemExit
    raise AssertionError('expired token accepted')
" | grep -q '^OK$'; then
    pass "JWT rejects expired token"
else
    fail "JWT accepted expired token"
fi

# 4. JWT rejects malformed input
if run_py "
import tempfile
from forge.services.auth import verify_token
with tempfile.TemporaryDirectory() as d:
    for bad in ['', 'a', 'a.b', 'a.b.c.d']:
        try:
            verify_token(d, bad)
        except ValueError:
            continue
        raise AssertionError(f'accepted: {bad!r}')
print('OK')" | grep -q '^OK$'; then
    pass "JWT rejects malformed input"
else
    fail "JWT accepted malformed input"
fi

# 5. JWT signing key generated with 0600 perms
if run_py "
import tempfile, os
from forge.services.auth.sessions import _get_or_create_signing_key
with tempfile.TemporaryDirectory() as d:
    _get_or_create_signing_key(d)
    p = os.path.join(d, 'auth', 'keys', 'jwt.json')
    mode = os.stat(p).st_mode & 0o777
    assert mode == 0o600, oct(mode)
print('OK')" | grep -q '^OK$'; then
    pass "JWT signing key file mode 0600"
else
    fail "JWT signing key file mode wrong"
fi

# 6. Provider add + list + remove
if run_py "
import tempfile
from forge.services.auth import add_provider, list_providers, remove_provider
with tempfile.TemporaryDirectory() as d:
    add_provider(d, 'google', {'client_id':'x'})
    add_provider(d, 'github', {'client_id':'y'})
    names = [p.get('_provider') for p in list_providers(d)]
    assert set(names) == {'google','github'}, names
    assert remove_provider(d, 'github') is True
    names = [p.get('_provider') for p in list_providers(d)]
    assert names == ['google']
print('OK')" | grep -q '^OK$'; then
    pass "provider add/list/remove roundtrip"
else
    fail "provider CRUD broken"
fi

# 7. Provider rejects unknown name
if run_py "
import tempfile
from forge.services.auth import add_provider
with tempfile.TemporaryDirectory() as d:
    try:
        add_provider(d, 'no-such-provider', {})
    except ValueError:
        print('OK')
        raise SystemExit
    raise AssertionError('accepted unknown provider')
" | grep -q '^OK$'; then
    pass "unknown provider rejected"
else
    fail "unknown provider accepted"
fi

# 8. Provider rejects raw client_secret in config
if run_py "
import tempfile
from forge.services.auth import add_provider
with tempfile.TemporaryDirectory() as d:
    try:
        add_provider(d, 'google', {'client_id':'x','client_secret':'leak'})
    except ValueError:
        print('OK')
        raise SystemExit
    raise AssertionError('raw secret accepted')
" | grep -q '^OK$'; then
    pass "raw client_secret rejected in provider config"
else
    fail "raw client_secret accepted"
fi

# 9. create_user with email + password works; duplicate rejected
if run_py "
import tempfile
from forge.services.auth import create_user
with tempfile.TemporaryDirectory() as d:
    u = create_user(d, email='a@b.com', password='hunter2')
    assert u['email'] == 'a@b.com' and u['id']
    try:
        create_user(d, email='a@b.com', password='x')
    except ValueError:
        print('OK')
        raise SystemExit
    raise AssertionError('duplicate accepted')
" | grep -q '^OK$'; then
    pass "create_user happy path + duplicate rejection"
else
    fail "create_user round-trip broken"
fi

# 10. create_user rejects missing inputs
if run_py "
import tempfile
from forge.services.auth import create_user
with tempfile.TemporaryDirectory() as d:
    try:
        create_user(d)
    except ValueError:
        print('OK')
        raise SystemExit
    raise AssertionError('empty user accepted')
" | grep -q '^OK$'; then
    pass "create_user rejects empty input"
else
    fail "create_user accepted empty input"
fi

# 11. Password hash + verify
if run_py "
from forge.services.auth.sessions import hash_password, verify_password
h = hash_password('correct horse')
assert verify_password('correct horse', h) is True
assert verify_password('wrong', h) is False
print('OK')" | grep -q '^OK$'; then
    pass "password hash + verify"
else
    fail "password hash/verify broken"
fi

# 12. PBKDF2 iters at OWASP 2026 minimum (600k+)
if run_py "
from forge.services.auth.sessions import hash_password, _PBKDF2_ITERS
assert _PBKDF2_ITERS >= 600000, _PBKDF2_ITERS
h = hash_password('x')
assert h.startswith('pbkdf2_sha256\$')
parts = h.split('\$')
assert int(parts[1]) >= 600000
print('OK')" | grep -q '^OK$'; then
    pass "PBKDF2 iters meet OWASP 2026 minimum"
else
    fail "PBKDF2 iters below 600k"
fi

# 13. authorize_url generates PKCE challenge
if run_py "
import tempfile
from forge.services.auth import add_provider
from forge.services.auth.providers import authorize_url
with tempfile.TemporaryDirectory() as d:
    add_provider(d, 'google', {'client_id':'gid'})
    res = authorize_url(d, 'google', 'http://localhost/cb')
    assert 'code_challenge=' in res['authorize_url']
    assert 'code_challenge_method=S256' in res['authorize_url']
    assert len(res['code_verifier']) >= 43
print('OK')" | grep -q '^OK$'; then
    pass "authorize_url emits PKCE S256 challenge"
else
    fail "authorize_url PKCE flow broken"
fi

# 14. revoke_session marks all sessions revoked
if run_py "
import tempfile, sqlite3, os, time
from forge.services.auth import revoke_session, create_user
from forge.services.auth.sessions import _open_users_db, _utc_iso
with tempfile.TemporaryDirectory() as d:
    u = create_user(d, email='r@b.com', password='p')
    conn = _open_users_db(d)
    conn.execute('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL)',
                 ('s1', u['id'], 'h', _utc_iso(), _utc_iso()))
    conn.execute('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL)',
                 ('s2', u['id'], 'h', _utc_iso(), _utc_iso()))
    conn.close()
    n = revoke_session(d, u['id'])
    assert n == 2, n
print('OK')" | grep -q '^OK$'; then
    pass "revoke_session marks all sessions"
else
    fail "revoke_session broken"
fi

# 15. RBAC has_scope honors hierarchy
if run_py "
import tempfile
from forge.services.auth.rbac import grant, has_scope
with tempfile.TemporaryDirectory() as d:
    grant(d, 'u1', 'res:x', 'write')
    assert has_scope(d, 'u1', 'res:x', 'read') is True
    assert has_scope(d, 'u1', 'res:x', 'write') is True
    assert has_scope(d, 'u1', 'res:x', 'control') is False
    assert has_scope(d, 'u1', 'res:other', 'read') is False
print('OK')" | grep -q '^OK$'; then
    pass "RBAC scope hierarchy"
else
    fail "RBAC scope check broken"
fi

# 16. RBAC rejects unknown scope
if run_py "
import tempfile
from forge.services.auth.rbac import grant
with tempfile.TemporaryDirectory() as d:
    try:
        grant(d, 'u1', 'r', 'superadmin')
    except ValueError:
        print('OK')
        raise SystemExit
    raise AssertionError('unknown scope accepted')
" | grep -q '^OK$'; then
    pass "RBAC rejects unknown scope"
else
    fail "RBAC accepted unknown scope"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
