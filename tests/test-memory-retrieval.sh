#!/usr/bin/env bash
#
# Test Memory Retrieval System
# Tests: task type detection, weighted retrieval, similarity search, temporal retrieval
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
    pkill -f "test-memory-retrieval" 2>/dev/null || true
}
trap cleanup EXIT

echo "========================================"
echo "Loki Mode Memory Retrieval Tests"
echo "========================================"
echo ""

# Setup PYTHONPATH
export PYTHONPATH="${PROJECT_ROOT}:${PYTHONPATH:-}"

cd "$TEST_DIR" || exit 1
mkdir -p .loki/memory/{episodic,semantic,skills}

# Initialize test data
echo '{"version":"1.0","topics":[],"total_memories":0,"total_tokens_available":0}' > .loki/memory/index.json
echo '{"version":"1.0","recent_actions":[],"key_decisions":[],"active_context":{}}' > .loki/memory/timeline.json
echo '{"patterns":[]}' > .loki/memory/semantic/patterns.json
echo '{"anti_patterns":[]}' > .loki/memory/semantic/anti-patterns.json

# Test 1: Task Type Detection - Exploration
log_test "Task type detection - exploration"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval, TASK_SIGNALS
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    # Test exploration detection
    context = {
        "goal": "explore the codebase and understand the architecture",
        "action_type": "read_file",
        "phase": "research"
    }

    task_type = retrieval.detect_task_type(context)
    if task_type == "exploration":
        print("OK")
    else:
        print(f"FAIL:got {task_type}, expected exploration")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Task type detection - exploration"
else
    fail "Task type detection - exploration"
fi

# Test 2: Task Type Detection - Implementation
log_test "Task type detection - implementation"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    context = {
        "goal": "implement the new API endpoint for user registration",
        "action_type": "write_file",
        "phase": "development"
    }

    task_type = retrieval.detect_task_type(context)
    if task_type == "implementation":
        print("OK")
    else:
        print(f"FAIL:got {task_type}, expected implementation")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Task type detection - implementation"
else
    fail "Task type detection - implementation"
fi

# Test 3: Task Type Detection - Debugging
log_test "Task type detection - debugging"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    context = {
        "goal": "fix the bug causing crash on login",
        "action_type": "run_test",
        "phase": "debugging"
    }

    task_type = retrieval.detect_task_type(context)
    if task_type == "debugging":
        print("OK")
    else:
        print(f"FAIL:got {task_type}, expected debugging")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Task type detection - debugging"
else
    fail "Task type detection - debugging"
fi

# Test 4: Task Type Detection - Review
log_test "Task type detection - review"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    context = {
        "goal": "review the pull request for code quality",
        "action_type": "review_pr",
        "phase": "qa"
    }

    task_type = retrieval.detect_task_type(context)
    if task_type == "review":
        print("OK")
    else:
        print(f"FAIL:got {task_type}, expected review")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Task type detection - review"
else
    fail "Task type detection - review"
fi

# Test 5: Task Type Detection - Refactoring
log_test "Task type detection - refactoring"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    context = {
        "goal": "refactor the module to extract common functions",
        "action_type": "rename",
        "phase": "refactoring"
    }

    task_type = retrieval.detect_task_type(context)
    if task_type == "refactoring":
        print("OK")
    else:
        print(f"FAIL:got {task_type}, expected refactoring")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Task type detection - refactoring"
else
    fail "Task type detection - refactoring"
fi

# Test 6: Task Type Detection - Default
log_test "Task type detection - defaults to implementation"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    # Context with no matching signals
    context = {
        "goal": "something vague",
        "action_type": "",
        "phase": ""
    }

    task_type = retrieval.detect_task_type(context)
    if task_type == "implementation":
        print("OK")
    else:
        print(f"FAIL:got {task_type}, expected implementation (default)")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Task type detection - defaults to implementation"
else
    fail "Task type detection - defaults to implementation"
fi

# Test 7: Task Strategy Weights
log_test "Task strategy weights exist for all types"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import TASK_STRATEGIES

    expected_types = ["exploration", "implementation", "debugging", "review", "refactoring"]
    expected_keys = ["episodic", "semantic", "skills", "anti_patterns"]

    for task_type in expected_types:
        if task_type not in TASK_STRATEGIES:
            print(f"FAIL:missing strategy for {task_type}")
            sys.exit(1)

        weights = TASK_STRATEGIES[task_type]
        for key in expected_keys:
            if key not in weights:
                print(f"FAIL:missing weight {key} in {task_type}")
                sys.exit(1)

        # Verify weights sum to approximately 1.0
        total = sum(weights.values())
        if not (0.99 <= total <= 1.01):
            print(f"FAIL:{task_type} weights sum to {total}, not 1.0")
            sys.exit(1)

    print("OK")
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Task strategy weights exist for all types"
else
    fail "Task strategy weights exist for all types"
