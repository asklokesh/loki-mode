"""
tests/dashboard/test_get_logs_bounds.py
Bounds validation for GET /api/logs (dashboard/server.py:get_logs).

Regression guard for an unbounded `lines` query param. Before the fix, `lines`
was a bare `int = 100` that flowed unchecked to `_read_log_tail` as the slice
index `split("\n")[-n:]`. Negative values inverted the "last N lines" contract
(lines=-5 -> `[5:]` returned the whole buffer minus the FIRST 5), and lines=0
(`[0:]`) returned everything. The fix uses
`Query(default=100, ge=1, le=10000)`, matching the file's convention (see
get_app_runner_logs at server.py:8147), so FastAPI rejects out-of-range values
with a clean 422 instead of silently returning a wrong slice.

Hermetic: uses the _ForceLokiDir context manager (pins _get_loki_dir to a tmp
path) and FastAPI TestClient. No module reloads, no global state mutation.
Auth is anonymous by default (get_current_token returns None when neither
LOKI_ENTERPRISE_AUTH nor OIDC is configured).
"""

from __future__ import annotations

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


class GetLogsBoundsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-getlogs-bounds-")
        self.log_dir = Path(self.tmp) / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)
        # 100 distinct, unambiguous log lines (plain text, no timestamp prefix,
        # so each parses to exactly one entry with message == the raw line).
        self.total = 100
        (self.log_dir / "session.log").write_text(
            "\n".join(f"logline-{i}" for i in range(self.total))
        )

    def _client(self):
        from dashboard.server import app
        from fastapi.testclient import TestClient
        return TestClient(app, raise_server_exceptions=False)

    def test_negative_lines_rejected_with_422(self):
        # Pre-fix this returned 200 with a wrong slice ([5:] -> buffer minus
        # first 5 lines), inverting the "last N" contract. Must now be 422.
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/logs?lines=-5")
        self.assertEqual(resp.status_code, 422, resp.text)

    def test_zero_lines_rejected_with_422(self):
        # Pre-fix lines=0 -> [0:] returned the ENTIRE buffer. Must now be 422.
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/logs?lines=0")
        self.assertEqual(resp.status_code, 422, resp.text)

    def test_too_large_lines_rejected_with_422(self):
        # Above le=10000 upper bound -> 422.
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/logs?lines=10001")
        self.assertEqual(resp.status_code, 422, resp.text)

    def test_in_range_lines_returns_200_and_caps_count(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/logs?lines=50")
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertIsInstance(body, list)
        # Non-vacuity: the fixture has 100 lines, so a vacuous (empty) response
        # would silently pass the cap assertion. Require real entries AND the
        # cap, and confirm we got the TAIL (last 50), not the head.
        self.assertGreater(len(body), 0, "expected non-empty log entries")
        self.assertLessEqual(len(body), 50, "lines=50 must return at most 50 entries")
        messages = [e["message"] for e in body]
        self.assertIn("logline-99", messages, "tail must include the last line")
        self.assertNotIn("logline-0", messages, "lines=50 must not include the first line")


if __name__ == "__main__":
    unittest.main()
