#!/usr/bin/env bash
# v7.7.32 regression test: /api/tasks must pass through task enrichment fields
# (description, acceptance_criteria, notes, logs, provider, startedAt) from the
# dashboard-state.json path, where run.sh writes them at the TOP LEVEL of the
# task object. Previously the handler read description from payload.description
# (which iteration tasks do not have) and dropped the enrichment entirely, so
# the dashboard task-detail modal rendered only the title.
set -u
PY=$(command -v python3.12 || command -v python3)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# --- static: handler reads description from top level, not only payload -----
grep -q 'task.get("description", payload.get("description"' "$REPO_ROOT/dashboard/server.py" \
  && ok "/api/tasks reads description from top level (payload fallback)" \
  || bad "/api/tasks still reads description only from payload"

$PY -c "import ast; ast.parse(open('$REPO_ROOT/dashboard/server.py').read())" \
  && ok "dashboard/server.py parses" || bad "server.py syntax error"

# --- functional: an iteration task with top-level enrichment is passed through
RESULT=$($PY - <<'PYEOF' 2>&1 | tail -1
import sys, os, tempfile, json, shutil
sys.path.insert(0, '.')
work = tempfile.mkdtemp(prefix='lk732-')
loki = os.path.join(work, '.loki'); os.makedirs(os.path.join(loki, 'queue'))
# write a dashboard-state.json shaped exactly like run.sh writes for an iteration
state = {
    "tasks": {
        "pending": [],
        "inProgress": [{
            "id": "iteration-1",
            "type": "iteration",
            "title": "Iteration 1",
            "description": "RARV iteration 1. PRD: Codebase Analysis",
            "status": "in_progress",
            "priority": "medium",
            "provider": "claude",
            "startedAt": "2026-05-29T16:15:24Z",
            "acceptance_criteria": [
                "REASON phase identifies next task",
                "ACT phase produces verifiable artifacts",
                "REFLECT phase records progress",
                "VERIFY phase passes quality gates",
            ],
            "notes": [],
            "logs": [{"timestamp": "2026-05-29T16:15:24Z", "level": "info",
                      "phase": "BOOTSTRAP", "message": "Iteration 1 started"}],
        }],
    }
}
with open(os.path.join(loki, 'dashboard-state.json'), 'w') as f:
    json.dump(state, f)
os.environ['LOKI_DIR'] = loki
try:
    from dashboard import server
    from fastapi.testclient import TestClient
    c = TestClient(server.app)
    tasks = c.get('/api/tasks').json()
    it = next((t for t in tasks if t.get('id') == 'iteration-1'), None)
    if not it:
        print("MODAL_FAIL: iteration-1 absent from /api/tasks")
    else:
        good = (
            it.get('description') == "RARV iteration 1. PRD: Codebase Analysis"
            and len(it.get('acceptance_criteria', [])) == 4
            and it.get('provider') == 'claude'
            and it.get('startedAt') == "2026-05-29T16:15:24Z"
            and len(it.get('logs', [])) == 1
        )
        print("MODAL_OK" if good else f"MODAL_FAIL: desc={it.get('description')!r} crit={len(it.get('acceptance_criteria',[]))} prov={it.get('provider')} logs={len(it.get('logs',[]))}")
finally:
    shutil.rmtree(work, ignore_errors=True)
PYEOF
)
[ "$RESULT" = "MODAL_OK" ] && ok "iteration task surfaces description + criteria + provider + logs via /api/tasks" || bad "task enrichment passthrough: $RESULT"

# --- no em dashes in changed file ------------------------------------------
if grep -lP '\xe2\x80\x94' "$REPO_ROOT/dashboard/server.py" "$SCRIPT_DIR/test-task-modal-fields.sh" >/dev/null 2>&1; then
    bad "em dash found in changed files"
else
    ok "no em dashes in changed files"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
