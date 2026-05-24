#!/usr/bin/env bash
# Test: N-09 OpenAPI spec includes 401/403/404/422 for every route.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. Error schema is registered in components
if run_py "
import tempfile
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    spec = generate(d)
    assert 'Error' in spec['components']['schemas']
    err = spec['components']['schemas']['Error']
    assert err['type'] == 'object'
    assert 'error' in err['required']
print('OK')" | grep -q '^OK$'; then pass "N-09 Error schema present"; else fail "Error schema missing"; fi

# 2. db list (GET) has 401+403; db post has 401+403+422; db one has +404
if run_py "
import tempfile
from forge.spec_detector import ForgeRequirements, TableSpec
from forge.provisioner import provision
from forge.sdk.openapi import generate
with tempfile.TemporaryDirectory() as d:
    req = ForgeRequirements(none=False,
        tables=[TableSpec(name='items', columns=['id pk', 'name text'])])
    provision(req, d)
    spec = generate(d)
    p = spec['paths']
    list_resp = p['/db/v1/items']['get']['responses']
    assert '401' in list_resp and '403' in list_resp, list_resp
    post_resp = p['/db/v1/items']['post']['responses']
    for code in ('401', '403', '422'):
        assert code in post_resp, (code, post_resp)
    one_resp = p['/db/v1/items/{id}']['get']['responses']
    for code in ('401', '403', '404'):
        assert code in one_resp, (code, one_resp)
print('OK')" | grep -q '^OK$'; then pass "N-09 db routes have error responses"; else fail "db missing codes"; fi

# 3. Every 4xx response uses the Error $ref
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
    bad = []
    for path, ops in spec['paths'].items():
        for verb, op in ops.items():
            if not isinstance(op, dict):
                continue
            for code, resp in (op.get('responses') or {}).items():
                if not str(code).startswith('4'):
                    continue
                schema = ((resp.get('content') or {})
                          .get('application/json') or {}).get('schema') or {}
                if schema.get('\$ref') != '#/components/schemas/Error':
                    bad.append((path, verb, code))
    assert not bad, bad
print('OK')" | grep -q '^OK$'; then pass "N-09 4xx uses Error ref"; else fail "ref drift"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
