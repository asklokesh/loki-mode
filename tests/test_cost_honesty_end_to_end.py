"""One missing measurement must not become four different lies.

THE ARC THIS LOCKS DOWN. A single defect -- codex writing no token usage --
surfaced independently on four surfaces, and each one turned "we did not
measure" into "it was free":

    v8.51.0  codex dispatch   recorded no tokens at all
    v8.52.0  receipt          {"usd": 0.0, "available": true}
    v8.53.0  the PROMPT       "$0.00" per iteration, steering the agent
    v8.54.0  the verifier     never checked cost, so the claim passed

Each was fixed in isolation and each has its own unit test. None of those tests
can see a FIFTH surface drifting, or one of the four regressing in a way its
neighbours mask. This asserts the property they share:

    An unmeasured cost reads as UNKNOWN on every surface. Never as $0.00.

Free and unmeasured are different claims. Only one of them is honest, and the
Evidence Receipt -- the artifact no competitor ships -- is worth nothing if it
can certify the dishonest one. A real receipt did exactly that, with a VALID
integrity hash.

Both directions are asserted. A guard so strict it suppressed genuine data
would blank the cost surface permanently, which is its own dishonesty and would
make the 20x cost-per-issue spread unmeasurable again.
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_LIB = _ROOT / "autonomy" / "lib"
sys.path.insert(0, str(_LIB))

from efficiency_cost import collect_efficiency  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "proof_verify", _LIB / "proof-verify.py")
_pv = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_pv)

_TREND = _LIB / "iteration_attribution.py"

_MEASURED = {
    "iteration": 1, "input_tokens": 9412, "output_tokens": 23,
    "cache_read_tokens": 11008, "cache_creation_tokens": 0,
    "cost_usd": 0.018719, "model": "gpt-5.6-sol",
    "duration_ms": 90000, "status": "completed",
}

# The exact shape a real FireLater run produced before v8.51.0: records present,
# every field zero.
_UNMEASURED = {
    "iteration": 1, "input_tokens": 0, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_creation_tokens": 0,
    "cost_usd": 0, "model": "high",
    "duration_ms": 90000, "status": "completed",
}


def _workspace(record):
    d = tempfile.mkdtemp()
    eff = pathlib.Path(d) / ".loki" / "metrics" / "efficiency"
    eff.mkdir(parents=True, exist_ok=True)
    (eff / "iteration-1.json").write_text(json.dumps(record), encoding="utf-8")
    return pathlib.Path(d) / ".loki"


def _trend(loki_dir):
    return subprocess.run(
        [sys.executable, str(_TREND), "--loki-dir", str(loki_dir),
         "--prompt-block"],
        capture_output=True, text=True, timeout=60).stdout


class UnmeasuredIsNeverFree(unittest.TestCase):
    """The direction that shipped a false claim to a user."""

    def setUp(self):
        self.loki = _workspace(_UNMEASURED)

    def test_receipt_reports_unknown(self):
        cost, _ = collect_efficiency(str(self.loki))
        self.assertIsNone(cost["usd"], "the receipt claims the run was free")
        self.assertFalse(cost["available"])

    def test_prompt_does_not_show_a_dollar_figure(self):
        """The prompt STEERS the agent, so this one is not a display bug."""
        out = _trend(self.loki)
        self.assertNotIn(
            "$0.00", out,
            "the prompt tells the agent its work is free, which survives into "
            "every downstream decision it makes about effort")
        self.assertIn("iter 1", out, "the whole steer was suppressed")
        self.assertIn("90s", out, "duration was dropped along with the cost")

    def test_verifier_rejects_the_free_claim(self):
        r = _pv.verify_integrity({
            "verification": {"hash": "x"},
            "cost": {"usd": 0.0, "input_tokens": 0, "output_tokens": 0,
                     "cache_read_tokens": 0, "cache_creation_tokens": 0,
                     "available": True},
            "facts": {}, "honesty": {},
        })
        self.assertFalse(
            r["cost_coherent"],
            "a receipt asserting usd=0.0 with available=true verified clean")
        self.assertFalse(r["ok"])


class MeasuredIsStillReported(unittest.TestCase):
    """The opposite error: over-strict guards would blank cost permanently."""

    def setUp(self):
        self.loki = _workspace(_MEASURED)

    def test_receipt_carries_the_real_cost(self):
        cost, model = collect_efficiency(str(self.loki))
        self.assertTrue(cost["available"])
        self.assertAlmostEqual(cost["usd"], 0.0187, places=4)
        self.assertEqual(model, "gpt-5.6-sol")

    def test_prompt_shows_the_real_cost(self):
        out = _trend(self.loki)
        self.assertIn("$0.02", out, "a genuine measured cost was suppressed")
        self.assertIn("cache", out, "the cache ratio steer was lost")

    def test_verifier_accepts_a_real_measurement(self):
        r = _pv.verify_integrity({
            "verification": {"hash": "x"},
            "cost": {"usd": 0.0187, "input_tokens": 9412, "output_tokens": 23,
                     "cache_read_tokens": 11008, "cache_creation_tokens": 0,
                     "available": True},
            "facts": {}, "honesty": {},
        })
        self.assertTrue(r["cost_coherent"], "a real measurement was flagged")


class TheCaptureSurfaceStillExists(unittest.TestCase):
    """The fourth surface: without capture the other three have nothing to say.

    Codex reports usage only under `codex exec --json`, and the dispatch pipes
    stdout through tee into logs the runner parses for completion signals. The
    session rollout is therefore the side channel -- losing it silently returns
    every run to zero tokens.
    """

    def test_the_codex_usage_helper_is_present_and_priced(self):
        helper = _LIB / "codex-usage.py"
        self.assertTrue(
            helper.exists(),
            "the codex usage reader is gone -- codex runs record no tokens and "
            "all three surfaces above go quiet again")

        pricing = json.loads(
            (_ROOT / "loki-ts" / "data" / "model-pricing.json").read_text())["pricing"]
        for tier in ("gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"):
            with self.subTest(tier=tier):
                self.assertIn(
                    tier, pricing,
                    "a shipped codex tier is unpriced, so its runs record "
                    "tokens with cost unknown")

    def test_the_runner_calls_the_helper(self):
        """WIRING. A capture helper nothing invokes is the same as none."""
        run_sh = (_ROOT / "autonomy" / "run.sh").read_text(
            encoding="utf-8", errors="replace")
        self.assertIn(
            "lib/codex-usage.py", run_sh,
            "nothing calls the usage helper; codex cost silently returns to 0")


if __name__ == "__main__":
    unittest.main()
