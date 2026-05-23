#!/usr/bin/env bash
# Test: forge.services.auth.external - Auth0/Clerk/Kinde/Stytch/WorkOS (F-4).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. configure happy path for all 5 providers
if run_py "
import tempfile
from forge.services.auth.external import configure, list_external, SUPPORTED_EXTERNAL
with tempfile.TemporaryDirectory() as d:
    for name in SUPPORTED_EXTERNAL:
        configure(d, name, issuer=f'https://{name}.example.com',
                  audience=f'aud-{name}')
    lst = list_external(d)
    assert len(lst) == 5, lst
print('OK')" | grep -q '^OK$'; then pass "configure all 5 adapters"; else fail "configure broken"; fi

# 2. unsupported adapter rejected
if run_py "
import tempfile
from forge.services.auth.external import configure, ExternalAuthError
with tempfile.TemporaryDirectory() as d:
    try: configure(d, 'okta', issuer='https://o', audience='a')
    except ExternalAuthError: print('OK'); raise SystemExit
    raise AssertionError('okta accepted')
" | grep -q '^OK$'; then pass "unsupported adapter rejected"; else fail "unsupported accepted"; fi

# 3. non-http issuer rejected
if run_py "
import tempfile
from forge.services.auth.external import configure, ExternalAuthError
with tempfile.TemporaryDirectory() as d:
    try: configure(d, 'auth0', issuer='file:///etc', audience='a')
    except ExternalAuthError: print('OK'); raise SystemExit
    raise AssertionError('file:// accepted')
" | grep -q '^OK$'; then pass "non-http issuer rejected"; else fail "bad issuer accepted"; fi

# 4. config file mode is 0600
if run_py "
import os, tempfile
from forge.services.auth.external import configure
with tempfile.TemporaryDirectory() as d:
    configure(d, 'auth0', issuer='https://x.example.com', audience='a')
    p = os.path.join(d, 'auth', 'external', 'auth0.json')
    mode = os.stat(p).st_mode & 0o777
    assert mode == 0o600, oct(mode)
print('OK')" | grep -q '^OK$'; then pass "config file mode 0600"; else fail "config mode wrong"; fi

# 5. remove
if run_py "
import tempfile
from forge.services.auth.external import configure, remove_external
with tempfile.TemporaryDirectory() as d:
    configure(d, 'auth0', issuer='https://x.example.com', audience='a')
    assert remove_external(d, 'auth0') is True
    assert remove_external(d, 'auth0') is False
print('OK')" | grep -q '^OK$'; then pass "remove + idempotency"; else fail "remove broken"; fi

# 6. verify_token without jwks cache rejects with clear error
if run_py "
import tempfile
from forge.services.auth.external import configure, verify_token, ExternalAuthError
with tempfile.TemporaryDirectory() as d:
    configure(d, 'auth0', issuer='https://x.example.com', audience='a')
    try:
        verify_token(d, 'auth0', 'aaa.bbb.ccc')
    except ExternalAuthError as e:
        assert 'JWKS' in str(e) or 'jwks' in str(e), str(e)
        print('OK')
        raise SystemExit
    raise AssertionError('no cache accepted')
" | grep -q '^OK$'; then pass "verify rejects missing JWKS cache"; else fail "missing JWKS not handled"; fi

# 7. verify_token HS256 with provided cache + bad signature
if run_py "
import base64, json, tempfile
from forge.services.auth.external import configure, verify_token, ExternalAuthError
with tempfile.TemporaryDirectory() as d:
    configure(d, 'auth0', issuer='https://x.example.com', audience='a')
    # Tamper a token: signature is all zeros.
    h = base64.urlsafe_b64encode(json.dumps({'alg':'HS256','typ':'JWT','kid':'k1'}).encode()).rstrip(b'=').decode()
    p = base64.urlsafe_b64encode(json.dumps({'iss':'https://x.example.com','aud':'a','exp':9999999999}).encode()).rstrip(b'=').decode()
    s = 'A' * 43
    cache = {'keys':[{'kid':'k1','k': base64.urlsafe_b64encode(b'secretsecretsecretsecret').rstrip(b'=').decode()}]}
    # alg HS256 isn't in the configured allowed algs for auth0 (RS256 only),
    # so verify should reject with 'alg ... not allowed'.
    try: verify_token(d, 'auth0', h+'.'+p+'.'+s, jwks_cache=cache)
    except ExternalAuthError as e:
        assert 'alg' in str(e), str(e); print('OK'); raise SystemExit
    raise AssertionError('mismatched alg accepted')
" | grep -q '^OK$'; then pass "verify rejects mismatched alg"; else fail "alg mismatch accepted"; fi

# 8. issuer mismatch rejected
if run_py "
import base64, json, tempfile, hmac, hashlib
from forge.services.auth.external import configure, verify_token, ExternalAuthError
with tempfile.TemporaryDirectory() as d:
    configure(d, 'auth0', issuer='https://x.example.com', audience='a')
    # Patch the cfg to allow HS256 for this test (otherwise alg check trips first).
    import os, json as _j
    p = os.path.join(d, 'auth', 'external', 'auth0.json')
    cfg = _j.load(open(p))
    cfg['alg'] = ['HS256']
    _j.dump(cfg, open(p, 'w'))
    secret_b = b'secret-32-bytes-or-so-secret-32!'
    kid = 'k1'
    h = base64.urlsafe_b64encode(_j.dumps({'alg':'HS256','typ':'JWT','kid':kid}).encode()).rstrip(b'=').decode()
    pl = base64.urlsafe_b64encode(_j.dumps({'iss':'https://EVIL.example.com','aud':'a','exp':9999999999}).encode()).rstrip(b'=').decode()
    sig_bytes = hmac.new(secret_b, (h+'.'+pl).encode(), hashlib.sha256).digest()
    sig = base64.urlsafe_b64encode(sig_bytes).rstrip(b'=').decode()
    cache = {'keys':[{'kid':kid,'k': base64.urlsafe_b64encode(secret_b).rstrip(b'=').decode()}]}
    try: verify_token(d, 'auth0', h+'.'+pl+'.'+sig, jwks_cache=cache)
    except ExternalAuthError as e:
        assert 'issuer' in str(e), str(e); print('OK'); raise SystemExit
    raise AssertionError('issuer mismatch accepted')
" | grep -q '^OK$'; then pass "issuer mismatch rejected"; else fail "issuer mismatch accepted"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
