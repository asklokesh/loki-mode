#!/usr/bin/env bash
# Test: N-29 warm() respects manifest warm_disabled=True.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. warm_disabled=True -> skipped result, no warm_count bump
if run_py "
import json, os, tempfile
from forge.services.functions import deploy, warm, get_function
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    mp = os.path.join(d, 'functions', 'hello', 'manifest.json')
    with open(mp) as f: m = json.load(f)
    m['warm_disabled'] = True
    with open(mp, 'w') as f: json.dump(m, f)
    r = warm(d, 'hello')
    assert r['ok'] is True, r
    assert r['warmed'] is False, r
    assert r['skipped'] is True, r
    assert r['reason'] == 'warm_disabled', r
    m2 = get_function(d, 'hello')
    assert m2.get('warm_count', 0) == 0, m2
print('OK')" | grep -q '^OK$'; then pass "N-29 disabled -> skipped"; else fail "warmed when disabled"; fi

# 2. warm_disabled=False (default) still works
if run_py "
import tempfile
from forge.services.functions import deploy, warm
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    r = warm(d, 'hello')
    assert r['warmed'] is True, r
print('OK')" | grep -q '^OK$'; then pass "N-29 default still warms"; else fail "default broke"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
