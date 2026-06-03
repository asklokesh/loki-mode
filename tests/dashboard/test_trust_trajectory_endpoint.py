"""tests/dashboard/test_trust_trajectory_endpoint.py
R4 visible trust trajectory endpoint -- HTTP + WebSocket-push tests.

Covers GET /api/trust/trajectory (dashboard/server.py):
  - empty / single-run -> 200 with insufficient=True (no fabricated trend)
  - multi-run aggregation + direction (improving when council/gate up, iters down)
  - cache written to .loki/metrics/trust-trajectory.json on GET
  - corrupt proof.json skipped, no crash
  - no-PII: response carries no filesystem paths or proof spec/diff text
  - degraded branch: module-not-found -> available=False, 200 (no crash)

Plus the proactive surface: the trust_update message _push_loki_state_loop
broadcasts over the EXISTING WebSocket when the trajectory tally changes.

Uses the FastAPI TestClient + _ForceLokiDir pattern from
tests/dashboard/test_cost_timeline_endpoint.py.
"""

from __future__ import annotations

import json
import os
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


def _reset_trust_module_cache():
    # The endpoint memoizes the imported module in _TRUST_MODULE. Reset it so a
    # degraded-branch test that forces the loader to fail does not poison later
    # tests (and vice versa).
    from dashboard import server as _server
    _server._TRUST_MODULE = None


class TrustTrajectoryEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-trust-dash-")
        self.proofs = Path(self.tmp) / "proofs"
        self.proofs.mkdir(parents=True, exist_ok=True)
        _reset_trust_module_cache()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        _reset_trust_module_cache()

    def _write_proof(self, run_id, *, generated_at, final_verdict=None,
                     gates_passed=None, gates_total=None, iterations=None,
                     raw=None):
        d = self.proofs / run_id
        d.mkdir(parents=True, exist_ok=True)
        if raw is not None:
            payload = raw
        else:
            council = {"enabled": True}
            if final_verdict is not None:
                council["final_verdict"] = final_verdict
            qg = {}
            if gates_passed is not None and gates_total is not None:
                qg = {"passed": gates_passed, "total": gates_total}
            payload = {
                "run_id": run_id,
                "generated_at": generated_at,
                "council": council,
                "quality_gates": qg,
            }
            if iterations is not None:
                payload["iterations"] = {"count": iterations}
        with open(d / "proof.json", "w", encoding="utf-8") as f:
            json.dump(payload, f)

    # ---------- insufficient history ---------------------------------------

    def test_empty_is_insufficient(self):
        empty = tempfile.mkdtemp(prefix="loki-trust-empty-")
        try:
            with _ForceLokiDir(empty):
                resp = _client().get("/api/trust/trajectory")
            self.assertEqual(resp.status_code, 200)
            d = resp.json()
            self.assertTrue(d["available"])
            self.assertEqual(d["runs_count"], 0)
            self.assertTrue(d["insufficient"])
            self.assertEqual(d["improving_count"], 0)
        finally:
            shutil.rmtree(empty, ignore_errors=True)

    def test_single_run_insufficient_no_fake_trend(self):
        self._write_proof("r1", generated_at="2026-06-01T00:00:00Z",
                          final_verdict="APPROVED", gates_passed=5, gates_total=5)
        with _ForceLokiDir(self.tmp):
            d = _client().get("/api/trust/trajectory").json()
        self.assertTrue(d["insufficient"])
        cp = d["axes"]["council_pass_rate"]
        self.assertEqual(cp["direction"], "flat")
        self.assertIsNone(cp["improving"])

    # ---------- multi-run aggregation + direction --------------------------

    def test_multi_run_improving(self):
        self._write_proof("r1", generated_at="2026-06-01T00:00:00Z",
                          final_verdict="REJECTED", gates_passed=2, gates_total=5,
                          iterations=10)
        self._write_proof("r2", generated_at="2026-06-02T00:00:00Z",
                          final_verdict="REJECTED", gates_passed=3, gates_total=5,
                          iterations=8)
        self._write_proof("r3", generated_at="2026-06-03T00:00:00Z",
                          final_verdict="APPROVED", gates_passed=5, gates_total=5,
                          iterations=4)
        self._write_proof("r4", generated_at="2026-06-04T00:00:00Z",
                          final_verdict="APPROVED", gates_passed=5, gates_total=5,
                          iterations=3)
        with _ForceLokiDir(self.tmp):
            d = _client().get("/api/trust/trajectory").json()
        self.assertFalse(d["insufficient"])
        self.assertEqual(d["runs_count"], 4)
        self.assertEqual(d["axes"]["council_pass_rate"]["direction"], "up")
        self.assertTrue(d["axes"]["council_pass_rate"]["improving"])
        self.assertEqual(d["axes"]["iterations"]["direction"], "down")
        self.assertTrue(d["axes"]["iterations"]["improving"])
        self.assertEqual(d["improving_count"], 3)
        # series is time-ordered ascending
        self.assertEqual([s["run_id"] for s in d["series"]],
                         ["r1", "r2", "r3", "r4"])

    def test_cache_written_on_get(self):
        self._write_proof("r1", generated_at="2026-06-01T00:00:00Z",
                          final_verdict="APPROVED")
        self._write_proof("r2", generated_at="2026-06-02T00:00:00Z",
                          final_verdict="APPROVED")
        with _ForceLokiDir(self.tmp):
            _client().get("/api/trust/trajectory")
        cache = Path(self.tmp) / "metrics" / "trust-trajectory.json"
        self.assertTrue(cache.is_file())
        with open(cache, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["schema_version"], 1)

    # ---------- resilience + no-PII ----------------------------------------

    def test_corrupt_proof_skipped(self):
        bad = self.proofs / "bad"
        bad.mkdir(parents=True, exist_ok=True)
        with open(bad / "proof.json", "w", encoding="utf-8") as f:
            f.write("{not valid json")
        self._write_proof("good1", generated_at="2026-06-01T00:00:00Z",
                          final_verdict="APPROVED")
        self._write_proof("good2", generated_at="2026-06-02T00:00:00Z",
                          final_verdict="APPROVED")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/trust/trajectory")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["runs_count"], 2)

    def test_no_pii_no_paths_or_secrets(self):
        secret = "API_KEY=sk-do-not-leak-12345"
        self._write_proof("r1", generated_at="2026-06-01T00:00:00Z", raw={
            "run_id": "r1", "generated_at": "2026-06-01T00:00:00Z",
            "spec": {"text": secret, "source": "/home/u/secret.md"},
            "diffs": [secret],
            "council": {"enabled": True, "final_verdict": "APPROVED",
                        "reviewers": [{"summary": secret}]},
            "quality_gates": {"passed": 5, "total": 5},
            "iterations": {"count": 3}})
        self._write_proof("r2", generated_at="2026-06-02T00:00:00Z", raw={
            "run_id": "r2", "generated_at": "2026-06-02T00:00:00Z",
            "spec": {"text": secret},
            "council": {"enabled": True, "final_verdict": "APPROVED"},
            "quality_gates": {"passed": 5, "total": 5},
            "iterations": {"count": 2}})
        with _ForceLokiDir(self.tmp):
            text = _client().get("/api/trust/trajectory").text
        self.assertNotIn(secret, text)
        self.assertNotIn("sk-do-not-leak", text)
        self.assertNotIn("/home/u/secret.md", text)
        self.assertNotIn("/proofs/", text)

    # ---------- degraded branch --------------------------------------------

    def test_module_not_found_degrades_gracefully(self):
        from dashboard import server as _server
        saved = _server._load_trust_module
        _server._load_trust_module = lambda: None
        try:
            with _ForceLokiDir(self.tmp):
                resp = _client().get("/api/trust/trajectory")
            self.assertEqual(resp.status_code, 200)
            d = resp.json()
            self.assertFalse(d["available"])
            self.assertTrue(d["insufficient"])
            self.assertEqual(d["runs_count"], 0)
        finally:
            _server._load_trust_module = saved


