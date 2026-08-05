"""The operator routes must be MOUNTED, and must not flatten the envelope.

WHAT THIS GUARDS. Four filesystem readers (api_runs, api_tests, api_evidence,
api_releases) were written with a strict honesty contract and then left as
libraries with no APIRouter -- reachable by the test suite and by nobody else.
dashboard/api_operator.py exposes them. The failure mode this suite exists for
is not "the reader is wrong" (each reader has its own tests); it is:

  1. the router silently stops being mounted on the real app, so every path
     404s while every reader test stays green, and
  2. a later "cleanup" unwraps an envelope into a bare list for convenience,
     discarding reason/source/verdict -- at which point an unreadable
     workspace and an empty one become indistinguishable to the UI.

Both are invisible to every other test in this repo.

THE ROUTES ARE EXERCISED THROUGH STARLETTE against a real temporary workspace,
not mocked. A mocked reader would prove only that the mock returns what the
test told it to; what needs proving is that a genuine .loki tree reaches a
genuine HTTP response with its contract intact.
"""

import json
import os
import pathlib
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _client_and_workspace():
    """A live app carrying only the operator router, over a real .loki tree.

    AUTH STATE IS PINNED OFF HERE, deliberately. These tests are about the
    ENVELOPE contract, not about authentication, and they must not inherit
    whichever auth mode a previously-run test left behind.
    tests/dashboard/test_tenant_create_admin_only.py sets
    LOKI_ENTERPRISE_AUTH=true in setUpClass and never unsets the environment
    variable (it restores the auth module flags, but not the env). Running
    after it, every request here returned 401 instead of 200 -- which is how
    these tests went red on all four CI Python versions while passing in
    isolation locally.

    Pinning it here rather than "fixing" the other test keeps each file
    self-contained: a test that depends on ambient auth state is fragile no
    matter which file set it.
    """
    from fastapi import FastAPI
    from starlette.testclient import TestClient

    os.environ["LOKI_ENTERPRISE_AUTH"] = "false"
    try:
        from dashboard import auth as _auth
        _auth.ENTERPRISE_AUTH_ENABLED = False
        _auth.OIDC_ENABLED = False
    except Exception:
        pass

    d = tempfile.mkdtemp()
    loki = os.path.join(d, ".loki")
    os.makedirs(os.path.join(loki, "metrics"), exist_ok=True)
    os.makedirs(os.path.join(loki, "state"), exist_ok=True)
    with open(os.path.join(loki, "state", "trust-run-id"), "w") as fh:
        fh.write("run-op-1\n")
    with open(os.path.join(loki, "metrics", "trust-events.jsonl"), "w") as fh:
        fh.write(json.dumps({"run_id": "run-op-1",
                             "ts": time.time(),
                             "event": "iteration_complete"}) + "\n")
    os.environ["LOKI_DIR"] = loki

    from dashboard.api_operator import router
    app = FastAPI()
    app.include_router(router)
    return TestClient(app), loki


class TheRouterIsMountedOnTheRealDashboardApp(unittest.TestCase):
    """Assertion 1. Importing the module proves nothing; the app's route
    table is what serves users."""

    def test_operator_paths_are_reachable_on_the_real_app(self):
        """Asserted by ROUTING A REQUEST, not by walking app.routes.

        THE BUG THIS TEST ITSELF HAD. It originally asserted that each path
        appeared in `[r.path for r in server.app.routes]`. That is an
        IMPLEMENTATION DETAIL of FastAPI, and FastAPI changed it: up to 0.128
        include_router copied each route into app.routes, while from 0.141 it
        appends ONE lazy `_IncludedRouter` wrapper and resolves the real routes
        at request time.

        So on CI (fastapi 0.141.1) app.routes showed 189 entries with zero
        /api/v2 and zero /api/operator, while macOS (0.128.0) showed 215 with
        all 28 -- a deficit of exactly the 24 v2 + 4 operator routes. Every one
        of those routes was mounted and serving correctly the whole time; only
        the enumeration changed. Four CI rounds were spent treating a working
        dashboard as broken.

        Routing a real request is version-independent and is also the property
        anyone actually cares about: not "is this row in a list" but "does a
        caller reach the handler".
        """
        import importlib
        try:
            server = importlib.import_module("dashboard.server")
        except Exception as exc:  # pragma: no cover - import env varies
            self.skipTest("dashboard.server not importable here: %s" % exc)
        try:
            from starlette.testclient import TestClient
        except Exception as exc:  # pragma: no cover
            self.skipTest("starlette unavailable: %s" % exc)

        os.environ["LOKI_ENTERPRISE_AUTH"] = "false"
        try:
            from dashboard import auth as _auth
            _auth.ENTERPRISE_AUTH_ENABLED = False
            _auth.OIDC_ENABLED = False
        except Exception:
            pass

        client = TestClient(server.app, raise_server_exceptions=False)
        for path in ("/api/operator/runs/some-run",
                     "/api/operator/tests",
                     "/api/operator/receipts",
                     "/api/operator/releases"):
            r = client.get(path)
            # 404 is the failure that matters: it means nothing is mounted
            # there. Any other status means a handler ran.
            self.assertNotEqual(
                r.status_code, 404,
                "%s returned 404 on the real dashboard app; the operator "
                "router is not mounted, so the reader behind it is "
                "unreachable by any user" % path)


