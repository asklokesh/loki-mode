#!/usr/bin/env bash
# v7.7.26 test: the dashboard surfaces live Claude hook events ("Live Tool
# Activity"). The server already supported the type_prefix filter; v7.7.26
# wires the council-transcripts UI component to fetch + render it.
set -u

PY=$(command -v python3.12 || command -v python3)
PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT" || exit 1

# Test 1: the endpoint returns ONLY claude_hook_ events under hook_events.
RESULT=$($PY <<'PYEOF' 2>&1 | tail -1
import sys, tempfile, shutil, os, json
sys.path.insert(0, '.')
tmp = tempfile.mkdtemp(prefix='loki-hook-')
try:
    loki = os.path.join(tmp, '.loki'); os.makedirs(loki)
    with open(os.path.join(loki, 'events.jsonl'), 'w') as f:
        f.write(json.dumps({"type":"claude_hook_PreToolUse","timestamp":"2026-05-28T14:00:00Z","tool":"Bash"})+"\n")
        f.write(json.dumps({"type":"claude_hook_PostToolUse","timestamp":"2026-05-28T14:00:01Z","tool":"Edit"})+"\n")
        f.write(json.dumps({"type":"iteration_start","timestamp":"2026-05-28T14:00:02Z"})+"\n")
    from dashboard import server
    server._active_project_dir = tmp
    from fastapi.testclient import TestClient
    c = TestClient(server.app)
    r = c.get("/api/council/transcripts?limit=20&type_prefix=claude_hook_")
    he = r.json().get("hook_events", [])
    types = [e.get("type") for e in he]
    only_hooks = bool(types) and all(t.startswith("claude_hook_") for t in types)
    print("HOOK_OK" if (r.status_code == 200 and len(he) == 2 and only_hooks) else f"HOOK_FAIL: {r.status_code} {types}")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
PYEOF
)
if [ "$RESULT" = "HOOK_OK" ]; then ok "endpoint returns only claude_hook_ events under hook_events"; else bad "hook endpoint: $RESULT"; fi

# Test 2: the built dashboard UI fetches type_prefix and reads hook_events.
if grep -q "type_prefix=claude_hook_" dashboard/static/index.html \
   && grep -q "hook_events" dashboard/static/index.html \
   && grep -q "Live Tool Activity" dashboard/static/index.html; then
    ok "built dashboard UI wires the Live Tool Activity hook-events panel"
else
    bad "built dashboard UI missing hook-events wiring (rebuild dashboard-ui?)"
fi

# Test 3: the source component reads hook_events (not the wrong key).
if grep -q "hooks.hook_events" dashboard-ui/components/loki-council-transcripts.js \
   && grep -q "_hookEventsHtml" dashboard-ui/components/loki-council-transcripts.js; then
    ok "council-transcripts component reads hook_events + renders the panel"
else
    bad "council-transcripts component not wired to hook_events"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
