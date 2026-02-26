#!/usr/bin/env bash
# Test: Cluster workflow templates and swarm classes (v6.2.0)
# Validates cluster JSON templates, TopologyValidator, and PubSubMessageBus.
# Pure unit test -- no Docker or running loki required.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR/.."
LOKI="$PROJECT_ROOT/autonomy/loki"
CLUSTERS="$PROJECT_ROOT/templates/clusters"

PASS=0; FAIL=0; TOTAL=0
pass() { ((PASS++)); ((TOTAL++)); echo "PASS: $1"; }
fail() { ((FAIL++)); ((TOTAL++)); echo "FAIL: $1"; }

# --- Tests ---

# 1. templates/clusters/ directory exists
if [[ -d "$CLUSTERS" ]]; then
    pass "templates/clusters/ directory exists"
else
    fail "templates/clusters/ directory not found"
fi

# 2. security-review.json is valid JSON
if python3 -c "import json; json.load(open('$CLUSTERS/security-review.json'))" 2>/dev/null; then
    pass "security-review.json is valid JSON"
else
    fail "security-review.json is not valid JSON"
fi

# 3. code-review.json is valid JSON
if python3 -c "import json; json.load(open('$CLUSTERS/code-review.json'))" 2>/dev/null; then
    pass "code-review.json is valid JSON"
else
    fail "code-review.json is not valid JSON"
fi

# 4. performance-audit.json is valid JSON
if python3 -c "import json; json.load(open('$CLUSTERS/performance-audit.json'))" 2>/dev/null; then
    pass "performance-audit.json is valid JSON"
else
    fail "performance-audit.json is not valid JSON"
fi

# 5. refactoring.json is valid JSON
if python3 -c "import json; json.load(open('$CLUSTERS/refactoring.json'))" 2>/dev/null; then
    pass "refactoring.json is valid JSON"
else
    fail "refactoring.json is not valid JSON"
fi

# 6. TopologyValidator validates security-review.json
if python3 -c "
import sys; sys.path.insert(0, '$PROJECT_ROOT')
from swarm.patterns import TopologyValidator
errors = TopologyValidator.validate_file('$CLUSTERS/security-review.json')
assert not errors, f'Validation errors: {errors}'
" 2>/dev/null; then
    pass "TopologyValidator validates security-review.json"
else
    fail "TopologyValidator rejects security-review.json"
fi

# 7. TopologyValidator validates code-review.json
if python3 -c "
import sys; sys.path.insert(0, '$PROJECT_ROOT')
from swarm.patterns import TopologyValidator
errors = TopologyValidator.validate_file('$CLUSTERS/code-review.json')
assert not errors, f'Validation errors: {errors}'
" 2>/dev/null; then
    pass "TopologyValidator validates code-review.json"
else
    fail "TopologyValidator rejects code-review.json"
fi

# 8. PubSubMessageBus basic publish/subscribe
if python3 -c "
import sys; sys.path.insert(0, '$PROJECT_ROOT')
from swarm.messages import PubSubMessageBus
bus = PubSubMessageBus()
received = []
bus.subscribe('test', lambda m, t, s: received.append(m))
bus.publish('test', {'data': 1})
assert len(received) == 1, f'Expected 1 message, got {len(received)}'
" 2>/dev/null; then
    pass "PubSubMessageBus basic publish/subscribe works"
else
    fail "PubSubMessageBus basic publish/subscribe failed"
fi

# 9. PubSubMessageBus wildcard subscribe
if python3 -c "
import sys; sys.path.insert(0, '$PROJECT_ROOT')
from swarm.messages import PubSubMessageBus
bus = PubSubMessageBus()
received = []
bus.subscribe('task.*', lambda m, t, s: received.append(t))
bus.publish('task.done', {})
assert len(received) == 1, f'Expected 1 wildcard match, got {len(received)}'
" 2>/dev/null; then
    pass "PubSubMessageBus wildcard subscribe works"
else
    fail "PubSubMessageBus wildcard subscribe failed"
fi

# 10. TopologyValidator detects self-loop
if python3 -c "
import sys; sys.path.insert(0, '$PROJECT_ROOT')
from swarm.patterns import TopologyValidator
errs = TopologyValidator.validate({
    'agents': [{'id': 'a', 'subscribes': ['x'], 'publishes': ['x']}]
})
assert any('subscribes to its own' in e for e in errs), f'Expected self-loop error, got: {errs}'
" 2>/dev/null; then
    pass "TopologyValidator detects self-loop"
else
    fail "TopologyValidator did not detect self-loop"
fi

# 11. cmd_cluster appears in loki dispatch
if grep -q 'cluster)' "$LOKI"; then
    pass "cmd_cluster dispatch exists in loki CLI"
else
    fail "cmd_cluster dispatch missing from loki CLI"
fi

# 12. loki cluster --help outputs help text
if bash "$LOKI" cluster --help 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -q "Custom workflow"; then
    pass "loki cluster --help outputs expected help text"
else
    fail "loki cluster --help missing expected help text"
fi

echo ""
echo "Results: $PASS/$TOTAL passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
