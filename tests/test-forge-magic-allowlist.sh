#!/usr/bin/env bash
# Test: N-34 magic-link redirect honors LOKI_FORGE_MAGIC_REDIRECT_ALLOW.
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

# 1. allow-list set: matching host -> 302
if run_py "
import os, tempfile
os.environ['LOKI_FORGE_MAGIC_REDIRECT_ALLOW'] = 'app.example.com'
d = tempfile.mkdtemp()
os.chdir(d)
forge_dir = os.path.join(d, '.loki', 'forge')
os.makedirs(forge_dir, exist_ok=True)
from forge.services.auth import magic_link_issue
res = magic_link_issue(forge_dir, email='a@b.com')
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI(); register_forge_router(app)
c = TestClient(app)
r = c.get(f'/forge/auth/magic/redeem?token=' + res['token'] +
          '&redirect=https://app.example.com/cb', follow_redirects=False)
assert r.status_code == 302, (r.status_code, r.text)
print('OK')" | grep -q '^OK$'; then pass "N-34 allow-listed host ok"; else fail "blocked allowed host"; fi

# 2. allow-list set: non-matching host -> 400
if run_py "
import os, tempfile
os.environ['LOKI_FORGE_MAGIC_REDIRECT_ALLOW'] = 'app.example.com'
d = tempfile.mkdtemp()
os.chdir(d)
forge_dir = os.path.join(d, '.loki', 'forge')
os.makedirs(forge_dir, exist_ok=True)
from forge.services.auth import magic_link_issue
res = magic_link_issue(forge_dir, email='a@b.com')
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI(); register_forge_router(app)
c = TestClient(app)
r = c.get(f'/forge/auth/magic/redeem?token=' + res['token'] +
          '&redirect=https://evil.com/cb')
assert r.status_code == 400, (r.status_code, r.text)
print('OK')" | grep -q '^OK$'; then pass "N-34 outside-list blocked"; else fail "outside allowed"; fi

# 3. wildcard *.example.com matches subdomain
if run_py "
import os, tempfile
os.environ['LOKI_FORGE_MAGIC_REDIRECT_ALLOW'] = '*.example.com'
d = tempfile.mkdtemp()
os.chdir(d)
forge_dir = os.path.join(d, '.loki', 'forge')
os.makedirs(forge_dir, exist_ok=True)
from forge.services.auth import magic_link_issue
res = magic_link_issue(forge_dir, email='a@b.com')
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI(); register_forge_router(app)
c = TestClient(app)
r = c.get(f'/forge/auth/magic/redeem?token=' + res['token'] +
          '&redirect=https://app.example.com/cb', follow_redirects=False)
assert r.status_code == 302, (r.status_code, r.text)
print('OK')" | grep -q '^OK$'; then pass "N-34 wildcard suffix match"; else fail "wildcard failed"; fi

# 4. no allow-list set: any http(s) host still works (back-compat)
if run_py "
import os, tempfile
os.environ.pop('LOKI_FORGE_MAGIC_REDIRECT_ALLOW', None)
d = tempfile.mkdtemp()
os.chdir(d)
forge_dir = os.path.join(d, '.loki', 'forge')
os.makedirs(forge_dir, exist_ok=True)
from forge.services.auth import magic_link_issue
res = magic_link_issue(forge_dir, email='a@b.com')
from fastapi import FastAPI
from fastapi.testclient import TestClient
from dashboard.forge_router import register_forge_router
app = FastAPI(); register_forge_router(app)
c = TestClient(app)
r = c.get(f'/forge/auth/magic/redeem?token=' + res['token'] +
          '&redirect=https://any.example.com/cb', follow_redirects=False)
assert r.status_code == 302, (r.status_code, r.text)
print('OK')" | grep -q '^OK$'; then pass "N-34 unset list back-compat"; else fail "back-compat broke"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
