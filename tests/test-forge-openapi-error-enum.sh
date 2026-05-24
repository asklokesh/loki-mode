#!/usr/bin/env bash
# Test: N-23 OpenAPI Error schema lists every error code as an enum.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. error field has an enum of strings
if run_py "
import tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    err = spec['components']['schemas']['Error']
    enum = err['properties']['error'].get('enum')
    assert isinstance(enum, list) and enum, err
    assert all(isinstance(x, str) for x in enum), enum
print('OK')" | grep -q '^OK$'; then pass "N-23 enum present"; else fail "no enum"; fi

# 2. enum covers the core 4 we documented earlier (unauthorized, etc.)
if run_py "
import tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    enum = set(spec['components']['schemas']['Error']['properties']['error']['enum'])
    for code in ('unauthorized', 'forbidden', 'not_found', 'validation_failed'):
        assert code in enum, (code, enum)
print('OK')" | grep -q '^OK$'; then pass "N-23 core codes listed"; else fail "missing codes"; fi

# 3. enum stays stable across runs (deterministic output)
if run_py "
import tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    a = generate(d)['components']['schemas']['Error']['properties']['error']['enum']
    b = generate(d)['components']['schemas']['Error']['properties']['error']['enum']
    assert a == b, (a, b)
print('OK')" | grep -q '^OK$'; then pass "N-23 deterministic"; else fail "drift"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
