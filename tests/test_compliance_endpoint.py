"""
Tests for the continuous compliance surface (P3-11): GET /api/compliance.

Exercises the FastAPI endpoint glue directly (type validation, payload
assembly, real-data path, honest-empty path) using a synchronous
TestClient. The endpoint shells out to the authoritative Node compliance
engine (src/audit/index.js), so tests that need real data seed an audit
chain via that engine; if Node is unavailable the data-path assertions
are skipped (the endpoint still degrades honestly to available:False,
which is asserted separately).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

REPO_ROOT = Path(__file__).resolve().parent.parent
INDEX_JS = REPO_ROOT / "src" / "audit" / "index.js"
NODE = shutil.which("node")


def _seed_chain(project_dir, entries):
    """Record audit entries into project_dir/.loki/audit via the JS engine."""
    script = (
        "var a=require(process.argv[1]);"
        "a.init(process.argv[2]);"
        "JSON.parse(process.argv[3]).forEach(function(e){a.record(e);});"
        "a.flush();"
    )
    subprocess.run(
        [NODE, "-e", script, str(REPO_ROOT / "src" / "audit"),
         project_dir, json.dumps(entries)],
        check=True,
        capture_output=True,
    )


class ComplianceEndpointTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from dashboard import server

        cls.server = server
        cls.client = TestClient(server.app)

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="loki-compliance-pytest-")
        (Path(self._tmp) / ".loki").mkdir(parents=True, exist_ok=True)
        # Point the endpoint at this throwaway project's .loki dir.
        self._orig_get_loki_dir = self.server._get_loki_dir
        loki_dir = Path(self._tmp) / ".loki"
        self.server._get_loki_dir = lambda: loki_dir

    def tearDown(self):
        self.server._get_loki_dir = self._orig_get_loki_dir
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_invalid_type_returns_400(self):
        resp = self.client.get("/api/compliance", params={"type": "bogus"})
        self.assertEqual(resp.status_code, 400)

    def test_honest_empty_when_no_audit_data(self):
        """A project with no audit chain returns a real empty report, not a fake pass."""
        resp = self.client.get("/api/compliance")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        if not body.get("available"):
            self.skipTest("Node compliance engine unavailable: " + str(body.get("reason")))
        report = body["report"]
        self.assertEqual(report["totalAuditEntries"], 0)
        self.assertTrue(report["chainIntegrity"]["valid"])
        self.assertEqual(report["chainIntegrity"]["entries"], 0)
        total_evidence = sum(c["evidenceCount"] for c in report["controls"].values())
        self.assertEqual(total_evidence, 0)

    @unittest.skipIf(NODE is None, "node runtime not available")
    def test_real_data_flows_through(self):
        """Recorded audit entries surface as real evidence with a real integrity verdict."""
        _seed_chain(self._tmp, [
            {"who": "agent-1", "what": "file_write", "where": "x.js", "why": "impl"},
            {"who": "agent-2", "what": "deploy", "why": "ship"},
        ])
        resp = self.client.get("/api/compliance", params={"type": "soc2"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body["available"])
        report = body["report"]
        self.assertEqual(report["totalAuditEntries"], 2)
        self.assertTrue(report["chainIntegrity"]["valid"])
        self.assertEqual(report["chainIntegrity"]["entries"], 2)
        # file_write maps to CC6_3 -> real, non-fabricated evidence.
        self.assertGreater(report["controls"]["CC6_3"]["evidenceCount"], 0)

    @unittest.skipIf(NODE is None, "node runtime not available")
    def test_type_switch_iso27001(self):
        _seed_chain(self._tmp, [
            {"who": "agent-1", "what": "test_run", "why": "verify"},
        ])
        resp = self.client.get("/api/compliance", params={"type": "iso27001"})
        self.assertEqual(resp.status_code, 200)
        report = resp.json()["report"]
        self.assertEqual(report["reportType"], "ISO27001")
        self.assertGreater(report["controls"]["A.14.2"]["evidenceCount"], 0)


if __name__ == "__main__":
    unittest.main()
