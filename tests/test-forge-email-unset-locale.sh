#!/usr/bin/env bash
# Test: N-11 unset_locale drops a locale variant without wiping default.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. happy path: register default + fr variant; unset fr only
if run_py "
import tempfile
from forge.services.email import register_template, unset_locale, list_templates
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'welcome', subject='hi', body_text='hello')
    register_template(d, 'welcome', subject='salut', body_text='bonjour',
                      locale='fr')
    assert unset_locale(d, 'welcome', 'fr') is True
    names = [t['name'] for t in list_templates(d)]
    assert 'welcome' in names, names
    assert 'welcome@fr' not in names, names
print('OK')" | grep -q '^OK$'; then pass "N-11 drops locale, keeps default"; else fail "default wiped"; fi

# 2. returns False when no matching variant
if run_py "
import tempfile
from forge.services.email import register_template, unset_locale
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'welcome', subject='hi', body_text='hello')
    assert unset_locale(d, 'welcome', 'de') is False
print('OK')" | grep -q '^OK$'; then pass "N-11 no-op when variant absent"; else fail "false-pos drop"; fi

# 3. refuses to drop the default (locale=None)
if run_py "
import tempfile
from forge.services.email import register_template, unset_locale
from forge.services.email.templates import EmailError
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'welcome', subject='hi', body_text='hello')
    try:
        unset_locale(d, 'welcome', None)
        print('NO_RAISE')
    except EmailError as e:
        assert 'default' in str(e), e
        print('OK')" | grep -q '^OK$'; then pass "N-11 refuses default"; else fail "default droppable"; fi

# 4. invalid locale rejected
if run_py "
import tempfile
from forge.services.email import unset_locale
from forge.services.email.templates import EmailError
with tempfile.TemporaryDirectory() as d:
    try:
        unset_locale(d, 'welcome', 'BAD')
        print('NO_RAISE')
    except EmailError as e:
        print('OK')" | grep -q '^OK$'; then pass "N-11 invalid locale rejected"; else fail "bad locale accepted"; fi

# 5. multi-locale: unset fr leaves de intact
if run_py "
import tempfile
from forge.services.email import register_template, unset_locale, list_templates
with tempfile.TemporaryDirectory() as d:
    register_template(d, 'welcome', subject='hi', body_text='hello')
    register_template(d, 'welcome', subject='salut', body_text='bj', locale='fr')
    register_template(d, 'welcome', subject='hallo', body_text='hi', locale='de')
    unset_locale(d, 'welcome', 'fr')
    names = [t['name'] for t in list_templates(d)]
    assert 'welcome@de' in names and 'welcome' in names
    assert 'welcome@fr' not in names, names
print('OK')" | grep -q '^OK$'; then pass "N-11 surgical removal"; else fail "co-locale dropped"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
