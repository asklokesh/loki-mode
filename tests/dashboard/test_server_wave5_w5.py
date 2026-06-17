"""tests/dashboard/test_server_wave5_w5.py
Wave-5 bug-hunt fixes for dashboard/server.py (queued after v7.63.0).

Covers four CONFIRMED findings:

  M1 -- GET /api/logs returned session log lines WITHOUT secret redaction while
        the sibling /api/app-runner/logs + /errors endpoints redact. A secret an
        agent/tool echoed into .loki/logs/*.log was returned raw. Fix wires
        _get_log_redactor() into get_logs. Test: a fake sk-ant- secret in a
        session log must come back REDACTED.

  L1 -- _compute_cost_snapshot (/api/cost) and the /metrics cost block called
        data.get(...) inside a try/except that did NOT catch AttributeError, so a
        non-object efficiency JSON ([] / null / scalar) 500'd both endpoints. Fix
        adds an isinstance(data, dict) guard + AttributeError to the caught tuple.
        Test: a corrupt efficiency file -> both endpoints return 200.

  L2 -- get_budget (/api/budget) ran float(budget_limit) - float(budget_used)
        AFTER its try/except ended, so a budget.json with a non-numeric
        budget_used (e.g. "n/a") 500'd. Fix coerces non-numeric values to 0.0.
        Test: budget_used="n/a" -> 200 with a sane payload.

  M2 -- ConnectionManager.broadcast did sequential `await send_json` with no
        per-client timeout, so one stalled client froze the fan-out + the 2s
        push loop for everyone. Fix wraps each send in asyncio.wait_for and runs
        them concurrently, dropping a timed-out client. Test: a stub connection
        whose send_json never resolves must NOT block broadcast, and must be
        dropped.

Hermetic: uses the _ForceLokiDir context manager (pins _get_loki_dir to a tmp
path) + FastAPI TestClient, matching tests/dashboard/test_get_logs_bounds.py and
tests/dashboard/test_cost_timeline_endpoint.py. No importlib.reload of the
already-imported server module (that caused a release-gate isolation failure).
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


def _client():
    from dashboard.server import app
    from fastapi.testclient import TestClient
    return TestClient(app, raise_server_exceptions=False)


# A realistic-looking but entirely fake Anthropic key. Long enough to trip the
# redactor's sk-ant- pattern.
_FAKE_SECRET = "sk-ant-FAKE0123456789abcdef0123456789abcdef0123456789"


class GetLogsRedactionTests(unittest.TestCase):
    """M1: /api/logs must redact secrets in session log lines."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-w5-logs-")
        self.log_dir = Path(self.tmp) / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_session_log_secret_is_redacted(self):
        # A session log line carrying a leaked secret (as an echoed tool output
        # would). Plain text (no timestamp prefix) -> message == raw line.
        (self.log_dir / "session.log").write_text(
            f"tool stdout: exporting key {_FAKE_SECRET} to env\n"
        )
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/logs?lines=100")
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertIsInstance(body, list)
        self.assertGreater(len(body), 0, "expected non-empty log entries")
        joined = "\n".join(e["message"] for e in body)
        # The raw secret MUST NOT appear anywhere in the response.
        self.assertNotIn(_FAKE_SECRET, resp.text, "raw secret leaked in response")
        self.assertNotIn(_FAKE_SECRET, joined, "raw secret leaked in a message")
        # The redaction marker MUST be present.
        self.assertIn("[REDACTED", joined, "expected a redaction marker")


