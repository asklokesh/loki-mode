"""Tests for the fleet cross-project retry endpoint (dashboard/server.py).

POST /api/fleet/runs/{identifier}/retry re-launches one finished/failed build
by re-running `loki start` (run.sh) from the project's registry-stored working
directory against a spec recovered from that directory. It must:

  1. Re-launch a stopped project that has a recoverable spec, flipping the
     registry status to running (the launch is mocked so no real build runs).
  2. Refuse (409) a project that is currently running -- never double-launch.
  3. Refuse (409, honestly) a project with no recoverable spec source.
  4. With auth enabled: reject an unauthenticated caller (401) and a read-only
     scope token (403) -- the retry control action is gated.
  5. Resolve the identifier through the registry only -- a path-traversal
     identifier escapes nothing (registry-bound), so it 404s.

HERMETICITY
-----------
LOKI_ENTERPRISE_AUTH is read at import time by dashboard.auth, so every
assertion that depends on its value runs in a SUBPROCESS with the env set
there; the parent interpreter is never mutated. The registry is redirected to a
per-test temp directory by monkeypatching registry.REGISTRY_DIR /
registry.REGISTRY_FILE inside the child (read at call time). NO temp HOME is
used, so the real ~/.loki is never touched. subprocess.Popen is monkeypatched
in-child so retry never spawns a real run.sh.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest


_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


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
    )
    return subprocess.run(
        [sys.executable, "-c", preamble + body],
        env=env,
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
    )


# Shared helper: seed a temp registry with one STOPPED project. The project's
# .loki tree is created; the caller decides which spec source (if any) to drop
# in. The recorded pid is a guaranteed-dead pid so the project reads stopped.
# Defines seed(spec_kind, running) -> (tmp_dir, project_id, project_path).
_SEED_HELPER = """
import json, os, tempfile
from datetime import datetime, timezone
from pathlib import Path


def _dead_pid():
    # A pid that is not alive, found WITHOUT spawning a process (the tests
    # monkeypatch subprocess.Popen, so we must not rely on it). Scan downward
    # from a high pid until os.kill(pid, 0) reports the pid is dead (ESRCH).
    for candidate in range(2 ** 22, 1, -1):
        try:
            os.kill(candidate, 0)
        except ProcessLookupError:
            return candidate
        except OSError:
            # EPERM etc: pid exists but not ours -> alive; keep scanning.
            continue
    return 2 ** 22


def seed(spec_kind="root_prd", running=False):
    tmp = tempfile.mkdtemp(prefix="loki-fleet-retry-")
    reg_dir = os.path.join(tmp, "registry")
    os.makedirs(reg_dir, exist_ok=True)

    proj_dir = os.path.join(tmp, "proj-alpha")
    loki_dir = os.path.join(proj_dir, ".loki")
    os.makedirs(loki_dir, exist_ok=True)

    # Drop in the requested recoverable spec source (or none).
    if spec_kind == "root_prd":
        with open(os.path.join(proj_dir, "PRD.md"), "w") as f:
            f.write("# Spec\\nbuild a thing\\n")
    elif spec_kind == "generated_prd":
        with open(os.path.join(loki_dir, "generated-prd.md"), "w") as f:
            f.write("# Generated\\nreverse-engineered\\n")
    elif spec_kind == "dashboard_spec":
        specs_dir = os.path.join(loki_dir, "specs")
        os.makedirs(specs_dir, exist_ok=True)
        with open(os.path.join(specs_dir, "dashboard-spec-1.md"), "w") as f:
            f.write("# Inline\\nbrief\\n")
    # spec_kind == "none": deliberately leave no recoverable spec.

    import dashboard.registry as registry
    registry.REGISTRY_DIR = Path(reg_dir)
    registry.REGISTRY_FILE = Path(reg_dir) / "projects.json"

    proj = registry.register_project(proj_dir, name="alpha")
    reg = registry._load_registry()
    if running:
        reg["projects"][proj["id"]]["pid"] = os.getpid()  # this proc is alive
        reg["projects"][proj["id"]]["status"] = "running"
    else:
        reg["projects"][proj["id"]]["pid"] = _dead_pid()
        reg["projects"][proj["id"]]["status"] = "stopped"
    registry._save_registry(reg)
    return tmp, proj["id"], proj_dir
