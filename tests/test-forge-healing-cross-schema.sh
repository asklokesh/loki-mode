#!/usr/bin/env bash
# Test: N-19 healing flags cross-schema FK references as warnings.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. dangling FK to a table not in proposal -> warning
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(p)
    c.executescript('''
        CREATE TABLE orders (id INTEGER PRIMARY KEY,
                             user_id INTEGER REFERENCES users(id));
    ''')
    c.commit(); c.close()
    prop = propose_from_sqlite(p)
    assert any('users' in w and 'cross-schema or dropped' in w
               for w in prop['warnings']), prop['warnings']
print('OK')" | grep -q '^OK$'; then pass "N-19 dangling FK flagged"; else fail "no warning"; fi

# 2. FK to an in-proposal table emits no cross-schema warning
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(p)
    c.executescript('''
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE orders (id INTEGER PRIMARY KEY,
                             user_id INTEGER REFERENCES users(id));
    ''')
    c.commit(); c.close()
    prop = propose_from_sqlite(p)
    assert not any('cross-schema or dropped' in w
                   for w in prop['warnings']), prop['warnings']
print('OK')" | grep -q '^OK$'; then pass "N-19 valid FK no warning"; else fail "false warning"; fi

# 3. self-reference does not trigger the warning
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(p)
    c.executescript('''
        CREATE TABLE nodes (id INTEGER PRIMARY KEY,
                            parent INTEGER REFERENCES nodes(id));
    ''')
    c.commit(); c.close()
    prop = propose_from_sqlite(p)
    assert not any('cross-schema or dropped' in w
                   for w in prop['warnings']), prop['warnings']
print('OK')" | grep -q '^OK$'; then pass "N-19 self-ref clean"; else fail "self-ref flagged"; fi

# 4. mixed: valid + dangling -> only the dangling one warns
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(p)
    c.executescript('''
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE orders (id INTEGER PRIMARY KEY,
                             user_id INTEGER REFERENCES users(id),
                             ledger_id INTEGER REFERENCES external_ledger(id));
    ''')
    c.commit(); c.close()
    prop = propose_from_sqlite(p)
    warns = [w for w in prop['warnings'] if 'cross-schema or dropped' in w]
    assert len(warns) == 1, warns
    assert 'external_ledger' in warns[0]
print('OK')" | grep -q '^OK$'; then pass "N-19 mixed precise"; else fail "imprecise warn"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