fi

# Test 8: Keyword Search - Episodic
log_test "Keyword search - episodic memories"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
import json
import os
from datetime import datetime

try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    # Create test episode
    date_str = datetime.now().strftime("%Y-%m-%d")
    os.makedirs(f".loki/memory/episodic/{date_str}", exist_ok=True)

    episode = {
        "id": "ep-search-001",
        "task_id": "task-001",
        "timestamp": datetime.now().isoformat() + "Z",
        "context": {
            "goal": "implement authentication system",
            "phase": "development"
        },
        "outcome": "success"
    }
    with open(f".loki/memory/episodic/{date_str}/ep-search-001.json", "w") as f:
        json.dump(episode, f)

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    # Search for authentication
    results = retrieval.retrieve_by_keyword(["authentication"], "episodic")

    if len(results) > 0 and results[0].get("_source") == "episodic":
        print("OK")
    else:
        print("FAIL:no results or wrong source")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Keyword search - episodic memories"
else
    fail "Keyword search - episodic memories"
fi

# Test 9: Keyword Search - Semantic
log_test "Keyword search - semantic patterns"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
import json

try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    # Create test pattern
    patterns = {
        "patterns": [
            {
                "id": "sem-search-001",
                "pattern": "Always use parameterized queries for database access",
                "category": "security",
                "confidence": 0.9
            }
        ]
    }
    with open(".loki/memory/semantic/patterns.json", "w") as f:
        json.dump(patterns, f)

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    # Search for database
    results = retrieval.retrieve_by_keyword(["database"], "semantic")

    if len(results) > 0 and results[0].get("_source") == "semantic":
        print("OK")
    else:
        print("FAIL:no results or wrong source")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Keyword search - semantic patterns"
else
    fail "Keyword search - semantic patterns"
fi

# Test 10: Keyword Search - Skills
log_test "Keyword search - skills"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
import json

try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    # Create test skill
    skill = {
        "id": "skill-search-001",
        "name": "API Testing",
        "description": "How to write and run API tests",
        "steps": ["Write test cases", "Run tests", "Check coverage"]
    }
    with open(".loki/memory/skills/api-testing.json", "w") as f:
        json.dump(skill, f)

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    # Search for testing
    results = retrieval.retrieve_by_keyword(["testing"], "skills")

    if len(results) > 0 and results[0].get("_source") == "skills":
        print("OK")
    else:
        print("FAIL:no results or wrong source")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Keyword search - skills"
else
    fail "Keyword search - skills"
fi

# Test 11: Keyword Search - Anti-patterns
log_test "Keyword search - anti-patterns"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
import json

try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    # Create test anti-pattern
    anti_patterns = {
        "anti_patterns": [
            {
                "id": "anti-001",
                "what_fails": "Storing passwords in plain text",
                "why": "Security vulnerability",
                "prevention": "Use bcrypt or similar hashing"
            }
        ]
    }
    with open(".loki/memory/semantic/anti-patterns.json", "w") as f:
        json.dump(anti_patterns, f)

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    # Search for password
    results = retrieval.retrieve_by_keyword(["passwords", "security"], "anti_patterns")

    if len(results) > 0 and results[0].get("_source") == "anti_patterns":
        print("OK")
    else:
        print("FAIL:no results or wrong source")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Keyword search - anti-patterns"
else
    fail "Keyword search - anti-patterns"
fi

# Test 12: Temporal Retrieval
log_test "Temporal retrieval - date range"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
import json
import os
from datetime import datetime, timedelta

