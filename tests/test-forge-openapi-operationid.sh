#!/usr/bin/env bash
# Test: N-51 every OpenAPI operation has an operationId.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. every operation in the spec has an operationId
if run_py "
import tempfile
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    req = ForgeRequirements(none=False,
        tables=[TableSpec(name='items', columns=['id pk'])])
    provision(req, d)
    spec = generate(d)
    missing = []
    for path, ops in spec['paths'].items():
        for verb, op in ops.items():
            if isinstance(op, dict) and 'operationId' not in op:
                missing.append((path, verb))
    assert not missing, missing
print('OK')" | grep -q '^OK$'; then pass "N-51 all ops have operationId"; else fail "missing"; fi

# 2. operationIds are unique across the spec
if run_py "
import tempfile
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    req = ForgeRequirements(none=False,
        tables=[TableSpec(name='items', columns=['id pk']),
                TableSpec(name='orders', columns=['id pk'])])
    provision(req, d)
    spec = generate(d)
    ids = []
    for ops in spec['paths'].values():
        for op in ops.values():
            if isinstance(op, dict) and 'operationId' in op:
                ids.append(op['operationId'])
    assert len(ids) == len(set(ids)), ids
print('OK')" | grep -q '^OK$'; then pass "N-51 operationIds unique"; else fail "duplicates"; fi

# 3. operationId for db_list_items is the documented shape
if run_py "
import tempfile
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    req = ForgeRequirements(none=False,
        tables=[TableSpec(name='items', columns=['id pk'])])
    provision(req, d)
    spec = generate(d)
    op = spec['paths']['/db/v1/items']['get']
    assert op['operationId'] == 'db_list_items', op
print('OK')" | grep -q '^OK$'; then pass "N-51 documented shape"; else fail "shape changed"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
