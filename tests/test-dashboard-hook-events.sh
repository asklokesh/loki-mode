#!/usr/bin/env bash
export LOKI_DASHBOARD_ALLOWED_HOSTS=testserver,test  # TestClient Host; keeps default allowlist strict
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
from datetime import datetime, timezone, timedelta
sys.path.insert(0, '.')
tmp = tempfile.mkdtemp(prefix='loki-hook-')
try:
    loki = os.path.join(tmp, '.loki'); os.makedirs(loki)
    # Timestamps must be "now"-relative: _read_events defaults to a 7-day
    # rolling window, so a fixed past date ages out of the window and the
    # endpoint correctly returns [] -- that looked like a product regression
    # but was the fixture, not the server. Generate them at run time instead.
    now = datetime.now(timezone.utc)
    t0 = (now - timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    t1 = (now - timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    t2 = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(os.path.join(loki, 'events.jsonl'), 'w') as f:
        f.write(json.dumps({"type":"claude_hook_PreToolUse","timestamp":t0,"tool":"Bash"})+"\n")
        f.write(json.dumps({"type":"claude_hook_PostToolUse","timestamp":t1,"tool":"Edit"})+"\n")
        f.write(json.dumps({"type":"iteration_start","timestamp":t2})+"\n")
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


echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
