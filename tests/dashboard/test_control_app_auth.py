"""Auth-gating tests for the standalone control app (dashboard/control.py).

dashboard/control.py defines its own self-contained FastAPI `app` whose
docstring invites operators to expose it via `uvicorn dashboard.control:app`.
Its state-mutating endpoints (start/stop/pause/resume) must honor the same
"control" scope check as the primary dashboard (dashboard/server.py); otherwise
following the docstring stands up an unauthenticated control plane even when
LOKI_ENTERPRISE_AUTH / OIDC are configured.

These tests assert:
  1. Every mutating endpoint carries an auth dependency (route-definition level,
     deterministic, no network).
  2. With auth enabled and no credentials, a mutating call is rejected (401).
  3. With auth disabled (default), the anonymous localhost workflow still works
     (no regression).

HERMETICITY
-----------
LOKI_ENTERPRISE_AUTH is read at *import time* by both dashboard.auth and
dashboard.control, so toggling it on/off requires re-executing those modules.
Doing that in-process (via importlib.reload) is leaky: reloading dashboard.auth
rebinds auth.get_current_token to a *new* function object, while routes already
registered on dashboard.server (imported by other tests) remain keyed on the
*original* object. A later test that overrides dependency_overrides on the new
object then silently misses, real auth runs, and unrelated tests start seeing
401 instead of their expected status. (This regression made all of
tests/dashboard/test_tenant_isolation.py fail when both files ran together.)

To stay fully hermetic, every assertion that depends on a particular
LOKI_ENTERPRISE_AUTH value runs in a SUBPROCESS with the env set there. The
parent interpreter's sys.modules and os.environ are never mutated, so no
downstream test is affected. The assertions themselves are unchanged; they are
simply evaluated in a child interpreter.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest


MUTATING_PATHS = [
    "/api/control/start",
    "/api/control/stop",
    "/api/control/pause",
    "/api/control/resume",
]

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _run_in_subprocess(body: str, enterprise_auth):
    """Execute `body` in a child interpreter and return CompletedProcess.

    `enterprise_auth` is one of: True (set LOKI_ENTERPRISE_AUTH=true),
    False (force-unset it), or None (inherit parent unchanged -- unused here).
    The child imports dashboard.* fresh, so LOKI_ENTERPRISE_AUTH is honored at
    import time without touching the parent's modules or environment. The child
    must exit non-zero (via an unhandled AssertionError) to signal failure;
    `body` should assert directly.
    """
    env = dict(os.environ)
    if enterprise_auth is True:
        env["LOKI_ENTERPRISE_AUTH"] = "true"
    elif enterprise_auth is False:
        env.pop("LOKI_ENTERPRISE_AUTH", None)

    # Keep imports isolated from the parent: the child resolves dashboard.* from
    # the repo root on its own sys.path and imports them for the first time.
    preamble = (
        "import sys\n"
        f"sys.path.insert(0, {_REPO_ROOT!r})\n"
        f"MUTATING_PATHS = {MUTATING_PATHS!r}\n"
    )
    return subprocess.run(
        [sys.executable, "-c", preamble + body],
        env=env,
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
    )


# Body executed in the child for the enterprise-auth-enabled rejection test.
# Skips (exit 0) when fastapi TestClient / httpx are unavailable, mirroring the
# original skip behavior. Asserts every mutating path returns 401.
_BODY_AUTH_ENABLED_REJECTS = """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.control as control
client = TestClient(control.app, raise_server_exceptions=False)
for path in MUTATING_PATHS:
    resp = client.post(path)
    assert resp.status_code == 401, (
        f"{path} should reject unauthenticated callers with 401, "
        f"got {resp.status_code}"
    )
print("OK")
"""


# Body executed in the child for the auth-disabled no-regression test.
# resume is side-effect-light and returns 200 regardless of whether a session
# is running -- an ideal anonymous-workflow probe.
_BODY_AUTH_DISABLED_ALLOWS = """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    sys.exit(0)

import dashboard.control as control
client = TestClient(control.app, raise_server_exceptions=False)
resp = client.post("/api/control/resume")
assert resp.status_code == 200, (
    "anonymous localhost workflow must be preserved when auth is off, "
    f"got {resp.status_code}"
)
print("OK")
"""


# Body executed in the child for the route-definition dependency check. This is
# env-independent (it inspects route definitions, not runtime auth), but it is
# run in a subprocess too so this test file imports dashboard.* exactly zero
# times in the parent interpreter -- guaranteeing it cannot perturb any other
# test's view of dashboard.auth / dashboard.server / dashboard.control.
_BODY_ROUTES_HAVE_DEPENDENCY = """
import dashboard.control as control
routes = {r.path: r for r in control.app.routes if hasattr(r, "path")}
for path in MUTATING_PATHS:
    assert path in routes, f"{path} route missing"
    deps = getattr(routes[path], "dependencies", [])
    assert len(deps) >= 1, f"{path} has no auth dependency"
print("OK")
"""


class ControlAppAuthTest(unittest.TestCase):
    def _assert_child_passed(self, proc):
        """Fail with the child's stdout+stderr if it exited non-zero."""
        if proc.returncode != 0:
            self.fail(
                "subprocess assertion failed (exit "
                f"{proc.returncode}):\nSTDOUT:\n{proc.stdout}\n"
                f"STDERR:\n{proc.stderr}"
            )
        if "SKIP:" in proc.stdout:
            self.skipTest(proc.stdout.strip())

    def test_all_mutating_routes_have_a_dependency(self):
        proc = _run_in_subprocess(
            _BODY_ROUTES_HAVE_DEPENDENCY, enterprise_auth=False
        )
        self._assert_child_passed(proc)

    def test_auth_enabled_rejects_unauthenticated_mutation(self):
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
