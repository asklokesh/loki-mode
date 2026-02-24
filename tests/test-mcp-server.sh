#!/usr/bin/env bash
# Test Loki Mode MCP server

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_DIR=$(mktemp -d)
TESTS_PASSED=0
TESTS_FAILED=0

export PYTHONPATH="$PROJECT_ROOT:${PYTHONPATH:-}"

cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

log_test() { echo "[TEST] $1"; }
pass() { ((TESTS_PASSED++)); echo "[PASS] $1"; }
fail() { ((TESTS_FAILED++)); echo "[FAIL] $1"; }

# Setup
setup() {
    mkdir -p "$TEST_DIR/.loki/state" "$TEST_DIR/.loki/memory" "$TEST_DIR/.loki/metrics"
    cd "$TEST_DIR" || exit 1
}

# Test 1: MCP module imports
test_mcp_import() {
    log_test "MCP module imports successfully"
    if python3 -c "from mcp import server" 2>/dev/null; then
        pass "MCP module imports"
    else
        # Check if MCP SDK is installed
        if ! python3 -c "import mcp" 2>/dev/null; then
            echo "[SKIP] MCP SDK not installed (pip install mcp)"
            return
        fi
        fail "MCP module import failed"
    fi
}

# Test 2: Server file syntax valid
test_server_syntax() {
    log_test "MCP server.py has valid Python syntax"
    if python3 -m py_compile "$PROJECT_ROOT/mcp/server.py" 2>/dev/null; then
        pass "server.py syntax valid"
    else
        fail "server.py has syntax errors"
    fi
}

# Test 3: tools.py syntax valid
test_tools_syntax() {
    log_test "MCP tools.py has valid Python syntax"
    if [ -f "$PROJECT_ROOT/mcp/tools.py" ]; then
        if python3 -m py_compile "$PROJECT_ROOT/mcp/tools.py" 2>/dev/null; then
            pass "tools.py syntax valid"
        else
            fail "tools.py has syntax errors"
        fi
    else
        echo "[SKIP] tools.py not found"
    fi
}

# Test 4: resources.py syntax valid
test_resources_syntax() {
    log_test "MCP resources.py has valid Python syntax"
    if [ -f "$PROJECT_ROOT/mcp/resources.py" ]; then
        if python3 -m py_compile "$PROJECT_ROOT/mcp/resources.py" 2>/dev/null; then
            pass "resources.py syntax valid"
        else
            fail "resources.py has syntax errors"
        fi
    else
        echo "[SKIP] resources.py not found"
    fi
}

# Test 5: .mcp.json exists and is valid
test_mcp_json() {
    log_test ".mcp.json exists and is valid"
    if [ -f "$PROJECT_ROOT/.mcp.json" ]; then
        if python3 -c "import json; json.load(open('$PROJECT_ROOT/.mcp.json'))" 2>/dev/null; then
            pass ".mcp.json is valid JSON"
        else
            fail ".mcp.json is not valid JSON"
        fi
    else
        fail ".mcp.json not found"
    fi
}

# Test 6: .mcp.json has loki-mode server
test_mcp_json_server() {
    log_test ".mcp.json has loki-mode server configured"
    if python3 -c "
import json
with open('$PROJECT_ROOT/.mcp.json') as f:
    servers = json.load(f).get('mcpServers', {})
    assert 'loki-mode' in servers, 'loki-mode server not found'
    print('loki-mode server found')
" 2>/dev/null; then
        pass "loki-mode server configured"
    else
        fail "loki-mode server not in .mcp.json"
    fi
}

# Test 7: Task queue operations (without MCP SDK)
test_task_queue_file_ops() {
    log_test "Task queue file operations work"
    # Create a task queue
    cat > "$TEST_DIR/.loki/state/task-queue.json" << 'EOF'
{
  "tasks": [
    {"id": "task-0001", "title": "Test task", "status": "pending"}
  ],
  "version": "1.0"
}
EOF
    if python3 -c "
import json
with open('$TEST_DIR/.loki/state/task-queue.json') as f:
    queue = json.load(f)
    assert len(queue['tasks']) == 1
    assert queue['tasks'][0]['status'] == 'pending'
    print('Task queue valid')
" 2>/dev/null; then
        pass "Task queue operations work"
    else
        fail "Task queue operations failed"
    fi
}

# Test 8: Memory integration check
test_memory_integration() {
    log_test "MCP server can access memory module"
    if python3 -c "
import sys
sys.path.insert(0, '$PROJECT_ROOT')
from memory.engine import MemoryEngine
from memory.storage import MemoryStorage
print('Memory module accessible')
" 2>/dev/null; then
        pass "Memory module accessible from MCP"
    else
        fail "Memory module not accessible"
    fi
}

# Test 9: MCP requirements.txt exists
test_requirements() {
    log_test "MCP requirements.txt exists"
    if [ -f "$PROJECT_ROOT/mcp/requirements.txt" ]; then
        if grep -q "mcp" "$PROJECT_ROOT/mcp/requirements.txt"; then
            pass "requirements.txt has mcp dependency"
        else
            fail "requirements.txt missing mcp dependency"
        fi
    else
        fail "mcp/requirements.txt not found"
    fi
}

# Test 10: Server has required tools
test_server_tools() {
    log_test "Server defines required tools"
    TOOLS=$(grep -c "@mcp.tool()" "$PROJECT_ROOT/mcp/server.py" 2>/dev/null || echo "0")
    if [ "$TOOLS" -ge 5 ]; then
        pass "Server has $TOOLS tools defined"
    else
        fail "Server has only $TOOLS tools (need at least 5)"
    fi
}

# Test 11: Server has resources
test_server_resources() {
    log_test "Server defines resources"
    RESOURCES=$(grep -c "@mcp.resource" "$PROJECT_ROOT/mcp/server.py" 2>/dev/null || echo "0")
    if [ "$RESOURCES" -ge 2 ]; then
        pass "Server has $RESOURCES resources defined"
    else
        fail "Server has only $RESOURCES resources (need at least 2)"
    fi
}

# Test 12: Server has prompts
test_server_prompts() {
    log_test "Server defines prompts"
    PROMPTS=$(grep -c "@mcp.prompt()" "$PROJECT_ROOT/mcp/server.py" 2>/dev/null || echo "0")
    if [ "$PROMPTS" -ge 1 ]; then
        pass "Server has $PROMPTS prompts defined"
    else
        fail "Server has only $PROMPTS prompts (need at least 1)"
    fi
}

# Run tests
setup
test_mcp_import
test_server_syntax
test_tools_syntax
test_resources_syntax
test_mcp_json
test_mcp_json_server
test_task_queue_file_ops
test_memory_integration
test_requirements
test_server_tools
test_server_resources
test_server_prompts

# Summary
echo ""
echo "========================================"
echo "MCP Server Test Results"
echo "========================================"
echo "Passed: $TESTS_PASSED"
echo "Failed: $TESTS_FAILED"
echo "========================================"

[ "$TESTS_FAILED" -eq 0 ]
