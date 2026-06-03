"""tests/dashboard/test_cost_timeline_endpoint.py
R3 cost + observability endpoint -- HTTP tests.

Covers GET /api/cost/timeline (dashboard/server.py):
  - empty dirs -> 200 with honest nulls (cost_recorded False, no fabricated $0)
  - current-run per-iteration aggregation + cumulative_usd from efficiency/
  - per-run history from .loki/proofs/*/proof.json + project_total_usd
  - budget status thresholds: ok (<80%) / warn ([80%,100%)) / exceeded (>=100%)
  - recorded-but-zero ($0.00 with cost_recorded True) vs not-recorded (null)
  - cost_usd null in a record priced from tokens via _calculate_model_cost
  - corrupt JSON files skipped, no crash
  - no-PII: response carries no filesystem paths

Uses FastAPI TestClient with raise_server_exceptions=False and the
_ForceLokiDir pattern from tests/dashboard/test_proofs_routes.py.
"""

from __future__ import annotations

import asyncio
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


class CostTimelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-cost-dash-")
        self.eff = Path(self.tmp) / "metrics" / "efficiency"
        self.eff.mkdir(parents=True, exist_ok=True)
        self.proofs = Path(self.tmp) / "proofs"
        self.metrics = Path(self.tmp) / "metrics"
        # Ensure no env budget leaks in from the runner.
        self._saved_env = os.environ.pop("LOKI_BUDGET_LIMIT", None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._saved_env is not None:
            os.environ["LOKI_BUDGET_LIMIT"] = self._saved_env
        else:
            os.environ.pop("LOKI_BUDGET_LIMIT", None)

    def _write_eff(self, name, payload):
        with open(self.eff / name, "w", encoding="utf-8") as f:
            json.dump(payload, f)

    def _write_proof(self, run_id, payload):
        d = self.proofs / run_id
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "proof.json", "w", encoding="utf-8") as f:
            json.dump(payload, f)

    def _write_budget(self, payload):
        self.metrics.mkdir(parents=True, exist_ok=True)
        with open(self.metrics / "budget.json", "w", encoding="utf-8") as f:
            json.dump(payload, f)

    # ---------- empty -------------------------------------------------------

    def test_empty_returns_honest_nulls(self):
        empty = tempfile.mkdtemp(prefix="loki-cost-empty-")
        try:
            with _ForceLokiDir(empty):
                resp = _client().get("/api/cost/timeline")
            self.assertEqual(resp.status_code, 200)
            d = resp.json()
            self.assertEqual(d["current_run"]["iterations"], [])
            self.assertIsNone(d["current_run"]["total_usd"])
            self.assertFalse(d["current_run"]["cost_recorded"])
            self.assertEqual(d["runs"], [])
            self.assertEqual(d["runs_count"], 0)
            self.assertEqual(d["budget"]["status"], "none")
            self.assertIsNone(d["budget"]["limit"])
        finally:
            shutil.rmtree(empty, ignore_errors=True)

    # ---------- current run aggregation ------------------------------------

    def test_current_run_cumulative(self):
        self._write_eff("iteration-001.json", {
            "iteration": 1, "model": "sonnet", "phase": "build",
            "input_tokens": 1000, "output_tokens": 500, "cost_usd": 0.05,
            "timestamp": "2026-06-03T01:00:00Z"})
        self._write_eff("iteration-002.json", {
            "iteration": 2, "model": "sonnet", "phase": "review",
            "input_tokens": 2000, "output_tokens": 800, "cost_usd": 0.10,
            "timestamp": "2026-06-03T01:05:00Z"})
        with _ForceLokiDir(self.tmp):
            d = _client().get("/api/cost/timeline").json()
        its = d["current_run"]["iterations"]
        self.assertEqual(len(its), 2)
        self.assertEqual(its[0]["iteration"], 1)
        self.assertAlmostEqual(its[0]["cumulative_usd"], 0.05, places=6)
        self.assertAlmostEqual(its[1]["cumulative_usd"], 0.15, places=6)
        self.assertTrue(d["current_run"]["cost_recorded"])
        self.assertAlmostEqual(d["current_run"]["total_usd"], 0.15, places=6)

    def test_cost_null_priced_from_tokens(self):
        # cost_usd absent -> priced via _calculate_model_cost (sonnet defaults).
        self._write_eff("iteration-001.json", {
            "iteration": 1, "model": "sonnet", "phase": "build",
            "input_tokens": 1_000_000, "output_tokens": 1_000_000})
        with _ForceLokiDir(self.tmp):
            d = _client().get("/api/cost/timeline").json()
        # sonnet default: 3.00 input + 15.00 output per mtok = 18.00 for 1M+1M.
        self.assertGreater(d["current_run"]["iterations"][0]["cost_usd"], 0)

    def test_recorded_but_zero_distinct_from_not_recorded(self):
        self._write_eff("iteration-001.json", {
            "iteration": 1, "model": "sonnet", "phase": "build",
            "input_tokens": 0, "output_tokens": 0, "cost_usd": 0})
        with _ForceLokiDir(self.tmp):
            d = _client().get("/api/cost/timeline").json()
        # Recorded but zero: cost_recorded True, total 0.0 (NOT null).
        self.assertTrue(d["current_run"]["cost_recorded"])
        self.assertEqual(d["current_run"]["total_usd"], 0.0)

    # ---------- per-run history --------------------------------------------

    def test_runs_history_from_proofs(self):
        self._write_proof("run-a", {
            "run_id": "run-a", "generated_at": "2026-06-01T00:00:00Z",
            "provider": {"model": "opus"}, "cost": {"usd": 1.5},
            "files_changed": {"count": 3}, "council": {"final_verdict": "APPROVE"}})
        self._write_proof("run-b", {
            "run_id": "run-b", "generated_at": "2026-06-02T00:00:00Z",
            "provider": {"model": "sonnet"}, "cost": {"usd": 0.5},
            "files_changed": {"count": 1}, "council": {"final_verdict": "APPROVE"}})
        with _ForceLokiDir(self.tmp):
            d = _client().get("/api/cost/timeline").json()
        self.assertEqual(d["runs_count"], 2)
        # newest first by generated_at
        self.assertEqual(d["runs"][0]["run_id"], "run-b")
        self.assertAlmostEqual(d["project_total_usd"], 2.0, places=6)

    def test_proof_cost_null_preserved(self):
        self._write_proof("run-a", {
            "run_id": "run-a", "generated_at": "2026-06-01T00:00:00Z",
            "cost": {"usd": None}})
        with _ForceLokiDir(self.tmp):
            d = _client().get("/api/cost/timeline").json()
        self.assertIsNone(d["runs"][0]["cost_usd"])
        self.assertEqual(d["project_total_usd"], 0.0)

    # ---------- budget thresholds ------------------------------------------

    def _cost_with_budget(self, used, limit):
        # One efficiency record carrying the desired current spend.
        self._write_eff("iteration-001.json", {
            "iteration": 1, "model": "sonnet", "phase": "build",
            "input_tokens": 1, "output_tokens": 1, "cost_usd": used})
        self._write_budget({"limit": limit, "budget_limit": limit,
                            "budget_used": used, "exceeded": used >= limit})
        with _ForceLokiDir(self.tmp):
            return _client().get("/api/cost/timeline").json()["budget"]

    def test_budget_status_ok_below_80(self):
        b = self._cost_with_budget(used=10.0, limit=100.0)
        self.assertEqual(b["status"], "ok")
        self.assertFalse(b["exceeded"])

    def test_budget_status_warn_at_80(self):
        b = self._cost_with_budget(used=80.0, limit=100.0)
        self.assertEqual(b["status"], "warn")
        self.assertFalse(b["exceeded"])
        self.assertEqual(b["warn_threshold_percent"], 80)

    def test_budget_status_ok_just_below_80(self):
        b = self._cost_with_budget(used=79.99, limit=100.0)
        self.assertEqual(b["status"], "ok")

    def test_budget_status_exceeded_at_100(self):
        b = self._cost_with_budget(used=100.0, limit=100.0)
        self.assertEqual(b["status"], "exceeded")
        self.assertTrue(b["exceeded"])
        self.assertEqual(b["remaining"], 0.0)

    def test_budget_limit_from_env_when_no_file(self):
        self._write_eff("iteration-001.json", {
            "iteration": 1, "model": "sonnet", "phase": "build",
            "input_tokens": 1, "output_tokens": 1, "cost_usd": 90.0})
        os.environ["LOKI_BUDGET_LIMIT"] = "100"
        try:
            with _ForceLokiDir(self.tmp):
                b = _client().get("/api/cost/timeline").json()["budget"]
            self.assertEqual(b["limit"], 100.0)
            self.assertEqual(b["status"], "warn")
        finally:
            os.environ.pop("LOKI_BUDGET_LIMIT", None)

    # ---------- resilience + no-PII ----------------------------------------

    def test_corrupt_efficiency_skipped(self):
        with open(self.eff / "iteration-001.json", "w", encoding="utf-8") as f:
            f.write("{not valid json")
        self._write_eff("iteration-002.json", {
            "iteration": 2, "model": "sonnet", "phase": "build",
            "input_tokens": 1, "output_tokens": 1, "cost_usd": 0.02})
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/cost/timeline")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.json()["current_run"]["iterations"]), 1)

    def test_corrupt_proof_skipped(self):
        d = self.proofs / "bad"
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "proof.json", "w", encoding="utf-8") as f:
            f.write("[not an object]")
        self._write_proof("good", {
            "run_id": "good", "generated_at": "2026-06-01T00:00:00Z",
            "cost": {"usd": 0.3}})
        with _ForceLokiDir(self.tmp):
            data = _client().get("/api/cost/timeline").json()
        self.assertEqual(data["runs_count"], 1)
        self.assertEqual(data["runs"][0]["run_id"], "good")

    def test_no_pii_no_paths_leaked(self):
        self._write_eff("iteration-001.json", {
            "iteration": 1, "model": "sonnet", "phase": "build",
            "input_tokens": 1, "output_tokens": 1, "cost_usd": 0.02})
        self._write_proof("run-a", {
            "run_id": "run-a", "generated_at": "2026-06-01T00:00:00Z",
            "cost": {"usd": 0.3}})
        with _ForceLokiDir(self.tmp):
            text = _client().get("/api/cost/timeline").text
        # The tmp path must never appear in the response body.
        self.assertNotIn(self.tmp, text)
        self.assertNotIn("/proofs/", text)
        self.assertNotIn("/efficiency/", text)


