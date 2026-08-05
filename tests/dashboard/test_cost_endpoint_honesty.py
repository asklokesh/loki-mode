"""The dashboard cost endpoints must not turn "unmeasured" into "free".

THE ARC THIS EXTENDS. One defect -- a provider writing no token usage --
surfaced independently on six surfaces, and each turned "we did not measure"
into "it cost nothing":

    v8.51.0  codex dispatch   recorded no tokens at all
    v8.52.0  receipt          {"usd": 0.0, "available": true}
    v8.53.0  the PROMPT       "$0.00" per iteration, steering the agent
    v8.54.0  the verifier     never checked cost, so the claim passed
    v8.69.0  cost summary     the per-run reader
    v8.72.0 + v8.74.0  kpis.ts   cost, then tokens

dashboard/server.py was never audited for this class. Both of its cost readers
had it, in different ways:

  - /api/cost           reported estimated_cost_usd 0.0 and total_tokens 0, and
                        carried no "was this measured" field at all.
  - /api/cost/timeline  had the right FIELD (cost_recorded) but set it True for
                        any parseable file, so the all-zero records a real
                        pre-v8.51.0 codex run wrote reported $0.00 with
                        cost_recorded True -- the endpoint asserting the run was
                        FREE, which is the exact lie the receipt fix removed.

The canonical predicate is record_is_measured() in
autonomy/lib/efficiency_cost.py. dashboard/server.py mirrors it as
_record_is_measured(); this asserts the two agree rather than restating a
second rule.

BOTH DIRECTIONS ARE ASSERTED. A guard so strict it blanked genuine data would
be dishonest in the opposite direction, and a falsy check (`if cost:`) does
exactly that because 0 is falsy -- the trap hit in v8.72.0. A MEASURED zero
(real observed tokens, provider reported $0) must still render 0.0, never null.
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
sys.path.insert(0, str(_ROOT / "autonomy" / "lib"))


class _ForceLokiDir:
    """Pin dashboard.server._get_loki_dir() to a tmp dir (house pattern)."""

    def __init__(self, tmpdir: str):
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


# The exact shape a real FireLater run produced before v8.51.0: records
# present and parseable, every measured field zero. Byte-compatible with
# _UNMEASURED in tests/test_cost_honesty_end_to_end.py.
_UNMEASURED = {
    "iteration": 1, "model": "sonnet", "phase": "build",
    "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0,
    "cache_creation_tokens": 0, "cost_usd": 0,
}

# Real observed tokens, provider genuinely reported $0 (free tier / cached).
# This is a MEASUREMENT whose value is zero -- the case a falsy guard breaks.
_MEASURED_ZERO = dict(_UNMEASURED, input_tokens=9412, cache_read_tokens=11008,
                      cost_usd=0.0)

_MEASURED_NONZERO = dict(_UNMEASURED, input_tokens=1000, output_tokens=500,
                         cost_usd=0.05)


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="loki-cost-honesty-")
        self.eff = Path(self.tmp) / "metrics" / "efficiency"
        self.eff.mkdir(parents=True, exist_ok=True)
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

    def _cost(self):
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/cost")
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()

    def _timeline(self):
        with _ForceLokiDir(self.tmp):
            resp = _client().get("/api/cost/timeline")
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()["current_run"]


class PredicateMirrorsCanonical(_Base):
    """The dashboard copy must agree with autonomy/lib, field for field."""

    def test_field_list_matches_canonical(self):
        import efficiency_cost as canonical
        from dashboard import server as _server
        self.assertEqual(
            tuple(_server._MEASURED_FIELDS), tuple(canonical._MEASURED_FIELDS),
            "dashboard predicate drifted from the canonical field list")

    def test_agrees_with_canonical_on_every_shape(self):
        import efficiency_cost as canonical
        from dashboard import server as _server
        shapes = [
            _UNMEASURED, _MEASURED_ZERO, _MEASURED_NONZERO, {},
            {"cost_usd": 0.0}, {"cost_usd": 0.01}, {"output_tokens": 3},
            # A bool must not count as a measurement (True == 1 in Python).
            {"input_tokens": True}, {"cost_usd": False},
            # Non-dicts are not records.
            [], None, "x", 7,
        ]
        for shape in shapes:
            self.assertEqual(
                _server._record_is_measured(shape),
                canonical.record_is_measured(shape),
                f"predicates disagree on {shape!r}")


class UnmeasuredReadsUnknown(_Base):
    """Direction 1: never fabricate a zero."""

    def test_api_cost_all_zero_records_are_null_not_free(self):
        self._write_eff("iteration-001.json", _UNMEASURED)
        d = self._cost()
        self.assertFalse(d["cost_recorded"])
        self.assertIsNone(d["estimated_cost_usd"],
                          "/api/cost claims an unmeasured run cost $0.00")
        self.assertIsNone(d["total_tokens"])
        self.assertIsNone(d["total_input_tokens"])
        self.assertIsNone(d["total_output_tokens"])

    def test_timeline_all_zero_records_are_null_not_free(self):
        self._write_eff("iteration-001.json", _UNMEASURED)
        t = self._timeline()
        self.assertFalse(t["cost_recorded"],
                         "a present file was treated as a measurement")
        self.assertIsNone(t["total_usd"])

    def test_no_records_at_all_is_null(self):
        d = self._cost()
        self.assertFalse(d["cost_recorded"])
        self.assertIsNone(d["estimated_cost_usd"])
        self.assertIsNone(d["total_tokens"])

    def test_many_unmeasured_records_stay_null(self):
        for i in range(1, 5):
            self._write_eff(f"iteration-00{i}.json", dict(_UNMEASURED, iteration=i))
        d = self._cost()
        self.assertIsNone(d["estimated_cost_usd"])
        self.assertIsNone(self._timeline()["total_usd"])


class MeasuredZeroStillRendersZero(_Base):
    """Direction 2: a real zero must NOT be blanked (the v8.72.0 trap).

    0 is falsy, so a `if estimated_cost:` guard would null these out and
    permanently blank a genuine free-tier measurement.
    """

    def test_api_cost_measured_zero_renders_zero(self):
        self._write_eff("iteration-001.json", _MEASURED_ZERO)
        d = self._cost()
        self.assertTrue(d["cost_recorded"])
        self.assertIsNotNone(d["estimated_cost_usd"],
                             "a genuine measured $0 was blanked out")
        self.assertEqual(d["estimated_cost_usd"], 0.0)
        # The tokens that PROVE it was measured must survive too.
        self.assertEqual(d["total_input_tokens"], 9412)
        self.assertEqual(d["total_tokens"], 9412 + 11008)

    def test_timeline_measured_zero_renders_zero(self):
        self._write_eff("iteration-001.json", _MEASURED_ZERO)
        t = self._timeline()
        self.assertTrue(t["cost_recorded"])
        self.assertIsNotNone(t["total_usd"])
        self.assertEqual(t["total_usd"], 0.0)

    def test_measured_records_summing_to_zero_stay_zero(self):
        """The aggregate is zero but every record was measured."""
        self._write_eff("iteration-001.json", dict(_MEASURED_ZERO, iteration=1))
        self._write_eff("iteration-002.json", dict(_MEASURED_ZERO, iteration=2))
        d = self._cost()
        self.assertTrue(d["cost_recorded"])
        self.assertEqual(d["estimated_cost_usd"], 0.0)

    def test_one_measured_record_rescues_a_batch(self):
        """Measurement is per-record: one observed value means we measured."""
        self._write_eff("iteration-001.json", dict(_UNMEASURED, iteration=1))
        self._write_eff("iteration-002.json", dict(_MEASURED_ZERO, iteration=2))
        d = self._cost()
        self.assertTrue(d["cost_recorded"])
        self.assertEqual(d["estimated_cost_usd"], 0.0)


class MeasuredNonZeroUnchanged(_Base):
    """Direction 3: the normal path must be byte-identical to before."""

    def test_api_cost_reports_real_spend(self):
        self._write_eff("iteration-001.json", _MEASURED_NONZERO)
        d = self._cost()
        self.assertTrue(d["cost_recorded"])
        self.assertAlmostEqual(d["estimated_cost_usd"], 0.05, places=6)
        self.assertEqual(d["total_input_tokens"], 1000)
        self.assertEqual(d["total_output_tokens"], 500)

    def test_timeline_reports_real_spend(self):
        self._write_eff("iteration-001.json", dict(_MEASURED_NONZERO, iteration=1))
        self._write_eff("iteration-002.json", dict(
            _MEASURED_NONZERO, iteration=2, cost_usd=0.10))
        t = self._timeline()
        self.assertTrue(t["cost_recorded"])
        self.assertAlmostEqual(t["total_usd"], 0.15, places=6)

    def test_three_readers_still_agree(self):
        """The invariant test_cost_timeline_endpoint.py locks down."""
        from dashboard import server as _server
        self._write_eff("iteration-001.json", dict(_MEASURED_NONZERO, iteration=1))
        self._write_eff("iteration-002.json", dict(
            _MEASURED_NONZERO, iteration=2, cost_usd=0.10))
        with _ForceLokiDir(self.tmp):
            snap = _server._compute_cost_snapshot()
            budget = _server._compute_budget_snapshot(Path(self.tmp))
            timeline = _server._compute_cost_timeline()
        self.assertAlmostEqual(snap["estimated_cost_usd"], 0.15, places=6)
        self.assertAlmostEqual(budget["used"], 0.15, places=6)
        self.assertAlmostEqual(
            timeline["current_run"]["total_usd"], 0.15, places=6)


if __name__ == "__main__":
    unittest.main()
