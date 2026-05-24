#!/usr/bin/env bash
# Test: N-60 unset_template drops default + all locale variants.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. default + 2 locales: unset_template drops all 3
if run_py "
import tempfile
from forge.services.email import (
    register_template, unset_template, list_templates,
)
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'w', subject='hi', body_text='x')
    register_template(d, 'w', subject='x', body_text='x', locale='fr')
    register_template(d, 'w', subject='x', body_text='x', locale='de')
    assert unset_template(d, 'w') is True
    names = {t['name'] for t in list_templates(d)
             if t['name'] in ('w', 'w@fr', 'w@de')}
    assert names == set(), names
print('OK')" | grep -q '^OK$'; then pass "N-60 drops all"; else fail "leftover"; fi

# 2. no override -> returns False
if run_py "
import tempfile
from forge.services.email import unset_template
with tempfile.TemporaryDirectory() as d:
    assert unset_template(d, 'ghost') is False
print('OK')" | grep -q '^OK$'; then pass "N-60 no-op False"; else fail "false True"; fi

# 3. does not touch sibling templates
if run_py "
import tempfile
from forge.services.email import (
    register_template, unset_template, list_templates,
)
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'a', subject='hi', body_text='x')
    register_template(d, 'a', subject='x', body_text='x', locale='fr')
    register_template(d, 'b', subject='hi', body_text='x')
    unset_template(d, 'a')
    names = {t['name'] for t in list_templates(d)
             if t['name'] in ('a', 'a@fr', 'b')}
    assert names == {'b'}, names
print('OK')" | grep -q '^OK$'; then pass "N-60 sibling preserved"; else fail "sibling dropped"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
