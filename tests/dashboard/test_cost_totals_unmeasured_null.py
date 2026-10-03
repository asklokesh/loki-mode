"""A total over runs nobody measured is null, never $0.00 (moat P7).

THE BUGS (cycle-4 council):

  - /api/cost/timeline summed proof costs with null counted as 0 and sent
    "project_total_usd": 0.0, so the legacy cost page showed
    PROJECT TOTAL $0.00 for two runs that each read "not recorded".
  - dashboard/registry.py seeded every fleet run with cost_usd 0.0, so
    /api/fleet/runs said $0.00 per project and /api/fleet/summary summed a
    Total Cost of $0.00 for projects that never recorded a cost.
  - /api/cost by_phase / by_model sent input_tokens / output_tokens 0 for a
    bucket whose records carried no token field at all.

BOTH DIRECTIONS ARE ASSERTED. A measured $0.00 stays 0.0, a measured 2.5
stays 2.5, and a mix sums only the measured runs and says the total is
partial (a lower bound), so a fix that nulls every zero is caught too.
"""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

_ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_ROOT))


class _ForceLokiDir:
    """Pin dashboard.server._get_loki_dir() to a tmp dir (house pattern)."""

    def __init__(self, tmpdir):
        self.tmp = tmpdir
        self._orig = None

    def __enter__(self):
        from dashboard import server as _server
        self._orig = _server._get_loki_dir
        _server._get_loki_dir = lambda: Path(self.tmp)
        return self

    def __exit__(self, *exc):
        from dashboard import server as _server
        _server._get_loki_dir = self._orig
        return False


def _client():
    from fastapi.testclient import TestClient
    from dashboard import server as _server
    return TestClient(_server.app, raise_server_exceptions=False)


