#!/bin/bash
# Test Loki Mode Event Bus

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
TEST_DIR=$(mktemp -d)
TESTS_PASSED=0
TESTS_FAILED=0

export PYTHONPATH="$PROJECT_ROOT:${PYTHONPATH:-}"
export LOKI_DIR="$TEST_DIR/.loki"

cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

log_test() { echo "[TEST] $1"; }
pass() { ((TESTS_PASSED++)); echo "[PASS] $1"; }
fail() { ((TESTS_FAILED++)); echo "[FAIL] $1"; }

# Setup
setup() {
    mkdir -p "$TEST_DIR/.loki/events/pending"
    mkdir -p "$TEST_DIR/.loki/events/archive"
    cd "$TEST_DIR"
}

# Test 1: Python module imports
test_python_import() {
    log_test "Python event bus imports successfully"
    if python3 -c "from events import EventBus, LokiEvent" 2>/dev/null; then
        pass "Python module imports"
    else
        fail "Python module import failed"
    fi
}

# Test 2: Python emit event
test_python_emit() {
    log_test "Python emit event works"
    if python3 << 'EOF'
import sys
sys.path.insert(0, '$PROJECT_ROOT')
from events import EventBus, LokiEvent, EventType, EventSource

bus = EventBus()
event_id = bus.emit(LokiEvent(
    type=EventType.SESSION,
    source=EventSource.CLI,
    payload={'action': 'test', 'value': 123}
))
assert len(event_id) > 0
print(f"Emitted event: {event_id}")
EOF
    then
        pass "Python emit event"
    else
        fail "Python emit event failed"
    fi
}

# Test 3: Python get pending events
test_python_get_pending() {
    log_test "Python get pending events works"
    if python3 << 'EOF'
import sys
sys.path.insert(0, '$PROJECT_ROOT')
from events import EventBus, EventType

bus = EventBus()
events = bus.get_pending_events()
assert len(events) >= 1, f"Expected at least 1 event, got {len(events)}"
print(f"Found {len(events)} pending events")
EOF
    then
        pass "Python get pending events"
    else
        fail "Python get pending events failed"
    fi
}

# Test 4: Python mark processed
test_python_mark_processed() {
    log_test "Python mark processed works"
    if python3 << 'EOF'
import sys
sys.path.insert(0, '$PROJECT_ROOT')
from events import EventBus, LokiEvent, EventType, EventSource

bus = EventBus()

# Emit a new event
event = LokiEvent(
    type=EventType.TASK,
    source=EventSource.API,
    payload={'action': 'complete', 'task_id': 'task-001'}
)
bus.emit(event)

# Mark it processed
events = bus.get_pending_events()
for e in events:
    if e.type == EventType.TASK:
        bus.mark_processed(e)
        break

# Check it's archived
import os
archive_files = os.listdir(bus.archive_dir)
assert len(archive_files) >= 1, "Event not archived"
print(f"Archived {len(archive_files)} events")
EOF
    then
        pass "Python mark processed"
    else
        fail "Python mark processed failed"
    fi
}

# Test 5: Bash emit script works
test_bash_emit() {
    log_test "Bash emit script works"
    chmod +x "$PROJECT_ROOT/events/emit.sh"
    EVENT_ID=$("$PROJECT_ROOT/events/emit.sh" session cli start provider=claude 2>/dev/null)
    if [ -n "$EVENT_ID" ] && [ -f "$LOKI_DIR/events/pending/"*"$EVENT_ID.json" ]; then
        pass "Bash emit script"
    else
        fail "Bash emit script failed (EVENT_ID=$EVENT_ID)"
    fi
}

