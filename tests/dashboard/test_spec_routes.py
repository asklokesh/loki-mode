"""tests/dashboard/test_spec_routes.py
Task I active-spec + spec-history dashboard endpoints -- HTTP tests.

Covers the two read-only routes added in dashboard/server.py:
    - GET /api/spec          (active spec, honestly typed)
    - GET /api/spec/history  (past specs from Evidence Receipts, newest-first)

The active-spec resolution mirrors proof-generator.py::_collect_spec:
    PRD file (session.json prdPath) > brief.txt > issue (latest proof) >
    generated-prd.md > codebase-analysis > none (honest empty state).

Uses FastAPI TestClient with raise_server_exceptions=False and the
_ForceLokiDir pattern from tests/dashboard/test_proofs_routes.py.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path


class _ForceLokiDir:
    """Context manager that pins dashboard.server._get_loki_dir() to a tmp."""

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


def _client():
    from dashboard.server import app
    from fastapi.testclient import TestClient
    return TestClient(app, raise_server_exceptions=False)


def _write_proof(loki: Path, run_id: str, source: str, brief: str,
                 generated_at: str):
    run_dir = loki / "proofs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    proof = {
        "schema_version": "1.1",
        "run_id": run_id,
        "generated_at": generated_at,
        "spec": {"source": source, "brief": brief},
    }
    with open(run_dir / "proof.json", "w", encoding="utf-8") as f:
        json.dump(proof, f)


class ActiveSpecTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-spec-dash-")
        self.loki = Path(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---------- PRD file ----------------------------------------------------

    def test_prd_when_session_prdpath_exists(self):
        prd = self.loki / "myprd.md"
        prd.write_text("# Build a todo app\nWith auth.", encoding="utf-8")
        (self.loki / "session.json").write_text(
            json.dumps({"prdPath": str(prd), "status": "running"}),
            encoding="utf-8")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["type"], "prd")
        self.assertEqual(body["path"], str(prd))
        self.assertIn("Build a todo app", body["content"])

    def test_prd_path_missing_file_falls_through(self):
        # session.json points at a PRD that no longer exists -> must NOT claim
        # prd; falls through to the next honest source (here: codebase-analysis
        # because a session exists).
        (self.loki / "session.json").write_text(
            json.dumps({"prdPath": "/nope/gone.md", "status": "running"}),
            encoding="utf-8")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["type"], "codebase-analysis")

    # ---------- one-line brief ---------------------------------------------

    def test_brief_from_state_brief_txt(self):
        (self.loki / "state").mkdir(parents=True, exist_ok=True)
        (self.loki / "state" / "brief.txt").write_text(
            "build a discord bot that posts the weather", encoding="utf-8")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["type"], "brief")
        self.assertEqual(body["text"],
                         "build a discord bot that posts the weather")

    # ---------- issue mode (from latest proof) -----------------------------

    def test_issue_from_latest_proof_source(self):
        _write_proof(
            self.loki, "20260620T010000Z-aaa",
            "https://github.com/o/r/issues/42", "Add CSV export to reports.",
            "2026-06-20T01:00:00Z")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["type"], "issue")
        self.assertEqual(body["ref"], "https://github.com/o/r/issues/42")
        self.assertIn("Add CSV export", body["body"])

    def test_brief_takes_priority_over_issue_proof(self):
        # A live brief.txt (the active run) outranks an older issue proof.
        (self.loki / "state").mkdir(parents=True, exist_ok=True)
        (self.loki / "state" / "brief.txt").write_text("live brief", encoding="utf-8")
        _write_proof(
            self.loki, "20260619T010000Z-old",
            "https://github.com/o/r/issues/7", "old issue", "2026-06-19T01:00:00Z")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec")
        self.assertEqual(resp.json()["type"], "brief")

    # ---------- generated PRD ----------------------------------------------

    def test_spec_from_generated_prd(self):
        (self.loki / "generated-prd.md").write_text(
            "# Synthesized PRD\nGoals...", encoding="utf-8")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["type"], "spec")
        self.assertTrue(body["generated"])
        self.assertIn("Synthesized PRD", body["content"])

    # ---------- codebase-analysis & none -----------------------------------

    def test_codebase_analysis_when_session_but_no_spec(self):
        (self.loki / "session.json").write_text(
            json.dumps({"status": "running"}), encoding="utf-8")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec")
        self.assertEqual(resp.json()["type"], "codebase-analysis")

    def test_none_when_nothing_present(self):
        # Truly empty .loki -> honest "none", never a fabricated spec.
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["type"], "none")


class SpecHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-spec-hist-")
        self.loki = Path(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_empty_when_no_proofs(self):
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec/history")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"history": []})

    def test_lists_proofs_newest_first_with_types(self):
        _write_proof(self.loki, "r-old", "brief", "older one-liner",
                     "2026-06-18T00:00:00Z")
        _write_proof(self.loki, "r-mid", "https://github.com/o/r/issues/9",
                     "an issue", "2026-06-19T00:00:00Z")
        _write_proof(self.loki, "r-new", "/abs/path/prd.md", "# A real PRD",
                     "2026-06-20T00:00:00Z")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec/history")
        self.assertEqual(resp.status_code, 200)
        hist = resp.json()["history"]
        self.assertEqual([h["run_id"] for h in hist],
                         ["r-new", "r-mid", "r-old"])
        self.assertEqual(hist[0]["type"], "spec")
        self.assertEqual(hist[1]["type"], "issue")
        self.assertEqual(hist[2]["type"], "brief")
        # Summary is the first non-empty brief line, honestly derived.
        self.assertEqual(hist[0]["summary"], "A real PRD")
        self.assertEqual(hist[2]["summary"], "older one-liner")

    def test_codebase_analysis_summary_is_honest(self):
        _write_proof(self.loki, "r-ca", "codebase-analysis", "",
                     "2026-06-20T00:00:00Z")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec/history")
        hist = resp.json()["history"]
        self.assertEqual(hist[0]["type"], "codebase-analysis")
        self.assertEqual(hist[0]["summary"], "Codebase analysis (no spec)")

    def test_corrupt_proof_is_skipped_not_faked(self):
        good_run = self.loki / "proofs" / "r-good"
        good_run.mkdir(parents=True, exist_ok=True)
        _write_proof(self.loki, "r-good", "brief", "valid", "2026-06-20T00:00:00Z")
        bad_run = self.loki / "proofs" / "r-bad"
        bad_run.mkdir(parents=True, exist_ok=True)
        (bad_run / "proof.json").write_text("{not json", encoding="utf-8")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/spec/history")
        hist = resp.json()["history"]
        self.assertEqual(len(hist), 1)
        self.assertEqual(hist[0]["run_id"], "r-good")


if __name__ == "__main__":
    unittest.main()