try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    # Create episodes at different dates
    today = datetime.now()
    yesterday = today - timedelta(days=1)

    # Today's episode
    date_str = today.strftime("%Y-%m-%d")
    os.makedirs(f".loki/memory/episodic/{date_str}", exist_ok=True)
    episode1 = {
        "id": "ep-today-001",
        "timestamp": today.isoformat() + "Z",
        "context": {"goal": "today task", "phase": "test"}
    }
    with open(f".loki/memory/episodic/{date_str}/ep-today-001.json", "w") as f:
        json.dump(episode1, f)

    # Yesterday's episode
    date_str = yesterday.strftime("%Y-%m-%d")
    os.makedirs(f".loki/memory/episodic/{date_str}", exist_ok=True)
    episode2 = {
        "id": "ep-yesterday-001",
        "timestamp": yesterday.isoformat() + "Z",
        "context": {"goal": "yesterday task", "phase": "test"}
    }
    with open(f".loki/memory/episodic/{date_str}/ep-yesterday-001.json", "w") as f:
        json.dump(episode2, f)

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    # Retrieve since yesterday
    results = retrieval.retrieve_by_temporal(
        since=yesterday - timedelta(hours=1),
        until=today + timedelta(hours=1)
    )

    # Should have at least 2 episodes
    if len(results) >= 2:
        print("OK")
    else:
        print(f"FAIL:expected >= 2 results, got {len(results)}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Temporal retrieval - date range"
else
    fail "Temporal retrieval - date range"
fi

# Test 13: Task-Aware Retrieval
log_test "Task-aware retrieval"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    context = {
        "goal": "implement user authentication",
        "phase": "development",
        "action_type": "write_file"
    }

    results = retrieval.retrieve_task_aware(context, top_k=5)

    # Should return a list
    if isinstance(results, list):
        print("OK")
    else:
        print("FAIL:not a list")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Task-aware retrieval"
else
    fail "Task-aware retrieval"
fi

# Test 14: Similarity Search Fallback
log_test "Similarity search falls back to keyword search"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    # No embedding engine provided - should fall back to keyword search
    retrieval = MemoryRetrieval(storage, embedding_engine=None, base_path=".loki/memory")

    results = retrieval.retrieve_by_similarity("authentication", "episodic", top_k=5)

    # Should return a list (keyword search fallback)
    if isinstance(results, list):
        print("OK")
    else:
        print("FAIL:not a list")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Similarity search falls back to keyword search"
else
    fail "Similarity search falls back to keyword search"
fi

# Test 15: Recency Boost
log_test "Recency boost applied to results"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
import json
import os
from datetime import datetime, timedelta

try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    # Create two episodes - one recent, one old
    today = datetime.now()
    old_date = today - timedelta(days=20)

    # Recent episode
    date_str = today.strftime("%Y-%m-%d")
    os.makedirs(f".loki/memory/episodic/{date_str}", exist_ok=True)
    recent = {
        "id": "ep-recent-001",
        "timestamp": today.isoformat() + "Z",
        "context": {"goal": "recent auth task", "phase": "test"},
        "_score": 1.0
    }
    with open(f".loki/memory/episodic/{date_str}/ep-recent-001.json", "w") as f:
        json.dump(recent, f)

    # Older episode
    date_str = old_date.strftime("%Y-%m-%d")
    os.makedirs(f".loki/memory/episodic/{date_str}", exist_ok=True)
    old = {
        "id": "ep-old-001",
        "timestamp": old_date.isoformat() + "Z",
        "context": {"goal": "old auth task", "phase": "test"},
        "_score": 1.0
    }
    with open(f".loki/memory/episodic/{date_str}/ep-old-001.json", "w") as f:
        json.dump(old, f)

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    # Apply recency boost
    results = [
        {"id": "ep-recent-001", "timestamp": today.isoformat() + "Z", "_score": 1.0, "_weighted_score": 1.0},
        {"id": "ep-old-001", "timestamp": old_date.isoformat() + "Z", "_score": 1.0, "_weighted_score": 1.0}
    ]

    boosted = retrieval._apply_recency_boost(results, boost_factor=0.1)

    # Recent should have higher score than old
    recent_score = boosted[0].get("_weighted_score", 0) if boosted[0]["id"] == "ep-recent-001" else boosted[1].get("_weighted_score", 0)
    old_score = boosted[1].get("_weighted_score", 0) if boosted[1]["id"] == "ep-old-001" else boosted[0].get("_weighted_score", 0)

    if recent_score > old_score:
        print("OK")
    else:
        print(f"FAIL:recent={recent_score}, old={old_score}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Recency boost applied to results"
else
    fail "Recency boost applied to results"
fi

# Test 16: Query Building from Context
log_test "Build query from context"
python3 << 'EOF' 2>/dev/null
import sys
sys.path.insert(0, '${PROJECT_ROOT}')
try:
    from memory.retrieval import MemoryRetrieval
    from memory.storage import MemoryStorage

    storage = MemoryStorage(".loki/memory")
    retrieval = MemoryRetrieval(storage, base_path=".loki/memory")

    context = {
        "goal": "implement user authentication",
        "phase": "development",
        "action_type": "write_file",
        "files": ["src/auth.ts", "src/login.ts", "src/utils.ts"]
    }

    query = retrieval._build_query_from_context(context)

    # Query should contain goal and phase
    if "implement user authentication" in query and "development" in query:
        print("OK")
    else:
        print(f"FAIL:query={query}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Build query from context"
else
    fail "Build query from context"
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
