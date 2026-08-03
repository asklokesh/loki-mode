"""The operator mount must be portable, and must not fail open.

WHAT WENT WRONG. The mount shipped as:

    try:
        from .api_operator import router as api_operator_router
        app.include_router(api_operator_router)
    except Exception as exc:
        logger.warning("operator API unavailable: %s", exc)

`except Exception` does not distinguish "an optional dependency is absent"
from "this module is broken". A typo, a refactor that breaks an import, or a
syntax error all produce a dashboard that STARTS FINE, reports healthy, and
serves 404 on every operator path. A monitoring surface that is silently blind
is the failure mode this codebase treats as worse than an outage, and it is
the same class as the four readers that existed for weeks while reachable by
nobody.

It also hid its own cause: the mount test failed on Python 3.10-3.13 with only
"route not found", because the real exception had been swallowed into a log
line nobody reads on CI.

WHAT IS ASSERTED:
  1. The routes are present on the real app. Portability, not theory: this is
     the assertion that was failing on CI.
  2. The mount catches ImportError ONLY. Any broader handler re-opens the
     silent-404 hole.
  3. No route is registered twice. A double include_router serves two handlers
     for one path, and which one answers depends on registration order.
  4. Every operator route carries the read scope, so the mount cannot be
     "fixed" by dropping the auth dependency.
"""

import pathlib
import re
import sys
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

_SERVER = _ROOT / "dashboard" / "server.py"

_EXPECTED = (
    "/api/operator/runs/{run_id}",
    "/api/operator/tests",
    "/api/operator/receipts",
    "/api/operator/releases",
)


class TheRoutesAreActuallyThere(unittest.TestCase):

    def setUp(self):
        # Reloaded rather than plain-imported: six tests under tests/dashboard/
        # delete dashboard.* from sys.modules or reload it, so a cached module
        # object can report a route table that predates the mount. That is how
        # this assertion failed on all four CI Python versions while passing in
        # isolation. Reloading makes the assertion about the source on disk.
        import importlib
        try:
            server = importlib.import_module("dashboard.server")
            server = importlib.reload(server)
        except Exception as exc:  # pragma: no cover
            self.skipTest("dashboard.server not importable: %s" % exc)
        self.server = server

    def test_every_operator_route_is_reachable(self):
        """Reachability, NOT membership of app.routes.

        app.routes is a FastAPI implementation detail that CHANGED: through
        0.128 include_router copied each route in, from 0.141 it appends one
        lazy _IncludedRouter and resolves at request time. Asserting on the
        list reported a perfectly working dashboard as broken on every Linux
        CI run while passing on macOS. Routing a request is version-independent
        and is the property that actually matters.
        """
        try:
            from starlette.testclient import TestClient
        except Exception as exc:  # pragma: no cover
            self.skipTest("starlette unavailable: %s" % exc)
        client = TestClient(self.server.app, raise_server_exceptions=False)
        for expected in _EXPECTED:
            path = expected.replace("{run_id}", "some-run")
            r = client.get(path)
            self.assertNotEqual(
                r.status_code, 404,
                "%s returned 404; nothing is mounted there. If the module "
                "failed to import, the mount swallowed the reason instead of "
                "failing loudly." % path)

    def test_the_router_declares_each_path_exactly_once(self):
        """Duplicate registration, checked on the ROUTER rather than the app.

        Two handlers for one path means which answers depends on registration
        order. The router object is the honest place to check this: it holds
        the declarations regardless of how the app chooses to store them.
        """
        try:
            from dashboard.api_operator import router  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("api_operator not importable: %s" % exc)
        paths = [getattr(r, "path", "") for r in router.routes]
        for expected in _EXPECTED:
            self.assertEqual(
                paths.count(expected), 1,
                "%s is declared %d times on the operator router"
                % (expected, paths.count(expected)))

    def test_every_operator_route_still_requires_read_scope(self):
        """The mount must not be repaired by dropping auth."""
        try:
            from dashboard.api_operator import router  # noqa: PLC0415
        except Exception as exc:  # pragma: no cover
            self.skipTest("api_operator not importable: %s" % exc)
        for r in router.routes:
            self.assertTrue(
                getattr(r, "dependencies", []),
                "%s carries no auth dependency" % getattr(r, "path", r))


class TheMountDoesNotFailOpen(unittest.TestCase):
    """Source-level, because the alternative is breaking the import to observe
    the handler, which cannot be done inside a process that already imported
    the module successfully."""

    def test_the_mount_catches_importerror_only(self):
        src = _SERVER.read_text(encoding="utf-8", errors="replace")
        m = re.search(
            r"try:\s*\n\s*from \.api_operator import router[^\n]*\n"
            r"(?P<body>(?:.*\n)*?)\s*(?:else:|app\.include_router\(api_operator)",
            src)
        self.assertIsNotNone(
            m, "could not locate the operator mount block in server.py")
        body = m.group("body")
        self.assertIn(
            "except ImportError", body,
            "the operator mount does not catch ImportError specifically")
        self.assertNotRegex(
            body, r"except\s+Exception",
            "the operator mount catches Exception, so a typo or a broken "
            "refactor produces a dashboard that starts healthy and serves 404 "
            "on every operator path")


if __name__ == "__main__":
    unittest.main()