"""


# (a) Retry a stopped project with a recoverable spec -> launches + flips to
# running. subprocess.Popen is patched so no real run.sh executes.
_BODY_RETRY_LAUNCHES = _SEED_HELPER + """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.server as server
import dashboard.registry as registry

tmp, pid, proj_dir = seed(spec_kind="root_prd", running=False)


class _FakeProc:
    def __init__(self, *a, **k):
        self.pid = 4242
        _FakeProc.spawned = True
        _FakeProc.args = a[0] if a else k.get("args")
        _FakeProc.cwd = k.get("cwd")


_FakeProc.spawned = False
server.subprocess.Popen = _FakeProc

client = TestClient(server.app, raise_server_exceptions=False)
resp = client.post(f"/api/fleet/runs/{pid}/retry")
assert resp.status_code == 200, f"retry -> {resp.status_code}: {resp.text}"
data = resp.json()
assert data["success"] is True, data
assert data["retried"] is True, data
assert data["pid"] == 4242, data
assert data["spec"].endswith("PRD.md"), data
assert _FakeProc.spawned is True, "run.sh was not spawned"
# Launched from the project's own CWD, never a caller path.
assert os.path.realpath(_FakeProc.cwd) == os.path.realpath(proj_dir), _FakeProc.cwd
# run.sh invoked with the recovered spec.
assert any(str(a).endswith("PRD.md") for a in _FakeProc.args), _FakeProc.args

# Registry status flipped to running with the new pid.
proj = registry.get_project(pid)
assert proj["status"] == "running", proj
assert proj["pid"] == 4242, proj
print("OK")
"""


# (b) Retry a RUNNING project -> refused 409, nothing spawned.
_BODY_RETRY_RUNNING_REFUSED = _SEED_HELPER + """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.server as server

tmp, pid, proj_dir = seed(spec_kind="root_prd", running=True)


class _FakeProc:
    spawned = False
    def __init__(self, *a, **k):
        _FakeProc.spawned = True
        self.pid = 1


server.subprocess.Popen = _FakeProc
client = TestClient(server.app, raise_server_exceptions=False)
resp = client.post(f"/api/fleet/runs/{pid}/retry")
assert resp.status_code == 409, f"running retry -> {resp.status_code}: {resp.text}"
assert _FakeProc.spawned is False, "must not spawn for a running project"
print("OK")
"""

# A project already CLAIMED by a concurrent retry (status="launching") must be
# refused -- this is the persisted marker that closes the double-launch TOCTOU.
_BODY_RETRY_LAUNCHING_REFUSED = _SEED_HELPER + """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.registry as registry
import dashboard.server as server

tmp, pid, proj_dir = seed(spec_kind="root_prd", running=False)

# Simulate a sibling retry that already claimed this project.
with registry._registry_lock():
    reg = registry._load_registry()
    reg["projects"][pid]["status"] = "launching"
    registry._save_registry(reg)


class _FakeProc:
    spawned = False
    def __init__(self, *a, **k):
        _FakeProc.spawned = True
        self.pid = 1


server.subprocess.Popen = _FakeProc
client = TestClient(server.app, raise_server_exceptions=False)
resp = client.post(f"/api/fleet/runs/{pid}/retry")
assert resp.status_code == 409, f"launching retry -> {resp.status_code}: {resp.text}"
assert _FakeProc.spawned is False, "must not spawn for an already-claimed project"
print("OK")
"""


# (c) Retry a project with no recoverable spec -> honest 409 refusal.
_BODY_RETRY_NO_SPEC_REFUSED = _SEED_HELPER + """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.server as server

tmp, pid, proj_dir = seed(spec_kind="none", running=False)


class _FakeProc:
    spawned = False
    def __init__(self, *a, **k):
        _FakeProc.spawned = True
        self.pid = 1


