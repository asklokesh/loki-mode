"""A replay that quietly loses data reports a cleaner run than happened.

tools/run-replay.py reconstructs a completed run from artifacts alone. Its
value rests entirely on the reconstruction being FAITHFUL, so the properties
asserted here are the honesty properties, not the formatting:

  - a corrupt line is COUNTED and REPORTED, never silently dropped
    (scripts/measure-run.sh skips bad lines by design; a corrupt tail
    therefore vanishes without a trace, which is the defect this tool exists
    to not repeat)
  - an unmeasured cost reads UNKNOWN, never 0 -- on BOTH surfaces, since a
    JSON consumer reading 0.0 is the same lie in a different font
  - a stage that never emitted reads "not recorded", while a genuine 0s
    duration is preserved as real data. Those are different claims and the
    naive falsy check collapses them.
  - an empty events.jsonl exits non-zero rather than rendering an
    empty-but-successful-looking replay

Fixtures use the exact event shapes emit_event_json / emit_stage_complete
write (autonomy/run.sh:2435, :2486) and the exact efficiency record shape a
real run produced.
"""

import importlib.util
import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]

_spec = importlib.util.spec_from_file_location(
    "run_replay", _ROOT / "tools" / "run-replay.py")
_rr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rr)


def _event(etype, **data):
    return json.dumps(
        {"timestamp": "2026-07-20T19:42:12Z", "type": etype, "data": data})


def _stage(name, status, secs, iteration):
    return _event("stage_complete", stage=name, status=status,
                  duration_s=secs, iteration=iteration)


# The exact shape a real run wrote (autonomi-workspaces/06f97afc, iteration-1).
def _eff(iteration, usd, inp=106, out=15241, cache=439834):
    return {
        "iteration": iteration, "model": "haiku", "phase": "BUILDING",
        "duration_ms": 161000, "provider": "claude", "status": "completed",
        "input_tokens": inp, "output_tokens": out,
        "cache_read_tokens": cache, "cache_creation_tokens": 28187,
        "cost_usd": usd, "timestamp": "2026-07-20T19:42:09Z",
    }


# Records present, every field zero: the FireLater shape that made an
# unmeasured run report as free.
_UNMEASURED = {
    "iteration": 2, "model": "gpt-5.6-sol", "input_tokens": 0,
    "output_tokens": 0, "cache_read_tokens": 0, "cache_creation_tokens": 0,
    "cost_usd": 0.0, "status": "completed",
}


class _Workspace:
    """Throwaway workspace holding a .loki/ tree."""

    def __init__(self, lines, efficiency=None):
        self._tmp = tempfile.TemporaryDirectory()
        self.path = self._tmp.name
        loki = os.path.join(self.path, ".loki")
        os.makedirs(loki, exist_ok=True)
        if lines is not None:
            with open(os.path.join(loki, "events.jsonl"), "w") as fh:
                fh.write("\n".join(lines) + ("\n" if lines else ""))
        for n, rec in (efficiency or {}).items():
            d = os.path.join(loki, "metrics", "efficiency")
            os.makedirs(d, exist_ok=True)
            with open(os.path.join(d, "iteration-%d.json" % n), "w") as fh:
                json.dump(rec, fh)

    def cleanup(self):
        self._tmp.cleanup()


def _render(ws):
    return _rr.render(_rr.build_replay(ws.path))