class TheEnvelopeSurvivesTheRoundTrip(unittest.TestCase):
    """Assertion 2. reason/source are what separate 'nothing here' from
    'could not read', and they are exactly what a convenience refactor drops."""

    def setUp(self):
        try:
            self.client, self.loki = _client_and_workspace()
        except Exception as exc:  # pragma: no cover
            self.skipTest("starlette/fastapi unavailable: %s" % exc)

    def test_run_detail_keeps_source_and_reason(self):
        r = self.client.get("/api/operator/runs/run-op-1")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIsInstance(body, dict,
                              "run detail was flattened out of its envelope")
        for key in ("run", "iterations", "source", "freshness_s", "reason"):
            self.assertIn(key, body, "envelope lost %r" % key)
        self.assertTrue(body["source"],
                        "the response names no sources, so no row can be "
                        "audited back to the file it came from")

    def test_tests_route_keeps_its_envelope(self):
        r = self.client.get("/api/operator/tests")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIsInstance(body, dict)
        for key in ("items", "source", "reason"):
            self.assertIn(key, body, "envelope lost %r" % key)

    def test_receipts_route_carries_a_verdict_not_a_bare_list(self):
        """The specific bug this caught during development.

        list_receipts returns a bare list; an empty tree and an unreadable
        tree both arrive as []. receipts_report carries an explicit verdict,
        where an empty walk is EMPTY -- its own state, not a vacuous pass.
        """
        r = self.client.get("/api/operator/receipts")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIsInstance(
            body, dict,
            "receipts returned a bare list; an empty workspace and an "
            "unreadable one are now indistinguishable to the caller")
        for key in ("verdict", "source", "error", "receipts", "counts"):
            self.assertIn(key, body, "receipts report lost %r" % key)
        self.assertTrue(
            body.get("verdict"),
            "an empty walk produced no verdict; 'we found nothing wrong' is "
            "not a claim anyone may make about a tree they never opened")

    def test_releases_reports_unavailable_comparison_as_none_not_false(self):
        """version_is_ahead must be None when it cannot be computed.

        False would assert 'VERSION is not ahead of the newest tag', which is
        a claim the route has no basis for on a checkout with no tags.
        """
        r = self.client.get("/api/operator/releases?limit=3")
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertIn("version_is_ahead", body)
        if not body.get("releases"):
            self.assertIsNone(
                body.get("version_is_ahead"),
                "no tags were readable, yet version_is_ahead is %r; that "
                "asserts a comparison that was never made"
                % body.get("version_is_ahead"))
            self.assertTrue(body.get("reason"),
                            "an empty release list carried no reason")


class AReaderFailureIsNotAnEmptySuccess(unittest.TestCase):
    """The honesty rule at the transport layer.

    A reader that raises must surface as 503. Returning an empty 200 would
    render in the UI as a healthy workspace with nothing in it, which is the
    failure this codebase treats as worse than an error.
    """

    def setUp(self):
        try:
            self.client, self.loki = _client_and_workspace()
        except Exception as exc:  # pragma: no cover
            self.skipTest("starlette/fastapi unavailable: %s" % exc)

    def test_a_raising_reader_yields_503_not_200(self):
        from dashboard import api_operator

        real = api_operator._loki_dir

        def _boom():
            raise OSError("disk gone")

        api_operator._loki_dir = _boom
        try:
            r = self.client.get("/api/operator/tests")
        finally:
            api_operator._loki_dir = real

        self.assertEqual(
            r.status_code, 503,
            "a reader that raised returned %d; an empty 200 renders as a "
            "healthy empty workspace and hides the fault"% r.status_code)
        self.assertIn("disk gone", json.dumps(r.json()),
                      "the 503 does not say what actually failed")


if __name__ == "__main__":
    unittest.main()
