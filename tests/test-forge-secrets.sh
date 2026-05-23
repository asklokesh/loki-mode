#!/usr/bin/env bash
# Test: forge.services.secrets - vault + rotation (Phase F-3).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. set + get + delete roundtrip
if run_py "
import tempfile
from forge.services.secrets import set_secret, get_secret, list_secrets, delete_secret
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'STRIPE_KEY', 'sk_test_xxx')
    assert get_secret(d, 'STRIPE_KEY') == 'sk_test_xxx'
    names = [s['name'] for s in list_secrets(d)]
    assert names == ['STRIPE_KEY']
    assert delete_secret(d, 'STRIPE_KEY') is True
    assert get_secret(d, 'STRIPE_KEY') is None
print('OK')" | grep -q '^OK$'; then pass "vault set/get/delete"; else fail "vault CRUD broken"; fi

# 2. invalid secret names rejected
if run_py "
import tempfile
from forge.services.secrets import set_secret, SecretError
with tempfile.TemporaryDirectory() as d:
    for bad in ['', '_leading', 'has space', 'with-dash', 'with.dot']:
        try: set_secret(d, bad, 'x')
        except SecretError: continue
        raise AssertionError(f'accepted: {bad!r}')
print('OK')" | grep -q '^OK$'; then pass "bad secret names rejected"; else fail "bad name accepted"; fi

# 3. value size cap
if run_py "
import tempfile
from forge.services.secrets import set_secret, SecretError
with tempfile.TemporaryDirectory() as d:
    try: set_secret(d, 'X', 'x' * (65 * 1024))
    except SecretError: print('OK'); raise SystemExit
    raise AssertionError('over-cap accepted')
" | grep -q '^OK$'; then pass "value size cap enforced"; else fail "size cap leak"; fi

# 4. list does not echo values
if run_py "
import tempfile
from forge.services.secrets import set_secret, list_secrets
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'STRIPE_KEY', 'sk_test_super_secret_xxx')
    for s in list_secrets(d):
        assert 'value' not in s and 'ct' not in s
        assert 'sk_test' not in str(s)
print('OK')" | grep -q '^OK$'; then pass "list does not echo values"; else fail "list leaked value"; fi

# 5. ciphertext on disk does not contain plaintext
if run_py "
import os, tempfile
from forge.services.secrets import set_secret
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'STRIPE_KEY', 'sk_live_PLAINTEXT_LEAK_PROBE')
    vault = open(os.path.join(d, 'secrets.vault'), 'rb').read()
    assert b'PLAINTEXT_LEAK_PROBE' not in vault, 'plaintext on disk!'
print('OK')" | grep -q '^OK$'; then pass "no plaintext on disk"; else fail "plaintext leaked to disk"; fi

# 6. master key file is 0600
if run_py "
import os, tempfile
from forge.services.secrets import set_secret
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'X', 'y')
    p = os.path.join(d, '.master.key')
    if os.path.exists(p):
        mode = os.stat(p).st_mode & 0o777
        assert mode == 0o600, oct(mode)
print('OK')" | grep -q '^OK$'; then pass "master key file mode 0600"; else fail "master key file mode wrong"; fi

# 7. rotation policy set + get
if run_py "
import tempfile
from forge.services.secrets import set_secret, set_rotation_policy, get_rotation_policy
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'API_KEY', 'value')
    set_rotation_policy(d, 'API_KEY', cron='@monthly', action='alert')
    p = get_rotation_policy(d, 'API_KEY')
    assert p['action'] == 'alert' and p['cron'] == '@monthly'
print('OK')" | grep -q '^OK$'; then pass "rotation policy set + get"; else fail "rotation policy broken"; fi

# 8. rotation policy rejects bad action
if run_py "
import tempfile
from forge.services.secrets import set_secret, set_rotation_policy
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'x')
    try: set_rotation_policy(d, 'A', action='wipe')
    except ValueError: print('OK'); raise SystemExit
    raise AssertionError('bad action accepted')
" | grep -q '^OK$'; then pass "bad rotation action rejected"; else fail "bad action accepted"; fi

# 9. rotation alert emits marker file
if run_py "
import os, tempfile
from forge.services.secrets import set_secret, set_rotation_policy, apply_rotation_policy
with tempfile.TemporaryDirectory() as d:
    set_secret(d, 'A', 'x')
    set_rotation_policy(d, 'A', action='alert')
    res = apply_rotation_policy(d, 'A')
    assert res['ok'] is True
    alerts = os.listdir(os.path.join(d, 'secrets', 'alerts'))
    assert len(alerts) == 1
print('OK')" | grep -q '^OK$'; then pass "rotation alert emits marker"; else fail "alert not emitted"; fi

# 10. rotation for unknown secret rejected
if run_py "
import tempfile
from forge.services.secrets import set_rotation_policy
with tempfile.TemporaryDirectory() as d:
    try: set_rotation_policy(d, 'NO_SUCH', action='alert')
    except ValueError: print('OK'); raise SystemExit
    raise AssertionError('unknown secret accepted')
" | grep -q '^OK$'; then pass "unknown secret rejected"; else fail "unknown secret accepted"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
