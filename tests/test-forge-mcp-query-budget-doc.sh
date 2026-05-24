#!/usr/bin/env bash
# Test: N-16 MCP forge_db_query_page docstring exposes budget_ms.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }
run_py() { PYTHONPATH="$ROOT" python3 -c "$1" 2>&1; }

# 1. The source docstring mentions budget_ms with semantics
if grep -q 'budget_ms: optional wall-clock cap' "$ROOT/mcp/forge_tools.py"; then
    pass "N-16 docstring describes budget_ms"
else
    fail "budget_ms not described"
fi

# 2. The MCP tool signature still has the parameter (regression guard)
if grep -q 'budget_ms: int = 0' "$ROOT/mcp/forge_tools.py"; then
    pass "N-16 signature preserved"
else
    fail "signature changed"
fi

# 3. The docstring mentions the error string an agent should expect
if grep -q 'query budget exceeded' "$ROOT/mcp/forge_tools.py"; then
    pass "N-16 mentions error message"
else
    fail "error msg not documented"
fi

# 4. End-to-end: registering the tool exposes a docstring with budget_ms
if run_py "
import inspect
from mcp import forge_tools
src = inspect.getsource(forge_tools)
# Find the forge_db_query_page docstring by locating the function def
i = src.index('async def forge_db_query_page')
j = src.index('\"\"\"', i) + 3
k = src.index('\"\"\"', j)
doc = src[j:k]
assert 'budget_ms' in doc, doc
assert 'wall-clock' in doc, doc
print('OK')" | grep -q '^OK$'; then pass "N-16 inspect sees budget docs"; else fail "inspect missed docs"; fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
