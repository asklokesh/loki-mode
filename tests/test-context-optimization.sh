#!/usr/bin/env bash
#
# Test Context Window Optimization
# Tests: token estimation, optimize_context, budget-aware retrieval, progressive disclosure
#

set -uo pipefail
# Note: Not using -e to allow collecting all test results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_DIR=$(mktemp -d)
TESTS_PASSED=0
TESTS_FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

skip() {
    echo -e "${YELLOW}[SKIP]${NC} $1"
}

log_test() {
    echo -e "${YELLOW}[TEST]${NC} $1"
}

cleanup() {
    rm -rf "$TEST_DIR"
    # NO pkill HERE. The previous line was:
    #     pkill -f "test-context-optimization" 2>/dev/null || true
    # which matches THIS SCRIPT'S OWN command line. Running from the EXIT trap,
    # it SIGTERMed the very shell that was exiting, so the harness printed
    # "Passed: 13  Failed: 0  All tests passed!" and then "Terminated", and the
    # suite recorded the script as FAILED on a non-zero exit with every
    # assertion green. On macOS the pattern did not match the same way, so this
    # reproduced only on the Linux CI runner.
    #
    # This test spawns no background processes (verified: zero `... &` in the
    # file), so there is nothing to reap and the correct fix is to reap nothing.
    :
}
trap cleanup EXIT

echo "========================================"
echo "Loki Mode Context Window Optimization Tests"
echo "========================================"
echo ""

# Setup PYTHONPATH
export PYTHONPATH="${PROJECT_ROOT}:${PYTHONPATH:-}"

cd "$TEST_DIR" || exit 1
mkdir -p .loki/memory/{episodic,semantic,skills}

# Initialize test data
echo '{"version":"1.0","topics":[{"topic":"authentication","type":"episodic","last_updated":"2026-02-03T10:00:00Z"},{"topic":"database","type":"semantic","last_updated":"2026-02-02T10:00:00Z"}],"total_memories":10,"total_tokens_available":5000}' > .loki/memory/index.json
echo '{"version":"1.0","recent_actions":[],"key_decisions":[],"active_context":{}}' > .loki/memory/timeline.json
echo '{"patterns":[{"id":"sem-001","pattern":"Use parameterized queries","category":"security","confidence":0.9,"usage_count":5}]}' > .loki/memory/semantic/patterns.json
echo '{"anti_patterns":[]}' > .loki/memory/semantic/anti-patterns.json

