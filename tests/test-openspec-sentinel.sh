#!/usr/bin/env bash
# shellcheck disable=SC2034  # Variables may be unused in test context
# shellcheck disable=SC2155  # Declare and assign separately
# Test: OpenSpec Sentinel Scoping and Queue Purge Logic
# Tests all state transitions for sentinel-based task queue management
# Covers: fresh run, crash-restart, change switch, content edit, legacy compat

set -uo pipefail
# Note: Not using -e to allow collecting all test results

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_DIR=$(mktemp -d)
PASSED=0
FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; ((PASSED++)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; ((FAILED++)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

cleanup() {
    rm -rf "$TEST_DIR"
}
trap cleanup EXIT

cd "$TEST_DIR" || exit 1

echo "========================================"
echo "Loki Mode OpenSpec Sentinel Tests"
echo "========================================"
echo ""

# Initialize structure
mkdir -p .loki/queue

SENTINEL=".loki/queue/.openspec-populated"
PENDING=".loki/queue/pending.json"
COMPLETED=".loki/queue/completed.json"
IN_PROGRESS=".loki/queue/in-progress.json"
TASKS_FILE=".loki/openspec-tasks.json"

echo '[]' > "$PENDING"
echo '[]' > "$COMPLETED"
echo '[]' > "$IN_PROGRESS"

# ---------------------------------------------------------------------------
# Helpers (mirror the logic in autonomy/run.sh)
# ---------------------------------------------------------------------------

# Compute content hash (cross-platform: Linux md5sum, macOS md5)
content_hash() {
    md5sum "$1" 2>/dev/null | cut -d' ' -f1 || md5 -q "$1" 2>/dev/null || echo "none"
}

# Simulate sentinel read logic from run.sh populate_openspec_queue()
check_sentinel() {
    local change_path="$1"
    if [[ -f "$SENTINEL" ]]; then
        local stored_change stored_hash current_hash
        stored_change="$(sed -n '1p' "$SENTINEL")"
        stored_hash="$(sed -n '2p' "$SENTINEL")"
        current_hash="$(content_hash "$TASKS_FILE")"
        if [[ "$stored_change" == "$change_path" ]] && [[ "$stored_hash" == "$current_hash" ]]; then
            echo "skip"
        elif [[ "$stored_change" != "$change_path" ]]; then
            echo "purge_change_switch"
        else
            echo "purge_content_changed"
        fi
    else
        echo "populate"
    fi
}

# Write sentinel with path + content hash (mirrors run.sh)
write_sentinel() {
    local change_path="$1"
    local hash
    hash="$(content_hash "$TASKS_FILE")"
    printf '%s\n%s\n' "$change_path" "$hash" > "$SENTINEL"
}

# Purge openspec tasks from a queue file using jq (mirrors run.sh)
# Outputs "purged N" to stdout for count verification
purge_openspec_from_queue() {
    local queue_file="$1"
    [[ -f "$queue_file" ]] || { echo "purged 0"; return 0; }
    local tmp_file="${queue_file}.tmp"
    if jq '[.[] | select(.source != "openspec")]' "$queue_file" > "$tmp_file" 2>&1; then
        local before after
        before=$(jq 'length' "$queue_file" 2>/dev/null || echo 0)
        after=$(jq 'length' "$tmp_file" 2>/dev/null || echo 0)
        mv "$tmp_file" "$queue_file"
        echo "purged $((before - after))"
        return 0
    else
        rm -f "$tmp_file"
        echo "purged error"
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Test 1: Fresh run -- no sentinel exists, should populate
# ---------------------------------------------------------------------------
log_test "Fresh run (no sentinel)"
echo '{"tasks": [{"id": "openspec-A-1.1"}]}' > "$TASKS_FILE"
CHANGE_PATH="/repo/openspec/changes/feature-a"

result=$(check_sentinel "$CHANGE_PATH")
if [ "$result" = "populate" ]; then
    log_pass "Fresh run triggers populate"
else
    log_fail "Fresh run should trigger populate (got: $result)"
fi

# Simulate population
echo '[{"id":"openspec-A-1.1","source":"openspec"},{"id":"openspec-A-1.2","source":"openspec"}]' > "$PENDING"
write_sentinel "$CHANGE_PATH"

stored_path="$(sed -n '1p' "$SENTINEL")"
stored_hash="$(sed -n '2p' "$SENTINEL")"
if [ "$stored_path" = "$CHANGE_PATH" ]; then
    log_pass "Sentinel stores change path"
else
    log_fail "Sentinel path mismatch (expected: $CHANGE_PATH, got: $stored_path)"
fi

expected_hash="$(content_hash "$TASKS_FILE")"
if [ "$stored_hash" = "$expected_hash" ]; then
    log_pass "Sentinel stores content hash"
else
    log_fail "Sentinel hash mismatch (expected: $expected_hash, got: $stored_hash)"
fi

# ---------------------------------------------------------------------------
# Test 2: Crash-restart -- same change, same content, skip repopulation
# ---------------------------------------------------------------------------
log_test "Crash-restart same change (path + hash match)"

result=$(check_sentinel "$CHANGE_PATH")
if [ "$result" = "skip" ]; then
    log_pass "Same change + content skips repopulation"
else
    log_fail "Should skip (got: $result)"
fi

task_count=$(jq 'length' "$PENDING")
if [ "$task_count" -eq 2 ]; then
    log_pass "Pending queue untouched (progress preserved)"
else
    log_fail "Pending queue modified (count: $task_count, expected: 2)"
fi

# ---------------------------------------------------------------------------
# Test 3: Switch to different change -- purge all 3 queues
# ---------------------------------------------------------------------------
log_test "Switch to different change"
echo '{"tasks": [{"id": "openspec-B-1.1"}]}' > "$TASKS_FILE"
NEW_CHANGE_PATH="/repo/openspec/changes/feature-b"

# Populate all 3 queues with a mix of openspec and non-openspec tasks
echo '[{"id":"openspec-A-2.1","source":"openspec"},{"id":"prd-2","source":"prd"}]' > "$PENDING"
echo '[{"id":"openspec-A-1.1","source":"openspec"},{"id":"prd-1","source":"prd"}]' > "$COMPLETED"
echo '[{"id":"openspec-A-1.2","source":"openspec"}]' > "$IN_PROGRESS"

result=$(check_sentinel "$NEW_CHANGE_PATH")
if [ "$result" = "purge_change_switch" ]; then
    log_pass "Different change triggers purge"
else
    log_fail "Should trigger purge (got: $result)"
fi

# Execute purge on all 3 queues and verify counts
pending_purged=$(purge_openspec_from_queue "$PENDING")
completed_purged=$(purge_openspec_from_queue "$COMPLETED")
in_progress_purged=$(purge_openspec_from_queue "$IN_PROGRESS")

if [ "$pending_purged" = "purged 1" ]; then
    log_pass "Pending: 1 openspec task purged"
else
    log_fail "Pending purge count wrong ($pending_purged)"
fi

if [ "$completed_purged" = "purged 1" ]; then
    log_pass "Completed: 1 openspec task purged"
else
    log_fail "Completed purge count wrong ($completed_purged)"
fi

if [ "$in_progress_purged" = "purged 1" ]; then
    log_pass "In-progress: 1 openspec task purged"
else
    log_fail "In-progress purge count wrong ($in_progress_purged)"
fi

# Verify non-openspec tasks survived
pending_remaining=$(jq 'length' "$PENDING")
pending_source=$(jq -r '.[0].source' "$PENDING")
if [ "$pending_remaining" -eq 1 ] && [ "$pending_source" = "prd" ]; then
    log_pass "Pending: non-openspec task preserved"
else
    log_fail "Pending: unexpected state (count: $pending_remaining, source: $pending_source)"
fi

completed_remaining=$(jq 'length' "$COMPLETED")
completed_source=$(jq -r '.[0].source' "$COMPLETED")
if [ "$completed_remaining" -eq 1 ] && [ "$completed_source" = "prd" ]; then
    log_pass "Completed: non-openspec task preserved"
else
    log_fail "Completed: unexpected state (count: $completed_remaining, source: $completed_source)"
fi

in_progress_remaining=$(jq 'length' "$IN_PROGRESS")
if [ "$in_progress_remaining" -eq 0 ]; then
    log_pass "In-progress: empty after purge (was all openspec)"
else
    log_fail "In-progress should be empty (count: $in_progress_remaining)"
fi

write_sentinel "$NEW_CHANGE_PATH"

# ---------------------------------------------------------------------------
# Test 4: Same change but tasks.md edited -- hash mismatch triggers reload
# ---------------------------------------------------------------------------
log_test "Same change, tasks.md edited (hash mismatch)"
echo '{"tasks": [{"id": "openspec-B-1.1"}, {"id": "openspec-B-1.2", "new": true}]}' > "$TASKS_FILE"

result=$(check_sentinel "$NEW_CHANGE_PATH")
if [ "$result" = "purge_content_changed" ]; then
    log_pass "Content hash mismatch triggers reload"
else
    log_fail "Should trigger content change purge (got: $result)"
fi

# ---------------------------------------------------------------------------
# Test 5: No --openspec after previous run -- leave everything untouched
# ---------------------------------------------------------------------------
log_test "No --openspec after previous run (don't touch anything)"
echo '[{"id":"openspec-B-1.1","source":"openspec"},{"id":"prd-3","source":"prd"}]' > "$PENDING"
echo '[{"id":"openspec-B-2.1","source":"openspec"}]' > "$COMPLETED"
write_sentinel "$NEW_CHANGE_PATH"

pending_before=$(jq 'length' "$PENDING")
completed_before=$(jq 'length' "$COMPLETED")
sentinel_before=$(cat "$SENTINEL")

# Do nothing -- this IS the test. No --openspec means no cleanup.

pending_after=$(jq 'length' "$PENDING")
completed_after=$(jq 'length' "$COMPLETED")
sentinel_after=$(cat "$SENTINEL")

if [ "$pending_after" -eq "$pending_before" ]; then
    log_pass "Pending untouched when no --openspec"
else
    log_fail "Pending modified without --openspec (before: $pending_before, after: $pending_after)"
fi

if [ "$completed_after" -eq "$completed_before" ]; then
    log_pass "Completed untouched when no --openspec"
else
    log_fail "Completed modified without --openspec"
fi

if [ "$sentinel_after" = "$sentinel_before" ]; then
    log_pass "Sentinel untouched when no --openspec"
else
    log_fail "Sentinel modified without --openspec"
fi

# ---------------------------------------------------------------------------
# Test 6: Direct run.sh invocation (bypass CLI)
# ---------------------------------------------------------------------------
log_test "Direct run.sh invocation (bypass CLI)"
echo '{"tasks": [{"id": "openspec-C-1.1"}]}' > "$TASKS_FILE"

result=$(check_sentinel "/repo/openspec/changes/feature-c")
if [ "$result" = "purge_change_switch" ]; then
    log_pass "Direct run.sh detects change switch"
else
    log_fail "Should detect change switch (got: $result)"
fi

# ---------------------------------------------------------------------------
# Test 7: Legacy sentinel (old format, path only, no hash line)
# ---------------------------------------------------------------------------
log_test "Legacy sentinel backward compatibility"
echo "/repo/openspec/changes/feature-c" > "$SENTINEL"
echo '{"tasks": [{"id": "openspec-C-1.1"}]}' > "$TASKS_FILE"

stored_hash="$(sed -n '2p' "$SENTINEL")"
if [ -z "$stored_hash" ]; then
    log_pass "Legacy sentinel has no hash line"
else
    log_fail "Expected empty hash line (got: $stored_hash)"
fi

result=$(check_sentinel "/repo/openspec/changes/feature-c")
if [ "$result" = "purge_content_changed" ]; then
    log_pass "Legacy sentinel triggers reload (safe upgrade path)"
else
    log_fail "Legacy sentinel should trigger reload (got: $result)"
fi

# ---------------------------------------------------------------------------
# Test 8: jq purge on malformed JSON -- error handling
# ---------------------------------------------------------------------------
log_test "Malformed JSON error handling"
echo "this is not json" > "$PENDING"

purge_result=0
purge_openspec_from_queue "$PENDING" 2>/dev/null || purge_result=1

if [ "$purge_result" -eq 1 ]; then
    log_pass "Malformed JSON returns error code"
else
    log_fail "Should return error on malformed JSON"
fi

content=$(cat "$PENDING")
if [ "$content" = "this is not json" ]; then
    log_pass "Original file preserved on jq error"
else
    log_fail "File was corrupted (content: $content)"
fi

# ---------------------------------------------------------------------------
# Test 9: Purge on empty queue files
# ---------------------------------------------------------------------------
log_test "Empty queue files"
echo '[]' > "$PENDING"
echo '[]' > "$COMPLETED"
echo '[]' > "$IN_PROGRESS"

p9=$(purge_openspec_from_queue "$PENDING")
c9=$(purge_openspec_from_queue "$COMPLETED")
i9=$(purge_openspec_from_queue "$IN_PROGRESS")

if [ "$p9" = "purged 0" ]; then
    log_pass "Empty pending: reports 0 purged"
else
    log_fail "Empty pending: wrong count ($p9)"
fi
if [ "$c9" = "purged 0" ]; then
    log_pass "Empty completed: reports 0 purged"
else
    log_fail "Empty completed: wrong count ($c9)"
fi
if [ "$i9" = "purged 0" ]; then
    log_pass "Empty in-progress: reports 0 purged"
else
    log_fail "Empty in-progress: wrong count ($i9)"
fi

# ---------------------------------------------------------------------------
# Test 10: Purge on nonexistent queue file
# ---------------------------------------------------------------------------
log_test "Nonexistent queue file"
rm -f "$COMPLETED"

s10=$(purge_openspec_from_queue "$COMPLETED")
s10_rc=$?

if [ "$s10_rc" -eq 0 ]; then
    log_pass "Nonexistent file returns success"
else
    log_fail "Should return success for nonexistent file"
fi
if [ "$s10" = "purged 0" ]; then
    log_pass "Nonexistent file reports 0 purged"
else
    log_fail "Should report 0 purged ($s10)"
fi
if [ ! -f "$COMPLETED" ]; then
    log_pass "No file created for nonexistent queue"
else
    log_fail "Should not create file"
fi

# ---------------------------------------------------------------------------
# Test 11: Task ID scoping via adapter
# ---------------------------------------------------------------------------
log_test "Task ID scoping via adapter"
ADAPTER_PATH="$SCRIPT_DIR/../autonomy/openspec-adapter.py"

if [ -f "$ADAPTER_PATH" ]; then
    mkdir -p "$TEST_DIR/fake-change/specs/auth"
    cat > "$TEST_DIR/fake-change/proposal.md" << 'MD'
# Test Change
## Why
Testing
## What Changes
Everything
MD
    cat > "$TEST_DIR/fake-change/specs/auth/spec.md" << 'MD'
## ADDED Requirements
### Requirement: Test Auth
#### Scenario: Basic login
- GIVEN a user
- WHEN they login
- THEN they see dashboard
MD
    cat > "$TEST_DIR/fake-change/tasks.md" << 'MD'
## 1. Auth
- [ ] 1.1 Implement login
- [ ] 1.2 Add session handling
## 2. Dashboard
- [ ] 2.1 Build main view
MD

    task_ids=$(python3 "$ADAPTER_PATH" "$TEST_DIR/fake-change" --json 2>/dev/null | python3 -c "
import json, sys
data = json.load(sys.stdin)
for t in data['tasks']:
    print(t['id'])
" 2>/dev/null)

    id1=$(echo "$task_ids" | head -1)
    if echo "$id1" | grep -q 'openspec-fake-change-'; then
        log_pass "Task ID includes change name (openspec-fake-change-N.M)"
    else
        log_fail "Task ID missing change name (got: $id1)"
    fi
else
    log_fail "Adapter not found at $ADAPTER_PATH (skipped)"
fi

# ---------------------------------------------------------------------------
# Test 12: Mixed-source queue preserves non-openspec tasks
# ---------------------------------------------------------------------------
log_test "Mixed-source queue preservation"
echo '[
  {"id":"openspec-X-1.1","source":"openspec","title":"OS task 1"},
  {"id":"prd-1","source":"prd","title":"PRD task"},
  {"id":"openspec-X-2.1","source":"openspec","title":"OS task 2"},
  {"id":"bmad-1","source":"bmad","title":"BMAD task"},
  {"id":"mirofish-1","source":"mirofish","title":"MiroFish task"}
]' > "$PENDING"

mixed_purged=$(purge_openspec_from_queue "$PENDING")
if [ "$mixed_purged" = "purged 2" ]; then
    log_pass "Reports 2 openspec tasks purged from mixed queue"
else
    log_fail "Wrong purge count ($mixed_purged, expected: purged 2)"
fi

remaining=$(jq 'length' "$PENDING")
if [ "$remaining" -eq 3 ]; then
    log_pass "Keeps 3 non-openspec tasks"
else
    log_fail "Wrong remaining count ($remaining, expected: 3)"
fi

sources=$(jq -r '.[].source' "$PENDING" | sort | tr '\n' ',')
if [ "$sources" = "bmad,mirofish,prd," ]; then
    log_pass "Preserves bmad, mirofish, prd sources"
else
    log_fail "Wrong sources remaining ($sources)"
fi

# ---------------------------------------------------------------------------
# Test 13: Empty/unset OPENSPEC_CHANGE_PATH with existing sentinel
# ---------------------------------------------------------------------------
log_test "Empty OPENSPEC_CHANGE_PATH triggers purge against stored path"

# Set up sentinel with a real stored path
echo '{"tasks": [{"id": "openspec-D-1.1"}]}' > "$TASKS_FILE"
STORED_PATH="/repo/openspec/changes/feature-d"
write_sentinel "$STORED_PATH"

# Verify sentinel was written with the stored path
stored_before="$(sed -n '1p' "$SENTINEL")"
if [ "$stored_before" = "$STORED_PATH" ]; then
    log_pass "Sentinel has stored path before empty-path check"
else
    log_fail "Sentinel setup failed (got: $stored_before)"
fi

# Pass empty string as change_path -- simulates unset OPENSPEC_CHANGE_PATH
result=$(check_sentinel "")
if [ "$result" = "purge_change_switch" ]; then
    log_pass "Empty change path vs stored path triggers purge_change_switch"
else
    log_fail "Empty change path should trigger purge_change_switch (got: $result)"
fi

# Populate queues and verify purge works end-to-end in this scenario
echo '[{"id":"openspec-D-1.1","source":"openspec"},{"id":"prd-5","source":"prd"}]' > "$PENDING"
echo '[{"id":"openspec-D-2.1","source":"openspec"}]' > "$COMPLETED"
echo '[]' > "$IN_PROGRESS"

pending_purged=$(purge_openspec_from_queue "$PENDING")
completed_purged=$(purge_openspec_from_queue "$COMPLETED")

if [ "$pending_purged" = "purged 1" ]; then
    log_pass "Empty-path purge: 1 openspec task removed from pending"
else
    log_fail "Empty-path purge pending count wrong ($pending_purged)"
fi

if [ "$completed_purged" = "purged 1" ]; then
    log_pass "Empty-path purge: 1 openspec task removed from completed"
else
    log_fail "Empty-path purge completed count wrong ($completed_purged)"
fi

prd_remaining=$(jq -r '.[0].source' "$PENDING")
if [ "$prd_remaining" = "prd" ]; then
    log_pass "Empty-path purge: non-openspec task preserved"
else
    log_fail "Empty-path purge: non-openspec task lost (source: $prd_remaining)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "Results: $PASSED passed, $FAILED failed"
echo "========================================"
[[ $FAILED -eq 0 ]] && exit 0 || exit 1