server.subprocess.Popen = _FakeProc
client = TestClient(server.app, raise_server_exceptions=False)
resp = client.post(f"/api/fleet/runs/{pid}/retry")
assert resp.status_code == 409, f"no-spec retry -> {resp.status_code}: {resp.text}"
assert "spec" in resp.json()["detail"].lower(), resp.json()
assert _FakeProc.spawned is False, "must not spawn when no spec is recoverable"
print("OK")
"""


# (c2) generated-prd.md and a dashboard spec are also recoverable sources.
_BODY_RETRY_RECOVERS_GENERATED = _SEED_HELPER + """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.server as server


class _FakeProc:
    def __init__(self, *a, **k):
        self.pid = 7

server.subprocess.Popen = _FakeProc
client = TestClient(server.app, raise_server_exceptions=False)

tmp, pid, _ = seed(spec_kind="generated_prd", running=False)
resp = client.post(f"/api/fleet/runs/{pid}/retry")
assert resp.status_code == 200, f"generated-prd retry -> {resp.status_code}: {resp.text}"
assert resp.json()["spec"].endswith("generated-prd.md"), resp.json()

tmp2, pid2, _ = seed(spec_kind="dashboard_spec", running=False)
resp2 = client.post(f"/api/fleet/runs/{pid2}/retry")
assert resp2.status_code == 200, f"dashboard-spec retry -> {resp2.status_code}: {resp2.text}"
assert resp2.json()["spec"].endswith(".md"), resp2.json()
print("OK")
"""


# (d) Auth-enabled: unauthenticated retry rejected with 401.
_BODY_AUTH_UNAUTH_REJECTED = """
import sys
sys.path.insert(0, %(root)r)
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.server as server
client = TestClient(server.app, raise_server_exceptions=False)
resp = client.post("/api/fleet/runs/anything/retry")
assert resp.status_code == 401, (
    f"retry should reject unauthenticated callers with 401, got {resp.status_code}"
)
print("OK")
""" % {"root": _REPO_ROOT}


# (d2) Auth-enabled: a read-only-scope token is forbidden (403) on the control
# retry action. Mints a read-scope token via auth.generate_token with the token
# store redirected to a temp dir (no temp HOME; the real ~/.loki is untouched),
# then calls retry with it.
_BODY_AUTH_READ_SCOPE_FORBIDDEN = """
import os, sys, tempfile
from pathlib import Path
sys.path.insert(0, %(root)r)
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.auth as auth
if not getattr(auth, "ENTERPRISE_AUTH_ENABLED", False):
    print("SKIP: enterprise auth not active in child")
    sys.exit(0)

# Redirect the token store to a temp dir (auth reads TOKEN_FILE at call time).
tmp = tempfile.mkdtemp(prefix="loki-retry-auth-")
auth.TOKEN_DIR = Path(tmp)
auth.TOKEN_FILE = Path(tmp) / "tokens.json"

created = auth.generate_token(name="readonly", scopes=["read"])
token = created["token"]

import dashboard.server as server
client = TestClient(server.app, raise_server_exceptions=False)
resp = client.post(
    "/api/fleet/runs/anything/retry",
    headers={"Authorization": f"Bearer {token}"},
)
assert resp.status_code == 403, (
    f"read-scope token should be forbidden (403) on retry, got {resp.status_code}: {resp.text}"
)
print("OK")
""" % {"root": _REPO_ROOT}


# (e) Path-traversal identifier is registry-bound: it resolves to no project and
# 404s -- it is never used as a filesystem path, so nothing escapes.
_BODY_RETRY_TRAVERSAL_IDENTIFIER = _SEED_HELPER + """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.server as server


class _FakeProc:
    spawned = False
    def __init__(self, *a, **k):
        _FakeProc.spawned = True
        self.pid = 1


