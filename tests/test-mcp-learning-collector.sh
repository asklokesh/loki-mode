#!/usr/bin/env bash
# Test MCP learning collector signal emission
#
# This test verifies that the MCP learning collector correctly
# emits learning signals for tool calls.
#
# Run: ./tests/test-mcp-learning-collector.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TEST_LOKI_DIR="/tmp/loki-test-mcp-learning-$$"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Cleanup function
cleanup() {
    rm -rf "$TEST_LOKI_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# Check if signal file was created
check_signal_created() {
    local signal_dir="$TEST_LOKI_DIR/learning/signals"
    if [ -d "$signal_dir" ]; then
        local count
        count=$(find "$signal_dir" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
        if [ "$count" -gt 0 ]; then
            return 0
        fi
    fi
    return 1
}

# Get latest signal file content
get_latest_signal() {
    local signal_dir="$TEST_LOKI_DIR/learning/signals"
    if [ -d "$signal_dir" ]; then
        local latest
        latest=$(find "$signal_dir" -name "*.json" -type f 2>/dev/null | sort | tail -1)
        if [ -n "$latest" ]; then
            cat "$latest"
        fi
    fi
}

# Count signals
count_signals() {
    local signal_dir="$TEST_LOKI_DIR/learning/signals"
    if [ -d "$signal_dir" ]; then
        find "$signal_dir" -name "*.json" 2>/dev/null | wc -l | tr -d ' '
    else
        echo "0"
    fi
}

# Clear signals for next test
clear_signals() {
    rm -rf "$TEST_LOKI_DIR/learning/signals" 2>/dev/null || true
}

# Python test runner helper - imports learning_collector directly
# This avoids importing the mcp server which requires the MCP SDK
run_python_test() {
    python3 << PYEOF
import sys
import os
import importlib.util

# Setup path
project_dir = '$PROJECT_DIR'
sys.path.insert(0, project_dir)

# Load learning_collector module directly without going through mcp package
spec = importlib.util.spec_from_file_location(
    "learning_collector",
    os.path.join(project_dir, "mcp", "learning_collector.py")
)
lc = importlib.util.module_from_spec(spec)
sys.modules['learning_collector'] = lc
spec.loader.exec_module(lc)

# Now we can use the module
MCPLearningCollector = lc.MCPLearningCollector
get_mcp_learning_collector = lc.get_mcp_learning_collector
ToolStats = lc.ToolStats
ToolCallTracker = lc.ToolCallTracker

$1
PYEOF
}

echo ""
echo "=============================================="
echo "  MCP Learning Collector Tests"
echo "=============================================="
echo ""

# Check prerequisites
echo "Checking prerequisites..."
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}FAIL: python3 not found${NC}"
    exit 1
fi

# Check if learning module is available
if ! python3 -c "import sys; sys.path.insert(0, '$PROJECT_DIR'); from learning import SignalSource" 2>/dev/null; then
    echo -e "${RED}FAIL: learning module not available${NC}"
    exit 1
fi

echo -e "${GREEN}Prerequisites OK${NC}"
echo ""

# Create test directory
mkdir -p "$TEST_LOKI_DIR"

echo "Test 1: MCPLearningCollector basic functionality"
echo "----------------------------------------------"

# Test collector creation and tool efficiency emission
clear_signals
run_python_test "
from pathlib import Path
import time

loki_dir = Path('$TEST_LOKI_DIR')
collector = MCPLearningCollector(loki_dir=loki_dir)

# Emit tool efficiency signal
collector.emit_tool_efficiency(
    tool_name='loki_memory_retrieve',
    action='test_tool_call',
    execution_time_ms=150,
    success=True,
    context={'query': 'test query'}
)

# Wait for async emission
time.sleep(0.5)
print('Tool efficiency signal emitted')
"

if check_signal_created; then
    echo -e "  ${GREEN}Tool efficiency signal created${NC}"
    signal_content=$(get_latest_signal)
    if echo "$signal_content" | grep -q '"type": "tool_efficiency"'; then
        echo -e "  ${GREEN}Signal type correct${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}Signal type incorrect${NC}"
        ((TESTS_FAILED++))
    fi
    if echo "$signal_content" | grep -q '"source": "mcp"'; then
        echo -e "  ${GREEN}Signal source correct (mcp)${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}Signal source incorrect${NC}"
        ((TESTS_FAILED++))
    fi
else
    echo -e "  ${RED}No tool efficiency signal created${NC}"
    ((TESTS_FAILED++))
    ((TESTS_FAILED++))
fi
((TESTS_RUN+=2))

echo ""
echo "Test 2: Error pattern emission"
echo "----------------------------------------------"

clear_signals
run_python_test "
from pathlib import Path
import time

loki_dir = Path('$TEST_LOKI_DIR')
collector = MCPLearningCollector(loki_dir=loki_dir)

# Emit error pattern signal
collector.emit_error_pattern(
    tool_name='loki_task_queue_add',
    action='test_error',
    error_type='ValidationError',
    error_message='Invalid task priority',
    context={'priority': 'invalid'}
)

time.sleep(0.5)
print('Error pattern signal emitted')
"

if check_signal_created; then
    echo -e "  ${GREEN}Error pattern signal created${NC}"
    signal_content=$(get_latest_signal)
    if echo "$signal_content" | grep -q '"type": "error_pattern"'; then
        echo -e "  ${GREEN}Signal type correct${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}Signal type incorrect${NC}"
        ((TESTS_FAILED++))
    fi
    if echo "$signal_content" | grep -q '"error_type": "ValidationError"'; then
        echo -e "  ${GREEN}Error type correct${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}Error type incorrect${NC}"
        ((TESTS_FAILED++))
    fi
else
    echo -e "  ${RED}No error pattern signal created${NC}"
    ((TESTS_FAILED+=2))
fi
((TESTS_RUN+=2))

echo ""
echo "Test 3: Success pattern emission"
echo "----------------------------------------------"

clear_signals
run_python_test "
from pathlib import Path
import time

loki_dir = Path('$TEST_LOKI_DIR')
collector = MCPLearningCollector(loki_dir=loki_dir)

# Emit success pattern signal
collector.emit_success_pattern(
    tool_name='loki_consolidate_memory',
    action='test_success',
    pattern_name='memory_consolidation_success',
    duration_seconds=30,
    action_sequence=['load_episodes', 'extract_patterns', 'save_patterns']
)

time.sleep(0.5)
print('Success pattern signal emitted')
"

if check_signal_created; then
    echo -e "  ${GREEN}Success pattern signal created${NC}"
    signal_content=$(get_latest_signal)
    if echo "$signal_content" | grep -q '"type": "success_pattern"'; then
        echo -e "  ${GREEN}Signal type correct${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}Signal type incorrect${NC}"
        ((TESTS_FAILED++))
    fi
    if echo "$signal_content" | grep -q '"pattern_name": "memory_consolidation_success"'; then
        echo -e "  ${GREEN}Pattern name correct${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}Pattern name incorrect${NC}"
        ((TESTS_FAILED++))
    fi
else
    echo -e "  ${RED}No success pattern signal created${NC}"
    ((TESTS_FAILED+=2))
fi
((TESTS_RUN+=2))

echo ""
echo "Test 4: Context relevance emission"
echo "----------------------------------------------"

clear_signals
run_python_test "
from pathlib import Path
import time

loki_dir = Path('$TEST_LOKI_DIR')
collector = MCPLearningCollector(loki_dir=loki_dir)

# Emit context relevance signal
collector.emit_context_relevance(
    tool_name='loki_memory_retrieve',
    action='memory_retrieval',
    query='authentication patterns',
    retrieved_ids=['mem-001', 'mem-002', 'mem-003'],
    relevant_ids=['mem-001', 'mem-003'],
    irrelevant_ids=['mem-002']
)

time.sleep(0.5)
print('Context relevance signal emitted')
"

if check_signal_created; then
    echo -e "  ${GREEN}Context relevance signal created${NC}"
    signal_content=$(get_latest_signal)
    if echo "$signal_content" | grep -q '"type": "context_relevance"'; then
        echo -e "  ${GREEN}Signal type correct${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}Signal type incorrect${NC}"
        ((TESTS_FAILED++))
    fi
    if echo "$signal_content" | grep -q '"query": "authentication patterns"'; then
        echo -e "  ${GREEN}Query correct${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}Query incorrect${NC}"
        ((TESTS_FAILED++))
    fi
else
    echo -e "  ${RED}No context relevance signal created${NC}"
    ((TESTS_FAILED+=2))
fi
((TESTS_RUN+=2))

echo ""
echo "Test 5: Tool statistics tracking"
echo "----------------------------------------------"

run_python_test "
from pathlib import Path

loki_dir = Path('$TEST_LOKI_DIR')
collector = MCPLearningCollector(loki_dir=loki_dir, enabled=False)  # Disable emission for stats test

# Record multiple calls
collector.emit_tool_efficiency('test_tool', 'call1', 100, True)
collector.emit_tool_efficiency('test_tool', 'call2', 150, True)
collector.emit_tool_efficiency('test_tool', 'call3', 200, False)

# Check stats
stats = collector.get_tool_stats('test_tool')
assert stats is not None, 'Stats should exist'
assert stats.total_calls == 3, f'Expected 3 calls, got {stats.total_calls}'
assert stats.successful_calls == 2, f'Expected 2 successful, got {stats.successful_calls}'
assert stats.failed_calls == 1, f'Expected 1 failed, got {stats.failed_calls}'
assert 0.6 <= stats.success_rate <= 0.7, f'Expected success rate ~0.67, got {stats.success_rate}'

print('Stats tracking working correctly')
print(f'  Total calls: {stats.total_calls}')
print(f'  Success rate: {stats.success_rate:.2f}')
print(f'  Avg time: {stats.avg_execution_time_ms}ms')
"

if [ $? -eq 0 ]; then
    echo -e "  ${GREEN}Tool statistics tracking works${NC}"
    ((TESTS_PASSED++))
else
    echo -e "  ${RED}Tool statistics tracking failed${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 6: ToolCallTracker context manager"
echo "----------------------------------------------"

clear_signals
run_python_test "
from pathlib import Path
import time

loki_dir = Path('$TEST_LOKI_DIR')
collector = MCPLearningCollector(loki_dir=loki_dir)

# Test successful call with context manager
with collector.track_tool_call('loki_state_get', {'include_memory': True}) as tracker:
    # Simulate tool execution
    time.sleep(0.1)
    tracker.set_result({'state': 'active'}, success=True)

time.sleep(0.5)
print('Context manager test completed')
"

if check_signal_created; then
    echo -e "  ${GREEN}Context manager emitted signal${NC}"
    signal_content=$(get_latest_signal)
    if echo "$signal_content" | grep -q '"tool_name": "loki_state_get"'; then
        echo -e "  ${GREEN}Tool name correct${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "  ${RED}Tool name incorrect${NC}"
        ((TESTS_FAILED++))
    fi
else
    echo -e "  ${RED}No signal from context manager${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 7: Non-blocking emission (performance)"
echo "----------------------------------------------"

clear_signals
run_python_test "
from pathlib import Path
import time
import sys

loki_dir = Path('$TEST_LOKI_DIR')
collector = MCPLearningCollector(loki_dir=loki_dir)

# Measure time for emission
start = time.time()
for i in range(10):
    collector.emit_tool_efficiency(
        tool_name=f'tool_{i}',
        action='test_call',
        execution_time_ms=100,
        success=True
    )
elapsed = time.time() - start

# Emission should be fast (non-blocking)
if elapsed < 0.5:
    print(f'Emission is non-blocking: {elapsed:.3f}s for 10 emissions')
    sys.exit(0)
else:
    print(f'Emission too slow: {elapsed:.3f}s for 10 emissions')
    sys.exit(1)
"

if [ $? -eq 0 ]; then
    echo -e "  ${GREEN}Emission is non-blocking${NC}"
    ((TESTS_PASSED++))
else
    echo -e "  ${RED}Emission is blocking (too slow)${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 8: Disabled collector"
echo "----------------------------------------------"

clear_signals
run_python_test "
from pathlib import Path
import time

loki_dir = Path('$TEST_LOKI_DIR')
collector = MCPLearningCollector(loki_dir=loki_dir, enabled=False)

# This should not create any signals
collector.emit_tool_efficiency(
    tool_name='disabled_tool',
    action='test_call',
    execution_time_ms=100,
    success=True
)

time.sleep(0.5)
print('Disabled collector test completed')
"

signal_count=$(count_signals)
if [ "$signal_count" -eq "0" ]; then
    echo -e "  ${GREEN}Disabled collector does not emit signals${NC}"
    ((TESTS_PASSED++))
else
    echo -e "  ${RED}Disabled collector should not emit signals${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 9: Stats summary"
echo "----------------------------------------------"

run_python_test "
from pathlib import Path

loki_dir = Path('$TEST_LOKI_DIR')
collector = MCPLearningCollector(loki_dir=loki_dir, enabled=False)

# Record calls for multiple tools
collector.emit_tool_efficiency('tool_a', 'call1', 100, True)
collector.emit_tool_efficiency('tool_a', 'call2', 150, True)
collector.emit_tool_efficiency('tool_b', 'call1', 200, False)

# Get summary
summary = collector.get_stats_summary()
assert summary['total_tools'] == 2, f\"Expected 2 tools, got {summary['total_tools']}\"
assert summary['total_calls'] == 3, f\"Expected 3 calls, got {summary['total_calls']}\"
assert summary['total_successful'] == 2, f\"Expected 2 successful, got {summary['total_successful']}\"
assert summary['total_failed'] == 1, f\"Expected 1 failed, got {summary['total_failed']}\"

print('Stats summary correct:')
print(f\"  Tools: {summary['total_tools']}\")
print(f\"  Total calls: {summary['total_calls']}\")
print(f\"  Successful: {summary['total_successful']}\")
print(f\"  Failed: {summary['total_failed']}\")
"

if [ $? -eq 0 ]; then
    echo -e "  ${GREEN}Stats summary works${NC}"
    ((TESTS_PASSED++))
else
    echo -e "  ${RED}Stats summary failed${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "Test 10: ToolStats properties"
echo "----------------------------------------------"

run_python_test "
from pathlib import Path

# Test ToolStats directly
stats = ToolStats(tool_name='test_tool')
assert stats.total_calls == 0
assert stats.success_rate == 1.0  # Default for no calls
assert stats.avg_execution_time_ms == 0

# Record some calls
stats.record_call(True, 100)
stats.record_call(True, 200)
stats.record_call(False, 150)

assert stats.total_calls == 3
assert stats.successful_calls == 2
assert stats.failed_calls == 1
assert stats.success_rate == 2/3
assert stats.avg_execution_time_ms == 150
assert stats.last_call_time is not None

print('ToolStats properties correct')
"

if [ $? -eq 0 ]; then
    echo -e "  ${GREEN}ToolStats properties work${NC}"
    ((TESTS_PASSED++))
else
    echo -e "  ${RED}ToolStats properties failed${NC}"
    ((TESTS_FAILED++))
fi
((TESTS_RUN++))

echo ""
echo "=============================================="
echo "  Test Results"
echo "=============================================="
echo ""
echo "  Tests run:    $TESTS_RUN"
echo "  Tests passed: $TESTS_PASSED"
echo "  Tests failed: $TESTS_FAILED"
echo ""

if [ "$TESTS_FAILED" -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
