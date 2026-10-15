#!/usr/bin/env bash
# shellcheck disable=SC2034  # Variables may be unused in test context
# shellcheck disable=SC2155  # Declare and assign separately
# Test: Vibe Kanban export (loki export vibe-kanban -> scripts/sync-to-vibe-kanban.sh)
# Runs against a temp SQLite DB; never touches a real Vibe Kanban database.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export LOKI_NO_BROWSER=1
PASSED=0
FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_pass() { echo -e "${GREEN}[PASS]${NC} $1"; PASSED=$((PASSED + 1)); }
log_fail() { echo -e "${RED}[FAIL]${NC} $1"; FAILED=$((FAILED + 1)); }
log_test() { echo -e "${YELLOW}[TEST]${NC} $1"; }

if ! command -v sqlite3 >/dev/null 2>&1; then
    echo "SKIP: sqlite3 not installed"
    exit 0
fi

# One run-owned temp dir (CLAUDE.md cleanup contract)
loki_run_tmp_create() {
    local temp_root marker
    [ -z "${LOKI_RUN_TMP:-}" ] || return 64
    temp_root="$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P)" || return 64
    LOKI_RUN_TMP="$(mktemp -d "${temp_root}/loki-run.XXXXXXXX")" || return 1
    marker="${LOKI_RUN_TMP}/.loki-run-owned"
    chmod 700 "$LOKI_RUN_TMP" || return 1
    printf '%s\n' "$LOKI_RUN_TMP" >"$marker" && chmod 600 "$marker" || return 1
}
loki_run_tmp_create || { echo "cannot create temp dir"; exit 1; }
TEST_DIR="$LOKI_RUN_TMP"
trap 'rm -rf -- "$TEST_DIR"' EXIT

DB="$TEST_DIR/vk.sqlite"
export VIBE_KANBAN_DB="$DB"
sqlite3 "$DB" "CREATE TABLE projects (id BLOB PRIMARY KEY, name TEXT, default_agent_working_dir TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE tasks (id BLOB PRIMARY KEY, project_id BLOB, title TEXT, description TEXT, status TEXT, created_at TEXT, updated_at TEXT);"

WORK="$TEST_DIR/proj"
mkdir -p "$WORK/.loki/state" "$WORK/.loki/queue"
cd "$WORK" || exit 1
echo '{"currentPhase": "DEVELOPMENT"}' > .loki/state/orchestrator.json

q() { sqlite3 "$DB" "$1"; }
run_export() { SKILL_DIR="$REPO_ROOT" bash "$REPO_ROOT/autonomy/loki" export vibe-kanban 2>&1; }

echo "========================================"
echo "Vibe Kanban Export Tests"
echo "========================================"

log_test "Dict payload exported with [Loki] title"
cat > .loki/queue/pending.json << 'J'
[{"id": "task-001", "type": "eng-backend", "priority": 9,
  "payload": {"action": "Implement API endpoint", "description": "Create /api/users endpoint"}}]
J
out=$(run_export); rc=$?
title=$(q "SELECT title FROM tasks WHERE title LIKE '%Implement API endpoint%';")
if [ "$rc" -eq 0 ] && [ "$title" = "[Loki] Implement API endpoint" ]; then
    log_pass "loki export vibe-kanban inserted the task (rc=0)"
else
    log_fail "dict payload: rc=$rc title='$title' out=$out"
fi

log_test "Priority and phase land in the description"
desc=$(q "SELECT description FROM tasks WHERE title LIKE '%Implement API endpoint%';")
if [[ "$desc" == *"Priority: HIGH"* ]] && [[ "$desc" == *"Phase: DEVELOPMENT"* ]]; then
    log_pass "Priority HIGH and phase DEVELOPMENT recorded"
else
    log_fail "description wrong: $desc"
fi

log_test "String payload"
cat > .loki/queue/pending.json << 'J'
[{"id": "task-002", "type": "eng-frontend", "priority": 2, "payload": "Simple string payload"}]
J
run_export >/dev/null
title=$(q "SELECT title FROM tasks;")
if [ "$title" = "[Loki] Simple string payload" ]; then
    log_pass "String payload exported and prior [Loki] rows replaced"
else
    log_fail "string payload: title='$title'"
fi

log_test "Status mapping per queue"
echo '[]' > .loki/queue/pending.json
echo '[{"id":"t-doing","priority":5,"payload":{"action":"Doing"}}]' > .loki/queue/in-progress.json
echo '[{"id":"t-done","priority":5,"payload":{"action":"Done one"}}]' > .loki/queue/completed.json
echo '[{"id":"t-fail","priority":5,"payload":{"action":"Failed one"}}]' > .loki/queue/failed.json
run_export >/dev/null
got=$(q "SELECT title || '=' || status FROM tasks ORDER BY title;" | tr '\n' ' ')
if [ "$got" = "[Loki] Doing=inprogress [Loki] Done one=done [Loki] Failed one=cancelled " ]; then
    log_pass "in-progress->inprogress, completed->done, failed->cancelled"
else
    log_fail "status mapping: $got"
fi

log_test "Non-Loki tasks survive a sync"
pid=$(q "SELECT hex(id) FROM projects LIMIT 1;")
q "INSERT INTO tasks (id, project_id, title, description, status, created_at, updated_at) VALUES (randomblob(16), X'$pid', 'Manual card', '', 'todo', 'now', 'now');"
run_export >/dev/null
if [ "$(q "SELECT count(*) FROM tasks WHERE title='Manual card';")" = "1" ]; then
    log_pass "manual card preserved"
else
    log_fail "manual card was deleted"
fi

log_test "Missing orchestrator.json falls back to UNKNOWN phase"
rm -f .loki/state/orchestrator.json
run_export >/dev/null
desc=$(q "SELECT description FROM tasks WHERE title LIKE '%Doing%';")
if [[ "$desc" == *"Phase: UNKNOWN"* ]]; then
    log_pass "UNKNOWN phase used"
else
    log_fail "phase fallback wrong: $desc"
fi

log_test "Missing DB fails loudly"
out=$(VIBE_KANBAN_DB="$TEST_DIR/nope.sqlite" SKILL_DIR="$REPO_ROOT" bash "$REPO_ROOT/autonomy/loki" export vibe-kanban 2>&1); rc=$?
if [ "$rc" -ne 0 ] && [[ "$out" == *"database not found"* ]]; then
    log_pass "missing DB rejected"
else
    log_fail "missing DB: rc=$rc out=$out"
fi

echo ""
echo "Passed: $PASSED  Failed: $FAILED"
[ "$FAILED" -eq 0 ]
