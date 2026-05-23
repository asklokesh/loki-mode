#!/usr/bin/env bash
# Test: X-68 function warm + X-69 healing-mode legacy DB introspect.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# X-68 warm

# 1. warm a python function returns ok
if run_py "
import base64, tempfile
from forge.services.functions import deploy as fdeploy, warm
with tempfile.TemporaryDirectory() as d:
    fdeploy(d, 'pyfn', 'python', base64.b64encode(b'print(1)').decode())
    res = warm(d, 'pyfn')
    assert res['ok'] is True, res
    assert res['warmed'] is True
    assert res['runtime'] == 'python'
print('OK')" | grep -q '^OK$'; then pass "X-68 warm python"; else fail "warm python broken"; fi

# 2. warm a bun function returns ok (or unwarmed when bun missing)
if run_py "
import base64, tempfile
from forge.services.functions import deploy as fdeploy, warm
with tempfile.TemporaryDirectory() as d:
    fdeploy(d, 'tsfn', 'bun', base64.b64encode(b'console.log(1)').decode())
    res = warm(d, 'tsfn')
    # Either bun is installed and warmed=true, or not installed and we fall
    # through to file-read which is still ok.
    assert res['ok'] is True or res['warmed'] is False
print('OK')" | grep -q '^OK$'; then pass "X-68 warm bun"; else fail "warm bun crashed"; fi

# 3. warm unknown function reports function_not_found
if run_py "
import tempfile
from forge.services.functions import warm
with tempfile.TemporaryDirectory() as d:
    res = warm(d, 'no-such')
    assert res['ok'] is False
    assert res['error'] == 'function_not_found'
print('OK')" | grep -q '^OK$'; then pass "X-68 warm missing function"; else fail "missing fn not handled"; fi

# X-69 healing

# 4. propose_from_sqlite reads tables + columns
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    legacy = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(legacy)
    c.execute('CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE)')
    c.execute('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL)')
    c.execute('CREATE INDEX idx_email ON customers(email)')
    c.commit(); c.close()
    p = propose_from_sqlite(legacy)
    names = [op['add_table']['name'] for op in p['operations'] if 'add_table' in op]
    assert sorted(names) == ['customers','orders'], names
print('OK')" | grep -q '^OK$'; then pass "X-69 propose reads tables"; else fail "propose broken"; fi

# 5. propose skips forge-internal-looking tables
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    legacy = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(legacy)
    c.execute('CREATE TABLE _forge_x (id INTEGER PRIMARY KEY)')
    c.execute('CREATE TABLE real_data (id INTEGER PRIMARY KEY)')
    c.commit(); c.close()
    p = propose_from_sqlite(legacy)
    names = [op['add_table']['name'] for op in p['operations'] if 'add_table' in op]
    assert names == ['real_data'], names
print('OK')" | grep -q '^OK$'; then pass "X-69 skips forge-internal tables"; else fail "internal not skipped"; fi

# 6. propose maps PRIMARY KEY INTEGER -> id
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    legacy = os.path.join(d, 'l.sqlite')
    c = sqlite3.connect(legacy)
    c.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)')
    c.commit(); c.close()
    p = propose_from_sqlite(legacy)
    cols = p['operations'][0]['add_table']['columns']
    id_col = next(c for c in cols if c['name'] == 'id')
    assert id_col['type'] == 'id' and id_col.get('primary_key') is True
print('OK')" | grep -q '^OK$'; then pass "X-69 PK integer -> id alias"; else fail "PK mapping wrong"; fi

# 7. apply_proposal end-to-end recreates schema in forge
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite, apply_proposal
from forge.services.database import open_engine, introspect
with tempfile.TemporaryDirectory() as d:
    legacy = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(legacy)
    c.execute('CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL NOT NULL)')
    c.commit(); c.close()
    fd = os.path.join(d, '.loki', 'forge')
    os.makedirs(fd)
    p = propose_from_sqlite(legacy)
    res = apply_proposal(fd, p)
    assert res['applied'] and not res['errors']
    snap = introspect(open_engine(fd))
    assert 'orders' in [t['name'] for t in snap['tables']]
print('OK')" | grep -q '^OK$'; then pass "X-69 apply recreates schema"; else fail "apply broken"; fi

# 8. propose emits indices
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    legacy = os.path.join(d, 'l.sqlite')
    c = sqlite3.connect(legacy)
    c.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, email TEXT)')
    c.execute('CREATE UNIQUE INDEX idx_email ON t(email)')
    c.commit(); c.close()
    p = propose_from_sqlite(legacy)
    idx_ops = [op for op in p['operations'] if 'create_index' in op]
    assert any(o['create_index']['unique'] for o in idx_ops), idx_ops
print('OK')" | grep -q '^OK$'; then pass "X-69 propose emits indices"; else fail "indices missing"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
