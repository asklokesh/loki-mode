"""
tests/dashboard/test_session_model_endpoint.py

Mid-flight model switching endpoints (dashboard/server.py):
    - GET  /api/session/model   reports override + default + effective
    - POST /api/session/model   writes/clears .loki/state/model-override

Uses FastAPI's TestClient with raise_server_exceptions=False and the
_ForceLokiDir context manager (same pattern as test_phase1_endpoints.py), so
no real server is started, no port is bound, and no real model is invoked. The
override file written under the tmp .loki/state/ is the same project-scoped path
the run.sh reader consumes.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path


class _ForceLokiDir:
    """Context manager that pins dashboard.server._get_loki_dir() to a tmp path."""

    def __init__(self, tmpdir: str):
        self.tmp = tmpdir
        self._orig = None

    def __enter__(self):
        from dashboard import server as _server
        self._orig = _server._get_loki_dir
        _server._get_loki_dir = lambda: Path(self.tmp)
        return self

    def __exit__(self, exc_type, exc, tb):
        from dashboard import server as _server
        if self._orig is not None:
            _server._get_loki_dir = self._orig


class SessionModelEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-session-model-")
        (Path(self.tmp) / "state").mkdir(parents=True, exist_ok=True)
        self._override = Path(self.tmp) / "state" / "model-override"
        # Snapshot + clear env that changes endpoint behavior so each test is
        # isolated (LOKI_MAX_TIER clamp, LOKI_SESSION_MODEL default, enterprise
        # auth scope). Restored in tearDown.
        self._saved_env = {
            k: os.environ.get(k)
            for k in ("LOKI_MAX_TIER", "LOKI_SESSION_MODEL", "LOKI_ENTERPRISE_AUTH")
        }
        for k in self._saved_env:
            os.environ.pop(k, None)

    def tearDown(self):
        import shutil
        for k, v in self._saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _client(self):
        from dashboard.server import app
        from fastapi.testclient import TestClient
        return TestClient(app, raise_server_exceptions=False)

    def test_get_reports_no_override_by_default(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIsNone(body["override"])
        self.assertIn(body["default"], ("haiku", "sonnet", "opus", "fable"))
        self.assertEqual(body["effective"], body["default"])
        self.assertEqual(body["allowed"], ["haiku", "sonnet", "opus", "fable"])

    def test_post_fable_writes_override_file(self):
        # No LOKI_MAX_TIER (cleared in setUp): effective is the requested model
        # itself (the field is now the model the next iteration will use, after
        # any ceiling clamp).
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "fable"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["model"], "fable")
        self.assertEqual(body["effective"], "fable")
        self.assertFalse(body["clamped"])
        self.assertTrue(self._override.is_file())
        self.assertEqual(self._override.read_text().strip(), "fable")

    def test_get_reflects_written_override(self):
        self._override.write_text("opus\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        body = resp.json()
        self.assertEqual(body["override"], "opus")
        self.assertEqual(body["effective"], "opus")

    def test_post_clears_override_with_null(self):
        self._override.write_text("fable\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": None})
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.json()["model"])
        self.assertFalse(self._override.exists())

    def test_post_clears_override_with_empty_string(self):
        self._override.write_text("fable\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": ""})
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(self._override.exists())

    def test_post_rejects_arbitrary_string(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "rm -rf /"})
        self.assertEqual(resp.status_code, 400)
        # File must NOT be written for a rejected value.
        self.assertFalse(self._override.exists())

    def test_post_rejects_unknown_alias(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "gpt-4"})
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(self._override.exists())

    def test_post_normalizes_case_and_whitespace(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "  FABLE  "})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self._override.read_text().strip(), "fable")

    def test_get_ignores_invalid_file_content(self):
        # A manually corrupted override file must not be reported as a valid override.
        self._override.write_text("garbage-value\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertIsNone(resp.json()["override"])

    # --- Model-honesty fixes -------------------------------------------------

    def test_get_clamps_effective_to_max_tier(self):
        # A fable override under LOKI_MAX_TIER=sonnet must report the CLAMPED
        # effective model (opus), not fable, so the dashboard never claims a
        # model the run would clamp down (cost-ceiling agreement).
        self._override.write_text("fable\n")
        os.environ["LOKI_MAX_TIER"] = "sonnet"
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        body = resp.json()
        self.assertEqual(body["override"], "fable")
        self.assertEqual(body["effective"], "opus")

    def test_post_clamps_effective_to_max_tier(self):
        # POST validation response shows the clamped effective model + clamped flag.
        os.environ["LOKI_MAX_TIER"] = "sonnet"
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "fable"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["model"], "fable")
        self.assertEqual(body["effective"], "opus")
        self.assertTrue(body["clamped"])
        # The override file still records the requested alias; the run clamps it.
        self.assertEqual(self._override.read_text().strip(), "fable")

    def test_get_rejects_interior_whitespace_override(self):
        # Normalization parity with run.sh: "fab le" (interior whitespace) is NOT
        # a valid alias, so GET must report no override (run.sh rejects it too).
        self._override.write_text("fab le\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertIsNone(resp.json()["override"])

    def test_post_rejects_interior_whitespace(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "fab le"})
        self.assertEqual(resp.status_code, 400)
        self.assertFalse(self._override.exists())

    def test_get_uppercase_override_normalized(self):
        # Normalization parity: an uppercase file value normalizes to the alias.
        self._override.write_text("FABLE\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/session/model")
        self.assertEqual(resp.json()["override"], "fable")

    def test_get_carries_read_scope_dependency(self):
        # Anonymous-under-enterprise-auth fix: GET /api/session/model now carries
        # require_scope("read"), matching GET /api/status (the conceptually paired
        # read endpoint). Enterprise auth is evaluated at import time, so assert
        # structurally that the route's dependencies include the read scope (the
        # same way GET /api/status is scoped), rather than toggling import-time
        # env. This is the verifiable invariant the finding asks for.
        from dashboard.server import app

        def _scope_deps(path: str, method: str = "GET"):
            for route in app.routes:
                if getattr(route, "path", None) == path and method in getattr(route, "methods", set()):
                    return [
                        getattr(getattr(d, "dependency", None), "__qualname__", "")
                        for d in getattr(route, "dependencies", [])
                    ]
            return None

        session_deps = _scope_deps("/api/session/model", "GET")
        status_deps = _scope_deps("/api/status", "GET")
        self.assertIsNotNone(session_deps, "GET /api/session/model route not found")
        # GET /api/status is the paired scoped read endpoint; the session GET must
        # carry a scope dependency too (no longer anonymous).
        self.assertTrue(
            any("check_scope" in d for d in session_deps),
            f"GET /api/session/model missing require_scope dependency; deps={session_deps}",
        )
        if status_deps is not None:
            self.assertTrue(
                any("check_scope" in d for d in status_deps),
                "GET /api/status expected to be scoped (baseline for parity)",
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
