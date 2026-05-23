#!/usr/bin/env bash
# Test: forge.services.functions - deploy + invoke + logs (Phase F-2).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. deploy roundtrip
if run_py "
import base64, tempfile
from forge.services.functions import deploy, get_function, list_functions
with tempfile.TemporaryDirectory() as d:
    src = base64.b64encode(b'console.log(1)').decode()
    m = deploy(d, 'hello', 'bun', src)
    assert m['name'] == 'hello' and m['active_version'] == 1
    assert get_function(d, 'hello')['runtime'] == 'bun'
    assert len(list_functions(d)) == 1
print('OK')" | grep -q '^OK$'; then
    pass "function deploy + list roundtrip"
else
    fail "deploy/list broken"
fi

# 2. unsupported runtime rejected
if run_py "
import base64, tempfile
from forge.services.functions import deploy, FunctionError
with tempfile.TemporaryDirectory() as d:
    try:
        deploy(d, 'x', 'php', base64.b64encode(b'x').decode())
    except FunctionError:
        print('OK')
        raise SystemExit
    raise AssertionError('php accepted')
" | grep -q '^OK$'; then
    pass "unsupported runtime rejected"
else
    fail "unsupported runtime accepted"
fi

# 3. invalid name rejected
if run_py "
import base64, tempfile
from forge.services.functions import deploy, FunctionError
with tempfile.TemporaryDirectory() as d:
    for bad in ['UPPER', '1leading', 'has space', 'a']:
        try:
            deploy(d, bad, 'bun', base64.b64encode(b'x').decode())
        except FunctionError:
            continue
        raise AssertionError(f'accepted: {bad!r}')
print('OK')" | grep -q '^OK$'; then
    pass "invalid function names rejected"
else
    fail "invalid function name accepted"
fi

# 4. source size cap enforced
if run_py "
import base64, tempfile
from forge.services.functions import deploy, FunctionError
with tempfile.TemporaryDirectory() as d:
    big = base64.b64encode(b'x' * (5 * 1024 * 1024)).decode()
    try:
        deploy(d, 'big', 'bun', big)
    except FunctionError:
        print('OK')
        raise SystemExit
    raise AssertionError('size cap not enforced')
" | grep -q '^OK$'; then
    pass "source size cap enforced"
else
    fail "size cap leak"
fi

# 5. multiple deploys bump active_version
if run_py "
import base64, tempfile
from forge.services.functions import deploy
with tempfile.TemporaryDirectory() as d:
    for i in range(3):
        m = deploy(d, 'fn', 'bun', base64.b64encode(b'v%d' % i).decode())
    assert m['active_version'] == 3, m
    assert len(m['versions']) == 3
print('OK')" | grep -q '^OK$'; then
    pass "deploy bumps active_version"
else
    fail "version bump broken"
fi

# 6. rollback switches active_version
if run_py "
import base64, tempfile
from forge.services.functions import deploy, rollback
with tempfile.TemporaryDirectory() as d:
    deploy(d, 'fn', 'bun', base64.b64encode(b'v1').decode())
    deploy(d, 'fn', 'bun', base64.b64encode(b'v2').decode())
    res = rollback(d, 'fn', 1)
    assert res['active_version'] == 1
print('OK')" | grep -q '^OK$'; then
    pass "rollback switches active_version"
else
    fail "rollback broken"
fi

# 7. rollback to missing version rejected
if run_py "
import base64, tempfile
from forge.services.functions import deploy, rollback, FunctionError
with tempfile.TemporaryDirectory() as d:
    deploy(d, 'fn', 'bun', base64.b64encode(b'v1').decode())
    try:
        rollback(d, 'fn', 99)
    except FunctionError:
        print('OK')
        raise SystemExit
    raise AssertionError('bad rollback accepted')
" | grep -q '^OK$'; then
    pass "rollback rejects missing version"
else
    fail "bad rollback accepted"
fi

# 8. invoke surfaces runtime_missing cleanly when bun not on PATH
if run_py "
import base64, tempfile
from forge.services.functions import deploy, invoke
with tempfile.TemporaryDirectory() as d:
    deploy(d, 'fn', 'bun', base64.b64encode(b'console.log(1)').decode())
    res = invoke(d, 'fn')
    # Test env may or may not have bun; either ok=True or error='runtime_missing'.
    assert res['run_id']
    assert 'ok' in res
print('OK')" | grep -q '^OK$'; then
    pass "invoke returns structured result regardless of runtime availability"
else
    fail "invoke crashed instead of surfacing error"
fi

# 9. invoke a python function end-to-end (python3 always available here)
if run_py "
import base64, tempfile
from forge.services.functions import deploy, invoke
src = b'import sys, json; payload = json.load(sys.stdin); print(json.dumps({\"echo\": payload}))'
with tempfile.TemporaryDirectory() as d:
    deploy(d, 'echo', 'python', base64.b64encode(src).decode())
    res = invoke(d, 'echo', payload={'hello': 'world'})
    assert res['ok'] is True, res
    out = res['stdout'].strip()
    import json
    parsed = json.loads(out)
    assert parsed == {'echo': {'hello': 'world'}}, parsed
print('OK')" | grep -q '^OK$'; then
    pass "python runtime invoke end-to-end"
else
    fail "python invoke broken"
fi

# 10. timeout enforced
if run_py "
import base64, tempfile
from forge.services.functions import deploy, invoke
src = b'import time; time.sleep(5)'
with tempfile.TemporaryDirectory() as d:
    deploy(d, 'slow', 'python', base64.b64encode(src).decode(), timeout_ms=300)
    res = invoke(d, 'slow')
    assert res['ok'] is False and res.get('error') == 'timeout', res
print('OK')" | grep -q '^OK$'; then
    pass "timeout enforced (returns error=timeout)"
else
    fail "timeout not enforced"
fi

# 11. delete removes the function dir
if run_py "
import base64, os, tempfile
from forge.services.functions import deploy, delete_function
with tempfile.TemporaryDirectory() as d:
    deploy(d, 'fn', 'bun', base64.b64encode(b'x').decode())
    assert delete_function(d, 'fn') is True
    assert not os.path.exists(os.path.join(d, 'functions', 'fn'))
print('OK')" | grep -q '^OK$'; then
    pass "delete_function removes function dir"
else
    fail "delete_function broken"
fi

# 12. logs are recorded
if run_py "
import base64, tempfile
from forge.services.functions import deploy, invoke, list_runs
src = b'print(\"ok\")'
with tempfile.TemporaryDirectory() as d:
    deploy(d, 'fn', 'python', base64.b64encode(src).decode())
    invoke(d, 'fn')
    invoke(d, 'fn')
    runs = list_runs(d, 'fn')
    assert len(runs) == 2, len(runs)
print('OK')" | grep -q '^OK$'; then
    pass "invocation logs recorded"
else
    fail "logs not recorded"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
