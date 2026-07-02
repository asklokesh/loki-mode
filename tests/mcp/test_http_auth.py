"""
tests/mcp/test_http_auth.py

Regression tests for the optional bearer-token auth + explicit loopback bind
on `loki mcp --transport http` (mcp/server.py::_run_http_transport, gap rank 18).

The auth layer is a Starlette BaseHTTPMiddleware that:
  - when LOKI_MCP_AUTH_TOKEN is set: requires `Authorization: Bearer <token>`
    on every HTTP request, rejecting a missing/wrong header with 401;
  - when LOKI_MCP_AUTH_TOKEN is unset/empty: is not installed at all, so the
    request path is byte-identical to the unauthenticated FastMCP behavior.

Rather than boot a full FastMCP server (network + SDK session manager), these
tests reconstruct the SAME middleware the server installs and mount it on a
minimal Starlette app that HAS a lifespan. That lets a real Starlette TestClient
exercise the exact code paths, including proving the middleware forwards the
non-http `lifespan` ASGI scope (BaseHTTPMiddleware does this automatically) so
the app still starts up -- the failure mode that would 500/hang every real MCP
request while a naive 401 test still "passed".

The middleware factory here is intentionally a faithful copy of the block in
mcp/server.py::_run_http_transport. If the server's logic changes, this test
must change with it; the accompanying live curl matrix in
tests/test-mcp-http-auth.sh exercises the real server end to end.
"""

from __future__ import annotations

import hmac
import unittest


def _build_auth_middleware(token):
    """Mirror of the dispatch installed in server.py::_run_http_transport."""
    from starlette.responses import JSONResponse

    expected_header = "Bearer " + token

    async def _require_bearer(request, call_next):
        provided = request.headers.get("authorization", "")
        if not hmac.compare_digest(provided, expected_header):
            return JSONResponse(
                {"error": "unauthorized"},
                status_code=401,
                headers={"WWW-Authenticate": "Bearer"},
            )
        return await call_next(request)

    return _require_bearer


def _make_app(token=None):
    """Minimal Starlette app with a lifespan and a single route.

    When `token` is truthy, wrap it with the bearer middleware exactly as the
    server does. When falsy, install nothing (unauthenticated path).
    """
    from contextlib import asynccontextmanager

    from starlette.applications import Starlette
    from starlette.responses import PlainTextResponse
    from starlette.routing import Route

    lifespan_started = {"value": False}

    @asynccontextmanager
    async def lifespan(app):
        # Proves the lifespan scope reaches startup even with the middleware in
        # place (BaseHTTPMiddleware forwards non-http scopes).
        lifespan_started["value"] = True
        yield

    async def ok(request):
        return PlainTextResponse("ok")

    app = Starlette(routes=[Route("/mcp", ok)], lifespan=lifespan)
    app.state.lifespan_started = lifespan_started

    if token:
        from starlette.middleware.base import BaseHTTPMiddleware
        app.add_middleware(BaseHTTPMiddleware, dispatch=_build_auth_middleware(token))

    return app


class TestHttpBearerAuth(unittest.TestCase):
    TOKEN = "s3cr3t-token-value"

    def _client(self, app):
        from starlette.testclient import TestClient
        # `with` drives the lifespan (startup/shutdown).
        return TestClient(app)

    def test_token_set_no_bearer_rejected_401(self):
        app = _make_app(token=self.TOKEN)
        with self._client(app) as client:
            resp = client.get("/mcp")
            self.assertEqual(resp.status_code, 401)
            self.assertEqual(resp.json().get("error"), "unauthorized")
            self.assertIn("bearer", resp.headers.get("www-authenticate", "").lower())
            # Lifespan still ran despite the middleware -> non-http scope forwarded.
            self.assertTrue(app.state.lifespan_started["value"])

    def test_token_set_wrong_bearer_rejected_401(self):
        app = _make_app(token=self.TOKEN)
        with self._client(app) as client:
            resp = client.get("/mcp", headers={"Authorization": "Bearer wrong-token"})
            self.assertEqual(resp.status_code, 401)

    def test_token_set_malformed_header_rejected_401(self):
        app = _make_app(token=self.TOKEN)
        with self._client(app) as client:
            # Right token value but missing the "Bearer " scheme prefix.
            resp = client.get("/mcp", headers={"Authorization": self.TOKEN})
            self.assertEqual(resp.status_code, 401)

    def test_token_set_correct_bearer_allowed_200(self):
        app = _make_app(token=self.TOKEN)
        with self._client(app) as client:
            resp = client.get(
                "/mcp", headers={"Authorization": "Bearer " + self.TOKEN}
            )
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.text, "ok")

    def test_token_unset_no_auth_applied(self):
        # Falsy token -> middleware not installed; request succeeds with no header.
        app = _make_app(token=None)
        with self._client(app) as client:
            resp = client.get("/mcp")
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.text, "ok")

    def test_compare_is_constant_time_semantics(self):
        # Guards the exact matcher: only the full "Bearer <token>" string passes.
        expected = "Bearer " + self.TOKEN
        self.assertTrue(hmac.compare_digest("Bearer " + self.TOKEN, expected))
        self.assertFalse(hmac.compare_digest("Bearer " + self.TOKEN + "x", expected))
        self.assertFalse(hmac.compare_digest("", expected))


if __name__ == "__main__":
    unittest.main(verbosity=2)