class CostMetricsCorruptFileTests(unittest.TestCase):
    """L1: a non-object efficiency file must not 500 /api/cost or /metrics."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-w5-cost-")
        self.eff = Path(self.tmp) / "metrics" / "efficiency"
        self.eff.mkdir(parents=True, exist_ok=True)
        self._saved_env = os.environ.pop("LOKI_BUDGET_LIMIT", None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._saved_env is not None:
            os.environ["LOKI_BUDGET_LIMIT"] = self._saved_env
        else:
            os.environ.pop("LOKI_BUDGET_LIMIT", None)

    def _write(self, name, raw):
        with open(self.eff / name, "w", encoding="utf-8") as f:
            f.write(raw)

    def test_cost_endpoint_skips_list_json(self):
        # Valid JSON but a non-object (list) -> pre-fix data.get -> AttributeError.
        self._write("iteration-001.json", "[]")
        # A good record alongside it must still aggregate.
        self._write("iteration-002.json", json.dumps({
            "iteration": 2, "model": "sonnet", "phase": "build",
            "input_tokens": 1, "output_tokens": 1, "cost_usd": 0.02}))
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/cost")
        self.assertEqual(resp.status_code, 200, resp.text)
        d = resp.json()
        # The good record's cost survived; the bad file was skipped, not fatal.
        self.assertAlmostEqual(d["estimated_cost_usd"], 0.02, places=6)

    def test_cost_endpoint_skips_null_json(self):
        self._write("iteration-001.json", "null")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/cost")
        self.assertEqual(resp.status_code, 200, resp.text)

    def test_cost_endpoint_skips_corrupt_tracking_fallback(self):
        # With no efficiency token data the code falls back to
        # context/tracking.json. A non-object tracking file -> ctx.get(...)
        # raised AttributeError in that block (third L1 site). Must be 200.
        ctx_dir = Path(self.tmp) / "context"
        ctx_dir.mkdir(parents=True, exist_ok=True)
        with open(ctx_dir / "tracking.json", "w", encoding="utf-8") as f:
            f.write("[]")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/cost")
        self.assertEqual(resp.status_code, 200, resp.text)
        d = resp.json()
        self.assertEqual(d["total_input_tokens"], 0)
        self.assertEqual(d["total_output_tokens"], 0)

    def test_metrics_endpoint_skips_list_json(self):
        # /metrics cost block has the same AttributeError exposure.
        self._write("iteration-001.json", "[]")
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/metrics")
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertIn("loki_cost_usd", resp.text)


class BudgetNonNumericTests(unittest.TestCase):
    """L2: /api/budget must not 500 on a non-numeric budget_used/limit."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-w5-budget-")
        self.metrics = Path(self.tmp) / "metrics"
        self.metrics.mkdir(parents=True, exist_ok=True)
        self._saved_env = os.environ.pop("LOKI_BUDGET_LIMIT", None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._saved_env is not None:
            os.environ["LOKI_BUDGET_LIMIT"] = self._saved_env
        else:
            os.environ.pop("LOKI_BUDGET_LIMIT", None)

    def _write_budget(self, payload):
        with open(self.metrics / "budget.json", "w", encoding="utf-8") as f:
            json.dump(payload, f)

    def test_non_numeric_budget_used_returns_200(self):
        # Parses as valid JSON; pre-fix float("n/a") -> ValueError -> 500.
        self._write_budget({"limit": 100.0, "budget_used": "n/a"})
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/budget")
        self.assertEqual(resp.status_code, 200, resp.text)
        d = resp.json()
        self.assertEqual(d["budget_limit"], 100.0)
        # Non-numeric used coerced to 0.0 -> full limit remaining.
        self.assertEqual(d["current_cost"], 0.0)
        self.assertEqual(d["remaining"], 100.0)

    def test_non_numeric_limit_returns_200(self):
        self._write_budget({"limit": ["not", "a", "number"], "budget_used": 5.0})
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/budget")
        self.assertEqual(resp.status_code, 200, resp.text)
        d = resp.json()
        # Non-numeric limit coerced to None -> no remaining computed.
        self.assertIsNone(d["budget_limit"])
        self.assertIsNone(d["remaining"])
        self.assertEqual(d["current_cost"], 5.0)


class BroadcastBackpressureTests(unittest.IsolatedAsyncioTestCase):
    """M2: a stalled client must not block broadcast; it must be dropped."""

    async def test_hung_client_does_not_block_and_is_dropped(self):
        from dashboard import server as _server

        class _HungConn:
            """send_json never resolves (simulates a full TCP send buffer)."""

            async def send_json(self, _message):
                await asyncio.Event().wait()  # blocks forever

        class _GoodConn:
            def __init__(self):
                self.received = []

            async def send_json(self, message):
                self.received.append(message)

        mgr = _server.ConnectionManager()
        # Use a short timeout so the test is fast and deterministic.
        mgr.SEND_TIMEOUT_SECONDS = 0.2
        hung = _HungConn()
        good = _GoodConn()
        mgr.active_connections = [hung, good]

        # broadcast must complete well within (timeout + slack), NOT hang.
        await asyncio.wait_for(
            mgr.broadcast({"type": "state_update", "data": {"x": 1}}),
            timeout=2.0,
        )

        # The good client still received the message...
        self.assertEqual(len(good.received), 1)
        self.assertEqual(good.received[0]["type"], "state_update")
        # ...and the hung client was dropped, the good one kept.
        self.assertNotIn(hung, mgr.active_connections)
        self.assertIn(good, mgr.active_connections)

    async def test_send_personal_drops_hung_client(self):
        from dashboard import server as _server

        class _HungConn:
            async def send_json(self, _message):
                await asyncio.Event().wait()

        mgr = _server.ConnectionManager()
        mgr.SEND_TIMEOUT_SECONDS = 0.2
        hung = _HungConn()
        mgr.active_connections = [hung]

        await asyncio.wait_for(
            mgr.send_personal(hung, {"type": "ping"}),
            timeout=2.0,
        )
        self.assertNotIn(hung, mgr.active_connections)


if __name__ == "__main__":
    unittest.main()
