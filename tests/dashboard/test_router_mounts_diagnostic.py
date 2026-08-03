"""Both mounted routers must be REACHABLE, on every FastAPI version.

THE INVESTIGATION THIS FILE CLOSES. The mount assertions failed on Linux CI
across Python 3.10-3.13 while passing on macOS. The evidence looked alarming:
189 routes on CI versus 215 on macOS, a deficit of EXACTLY 28, which is
precisely the 24 api_v2 routes plus the 4 api_operator routes. Both routers
imported cleanly and reported 24 and 4 routes on their own objects.

THE CAUSE WAS NOT OUR CODE. FastAPI changed how include_router stores routes:

    <= 0.128   each route is copied into app.routes
    >= 0.141   ONE lazy _IncludedRouter wrapper is appended, and the real
               routes are resolved at request time

CI installs the latest fastapi (0.141.1); this machine had 0.128.0 pinned. So
`app.include_router(router_with_24_routes)` added exactly 1 entry to
app.routes, and every assertion that walked that list saw zero v2 and zero
operator paths.

Every one of those routes was mounted and serving the whole time. Verified in
a Linux container on 0.141.1: GET /api/operator/tests returns 200, and
/api/v2/tenants reaches its handler (it fails later on a database path, which
is a different matter entirely).

THE LESSON, and it is the reason this file stays. app.routes is an
IMPLEMENTATION DETAIL of the framework. Asserting on it made a working
dashboard look broken for four CI rounds and nearly justified quarantining a
real assertion to manufacture a green build. Route tests here assert
REACHABILITY by routing a request, which is both version-independent and the
only property a user has.
"""

import pathlib
import sys
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


class BothRoutersAreReachable(unittest.TestCase):

    def test_v2_and_operator_routes_both_reach_a_handler(self):
        """A 404 is the only failure that matters: nothing mounted there."""
        import importlib
        import os
        try:
            server = importlib.import_module("dashboard.server")
            from starlette.testclient import TestClient
        except Exception as exc:  # pragma: no cover
            self.skipTest("dashboard.server/starlette not importable: %s" % exc)

        os.environ["LOKI_ENTERPRISE_AUTH"] = "false"
        try:
            from dashboard import auth as _auth
            _auth.ENTERPRISE_AUTH_ENABLED = False
            _auth.OIDC_ENABLED = False
        except Exception:
            pass

        client = TestClient(server.app, raise_server_exceptions=False)
        for path in ("/api/operator/tests", "/api/v2/tenants"):
            r = client.get(path)
            self.assertNotEqual(
                r.status_code, 404,
                "%s returned 404 on the real app. Note this test asserts "
                "REACHABILITY, not membership of app.routes: FastAPI >= 0.141 "
                "stores an included router as one lazy wrapper rather than "
                "copying its routes in, so an app.routes check reports a "
                "working mount as missing." % path)

    def test_the_route_tests_do_not_assert_on_app_routes(self):
        """Pins the lesson so it cannot silently regress.

        Walking app.routes is what made a working dashboard look broken for
        four CI rounds. Any route test that goes back to it will pass on an
        older FastAPI and fail on a newer one, which is the worst combination:
        green locally, red on CI, for a defect that does not exist.
        """
        import ast as _ast
        import pathlib as _p
        here = _p.Path(__file__).parent
        # Every file that asserts a route is MOUNTED. The original version
        # named two, and a THIRD (test_api_phases.py, arriving later from a
        # fleet worktree) reintroduced the banned pattern and took all four CI
        # Python jobs red hours after the fix had already landed elsewhere. A
        # manual allowlist only protects the files someone remembered, so this
        # is derived: any dashboard test whose text claims a route "is not
        # mounted" or "is mounted" is making a mount assertion.
        #
        # DELIBERATELY NOT every file that touches app.routes. Four others
        # (test_all_data_gets_scoped, test_fleet_observability,
        # test_fleet_retry, test_memory_read_scope_auth) enumerate routes to
        # audit AUTH SCOPE, not to prove a mount, and they pass on 0.141.1 --
        # the lazy wrapper still carries what they inspect. Banning the call
        # outright would break four working tests to fix a bug they do not
        # have.
        _mount_assertors = [
            f.name for f in here.glob("test_*.py")
            if f.name != _p.Path(__file__).name
            and "is not mounted" in f.read_text(errors="replace")
        ]
        self.assertTrue(_mount_assertors,
                        "found no mount-asserting test files; the guard below "
                        "would be vacuous")
        for name in sorted(_mount_assertors):
            src = (here / name).read_text(encoding="utf-8", errors="replace")
            tree = _ast.parse(src)
            # Strip every docstring before searching. A docstring may quote the
            # banned pattern to explain WHY it is banned -- including this
            # file's own -- and a plain substring search cannot tell an
            # explanation from a violation.
            for node in _ast.walk(tree):
                if isinstance(node, (_ast.Module, _ast.ClassDef,
                                     _ast.FunctionDef, _ast.AsyncFunctionDef)):
                    body = getattr(node, "body", [])
                    if (body and isinstance(body[0], _ast.Expr)
                            and isinstance(body[0].value, _ast.Constant)
                            and isinstance(body[0].value.value, str)):
                        body[0].value.value = ""
            code = _ast.unparse(tree)
            for banned in ("server.app.routes", "self.server.app.routes"):
                self.assertNotIn(
                    banned, code,
                    "%s enumerates app.routes in EXECUTABLE code (%r). Assert "
                    "reachability by routing a request: FastAPI >= 0.141 "
                    "stores an included router as one lazy wrapper, so "
                    "enumeration reports a working mount as missing."
                    % (name, banned))


if __name__ == "__main__":
    unittest.main()