class BudgetSnapshotTests(unittest.TestCase):
    """R3 proactive surface: the budget snapshot the WebSocket push broadcasts.

    The dashboard pushes a {"type": "budget_status", "data": <snapshot>} message
    over the EXISTING WebSocket (manager.broadcast in _push_loki_state_loop) when
    the snapshot status crosses into warn/exceeded. These tests prove the warn
    status is exposed on that broadcast payload, so a non-watching user sees the
    80% warning in any open dashboard page before the hard stop at 100%.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-budget-snap-")
        self.eff = Path(self.tmp) / "metrics" / "efficiency"
        self.eff.mkdir(parents=True, exist_ok=True)
        self.metrics = Path(self.tmp) / "metrics"
        self._saved_env = os.environ.pop("LOKI_BUDGET_LIMIT", None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._saved_env is not None:
            os.environ["LOKI_BUDGET_LIMIT"] = self._saved_env
        else:
            os.environ.pop("LOKI_BUDGET_LIMIT", None)

    def _write_eff(self, name, payload):
        with open(self.eff / name, "w", encoding="utf-8") as f:
            json.dump(payload, f)

    def _write_budget(self, payload):
        self.metrics.mkdir(parents=True, exist_ok=True)
        with open(self.metrics / "budget.json", "w", encoding="utf-8") as f:
            json.dump(payload, f)

    def _snapshot(self, used, limit):
        from dashboard import server as _server
        self._write_eff("iteration-001.json", {
            "iteration": 1, "model": "sonnet", "phase": "build",
            "input_tokens": 1, "output_tokens": 1, "cost_usd": used})
        self._write_budget({"limit": limit})
        return _server._compute_budget_snapshot(Path(self.tmp))

    def test_snapshot_warn_at_80(self):
        snap = self._snapshot(used=82.0, limit=100.0)
        self.assertEqual(snap["status"], "warn")
        self.assertFalse(snap["exceeded"])
        self.assertEqual(snap["percent_used"], 82.0)
        self.assertEqual(snap["warn_threshold_percent"], 80)

    def test_snapshot_ok_below_80(self):
        snap = self._snapshot(used=50.0, limit=100.0)
        self.assertEqual(snap["status"], "ok")

    def test_snapshot_exceeded_at_100(self):
        snap = self._snapshot(used=100.0, limit=100.0)
        self.assertEqual(snap["status"], "exceeded")
        self.assertTrue(snap["exceeded"])
        self.assertEqual(snap["remaining"], 0.0)

    def test_snapshot_none_without_limit(self):
        from dashboard import server as _server
        self._write_eff("iteration-001.json", {
            "iteration": 1, "model": "sonnet", "phase": "build",
            "input_tokens": 1, "output_tokens": 1, "cost_usd": 5.0})
        snap = _server._compute_budget_snapshot(Path(self.tmp))
        self.assertEqual(snap["status"], "none")
        self.assertIsNone(snap["limit"])

    def test_broadcast_payload_carries_warn(self):
        """The exact message shape the WS loop broadcasts must carry warn."""
        snap = self._snapshot(used=85.0, limit=100.0)
        message = {"type": "budget_status", "data": snap}
        self.assertEqual(message["type"], "budget_status")
        self.assertEqual(message["data"]["status"], "warn")
        # Must be JSON-serialisable (it is sent over the WebSocket as JSON).
        self.assertIn('"status": "warn"', json.dumps(message))


class BudgetBroadcastLoopTests(unittest.IsolatedAsyncioTestCase):
    """Drive one iteration of the real _push_loki_state_loop and assert it
    broadcasts a budget_status message over the existing WebSocket manager when
    spend crosses 80%, using the same broadcast path as every other push.
    """

    async def test_loop_broadcasts_budget_status_on_warn(self):
        from dashboard import server as _server

        tmp = tempfile.mkdtemp(prefix="loki-budget-loop-")
        eff = Path(tmp) / "metrics" / "efficiency"
        eff.mkdir(parents=True, exist_ok=True)
        with open(eff / "iteration-001.json", "w", encoding="utf-8") as f:
            json.dump({"iteration": 1, "model": "sonnet", "phase": "build",
                       "input_tokens": 1, "output_tokens": 1, "cost_usd": 90.0}, f)
        with open(Path(tmp) / "metrics" / "budget.json", "w", encoding="utf-8") as f:
            json.dump({"limit": 100.0}, f)

        captured = []

        class _StopLoop(BaseException):
            """Not Exception/CancelledError, so it escapes the loop's own
            handlers (which return on CancelledError and continue on Exception).
            """

        class _FakeManager:
            # One fake connection so the loop's active_connections guard passes.
            active_connections = [object()]

            async def broadcast(self, message):
                captured.append(message)
                # Stop the infinite loop after the first broadcast we care about.
                if message.get("type") == "budget_status":
                    raise _StopLoop()

        saved_loki_dir = _server._get_loki_dir
        saved_manager = _server.manager
        saved_env = os.environ.pop("LOKI_BUDGET_LIMIT", None)
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
            shutil.rmtree(tmp, ignore_errors=True)

        budget_msgs = [m for m in captured if m.get("type") == "budget_status"]
        self.assertTrue(budget_msgs, "loop did not broadcast a budget_status message")
        self.assertEqual(budget_msgs[0]["data"]["status"], "warn")
        self.assertEqual(budget_msgs[0]["data"]["percent_used"], 90.0)


if __name__ == "__main__":
    unittest.main()
