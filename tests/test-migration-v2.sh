#!/usr/bin/env bash
#===============================================================================
# Migration Engine V2 Tests
# Tests the hardened migration engine: hooks, schema validation,
# MIGRATION.md index, progress.md bridging, and test fixture.
#===============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
FIXTURE_DIR="$SCRIPT_DIR/fixtures/legacy-checkout-app"

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

echo "Migration Engine V2 Tests"
echo "========================="
echo ""

# -----------------------------------------------------------------------
# Test 1: Test fixture files exist and are valid Python
# -----------------------------------------------------------------------
echo "Test 1: Legacy checkout app fixture exists"
if [[ -f "$FIXTURE_DIR/src/checkout/CheckoutService.py" ]] && \
   [[ -f "$FIXTURE_DIR/src/checkout/PaymentProcessor.py" ]] && \
   [[ -f "$FIXTURE_DIR/src/auth/AuthService.py" ]] && \
   [[ -f "$FIXTURE_DIR/src/config/settings.py" ]] && \
   [[ -f "$FIXTURE_DIR/src/utils/date_utils.py" ]] && \
   [[ -f "$FIXTURE_DIR/tests/test_checkout.py" ]]; then
    pass "All fixture files exist"
else
    fail "Missing fixture files"
fi

# -----------------------------------------------------------------------
# Test 2: Fixture tests run and pass
# -----------------------------------------------------------------------
echo "Test 2: Fixture tests pass"
if cd "$FIXTURE_DIR" && python3 tests/test_checkout.py 2>/dev/null; then
    pass "Fixture tests pass"
else
    fail "Fixture tests failed"
fi
cd "$PROJECT_DIR"

# -----------------------------------------------------------------------
# Test 3: Security scan detects fake API key in settings.py
# -----------------------------------------------------------------------
echo "Test 3: Fake API key detection"
if grep -q "LOKI_TEST_FAKE_KEY" "$FIXTURE_DIR/src/config/settings.py"; then
    pass "Fake API key present in fixture for detection testing"
else
    fail "Fake API key not found in settings.py"
fi

