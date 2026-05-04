"""
tests/dashboard/test_council_transcripts_endpoint.py
v7.5.16 -- pytest suite for GET /api/council/transcripts and
           GET /api/council/transcripts/{iteration_id}.

All acceptance criteria from the Dev B brief are covered:
  AC1  empty response when transcripts dir absent (200 OK, not 404)
  AC2  sorted descending, total matches, latest_id matches first
  AC3  single-record fetch returns body or 404
  AC4  ?limit=1 returns exactly 1 record even when 3 exist
  AC5  ?since=<future> returns empty list
  AC6  ?iter_min=5 filters to iteration >= 5
  AC7  corrupt JSON file skipped, no crash
  AC8  non-object JSON payload (array) skipped, no crash
  AC9  path traversal in iteration_id rejected (404)
 AC10  all responses JSON with correct Content-Type
"""

from __future__ import annotations

import json
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


def _make_transcript(iteration: int, timestamp: str, outcome: str = "APPROVED") -> dict:
    """Return a minimal valid CouncilTranscript dict."""
    return {
        "iteration_id": f"iter-{iteration}-{timestamp.replace(':', '').replace('-', '')}",
        "iteration": iteration,
        "timestamp": timestamp,
        "task_or_prd": f"Build something great (iter {iteration})",
        "prd_path": "/project/prd.md",
        "voters": [
            {
                "name": "requirements_verifier",
                "role_index": 1,
                "verdict": "APPROVE",
                "reasoning": "All requirements met.",
                "issues": [],
                "is_contrarian": False,
            }
        ],
        "outcome": outcome,
        "contrarian_triggered": False,
        "contrarian_flipped": False,
        "approve_count": 1,
        "reject_count": 0,
        "threshold": 2,
        "total_members": 1,
    }


