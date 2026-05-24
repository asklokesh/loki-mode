#!/usr/bin/env bash
# Test: N-25 clear_locales drops every locale variant in one call.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. clear three locales in one call, default preserved
if run_py "
import tempfile
from forge.services.email import register_template, clear_locales, list_templates
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'w', subject='hi', body_text='x')
    for loc in ('fr', 'de', 'en-GB'):
        register_template(d, 'w', subject='x', body_text='x', locale=loc)
    removed = clear_locales(d, 'w')
    assert set(removed) == {'fr', 'de', 'en-GB'}, removed
    names = [t['name'] for t in list_templates(d)]
    assert 'w' in names
    assert not any('@' in n for n in names), names
print('OK')" | grep -q '^OK$'; then pass "N-25 wholesale drop"; else fail "incomplete drop"; fi

# 2. empty case returns []
if run_py "
import tempfile
from forge.services.email import clear_locales
with tempfile.TemporaryDirectory() as d:
    assert clear_locales(d, 'ghost') == []
print('OK')" | grep -q '^OK$'; then pass "N-25 empty -> []"; else fail "non-empty"; fi

# 3. does not touch sibling templates
if run_py "
import tempfile
from forge.services.email import register_template, clear_locales, list_templates
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'a', subject='hi', body_text='x')
    register_template(d, 'a', subject='hi', body_text='x', locale='fr')
    register_template(d, 'b', subject='hi', body_text='x', locale='fr')
    clear_locales(d, 'a')
    names = sorted(t['name'] for t in list_templates(d)
                   if t['name'] in ('a', 'a@fr', 'b@fr'))
    assert names == ['a', 'b@fr'], names
print('OK')" | grep -q '^OK$'; then pass "N-25 sibling preserved"; else fail "sibling dropped"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
