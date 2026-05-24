#!/usr/bin/env bash
# Test: N-15 warm() persists warm_count and metrics surfaces the counter.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. warm() increments warm_count on success
if run_py "
import tempfile
from forge.services.functions import deploy, warm, get_function
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    r = warm(d, 'hello')
    assert r['ok'] is True, r
    m = get_function(d, 'hello')
    assert m.get('warm_count') == 1, m.get('warm_count')
print('OK')" | grep -q '^OK$'; then pass "N-15 warm increments counter"; else fail "counter stuck"; fi

# 2. multiple warms accumulate
if run_py "
import tempfile
from forge.services.functions import deploy, warm, get_function
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    warm(d, 'hello'); warm(d, 'hello'); warm(d, 'hello')
    m = get_function(d, 'hello')
    assert m.get('warm_count') == 3, m.get('warm_count')
print('OK')" | grep -q '^OK$'; then pass "N-15 accumulates"; else fail "no accumulation"; fi

# 3. metrics render emits forge_function_warm_total
if run_py "
import tempfile
from forge.services.functions import deploy, warm
from forge.metrics import render
with tempfile.TemporaryDirectory() as d:
    deploy(d, name='hello', runtime='python',
           source_b64='cHJpbnQoIm9rIikK', entry='index')
    warm(d, 'hello')
    out = render(d)
    assert 'forge_function_warm_total' in out, out
    assert 'name=\"hello\"' in out
print('OK')" | grep -q '^OK$'; then pass "N-15 metric surfaced"; else fail "metric missing"; fi

# 4. warm failure does NOT increment counter
if run_py "
import tempfile
from forge.services.functions import warm, get_function
with tempfile.TemporaryDirectory() as d:
    r = warm(d, 'ghost')
    assert r['ok'] is False
    m = get_function(d, 'ghost')
    assert m is None
print('OK')" | grep -q '^OK$'; then pass "N-15 failed warm no increment"; else fail "false increment"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
