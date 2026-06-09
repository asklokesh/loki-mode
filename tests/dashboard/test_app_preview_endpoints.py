"""
tests/dashboard/test_app_preview_endpoints.py
Live App Preview surfacing -- HTTP tests for the app-runner errors endpoint
and the redaction applied to the app-runner logs endpoint.

Covers:
    - GET /api/app-runner/errors   (redacted tail + status/crash_count)
    - GET /api/app-runner/logs     (now redacted)

Uses FastAPI TestClient with raise_server_exceptions=False and the
_ForceLokiDir context manager pattern from the other dashboard tests.
"""

from __future__ import annotations

import json
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


class AppPreviewEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-apppreview-dash-")
        self.app_dir = Path(self.tmp) / "app-runner"
        self.app_dir.mkdir(parents=True, exist_ok=True)

    def _client(self):
        from dashboard.server import app
        from fastapi.testclient import TestClient
        return TestClient(app, raise_server_exceptions=False)

    def _write_state(self, status="running", crash_count=0):
        (self.app_dir / "state.json").write_text(json.dumps({
            "main_pid": 123,
            "port": 5173,
            "url": "http://localhost:5173",
            "status": status,
            "crash_count": crash_count,
        }))

    def _write_log(self, text):
        (self.app_dir / "app.log").write_text(text)

    # ---------- /api/app-runner/errors --------------------------------------

    def test_errors_not_initialized_when_no_state(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/app-runner/errors")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "not_initialized")
        self.assertEqual(body["lines"], [])
        self.assertTrue(body["redacted"])

    def test_errors_returns_status_and_crash_count(self):
        self._write_state(status="crashed", crash_count=2)
        self._write_log("TypeError: boom\nat handler\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/app-runner/errors")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "crashed")
        self.assertEqual(body["crash_count"], 2)
        self.assertTrue(any("TypeError" in ln for ln in body["lines"]))

    def test_errors_tail_respects_lines_param(self):
        self._write_state(status="crashed", crash_count=1)
        self._write_log("\n".join(f"line {i}" for i in range(100)))
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/app-runner/errors?lines=10")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertLessEqual(len(body["lines"]), 10)
        self.assertIn("line 99", body["lines"][-1])

    def test_errors_redacts_secrets_in_log(self):
        self._write_state(status="crashed", crash_count=1)
        self._write_log("DATABASE_URL=postgres://user:supersecret@host/db\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/app-runner/errors")
        self.assertEqual(resp.status_code, 200)
        joined = "\n".join(resp.json()["lines"])
        # The secret value must not appear verbatim; redaction may or may not be
        # available in CI, but the endpoint must never return the raw secret.
        self.assertNotIn("supersecret", joined)

    # ---------- /api/app-runner/logs (now redacted) -------------------------

    def test_logs_redacts_secrets(self):
        self._write_log("API_KEY=sk-livesecretvalue123\nnormal line\n")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/app-runner/logs")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        joined = "\n".join(body["lines"])
        self.assertNotIn("sk-livesecretvalue123", joined)
        self.assertTrue(body.get("redacted"))

    def test_logs_empty_when_no_file(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/app-runner/logs")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["lines"], [])


if __name__ == "__main__":
    unittest.main()
