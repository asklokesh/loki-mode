"""
tests/dashboard/test_phase1_endpoints.py
v7.5.3 Phase 1 artifact endpoints -- HTTP tests.

Covers the four read-only inspectors added in dashboard/server.py:
    - GET /api/findings/{iteration}      (server.py:5802)
    - GET /api/learnings                  (server.py:5831)
    - GET /api/escalations                (server.py:5850)
    - GET /api/escalations/{filename}     (server.py:5882)

All tests use FastAPI's TestClient with raise_server_exceptions=False and
mirror the _ForceLokiDir context manager pattern from
tests/dashboard/test_managed_endpoints.py.
"""

from __future__ import annotations

import json
import os
import tempfile
import time
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


class Phase1EndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-phase1-dash-")
        # Pre-create common subdirs.
        (Path(self.tmp) / "state").mkdir(parents=True, exist_ok=True)

    def _client(self):
        from dashboard.server import app
        from fastapi.testclient import TestClient
        return TestClient(app, raise_server_exceptions=False)

    # ---------- /api/findings/{iteration} (server.py:5802) ------------------

    def test_findings_404_when_no_file_or_review_dir(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/findings/7")
        self.assertEqual(resp.status_code, 404)
        self.assertIn("No findings", resp.json()["detail"])

    def test_findings_returns_persisted_file_when_present(self):
        payload = {
            "iteration": 3,
            "review_id": "review-abc-3",
            "findings": [{"severity": "high", "msg": "x"}],
        }
        path = Path(self.tmp) / "state" / "findings-3.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/findings/3")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["iteration"], 3)
        self.assertEqual(body["review_id"], "review-abc-3")
        self.assertEqual(len(body["findings"]), 1)

    def test_findings_falls_back_to_review_dir_with_note(self):
        # No persisted state/findings-5.json. Create a review dir matching iter=5.
        reviews_dir = Path(self.tmp) / "quality" / "reviews"
        review_dir = reviews_dir / "review-xyz-5"
        review_dir.mkdir(parents=True, exist_ok=True)
        with open(review_dir / "aggregate.json", "w", encoding="utf-8") as f:
            json.dump({"review_id": "review-xyz-5", "summary": "ok"}, f)

        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/findings/5")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["iteration"], 5)
        self.assertEqual(body["review_id"], "review-xyz-5")
        self.assertEqual(body["findings"], [])
        self.assertIn("findings-<iter>.json not found", body["note"])

    # ---------- /api/learnings (server.py:5831) -----------------------------

    def test_learnings_empty_when_file_missing(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/learnings")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body, {"version": 1, "learnings": [], "total": 0})

    def test_learnings_limit_returns_most_recent(self):
        # File stores chronological order; endpoint reverses (newest first).
        learnings = [
            {"id": 1, "text": "oldest"},
            {"id": 2, "text": "middle"},
            {"id": 3, "text": "newer"},
            {"id": 4, "text": "newest"},
        ]
        path = Path(self.tmp) / "state" / "relevant-learnings.json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "learnings": learnings}, f)

        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/learnings", params={"limit": 2})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["total"], 4)
        self.assertEqual(body["version"], 1)
        self.assertEqual(len(body["learnings"]), 2)
        # Newest first: id=4 then id=3.
        self.assertEqual(body["learnings"][0]["id"], 4)
        self.assertEqual(body["learnings"][1]["id"], 3)

    # ---------- /api/escalations (server.py:5850) ---------------------------

    def test_escalations_empty_when_dir_missing(self):
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/escalations")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"escalations": []})

    def test_escalations_lists_md_files_newest_first(self):
        esc_dir = Path(self.tmp) / "escalations"
        esc_dir.mkdir(parents=True, exist_ok=True)
        # Sorting is by name reverse (server.py:5859-5860). Use names that
        # sort correctly and skip non-.md files.
        (esc_dir / "handoff-2026-04-01.md").write_text("alpha", encoding="utf-8")
        (esc_dir / "handoff-2026-04-15.md").write_text("beta beta", encoding="utf-8")
        (esc_dir / "notes.txt").write_text("ignored", encoding="utf-8")

        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/escalations")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        names = [e["filename"] for e in body["escalations"]]
        self.assertEqual(names, ["handoff-2026-04-15.md", "handoff-2026-04-01.md"])
        for entry in body["escalations"]:
            self.assertIn("size_bytes", entry)
            self.assertIn("modified_at", entry)
            self.assertIsInstance(entry["size_bytes"], int)
            # ISO-8601 with timezone offset.
            self.assertTrue(
                entry["modified_at"].endswith("+00:00")
                or entry["modified_at"].endswith("Z"),
                f"modified_at not UTC ISO-8601: {entry['modified_at']}",
            )
        self.assertEqual(body["escalations"][0]["size_bytes"], len("beta beta"))

    # ---------- /api/escalations/{filename} (server.py:5882) ----------------

    def test_escalation_read_returns_markdown_content_type(self):
        esc_dir = Path(self.tmp) / "escalations"
        esc_dir.mkdir(parents=True, exist_ok=True)
        body_text = "# Handoff\n\nSome details.\n"
        (esc_dir / "handoff-1.md").write_text(body_text, encoding="utf-8")

        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/escalations/handoff-1.md")
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.headers["content-type"].startswith("text/markdown"))
        self.assertEqual(resp.text, body_text)

    def test_escalation_400_on_path_traversal(self):
        # Two of the three guards (leading-dot, backslash) are reachable via
        # HTTP. The slash guard is exercised directly against the handler --
        # Starlette routing strips '/' before the handler ever sees it, so the
        # in-handler check at server.py:5885 only fires for code paths that
        # call the function with a literal '/' in the filename string.
        with _ForceLokiDir(self.tmp):
            client = self._client()
            # Leading dot is rejected (server.py:5885).
            r1 = client.get("/api/escalations/.hidden.md")
            self.assertEqual(r1.status_code, 400)
            # Backslash in filename is rejected.
            r2 = client.get("/api/escalations/foo%5Cbar.md")
            self.assertEqual(r2.status_code, 400)

        # Direct handler call to verify the '/' guard at server.py:5885.
        import asyncio
        from fastapi import HTTPException
        from dashboard import server as _server
        with _ForceLokiDir(self.tmp):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(_server.get_escalation("foo/bar.md"))
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("invalid", ctx.exception.detail.lower())

    def test_escalation_400_on_non_md_extension(self):
        esc_dir = Path(self.tmp) / "escalations"
        esc_dir.mkdir(parents=True, exist_ok=True)
        (esc_dir / "notes.txt").write_text("nope", encoding="utf-8")

        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/escalations/notes.txt")
        self.assertEqual(resp.status_code, 400)
        self.assertIn(".md", resp.json()["detail"])

    def test_escalation_404_when_missing(self):
        esc_dir = Path(self.tmp) / "escalations"
        esc_dir.mkdir(parents=True, exist_ok=True)

        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/escalations/missing.md")
        self.assertEqual(resp.status_code, 404)
        self.assertIn("not found", resp.json()["detail"].lower())


if __name__ == "__main__":
    unittest.main()
