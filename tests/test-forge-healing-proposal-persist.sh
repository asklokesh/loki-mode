#!/usr/bin/env bash
# Test: N-56 healing proposal persistence + diff.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. write_proposal creates .loki/healing/proposal.json
if run_py "
import os, tempfile
from forge.healing import write_proposal
with tempfile.TemporaryDirectory() as d:
    p = write_proposal(d, {'operations': [{'add_table': {'name': 'x'}}]})
    assert os.path.isfile(p), p
print('OK')" | grep -q '^OK$'; then pass "N-56 write_proposal persists"; else fail "no file"; fi

# 2. first diff: added_tables = all current tables, removed empty
if run_py "
import tempfile
from forge.healing import diff_proposal
with tempfile.TemporaryDirectory() as d:
    diff = diff_proposal(d,
        {'operations': [{'add_table': {'name': 'a'}},
                        {'add_table': {'name': 'b'}}]})
    assert diff['added_tables'] == ['a', 'b'], diff
    assert diff['removed_tables'] == []
    assert diff['prev_path'] is None
print('OK')" | grep -q '^OK$'; then pass "N-56 first diff"; else fail "wrong"; fi

# 3. after write, next diff is empty when same
if run_py "
import tempfile
from forge.healing import write_proposal, diff_proposal
with tempfile.TemporaryDirectory() as d:
    prop = {'operations': [{'add_table': {'name': 'a'}}]}
    write_proposal(d, prop)
    diff = diff_proposal(d, prop)
    assert diff['added_tables'] == [], diff
    assert diff['removed_tables'] == []
print('OK')" | grep -q '^OK$'; then pass "N-56 same -> empty diff"; else fail "false diff"; fi

# 4. removed_tables surfaces dropped tables
if run_py "
import tempfile
from forge.healing import write_proposal, diff_proposal
with tempfile.TemporaryDirectory() as d:
    write_proposal(d,
        {'operations': [{'add_table': {'name': 'a'}},
                        {'add_table': {'name': 'b'}}]})
    diff = diff_proposal(d,
        {'operations': [{'add_table': {'name': 'a'}}]})
    assert diff['removed_tables'] == ['b'], diff
print('OK')" | grep -q '^OK$'; then pass "N-56 removal detected"; else fail "removal missed"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