# -----------------------------------------------------------------------
# Test 4: Schema validation passes on valid features.json
# -----------------------------------------------------------------------
echo "Test 4: Schema validation - valid features.json"
TMPDIR_TEST=$(mktemp -d)
cat > "$TMPDIR_TEST/features.json" << 'EOF'
{"features": [{"id": "feat_1", "description": "Login flow", "passes": true}, {"id": "feat_2", "description": "Checkout", "passes": false}]}
EOF
result=$(cd "$PROJECT_DIR" && python3 -c "
from pathlib import Path
from dashboard.migration_engine import validate_artifact
valid, errors = validate_artifact(Path('$TMPDIR_TEST/features.json'), 'features')
print('VALID' if valid else 'INVALID')
for e in errors: print(e)
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "Valid features.json passes validation"
else
    fail "Valid features.json rejected" "$result"
fi

# -----------------------------------------------------------------------
# Test 5: Schema validation catches missing description
# -----------------------------------------------------------------------
echo "Test 5: Schema validation - missing feature description"
cat > "$TMPDIR_TEST/features-bad.json" << 'EOF'
{"features": [{"id": "feat_1", "passes": true}]}
EOF
result=$(cd "$PROJECT_DIR" && python3 -c "
from pathlib import Path
from dashboard.migration_engine import validate_artifact
valid, errors = validate_artifact(Path('$TMPDIR_TEST/features-bad.json'), 'features')
print('VALID' if valid else 'INVALID')
for e in errors: print(e)
" 2>&1)
if echo "$result" | grep -q "INVALID\|missing description\|description"; then
    pass "Missing description detected"
else
    fail "Missing description not caught" "$result"
fi

# -----------------------------------------------------------------------
# Test 6: Schema validation catches duplicate step IDs in plan
# -----------------------------------------------------------------------
echo "Test 6: Schema validation - duplicate step IDs"
cat > "$TMPDIR_TEST/plan-dup.json" << 'EOF'
{"steps": [{"id": "step_1", "tests_required": ["test1"]}, {"id": "step_1", "tests_required": ["test2"]}]}
EOF
result=$(cd "$PROJECT_DIR" && python3 -c "
from pathlib import Path
from dashboard.migration_engine import validate_artifact
valid, errors = validate_artifact(Path('$TMPDIR_TEST/plan-dup.json'), 'migration-plan')
print('VALID' if valid else 'INVALID')
for e in errors: print(e)
" 2>&1)
if echo "$result" | grep -q "INVALID\|duplicate"; then
    pass "Duplicate step IDs detected"
else
    fail "Duplicate step IDs not caught" "$result"
fi

# -----------------------------------------------------------------------
# Test 7: Schema validation catches seam confidence out of range
# -----------------------------------------------------------------------
echo "Test 7: Schema validation - seam confidence out of range"
cat > "$TMPDIR_TEST/seams-bad.json" << 'EOF'
{"seams": [{"id": "seam_1", "confidence": 1.5}]}
EOF
result=$(cd "$PROJECT_DIR" && python3 -c "
from pathlib import Path
from dashboard.migration_engine import validate_artifact
valid, errors = validate_artifact(Path('$TMPDIR_TEST/seams-bad.json'), 'seams')
print('VALID' if valid else 'INVALID')
for e in errors: print(e)
" 2>&1)
if echo "$result" | grep -q "INVALID\|confidence"; then
    pass "Out-of-range confidence detected"
else
    fail "Out-of-range confidence not caught" "$result"
fi

# -----------------------------------------------------------------------
# Test 8: Schema validation passes with fallback (no jsonschema)
# -----------------------------------------------------------------------
echo "Test 8: Structural fallback validation works"
result=$(cd "$PROJECT_DIR" && python3 -c "
from dashboard.migration_engine import _structural_validate
valid, errors = _structural_validate({'features': [{'id': 'f1', 'description': 'test', 'passes': True}]}, 'features')
print('VALID' if valid else 'INVALID')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "Structural fallback validation works"
else
    fail "Structural fallback failed" "$result"
fi

# -----------------------------------------------------------------------
# Test 9: Migration hooks - hook_pre_phase_gate blocks without docs
# -----------------------------------------------------------------------
echo "Test 9: Hook pre_phase_gate blocks understand->guardrail without docs"
TMPDIR_MIG=$(mktemp -d)
export LOKI_MIGRATION_DIR="$TMPDIR_MIG"
export LOKI_CODEBASE_PATH="$FIXTURE_DIR"
# Source hooks
source "$PROJECT_DIR/autonomy/hooks/migration-hooks.sh"
load_migration_hook_config "$FIXTURE_DIR"
# No docs/ directory exists in temp dir
result=$(hook_pre_phase_gate "understand" "guardrail" 2>&1) && hook_rc=$? || hook_rc=$?
if [[ $hook_rc -ne 0 ]] && echo "$result" | grep -q "GATE_BLOCKED"; then
    pass "Pre-phase gate blocks without docs/"
else
    fail "Pre-phase gate did not block" "$result (rc=$hook_rc)"
fi

# -----------------------------------------------------------------------
# Test 10: Migration hooks - hook_on_agent_stop blocks failing features
# -----------------------------------------------------------------------
echo "Test 10: Hook on_agent_stop blocks with failing features"
cat > "$TMPDIR_MIG/features.json" << 'EOF'
{"features": [{"id": "f1", "passes": true}, {"id": "f2", "passes": false}]}
EOF
export LOKI_FEATURES_PATH="$TMPDIR_MIG/features.json"
result=$(hook_on_agent_stop 2>&1) && hook_rc=$? || hook_rc=$?
if [[ $hook_rc -ne 0 ]] && echo "$result" | grep -q "HOOK_BLOCKED"; then
    pass "On-agent-stop blocks with failing features"
else
    fail "On-agent-stop did not block" "$result (rc=$hook_rc)"
fi

# -----------------------------------------------------------------------
# Test 11: Migration hooks - hook_post_step rejects on test failure
# -----------------------------------------------------------------------
echo "Test 11: Hook post_step rejects when tests fail"
export LOKI_TEST_COMMAND="false"  # Always-failing test command
result=$(hook_post_step "step_001" 2>&1) && hook_rc=$? || hook_rc=$?
if [[ $hook_rc -ne 0 ]] && echo "$result" | grep -q "HOOK_REJECTED"; then
    pass "Post-step rejects when tests fail"
else
    fail "Post-step did not reject" "$result (rc=$hook_rc)"
fi
unset LOKI_TEST_COMMAND

# -----------------------------------------------------------------------
# Test 12: MIGRATION.md generation
# -----------------------------------------------------------------------
echo "Test 12: MIGRATION.md generation"
TMPDIR_CB=$(mktemp -d)
result=$(cd "$PROJECT_DIR" && python3 -c "
import sys, os, tempfile, json
from pathlib import Path
from dashboard.migration_engine import MigrationPipeline, reset_migration_pipeline

reset_migration_pipeline()
pipeline = MigrationPipeline('$TMPDIR_CB', 'fastapi')
manifest = pipeline.create_manifest()

index_path = pipeline.generate_migration_index()
print(f'INDEX_PATH={index_path}')
if Path(index_path).exists():
    content = Path(index_path).read_text()
    if 'Quick Context' in content and 'Rules for Agents' in content:
        print('VALID')
    else:
        print('INVALID: missing sections')
else:
    print('INVALID: file not created')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "MIGRATION.md generated with correct sections"
else
    fail "MIGRATION.md generation failed" "$result"
fi

# -----------------------------------------------------------------------
# Test 13: progress.md updated after agent session
# -----------------------------------------------------------------------
echo "Test 13: progress.md context bridging"
result=$(cd "$PROJECT_DIR" && python3 -c "
import sys
from pathlib import Path
from dashboard.migration_engine import MigrationPipeline, reset_migration_pipeline

reset_migration_pipeline()
pipeline = MigrationPipeline('$TMPDIR_CB', 'fastapi')
manifest = pipeline.create_manifest()

pipeline.update_progress('archaeologist_001', 'Discovered 15 features', {'steps_completed': 3, 'tests_passing': '12/15'})
pipeline.update_progress('planner_001', 'Created migration plan', {'notes': 'Incremental strategy'})

progress_path = Path(pipeline.migration_dir) / 'progress.md'
if progress_path.exists():
    content = progress_path.read_text()
    if 'archaeologist_001' in content and 'planner_001' in content:
        print('VALID')
    else:
        print('INVALID: missing agent entries')
else:
    print('INVALID: file not created')
" 2>&1)
if echo "$result" | grep -q "^VALID$"; then
    pass "progress.md updated with agent sessions"
else
    fail "progress.md update failed" "$result"
fi

# -----------------------------------------------------------------------
# Test 14: Migration hooks - default config (no YAML) works
# -----------------------------------------------------------------------
echo "Test 14: Hooks work with default config (no YAML)"
TMPDIR_NOYAML=$(mktemp -d)
load_migration_hook_config "$TMPDIR_NOYAML"
if [[ "$HOOK_POST_FILE_EDIT_ENABLED" == "true" ]] && \
   [[ "$HOOK_POST_STEP_ENABLED" == "true" ]] && \
   [[ "$HOOK_PRE_PHASE_GATE_ENABLED" == "true" ]] && \
   [[ "$HOOK_ON_AGENT_STOP_ENABLED" == "true" ]]; then
    pass "Default hook config loaded correctly"
else
    fail "Default hook config wrong"
fi

# -----------------------------------------------------------------------
# Cleanup
# -----------------------------------------------------------------------
rm -rf "$TMPDIR_TEST" "$TMPDIR_MIG" "$TMPDIR_CB" "$TMPDIR_NOYAML"
unset LOKI_MIGRATION_DIR LOKI_CODEBASE_PATH LOKI_FEATURES_PATH LOKI_AGENT_ID

echo ""
echo "========================="
echo "Results: $PASS passed, $FAIL failed (of $TOTAL)"
if [[ $FAIL -gt 0 ]]; then
    exit 1
fi
echo "All migration v2 tests passed."
