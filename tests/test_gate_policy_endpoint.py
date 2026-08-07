"""Tests for the read-only gate-policy surface: GET /api/gate-policy.

The load-bearing assertion is the null-vs-zero one. An unmeasured gate MUST
serialize `audit_hits: null`, never 0, because 0 is the positive claim that the
gate ran and never fired -- the false green an absent measurement always
produces. Two separate code paths in gate_policy.assess() produce that null (one
for always-blocking gates, one for promotable ones), so both are asserted, plus
the case a future editor is most tempted to "clean up" with `.get(name, 0)`: a
ledger that is PRESENT but has no entry for this particular gate.

Exercises the FastAPI glue with a synchronous TestClient against a throwaway
.loki dir. No provider calls, no paid calls, no network.
"""

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Every gate the surface must report, listed literally rather than derived from
# gate_policy's own tables: building the expectation from the module under test
# would assert only that it equals itself.
BLOCKING_GATES = ["code_review", "mock_integrity", "mutation_integrity",
                  "static_analysis"]
PROMOTABLE_GATES = ["magic_debate", "policy_approval", "test_coverage"]

# assess() reads these from the process environment, so a runner that happens to
# export one would flip a promotable gate to blocking and flake the mode
# assertions. Cleared for every test.
PROMOTION_KNOBS = {
    "LOKI_GATE_MAGIC_DEBATE_BLOCKING": "",
    "LOKI_COV_ENFORCE": "",
    "LOKI_POLICY_APPROVAL_ENFORCE": "",
}


class GatePolicyEndpointTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi.testclient import TestClient
        from dashboard import server

        cls.server = server
        cls.client = TestClient(server.app)

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="loki-gate-policy-pytest-")
        self.loki_dir = Path(self._tmp) / ".loki"
        self.loki_dir.mkdir(parents=True, exist_ok=True)
        self._orig_get_loki_dir = self.server._get_loki_dir
        self.server._get_loki_dir = lambda: self.loki_dir
        self._env = mock.patch.dict(os.environ, PROMOTION_KNOBS)
        self._env.start()

    def tearDown(self):
        self._env.stop()
        self.server._get_loki_dir = self._orig_get_loki_dir
        shutil.rmtree(self._tmp, ignore_errors=True)

    def _write_ledger(self, counts):
        d = self.loki_dir / "quality"
        d.mkdir(parents=True, exist_ok=True)
        (d / "gate-failure-count.json").write_text(json.dumps(counts))

    def _get(self):
        resp = self.client.get("/api/gate-policy")
        self.assertEqual(resp.status_code, 200)
        return resp.json()

    def _by_name(self, body):
        return {g["gate"]: g for g in body["gates"]}

    # -- every gate is reported -------------------------------------------

    def test_reports_every_gate(self):
        gates = self._by_name(self._get())
        # Asserted individually, never as a count: a threshold cannot say WHICH
        # gate went missing.
        for name in BLOCKING_GATES + PROMOTABLE_GATES:
            self.assertIn(name, gates, f"gate {name} missing from the surface")

    def test_modes_and_promotability(self):
        gates = self._by_name(self._get())
        for name in BLOCKING_GATES:
            self.assertEqual(gates[name]["mode"], "blocking", name)
            self.assertFalse(gates[name]["promotable"], name)
            self.assertIsNone(gates[name]["promote_with"], name)
        for name in PROMOTABLE_GATES:
            self.assertEqual(gates[name]["mode"], "advisory", name)
            self.assertTrue(gates[name]["promotable"], name)
            # An advisory gate must name the knob, or the report tells an
            # operator a gate is promotable without saying how.
            self.assertTrue(gates[name]["promote_with"], name)

    # -- the null-vs-zero contract ----------------------------------------

    def test_unmeasured_gate_is_null_not_zero(self):
        """No ledger at all: every gate reports null, never 0."""
        body = self._get()
        self.assertEqual(body["ledger"], "absent")
        for name, g in self._by_name(body).items():
            self.assertIsNone(
                g["audit_hits"],
                f"{name} reported {g['audit_hits']!r} with no ledger; 0 would "
                f"falsely claim the gate ran and never fired",
            )

    def test_null_survives_json_serialization(self):
        """The key must be present and null on the wire, not dropped."""
        text = self.client.get("/api/gate-policy").text
        raw = json.loads(text)
        for g in raw["gates"]:
            self.assertIn("audit_hits", g, g["gate"])
            self.assertIsNone(g["audit_hits"], g["gate"])
        # Asserted positively against the actual wire bytes. FastAPI renders
        # compact JSON (no space after the colon), so a negative assertion on
        # '"audit_hits": 0' would be unmatchable and could never fail.
        self.assertEqual(text.count('"audit_hits":null'), len(raw["gates"]))

    def test_gate_absent_from_a_present_ledger_is_still_null(self):
        """Ledger present but silent about a gate is UNMEASURED for that gate.

        This is the case a future `.get(name, 0)` "cleanup" would break: the
        ledger exists, so a reader assumes every number in it is real.
        """
        self._write_ledger({"code_review": 3})
        body = self._get()
        self.assertEqual(body["ledger"], "present")
        gates = self._by_name(body)
        self.assertEqual(gates["code_review"]["audit_hits"], 3)
        # Covers both code paths: unmeasured blocking AND unmeasured promotable.
        for name in [n for n in BLOCKING_GATES if n != "code_review"] + PROMOTABLE_GATES:
            self.assertIsNone(gates[name]["audit_hits"], name)

    def test_real_zero_is_preserved(self):
        """A gate the ledger explicitly records as 0 keeps its measured 0.

        Guards the fix from the other direction: mapping everything to null
        would lose the real, measured "ran and never fired" claim.
        """
        self._write_ledger({"code_review": 0, "test_coverage": 2})
        gates = self._by_name(self._get())
        self.assertEqual(gates["code_review"]["audit_hits"], 0)
        self.assertEqual(gates["test_coverage"]["audit_hits"], 2)

    # -- fail open ---------------------------------------------------------

    def test_missing_ledger_does_not_raise(self):
        body = self._get()
        self.assertEqual(body["status"], "measured")
        self.assertTrue(body["available"])

    def test_malformed_ledger_does_not_raise(self):
        d = self.loki_dir / "quality"
        d.mkdir(parents=True, exist_ok=True)
        (d / "gate-failure-count.json").write_text("{not json at all")
        body = self._get()
        self.assertEqual(body["ledger"], "absent")
        for name, g in self._by_name(body).items():
            self.assertIsNone(g["audit_hits"], name)

    def test_missing_module_fails_open_not_500(self):
        with mock.patch.object(self.server, "_load_gate_policy_module",
                               return_value=None):
            resp = self.client.get("/api/gate-policy")
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertFalse(body["available"])
        self.assertEqual(body["gates"], [])
        self.assertIn("error", body)

    def test_erroring_reporter_fails_open_not_500(self):
        boom = mock.Mock()
        boom.assess.side_effect = RuntimeError("ledger on fire")
        with mock.patch.object(self.server, "_load_gate_policy_module",
                               return_value=boom):
            resp = self.client.get("/api/gate-policy")
        self.assertEqual(resp.status_code, 200)
        self.assertFalse(resp.json()["available"])

    # -- read-only ---------------------------------------------------------

    def test_no_write_route_exists(self):
        """This surface reports; it never promotes a gate."""
        for method in ("post", "put", "patch", "delete"):
            resp = getattr(self.client, method)("/api/gate-policy")
            self.assertEqual(resp.status_code, 405, method)

    def test_reading_never_promotes_a_gate(self):
        self._get()
        for var in PROMOTION_KNOBS:
            self.assertEqual(os.environ.get(var, ""), "",
                             f"reading the surface set {var}")


if __name__ == "__main__":
    unittest.main()
