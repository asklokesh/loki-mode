#!/usr/bin/env bash
# Test: N-05 healing mode topologically sorts add_table ops by FK graph.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. simple FK: orders -> users; ordering puts users first
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(p)
    c.executescript('''
        CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));
        CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
    ''')
    c.commit(); c.close()
    prop = propose_from_sqlite(p)
    adds = [op['add_table']['name'] for op in prop['operations'] if 'add_table' in op]
    assert adds.index('users') < adds.index('orders'), adds
print('OK')" | grep -q '^OK$'; then pass "N-05 simple FK ordering"; else fail "users not before orders"; fi

# 2. multi-level chain: comments -> posts -> users
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(p)
    c.executescript('''
        CREATE TABLE comments (id INTEGER PRIMARY KEY, post_id INTEGER REFERENCES posts(id));
        CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES users(id));
        CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
    ''')
    c.commit(); c.close()
    prop = propose_from_sqlite(p)
    adds = [op['add_table']['name'] for op in prop['operations'] if 'add_table' in op]
    assert adds.index('users') < adds.index('posts') < adds.index('comments'), adds
print('OK')" | grep -q '^OK$'; then pass "N-05 chain ordering"; else fail "chain order wrong"; fi

# 3. FK column carries 'references' in the add_table spec
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(p)
    c.executescript('''
        CREATE TABLE users (id INTEGER PRIMARY KEY);
        CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));
    ''')
    c.commit(); c.close()
    prop = propose_from_sqlite(p)
    orders = [op['add_table'] for op in prop['operations']
              if 'add_table' in op and op['add_table']['name'] == 'orders'][0]
    user_col = [c for c in orders['columns'] if c['name'] == 'user_id'][0]
    assert user_col.get('references') == {'table': 'users', 'column': 'id'}, user_col
print('OK')" | grep -q '^OK$'; then pass "N-05 references attached"; else fail "references missing"; fi

# 4. cycle yields a warning and does not infinite-loop
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(p)
    # SQLite allows cyclic FKs at CREATE time; foreign_keys are off
    # by default in the legacy file, which is fine for our PRAGMA read.
    c.executescript('''
        CREATE TABLE a (id INTEGER PRIMARY KEY, b_id INTEGER REFERENCES b(id));
        CREATE TABLE b (id INTEGER PRIMARY KEY, a_id INTEGER REFERENCES a(id));
    ''')
    c.commit(); c.close()
    prop = propose_from_sqlite(p)
    assert any('FK cycle' in w for w in prop['warnings']), prop['warnings']
    adds = [op['add_table']['name'] for op in prop['operations'] if 'add_table' in op]
    assert set(adds) == {'a', 'b'}, adds
print('OK')" | grep -q '^OK$'; then pass "N-05 cycle handled"; else fail "cycle broke"; fi

# 5. self-reference (table referencing itself) is not treated as a cycle
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(p)
    c.executescript('''
        CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES nodes(id));
    ''')
    c.commit(); c.close()
    prop = propose_from_sqlite(p)
    assert not any('FK cycle' in w for w in prop['warnings']), prop['warnings']
    adds = [op['add_table']['name'] for op in prop['operations'] if 'add_table' in op]
    assert adds == ['nodes'], adds
print('OK')" | grep -q '^OK$'; then pass "N-05 self-ref not a cycle"; else fail "self-ref tripped"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
