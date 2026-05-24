#!/usr/bin/env bash
# Test: N-37 propose_from_sqlite surfaces source/accepted counts.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. counts present + numeric
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(p)
    c.executescript('CREATE TABLE a (id INTEGER PRIMARY KEY);')
    c.commit(); c.close()
    prop = propose_from_sqlite(p)
    assert isinstance(prop.get('source_table_count'), int), prop
    assert isinstance(prop.get('accepted_table_count'), int), prop
print('OK')" | grep -q '^OK$'; then pass "N-37 counts present"; else fail "missing"; fi

# 2. forge-internal + hidden tables count in source but not accepted
if run_py "
import os, sqlite3, tempfile
from forge.healing import propose_from_sqlite
with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, 'legacy.sqlite')
    c = sqlite3.connect(p)
    c.executescript('''
        CREATE TABLE good (id INTEGER PRIMARY KEY);
        CREATE TABLE _forge_internal (id INTEGER);
    ''')
    c.commit(); c.close()
    prop = propose_from_sqlite(p)
    assert prop['source_table_count'] == 2, prop
    assert prop['accepted_table_count'] == 1, prop
print('OK')" | grep -q '^OK$'; then pass "N-37 filtered correctly"; else fail "ratio wrong"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