class MultiIterationReplay(unittest.TestCase):
    """A real-shaped multi-iteration run reconstructs correctly."""

    def setUp(self):
        self.ws = _Workspace(
            [
                _event("iteration_start", iteration=1),
                _stage("static_analysis", "pass", 1, 1),
                _stage("test_suite", "pass", 4, 1),
                _stage("code_review", "fail", 57, 1),
                _event("iteration_complete", iteration=1, status="completed",
                       exitCode=0, provider="claude"),
                _stage("static_analysis", "pass", 2, 2),
                _stage("test_suite", "pass", 3, 2),
                _stage("code_review", "fail", 68, 2),
                _event("iteration_complete", iteration=2, status="completed",
                       exitCode=0, provider="claude"),
            ],
            efficiency={1: _eff(1, 0.1767), 2: _eff(2, 0.1850)},
        )
        self.addCleanup(self.ws.cleanup)
        self.rep = _rr.build_replay(self.ws.path)

    def test_both_iterations_reconstructed(self):
        self.assertEqual([it["iteration"] for it in self.rep["iterations"]],
                         [1, 2])

    def test_stage_durations_survive(self):
        it1 = self.rep["iterations"][0]
        self.assertEqual(it1["stages"]["code_review"]["duration_s"], 57.0)
        self.assertEqual(it1["stages"]["code_review"]["status"], "fail")

    def test_slowest_stage_is_summed_across_iterations(self):
        self.assertEqual(self.rep["slowest_stage"]["stage"], "code_review")
        self.assertEqual(self.rep["slowest_stage"]["total_s"], 125.0)

    def test_cost_climb_is_detected(self):
        it2 = self.rep["iterations"][1]
        self.assertTrue(it2["cost_comparable"])
        self.assertAlmostEqual(it2["cost_delta_usd"], 0.0083, places=6)
        self.assertIn("climbed", _render(self.ws))

    def test_repeat_gate_failure_is_named(self):
        self.assertEqual(self.rep["iterations"][1]["gates_failed_again"],
                         ["code_review"])
        self.assertIn("REPEAT FAILURE", _render(self.ws))

    def test_largest_cost_contributor(self):
        lg = self.rep["largest_cost_contributor"]
        self.assertEqual(lg["iteration"], 2)
        self.assertAlmostEqual(lg["usd"], 0.1850, places=6)

    def test_declares_it_spent_nothing(self):
        out = _render(self.ws)
        self.assertIn("Nothing was started and nothing was spent", out)
        self.assertTrue(self.rep["read_only"])


class CorruptLinesAreCounted(unittest.TestCase):
    """A truncated tail must not vanish. This is the load-bearing one."""

    def setUp(self):
        self.ws = _Workspace([
            _stage("test_suite", "pass", 4, 1),
            '{"timestamp":"2026-07-20T19:42:12Z","type":"stage_comp',  # cut
            _event("iteration_complete", iteration=1, status="completed"),
            "not json at all",
        ])
        self.addCleanup(self.ws.cleanup)

    def test_exact_skipped_count_in_json(self):
        # The EXACT count, not the presence of a label: a loose check would
        # survive the very mutation this guards against.
        self.assertEqual(_rr.build_replay(self.ws.path)["skipped_lines"], 2)

    def test_skipped_count_is_surfaced_to_a_human(self):
        out = _render(self.ws)
        self.assertIn("UNPARSEABLE LINES SKIPPED: 2", out)

    def test_clean_run_reports_zero_explicitly(self):
        ws = _Workspace([_event("iteration_complete", iteration=1,
                                status="completed")])
        self.addCleanup(ws.cleanup)
        self.assertEqual(_rr.build_replay(ws.path)["skipped_lines"], 0)
        self.assertIn("skipped: 0", _render(ws))

    def test_fully_corrupt_file_still_reports_the_count(self):
        # The worst case: nothing parses. It must exit non-zero AND say how
        # much it lost, or the loss is invisible.
        ws = _Workspace(["garbage", "{broken", "also not json"])
        self.addCleanup(ws.cleanup)
        err = io.StringIO()
        with self.assertRaises(SystemExit) as cm:
            sys.stderr, real = err, sys.stderr
            try:
                _rr.build_replay(ws.path)
            finally:
                sys.stderr = real
        self.assertNotEqual(cm.exception.code, 0)
        self.assertIn("3 unparseable line(s) skipped", err.getvalue())


