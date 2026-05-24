#!/usr/bin/env bash
# Test: N-32 metrics surfaces forge_function_warm_disabled count.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. zero functions -> metric absent (try-block skips when fns is empty)
if run_py "
import tempfile
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    out = render(d)
    print('OK')" | grep -q '^OK$'; then pass "N-32 empty no crash"; else fail "render crashed"; fi

# 2. one function with warm_disabled=True -> count=1
if run_py "
import json, os, tempfile
from forge.services.functions import deploy
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    mp = os.path.join(d, 'functions', 'hello', 'manifest.json')
    with open(mp) as f: m = json.load(f)
    m['warm_disabled'] = True
    with open(mp, 'w') as f: json.dump(m, f)
    out = render(d)
    assert 'forge_function_warm_disabled 1' in out, out
print('OK')" | grep -q '^OK$'; then pass "N-32 counts disabled"; else fail "count wrong"; fi

# 3. no warm_disabled set -> count=0
if run_py "
import tempfile
from forge.services.functions import deploy
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    out = render(d)
    assert 'forge_function_warm_disabled 0' in out, out
print('OK')" | grep -q '^OK$'; then pass "N-32 default 0"; else fail "default wrong"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