# Test 6: Bash event content is valid JSON
test_bash_event_json() {
    log_test "Bash event content is valid JSON"
    EVENT_ID=$("$PROJECT_ROOT/events/emit.sh" task runner complete task_id=task-002 2>/dev/null)
    EVENT_FILE=$(ls "$LOKI_DIR/events/pending/"*"$EVENT_ID.json" 2>/dev/null | head -1)
    if [ -n "$EVENT_FILE" ] && python3 -c "import json; json.load(open('$EVENT_FILE'))" 2>/dev/null; then
        pass "Bash event JSON valid"
    else
        fail "Bash event JSON invalid"
    fi
}

# Test 7: Python event filter by type
test_python_filter_type() {
    log_test "Python filter by event type works"
    if python3 << 'EOF'
import sys
sys.path.insert(0, '$PROJECT_ROOT')
from events import EventBus, LokiEvent, EventType, EventSource

bus = EventBus()

# Emit different types
bus.emit(LokiEvent(type=EventType.STATE, source=EventSource.CLI, payload={'action': 'test1'}))
bus.emit(LokiEvent(type=EventType.MEMORY, source=EventSource.CLI, payload={'action': 'test2'}))

# Filter by type
state_events = bus.get_pending_events(types=[EventType.STATE])
memory_events = bus.get_pending_events(types=[EventType.MEMORY])

assert any(e.type == EventType.STATE for e in state_events), "State event not found"
assert any(e.type == EventType.MEMORY for e in memory_events), "Memory event not found"
print(f"Found {len(state_events)} state events, {len(memory_events)} memory events")
EOF
    then
        pass "Python filter by type"
    else
        fail "Python filter by type failed"
    fi
}

# Test 8: Python get history
test_python_history() {
    log_test "Python get event history works"
    if python3 << 'EOF'
import sys
sys.path.insert(0, '$PROJECT_ROOT')
from events import EventBus, EventType

bus = EventBus()
history = bus.get_event_history(limit=10)
assert len(history) >= 1, "No events in history"
print(f"Found {len(history)} events in history")
EOF
    then
        pass "Python event history"
    else
        fail "Python event history failed"
    fi
}

# Test 9: Python convenience functions
test_python_convenience() {
    log_test "Python convenience functions work"
    if python3 << 'EOF'
import sys
sys.path.insert(0, '$PROJECT_ROOT')
from events.bus import emit_session_event, emit_task_event, emit_state_event, emit_error_event, EventSource

# Use convenience functions
id1 = emit_session_event(EventSource.API, 'start', provider='claude')
id2 = emit_task_event(EventSource.MCP, 'claim', 'task-003')
id3 = emit_state_event(EventSource.VSCODE, 'phase_change', phase='DEVELOPMENT')
id4 = emit_error_event(EventSource.HOOK, 'Command blocked')

assert all([id1, id2, id3, id4]), "Not all events emitted"
print(f"Emitted events: {id1}, {id2}, {id3}, {id4}")
EOF
    then
        pass "Python convenience functions"
    else
        fail "Python convenience functions failed"
    fi
}

# Test 10: Python clear pending
test_python_clear() {
    log_test "Python clear pending events works"
    if python3 << 'EOF'
import sys
sys.path.insert(0, '$PROJECT_ROOT')
from events import EventBus

bus = EventBus()
count = bus.clear_pending()
assert count >= 0, "Clear failed"
print(f"Cleared {count} pending events")

# Verify empty
remaining = bus.get_pending_events()
assert len(remaining) == 0, f"Still have {len(remaining)} pending"
print("Pending queue empty")
EOF
    then
        pass "Python clear pending"
    else
        fail "Python clear pending failed"
    fi
}

# Run tests
setup
test_python_import
test_python_emit
test_python_get_pending
test_python_mark_processed
test_bash_emit
test_bash_event_json
test_python_filter_type
test_python_history
test_python_convenience
test_python_clear

# Summary
echo ""
echo "========================================"
echo "Event Bus Test Results"
echo "========================================"
echo "Passed: $TESTS_PASSED"
echo "Failed: $TESTS_FAILED"
echo "========================================"

[ "$TESTS_FAILED" -eq 0 ]