class UnmeasuredCostReadsUnknown(unittest.TestCase):
    """Unmeasured is not free. Never $0.00, on either surface."""

    def setUp(self):
        self.ws = _Workspace(
            [
                _stage("test_suite", "pass", 4, 1),
                _event("iteration_complete", iteration=1, status="completed"),
                _stage("test_suite", "pass", 4, 2),
                _event("iteration_complete", iteration=2, status="completed"),
            ],
            # Iteration 1 measured; iteration 2 has a record that is all zeros.
            efficiency={1: _eff(1, 0.1767), 2: _UNMEASURED},
        )
        self.addCleanup(self.ws.cleanup)
        self.rep = _rr.build_replay(self.ws.path)

    def test_json_emits_null_not_zero(self):
        self.assertIsNone(self.rep["iterations"][1]["cost"])
        blob = json.dumps(self.rep)
        self.assertIn("null", blob)

    def test_human_output_says_not_recorded_not_a_dollar_zero(self):
        out = _render(self.ws)
        self.assertIn("cost not recorded", out)
        self.assertNotIn("$0.0000", out)

    def test_missing_record_entirely_also_reads_unknown(self):
        ws = _Workspace([
            _stage("test_suite", "pass", 4, 1),
            _event("iteration_complete", iteration=1, status="completed"),
        ])
        self.addCleanup(ws.cleanup)
        rep = _rr.build_replay(ws.path)
        self.assertIsNone(rep["iterations"][0]["cost"])
        self.assertIsNone(rep["largest_cost_contributor"])
        self.assertIsNone(rep["total_cost_usd"])
        self.assertIn("cost not recorded for any iteration", _render(ws))

    def test_no_delta_against_an_unmeasured_neighbour(self):
        # A delta computed against an unmeasured iteration is a fabricated
        # comparison.
        it2 = self.rep["iterations"][1]
        self.assertFalse(it2["cost_comparable"])
        self.assertIsNone(it2["cost_delta_usd"])
        self.assertIn("cannot compare", _render(self.ws))

    def test_partial_measurement_is_disclosed_as_a_subset_claim(self):
        lg = self.rep["largest_cost_contributor"]
        self.assertEqual(lg["measured_iterations"], 1)
        self.assertEqual(lg["total_iterations"], 2)
        self.assertIn("largest among the 1 of 2", _render(self.ws))


class TruncatedAtALineBoundary(unittest.TestCase):
    """A killed run truncates CLEANLY, so skipped_lines cannot catch it.

    Every line parses, the recording looks whole, and an entire iteration is
    gone. The efficiency records are the second witness that it existed.
    """

    def setUp(self):
        self.ws = _Workspace(
            [
                _stage("test_suite", "pass", 4, 1),
                _event("iteration_complete", iteration=1, status="completed"),
                _stage("test_suite", "pass", 4, 2),
                _event("iteration_complete", iteration=2, status="completed"),
                # ...and then the process died. No iteration-3 events at all.
            ],
            efficiency={1: _eff(1, 0.10), 2: _eff(2, 0.20),
                        3: _eff(3, 0.90)},
        )
        self.addCleanup(self.ws.cleanup)
        self.rep = _rr.build_replay(self.ws.path)

    def test_the_line_boundary_truncation_is_invisible_to_the_skip_count(self):
        # Proves the premise: the skip counter genuinely cannot see this.
        self.assertEqual(self.rep["skipped_lines"], 0)

    def test_iteration_known_only_from_its_cost_record_is_not_lost(self):
        self.assertEqual([it["iteration"] for it in self.rep["iterations"]],
                         [1, 2, 3])

    def test_its_cost_reaches_the_headline_claims(self):
        # Without the second witness this reads iteration 2 / $0.30, and both
        # headline numbers are simply wrong with no signal.
        self.assertEqual(self.rep["largest_cost_contributor"]["iteration"], 3)
        self.assertAlmostEqual(self.rep["total_cost_usd"], 1.20, places=6)

    def test_its_stages_read_not_recorded_not_zero(self):
        it3 = self.rep["iterations"][2]
        self.assertIsNone(it3["stages"]["test_suite"])
        self.assertEqual(it3["stages_not_recorded"], ["test_suite"])
        self.assertIn("not recorded", _render(self.ws))


