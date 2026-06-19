"""RBAC-scope tests for the dashboard memory read endpoints (dashboard/server.py).

The memory read endpoints expose stored episodic/semantic/procedural memory
contents. Their sibling endpoints (/api/memory/summary, /api/memory/file, the
{id} detail routes) already carry require_scope("read"), so the collection and
discovery reads must carry the same scope; otherwise, with enterprise auth on,
an unauthenticated caller could list the full episode/pattern/skill set and read
the index/timeline/stats while a single-item read is rejected.

These tests assert:
  1. Every memory read endpoint carries an auth dependency (route-definition
     level, deterministic, no network).
  2. With auth enabled and no credentials, a memory read is rejected (401).
  3. With auth disabled (default), the anonymous localhost read still works
     (no regression).

HERMETICITY
-----------
LOKI_ENTERPRISE_AUTH is read at *import time* by dashboard.auth, so toggling it
requires re-executing that module. Reloading in-process is leaky (it rebinds
auth.get_current_token to a new object while already-registered routes keep the
original), so every assertion that depends on a particular LOKI_ENTERPRISE_AUTH
value runs in a SUBPROCESS with the env set there. The parent interpreter's
sys.modules and os.environ are never mutated. This mirrors
tests/dashboard/test_control_app_auth.py.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest


# Memory read endpoints that must carry require_scope("read"). These are the
# routes swept in the v7.77 consistency pass; /api/memory/index is used as the
# runtime probe because it is side-effect-free and returns 200 with an empty
# index when no .loki directory exists.
MEMORY_READ_PATHS = [
    "/api/memory/episodes",
    "/api/memory/patterns",
    "/api/memory/skills",
    "/api/memory/index",
    "/api/memory/timeline",
    "/api/memory/search",
    "/api/memory/stats",
]
PROBE_PATH = "/api/memory/index"

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _run_in_subprocess(body: str, enterprise_auth):
    """Execute `body` in a child interpreter and return CompletedProcess.

    `enterprise_auth` is one of: True (set LOKI_ENTERPRISE_AUTH=true) or
    False (force-unset it). The child imports dashboard.* fresh, so
    LOKI_ENTERPRISE_AUTH is honored at import time without touching the parent's
    modules or environment. The child must exit non-zero (via an unhandled
    AssertionError) to signal failure; `body` should assert directly.
    """
    env = dict(os.environ)
    if enterprise_auth is True:
        env["LOKI_ENTERPRISE_AUTH"] = "true"
    elif enterprise_auth is False:
        env.pop("LOKI_ENTERPRISE_AUTH", None)
    # Force OIDC off too so the only auth toggle under test is token auth.
    env.pop("LOKI_OIDC_ISSUER", None)
    env.pop("LOKI_OIDC_CLIENT_ID", None)

    preamble = (
        "import sys\n"
        f"sys.path.insert(0, {_REPO_ROOT!r})\n"
        f"MEMORY_READ_PATHS = {MEMORY_READ_PATHS!r}\n"
        f"PROBE_PATH = {PROBE_PATH!r}\n"
    )
    return subprocess.run(
        [sys.executable, "-c", preamble + body],
        env=env,
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
    )


# Route-definition dependency check. Env-independent, but run in a subprocess so
# this test file imports dashboard.* exactly zero times in the parent
# interpreter, guaranteeing it cannot perturb any other test's view of
# dashboard.auth / dashboard.server.
_BODY_ROUTES_HAVE_DEPENDENCY = """
import dashboard.server as server
routes = {}
for r in server.app.routes:
    methods = getattr(r, "methods", None) or set()
    if hasattr(r, "path") and "GET" in methods:
        routes[r.path] = r
for path in MEMORY_READ_PATHS:
    assert path in routes, f"{path} GET route missing"
    deps = getattr(routes[path], "dependencies", [])
    assert len(deps) >= 1, f"{path} has no auth dependency"
print("OK")
"""


_BODY_AUTH_ENABLED_REJECTS = """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.server as server
client = TestClient(server.app, raise_server_exceptions=False)
for path in MEMORY_READ_PATHS:
    resp = client.get(path)
    assert resp.status_code == 401, (
        f"{path} should reject unauthenticated reads with 401, "
        f"got {resp.status_code}"
    )
print("OK")
"""


_BODY_AUTH_DISABLED_ALLOWS = """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.server as server
client = TestClient(server.app, raise_server_exceptions=False)
resp = client.get(PROBE_PATH)
assert resp.status_code == 200, (
    "anonymous localhost read must be preserved when auth is off, "
    f"got {resp.status_code}"
)
print("OK")
"""


class MemoryReadScopeAuthTest(unittest.TestCase):
    def _assert_child_passed(self, proc):
        if proc.returncode != 0:
            self.fail(
                "subprocess assertion failed (exit "
                f"{proc.returncode}):\nSTDOUT:\n{proc.stdout}\n"
                f"STDERR:\n{proc.stderr}"
            )
        if "SKIP:" in proc.stdout:
            self.skipTest(proc.stdout.strip())

    def test_all_memory_reads_have_a_dependency(self):
        proc = _run_in_subprocess(
            _BODY_ROUTES_HAVE_DEPENDENCY, enterprise_auth=False
        )
        self._assert_child_passed(proc)

    def test_auth_enabled_rejects_unauthenticated_read(self):
        proc = _run_in_subprocess(
            _BODY_AUTH_ENABLED_REJECTS, enterprise_auth=True
        )
        self._assert_child_passed(proc)

    def test_auth_disabled_allows_anonymous(self):
        proc = _run_in_subprocess(
            _BODY_AUTH_DISABLED_ALLOWS, enterprise_auth=False
        )
        self._assert_child_passed(proc)


if __name__ == "__main__":
    unittest.main()
