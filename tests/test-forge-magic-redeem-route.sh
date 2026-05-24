#!/usr/bin/env bash
# Test: N-10 /forge/auth/magic/redeem route wires redeem() into HTTP.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

if ! python3 -c "import fastapi" 2>/dev/null; then
    echo "SKIP: fastapi not available"
    exit 0
fi

# Build a minimal FastAPI app that mounts the forge router, then drive
# it via TestClient. Each assertion is its own subprocess so we get a
# clean state per case.

# 1. missing token -> 422
if run_py "
import os, tempfile
os.environ['TARGET_DIR'] = tempfile.mkdtemp()
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router as register
app = FastAPI()
register(app)
c = TestClient(app)
r = c.get('/forge/auth/magic/redeem')
assert r.status_code == 422, r.status_code
print('OK')" | grep -q '^OK$'; then pass "N-10 missing token -> 422"; else fail "wrong status for missing"; fi

# 2. unknown token -> 404
if run_py "
import os, tempfile
os.environ['TARGET_DIR'] = tempfile.mkdtemp()
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router as register
app = FastAPI()
register(app)
c = TestClient(app)
r = c.get('/forge/auth/magic/redeem?token=' + 'x' * 64)
assert r.status_code == 404, r.status_code
body = r.json()
assert body['error'] == 'consumed_or_unknown', body
print('OK')" | grep -q '^OK$'; then pass "N-10 unknown token -> 404"; else fail "wrong status for unknown"; fi

# 3. short token -> 422
if run_py "
import os, tempfile
os.environ['TARGET_DIR'] = tempfile.mkdtemp()
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router as register
app = FastAPI()
register(app)
c = TestClient(app)
r = c.get('/forge/auth/magic/redeem?token=short')
assert r.status_code == 422, r.status_code
print('OK')" | grep -q '^OK$'; then pass "N-10 short token -> 422"; else fail "short token not 422"; fi

# 4. happy path: issue then redeem returns ok+jwt
if run_py "
import os, tempfile, json
d = tempfile.mkdtemp()
os.chdir(d)
forge_dir = os.path.join(d, '.loki', 'forge')
os.makedirs(forge_dir, exist_ok=True)
from forge.services.auth import magic_link_issue
res = magic_link_issue(forge_dir, email='a@b.com')
token = res['token']
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router as register
app = FastAPI()
register(app)
c = TestClient(app)
r = c.get(f'/forge/auth/magic/redeem?token={token}')
assert r.status_code == 200, (r.status_code, r.text)
body = r.json()
assert body['ok'] is True, body
assert 'jwt' in body or 'token' in body, body
print('OK')" | grep -q '^OK$'; then pass "N-10 happy path returns jwt"; else fail "happy path broken"; fi

# 5. token cannot be redeemed twice
if run_py "
import os, tempfile
d = tempfile.mkdtemp()
os.chdir(d)
forge_dir = os.path.join(d, '.loki', 'forge')
os.makedirs(forge_dir, exist_ok=True)
from forge.services.auth import magic_link_issue
res = magic_link_issue(forge_dir, email='a@b.com')
token = res['token']
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router as register
app = FastAPI()
register(app)
c = TestClient(app)
r1 = c.get(f'/forge/auth/magic/redeem?token={token}')
assert r1.status_code == 200, r1.status_code
r2 = c.get(f'/forge/auth/magic/redeem?token={token}')
assert r2.status_code == 404, r2.status_code
print('OK')" | grep -q '^OK$'; then pass "N-10 single-use enforced"; else fail "double redeem allowed"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