class DeltaNeverSpansAnUnmeasuredGap(unittest.TestCase):
    """measured / unmeasured / measured must not compare 3 against 1."""

    def setUp(self):
        self.ws = _Workspace(
            [
                _stage("test_suite", "pass", 4, 1),
                _event("iteration_complete", iteration=1, status="completed"),
                _stage("test_suite", "pass", 4, 2),
                _event("iteration_complete", iteration=2, status="completed"),
                _stage("test_suite", "pass", 4, 3),
                _event("iteration_complete", iteration=3, status="completed"),
            ],
            efficiency={1: _eff(1, 0.10), 2: _UNMEASURED, 3: _eff(3, 0.90)},
        )
        self.addCleanup(self.ws.cleanup)
        self.rep = _rr.build_replay(self.ws.path)

    def test_no_delta_is_computed_across_the_gap(self):
        it3 = self.rep["iterations"][2]
        self.assertFalse(it3["cost_comparable"])
        self.assertIsNone(it3["cost_delta_usd"])

    def test_no_climbed_claim_is_printed(self):
        # "climbed $+0.80 vs previous iteration" would be false: the previous
        # iteration has no recorded cost at all.
        out = _render(self.ws)
        self.assertNotIn("climbed", out)
        self.assertIn("previous iteration's cost not recorded", out)


class AbsentStageIsNotZeroSeconds(unittest.TestCase):
    """Absent and instant are different claims."""

    def setUp(self):
        self.ws = _Workspace([
            _stage("static_analysis", "pass", 1, 1),
            _stage("security_scan", "pass", 0, 1),   # genuine 0s, real data
            _stage("code_review", "fail", 57, 1),
            _event("iteration_complete", iteration=1, status="completed"),
            # Iteration 2 never ran code_review at all.
            _stage("static_analysis", "pass", 2, 2),
            _stage("security_scan", "pass", 0, 2),
            _event("iteration_complete", iteration=2, status="completed"),
        ])
        self.addCleanup(self.ws.cleanup)
        self.rep = _rr.build_replay(self.ws.path)

    def test_absent_stage_is_null_not_zero(self):
        it2 = self.rep["iterations"][1]
        self.assertIsNone(it2["stages"]["code_review"])
        self.assertEqual(it2["stages_not_recorded"], ["code_review"])

    def test_absent_stage_renders_as_not_recorded(self):
        out = _render(self.ws)
        self.assertIn("code_review", out)
        self.assertIn("not recorded", out)

    def test_genuine_zero_duration_is_preserved_as_real_data(self):
        # The other direction: filtering on falsy duration_s would convert a
        # fast gate's real 0s into "not recorded", which is its own lie.
        it1 = self.rep["iterations"][0]
        self.assertIsNotNone(it1["stages"]["security_scan"])
        self.assertEqual(it1["stages"]["security_scan"]["duration_s"], 0.0)
        self.assertNotIn("security_scan", it1["stages_not_recorded"])

    def test_absent_stage_does_not_inflate_the_slowest_stage_total(self):
        self.assertEqual(self.rep["slowest_stage"]["stage"], "code_review")
        self.assertEqual(self.rep["slowest_stage"]["total_s"], 57.0)


class NoDataExitsNonZero(unittest.TestCase):
    """An empty replay must not look like a successful one."""

    def _expect_exit(self, ws):
        err = io.StringIO()
        with self.assertRaises(SystemExit) as cm:
            sys.stderr, real = err, sys.stderr
            try:
                _rr.build_replay(ws.path)
            finally:
                sys.stderr = real
        self.assertNotEqual(cm.exception.code, 0)
        return err.getvalue()

    def test_empty_events_file(self):
        ws = _Workspace([])
        self.addCleanup(ws.cleanup)
        self.assertIn("nothing to replay", self._expect_exit(ws))

    def test_missing_events_file(self):
        ws = _Workspace(None)
        self.addCleanup(ws.cleanup)
        self.assertIn("no events at", self._expect_exit(ws))

    def test_events_with_no_iteration_records(self):
        ws = _Workspace([_event("session_start", provider="claude")])
        self.addCleanup(ws.cleanup)
        self.assertIn("nothing to replay", self._expect_exit(ws))

    def test_main_returns_zero_on_a_real_run(self):
        ws = _Workspace([
            _stage("test_suite", "pass", 4, 1),
            _event("iteration_complete", iteration=1, status="completed"),
        ])
        self.addCleanup(ws.cleanup)
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(_rr.main(["--json", ws.path]), 0)
        self.assertEqual(json.loads(buf.getvalue())["skipped_lines"], 0)


if __name__ == "__main__":
    unittest.main()