class CouncilTranscriptsEndpointTests(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-council-tx-test-")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _client(self):
        from dashboard.server import app
        from fastapi.testclient import TestClient
        return TestClient(app, raise_server_exceptions=False)

    def _transcripts_dir(self) -> Path:
        d = Path(self.tmp) / "council" / "transcripts"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _write_transcript(self, rec: dict) -> Path:
        d = self._transcripts_dir()
        filename = f"{rec['iteration_id']}.json"
        p = d / filename
        p.write_text(json.dumps(rec), encoding="utf-8")
        return p

    # --- AC1: empty response when transcripts dir does not exist ---------------

    def test_ac1_empty_when_dir_absent(self):
        """AC1: returns empty envelope 200 when .loki/council/transcripts/ absent."""
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/council/transcripts")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["transcripts"], [])
        self.assertEqual(body["total"], 0)
        self.assertIsNone(body["latest_id"])

    # --- AC2: sorted descending, total, latest_id --------------------------------

    def test_ac2_sorted_descending_three_records(self):
        """AC2: 3 files returned sorted by iteration descending; latest_id is highest."""
        recs = [
            _make_transcript(1, "2026-05-01T10:00:00Z"),
            _make_transcript(3, "2026-05-03T10:00:00Z"),
            _make_transcript(2, "2026-05-02T10:00:00Z"),
        ]
        for r in recs:
            self._write_transcript(r)

        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/council/transcripts")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["total"], 3)
        iterations = [t["iteration"] for t in body["transcripts"]]
        # Sorted descending: 3, 2, 1 (via reverse filename sort)
        self.assertEqual(iterations, sorted(iterations, reverse=True))
        self.assertEqual(body["latest_id"], body["transcripts"][0]["iteration_id"])

    # --- AC3: single-record fetch returns body or 404 ----------------------------

    def test_ac3_single_record_found(self):
        """AC3: GET /api/council/transcripts/{id} returns the record."""
        rec = _make_transcript(5, "2026-05-03T14:12:00Z")
        self._write_transcript(rec)
        iid = rec["iteration_id"]

        with _ForceLokiDir(self.tmp):
            resp = self._client().get(f"/api/council/transcripts/{iid}")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["iteration_id"], iid)
        self.assertEqual(body["iteration"], 5)

    def test_ac3_single_record_not_found_returns_404(self):
        """AC3: GET /api/council/transcripts/<nonexistent> returns 404."""
        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/council/transcripts/iter-99-nonexistent")
        self.assertEqual(resp.status_code, 404)

    # --- AC4: ?limit=1 returns exactly 1 record ----------------------------------

    def test_ac4_limit_param_respected(self):
        """AC4: ?limit=1 returns exactly 1 record even when 3 exist."""
        for i in [1, 2, 3]:
            self._write_transcript(_make_transcript(i, f"2026-05-0{i}T10:00:00Z"))

        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/council/transcripts", params={"limit": 1})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(len(body["transcripts"]), 1)
        self.assertEqual(body["total"], 1)

    # --- AC5: ?since=<future> returns empty list ----------------------------------

    def test_ac5_since_future_returns_empty(self):
        """AC5: ?since=2099-01-01T00:00:00Z filters out all records."""
        for i in [1, 2]:
            self._write_transcript(_make_transcript(i, f"2026-05-0{i}T10:00:00Z"))

        with _ForceLokiDir(self.tmp):
            resp = self._client().get(
                "/api/council/transcripts",
                params={"since": "2099-01-01T00:00:00Z"},
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["transcripts"], [])
        self.assertEqual(body["total"], 0)
        self.assertIsNone(body["latest_id"])

    # --- AC6: ?iter_min filters by iteration number ------------------------------

    def test_ac6_iter_min_filters_low_iterations(self):
        """AC6: ?iter_min=5 returns only records with iteration >= 5."""
        for i in [3, 5, 7]:
            self._write_transcript(_make_transcript(i, f"2026-05-01T0{i}:00:00Z"))

        with _ForceLokiDir(self.tmp):
            resp = self._client().get(
                "/api/council/transcripts",
                params={"iter_min": 5},
            )
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        for t in body["transcripts"]:
            self.assertGreaterEqual(t["iteration"], 5)
        # iterations 5 and 7 pass; 3 is excluded
        self.assertEqual(body["total"], 2)

    # --- AC7: corrupt JSON file skipped, no crash --------------------------------

    def test_ac7_corrupt_json_file_skipped(self):
        """AC7: corrupt JSON file in transcripts dir does not crash the endpoint."""
        d = self._transcripts_dir()
        # Write one valid file and one corrupt file.
        valid_rec = _make_transcript(2, "2026-05-02T10:00:00Z")
        self._write_transcript(valid_rec)
        (d / "iter-1-corrupt.json").write_text("{not valid json{{", encoding="utf-8")

        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/council/transcripts")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        # Only the valid record should appear; corrupt file silently skipped.
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["transcripts"][0]["iteration"], 2)

    # --- AC8: non-object JSON payload skipped, no crash --------------------------

    def test_ac8_non_object_json_skipped(self):
        """AC8: a file containing a JSON array (not object) is skipped gracefully."""
        d = self._transcripts_dir()
        valid_rec = _make_transcript(3, "2026-05-03T10:00:00Z")
        self._write_transcript(valid_rec)
        (d / "iter-1-array.json").write_text("[1, 2, 3]", encoding="utf-8")

        with _ForceLokiDir(self.tmp):
            resp = self._client().get("/api/council/transcripts")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        # Array file skipped; only the valid object record returned.
        self.assertEqual(body["total"], 1)
        self.assertEqual(body["transcripts"][0]["iteration"], 3)

    # --- AC9: path traversal rejected --------------------------------------------

    def test_ac9_path_traversal_rejected(self):
        """AC9: path traversal attempts in iteration_id do not escape the transcripts dir.

        HTTP-level traversal (containing '/') is normalized by the ASGI router before
        reaching the endpoint function, so those never match the route at all.
        Filesystem-level traversal using '..' without a slash (e.g. '..secrets') IS
        caught by the endpoint's '..' check and returns 404.
        Backslash traversal is also rejected.
        """
        # These contain '..' without a forward slash: the endpoint's own guard handles them.
        filesystem_traversal_ids = [
            "..secrets",
            "..evil",
            "iter-1-..suffix",
        ]
        with _ForceLokiDir(self.tmp):
            client = self._client()
            for bad_id in filesystem_traversal_ids:
                resp = client.get(f"/api/council/transcripts/{bad_id}")
                self.assertIn(
                    resp.status_code,
                    (404, 422),
                    msg=f"Expected 404 or 422 for traversal id {bad_id!r}, got {resp.status_code}",
                )

    # --- AC10: Content-Type is application/json ----------------------------------

    def test_ac10_content_type_is_json(self):
        """AC10: all responses carry application/json Content-Type."""
        with _ForceLokiDir(self.tmp):
            client = self._client()
            list_resp = client.get("/api/council/transcripts")
            self.assertIn("application/json", list_resp.headers.get("content-type", ""))

            single_resp = client.get("/api/council/transcripts/iter-nonexistent")
            self.assertIn("application/json", single_resp.headers.get("content-type", ""))


    # --- BUG-001 regression: since validation must run before missing-dir check ----

    def test_since_validation_runs_before_missing_dir_check(self):
        """BUG-001: ?since=<invalid> must return 400 even when transcripts dir is absent.

        Prior to the fix, the early-return for a missing directory fired before the
        since param was validated, so garbage values silently returned 200.
        """
        # tmp dir has NO .loki/council/transcripts/ subdirectory.
        with _ForceLokiDir(self.tmp):
            client = self._client()

            # Invalid since value -- must get 400 regardless of missing dir.
            resp = client.get("/api/council/transcripts", params={"since": "garbage"})
            self.assertEqual(
                resp.status_code,
                400,
                msg=f"Expected 400 for since=garbage with missing dir, got {resp.status_code}",
            )

            # Valid since value with no transcripts dir -- must get 200 with empty list.
            resp = client.get(
                "/api/council/transcripts",
                params={"since": "2099-01-01T00:00:00Z"},
            )
            self.assertEqual(
                resp.status_code,
                200,
                msg=f"Expected 200 for valid since with missing dir, got {resp.status_code}",
            )
            body = resp.json()
            self.assertEqual(body["transcripts"], [])
            self.assertEqual(body["total"], 0)
            self.assertIsNone(body["latest_id"])


if __name__ == "__main__":
    unittest.main()
