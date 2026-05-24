#!/usr/bin/env bash
# Test: N-02 forge_db_query_page wall-clock budget enforcement.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. budget_ms=0 (default) does not interfere with normal queries
if run_py "
import tempfile
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    eng = open_engine(d)
    eng.execute('CREATE TABLE t(x INTEGER)', allow_writes=True)
    for i in range(50):
        eng.execute('INSERT INTO t VALUES (?)', [i], allow_writes=True)
    r = eng.query_page('SELECT * FROM t', limit=10)
    assert len(r['rows']) == 10, r
    assert r['has_more'] is True
print('OK')" | grep -q '^OK$'; then pass "N-02 budget=0 no interference"; else fail "default broken"; fi

# 2. budget_ms with plenty of time succeeds normally
if run_py "
import tempfile
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    eng = open_engine(d)
    eng.execute('CREATE TABLE t(x INTEGER)', allow_writes=True)
    for i in range(20):
        eng.execute('INSERT INTO t VALUES (?)', [i], allow_writes=True)
    r = eng.query_page('SELECT * FROM t', limit=100, budget_ms=5000)
    assert len(r['rows']) == 20
print('OK')" | grep -q '^OK$'; then pass "N-02 generous budget succeeds"; else fail "spurious abort"; fi

# 3. tiny budget on a heavy recursive CTE aborts with budget error
if run_py "
import tempfile, sqlite3
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    eng = open_engine(d)
    # Recursive CTE that walks 10 million rows in-memory; should
    # blow past a 1ms budget.
    # Aggregation forces a full scan of all 10M rows before LIMIT
    # can short-circuit; the budget should trip well before count(*)
    # completes.
    sql = '''
        WITH RECURSIVE seq(n) AS (
            SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 10000000
        )
        SELECT count(*) AS c FROM seq
    '''
    try:
        eng.query_page(sql, limit=10, budget_ms=5)
        print('NO_ABORT')
    except sqlite3.OperationalError as e:
        msg = str(e)
        assert 'budget exceeded' in msg, msg
        print('OK')" | grep -q '^OK$'; then pass "N-02 tiny budget aborts heavy query"; else fail "did not abort"; fi

# 4. handler is cleared between calls (next call gets a fresh clock)
if run_py "
import tempfile
from forge.services.database import open_engine
with tempfile.TemporaryDirectory() as d:
    eng = open_engine(d)
    eng.execute('CREATE TABLE t(x INTEGER)', allow_writes=True)
    eng.execute('INSERT INTO t VALUES (1)', allow_writes=True)
    # Call with budget, then without -- the second call must not be
    # affected by a stale progress handler from the first.
    r1 = eng.query_page('SELECT * FROM t', limit=10, budget_ms=5000)
    r2 = eng.query_page('SELECT * FROM t', limit=10)
    assert len(r1['rows']) == 1 and len(r2['rows']) == 1
print('OK')" | grep -q '^OK$'; then pass "N-02 handler cleared between calls"; else fail "stale handler leak"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
