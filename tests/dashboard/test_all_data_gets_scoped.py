"""Auth-scope coverage test for ALL dashboard data GET endpoints.

Regression guard for the v7.x finding that 68 of 110 GET routes carried no
require_scope dependency: with LOKI_ENTERPRISE_AUTH=true an unauthenticated
client could read cost, council transcripts, escalations, app-runner logs,
findings, learnings, and more, because only some GETs were guarded.

This test asserts that EVERY /api/* data GET carries at least one route
dependency. A small, explicit allowlist names the routes that are intentionally
public (health probe, the SPA shell, the capability/agent cards, and the auth
discovery endpoints). Any new unguarded /api/* GET fails this test.

HERMETICITY
-----------
The route table is inspected at definition time (no network, env-independent),
but the check runs in a SUBPROCESS so this file imports dashboard.* zero times
in the parent interpreter, matching tests/dashboard/test_memory_read_scope_auth.py.
"""

from __future__ import annotations

import os
import subprocess
import sys
import unittest


# Routes that are intentionally public (no auth dependency required). Keep this
# list tight: anything not here that is a data-bearing /api/* GET must be
# guarded.
PUBLIC_ALLOWLIST = {
    "/health",
    "/favicon.svg",
    "/",
    "/cost",
    "/trust",
    "/.well-known/agent.json",
    "/api/auth/info",
    "/api/enterprise/status",
    "/api/providers/models",  # static provider/model catalog, not project data
    "/{full_path:path}",      # SPA catch-all
    "/metrics",               # Prometheus scrape target; MUST be public (the
                              # ServiceMonitor scrapes it without a token)
}

# Routes that MUST stay PUBLIC even under enterprise auth (a 401 here is a
# regression, not hardening): k8s probes, A2A discovery, auth bootstrap, and the
# Prometheus endpoint. The data-GET guard above must never reach these.
MUST_BE_PUBLIC = {
    "/health",                  # k8s liveness/readiness probe -> 401 = CrashLoop
    "/.well-known/agent.json",  # A2A agent card, spec-mandated public discovery
    "/api/auth/info",           # bootstrap: client needs this to learn how to auth
    "/api/enterprise/status",   # auth-mode discovery
    "/metrics",                 # Prometheus scrape (ServiceMonitor, no token)
    "/favicon.svg",             # static asset
}


_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _run_in_subprocess(body: str):
    env = dict(os.environ)
    env.pop("LOKI_ENTERPRISE_AUTH", None)
    env.pop("LOKI_OIDC_ISSUER", None)
    env.pop("LOKI_OIDC_CLIENT_ID", None)
    preamble = (
        "import sys\n"
        f"sys.path.insert(0, {_REPO_ROOT!r})\n"
        f"PUBLIC_ALLOWLIST = {PUBLIC_ALLOWLIST!r}\n"
    )
    return subprocess.run(
        [sys.executable, "-c", preamble + body],
        env=env,
        cwd=_REPO_ROOT,
        capture_output=True,
        text=True,
    )


_BODY_NO_UNGUARDED_DATA_GET = """
import dashboard.server as server

unguarded = []
for r in server.app.routes:
    methods = getattr(r, "methods", None) or set()
    path = getattr(r, "path", None)
    if path is None or "GET" not in methods:
        continue
    if not path.startswith("/api/"):
        # Non-/api paths are shells/probes; only /api carries data.
        continue
    if path in PUBLIC_ALLOWLIST:
        continue
    deps = getattr(r, "dependencies", [])
    if len(deps) < 1:
        unguarded.append(path)

assert not unguarded, (
    "These /api/* data GET routes have no auth dependency: " + repr(sorted(unguarded))
)
print("OK")
"""


# Spot-check that the specific high-value leaks named in the finding are guarded.
_LEAK_PROBES = [
    "/api/cost",
    "/api/budget",
    "/api/council/state",
    "/api/council/transcripts",
    "/api/escalations",
    "/api/app-runner/logs",
    "/api/findings/{iteration}",
    "/api/learnings",
    "/api/proofs",
    "/api/checklist",
    "/api/quality-report",
]

