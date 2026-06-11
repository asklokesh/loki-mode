"""
tests/dashboard/test_claude_session_status.py
v7.34.0 Phase 1: the /api/status response surfaces claude_session_id read from
.loki/state/claude-session.json (the correlation-only stamp run.sh writes at
run-start). A user reads this to `claude --resume <uuid>`.

Uses FastAPI's TestClient with raise_server_exceptions=False and the
_ForceLokiDir context manager (same pattern as test_phase1_endpoints.py), so no
real server is started and no port is bound.
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


class ClaudeSessionStatusTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-claude-session-")
        (Path(self.tmp) / "state").mkdir(parents=True, exist_ok=True)

    def _client(self):
        from dashboard.server import app
        from fastapi.testclient import TestClient
        return TestClient(app, raise_server_exceptions=False)

    def test_status_surfaces_claude_session_id_when_present(self):
        uuid = "1c92381f-8899-58e5-b77f-d8f822f158fb"
        payload = {
            "run_id": "run-20260611-123-456",
            "claude_session_uuid": uuid,
            "mode": "stamp",
            "created_at": "2026-06-11T00:00:00Z",
        }
        path = Path(self.tmp) / "state" / "claude-session.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f)

        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/status")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn("claude_session_id", body)
        self.assertEqual(body["claude_session_id"], uuid)

    def test_status_claude_session_id_empty_when_file_absent(self):
        # No claude-session.json written -- the field must default to "" and must
        # not raise (run predates the field, or a non-claude provider).
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/status")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn("claude_session_id", body)
        self.assertEqual(body["claude_session_id"], "")

    def test_status_claude_session_id_empty_on_malformed_json(self):
        # Corrupt file must degrade to "" (best-effort read), not 500.
        path = Path(self.tmp) / "state" / "claude-session.json"
        path.write_text("{ this is not json", encoding="utf-8")
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/status")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["claude_session_id"], "")

    def test_status_claude_session_id_empty_on_valid_non_object_json(self):
        # Hunter LOW finding: a syntactically-valid non-object (array/string/
        # number) must not raise AttributeError -> 500; degrade to "".
        path = Path(self.tmp) / "state" / "claude-session.json"
        # non-object JSON AND a non-STRING value (council R2: a non-str value
        # would fail StatusResponse str validation -> 500) must both degrade.
        payloads = (
            "[1,2,3]", '"x"', "42", "null",
            '{"claude_session_uuid": 123}',
            '{"claude_session_uuid": {"x": 1}}',
            '{"claude_session_uuid": [1, 2]}',
            '{"claude_session_uuid": true}',
        )
        for payload in payloads:
            path.write_text(payload, encoding="utf-8")
            with _ForceLokiDir(self.tmp):
                resp = self._client().get("/api/status")
            self.assertEqual(resp.status_code, 200, f"500 on payload {payload!r}")
            self.assertEqual(resp.json()["claude_session_id"], "")


if __name__ == "__main__":
    unittest.main()
