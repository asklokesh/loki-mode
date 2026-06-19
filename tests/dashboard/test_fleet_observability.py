"""Tests for fleet observability endpoints (dashboard/server.py + registry.py).

The fleet view aggregates every registered build on the machine: the
machine-global registry (~/.loki/dashboard/projects.json) plus each project's
own .loki/ state. These endpoints must:

  1. Carry the right auth scope (read endpoints -> require_scope("read"),
     the cancel control action -> require_scope("control")), so enabling
     LOKI_ENTERPRISE_AUTH actually gates them.
  2. With auth disabled (default), serve the anonymous localhost workflow and
     return the expected aggregate shape from a seeded registry + .loki state.
  3. With auth enabled and no credentials, reject reads + the cancel action
     with 401.

HERMETICITY
-----------
LOKI_ENTERPRISE_AUTH is read at *import time* by dashboard.auth, so toggling it
requires a fresh interpreter. Mirroring tests/dashboard/test_control_app_auth.py,
every assertion that depends on a particular LOKI_ENTERPRISE_AUTH value runs in
a SUBPROCESS with the env set there; the parent interpreter's sys.modules and
os.environ are never mutated.

The registry is redirected to a per-test temp directory by monkeypatching
registry.REGISTRY_DIR / registry.REGISTRY_FILE inside the child (the module
reads them at call time, not import time). NO temp HOME is used, so the real
~/.loki is never touched and no other test is perturbed. The seeded project's
.loki state lives under that same temp tree.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest


_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

# Read endpoints (read scope) and the control action (control scope).
READ_PATHS = ["/api/fleet/runs", "/api/fleet/summary"]


def _run_in_subprocess(body: str, enterprise_auth):
    """Execute `body` in a child interpreter; return CompletedProcess.

    enterprise_auth: True sets LOKI_ENTERPRISE_AUTH=true, False force-unsets it.
    The child imports dashboard.* fresh so the value is honored at import time.
    """
    env = dict(os.environ)
    if enterprise_auth is True:
        env["LOKI_ENTERPRISE_AUTH"] = "true"
    elif enterprise_auth is False:
        env.pop("LOKI_ENTERPRISE_AUTH", None)

    preamble = (
        "import sys\n"
        f"sys.path.insert(0, {_REPO_ROOT!r})\n"
        f"READ_PATHS = {READ_PATHS!r}\n"
    )
    return subprocess.run(
        [sys.executable, "-c", preamble + body],
        env=env,
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
    )


# Shared helper body: seed a temp registry with one project that has .loki
# state (dashboard-state.json + session.json + an efficiency cost file), then
# point the registry module at it. Defines seed_fleet() returning the temp dir.
_SEED_HELPER = """
import json, os, tempfile
from datetime import datetime, timezone

def seed_fleet():
    tmp = tempfile.mkdtemp(prefix="loki-fleet-test-")
    reg_dir = os.path.join(tmp, "registry")
    os.makedirs(reg_dir, exist_ok=True)

    proj_dir = os.path.join(tmp, "proj-alpha")
    loki_dir = os.path.join(proj_dir, ".loki")
    os.makedirs(os.path.join(loki_dir, "metrics", "efficiency"), exist_ok=True)

    # Live build state.
    with open(os.path.join(loki_dir, "dashboard-state.json"), "w") as f:
        json.dump({"phase": "implement", "iteration": 7}, f)
    started = datetime.now(timezone.utc).isoformat()
    with open(os.path.join(loki_dir, "session.json"), "w") as f:
        json.dump({"status": "running", "startedAt": started}, f)
    with open(os.path.join(loki_dir, "metrics", "efficiency", "iter-1.json"), "w") as f:
        json.dump({"cost_usd": 1.25, "phase": "implement"}, f)
    with open(os.path.join(loki_dir, "metrics", "efficiency", "iter-2.json"), "w") as f:
        json.dump({"cost_usd": 0.75, "phase": "review"}, f)

    import dashboard.registry as registry
    from pathlib import Path
    registry.REGISTRY_DIR = Path(reg_dir)
    registry.REGISTRY_FILE = Path(reg_dir) / "projects.json"

    # Register with a live pid so the snapshot resolves "running".
    proj = registry.register_project(proj_dir, name="alpha")
    reg = registry._load_registry()
    reg["projects"][proj["id"]]["pid"] = os.getpid()  # this process is alive
    registry._save_registry(reg)
    return tmp, proj["id"]
"""


# Auth-disabled: aggregate shape from a seeded registry + .loki state.
_BODY_AGGREGATE_SHAPE = _SEED_HELPER + """
import dashboard.registry as registry

