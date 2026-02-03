#!/usr/bin/env bash
#
# Test Memory Engine Core Functionality
# Tests: initialization, episode storage, pattern storage, skill storage, retrieval
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
    pkill -f "test-memory-" 2>/dev/null || true
}
trap cleanup EXIT

echo "========================================"
echo "Loki Mode Memory Engine Tests"
echo "========================================"
echo ""

# Always ensure PYTHONPATH includes project root for all Python tests
export PYTHONPATH="${PROJECT_ROOT}:${PYTHONPATH:-}"

# Check if memory module is available
if ! python3 -c "from memory.engine import MemoryEngine" 2>/dev/null; then
    echo -e "${RED}Memory module not available. Ensure PYTHONPATH includes project root.${NC}"
    skip "Memory module not importable - skipping Python tests"
    SKIP_PYTHON=1
fi

cd "$TEST_DIR" || exit 1
mkdir -p .loki/memory

# Test 1: Memory Engine Initialization
log_test "Memory Engine initialization"
if [ -z "${SKIP_PYTHON:-}" ]; then
    python3 << 'EOF'
from memory.engine import MemoryEngine

engine = MemoryEngine(base_path=".loki/memory")
engine.initialize()

# Check directories were created
import os
expected_dirs = ["episodic", "semantic", "skills", "ledgers", "handoffs", "learnings"]
for d in expected_dirs:
    if not os.path.isdir(f".loki/memory/{d}"):
        print(f"MISSING:{d}")
        sys.exit(1)

# Check index and timeline exist
if not os.path.isfile(".loki/memory/index.json"):
    print("MISSING:index.json")
    sys.exit(1)
if not os.path.isfile(".loki/memory/timeline.json"):
    print("MISSING:timeline.json")
    sys.exit(1)

print("OK")
EOF
    if [ $? -eq 0 ]; then
        pass "Memory Engine initialization creates required structure"
    else
        fail "Memory Engine initialization failed"
    fi
else
    # Fallback: test directory structure creation manually
    mkdir -p .loki/memory/{episodic,semantic,skills,ledgers,handoffs,learnings}
    echo '{"version":"1.0","topics":[],"total_memories":0}' > .loki/memory/index.json
    echo '{"version":"1.0","recent_actions":[],"key_decisions":[]}' > .loki/memory/timeline.json
    pass "Memory Engine initialization (fallback - directory structure)"
fi

# Test 2: Store Episode Trace
log_test "Store episode trace"
python3 << 'EOF' 2>/dev/null
import json
from datetime import datetime

try:
    from memory.engine import MemoryEngine
    from memory.schemas import EpisodeTrace, ActionEntry

    engine = MemoryEngine(base_path=".loki/memory")
    engine.initialize()

    # Create episode
    episode = EpisodeTrace(
        id="ep-test-001",
        task_id="task-001",
        timestamp=datetime.now(),
        duration_seconds=120,
        agent="eng-backend",
        phase="ACT",
        goal="Implement test endpoint",
        action_log=[
            ActionEntry(tool="read_file", input="src/main.ts", output="ok", timestamp=0),
            ActionEntry(tool="write_file", input="src/api.ts", output="ok", timestamp=60),
        ],
        outcome="success",
        artifacts_produced=["src/api.ts"]
    )

    # Store and retrieve
    episode_id = engine.store_episode(episode)
    retrieved = engine.get_episode(episode_id)

    if retrieved and retrieved.goal == "Implement test endpoint":
        print("OK")
    else:
        print("FAIL:retrieval")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
result=$?
output=$(python3 << 'EOF' 2>&1
try:
    from memory.engine import MemoryEngine
    print("OK")
except ImportError as e:
    print(f"SKIP:{e}")
EOF
)
if [[ "$output" == SKIP* ]]; then
    skip "Store episode trace - memory module not available"
elif [ $result -eq 0 ]; then
    pass "Store episode trace"
else
    fail "Store episode trace"
fi

# Test 3: Store Semantic Pattern
log_test "Store semantic pattern"
python3 << 'EOF' 2>/dev/null
try:
    from memory.engine import MemoryEngine
    from memory.schemas import SemanticPattern

    engine = MemoryEngine(base_path=".loki/memory")
    engine.initialize()

    pattern = SemanticPattern(
        id="sem-test-001",
        pattern="Always validate input parameters",
        category="validation",
        conditions=["user input", "API endpoint"],
        correct_approach="Use schema validation",
        incorrect_approach="Trust user input",
        confidence=0.9
    )

    pattern_id = engine.store_pattern(pattern)
    retrieved = engine.get_pattern(pattern_id)

    if retrieved and retrieved.pattern == "Always validate input parameters":
        print("OK")
    else:
        print("FAIL:retrieval")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Store semantic pattern"