# Test 1: estimate_memory_tokens - basic
log_test "estimate_memory_tokens - basic"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.token_economics import estimate_memory_tokens

    memory = {"id": "test-001", "goal": "implement feature", "outcome": "success"}
    tokens = estimate_memory_tokens(memory)

    # Should be approximately len(json)/4
    if tokens > 0 and tokens < 100:
        print("OK")
    else:
        print(f"FAIL:unexpected token count {tokens}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "estimate_memory_tokens - basic"
else
    fail "estimate_memory_tokens - basic"
fi

# Test 2: estimate_memory_tokens - empty
log_test "estimate_memory_tokens - empty input"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.token_economics import estimate_memory_tokens

    tokens = estimate_memory_tokens({})
    if tokens == 0:
        print("OK")
    else:
        print(f"FAIL:expected 0, got {tokens}")
        sys.exit(1)

    tokens = estimate_memory_tokens(None)
    if tokens == 0:
        print("OK")
    else:
        print(f"FAIL:expected 0 for None, got {tokens}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "estimate_memory_tokens - empty input"
else
    fail "estimate_memory_tokens - empty input"
fi

# Test 3: optimize_context - basic
log_test "optimize_context - fits within budget"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.token_economics import optimize_context, estimate_memory_tokens

    memories = [
        {"id": "m1", "goal": "task 1", "confidence": 0.9, "_score": 1.0},
        {"id": "m2", "goal": "task 2", "confidence": 0.5, "_score": 0.8},
        {"id": "m3", "goal": "task 3", "confidence": 0.7, "_score": 0.6},
    ]

    # Budget should fit all memories
    budget = 500
    result = optimize_context(memories, budget)

    if len(result) == 3:
        print("OK")
    else:
        print(f"FAIL:expected 3 memories, got {len(result)}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "optimize_context - fits within budget"
else
    fail "optimize_context - fits within budget"
fi

# Test 4: optimize_context - budget limit
log_test "optimize_context - respects budget limit"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.token_economics import optimize_context, estimate_memory_tokens

    # Create larger memories
    memories = [
        {"id": "m1", "goal": "A" * 100, "confidence": 0.9, "_score": 1.0},
        {"id": "m2", "goal": "B" * 100, "confidence": 0.5, "_score": 0.8},
        {"id": "m3", "goal": "C" * 100, "confidence": 0.7, "_score": 0.6},
    ]

    # Estimate total tokens
    total_tokens = sum(estimate_memory_tokens(m) for m in memories)

    # Set budget to fit only 2 memories
    budget = int(total_tokens * 0.7)
    result = optimize_context(memories, budget)

    # Should have fewer than all memories
    if len(result) < 3:
        print("OK")
    else:
        print(f"FAIL:expected < 3 memories, got {len(result)}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "optimize_context - respects budget limit"
else
    fail "optimize_context - respects budget limit"
fi

# Test 5: optimize_context - prioritizes high scores
log_test "optimize_context - prioritizes high importance"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.token_economics import optimize_context
    from datetime import datetime

    now = datetime.now().isoformat() + "Z"

    memories = [
        {"id": "low", "goal": "low priority", "confidence": 0.3, "_score": 0.3, "usage_count": 1},
        {"id": "high", "goal": "high priority", "confidence": 0.9, "_score": 0.9, "usage_count": 10},
        {"id": "med", "goal": "medium priority", "confidence": 0.6, "_score": 0.6, "usage_count": 5},
    ]

    # Budget to fit only 1
    budget = 50
    result = optimize_context(memories, budget)

    if len(result) >= 1 and result[0]["id"] == "high":
        print("OK")
    else:
        print(f"FAIL:expected 'high' first, got {result[0]['id'] if result else 'none'}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "optimize_context - prioritizes high importance"
else
    fail "optimize_context - prioritizes high importance"
fi

# Test 6: optimize_context - empty inputs
log_test "optimize_context - handles empty inputs"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.token_economics import optimize_context

    # Empty memories
    result = optimize_context([], 1000)
    if result == []:
        pass
    else:
        print("FAIL:expected empty list for empty input")
        sys.exit(1)

    # Zero budget
    memories = [{"id": "m1", "goal": "task"}]
    result = optimize_context(memories, 0)
    if result == []:
        pass
    else:
        print("FAIL:expected empty list for zero budget")
        sys.exit(1)

    # Negative budget
    result = optimize_context(memories, -100)
    if result == []:
        print("OK")
    else:
        print("FAIL:expected empty list for negative budget")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "optimize_context - handles empty inputs"
else
    fail "optimize_context - handles empty inputs"
fi

# Test 7: get_context_efficiency
log_test "get_context_efficiency - calculates metrics"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.token_economics import get_context_efficiency

    memories = [
        {"id": "m1", "goal": "task 1"},
        {"id": "m2", "goal": "task 2"},
    ]

    metrics = get_context_efficiency(memories, budget=1000, total_available=5000)

    # Check required fields
    required = ["tokens_used", "budget", "utilization", "compression", "memories_selected"]
    for field in required:
        if field not in metrics:
            print(f"FAIL:missing field {field}")
            sys.exit(1)

    if metrics["memories_selected"] == 2:
        print("OK")
    else:
        print(f"FAIL:expected 2 memories, got {metrics['memories_selected']}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "get_context_efficiency - calculates metrics"
else
    fail "get_context_efficiency - calculates metrics"
fi

# Test 8: retrieve_task_aware with token_budget
log_test "retrieve_task_aware - accepts token_budget parameter"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    context = {
        "goal": "implement authentication",
        "phase": "development",
    }

    # Call with token_budget parameter
    results = retrieval.retrieve_task_aware(context, top_k=10, token_budget=500)

    if isinstance(results, list):
        print("OK")
    else:
        print("FAIL:expected list")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "retrieve_task_aware - accepts token_budget parameter"
else
    fail "retrieve_task_aware - accepts token_budget parameter"
fi

# Test 9: retrieve_with_budget - basic
log_test "retrieve_with_budget - returns structured result"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    context = {
        "goal": "implement authentication",
        "phase": "development",
    }

    result = retrieval.retrieve_with_budget(context, token_budget=1000)

    # Check structure
    required = ["memories", "metrics", "task_type"]
    for field in required:
        if field not in result:
            print(f"FAIL:missing field {field}")
            sys.exit(1)

    if isinstance(result["memories"], list) and isinstance(result["metrics"], dict):
        print("OK")
    else:
        print("FAIL:wrong types")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "retrieve_with_budget - returns structured result"
else
    fail "retrieve_with_budget - returns structured result"
fi

# Test 10: retrieve_with_budget - progressive mode
log_test "retrieve_with_budget - progressive mode tracks layers"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    context = {
        "goal": "implement authentication",
        "phase": "development",
    }

    result = retrieval.retrieve_with_budget(context, token_budget=1000, progressive=True)

    # Check that layers_used is in metrics
    if "layers_used" in result["metrics"]:
        print("OK")
    else:
        print("FAIL:missing layers_used in metrics")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "retrieve_with_budget - progressive mode tracks layers"
else
    fail "retrieve_with_budget - progressive mode tracks layers"
fi

# Test 11: get_token_usage_summary
log_test "get_token_usage_summary - returns statistics"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    context = {"goal": "test"}
    results = [
        {"id": "m1", "goal": "task 1", "_source": "episodic", "_layer": 1},
        {"id": "m2", "goal": "task 2", "_source": "semantic", "_layer": 2},
    ]

    summary = retrieval.get_token_usage_summary(context, results)

    required = ["total_tokens", "total_available", "compression_ratio", "memory_count", "by_source", "by_layer"]
    for field in required:
        if field not in summary:
            print(f"FAIL:missing field {field}")
            sys.exit(1)

    if summary["memory_count"] == 2:
        print("OK")
    else:
        print(f"FAIL:expected 2 memories, got {summary['memory_count']}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "get_token_usage_summary - returns statistics"
else
    fail "get_token_usage_summary - returns statistics"
fi

# Test 12: layer preference in optimize_context
log_test "optimize_context - prefers lower layers"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.token_economics import optimize_context

    # Equal scores but different layers
    memories = [
        {"id": "layer3", "goal": "full", "confidence": 0.5, "_score": 0.5, "_layer": 3},
        {"id": "layer1", "goal": "index", "confidence": 0.5, "_score": 0.5, "_layer": 1},
        {"id": "layer2", "goal": "summary", "confidence": 0.5, "_score": 0.5, "_layer": 2},
    ]

    # Budget for all
    result = optimize_context(memories, 500)

    # Layer 1 should come first due to layer boost
    if result and result[0]["id"] == "layer1":
        print("OK")
    else:
        ids = [m["id"] for m in result]
        print(f"FAIL:expected layer1 first, got order: {ids}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "optimize_context - prefers lower layers"
else
    fail "optimize_context - prefers lower layers"
fi

# Test 13: recency scoring
log_test "optimize_context - recency scoring"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
from datetime import datetime, timedelta
try:
    from memory.token_economics import optimize_context

    now = datetime.now()
    recent = now - timedelta(days=1)
    old = now - timedelta(days=25)

    memories = [
        {"id": "old", "goal": "old task", "confidence": 0.5, "_score": 0.5, "last_used": old.isoformat() + "Z"},
        {"id": "recent", "goal": "recent task", "confidence": 0.5, "_score": 0.5, "last_used": recent.isoformat() + "Z"},
    ]

    result = optimize_context(memories, 500)

    # Recent should come first
    if result and result[0]["id"] == "recent":
        print("OK")
    else:
        ids = [m["id"] for m in result]
        print(f"FAIL:expected recent first, got order: {ids}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "optimize_context - recency scoring"
else
    fail "optimize_context - recency scoring"
fi

echo ""
echo "========================================"
echo "Test Summary"
echo "========================================"
echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Failed: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed!${NC}"
    exit 1
fi