_NO_FIELDS = {"iteration": 1, "model": "sonnet", "phase": "build"}
_ALL_ZERO = {"iteration": 1, "model": "sonnet", "phase": "build",
             "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
_MEASURED = {"iteration": 1, "model": "sonnet", "phase": "build",
             "input_tokens": 1000, "output_tokens": 500, "cost_usd": 2.5}
_MEASURED_ZERO = {"iteration": 1, "model": "sonnet", "phase": "build",
                  "input_tokens": 9412, "output_tokens": 11008, "cost_usd": 0.0}
_NULL_COST = {"usd": None, "available": False}


class _TmpLoki(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-cost-totals-")
        self.loki = Path(self.tmp) / ".loki"
        (self.loki / "metrics" / "efficiency").mkdir(parents=True)
        self._saved_env = os.environ.pop("LOKI_BUDGET_LIMIT", None)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._saved_env is not None:
            os.environ["LOKI_BUDGET_LIMIT"] = self._saved_env

    def _eff(self, loki, i, rec):
        d = loki / "metrics" / "efficiency"
        d.mkdir(parents=True, exist_ok=True)
        (d / f"iteration-{i}.json").write_text(json.dumps(rec))

    def _proof(self, run_id, day, cost):
        d = self.loki / "proofs" / run_id
        d.mkdir(parents=True, exist_ok=True)
        (d / "proof.json").write_text(json.dumps({
            "run_id": run_id, "generated_at": f"2026-09-{day:02d}T00:00:00Z", "cost": cost}))

    def _get(self, path):
        with _ForceLokiDir(str(self.loki)):
            resp = _client().get(path)
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()


class ProjectTotalTests(_TmpLoki):
    def test_council_reproduction_all_runs_unmeasured_is_null(self):
        self._proof("r1", 1, _NULL_COST)
        self._proof("r2", 2, _NULL_COST)
        self._eff(self.loki, 1, _NO_FIELDS)
        d = self._get("/api/cost/timeline")
        self.assertEqual([(r["run_id"], r["cost_usd"]) for r in d["runs"]], [("r2", None), ("r1", None)])
        self.assertIn("project_total_usd", d)
        self.assertIsNone(d["project_total_usd"], "two unmeasured runs summed to a reading")
        self.assertFalse(d.get("project_total_partial"))

    def test_measured_zero_run_stays_zero(self):
        self._proof("r1", 1, {"usd": 0.0, "available": True})
        d = self._get("/api/cost/timeline")
        self.assertEqual(d["project_total_usd"], 0.0)
        self.assertIsNotNone(d["project_total_usd"])
        self.assertIs(d["project_total_partial"], False)

    def test_measured_run_stays_its_number(self):
        self._proof("r1", 1, {"usd": 2.5, "available": True})
        d = self._get("/api/cost/timeline")
        self.assertAlmostEqual(d["project_total_usd"], 2.5, places=6)
        self.assertIs(d["project_total_partial"], False)

    def test_mixed_sums_measured_runs_and_says_partial(self):
        self._proof("r1", 1, _NULL_COST)
        self._proof("r2", 2, {"usd": 2.5, "available": True})
        d = self._get("/api/cost/timeline")
        self.assertAlmostEqual(d["project_total_usd"], 2.5, places=6)
        self.assertIs(d["project_total_partial"], True)

    def test_no_runs_is_null_not_zero(self):
        d = self._get("/api/cost/timeline")
        self.assertEqual(d["runs"], [])
        self.assertIsNone(d["project_total_usd"])


class BucketTokenTests(_TmpLoki):
    def test_bucket_without_token_fields_sends_null_tokens(self):
        self._eff(self.loki, 1, _NO_FIELDS)
        d = self._get("/api/cost")
        for bucket in (d["by_phase"]["build"], d["by_model"]["sonnet"]):
            self.assertIsNone(bucket["input_tokens"], bucket)
            self.assertIsNone(bucket["output_tokens"], bucket)
            self.assertIsNone(bucket["cost_usd"], bucket)

    def test_bucket_with_cost_but_no_tokens_keeps_cost_nulls_tokens(self):
        self._eff(self.loki, 1, {"iteration": 1, "model": "sonnet", "phase": "build", "cost_usd": 2.5})
        b = self._get("/api/cost")["by_phase"]["build"]
        self.assertAlmostEqual(b["cost_usd"], 2.5, places=6)
        self.assertIsNone(b["input_tokens"])
        self.assertIsNone(b["output_tokens"])

    def test_measured_bucket_keeps_numbers(self):
        self._eff(self.loki, 1, _MEASURED_ZERO)
        b = self._get("/api/cost")["by_model"]["sonnet"]
        self.assertEqual((b["input_tokens"], b["output_tokens"], b["cost_usd"]), (9412, 11008, 0.0))


class FleetCostTests(_TmpLoki):
    def setUp(self):
        super().setUp()
        from dashboard import registry
        self.registry = registry
        self._saved_reg = (registry.REGISTRY_DIR, registry.REGISTRY_FILE)
        reg = Path(self.tmp) / "registry"
        registry.REGISTRY_DIR = reg
        registry.REGISTRY_FILE = reg / "projects.json"

    def tearDown(self):
        self.registry.REGISTRY_DIR, self.registry.REGISTRY_FILE = self._saved_reg
        super().tearDown()

    def _project(self, name, records=(), tracking=None):
        p = Path(self.tmp) / name
        loki = p / ".loki"
        loki.mkdir(parents=True)
        for i, rec in enumerate(records, 1):
            self._eff(loki, i, rec)
        if tracking is not None:
            (loki / "context").mkdir()
            (loki / "context" / "tracking.json").write_text(json.dumps({"totals": tracking}))
        self.registry.register_project(str(p), name=name)
        return p

    def _costs(self):
        runs = self.registry.get_fleet_runs()
        return {r["name"]: r["cost_usd"] for r in runs}, self.registry.get_fleet_summary()

    def test_unmeasured_project_is_null_not_zero(self):
        self._project("never", [_NO_FIELDS])
        self._project("zeros", [_ALL_ZERO])
        self._project("fresh-tracker", tracking={"total_input": 0, "total_output": 0, "total_cost_usd": 0.0})
        self._project("empty")
        costs, summary = self._costs()
        self.assertEqual(costs, {"never": None, "zeros": None, "fresh-tracker": None, "empty": None})
        self.assertIsNone(summary["total_cost_usd"])
        self.assertIs(summary["total_cost_partial"], False)

    def test_measured_projects_keep_numbers(self):
        self._project("paid", [_MEASURED])
        self._project("free", [_MEASURED_ZERO])
        self._project("tracked", tracking={"total_input": 10, "total_output": 5, "total_cost_usd": 1.5})
        costs, summary = self._costs()
        self.assertEqual(costs, {"paid": 2.5, "free": 0.0, "tracked": 1.5})
        self.assertAlmostEqual(summary["total_cost_usd"], 4.0, places=6)
        self.assertIs(summary["total_cost_partial"], False)

    def test_all_measured_zero_total_is_zero_not_null(self):
        self._project("free", [_MEASURED_ZERO])
        _, summary = self._costs()
        self.assertEqual(summary["total_cost_usd"], 0.0)
        self.assertIsNotNone(summary["total_cost_usd"])

    def test_mixed_total_sums_measured_and_says_partial(self):
        self._project("paid", [_MEASURED])
        self._project("never", [_NO_FIELDS])
        costs, summary = self._costs()
        self.assertEqual(costs, {"paid": 2.5, "never": None})
        self.assertAlmostEqual(summary["total_cost_usd"], 2.5, places=6)
        self.assertIs(summary["total_cost_partial"], True)

    def test_http_endpoints_send_null_and_partial(self):
        # One call per endpoint: the response models must accept null and
        # carry the partial flag (an undeclared key is dropped by FastAPI).
        self._project("paid", [_MEASURED])
        self._project("never", [_NO_FIELDS])
        client = _client()
        runs = client.get("/api/fleet/runs")
        self.assertEqual(runs.status_code, 200, runs.text)
        self.assertEqual({r["name"]: r["cost_usd"] for r in runs.json()}, {"paid": 2.5, "never": None})
        summary = client.get("/api/fleet/summary")
        self.assertEqual(summary.status_code, 200, summary.text)
        self.assertAlmostEqual(summary.json()["total_cost_usd"], 2.5, places=6)
        self.assertIs(summary.json()["total_cost_partial"], True)
        never_id = next(r["id"] for r in runs.json() if r["name"] == "never")
        one = client.get(f"/api/fleet/runs/{never_id}")
        self.assertEqual(one.status_code, 200, one.text)
        self.assertIsNone(one.json()["cost_usd"])


if __name__ == "__main__":
    unittest.main()
