#!/usr/bin/env bash
# Test: N-24 magic-link redeem honors ?redirect= safely.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

if ! python3 -c "import fastapi" 2>/dev/null; then
    echo "SKIP: fastapi not available"; exit 0
fi

# 1. happy path with redirect: 302 to target with ?session=JWT
if run_py "
import os, tempfile
d = tempfile.mkdtemp()
os.chdir(d)
forge_dir = os.path.join(d, '.loki', 'forge')
os.makedirs(forge_dir, exist_ok=True)
from forge.services.auth import magic_link_issue
res = magic_link_issue(forge_dir, email='a@b.com')
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI()
register_forge_router(app)
c = TestClient(app)
r = c.get(f'/forge/auth/magic/redeem?token=' + res['token'] +
          '&redirect=https://app.example.com/cb',
          follow_redirects=False)
assert r.status_code == 302, (r.status_code, r.text)
loc = r.headers['location']
assert loc.startswith('https://app.example.com/cb'), loc
assert 'session=' in loc, loc
print('OK')" | grep -q '^OK$'; then pass "N-24 redirect 302 with session"; else fail "no redirect"; fi

# 2. unsafe scheme rejected
if run_py "
import os, tempfile
d = tempfile.mkdtemp()
os.chdir(d)
forge_dir = os.path.join(d, '.loki', 'forge')
os.makedirs(forge_dir, exist_ok=True)
from forge.services.auth import magic_link_issue
res = magic_link_issue(forge_dir, email='a@b.com')
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI()
register_forge_router(app)
c = TestClient(app)
r = c.get(f'/forge/auth/magic/redeem?token=' + res['token'] +
          '&redirect=javascript:alert(1)')
assert r.status_code == 400, (r.status_code, r.text)
print('OK')" | grep -q '^OK$'; then pass "N-24 javascript: rejected"; else fail "xss-redirect allowed"; fi

# 3. relative path rejected (no netloc)
if run_py "
import os, tempfile
d = tempfile.mkdtemp()
os.chdir(d)
forge_dir = os.path.join(d, '.loki', 'forge')
os.makedirs(forge_dir, exist_ok=True)
from forge.services.auth import magic_link_issue
res = magic_link_issue(forge_dir, email='a@b.com')
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI()
register_forge_router(app)
c = TestClient(app)
r = c.get(f'/forge/auth/magic/redeem?token=' + res['token'] +
          '&redirect=/local/path')
assert r.status_code == 400, (r.status_code, r.text)
print('OK')" | grep -q '^OK$'; then pass "N-24 relative path rejected"; else fail "relative allowed"; fi

# 4. no redirect param -> JSON response unchanged
if run_py "
import os, tempfile
d = tempfile.mkdtemp()
os.chdir(d)
forge_dir = os.path.join(d, '.loki', 'forge')
os.makedirs(forge_dir, exist_ok=True)
from forge.services.auth import magic_link_issue
res = magic_link_issue(forge_dir, email='a@b.com')
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI()
register_forge_router(app)
c = TestClient(app)
r = c.get(f'/forge/auth/magic/redeem?token=' + res['token'])
assert r.status_code == 200, r.status_code
assert r.json()['ok'] is True
print('OK')" | grep -q '^OK$'; then pass "N-24 no-redirect json kept"; else fail "json broke"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
