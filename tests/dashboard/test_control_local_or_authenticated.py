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

ENFORCED CENTRALLY. The check is one http middleware over every mutating
method, not a dependency added per route. All 46 mutating routes already
carried require_scope and all 46 were bypassable, because require_scope is a
no-op when auth is disabled -- the count of scoped routes described the code
accurately and the security posture not at all. A per-route guard protects the
ones someone remembered and leaves every future route unprotected.

ONLY A ROUTABLE ADDRESS IS REFUSED. Starlette's TestClient reports its peer as
the literal string "testclient", and in-process and UDS transports report names
too; a peer that is not an IP literal is not evidence of a remote caller.
Refusing every non-loopback string broke 17 existing tests. The check parses
the address and refuses only what is genuinely routable.

PROVEN ON A REAL SOCKET, not only through TestClient. With the server bound to
0.0.0.0 (the documented container configuration):

    POST http://127.0.0.1:57398/api/control/stop      -> 200
    POST http://192.168.1.74:57398/api/control/stop   -> 403
"""

import os
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


class TheBoundaryIsCentralNotPerRoute(unittest.TestCase):
    """One middleware, not 46 hand-applied dependencies.

    A first attempt added a dependency to six control routes by hand. That
    shape protects the six someone remembered, leaves the other forty, and
    every route added later starts unprotected. All 46 mutating routes already
    carried require_scope and all 46 were bypassable, because require_scope is
    a no-op when auth is disabled -- so the count of scoped routes described
    the code accurately and the security posture not at all.
    """

    def test_a_single_http_middleware_gates_mutations(self):
        src = (_ROOT / "dashboard" / "server.py").read_text(
            encoding="utf-8", errors="replace")
        self.assertIn(
            '@app.middleware("http")', src,
            "the dashboard boundary middleware is gone; mutations are gated "
            "per-route again and any new route starts unprotected")
        self.assertIn(
            "async def dashboard_control_boundary", src,
            "the boundary function was renamed or removed")

    def test_the_boundary_is_not_reimplemented_per_route(self):
        src = (_ROOT / "dashboard" / "server.py").read_text(
            encoding="utf-8", errors="replace")
        n = src.count("Depends(require_local_or_authenticated)")
        self.assertEqual(
            n, 0,
            "%d routes carry the guard as a per-route dependency; the "
            "boundary is central so a new route cannot be forgotten" % n)


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


from starlette.testclient import TestClient  # noqa: E402


class TheProxyBypassIsClosed(unittest.TestCase):
    """A reverse proxy on the same host presents 127.0.0.1 as the peer.

    "The peer is loopback" therefore cannot mean "the caller is local". This
    was a REAL bypass, measured: a remote request carrying
    X-Forwarded-For: 203.0.113.9 through a same-host proxy reached
    POST /api/control/stop and got 200.

    Trusting X-Forwarded-For unconditionally is the opposite mistake, because
    any direct caller can send that header. So the operator names the proxies
    in LOKI_TRUSTED_PROXIES, and an unnamed proxy's headers are IGNORED.
    """

    def setUp(self):
        try:
            from starlette.testclient import TestClient  # noqa: PLC0415
            from dashboard import server, auth  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("dashboard/starlette not importable: %s" % exc)
        self.TestClient, self.server, self.auth = TestClient, server, auth
        self._ent, self._oidc = auth.ENTERPRISE_AUTH_ENABLED, auth.OIDC_ENABLED
        auth.ENTERPRISE_AUTH_ENABLED = False
        auth.OIDC_ENABLED = False
        self._prox = os.environ.get("LOKI_TRUSTED_PROXIES")

    def tearDown(self):
        self.auth.ENTERPRISE_AUTH_ENABLED = self._ent
        self.auth.OIDC_ENABLED = self._oidc
        if self._prox is None:
            os.environ.pop("LOKI_TRUSTED_PROXIES", None)
        else:
            os.environ["LOKI_TRUSTED_PROXIES"] = self._prox

    def _client(self, host):
        return self.TestClient(self.server.app, raise_server_exceptions=False,
                               client=(host, 5555))

    def test_a_trusted_proxy_forwarding_a_remote_client_is_refused(self):
        os.environ["LOKI_TRUSTED_PROXIES"] = "127.0.0.1"
        r = self._client("127.0.0.1").post(
            "/api/control/stop", json={},
            headers={"X-Forwarded-For": "203.0.113.9"})
        self.assertEqual(
            r.status_code, 403,
            "a remote client forwarded by a TRUSTED proxy was allowed to "
            "mutate; the loopback peer address masked a remote caller")

    def test_an_untrusted_proxy_header_is_ignored_not_believed(self):
        os.environ.pop("LOKI_TRUSTED_PROXIES", None)
        r = self._client("127.0.0.1").post(
            "/api/control/stop", json={},
            headers={"X-Forwarded-For": "203.0.113.9"})
        self.assertEqual(
            r.status_code, 200,
            "an UNTRUSTED X-Forwarded-For changed the decision; any direct "
            "caller can set that header, so it must be ignored unless the "
            "peer is a declared proxy")


class SensitiveReadsAreGatedAndProbesAreNot(unittest.TestCase):
    """Gating mutations alone left operational state readable.

    Measured from a routable remote address with auth off, before the read
    classification existed: /api/logs, /api/secrets/status, /api/github/status,
    /api/tasks, /api/council/transcripts and /api/proofs all returned 200.
    """

    def setUp(self):
        try:
            from starlette.testclient import TestClient  # noqa: PLC0415
            from dashboard import server, auth  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("dashboard/starlette not importable: %s" % exc)
        self.server, self.auth = server, auth
        self._ent, self._oidc = auth.ENTERPRISE_AUTH_ENABLED, auth.OIDC_ENABLED
        auth.ENTERPRISE_AUTH_ENABLED = False
        auth.OIDC_ENABLED = False
        self.remote = TestClient(server.app, raise_server_exceptions=False,
                                 client=("203.0.113.7", 5555))

    def tearDown(self):
        self.auth.ENTERPRISE_AUTH_ENABLED = self._ent
        self.auth.OIDC_ENABLED = self._oidc

    def test_sensitive_reads_are_refused_from_a_remote_caller(self):
        for path in ("/api/logs", "/api/secrets/status", "/api/github/status",
                     "/api/tasks", "/api/council/transcripts", "/api/proofs"):
            r = self.remote.get(path)
            self.assertEqual(
                r.status_code, 403,
                "%s returned %d to an anonymous remote caller"
                % (path, r.status_code))

    def test_health_and_metrics_stay_open(self):
        """A container health probe and a Prometheus scrape must keep working
        with no configuration, or the guard breaks every container."""
        for path in ("/health", "/metrics"):
            r = self.remote.get(path)
            self.assertEqual(
                r.status_code, 200,
                "%s returned %d; unconfigured container probes would fail"
                % (path, r.status_code))


class WebSocketsAreInsideTheBoundary(unittest.TestCase):
    """@app.middleware("http") only wraps HTTP scopes.

    Every WebSocket route was therefore OUTSIDE the boundary. Measured with
    auth off, from a routable remote address, both accepted the connection:

        /ws          CONNECTED
        /ws/collab   CONNECTED   -- and it is WRITABLE, so a network caller
                                    could push collaboration state

    The routes are not careless: /ws checks a query-parameter token when
    enterprise auth is ON, and server.py records that FastAPI's Depends() does
    not work on websocket routes. The hole is the auth-OFF default.
    """

    def setUp(self):
        try:
            from starlette.testclient import TestClient  # noqa: PLC0415
            from dashboard import server, auth  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("dashboard/starlette not importable: %s" % exc)
        self.TestClient, self.server, self.auth = TestClient, server, auth
        self._ent, self._oidc = auth.ENTERPRISE_AUTH_ENABLED, auth.OIDC_ENABLED
        auth.ENTERPRISE_AUTH_ENABLED = False
        auth.OIDC_ENABLED = False
        self._prox = os.environ.get("LOKI_TRUSTED_PROXIES")
        os.environ.pop("LOKI_TRUSTED_PROXIES", None)

    def tearDown(self):
        self.auth.ENTERPRISE_AUTH_ENABLED = self._ent
        self.auth.OIDC_ENABLED = self._oidc
        if self._prox is None:
            os.environ.pop("LOKI_TRUSTED_PROXIES", None)
        else:
            os.environ["LOKI_TRUSTED_PROXIES"] = self._prox

    def _connects(self, host, path="/ws", headers=None):
        client = self.TestClient(self.server.app, raise_server_exceptions=False,
                                 client=(host, 5555))
        try:
            with client.websocket_connect(path, headers=headers or {}):
                return True
        except Exception:
            return False

    def test_a_remote_caller_cannot_open_the_status_socket(self):
        self.assertFalse(
            self._connects("203.0.113.7"),
            "/ws accepted a remote anonymous upgrade")

    def test_a_remote_caller_cannot_open_the_writable_collab_socket(self):
        self.assertFalse(
            self._connects("203.0.113.7", "/ws/collab"),
            "/ws/collab accepted a remote anonymous upgrade; it is WRITABLE, "
            "so a network caller could push collaboration state")

    def test_loopback_still_connects(self):
        """The dashboard SPA is the main consumer of these sockets. If this
        breaks, the guard is a regression rather than a fix."""
        for path in ("/ws", "/ws/collab"):
            self.assertTrue(
                self._connects("127.0.0.1", path),
                "loopback was refused on %s" % path)

    def test_an_untrusted_forwarded_header_is_ignored(self):
        self.assertTrue(
            self._connects("127.0.0.1", "/ws",
                           {"X-Forwarded-For": "203.0.113.9"}),
            "an UNTRUSTED X-Forwarded-For changed the decision; any caller "
            "can set that header")

    def test_a_trusted_proxy_forwarding_a_remote_client_is_refused(self):
        os.environ["LOKI_TRUSTED_PROXIES"] = "127.0.0.1"
        self.assertFalse(
            self._connects("127.0.0.1", "/ws",
                           {"X-Forwarded-For": "203.0.113.9"}),
            "a remote client forwarded by a TRUSTED proxy opened a socket")

    def test_a_scope_without_a_peer_fails_closed(self):
        """An unidentifiable caller is where 'assume local' is least safe."""
        import asyncio
        mw = self.server.WebSocketBoundaryMiddleware(
            lambda scope, receive, send: None)
        sent = []

        async def _send(message):
            sent.append(message)

        async def _receive():
            return {}

        asyncio.run(mw({"type": "websocket", "headers": [], "path": "/ws"},
                       _receive, _send))
        self.assertEqual(
            sent, [{"type": "websocket.close", "code": 1008}],
            "a scope with no client address was passed through instead of "
            "being closed")


if __name__ == "__main__":
    unittest.main()