tmp, pid = seed_fleet()

runs = registry.get_fleet_runs()
assert isinstance(runs, list) and len(runs) == 1, f"expected 1 run, got {runs}"
r = runs[0]
for key in ("id", "name", "path", "status", "running", "phase",
            "iteration", "cost_usd", "started_at", "duration_seconds"):
    assert key in r, f"missing key {key} in {r}"
assert r["name"] == "alpha", r
assert r["running"] is True, r
assert r["status"] == "running", r
assert r["phase"] == "implement", r
assert r["iteration"] == 7, r
assert abs(r["cost_usd"] - 2.0) < 1e-6, r  # 1.25 + 0.75

summary = registry.get_fleet_summary()
assert summary["total_runs"] == 1, summary
assert summary["running_runs"] == 1, summary
assert summary["stopped_runs"] == 0, summary
assert abs(summary["total_cost_usd"] - 2.0) < 1e-6, summary
print("OK")
"""


# Auth-disabled HTTP: read endpoints serve anonymous and return the shape.
_BODY_HTTP_ANON = _SEED_HELPER + """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

seed_fleet()
import dashboard.server as server
client = TestClient(server.app, raise_server_exceptions=False)

resp = client.get("/api/fleet/runs")
assert resp.status_code == 200, f"/api/fleet/runs anon -> {resp.status_code}"
data = resp.json()
assert isinstance(data, list) and len(data) == 1, data
assert data[0]["name"] == "alpha", data

resp2 = client.get("/api/fleet/summary")
assert resp2.status_code == 200, f"/api/fleet/summary anon -> {resp2.status_code}"
assert resp2.json()["total_runs"] == 1, resp2.json()
print("OK")
"""


# Route-definition check: every fleet endpoint carries an auth dependency, and
# cancel carries the control scope (env-independent; in a subprocess for import
# isolation).
_BODY_ROUTES_HAVE_DEPENDENCY = """
import dashboard.server as server
routes = {}
for r in server.app.routes:
    if hasattr(r, "path"):
        routes.setdefault(r.path, []).append(r)

# All fleet paths must define at least one dependency (the auth scope check).
fleet_paths = [
    "/api/fleet/runs",
    "/api/fleet/summary",
    "/api/fleet/runs/{identifier}",
    "/api/fleet/runs/{identifier}/cancel",
]
for path in fleet_paths:
    assert path in routes, f"{path} route missing"
    has_dep = any(len(getattr(r, "dependencies", [])) >= 1 for r in routes[path])
    assert has_dep, f"{path} has no auth dependency"
print("OK")
"""


# Auth-enabled: reads + cancel reject unauthenticated callers with 401.
_BODY_AUTH_ENABLED_REJECTS = """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.server as server
client = TestClient(server.app, raise_server_exceptions=False)

for path in READ_PATHS:
    resp = client.get(path)
    assert resp.status_code == 401, (
        f"{path} should reject unauthenticated reads with 401, got {resp.status_code}"
    )

# The cancel control action must also be 401 without credentials.
resp = client.post("/api/fleet/runs/anything/cancel")
assert resp.status_code == 401, (
    f"cancel should reject unauthenticated callers with 401, got {resp.status_code}"
)
print("OK")
"""


class FleetObservabilityTest(unittest.TestCase):
    def _assert_child_passed(self, proc):
        if proc.returncode != 0:
            self.fail(
                "subprocess assertion failed (exit "
                f"{proc.returncode}):\nSTDOUT:\n{proc.stdout}\n"
                f"STDERR:\n{proc.stderr}"
            )
        if "SKIP:" in proc.stdout:
            self.skipTest(proc.stdout.strip())

    def test_aggregate_shape_from_seeded_registry(self):
        proc = _run_in_subprocess(_BODY_AGGREGATE_SHAPE, enterprise_auth=False)
        self._assert_child_passed(proc)

    def test_http_anonymous_returns_aggregate(self):
        proc = _run_in_subprocess(_BODY_HTTP_ANON, enterprise_auth=False)
        self._assert_child_passed(proc)

    def test_fleet_routes_have_auth_dependency(self):
        proc = _run_in_subprocess(
            _BODY_ROUTES_HAVE_DEPENDENCY, enterprise_auth=False
        )
        self._assert_child_passed(proc)

    def test_auth_enabled_rejects_unauthenticated(self):
        proc = _run_in_subprocess(
            _BODY_AUTH_ENABLED_REJECTS, enterprise_auth=True
        )
        self._assert_child_passed(proc)


if __name__ == "__main__":
    unittest.main()