class TrustBroadcastLoopTests(unittest.IsolatedAsyncioTestCase):
    """Drive one iteration of the real _push_loki_state_loop and assert it
    broadcasts a trust_update message over the existing WebSocket manager when
    the trajectory tally is first seen, using the same broadcast path as every
    other push (manager.broadcast).
    """

    async def test_loop_broadcasts_trust_update(self):
        from dashboard import server as _server

        tmp = tempfile.mkdtemp(prefix="loki-trust-loop-")
        proofs = Path(tmp) / "proofs"
        proofs.mkdir(parents=True, exist_ok=True)
        for i, (v, g) in enumerate([("REJECTED", 2), ("APPROVED", 5)], 1):
            d = proofs / ("r%d" % i)
            d.mkdir(parents=True, exist_ok=True)
            with open(d / "proof.json", "w", encoding="utf-8") as f:
                json.dump({"run_id": "r%d" % i,
                           "generated_at": "2026-06-0%dT00:00:00Z" % i,
                           "council": {"enabled": True, "final_verdict": v},
                           "quality_gates": {"passed": g, "total": 5}}, f)

        captured = []

        class _StopLoop(BaseException):
            pass

        class _FakeManager:
            active_connections = [object()]

            async def broadcast(self, message):
                captured.append(message)
                if message.get("type") == "trust_update":
                    raise _StopLoop()

        saved_loki_dir = _server._get_loki_dir
        saved_manager = _server.manager
        saved_env = os.environ.pop("LOKI_BUDGET_LIMIT", None)
        _reset_trust_module_cache()
        _server._get_loki_dir = lambda: Path(tmp)
        _server.manager = _FakeManager()
        try:
            with self.assertRaises(_StopLoop):
                await _server._push_loki_state_loop()
        finally:
            _server._get_loki_dir = saved_loki_dir
            _server.manager = saved_manager
            if saved_env is not None:
                os.environ["LOKI_BUDGET_LIMIT"] = saved_env
            _reset_trust_module_cache()
            shutil.rmtree(tmp, ignore_errors=True)

        trust_msgs = [m for m in captured if m.get("type") == "trust_update"]
        self.assertTrue(trust_msgs, "loop did not broadcast a trust_update message")
        data = trust_msgs[0]["data"]
        self.assertEqual(data["runs_count"], 2)
        self.assertFalse(data["insufficient"])
        # Must be JSON-serialisable (sent over the WebSocket as JSON).
        json.dumps(trust_msgs[0])


if __name__ == "__main__":
    unittest.main()
