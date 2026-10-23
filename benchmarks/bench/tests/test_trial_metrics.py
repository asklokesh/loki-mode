"""#348 (CW-15): per-trial false-pass, council cache share and journal reuse
metrics, each with a positive control that can make the metric fire. Fake
adapters only; no model call. Run: python3 -m pytest benchmarks/bench/tests/test_trial_metrics.py"""
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import bench_schema as schema  # noqa: E402
import runner  # noqa: E402
from adapters import _base, loki  # noqa: E402

_SPEC = {"id": "t", "prompt": "make ok", "acceptance": {"cmd": "test -f ok", "timeout_s": 10}}


def _fake(tool, *, writes, exit_status="completed", prov=None):
    def adapter(workdir, prompt_path, **kw):
        if writes:
            open(os.path.join(workdir, "ok"), "w").close()
        return _base.build_output(
            tool=tool, tool_version="1", model_used="m", duration_s=1.0,
            iterations=1, tokens_in=1, tokens_out=1, cost_usd=0.01,
            exit_status=exit_status, provenance=prov or {})
    return adapter


class TrialMetricsTest(unittest.TestCase):
    def setUp(self):
        self.fix = tempfile.mkdtemp(prefix="loki-bench-fixture-")
        open(os.path.join(self.fix, "seed"), "w").close()

    def tearDown(self):
        shutil.rmtree(self.fix, ignore_errors=True)

    def _row(self, adapter, tool):
        return runner.run_trial(adapter, _SPEC, self.fix, "m", tool, 1)

    def test_schema_pin(self):
        row = self._row(_fake("claude_code", writes=True), "claude_code")
        self.assertEqual(tuple(row["metrics"]), schema.TRIAL_METRIC_KEYS)

    def test_false_pass_control_fires(self):
        # Claims VERIFIED, produces nothing: the grader fails it.
        a = _fake("loki", writes=False, prov={"verify_verdict": "VERIFIED"})
        m = self._row(a, "loki")["metrics"]
        self.assertIs(m["claimed_done"], True)
        self.assertIs(m["false_pass"], True)

    def test_false_pass_clean_claim_is_false(self):
        a = _fake("loki", writes=True, prov={"verify_verdict": "VERIFIED"})
        self.assertIs(self._row(a, "loki")["metrics"]["false_pass"], False)

    def test_loki_already_satisfied_is_a_claim(self):
        a = _fake("loki", writes=False, prov={"verify_verdict": "ALREADY_SATISFIED"})
        m = self._row(a, "loki")["metrics"]
        self.assertIs(m["claimed_done"], True)
        self.assertIs(m["false_pass"], True)

    def test_loki_partial_is_not_a_claim(self):
        a = _fake("loki", writes=False, exit_status="error_rc_1",
                  prov={"verify_verdict": "PARTIAL"})
        m = self._row(a, "loki")["metrics"]
        self.assertIs(m["claimed_done"], False)
        self.assertIsNone(m["false_pass"])

    def test_other_tool_clean_exit_is_a_claim(self):
        m = self._row(_fake("claude_code", writes=False), "claude_code")["metrics"]
        self.assertIs(m["false_pass"], True)

    def test_unmeasured_trial_has_no_claim(self):
        a = _fake("claude_code", writes=True, exit_status="timeout")
        m = self._row(a, "claude_code")["metrics"]
        self.assertIsNone(m["claimed_done"])
        self.assertIsNone(m["false_pass"])

    def test_council_cache_share_control(self):
        phases = {"main_session": {"cache_read": 900, "cache_creation": 0},
                  "council": {"cache_read": 80, "cache_creation": 10, "input": 10},
                  "reviewer": {"cache_read": 20, "cache_creation": 0, "input": 80}}
        self.assertEqual(schema.council_cache_share(phases), 0.5)

    def test_council_cache_share_none_vs_zero(self):
        self.assertIsNone(schema.council_cache_share(
            {"main_session": {"cache_read": 5, "cache_creation": 5}}))
        self.assertIsNone(schema.council_cache_share(None))
        self.assertEqual(schema.council_cache_share(
            {"review": {"cache_read": 0, "cache_creation": 10, "input": 10}}), 0.0)

    def test_journal_reuse_control(self):
        a = _fake("loki", writes=True, prov={"journal_reuse_wall_s": 12.5})
        self.assertEqual(self._row(a, "loki")["metrics"]["journal_reuse_wall_s"], 12.5)
        b = _fake("loki", writes=True)
        self.assertIsNone(self._row(b, "loki")["metrics"]["journal_reuse_wall_s"])


class CachePassThroughTest(unittest.TestCase):
    def test_build_output_keeps_cache_tokens(self):
        out = _base.build_output(
            tool="loki", tool_version="1", model_used="m", duration_s=1,
            iterations=1, tokens_in=1, tokens_out=1, cost_usd=0.1,
            exit_status="completed", provenance={},
            cache_read_tokens=41472, cache_creation_tokens=17702)
        norm = schema.normalize_adapter_output(out)
        self.assertEqual(norm["cache_read_tokens"], 41472)
        self.assertEqual(norm["cache_creation_tokens"], 17702)

    def test_unknown_cache_stays_default(self):
        out = _base.build_output(
            tool="x", tool_version="1", model_used="m", duration_s=1,
            iterations=1, tokens_in=1, tokens_out=1, cost_usd=0.1,
            exit_status="completed", provenance={})
        self.assertEqual(schema.normalize_adapter_output(out)["cache_read_tokens"], 0)

    def test_phase_split_carries_input_tokens(self):
        class Eff:
            @staticmethod
            def read_child_ledger(_d):
                return [{"phase": "council", "cache_read_tokens": 8,
                         "cache_creation_tokens": 1, "input_tokens": 1}], 0
        got = loki._cache_tokens_by_phase(
            "x", {"cache_read_tokens": 10, "cache_creation_tokens": 2}, Eff)
        self.assertEqual(got["council"], {"cache_read": 8, "cache_creation": 1, "input": 1})
        self.assertEqual(got["main_session"], {"cache_read": 2, "cache_creation": 1})


if __name__ == "__main__":
    unittest.main()
