#!/usr/bin/env bash
#===============================================================================
# Platform Infrastructure Tests
# Tests: cluster lifecycle hooks, dynamic agent spawning,
# SQLite queryable state, crash recovery
#===============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

PASS=0
FAIL=0
TOTAL=0

pass() {
    PASS=$((PASS + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [PASS] $1"
}

fail() {
    FAIL=$((FAIL + 1))
    TOTAL=$((TOTAL + 1))
    echo "  [FAIL] $1"
    if [[ -n "${2:-}" ]]; then
        echo "         $2"
    fi
}

echo "Platform Infrastructure Tests"
echo "=============================="
echo ""

# -----------------------------------------------------------------------
# Test 1: SQLite backend - record and query events
# -----------------------------------------------------------------------
echo "Test 1: SQLite record_event/query_events roundtrip"
TEST_DB=$(mktemp -d)/test_state.db
result=$(cd "$PROJECT_DIR" && python3 -c "
from state.sqlite_backend import SqliteStateBackend
db = SqliteStateBackend('$TEST_DB')
row_id = db.record_event('agent_started', {'phase': 'understand'}, agent_id='arch_001')
events = db.query_events(agent_id='arch_001')
if len(events) == 1 and events[0]['agent_id'] == 'arch_001':
    print('VALID')
else:
    print(f'INVALID: got {len(events)} events')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "SQLite event roundtrip works"
else
    fail "SQLite event roundtrip failed" "$result"
fi

# -----------------------------------------------------------------------
# Test 2: SQLite backend - record and query messages with wildcards
# -----------------------------------------------------------------------
echo "Test 2: SQLite record_message with wildcard query"
result=$(cd "$PROJECT_DIR" && python3 -c "
from state.sqlite_backend import SqliteStateBackend
db = SqliteStateBackend('$TEST_DB')
db.record_message('task.completed', {'step': 'step_1'}, sender='planner')
db.record_message('task.failed', {'step': 'step_2'}, sender='planner')
db.record_message('agent.heartbeat', {'agent': 'arch'}, sender='arch')
msgs = db.query_messages(topic='task.*')
if len(msgs) == 2:
    print('VALID')
else:
    print(f'INVALID: expected 2, got {len(msgs)}')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "SQLite wildcard message query works"
else
    fail "SQLite wildcard query failed" "$result"
fi

# -----------------------------------------------------------------------
# Test 3: SQLite backend - file permissions are 0o600
# -----------------------------------------------------------------------
echo "Test 3: SQLite file permissions"
if [[ -f "$TEST_DB" ]]; then
    perms=$(stat -f "%Lp" "$TEST_DB" 2>/dev/null || stat -c "%a" "$TEST_DB" 2>/dev/null)
    if [[ "$perms" == "600" ]]; then
        pass "SQLite file permissions are 600"
    else
        fail "SQLite permissions are $perms, expected 600"
    fi
else
    fail "SQLite database file not created"
fi

# -----------------------------------------------------------------------
# Test 4: SQLite backend - checkpoints
# -----------------------------------------------------------------------
echo "Test 4: SQLite checkpoint recording"
result=$(cd "$PROJECT_DIR" && python3 -c "
from state.sqlite_backend import SqliteStateBackend
db = SqliteStateBackend('$TEST_DB')
db.record_checkpoint('mig_123', 'step_001', git_sha='abc123', metadata={'files': 3})
cps = db.query_checkpoints(migration_id='mig_123')
if len(cps) == 1 and cps[0]['step_id'] == 'step_001':
    print('VALID')
else:
    print(f'INVALID: got {len(cps)}')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "SQLite checkpoint roundtrip works"
else
    fail "SQLite checkpoint failed" "$result"
fi

# -----------------------------------------------------------------------
# Test 5: Cluster lifecycle hooks - pre_run fires
# -----------------------------------------------------------------------
echo "Test 5: Cluster lifecycle hooks - pre_run fires"
result=$(cd "$PROJECT_DIR" && python3 -c "
from swarm.patterns import ClusterLifecycleHooks
hooks = ClusterLifecycleHooks({'pre_run': ['echo hook_fired']})
results = hooks.fire('pre_run', {'cluster_id': 'test_123'})
if len(results) == 1 and results[0]['success'] and 'hook_fired' in results[0]['output']:
    print('VALID')
else:
    print(f'INVALID: {results}')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "Cluster pre_run hook fires"
else
    fail "Cluster pre_run hook failed" "$result"
fi

# -----------------------------------------------------------------------
# Test 6: Cluster lifecycle hooks - on_completion fires
# -----------------------------------------------------------------------
echo "Test 6: Cluster lifecycle hooks - on_completion fires"
result=$(cd "$PROJECT_DIR" && python3 -c "
from swarm.patterns import ClusterLifecycleHooks
hooks = ClusterLifecycleHooks({'on_completion': ['echo done']})
results = hooks.fire('on_completion', {'cluster_id': 'test_123'})
if len(results) == 1 and results[0]['success']:
    print('VALID')
else:
    print(f'INVALID: {results}')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "Cluster on_completion hook fires"
else
    fail "Cluster on_completion hook failed" "$result"
fi

# -----------------------------------------------------------------------
# Test 7: Cluster lifecycle hooks - env vars passed
# -----------------------------------------------------------------------
echo "Test 7: Cluster lifecycle hooks - LOKI_CLUSTER_* env vars"
result=$(cd "$PROJECT_DIR" && python3 -c "
from swarm.patterns import ClusterLifecycleHooks
hooks = ClusterLifecycleHooks({'pre_run': ['echo \$LOKI_CLUSTER_NAME']})
results = hooks.fire('pre_run', {'name': 'my_cluster'})
if len(results) == 1 and results[0]['success'] and 'my_cluster' in results[0]['output']:
    print('VALID')
else:
    print(f'INVALID: {results}')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "Cluster hooks pass LOKI_CLUSTER_* env vars"
else
    fail "Cluster env vars not passed" "$result"
fi

# -----------------------------------------------------------------------
# Test 8: Cluster lifecycle hooks - Python callable handler
# -----------------------------------------------------------------------
echo "Test 8: Cluster lifecycle hooks - callable handler"
result=$(cd "$PROJECT_DIR" && python3 -c "
from swarm.patterns import ClusterLifecycleHooks
hooks = ClusterLifecycleHooks()
hooks.register('on_failure', lambda ctx: f'failed:{ctx.get(\"reason\", \"unknown\")}')
results = hooks.fire('on_failure', {'reason': 'timeout'})
if len(results) == 1 and results[0]['success'] and 'failed:timeout' in results[0]['output']:
    print('VALID')
else:
    print(f'INVALID: {results}')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "Callable hook handler works"
else
    fail "Callable hook handler failed" "$result"
fi

# -----------------------------------------------------------------------
# Test 9: Cluster lifecycle hooks - invalid hook point raises
# -----------------------------------------------------------------------
echo "Test 9: Cluster lifecycle hooks - invalid hook point"
result=$(cd "$PROJECT_DIR" && python3 -c "
from swarm.patterns import ClusterLifecycleHooks
hooks = ClusterLifecycleHooks()
try:
    hooks.register('invalid_point', lambda ctx: None)
    print('INVALID: no error raised')
except ValueError as e:
    if 'Invalid hook point' in str(e):
        print('VALID')
    else:
        print(f'INVALID: wrong error: {e}')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "Invalid hook point raises ValueError"
else
    fail "Invalid hook point not rejected" "$result"
fi

# -----------------------------------------------------------------------
# Test 10: Dynamic spawn - max_agents cap enforced
# -----------------------------------------------------------------------
echo "Test 10: Dynamic agent spawning - max_agents cap"
result=$(cd "$PROJECT_DIR" && python3 -c "
import sys
sys.path.insert(0, '.')
from swarm.intelligence import SwarmCoordinator, SwarmConfig

config = SwarmConfig(max_agents=2)
coord = SwarmCoordinator(config=config)

# Register 2 agents to hit the cap
coord.register_agent('eng-frontend')
coord.register_agent('eng-backend')

# Third should fail
try:
    coord.spawn_agent({'type': 'eng-frontend'}, reason='testing')
    print('INVALID: no error raised')
except RuntimeError as e:
    if 'max agents' in str(e):
        print('VALID')
    else:
        print(f'INVALID: wrong error: {e}')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "Max agents cap enforced"
else
    fail "Max agents cap not enforced" "$result"
fi

# -----------------------------------------------------------------------
# Test 11: Dynamic spawn - despawn non-dynamic fails
# -----------------------------------------------------------------------
echo "Test 11: Dynamic agent spawning - cannot despawn non-dynamic"
result=$(cd "$PROJECT_DIR" && python3 -c "
import sys
sys.path.insert(0, '.')
from swarm.intelligence import SwarmCoordinator, SwarmConfig

coord = SwarmCoordinator(config=SwarmConfig())
agent = coord.register_agent('eng-frontend')

try:
    coord.despawn_agent(agent.id)
    print('INVALID: no error raised')
except ValueError as e:
    if 'non-dynamic' in str(e):
        print('VALID')
    else:
        print(f'INVALID: wrong error: {e}')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "Cannot despawn non-dynamic agent"
else
    fail "Despawn non-dynamic not rejected" "$result"
fi

# -----------------------------------------------------------------------
# Test 12: loki state db works
# -----------------------------------------------------------------------
echo "Test 12: loki state db command"
result=$(cd "$PROJECT_DIR" && bash autonomy/loki state db 2>&1)
if echo "$result" | grep -q "state.db"; then
    pass "loki state db prints database path"
else
    fail "loki state db failed" "$result"
fi

# -----------------------------------------------------------------------
# Test 13: loki cluster --help shows new options
# -----------------------------------------------------------------------
echo "Test 13: loki cluster --help shows --cluster-id"
result=$(cd "$PROJECT_DIR" && bash autonomy/loki cluster --help 2>&1)
if echo "$result" | grep -q "cluster-id"; then
    pass "Cluster help shows --cluster-id option"
else
    fail "Cluster help missing --cluster-id" "$result"
fi

# -----------------------------------------------------------------------
# Regression: loki cluster list still works
# -----------------------------------------------------------------------
echo "Test 14: Regression - loki cluster list"
result=$(cd "$PROJECT_DIR" && bash autonomy/loki cluster list 2>&1)
rc=$?
if [[ $rc -eq 0 ]] || echo "$result" | grep -q "Available\|No templates"; then
    pass "loki cluster list still works"
else
    fail "loki cluster list broken" "$result (rc=$rc)"
fi

# -----------------------------------------------------------------------
# Cleanup
# -----------------------------------------------------------------------
rm -rf "$(dirname "$TEST_DB")"

echo ""
echo "=============================="
echo "Results: $PASS passed, $FAIL failed (of $TOTAL)"
if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
echo "All platform infrastructure tests passed."