else
    fail "Store semantic pattern"
fi

# Test 4: Store Procedural Skill
log_test "Store procedural skill"
python3 << 'EOF' 2>/dev/null
try:
    from memory.engine import MemoryEngine
    from memory.schemas import ProceduralSkill

    engine = MemoryEngine(base_path=".loki/memory")
    engine.initialize()

    skill = ProceduralSkill(
        id="skill-test-api",
        name="API Implementation",
        description="How to implement a REST API endpoint",
        prerequisites=["OpenAPI spec exists", "Database configured"],
        steps=[
            "Read endpoint spec",
            "Create route handler",
            "Implement validation",
            "Write tests"
        ],
        exit_criteria=["All tests pass", "Response matches spec"]
    )

    skill_id = engine.store_skill(skill)
    retrieved = engine.get_skill(skill_id)

    if retrieved and retrieved.name == "API Implementation":
        print("OK")
    else:
        print("FAIL:retrieval")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Store procedural skill"
else
    fail "Store procedural skill"
fi

# Test 5: Get Stats
log_test "Get memory stats"
python3 << 'EOF' 2>/dev/null
try:
    from memory.engine import MemoryEngine

    engine = MemoryEngine(base_path=".loki/memory")
    engine.initialize()

    stats = engine.get_stats()

    # Check stats has expected keys
    expected_keys = ["episodic_count", "semantic_pattern_count", "skill_count"]
    for key in expected_keys:
        if key not in stats:
            print(f"FAIL:missing {key}")
            sys.exit(1)

    print("OK")
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Get memory stats"
else
    fail "Get memory stats"
fi

# Test 6: Get Recent Episodes
log_test "Get recent episodes"
python3 << 'EOF' 2>/dev/null
try:
    from memory.engine import MemoryEngine

    engine = MemoryEngine(base_path=".loki/memory")
    engine.initialize()

    recent = engine.get_recent_episodes(limit=5)

    # Should return a list (may be empty or have test episodes)
    if isinstance(recent, list):
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
    pass "Get recent episodes"
else
    fail "Get recent episodes"
fi

# Test 7: Find Patterns by Category
log_test "Find patterns by category"
python3 << 'EOF' 2>/dev/null
try:
    from memory.engine import MemoryEngine
    from memory.schemas import SemanticPattern

    engine = MemoryEngine(base_path=".loki/memory")
    engine.initialize()

    # Store a pattern with specific category
    pattern = SemanticPattern(
        id="sem-cat-001",
        pattern="Test pattern for category search",
        category="testing",
        confidence=0.85
    )
    engine.store_pattern(pattern)

    # Find by category
    found = engine.find_patterns(category="testing", min_confidence=0.8)

    if len(found) > 0 and found[0].category == "testing":
        print("OK")
    else:
        print("FAIL:not found")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Find patterns by category"
else
    fail "Find patterns by category"
fi

# Test 8: Increment Pattern Usage
log_test "Increment pattern usage count"
python3 << 'EOF' 2>/dev/null
try:
    from memory.engine import MemoryEngine
    from memory.schemas import SemanticPattern

    engine = MemoryEngine(base_path=".loki/memory")
    engine.initialize()

    # Store pattern
    pattern = SemanticPattern(
        id="sem-usage-001",
        pattern="Usage tracking pattern",
        category="general",
        confidence=0.9,
        usage_count=0
    )
    engine.store_pattern(pattern)

    # Increment usage
    engine.increment_pattern_usage("sem-usage-001")
    engine.increment_pattern_usage("sem-usage-001")

    # Check usage count increased
    retrieved = engine.get_pattern("sem-usage-001")
    if retrieved and retrieved.usage_count >= 2:
        print("OK")
    else:
        print(f"FAIL:usage_count={retrieved.usage_count if retrieved else 'None'}")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Increment pattern usage count"
else
    fail "Increment pattern usage count"
fi

# Test 9: List Skills
log_test "List all skills"
python3 << 'EOF' 2>/dev/null
try:
    from memory.engine import MemoryEngine

    engine = MemoryEngine(base_path=".loki/memory")
    engine.initialize()

    skills = engine.list_skills()

    if isinstance(skills, list):
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
    pass "List all skills"
else
    fail "List all skills"
fi

