#!/usr/bin/env bash
# Test: forge.services.gateway - routing + usage + rate limit (Phase F-2).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. add + list + remove routes
if run_py "
import tempfile
from forge.services.gateway import add_route, list_routes, remove_route
with tempfile.TemporaryDirectory() as d:
    add_route(d, {'model':'claude-opus','provider':'anthropic',
                  'base_url':'https://api.anthropic.com',
                  'api_key_ref':'ANTHROPIC_KEY','tier':1})
    add_route(d, {'model':'claude-opus','provider':'openrouter',
                  'base_url':'https://openrouter.ai/api','tier':2})
    rs = list_routes(d, model='claude-opus')
    assert len(rs) == 2
    assert remove_route(d, 'claude-opus', 'openrouter') is True
    rs = list_routes(d)
    assert len(rs) == 1
print('OK')" | grep -q '^OK$'; then
    pass "route add/list/remove roundtrip"
else
    fail "route CRUD broken"
fi

# 2. unsupported provider rejected
if run_py "
import tempfile
from forge.services.gateway import add_route
with tempfile.TemporaryDirectory() as d:
    try:
        add_route(d, {'model':'x','provider':'wrong','base_url':'https://x'})
    except ValueError:
        print('OK')
        raise SystemExit
    raise AssertionError('unknown provider accepted')
" | grep -q '^OK$'; then
    pass "unsupported provider rejected"
else
    fail "bad provider accepted"
fi

# 3. non-http base_url rejected
if run_py "
import tempfile
from forge.services.gateway import add_route
with tempfile.TemporaryDirectory() as d:
    try:
        add_route(d, {'model':'x','provider':'openai','base_url':'file:///etc'})
    except ValueError:
        print('OK')
        raise SystemExit
    raise AssertionError('file:// base_url accepted')
" | grep -q '^OK$'; then
    pass "non-http base_url rejected"
else
    fail "non-http base_url accepted"
fi

# 4. tier out of range rejected
if run_py "
import tempfile
from forge.services.gateway import add_route
with tempfile.TemporaryDirectory() as d:
    try:
        add_route(d, {'model':'x','provider':'openai','base_url':'https://x','tier':9})
    except ValueError:
        print('OK')
        raise SystemExit
    raise AssertionError('tier=9 accepted')
" | grep -q '^OK$'; then
    pass "tier out of range rejected"
else
    fail "bad tier accepted"
fi

# 5. duplicate (model, provider) is replaced not stacked
if run_py "
import tempfile
from forge.services.gateway import add_route, list_routes
with tempfile.TemporaryDirectory() as d:
    add_route(d, {'model':'m','provider':'openai','base_url':'https://a','tier':1})
    add_route(d, {'model':'m','provider':'openai','base_url':'https://b','tier':2})
    rs = list_routes(d, model='m')
    assert len(rs) == 1 and rs[0]['base_url'] == 'https://b' and rs[0]['tier'] == 2
print('OK')" | grep -q '^OK$'; then
    pass "duplicate (model,provider) replaces"
else
    fail "duplicate stacked instead of replacing"
fi

# 6. pick_route picks lowest tier
if run_py "
import tempfile
from forge.services.gateway import add_route, pick_route
with tempfile.TemporaryDirectory() as d:
    add_route(d, {'model':'m','provider':'openai','base_url':'https://x','tier':2,'cost_per_1m_output_tokens':30})
    add_route(d, {'model':'m','provider':'anthropic','base_url':'https://y','tier':1,'cost_per_1m_output_tokens':50})
    r = pick_route(d, 'm')
    assert r['provider'] == 'anthropic', r
print('OK')" | grep -q '^OK$'; then
    pass "pick_route picks lowest tier"
else
    fail "pick_route picked wrong tier"
fi

# 7. pick_route returns None when no route
if run_py "
import tempfile
from forge.services.gateway import pick_route
with tempfile.TemporaryDirectory() as d:
    assert pick_route(d, 'no-such-model') is None
print('OK')" | grep -q '^OK$'; then
    pass "pick_route None when no route"
else
    fail "pick_route did not return None"
fi

# 8. usage records + summary
if run_py "
import tempfile
from forge.services.gateway import record_usage, usage_summary
with tempfile.TemporaryDirectory() as d:
    for lat in [100, 200, 300]:
        record_usage(d, 'm', 'openai', latency_ms=lat,
                     input_tokens=10, output_tokens=20, ok=True)
    s = usage_summary(d, model='m')
    key = ('m', 'openai')
    assert key in s
    assert s[key]['count'] == 3
    assert s[key]['p50_latency_ms'] in (200, 300)  # median of 3
print('OK')" | grep -q '^OK$'; then
    pass "usage summary aggregates"
else
    fail "usage aggregation broken"
fi

# 9. rate limit allow + retry-after
if run_py "
from forge.services.gateway import check
from forge.services.gateway.rate_limit import reset
reset()
# Bucket size 2, refill 0/s for deterministic test.
r1 = check('k1', cost=1.0, capacity=2.0, refill_per_sec=0)
r2 = check('k1', cost=1.0, capacity=2.0, refill_per_sec=0)
r3 = check('k1', cost=1.0, capacity=2.0, refill_per_sec=0)
assert r1['allowed'] == 1.0
assert r2['allowed'] == 1.0
assert r3['allowed'] == 0.0
print('OK')" | grep -q '^OK$'; then
    pass "rate limit honors capacity"
else
    fail "rate limit capacity broken"
fi

# 10. rate limit refills
if run_py "
import time
from forge.services.gateway import check
from forge.services.gateway.rate_limit import reset
reset()
check('k2', cost=2.0, capacity=2.0, refill_per_sec=10.0)
time.sleep(0.3)
r = check('k2', cost=1.0, capacity=2.0, refill_per_sec=10.0)
assert r['allowed'] == 1.0, r
print('OK')" | grep -q '^OK$'; then
    pass "rate limit refills over time"
else
    fail "rate limit refill broken"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
