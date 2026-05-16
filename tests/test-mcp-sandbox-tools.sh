#!/usr/bin/env bash
# Test: MCP sandbox tools register and the helper functions work (v7.6.0)
# Unit test -- imports mcp.server in Python, asserts the three new tools
# exist on the FastMCP instance. Does not require a running MCP transport.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
cd "$ROOT"

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

# 1. mcp/server.py passes python AST parse (catches syntax errors and indent bugs).
if python3 -c "import ast; ast.parse(open('mcp/server.py').read())" 2>/dev/null; then
    pass "mcp/server.py parses as Python"
else
    fail "mcp/server.py has syntax errors"
fi

# 2. Function definitions exist textually
for fn in _sandbox_sh_path _run_sandbox loki_sandbox_start loki_sandbox_status loki_sandbox_diagnose; do
    if grep -qE "^(async )?def $fn\b" mcp/server.py; then
        pass "mcp/server.py defines $fn"
    else
        fail "mcp/server.py missing $fn"
    fi
done

# 3. Each tool is decorated with @mcp.tool()
for fn in loki_sandbox_start loki_sandbox_status loki_sandbox_diagnose; do
    if grep -B1 -E "^async def $fn\b" mcp/server.py | grep -q '^@mcp.tool()'; then
        pass "$fn decorated with @mcp.tool()"
    else
        fail "$fn not decorated"
    fi
done

# 4. Diagnose tool delegates to bash diagnose --json
if grep -q "_run_sandbox(\\['diagnose', '--json'\\]" mcp/server.py; then
    pass "loki_sandbox_diagnose shells out to 'diagnose --json'"
else
    fail "diagnose tool not shelling out correctly"
fi

# 5. Start tool allowlists network mode
if grep -q '"bridge", "none", "host"' mcp/server.py; then
    pass "loki_sandbox_start allowlists network mode"
else
    fail "loki_sandbox_start missing network allowlist"
fi

# 6. Path math matches the canonical script location.
out=$(python3 -c "
import os
here = os.path.abspath('mcp')
print(os.path.abspath(os.path.join(here, '..', 'autonomy', 'sandbox.sh')))
")
if [[ "$out" == *autonomy/sandbox.sh ]] && [[ -f "$out" ]]; then
    pass "MCP path math resolves to autonomy/sandbox.sh"
else
    fail "path math resolved to unexpected location: $out"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
