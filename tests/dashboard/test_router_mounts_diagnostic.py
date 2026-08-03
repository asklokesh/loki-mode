"""Why are api_v2 AND api_operator both absent from app.routes on CI?

THIS IS A DIAGNOSTIC, and it asserts a real contract while it reports.

The facts that do not fit any theory tried so far:
  - CI reports 156 routes on dashboard.server.app, including routes defined
    at line ~400 and routes defined AFTER the mount block (/lab).
  - It reports ZERO /api/v2/* and ZERO /api/operator/* routes.
  - api_v2 is mounted at server.py:1011 with NO try/except at all, so an
    exception there would abort the module and there would be no routes.
  - No "operator API could not be imported" line appears in the CI log, so
    the operator mount's except-ImportError branch never fired.

Locally the same file yields 24 v2 routes and 4 operator routes.

Because api_v2 has no error handling, "v2 is missing but the module finished"
is the observation that constrains everything: it means the mount statements
did not run in the module object the test is looking at, which points at a
module identity problem rather than an import failure.

The assertion below is the contract either way: if the dashboard app does not
carry its own v2 routes, the dashboard is broken regardless of the cause, and
the failure message carries the evidence needed to finish the diagnosis.
"""

import pathlib
import sys
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


class TheMountRegionActuallyRuns(unittest.TestCase):

    def test_v2_and_operator_routers_are_both_mounted(self):
        import importlib
        try:
            server = importlib.import_module("dashboard.server")
        except Exception as exc:  # pragma: no cover
            self.skipTest("dashboard.server not importable: %s" % exc)

        paths = [getattr(r, "path", "") for r in server.app.routes]
        v2 = sorted({p for p in paths if p.startswith("/api/v2")})
        op = sorted({p for p in paths if p.startswith("/api/operator")})

        # Evidence for whoever reads the failure, gathered before asserting.
        detail = [
            "module file: %s" % getattr(server, "__file__", "?"),
            "module name: %s" % getattr(server, "__name__", "?"),
            "total routes: %d" % len(paths),
            "v2 routes: %d" % len(v2),
            "operator routes: %d" % len(op),
            "dashboard.api_v2 in sys.modules: %s"
            % ("dashboard.api_v2" in sys.modules),
            "dashboard.api_operator in sys.modules: %s"
            % ("dashboard.api_operator" in sys.modules),
            "has /lab (defined AFTER the mounts): %s" % ("/lab" in paths),
        ]
        # Whether the routers themselves can be imported and how many routes
        # they carry, independent of whatever server.py did with them.
        for mod in ("dashboard.api_v2", "dashboard.api_operator"):
            try:
                m = importlib.import_module(mod)
                detail.append("%s imports OK, router routes: %d"
                              % (mod, len(m.router.routes)))
            except Exception as exc:
                detail.append("%s IMPORT FAILED: %s: %s"
                              % (mod, type(exc).__name__, exc))

        self.assertTrue(
            v2,
            "dashboard.server.app carries NO /api/v2 routes. api_v2 is mounted "
            "with no try/except, so this cannot be a swallowed import error.\n"
            + "\n".join("  " + d for d in detail))
        self.assertTrue(
            op,
            "dashboard.server.app carries no /api/operator routes.\n"
            + "\n".join("  " + d for d in detail))


if __name__ == "__main__":
    unittest.main()
