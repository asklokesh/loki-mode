"""A remote anonymous caller must not be able to stop a running build.

THE HOLE THIS CLOSES. Every /api/control mutation already carries
Depends(auth.require_scope("control")). That check returns True when
enterprise auth is DISABLED, which is the default. Bound to 127.0.0.1 that is
fine -- the only callers are on the machine. But the dashboard is documented to
run with LOKI_DASHBOARD_HOST=0.0.0.0 in a container
(docs/architecture/DASHBOARD_V2_ARCHITECTURE.md:736), and in that configuration
an unauthenticated request from anywhere on the network could stop a build.

Measured before the guard, on a default deployment with auth unset:

    POST /api/control/stop      -> 200
    POST /api/control/app-stop  -> 200

The rule is deliberately narrow so it cannot break a working local setup:

    auth enabled                    require_scope already decides
    auth disabled + loopback        allowed, exactly as before
    auth disabled + remote          403
    auth disabled + unknown peer    403, because an unidentifiable caller is
                                    the case where "assume local" is least safe

A NOTE ON TESTING THIS. Starlette's TestClient reports its peer host as the
literal string "testclient", not 127.0.0.1, so a TestClient request is treated
as REMOTE by this guard and receives 403. That is a test artifact, not the
behaviour a real local user sees: verified against a real uvicorn socket on
127.0.0.1, a genuine loopback POST still returns 200. The tests below assert
the remote-refusal half through TestClient and pin the loopback allowance by
calling the dependency directly with a loopback address.
"""

import pathlib
import sys
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

_MUTATING = (
    "/api/control/start",
    "/api/control/pause",
    "/api/control/resume",
    "/api/control/stop",
    "/api/control/app-restart",
    "/api/control/app-stop",
)


class _FakeClient:
    def __init__(self, host):
        self.host = host


class _FakeRequest:
    def __init__(self, host):
        self.client = _FakeClient(host) if host is not None else None


class TheGuardDecidesCorrectly(unittest.TestCase):
    """Direct calls, so the decision is tested without a transport in the way."""

    def setUp(self):
        try:
            from dashboard import server, auth  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("dashboard not importable: %s" % exc)
        self.server, self.auth = server, auth
        self._ent = auth.ENTERPRISE_AUTH_ENABLED
        self._oidc = auth.OIDC_ENABLED
        auth.ENTERPRISE_AUTH_ENABLED = False
        auth.OIDC_ENABLED = False

    def tearDown(self):
        self.auth.ENTERPRISE_AUTH_ENABLED = self._ent
        self.auth.OIDC_ENABLED = self._oidc

    def test_loopback_is_allowed_when_auth_is_off(self):
        """The existing local workflow must keep working, or this guard is a
        regression rather than a fix."""
        for host in ("127.0.0.1", "::1", "localhost"):
            self.server.require_local_or_authenticated(_FakeRequest(host))

    def test_a_remote_caller_is_refused_when_auth_is_off(self):
        from fastapi import HTTPException
        for host in ("203.0.113.7", "10.0.0.5", "192.168.1.20"):
            with self.assertRaises(HTTPException) as ctx:
                self.server.require_local_or_authenticated(_FakeRequest(host))
            self.assertEqual(ctx.exception.status_code, 403,
                             "remote caller %s was not refused" % host)

    def test_an_unidentifiable_caller_is_refused(self):
        """Fail closed: 'assume local' is least safe exactly here."""
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as ctx:
            self.server.require_local_or_authenticated(_FakeRequest(None))
        self.assertEqual(ctx.exception.status_code, 403)

    def test_enabled_auth_defers_to_require_scope(self):
        """With auth on, this guard must not second-guess the scope check --
        otherwise a legitimate authenticated remote operator is locked out."""
        self.auth.ENTERPRISE_AUTH_ENABLED = True
        self.server.require_local_or_authenticated(_FakeRequest("203.0.113.7"))


class EveryMutatingControlRouteCarriesTheGuard(unittest.TestCase):

    def test_all_six_are_guarded(self):
        src = (_ROOT / "dashboard" / "server.py").read_text(
            encoding="utf-8", errors="replace")
        for path in _MUTATING:
            needle = ('@app.post("%s", dependencies=[Depends('
                      'auth.require_scope("control")), '
                      'Depends(require_local_or_authenticated)])' % path)
            self.assertIn(
                needle, src,
                "%s does not carry require_local_or_authenticated; a remote "
                "anonymous caller could invoke it on a 0.0.0.0 deployment"
                % path)


class ARemoteRequestIsRefusedEndToEnd(unittest.TestCase):
    """Through the real middleware stack, not just the callable."""

    def test_remote_post_gets_403(self):
        try:
            from starlette.testclient import TestClient
            from dashboard import server, auth  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("dashboard/starlette not importable: %s" % exc)
        ent, oidc = auth.ENTERPRISE_AUTH_ENABLED, auth.OIDC_ENABLED
        auth.ENTERPRISE_AUTH_ENABLED = False
        auth.OIDC_ENABLED = False
        try:
            client = TestClient(server.app, raise_server_exceptions=False,
                                client=("203.0.113.7", 55555))
            for path in ("/api/control/stop", "/api/control/app-stop"):
                r = client.post(path, json={})
                self.assertEqual(
                    r.status_code, 403,
                    "%s returned %d to a remote anonymous caller"
                    % (path, r.status_code))
        finally:
            auth.ENTERPRISE_AUTH_ENABLED = ent
            auth.OIDC_ENABLED = oidc


if __name__ == "__main__":
    unittest.main()