_BODY_NAMED_LEAKS_GUARDED = """
import dashboard.server as server

routes = {}
for r in server.app.routes:
    methods = getattr(r, "methods", None) or set()
    if "GET" in methods and hasattr(r, "path"):
        routes[r.path] = r

probes = %r
for path in probes:
    assert path in routes, f"{path} GET route missing"
    deps = getattr(routes[path], "dependencies", [])
    assert len(deps) >= 1, f"{path} must carry an auth dependency"
print("OK")
""" % (_LEAK_PROBES,)


# Static: routes that MUST stay public must carry NO auth dependency. This is the
# guard that was missing -- the prior test only allowlisted them, so over-gating
# (a 401 on /health -> k8s CrashLoop under enterprise auth) slipped through.
_BODY_PUBLIC_NOT_GATED = """
import dashboard.server as server

routes = {}
for r in server.app.routes:
    methods = getattr(r, "methods", None) or set()
    if "GET" in methods and hasattr(r, "path"):
        routes[r.path] = r

must_public = %r
over_gated = []
for path in must_public:
    r = routes.get(path)
    if r is None:
        continue  # route may be conditionally registered; skip if absent
    if len(getattr(r, "dependencies", [])) > 0:
        over_gated.append(path)

assert not over_gated, (
    "These MUST-BE-PUBLIC routes carry an auth dependency (regression: a 401 here "
    "breaks k8s probes / A2A discovery / Prometheus scrape under enterprise auth): "
    + repr(sorted(over_gated))
)
print("OK")
""" % (sorted(MUST_BE_PUBLIC),)

# Behavioral: with enterprise auth ON, a public route returns non-401 while a
# data route returns 401 (proves the scope guards work in BOTH directions).
_BODY_PUBLIC_BEHAVIORAL = """
try:
    from fastapi.testclient import TestClient
    import httpx  # noqa: F401
except Exception:
    print("SKIP: fastapi TestClient / httpx not available")
    raise SystemExit(0)

import os
os.environ["LOKI_ENTERPRISE_AUTH"] = "true"
import dashboard.server as server

client = TestClient(server.app, raise_server_exceptions=False)
# Public routes must NOT 401 even with no token.
for path in ["/health", "/api/auth/info", "/api/enterprise/status", "/metrics"]:
    rc = client.get(path).status_code
    assert rc != 401, f"PUBLIC route {path} returned 401 under enterprise auth (regression): {rc}"
# A data route MUST 401 without a token (the auth fix actually works).
data_rc = client.get("/api/cost").status_code
assert data_rc == 401, f"/api/cost should 401 without a token under enterprise auth, got {data_rc}"
print("OK")
"""


class AllDataGetsScopedTest(unittest.TestCase):
    def _assert_child_passed(self, proc):
        if proc.returncode != 0:
            self.fail(
                "subprocess assertion failed (exit "
                f"{proc.returncode}):\nSTDOUT:\n{proc.stdout}\n"
                f"STDERR:\n{proc.stderr}"
            )
        if "SKIP:" in proc.stdout:
            self.skipTest(proc.stdout.strip())

    def test_no_unguarded_api_data_get(self):
        proc = _run_in_subprocess(_BODY_NO_UNGUARDED_DATA_GET)
        self._assert_child_passed(proc)

    def test_named_leak_endpoints_are_guarded(self):
        proc = _run_in_subprocess(_BODY_NAMED_LEAKS_GUARDED)
        self._assert_child_passed(proc)

    def test_public_routes_not_gated(self):
        proc = _run_in_subprocess(_BODY_PUBLIC_NOT_GATED)
        self._assert_child_passed(proc)

    def test_public_routes_non_401_under_enterprise_auth(self):
        proc = _run_in_subprocess(_BODY_PUBLIC_BEHAVIORAL)
        self._assert_child_passed(proc)


if __name__ == "__main__":
    unittest.main()
