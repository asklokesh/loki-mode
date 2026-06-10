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

    def tearDown(self):
        import shutil
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
        with _ForceLokiDir(self.tmp):
            resp = self._client().post("/api/session/model", json={"model": "fable"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["model"], "fable")
        self.assertEqual(body["effective"], "next_iteration")
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
