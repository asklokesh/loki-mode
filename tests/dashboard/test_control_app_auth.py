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
"""

from __future__ import annotations

import importlib
import os
import unittest


MUTATING_PATHS = [
    "/api/control/start",
    "/api/control/stop",
    "/api/control/pause",
    "/api/control/resume",
]


def _reload_control(enterprise_auth: bool):
    """Reload auth + control with the desired LOKI_ENTERPRISE_AUTH setting.

    Both modules read the env var at import time, so they must be reloaded
    after the env is mutated.
    """
    if enterprise_auth:
        os.environ["LOKI_ENTERPRISE_AUTH"] = "true"
    else:
        os.environ.pop("LOKI_ENTERPRISE_AUTH", None)
    import dashboard.auth as _auth
    import dashboard.control as _control
    importlib.reload(_auth)
    importlib.reload(_control)
    return _control


class ControlAppAuthTest(unittest.TestCase):
    def tearDown(self):
        # Leave the process in the default (anonymous) state for other tests.
        _reload_control(enterprise_auth=False)

    def test_all_mutating_routes_have_a_dependency(self):
        control = _reload_control(enterprise_auth=False)
        routes = {r.path: r for r in control.app.routes if hasattr(r, "path")}
        for path in MUTATING_PATHS:
            self.assertIn(path, routes, f"{path} route missing")
            deps = getattr(routes[path], "dependencies", [])
            self.assertGreaterEqual(
                len(deps), 1, f"{path} has no auth dependency"
            )

    def test_auth_enabled_rejects_unauthenticated_mutation(self):
        try:
            from fastapi.testclient import TestClient  # noqa: F401
            import httpx  # noqa: F401
        except Exception:
            self.skipTest("fastapi TestClient / httpx not available")
        control = _reload_control(enterprise_auth=True)
        from fastapi.testclient import TestClient

        client = TestClient(control.app, raise_server_exceptions=False)
        for path in MUTATING_PATHS:
            resp = client.post(path)
            self.assertEqual(
                resp.status_code,
                401,
                f"{path} should reject unauthenticated callers with 401, "
                f"got {resp.status_code}",
            )

    def test_auth_disabled_allows_anonymous(self):
        try:
            from fastapi.testclient import TestClient  # noqa: F401
            import httpx  # noqa: F401
        except Exception:
            self.skipTest("fastapi TestClient / httpx not available")
        control = _reload_control(enterprise_auth=False)
        from fastapi.testclient import TestClient

        client = TestClient(control.app, raise_server_exceptions=False)
        # resume/pause are side-effect-light and return 200 regardless of
        # whether a session is running -- ideal for a no-regression probe.
        resp = client.post("/api/control/resume")
        self.assertEqual(
            resp.status_code,
            200,
            "anonymous localhost workflow must be preserved when auth is off",
        )


if __name__ == "__main__":
    unittest.main()