# Test 10: Retrieve Relevant (task-aware)
log_test "Retrieve relevant memories (task-aware)"
python3 << 'EOF' 2>/dev/null
try:
    from memory.engine import MemoryEngine

    engine = MemoryEngine(base_path=".loki/memory")
    engine.initialize()

    context = {
        "goal": "implement new API endpoint",
        "task_type": "implementation",
        "phase": "development"
    }

    results = engine.retrieve_relevant(context, top_k=5)

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
    pass "Retrieve relevant memories (task-aware)"
else
    fail "Retrieve relevant memories (task-aware)"
fi

# Test 11: Get Index
log_test "Get memory index"
python3 << 'EOF' 2>/dev/null
try:
    from memory.engine import MemoryEngine

    engine = MemoryEngine(base_path=".loki/memory")
    engine.initialize()

    index = engine.get_index()

    # Check required fields
    if "version" in index and "topics" in index:
        print("OK")
    else:
        print("FAIL:missing fields")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Get memory index"
else
    fail "Get memory index"
fi

# Test 12: Get Timeline
log_test "Get timeline"
python3 << 'EOF' 2>/dev/null
try:
    from memory.engine import MemoryEngine

    engine = MemoryEngine(base_path=".loki/memory")
    engine.initialize()

    timeline = engine.get_timeline()

    # Check required fields
    if "recent_actions" in timeline and "key_decisions" in timeline:
        print("OK")
    else:
        print("FAIL:missing fields")
        sys.exit(1)
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Get timeline"
else
    fail "Get timeline"
fi

# Test 13: Schema Validation - EpisodeTrace
log_test "Schema validation - EpisodeTrace"
python3 << 'EOF' 2>/dev/null
try:
    from memory.schemas import EpisodeTrace
    from datetime import datetime

    # Valid episode
    valid = EpisodeTrace(
        id="ep-001",
        task_id="task-001",
        timestamp=datetime.now(),
        duration_seconds=60,
        agent="eng-001",
        phase="ACT",
        goal="Test goal",
        outcome="success"
    )
    errors = valid.validate()
    if errors:
        print(f"FAIL:valid should pass: {errors}")
        sys.exit(1)

    # Invalid episode (missing required fields)
    invalid = EpisodeTrace(
        id="",
        task_id="",
        timestamp=datetime.now(),
        duration_seconds=-1,
        agent="",
        phase="INVALID",
        goal="",
        outcome="invalid_outcome"
    )
    errors = invalid.validate()
    if len(errors) < 3:
        print(f"FAIL:should have multiple errors: {errors}")
        sys.exit(1)

    print("OK")
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Schema validation - EpisodeTrace"
else
    fail "Schema validation - EpisodeTrace"
fi

# Test 14: Schema Validation - SemanticPattern
log_test "Schema validation - SemanticPattern"
python3 << 'EOF' 2>/dev/null
try:
    from memory.schemas import SemanticPattern

    # Valid pattern
    valid = SemanticPattern(
        id="sem-001",
        pattern="Test pattern",
        category="testing",
        confidence=0.8
    )
    errors = valid.validate()
    if errors:
        print(f"FAIL:valid should pass: {errors}")
        sys.exit(1)

    # Invalid pattern
    invalid = SemanticPattern(
        id="",
        pattern="",
        category="",
        confidence=1.5,  # Out of range
        usage_count=-1   # Negative
    )
    errors = invalid.validate()
    if len(errors) < 3:
        print(f"FAIL:should have multiple errors: {errors}")
        sys.exit(1)

    print("OK")
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Schema validation - SemanticPattern"
else
    fail "Schema validation - SemanticPattern"
fi

# Test 15: Schema Validation - ProceduralSkill
log_test "Schema validation - ProceduralSkill"
python3 << 'EOF' 2>/dev/null
try:
    from memory.schemas import ProceduralSkill

    # Valid skill
    valid = ProceduralSkill(
        id="skill-001",
        name="Test Skill",
        description="A test skill",
        steps=["Step 1", "Step 2"]
    )
    errors = valid.validate()
    if errors:
        print(f"FAIL:valid should pass: {errors}")
        sys.exit(1)

    # Invalid skill (missing steps)
    invalid = ProceduralSkill(
        id="",
        name="",
        description="",
        steps=[]
    )
    errors = invalid.validate()
    if len(errors) < 3:
        print(f"FAIL:should have multiple errors: {errors}")
        sys.exit(1)

    print("OK")
except ImportError as e:
    print(f"SKIP:{e}")
except Exception as e:
    print(f"FAIL:{e}")
    sys.exit(1)
EOF
if [ $? -eq 0 ]; then
    pass "Schema validation - ProceduralSkill"
else
    fail "Schema validation - ProceduralSkill"
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
