#!/usr/bin/env bash
# Test: N-49 deploy validates user_id against users table.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. no users table -> no validation, deploy proceeds
if run_py "
import tempfile
from forge.services.functions import deploy
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index',
           deployed_by_user_id='u_ghost')
print('OK')" | grep -q '^OK$'; then pass "N-49 no table = no check"; else fail "false reject"; fi

# 2. users table present + valid id -> deploy succeeds
if run_py "
import tempfile, sqlite3, os
from forge.services.functions import deploy
with tempfile.TemporaryDirectory() as d:
    db = os.path.join(d, 'db.sqlite')
    os.makedirs(d, exist_ok=True)
    c = sqlite3.connect(db)
    c.executescript('CREATE TABLE users (id TEXT PRIMARY KEY);')
    c.execute('INSERT INTO users VALUES (?)', ('u_alice',))
    c.commit(); c.close()
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index',
           deployed_by_user_id='u_alice')
print('OK')" | grep -q '^OK$'; then pass "N-49 valid id accepted"; else fail "valid rejected"; fi

# 3. users table present + unknown id -> FunctionError
if run_py "
import tempfile, sqlite3, os
from forge.services.functions import deploy, FunctionError
with tempfile.TemporaryDirectory() as d:
    db = os.path.join(d, 'db.sqlite')
    os.makedirs(d, exist_ok=True)
    c = sqlite3.connect(db)
    c.executescript('CREATE TABLE users (id TEXT PRIMARY KEY);')
    c.execute('INSERT INTO users VALUES (?)', ('u_alice',))
    c.commit(); c.close()
    try:
        deploy(d, name='hello', runtime='python',
               source_b64='cHJpbnQoIm9rIikK', entry='index',
               deployed_by_user_id='u_typo')
        print('NO_RAISE')
    except FunctionError as e:
        assert 'not found' in str(e), e
        print('OK')" | grep -q '^OK$'; then pass "N-49 typo caught"; else fail "typo allowed"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
