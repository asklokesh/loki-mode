#!/usr/bin/env bash
# Test: X-80 MCP tool throttle.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. _check_tool_throttle returns None within limit
if run_py "
import sys
sys.path.insert(0, '$ROOT/mcp')
from forge_tools import _check_tool_throttle
from forge.services.gateway.rate_limit import reset
reset()
assert _check_tool_throttle('forge_test') is None
print('OK')" | grep -q '^OK$'; then pass "X-80 throttle allows within limit"; else fail "throttle broken"; fi

# 2. throttle blocks after capacity exceeded
if run_py "
import os, sys
os.environ['LOKI_FORGE_TOOL_RATE_PER_MIN'] = '5'
# Re-import to pick up env change.
sys.path.insert(0, '$ROOT/mcp')
import importlib, forge_tools
importlib.reload(forge_tools)
from forge.services.gateway.rate_limit import reset
reset()
# Burn the budget.
for _ in range(5):
    assert forge_tools._check_tool_throttle('forge_burn') is None
res = forge_tools._check_tool_throttle('forge_burn')
assert res is not None and res['error'] == 'forge_tool_rate_limited', res
print('OK')" | grep -q '^OK$'; then pass "X-80 throttle blocks over limit"; else fail "over-limit not blocked"; fi

# 3. throttle keys are per-tool
if run_py "
import os, sys
os.environ['LOKI_FORGE_TOOL_RATE_PER_MIN'] = '3'
sys.path.insert(0, '$ROOT/mcp')
import importlib, forge_tools
importlib.reload(forge_tools)
from forge.services.gateway.rate_limit import reset
reset()
for _ in range(3): forge_tools._check_tool_throttle('forge_a')
# Tool A exhausted; tool B should still be allowed.
assert forge_tools._check_tool_throttle('forge_b') is None
print('OK')" | grep -q '^OK$'; then pass "X-80 per-tool buckets"; else fail "buckets shared"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
