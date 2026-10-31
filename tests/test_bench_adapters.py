"""tests/test_bench_adapters.py -- R2 benchmark adapter behavior.

Covers:
  - adapter output validates the adapter-output schema (required keys + types).
  - NO adapter emits success/quality (the grader owns those; hard boundary).
  - every adapter runs with the CLI MOCKED (no live keys, no real processes).
  - manual adapter REQUIRES provenance and stamps verified=false.
  - token-only tools price from the shared table or report cost_usd=null.

All CLI invocations are mocked via an injectable runner; nothing here spawns a
real loki/aider/claude process or needs an API key.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import unittest

_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_ADAPTERS = os.path.join(_REPO, "benchmarks", "bench", "adapters")
_LIB = os.path.join(_REPO, "autonomy", "lib")
# efficiency_cost must be importable by _base under the plain name it uses.
if _LIB not in sys.path:
    sys.path.insert(0, _LIB)


def _load(unique_name, filename):
    """Load an adapter by file path under a UNIQUE module name.

    Using spec_from_file_location with a bench-prefixed name avoids any
    sys.modules collision with other test files that might also define a
    module literally named loki/aider/manual (collision-proof in the full
    suite regardless of collection order)."""
    path = os.path.join(_ADAPTERS, filename)
    spec = importlib.util.spec_from_file_location(unique_name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[unique_name] = mod
    spec.loader.exec_module(mod)
    return mod


# Load _base under BOTH a unique name (for our use) and the plain name the
# adapters fall back to (`import _base`) when loaded outside their package.
# Registering it in sys.modules makes that fallback resolve without putting the
# adapters dir on sys.path (so loki/aider/manual cannot collide there).
_base = _load("bench_adapter_base", "_base.py")
sys.modules.setdefault("_base", _base)
loki_adapter = _load("bench_adapter_loki", "loki.py")
aider_adapter = _load("bench_adapter_aider", "aider.py")
claude_adapter = _load("bench_adapter_claude_code", "claude_code.py")
manual_adapter = _load("bench_adapter_manual", "manual.py")

# Schema contract, defined inline so the test is self-contained. If the core
# agent's bench_schema lands later, it can be preferred; this mirrors the spec.
REQUIRED_KEYS = {
    "tool": str,
    "tool_version": (str, type(None)),
    "model_used": (str, type(None)),
    "duration_s": (float, int, type(None)),
    "iterations": (int, type(None)),
    "tokens_in": (int, type(None)),
    "tokens_out": (int, type(None)),
    "cost_usd": (float, int, type(None)),
    "exit_status": str,
    "provenance": dict,
}
FORBIDDEN_KEYS = ("success", "quality", "passed", "score", "verdict")


class _FakeProc:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def make_runner(version_out="", run_out="", run_rc=0, version_rc=0):
    """Return a subprocess.run-compatible callable that never spawns anything.

    Distinguishes a version probe (cmd[1] in --version/version) from a real run.
    """
    def _runner(cmd, **kwargs):
        is_version = len(cmd) >= 2 and cmd[1] in ("--version", "version")
        if is_version:
            return _FakeProc(returncode=version_rc, stdout=version_out)
        return _FakeProc(returncode=run_rc, stdout=run_out)
    return _runner


def assert_schema(tc, out):
    for key, typ in REQUIRED_KEYS.items():
        tc.assertIn(key, out, "missing key %s" % key)
        tc.assertIsInstance(out[key], typ, "key %s wrong type: %r" % (key, out[key]))
    for key in FORBIDDEN_KEYS:
        tc.assertNotIn(key, out, "adapter MUST NOT emit %s (grader owns it)" % key)
    # provenance must carry kind + verified.
    tc.assertIn("kind", out["provenance"])
    tc.assertIn("verified", out["provenance"])


class TestLokiLeanArm(unittest.TestCase):
    def _capture(self):
        seen = []

        def _runner(cmd, **kwargs):
            seen.append((cmd, kwargs.get("env") or {}))
            return make_runner(version_out="7.10.0", run_out="ok")(cmd, **kwargs)
        return _runner, seen

    def test_row_is_labelled_validates_and_sets_lean_env(self):
        runner, seen = self._capture()
        out = loki_adapter.run_lean(_REPO, "prd.md", runner=runner)
        assert_schema(self, out)
        self.assertEqual(out["tool"], "loki-lean")
        self.assertEqual(out["provenance"]["arm"], "loki-lean")
        self.assertEqual(out["provenance"]["lever_env"], {"LOKI_LEAN": "1"})
        self.assertEqual(_load("bench_schema_lean", "../bench_schema.py").validate_adapter_output(out), [])
        start = [(c, e) for c, e in seen if "start" in c]
        self.assertEqual(len(start), 1)
        cmd, env = start[0]
        self.assertEqual(env.get("LOKI_LEAN"), "1")
        self.assertIn("--no-pr", cmd)

    def test_run_outcome_from_exit_code_without_a_receipt(self):
        for rc, want in ((0, "VERIFIED"), (6, "PARTIAL"), (20, "PARTIAL"), (1, "FAILED")):
            out = loki_adapter.run_lean(_REPO, "prd.md", runner=make_runner(version_out="7.10.0", run_rc=rc))
            self.assertEqual((out["provenance"]["run_outcome"], out["provenance"]["run_outcome_source"]),
                             (want, "exit_code"))

    def test_run_outcome_prefers_the_receipt(self):
        import tempfile
        with tempfile.TemporaryDirectory() as wd:
            run_dir = os.path.join(wd, ".loki", "runs", "r1")
            os.makedirs(run_dir)
            with open(os.path.join(run_dir, "receipt.json"), "w") as fh:
                json.dump({"verdict": "partial"}, fh)
            loki_dir = os.path.join(wd, ".loki")
            self.assertEqual(loki_adapter._run_outcome(loki_dir, 0), ("PARTIAL", "receipt"))
            self.assertEqual(loki_adapter._run_outcome(loki_dir, 6), ("PARTIAL", "receipt"))

    def test_plain_loki_arm_never_sets_lean(self):
        runner, seen = self._capture()
        out = loki_adapter.run(_REPO, "prd.md", runner=runner)
        self.assertEqual(out["tool"], "loki")
        self.assertEqual(out["provenance"]["lever_env"], {})
        env = [e for c, e in seen if "start" in c][0]
        self.assertEqual(env.get("LOKI_LEAN"), os.environ.get("LOKI_LEAN"))

    def test_caller_levers_are_kept_beside_lean(self):
        runner, _seen = self._capture()
        out = loki_adapter.run_lean(_REPO, "prd.md", runner=runner, extra_env={"LOKI_COST_PROFILE": "lean"})
        self.assertEqual(out["provenance"]["lever_env"], {"LOKI_COST_PROFILE": "lean", "LOKI_LEAN": "1"})


class TestLokiAdapter(unittest.TestCase):
    def test_schema_and_no_success_quality(self):
        runner = make_runner(version_out="7.10.0", run_out="ok", run_rc=0)
        out = loki_adapter.run(_REPO, "prd.md", runner=runner)
        assert_schema(self, out)
        self.assertEqual(out["tool"], "loki")
        self.assertEqual(out["provenance"]["kind"], "automated")

    def test_cost_null_when_no_efficiency(self, ):
        # No .loki/metrics/efficiency in a temp dir -> cost_usd None (not 0.00).
        import tempfile
        with tempfile.TemporaryDirectory() as wd:
            runner = make_runner(version_out="7.10.0", run_out="ok")
            out = loki_adapter.run(wd, "prd.md", runner=runner)
            self.assertIsNone(out["cost_usd"])

    def test_cost_collected_from_efficiency(self):
        import tempfile
        with tempfile.TemporaryDirectory() as wd:
            eff = os.path.join(wd, ".loki", "metrics", "efficiency")
            os.makedirs(eff)
            with open(os.path.join(eff, "iteration-1.json"), "w") as fh:
                json.dump({"cost_usd": 0.42, "input_tokens": 100,
                           "output_tokens": 50, "model": "claude-opus-4"}, fh)
            runner = make_runner(version_out="7.10.0", run_out="ok")
            out = loki_adapter.run(wd, "prd.md", runner=runner)
            self.assertEqual(out["cost_usd"], 0.42)
            self.assertEqual(out["tokens_in"], 100)
            self.assertEqual(out["model_used"], "claude-opus-4")


    def test_advisor_calls_read_from_result_cost_records(self):
        import tempfile
        with tempfile.TemporaryDirectory() as wd:
            metrics = os.path.join(wd, ".loki", "metrics")
            os.makedirs(metrics)
            for i, rec in enumerate([{"total_cost_usd": 0.1, "advisor_calls": 2, "advisor_errors": 1},
                                     {"total_cost_usd": 0.1, "advisor_calls": 3},
                                     {"total_cost_usd": 0.1}]):
                with open(os.path.join(metrics, "result-cost-%d.json" % i), "w") as fh:
                    json.dump(rec, fh)
            out = loki_adapter.run(wd, "prd.md", runner=make_runner(version_out="7.10.0", run_out="ok"))
            self.assertEqual(out["provenance"]["advisor"], {"calls": 5, "errors": 1})

    def test_advisor_unknown_not_zero_without_result_cost_records(self):
        import tempfile
        with tempfile.TemporaryDirectory() as wd:
            out = loki_adapter.run(wd, "prd.md", runner=make_runner(version_out="7.10.0", run_out="ok"))
            self.assertIsNone(out["provenance"]["advisor"])


class TestAiderAdapter(unittest.TestCase):
    def test_schema_with_native_cost(self):
        run_out = "Tokens: 1,200 sent, 800 received\nCost: $0.0345 session."
        runner = make_runner(version_out="aider 0.60.0", run_out=run_out)
        out = aider_adapter.run(_REPO, "spec.md", model="gpt-5", runner=runner)
        assert_schema(self, out)
        self.assertEqual(out["tool"], "aider")
        self.assertEqual(out["tokens_in"], 1200)
        self.assertEqual(out["tokens_out"], 800)
        self.assertEqual(out["cost_usd"], 0.0345)

    def test_cost_null_when_unparseable(self):
        runner = make_runner(version_out="aider 0.60.0", run_out="no metrics here")
        out = aider_adapter.run(_REPO, "spec.md", runner=runner)
        assert_schema(self, out)
        self.assertIsNone(out["cost_usd"])
        self.assertIsNone(out["tokens_in"])

    def test_priced_from_tokens_when_no_native_cost(self):
        # Tokens present but no $ line -> price from prices.json (gpt-5 listed).
        run_out = "Tokens: 1,000,000 sent, 1,000,000 received"
        runner = make_runner(version_out="aider 0.60.0", run_out=run_out)
        out = aider_adapter.run(_REPO, "spec.md", model="gpt-5", runner=runner)
        self.assertIsNotNone(out["cost_usd"])
        # 1M in @1.25 + 1M out @10.0 = 11.25
        self.assertAlmostEqual(out["cost_usd"], 11.25, places=4)


class TestClaudeCodeAdapter(unittest.TestCase):
    def test_schema_with_json_output(self):
        payload = json.dumps({
            "total_cost_usd": 0.18, "model": "claude-sonnet-4",
            "usage": {"input_tokens": 500, "output_tokens": 200},
        })
        runner = make_runner(version_out="2.1.34", run_out=payload)
        out = claude_adapter.run(_REPO, "spec.md", runner=runner)
        assert_schema(self, out)
        self.assertEqual(out["tool"], "claude_code")
        self.assertEqual(out["cost_usd"], 0.18)
        self.assertEqual(out["tokens_in"], 500)
        self.assertEqual(out["model_used"], "claude-sonnet-4")

    def test_cost_null_when_no_json(self):
        runner = make_runner(version_out="2.1.34", run_out="plain text, no json")
        out = claude_adapter.run(_REPO, "spec.md", runner=runner)
        assert_schema(self, out)
        self.assertIsNone(out["cost_usd"])


class TestManualAdapter(unittest.TestCase):
    def _valid_entry(self):
        return {
            "tool": "devin",
            "model_used": "devin-1",
            "duration_s": 300,
            "cost_usd": 4.50,
            "provenance": {
                "operator": "alice",
                "date": "2026-05-29",
                "tool_version": "devin-2026.05",
                "run_link": "https://app.devin.ai/runs/abc",
            },
        }

    def test_valid_entry_stamps_verified_false(self):
        out = manual_adapter.run_from_entry(self._valid_entry())
        assert_schema(self, out)
        self.assertEqual(out["provenance"]["kind"], "manual")
        self.assertIs(out["provenance"]["verified"], False)
        self.assertEqual(out["tool"], "devin")
        self.assertEqual(out["cost_usd"], 4.50)

    def test_missing_provenance_raises(self):
        entry = self._valid_entry()
        del entry["provenance"]
        with self.assertRaises(manual_adapter.ManualEntryError):
            manual_adapter.run_from_entry(entry)

    def test_missing_provenance_field_raises(self):
        entry = self._valid_entry()
        del entry["provenance"]["operator"]
        with self.assertRaises(manual_adapter.ManualEntryError):
            manual_adapter.run_from_entry(entry)

    def test_missing_proof_link_raises(self):
        entry = self._valid_entry()
        del entry["provenance"]["run_link"]
        with self.assertRaises(manual_adapter.ManualEntryError):
            manual_adapter.run_from_entry(entry)

    def test_screenshot_satisfies_proof(self):
        entry = self._valid_entry()
        del entry["provenance"]["run_link"]
        entry["provenance"]["run_screenshot"] = "artifacts/devin-run.png"
        out = manual_adapter.run_from_entry(entry)
        self.assertIs(out["provenance"]["verified"], False)

    def test_never_fabricates_absent_numbers(self):
        entry = self._valid_entry()
        # no tokens supplied -> must stay null, never 0
        out = manual_adapter.run_from_entry(entry)
        self.assertIsNone(out["tokens_in"])
        self.assertIsNone(out["tokens_out"])

    def test_run_from_file(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "entry.json")
            with open(p, "w") as fh:
                json.dump(self._valid_entry(), fh)
            out = manual_adapter.run(manual_entry=p)
            self.assertEqual(out["tool"], "devin")


class TestNoAdapterEmitsSuccessOrQuality(unittest.TestCase):
    """Belt-and-suspenders: even if a caller passes success/quality, the
    builder strips them. Proves the boundary structurally."""

    def test_build_output_strips_forbidden(self):
        out = _base.build_output(
            tool="x", tool_version="1", model_used="m", duration_s=1.0,
            iterations=1, tokens_in=1, tokens_out=1, cost_usd=0.1,
            exit_status="completed", provenance={"kind": "automated", "verified": True},
            success=True, quality=0.99, score=100,
        )
        for k in FORBIDDEN_KEYS:
            self.assertNotIn(k, out)


if __name__ == "__main__":
    unittest.main()