server.subprocess.Popen = _FakeProc
# Seed a registry so the store is initialized, but call retry with traversal-ish
# identifiers that match no registered id/path/alias. A single-segment "%%2E%%2E"
# (".." percent-encoded) and a literal ".." are resolved through the registry,
# never used as a filesystem path, so both resolve to no project -> 404 and
# nothing is spawned. (Encoded slashes are intentionally avoided: the test
# client would decode them into extra path segments and miss the route.)
seed(spec_kind="root_prd", running=False)
client = TestClient(server.app, raise_server_exceptions=False)
for ident in ("%%2E%%2E", "....", "..%%5Cetc", "~root"):
    resp = client.post(f"/api/fleet/runs/{ident}/retry")
    assert resp.status_code == 404, (
        f"traversal identifier {ident!r} -> {resp.status_code}: {resp.text}"
    )
assert _FakeProc.spawned is False, "must not spawn for an unresolved identifier"
print("OK")
"""


# Route-definition check: the retry route exists and carries an auth dependency.
_BODY_ROUTE_HAS_DEPENDENCY = """
import sys
sys.path.insert(0, %(root)r)
import dashboard.server as server
routes = {}
for r in server.app.routes:
    if hasattr(r, "path"):
        routes.setdefault(r.path, []).append(r)
path = "/api/fleet/runs/{identifier}/retry"
assert path in routes, f"{path} route missing"
has_dep = any(len(getattr(r, "dependencies", [])) >= 1 for r in routes[path])
assert has_dep, f"{path} has no auth dependency"
print("OK")
""" % {"root": _REPO_ROOT}


class FleetRetryTest(unittest.TestCase):
    def _assert_child_passed(self, proc):
        if proc.returncode != 0:
            self.fail(
                "subprocess assertion failed (exit "
                f"{proc.returncode}):\nSTDOUT:\n{proc.stdout}\n"
                f"STDERR:\n{proc.stderr}"
            )
        if "SKIP:" in proc.stdout:
            self.skipTest(proc.stdout.strip())

    def test_retry_stopped_with_spec_launches(self):
        proc = _run_in_subprocess(_BODY_RETRY_LAUNCHES, enterprise_auth=False)
        self._assert_child_passed(proc)

    def test_retry_recovers_generated_and_dashboard_specs(self):
        proc = _run_in_subprocess(
            _BODY_RETRY_RECOVERS_GENERATED, enterprise_auth=False
        )
        self._assert_child_passed(proc)

    def test_retry_running_project_refused(self):
        proc = _run_in_subprocess(
            _BODY_RETRY_RUNNING_REFUSED, enterprise_auth=False
        )
        self._assert_child_passed(proc)

    def test_retry_launching_project_refused(self):
        # The double-launch TOCTOU guard: a project already claimed
        # (status="launching") by a concurrent retry must be refused, no spawn.
        proc = _run_in_subprocess(
            _BODY_RETRY_LAUNCHING_REFUSED, enterprise_auth=False
        )
        self._assert_child_passed(proc)

    def test_retry_no_spec_refused_honestly(self):
        proc = _run_in_subprocess(
            _BODY_RETRY_NO_SPEC_REFUSED, enterprise_auth=False
        )
        self._assert_child_passed(proc)

    def test_retry_traversal_identifier_is_registry_bound(self):
        proc = _run_in_subprocess(
            _BODY_RETRY_TRAVERSAL_IDENTIFIER, enterprise_auth=False
        )
        self._assert_child_passed(proc)

    def test_retry_route_has_auth_dependency(self):
        proc = _run_in_subprocess(
            _BODY_ROUTE_HAS_DEPENDENCY, enterprise_auth=False
        )
        self._assert_child_passed(proc)

    def test_auth_enabled_rejects_unauthenticated(self):
        proc = _run_in_subprocess(
            _BODY_AUTH_UNAUTH_REJECTED, enterprise_auth=True
        )
        self._assert_child_passed(proc)

    def test_auth_enabled_read_scope_forbidden(self):
        proc = _run_in_subprocess(
            _BODY_AUTH_READ_SCOPE_FORBIDDEN, enterprise_auth=True
        )
        self._assert_child_passed(proc)


if __name__ == "__main__":
    unittest.main()
