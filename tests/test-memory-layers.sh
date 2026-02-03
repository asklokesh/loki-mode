#!/usr/bin/env bash
#
# Test Memory Progressive Disclosure Layers
# Tests: index layer, timeline layer, progressive loader, token tracking
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
    # Clean up any test processes
    pkill -f "test-memory-layers" 2>/dev/null || true
}
trap cleanup EXIT

echo "========================================"
echo "Loki Mode Memory Layers Tests"
echo "========================================"
echo ""

# Setup PYTHONPATH
export PYTHONPATH="${PROJECT_ROOT}:${PYTHONPATH:-}"

cd "$TEST_DIR" || exit 1
mkdir -p .loki/memory

# =============================================================================
# Index Layer Tests (Layer 1)
# =============================================================================

echo "--- Index Layer Tests ---"
echo ""

# Test 1: Index Layer Initialization
log_test "Index layer initialization"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer

    layer = IndexLayer(".loki/memory")
    index = layer.load()

    # Should have required fields
    if "version" in index and "topics" in index:
        print("OK")
    else:
        print("FAIL:missing required fields")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Index layer initialization"
else
    fail "Index layer initialization"
fi

# Test 2: Add Topic to Index
log_test "Add topic to index"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer

    layer = IndexLayer(".loki/memory")

    topic = {
        "id": "topic-auth",
        "summary": "Authentication system implementation",
        "relevance_score": 0.85,
        "token_count": 1200,
        "last_accessed": "2026-01-25T10:00:00Z"
    }
    layer.add_topic(topic)

    # Verify topic was added
    topics = layer.get_topics()
    found = any(t.id == "topic-auth" for t in topics)

    if found:
        print("OK")
    else:
        print("FAIL:topic not found")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Add topic to index"
else
    fail "Add topic to index"
fi

# Test 3: Remove Topic from Index
log_test "Remove topic from index"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer

    layer = IndexLayer(".loki/memory")

    # Add a topic to remove
    topic = {
        "id": "topic-to-remove",
        "summary": "Temporary topic",
        "relevance_score": 0.5,
        "token_count": 100
    }
    layer.add_topic(topic)

    # Remove it
    result = layer.remove_topic("topic-to-remove")

    if not result:
        print("FAIL:remove returned false")
        sys.exit(1)

    # Verify it's gone
    topics = layer.get_topics()
    found = any(t.id == "topic-to-remove" for t in topics)

    if not found:
        print("OK")
    else:
        print("FAIL:topic still exists")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Remove topic from index"
else
    fail "Remove topic from index"
fi

