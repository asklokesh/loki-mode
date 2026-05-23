#!/usr/bin/env bash
# Test: forge dashboard router + migration review record (Phase F-2).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. dashboard/forge_router.py parses
if python3 -c "import ast; ast.parse(open('$ROOT/dashboard/forge_router.py').read())" 2>/dev/null; then
    pass "forge_router.py parses"
else
    fail "forge_router.py syntax error"
fi

# 2. register_forge_router function exists with expected signature
if grep -q '^def register_forge_router(app)' "$ROOT/dashboard/forge_router.py"; then
    pass "register_forge_router(app) defined"
else
    fail "register_forge_router(app) missing"
fi

# 3. Expected routes declared in source
for route in '/api/forge/state' '/api/forge/database/tables' \
             '/api/forge/database/migrations' '/api/forge/storage/buckets' \
             '/api/forge/functions' '/api/forge/gateway/routes'; do
    if grep -qE "\"$route\"" "$ROOT/dashboard/forge_router.py"; then
        pass "route declared: $route"
    else
        fail "route missing: $route"
    fi
done

# 4. server.py wires the router via optional import
if grep -q 'register_forge_router(app)' "$ROOT/dashboard/server.py"; then
    pass "server.py calls register_forge_router(app)"
else
    fail "server.py does not register forge router"
fi

# 5. Server wire-up is inside try/except (optional - failures non-fatal)
if grep -B 1 'from .forge_router import register_forge_router' "$ROOT/dashboard/server.py" | grep -q '^try:'; then
    pass "forge_router import is optional (try/except)"
else
    fail "forge_router import not optional"
fi

# 6. Migration apply emits a council review record under .loki/quality/forge-migrations/
if run_py "
import os, tempfile
from forge.services.database import open_engine, migrate_apply

with tempfile.TemporaryDirectory() as tdir:
    # Mimic project layout: <tdir>/.loki/forge/db.sqlite
    project = os.path.join(tdir, 'proj')
    forge_dir = os.path.join(project, '.loki', 'forge')
    os.makedirs(forge_dir, exist_ok=True)
    e = open_engine(forge_dir)
    res = migrate_apply(e, {'operations':[{'add_table':{
        'name':'t','columns':['id pk']}}],'summary':'add t'})
    review_dir = os.path.join(project, '.loki', 'quality', 'forge-migrations')
    assert os.path.isdir(review_dir), 'review dir missing'
    files = os.listdir(review_dir)
    assert any(f.endswith('.json') for f in files), files
    import json
    with open(os.path.join(review_dir, files[0])) as f:
        rec = json.load(f)
    assert rec['schema'] == 'loki.forge.migration.review/v1'
    assert rec['migration_id'] == res['migration_id']
print('OK')" | grep -q '^OK$'; then
    pass "migration_apply emits review record"
else
    fail "review record not emitted"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
