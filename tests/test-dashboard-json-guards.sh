#!/usr/bin/env bash
# Regression test for v7.110.0 non-dict-top-level JSON guards in dashboard/server.py
#
# Class of bug: an endpoint calls .get() on json.loads()/_safe_json_read() output
# assumed to be a dict, but the top-level JSON in an agent/user-written state file
# can be a list/string/number (or a nested item can be a non-dict). The handler's
# except only catches (json.JSONDecodeError, KeyError), so a non-dict raises an
# uncaught AttributeError -> HTTP 500 that blanks the dashboard.
#
# Covers:
#   BUG 1 (HIGH)  GET /api/status  - dashboard-state.json top-level list/str/num,
#                                    agents item not a dict, inProgress item not a dict
#   BUG 2 (HIGH)  GET /api/tasks   - dashboard-state.json top-level list/str/num
#   BUG 3 (MED)   GET /api/budget  - budget.json top-level number/list
#
# For each endpoint the test writes a non-dict top-level file and asserts HTTP 200
# with a sane empty/idle payload (never 500), and asserts a well-formed control
# file still returns correct data.
#
# Self-skips (exit 0) if fastapi / starlette TestClient are not installed.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PY="${PYTHON:-python3}"

# Dependency probe: skip cleanly if fastapi/testclient unavailable.
if ! "$PY" -c "import fastapi, starlette.testclient" >/dev/null 2>&1; then
  echo "SKIP: fastapi/starlette TestClient not installed"
  exit 0
fi

REPO_ROOT="$REPO_ROOT" "$PY" - <<'PYEOF'
import json
import os
import sys
import tempfile
from pathlib import Path

repo_root = os.environ["REPO_ROOT"]
sys.path.insert(0, repo_root)

# Never trust stale bytecode: a leftover dashboard/__pycache__/*.pyc can shadow
# the current source and produce a false PASS/FAIL. Import fresh from .py.
sys.dont_write_bytecode = True
for _pc in Path(repo_root, "dashboard").glob("__pycache__/server.*.pyc"):
    try:
        _pc.unlink()
    except OSError:
        pass

# Point the dashboard at an isolated temp .loki BEFORE importing server, and keep
# it there for every request via the LOKI_DIR env var (absolute path wins in
# _get_loki_dir()).
tmp = Path(tempfile.mkdtemp(prefix="loki-json-guards-"))
loki_dir = tmp / ".loki"
loki_dir.mkdir(parents=True, exist_ok=True)
os.environ["LOKI_DIR"] = str(loki_dir)
# Auth is disabled by default (no ENTERPRISE_AUTH_ENABLED/OIDC), so require_scope
# allows these read endpoints without a token; no auth setup needed here.

from starlette.testclient import TestClient  # noqa: E402
import dashboard.server as server  # noqa: E402

# Belt-and-suspenders: make sure no /api/focus override is active.
server._active_project_dir = None

# raise_server_exceptions=False so an uncaught handler exception is surfaced as a
# real HTTP 500 response (what a browser sees) instead of being re-raised into the
# test. On old/unfixed code these endpoints 500; on fixed code they return 200.
client = TestClient(server.app, raise_server_exceptions=False)

state_file = loki_dir / "dashboard-state.json"
budget_file = loki_dir / "metrics" / "budget.json"
budget_file.parent.mkdir(parents=True, exist_ok=True)

failures = []


def _write(path, obj):
    if isinstance(obj, str):
        path.write_text(obj)
    else:
        path.write_text(json.dumps(obj))


def check(label, cond):
    status = "PASS" if cond else "FAIL"
    print(f"  [{status}] {label}")
    if not cond:
        failures.append(label)


def get(url):
    r = client.get(url)
    return r.status_code, (r.json() if r.headers.get("content-type", "").startswith("application/json") else None)


print("BUG 1: GET /api/status non-dict / bad-item degradation")
for bad in ([1, 2, 3], "corrupt", 42, {"phase": "build", "tasks": [1, 2, 3]}):
    _write(state_file, bad)
    code, body = get("/api/status")
    check(f"top-level {bad!r} -> 200 (not 500)", code == 200)

# agents a list of strings; inProgress item not a dict
_write(state_file, {"phase": "build", "agents": ["a", "b"],
                    "tasks": {"inProgress": ["not-a-dict"]}})
code, body = get("/api/status")
check("agents list-of-str + inProgress non-dict item -> 200", code == 200)

# Control: well-formed -> 200 and reflects fields
_write(state_file, {"phase": "build",
                    "tasks": {"pending": [{"id": "p1"}],
                              "inProgress": [{"payload": {"action": "do-x"}}]}})
code, body = get("/api/status")
check("control well-formed -> 200", code == 200)
check("control phase == build", bool(body) and body.get("phase") == "build")

print("BUG 2: GET /api/tasks non-dict top-level degradation")
# /api/tasks returns a JSON list of task dicts.
for bad in ([1, 2, 3], "corrupt", 7):
    _write(state_file, bad)
    code, body = get("/api/tasks")
    check(f"top-level {bad!r} -> 200 (not 500)", code == 200)
    check(f"top-level {bad!r} -> empty task list", body == [])

# Control: well-formed -> tasks parsed
_write(state_file, {"tasks": {"pending": [{"id": "t1", "title": "Task One"}]}})
code, body = get("/api/tasks")
check("control well-formed -> 200", code == 200)
_titles = [t.get("title") for t in body if isinstance(t, dict)] if isinstance(body, list) else []
check("control tasks include 'Task One'", "Task One" in _titles)

print("BUG 3: GET /api/budget non-dict budget.json degradation")
for bad in (25, [], "25.00"):
    _write(budget_file, bad)
    code, body = get("/api/budget")
    check(f"budget.json {bad!r} -> 200 (not 500)", code == 200)

# Control: well-formed budget.json -> limit parsed
_write(budget_file, {"limit": 50.0, "budget_used": 1.25})
code, body = get("/api/budget")
check("control budget -> 200", code == 200)
check("control budget_limit == 50.0",
      isinstance(body, dict) and body.get("budget_limit") == 50.0)

print()
if failures:
    print(f"RESULT: FAIL ({len(failures)} assertion(s) failed)")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("RESULT: PASS (all endpoints degrade to 200, controls correct)")
sys.exit(0)
PYEOF
rc=$?
exit $rc
