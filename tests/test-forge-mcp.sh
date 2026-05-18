#!/usr/bin/env bash
# Test: mcp/forge_tools.py registration + tool wiring (v7.6.0 Phase F-1).
# Static-text test - the MCP SDK is optional in the local env, so we verify
# the file structure rather than booting a FastMCP server.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

PASS=0; FAIL=0; TOTAL=0
pass() { PASS=$((PASS+1)); TOTAL=$((TOTAL+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); TOTAL=$((TOTAL+1)); echo "FAIL: $1"; }

FORGE_TOOLS="$ROOT/mcp/forge_tools.py"
SERVER="$ROOT/mcp/server.py"

# 1. forge_tools.py parses as Python
if python3 -c "import ast; ast.parse(open('$FORGE_TOOLS').read())" 2>/dev/null; then
    pass "mcp/forge_tools.py parses as Python"
else
    fail "mcp/forge_tools.py syntax error"
fi

# 2. register() function defined
if grep -q '^def register(mcp)' "$FORGE_TOOLS"; then
    pass "register(mcp) entry point defined"
else
    fail "register(mcp) missing"
fi

# 3. Each F-1 tool defined inside register() with @mcp.tool() decorator
for tool in forge_db_introspect forge_db_query forge_db_migrate \
            forge_db_migrate_dryrun forge_db_migrate_rollback \
            forge_state_dump; do
    if grep -B 2 -E "async def $tool" "$FORGE_TOOLS" | grep -q '@mcp.tool()'; then
        pass "$tool registered with @mcp.tool()"
    else
        fail "$tool not registered"
    fi
done

# 4. server.py imports + calls register()
if grep -q 'from mcp.forge_tools import register' "$SERVER" \
   && grep -q '_register_forge_tools(mcp)' "$SERVER"; then
    pass "server.py wires register() through optional import"
else
    fail "server.py forge wiring missing"
fi

# 5. Registration is wrapped in try/except (optional - failures non-fatal)
if grep -B 1 'from mcp.forge_tools import register' "$SERVER" | grep -q '^try:'; then
    pass "forge import is optional (try/except)"
else
    fail "forge import not in try/except"
fi

# 6. Tool delegates to a forge.* internal module (not raw SQL)
if grep -q 'from forge.services.database import' "$FORGE_TOOLS"; then
    pass "forge tools delegate to forge.services.database"
else
    fail "forge tools do not import forge.services.database"
fi

# 7. No emoji in forge_tools.py
if python3 -c "
text = open('$FORGE_TOOLS', encoding='utf-8').read()
for ch in text:
    cp = ord(ch)
    if 0x1F300 <= cp <= 0x1FAFF or 0x2600 <= cp <= 0x27BF:
        raise SystemExit(1)
"; then
    pass "no emojis in mcp/forge_tools.py"
else
    fail "emoji found in mcp/forge_tools.py"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
