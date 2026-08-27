"""Remote auth-off reads fail closed at one dashboard namespace boundary.

The old boundary enumerated sensitive prefixes. That shape leaked every read
family added later: context, notifications, agents, usage, PRD observations,
v2 tenants and v2 audit all reached their handlers from a routable address
when auth was off. The tests below enumerate the live route tables and drive
the app as raw ASGI without lifespan startup, so a handler cannot hide a
missing boundary behind database, filesystem or startup failures.
"""

from __future__ import annotations

import asyncio
import os
import pathlib
import re
import sys
import unittest


sys.dont_write_bytecode = True
_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


_SENTINEL = "PACKET606-STATE-MUST-NOT-LEAK"
_PUBLIC_API_GETS = {
    "/api/auth/info",
    "/api/enterprise/status",
    "/api/providers/models",
}
_PUBLIC_PROBES_AND_UI = (
    "/health",
    "/metrics",
    "/.well-known/agent.json",
    "/openapi.json",
    "/docs",
    "/favicon.svg",
    "/",
    "/cost",
    "/trust",
)


def _materialize(path: str) -> str:
    """Turn a FastAPI route template into a harmless routable test path."""
    return re.sub(r"\{[^}]+\}", _SENTINEL, path)


async def _raw_get(app, path: str, host: str = "203.0.113.7"):
    """Issue one no-lifespan ASGI GET and return (status, response body)."""
    messages = []
    delivered = False

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": b"", "more_body": False}
        return {"type": "http.disconnect"}

    async def send(message):
        messages.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("utf-8"),
        "query_string": b"",
        "headers": [(b"host", b"dashboard.example")],
        "client": (host, 5555),
        "server": ("dashboard.example", 80),
        "root_path": "",
    }
    await app(scope, receive, send)
    status = next(
        message["status"]
        for message in messages
        if message["type"] == "http.response.start"
    )
    body = b"".join(
        message.get("body", b"")
        for message in messages
        if message["type"] == "http.response.body"
    )
    return status, body


def _dashboard_get_inventory(server):
    """Return every registered state-bearing GET, including the mounted lab."""
    paths = set()
    for route in server.app.routes:
        methods = getattr(route, "methods", None) or set()
        path = getattr(route, "path", None)
        if path and "GET" in methods and server._is_state_bearing_get(path):
            paths.add(path)

        # Mounts have no methods at the parent table. Enumerate the mounted
        # Purple Lab app too, while testing the full path seen by the parent
        # middleware. Other mounts are static assets and carry no API routes.
        child = getattr(route, "app", None)
        # /lab is wrapped by _MountAuthGuard; unwrap only that transparent
        # boundary adapter to reach the mounted FastAPI route table.
        child = getattr(child, "_app", child)
        child_routes = getattr(child, "routes", None)
        if path == "/lab" and child_routes:
            for child_route in child_routes:
                child_methods = getattr(child_route, "methods", None) or set()
                child_path = getattr(child_route, "path", None)
                if child_path and "GET" in child_methods:
                    full_path = path + child_path
                    if server._is_state_bearing_get(full_path):
                        paths.add(full_path)
    return sorted(paths)


class RemoteAuthOffReadBoundary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ.pop("LOKI_ENTERPRISE_AUTH", None)
        os.environ.pop("LOKI_OIDC_ISSUER", None)
        os.environ.pop("LOKI_OIDC_CLIENT_ID", None)
        from dashboard import auth, server  # noqa: PLC0415

        cls.auth, cls.server = auth, server
        cls._enterprise = auth.ENTERPRISE_AUTH_ENABLED
        cls._oidc = auth.OIDC_ENABLED
        auth.ENTERPRISE_AUTH_ENABLED = False
        auth.OIDC_ENABLED = False

    @classmethod
    def tearDownClass(cls):
        cls.auth.ENTERPRISE_AUTH_ENABLED = cls._enterprise
        cls.auth.OIDC_ENABLED = cls._oidc

    def test_public_api_allowlist_is_exact_and_complete(self):
        self.assertEqual(self.server._PUBLIC_API_GET_PATHS, _PUBLIC_API_GETS)

    def test_named_old_red_families_are_in_the_dynamic_inventory(self):
        inventory = set(_dashboard_get_inventory(self.server))
        for path in (
            "/api/context",
            "/api/notifications",
            "/api/agents",
            "/api/usage",
            "/api/prd-observations",
            "/api/v2/tenants",
            "/api/v2/audit",
        ):
            self.assertIn(path, inventory)

    def test_every_state_bearing_get_is_403_before_a_handler_can_leak(self):
        inventory = _dashboard_get_inventory(self.server)
        self.assertGreaterEqual(
            len(inventory), 150,
            "route inventory unexpectedly shrank; mounted or dashboard reads "
            "may have escaped enumeration",
        )

        async def exercise_all():
            failures = []
            for template in inventory:
                path = _materialize(template)
                status, body = await _raw_get(self.server.app, path)
                if status != 403 or _SENTINEL.encode() in body:
                    failures.append((template, status, body[:160]))
            return failures

        failures = asyncio.run(exercise_all())
        self.assertFalse(
            failures,
            "remote auth-off state-bearing GETs escaped the boundary: %r"
            % failures,
        )

    def test_probes_public_metadata_and_ui_are_not_boundary_blocked(self):
        async def exercise_all():
            results = {}
            for path in _PUBLIC_PROBES_AND_UI + tuple(sorted(_PUBLIC_API_GETS)):
                results[path] = await _raw_get(self.server.app, path)
            return results

        results = asyncio.run(exercise_all())
        for path, (status, body) in results.items():
            self.assertNotEqual(
                status, 403,
                "%s was blocked by the remote read boundary: %r"
                % (path, body[:160]),
            )
        self.assertEqual(results["/health"][0], 200)
        self.assertEqual(results["/metrics"][0], 200)
        for path in _PUBLIC_API_GETS:
            self.assertEqual(results[path][0], 200, path)

    def test_loopback_state_reads_keep_zero_config_behavior(self):
        for path in ("/api/context", "/api/usage", "/api/v2/tenants"):
            status, _body = asyncio.run(
                _raw_get(self.server.app, path, host="127.0.0.1")
            )
            self.assertNotEqual(status, 403, path)


if __name__ == "__main__":
    unittest.main()