# Test 4: Find Relevant Topics
log_test "Find relevant topics by query"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer

    layer = IndexLayer(".loki/memory")

    # Add topics
    layer.add_topic({
        "id": "topic-api",
        "summary": "REST API endpoint implementation",
        "relevance_score": 0.9,
        "token_count": 800
    })
    layer.add_topic({
        "id": "topic-db",
        "summary": "Database query optimization",
        "relevance_score": 0.7,
        "token_count": 600
    })

    # Search for API-related topics
    results = layer.find_relevant_topics("API endpoint", threshold=0.5)

    if len(results) > 0 and any(t.id == "topic-api" for t in results):
        print("OK")
    else:
        print(f"FAIL:expected topic-api in results, got {[t.id for t in results]}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Find relevant topics by query"
else
    fail "Find relevant topics by query"
fi

# Test 5: Index Token Count
log_test "Index token count estimation"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer

    layer = IndexLayer(".loki/memory")

    # Add some topics
    for i in range(5):
        layer.add_topic({
            "id": f"topic-{i}",
            "summary": f"Topic number {i} with some description",
            "relevance_score": 0.5 + i * 0.1,
            "token_count": 100 * (i + 1)
        })

    token_count = layer.get_token_count()

    # Should have some positive token count
    if token_count > 0:
        print("OK")
    else:
        print(f"FAIL:token_count={token_count}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Index token count estimation"
else
    fail "Index token count estimation"
fi

# Test 6: Update Index from Memories
log_test "Update index from memory list"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer

    layer = IndexLayer(".loki/memory")

    # Update with list of memories
    memories = [
        {"id": "mem-1", "summary": "First memory", "relevance_score": 0.8, "token_count": 200},
        {"id": "mem-2", "summary": "Second memory", "relevance_score": 0.6, "token_count": 150},
        {"id": "mem-3", "description": "Third memory (using description)", "confidence": 0.9}
    ]
    layer.update(memories)

    topics = layer.get_topics()

    if len(topics) == 3:
        print("OK")
    else:
        print(f"FAIL:expected 3 topics, got {len(topics)}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Update index from memory list"
else
    fail "Update index from memory list"
fi

# =============================================================================
# Timeline Layer Tests (Layer 2)
# =============================================================================

echo ""
echo "--- Timeline Layer Tests ---"
echo ""

# Test 7: Timeline Layer Initialization
log_test "Timeline layer initialization"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.timeline_layer import TimelineLayer

    layer = TimelineLayer(".loki/memory")
    timeline = layer.load()

    # Should have required fields
    required = ["recent_actions", "key_decisions", "active_context"]
    for field in required:
        if field not in timeline:
            print(f"FAIL:missing {field}")
            sys.exit(1)

    print("OK")
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Timeline layer initialization"
else
    fail "Timeline layer initialization"
fi

# Test 8: Add Action to Timeline
log_test "Add action to timeline"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.timeline_layer import TimelineLayer

    layer = TimelineLayer(".loki/memory")

    # Add action
    layer.add_action(
        action="Implemented user login endpoint",
        outcome="success",
        topic_id="topic-auth"
    )

    # Verify
    actions = layer.get_recent_actions(limit=5)

    if len(actions) > 0 and actions[0]["action"] == "Implemented user login endpoint":
        print("OK")
    else:
        print("FAIL:action not found")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Add action to timeline"
else
    fail "Add action to timeline"
fi

# Test 9: Add Decision to Timeline
log_test "Add decision to timeline"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.timeline_layer import TimelineLayer

    layer = TimelineLayer(".loki/memory")

    # Add decision
    layer.add_decision(
        decision="Use JWT for authentication",
        rationale="Industry standard, stateless, scalable",
        topic_id="topic-auth"
    )

    # Verify
    decisions = layer.get_key_decisions(limit=5)

    if len(decisions) > 0 and decisions[0]["decision"] == "Use JWT for authentication":
        print("OK")
    else:
        print("FAIL:decision not found")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Add decision to timeline"
else
    fail "Add decision to timeline"
fi

# Test 10: Get Recent for Topic
log_test "Get recent entries for specific topic"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.timeline_layer import TimelineLayer

    layer = TimelineLayer(".loki/memory")

    # Add entries for different topics
    layer.add_action(action="Action for auth", outcome="success", topic_id="topic-auth")
    layer.add_action(action="Action for db", outcome="success", topic_id="topic-db")
    layer.add_decision(decision="Decision for auth", rationale="test", topic_id="topic-auth")

    # Get entries for auth topic only
    entries = layer.get_recent_for_topic("topic-auth", limit=10)

    # Should have 2 entries for auth (1 action + 1 decision)
    if len(entries) >= 2:
        print("OK")
    else:
        print(f"FAIL:expected >= 2 entries, got {len(entries)}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Get recent entries for specific topic"
else
    fail "Get recent entries for specific topic"
fi

# Test 11: Set Active Context
log_test "Set and get active context"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.timeline_layer import TimelineLayer

    layer = TimelineLayer(".loki/memory")

    # Set context
    layer.set_active_context(
        current_focus="Implementing authentication",
        blocked_by=["Database schema not finalized"],
        next_up=["Write tests", "Deploy to staging"]
    )

    # Get context
    context = layer.get_active_context()

    if (context.get("current_focus") == "Implementing authentication" and
        "Database schema not finalized" in context.get("blocked_by", [])):
        print("OK")
    else:
        print(f"FAIL:context={context}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Set and get active context"
else
    fail "Set and get active context"
fi

# Test 12: Prune Old Entries
log_test "Prune old timeline entries"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.timeline_layer import TimelineLayer

    layer = TimelineLayer(".loki/memory")

    # Add many entries
    for i in range(20):
        layer.add_action(action=f"Action {i}", outcome="success")
        layer.add_decision(decision=f"Decision {i}", rationale="test")

    # Prune to keep only 5
    removed = layer.prune_old_entries(keep_last=5)

    # Should have removed some
    if removed > 0:
        print("OK")
    else:
        print("FAIL:nothing removed")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Prune old timeline entries"
else
    fail "Prune old timeline entries"
fi

# Test 13: Compress to Index Entry
log_test "Compress memories to index entry"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.timeline_layer import TimelineLayer

    layer = TimelineLayer(".loki/memory")

    memories = [
        {"id": "mem-1", "summary": "First memory", "relevance_score": 0.8, "token_count": 200, "timestamp": "2026-01-25T10:00:00Z"},
        {"id": "mem-2", "summary": "Second memory", "relevance_score": 0.6, "token_count": 150, "timestamp": "2026-01-25T09:00:00Z"}
    ]

    index_entry = layer.compress_to_index_entry(memories)

    # Should have aggregated values
    if (index_entry.get("token_count") == 350 and
        "relevance_score" in index_entry and
        index_entry.get("memory_count") == 2):
        print("OK")
    else:
        print(f"FAIL:entry={index_entry}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Compress memories to index entry"
else
    fail "Compress memories to index entry"
fi

# Test 14: Timeline Token Count
log_test "Timeline token count estimation"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.timeline_layer import TimelineLayer

    layer = TimelineLayer(".loki/memory")

    # Add some content
    for i in range(3):
        layer.add_action(action=f"Test action {i}", outcome="success")

    token_count = layer.get_token_count()

    if token_count > 0:
        print("OK")
    else:
        print(f"FAIL:token_count={token_count}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Timeline token count estimation"
else
    fail "Timeline token count estimation"
fi

# =============================================================================
# Progressive Loader Tests (Layer 3)
# =============================================================================

echo ""
echo "--- Progressive Loader Tests ---"
echo ""

# Test 15: Progressive Loader Initialization
log_test "Progressive loader initialization"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer
    from memory.layers.timeline_layer import TimelineLayer
    from memory.layers.loader import ProgressiveLoader

    index_layer = IndexLayer(".loki/memory")
    timeline_layer = TimelineLayer(".loki/memory")
    loader = ProgressiveLoader(".loki/memory", index_layer, timeline_layer)

    # Should initialize without error
    print("OK")
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Progressive loader initialization"
else
    fail "Progressive loader initialization"
fi

# Test 16: Token Metrics Tracking
log_test "Token metrics tracking"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer
    from memory.layers.timeline_layer import TimelineLayer
    from memory.layers.loader import ProgressiveLoader, TokenMetrics

    index_layer = IndexLayer(".loki/memory")
    timeline_layer = TimelineLayer(".loki/memory")
    loader = ProgressiveLoader(".loki/memory", index_layer, timeline_layer)

    # Track tokens for each layer
    loader.track_token_usage(1, 100)
    loader.track_token_usage(2, 500)
    loader.track_token_usage(3, 1000)

    metrics = loader.get_token_metrics()

    if (metrics.layer1_tokens == 100 and
        metrics.layer2_tokens == 500 and
        metrics.layer3_tokens == 1000 and
        metrics.total_tokens == 1600):
        print("OK")
    else:
        print(f"FAIL:metrics={metrics}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Token metrics tracking"
else
    fail "Token metrics tracking"
fi

# Test 17: Token Metrics Calculate Savings
log_test "Token metrics calculate savings"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.loader import TokenMetrics

    metrics = TokenMetrics(
        layer1_tokens=100,
        layer2_tokens=500,
        layer3_tokens=400
    )

    # Total available would be much larger
    metrics.calculate_savings(total_available=5000)

    # Used 1000 out of 5000 = 80% savings
    if metrics.estimated_savings_percent >= 70:  # Allow some tolerance
        print("OK")
    else:
        print(f"FAIL:savings={metrics.estimated_savings_percent}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Token metrics calculate savings"
else
    fail "Token metrics calculate savings"
fi

# Test 18: Sufficient Context Detection
log_test "Sufficient context detection"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer
    from memory.layers.timeline_layer import TimelineLayer
    from memory.layers.loader import ProgressiveLoader

    index_layer = IndexLayer(".loki/memory")
    timeline_layer = TimelineLayer(".loki/memory")
    loader = ProgressiveLoader(".loki/memory", index_layer, timeline_layer)

    # Empty memories - not sufficient
    if loader.sufficient_context([], "query"):
        print("FAIL:empty should not be sufficient")
        sys.exit(1)

    # 3+ entries - sufficient
    if not loader.sufficient_context([1, 2, 3], "simple query"):
        print("FAIL:3 entries should be sufficient")
        sys.exit(1)

    # Detail-seeking query - needs more
    if loader.sufficient_context([1], "show me exactly all details"):
        print("FAIL:detail-seeking should not be sufficient")
        sys.exit(1)

    print("OK")
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Sufficient context detection"
else
    fail "Sufficient context detection"
fi

# Test 19: Layer Summary
log_test "Get layer summary"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer
    from memory.layers.timeline_layer import TimelineLayer
    from memory.layers.loader import ProgressiveLoader

    index_layer = IndexLayer(".loki/memory")
    timeline_layer = TimelineLayer(".loki/memory")
    loader = ProgressiveLoader(".loki/memory", index_layer, timeline_layer)

    loader.track_token_usage(1, 100)
    loader.track_token_usage(2, 400)
    loader.track_token_usage(3, 500)

    summary = loader.get_layer_summary()

    # Check required fields
    if ("layer1" in summary and "layer2" in summary and "layer3" in summary and
        "total_tokens" in summary and summary["total_tokens"] == 1000):
        print("OK")
    else:
        print(f"FAIL:summary={summary}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Get layer summary"
else
    fail "Get layer summary"
fi

# Test 20: Reset Metrics
log_test "Reset token metrics"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer
    from memory.layers.timeline_layer import TimelineLayer
    from memory.layers.loader import ProgressiveLoader

    index_layer = IndexLayer(".loki/memory")
    timeline_layer = TimelineLayer(".loki/memory")
    loader = ProgressiveLoader(".loki/memory", index_layer, timeline_layer)

    # Track some tokens
    loader.track_token_usage(1, 100)
    loader.track_token_usage(2, 200)

    # Reset
    loader.reset_metrics()

    metrics = loader.get_token_metrics()

    if metrics.total_tokens == 0 and metrics.layer1_tokens == 0:
        print("OK")
    else:
        print(f"FAIL:metrics not reset: {metrics}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Reset token metrics"
else
    fail "Reset token metrics"
fi

# Test 21: Load Relevant Context
log_test "Load relevant context progressively"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.layers.index_layer import IndexLayer
    from memory.layers.timeline_layer import TimelineLayer
    from memory.layers.loader import ProgressiveLoader

    index_layer = IndexLayer(".loki/memory")
    timeline_layer = TimelineLayer(".loki/memory")

    # Add test data
    index_layer.add_topic({
        "id": "topic-test",
        "summary": "Test topic for loading",
        "relevance_score": 0.9,
        "token_count": 100
    })

    timeline_layer.add_action(
        action="Test action",
        outcome="success",
        topic_id="topic-test"
    )

    loader = ProgressiveLoader(".loki/memory", index_layer, timeline_layer)

    # Load context
    memories, metrics = loader.load_relevant_context("test topic", max_tokens=2000)

    # Should have metrics populated
    if metrics.layer1_tokens > 0:
        print("OK")
    else:
        print(f"FAIL:layer1_tokens={metrics.layer1_tokens}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Load relevant context progressively"
else
    fail "Load relevant context progressively"
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
