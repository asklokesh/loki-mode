#!/usr/bin/env bash
# Test: N-35 OpenAPI Error schema declares discriminator + per-code envelopes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. Error has discriminator
if run_py "
import tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    disc = spec['components']['schemas']['Error'].get('discriminator')
    assert disc, spec['components']['schemas']['Error']
    assert disc['propertyName'] == 'error'
    assert isinstance(disc.get('mapping'), dict)
print('OK')" | grep -q '^OK$'; then pass "N-35 discriminator present"; else fail "no discriminator"; fi

# 2. Per-code Error_<code> envelopes exist for every enum value
if run_py "
import tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    schemas = spec['components']['schemas']
    enum = schemas['Error']['properties']['error']['enum']
    for code in enum:
        assert f'Error_{code}' in schemas, f'missing Error_{code}'
        env = schemas[f'Error_{code}']
        # allOf with the base Error
        assert 'allOf' in env, env
print('OK')" | grep -q '^OK$'; then pass "N-35 per-code envelopes"; else fail "missing envelopes"; fi

# 3. discriminator mapping points at correct refs
if run_py "
import tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    disc = spec['components']['schemas']['Error']['discriminator']
    for code, ref in disc['mapping'].items():
        assert ref == f'#/components/schemas/Error_{code}', (code, ref)
print('OK')" | grep -q '^OK$'; then pass "N-35 mapping correct"; else fail "mapping wrong"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
