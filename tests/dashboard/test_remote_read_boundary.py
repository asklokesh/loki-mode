"""Remote auth-off reads fail closed at one dashboard namespace boundary.

The old boundary enumerated sensitive prefixes. That shape leaked every read
family added later: context, notifications, agents, usage, PRD observations,
v2 tenants and v2 audit all reached their handlers from a routable address
when auth was off. The tests below enumerate the live route tables and drive
the app as raw ASGI without lifespan startup, so a handler cannot hide a
missing boundary behind database, filesystem or startup failures. The one
loopback v2 reachability probe substitutes a sentinel database dependency: it
proves the request crossed the boundary and reached the intended handler
without depending on a developer's durable database or lifespan side effects.
"""

from __future__ import annotations

import asyncio
import importlib
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

    def walk(routes):
        """Yield declared routes across eager and lazy FastAPI versions.

        FastAPI <= 0.128 copies included routes into ``app.routes``. FastAPI
        >= 0.141 stores one lazy ``_IncludedRouter`` whose ``original_router``
        owns the declarations. A set at the caller deduplicates the eager
        representation while this recursion makes the lazy one visible.
        """
        for route in routes:
            yield route
            original_router = getattr(route, "original_router", None)
            original_routes = getattr(original_router, "routes", None)
            if original_routes:
                yield from walk(original_routes)

    for route in walk(server.app.routes):
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
        cls._auth_env = {
            name: os.environ.get(name)
            for name in (
                "LOKI_ENTERPRISE_AUTH",
                "LOKI_OIDC_ISSUER",
                "LOKI_OIDC_CLIENT_ID",
            )
        }
        os.environ.pop("LOKI_ENTERPRISE_AUTH", None)
        os.environ.pop("LOKI_OIDC_ISSUER", None)
        os.environ.pop("LOKI_OIDC_CLIENT_ID", None)

        # Import explicitly, then reload the server under the controlled env.
        # Other full-suite files deliberately evict/re-import dashboard.server;
        # a package attribute can therefore point at an app created under a
        # sibling test's environment. Reloading creates the exact app and route
        # table this boundary test intends to exercise.
        auth = importlib.import_module("dashboard.auth")
        server = importlib.reload(importlib.import_module("dashboard.server"))

        cls.auth, cls.server = auth, server
        cls._enterprise = auth.ENTERPRISE_AUTH_ENABLED
        cls._oidc = auth.OIDC_ENABLED
        auth.ENTERPRISE_AUTH_ENABLED = False
        auth.OIDC_ENABLED = False

    @classmethod
    def tearDownClass(cls):
        cls.auth.ENTERPRISE_AUTH_ENABLED = cls._enterprise
        cls.auth.OIDC_ENABLED = cls._oidc
        for name, value in cls._auth_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

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
            len(inventory), 190,
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
        for path in ("/api/context", "/api/usage"):
            status, _body = asyncio.run(
                _raw_get(self.server.app, path, host="127.0.0.1")
            )
            self.assertNotEqual(status, 403, path)

        # /api/v2/tenants is database-backed. Raw ASGI deliberately does not
        # run lifespan, so executing its real database dependency makes this
        # test depend on whether ~/.loki/dashboard.db happens to have tables.
        # Substitute only the DB session and raise from execute(): reaching the
        # sentinel proves the lazy/eager router matched the v2 handler and that
        # the loopback request crossed the boundary. A missing route returns
        # 404; an incorrectly gated request returns 403; neither can raise it.
        from dashboard import api_v2  # noqa: PLC0415

        class V2HandlerReached(Exception):
            pass

        class NoDurableDatabase:
            async def execute(self, *_args, **_kwargs):
                raise V2HandlerReached

        async def override_get_db():
            yield NoDurableDatabase()

        self.server.app.dependency_overrides[api_v2.get_db] = override_get_db
        try:
            with self.assertRaises(V2HandlerReached):
                asyncio.run(
                    _raw_get(
                        self.server.app,
                        "/api/v2/tenants",
                        host="127.0.0.1",
                    )
                )
        finally:
            self.server.app.dependency_overrides.pop(api_v2.get_db, None)


if __name__ == "__main__":
    unittest.main()
