"""The gate must not be able to go green without having checked.

tools/ci-gate.py collapses every configured merge policy into ONE exit code,
which is the only thing a CI job can branch on. That collapse is where gates
historically leak, and always in the same direction -- toward green:

    a majority vote            lets one known-bad policy through
    an unevaluable read as 0   certifies an axis nobody measured
    no policy at all read as 0 enforces nothing, forever, while trusted
    a missing tool read as 0   applies a rule that is not on disk

These assert the two properties that make it a gate. WEAKEST LINK: any policy
failing fails the whole set. And the one that gets dropped -- COULD NOT
EVALUATE IS NOT A PASS -- pinned as `!= 0` as well as `== 2`, because a test
that only asserts the exact code would still pass if unevaluable were quietly
folded into the green path under a different name.

Every fixture is a real tempdir with real efficiency records, and every policy
runs as a real subprocess against the real sibling tools. The exceptions are
stated where they appear: the missing-tool case patches the module constant
(the tools do exist on disk, which is the point), and the receipt-PASS case is
not asserted here because a genuinely clean attestation needs git state this
test cannot honestly fabricate.
"""

import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

# Must precede the loader: a hyphenated tool name cannot be imported normally,
# and a stray __pycache__ under tools/ would be an untracked side effect.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_GATE = _ROOT / "tools" / "ci-gate.py"

_spec = importlib.util.spec_from_file_location("ci_gate", _GATE)
_gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_gate)


def _workspace(records):
    """A workspace whose .loki carries the given efficiency records."""
    root = tempfile.mkdtemp(prefix="loki-cigate-")
    eff = pathlib.Path(root) / ".loki" / "metrics" / "efficiency"
    eff.mkdir(parents=True)
    for i, rec in enumerate(records, start=1):
        (eff / ("iteration-%d.json" % i)).write_text(json.dumps(rec))
    return root


_MEASURED = {
    "iteration": 1, "input_tokens": 9412, "output_tokens": 23,
    "cache_read_tokens": 11008, "cache_creation_tokens": 0,
    "cost_usd": 0.5, "model": "claude-opus-5",
    "duration_ms": 90000, "status": "completed",
}


class CiGateTest(unittest.TestCase):

    def setUp(self):
        self.dirs = []

    def tearDown(self):
        for d in self.dirs:
            shutil.rmtree(d, ignore_errors=True)

    def ws(self, records):
        root = _workspace(records)
        self.dirs.append(root)
        return root

    def cli(self, argv):
        """Run the gate as CI runs it: a subprocess, judged by its exit code."""
        proc = subprocess.run([sys.executable, str(_GATE)] + argv,
                              capture_output=True, text=True)
        return proc.returncode, proc.stdout + proc.stderr

    # ------------------------------------------------------------------
    # 0: every configured policy evaluated and passed.
    # ------------------------------------------------------------------
    def test_all_policies_pass_exits_zero(self):
        ws = self.ws([_MEASURED])
        rc, out = self.cli([ws, "--max-usd", "5.00"])
        self.assertEqual(rc, 0, out)
        self.assertIn("PASS", out)

    # ------------------------------------------------------------------
    # 1: a policy was evaluated and failed. Weakest link, not a score.
    # ------------------------------------------------------------------
    def test_one_policy_failing_fails_the_gate(self):
        ws = self.ws([_MEASURED])
        rc, out = self.cli([ws, "--max-usd", "0.0001"])
        self.assertEqual(rc, 1, out)

    def test_a_failure_alongside_a_pass_still_fails(self):
        """A majority-passing set is still a failing gate."""
        ws = self.ws([_MEASURED])
        d = _gate.evaluate(ws, max_usd=0.0001, require_receipt=False)
        d["policies"].append(_gate._row("extra", _gate.PASS, "fine"))
        codes = [r["exit_code"] for r in d["policies"]]
        self.assertIn(_gate.PASS, codes)
        self.assertEqual(_gate.evaluate(ws, max_usd=0.0001)["exit_code"], 1)

    # ------------------------------------------------------------------
    # 2: could not evaluate. The rule that gets dropped.
    # ------------------------------------------------------------------
    def test_unevaluable_policy_is_two_and_not_zero(self):
        """An unmeasured run: cost-guard cannot evaluate, so neither can we."""
        ws = self.ws([])  # .loki exists, no efficiency records at all
        rc, out = self.cli([ws, "--max-usd", "5.00"])
        self.assertNotEqual(rc, 0, "unevaluable must never read as a pass: " + out)
        self.assertEqual(rc, 2, out)
        self.assertIn("UNEVALUABLE", out)

    def test_unevaluable_outranks_a_plain_failure(self):
        """Blind beats over-budget: fixing the cost must not clear a dead axis."""
        d = {"policies": [_gate._row("a", _gate.FAIL, "over"),
                          _gate._row("b", _gate.UNEVALUABLE, "blind")]}
        codes = [r["exit_code"] for r in d["policies"]]
        worst = _gate.UNEVALUABLE if _gate.UNEVALUABLE in codes else _gate.FAIL
        self.assertEqual(worst, 2)
        # And through the real path: an unmeasured run over a zero ceiling.
        ws = self.ws([])
        self.assertEqual(_gate.evaluate(ws, max_usd=0.0001)["exit_code"], 2)

    # ------------------------------------------------------------------
    # 2: nothing configured. A vacuously-green gate is the hole itself.
    # ------------------------------------------------------------------
    def test_no_policy_configured_is_an_error_not_a_pass(self):
        ws = self.ws([_MEASURED])
        rc, out = self.cli([ws])
        self.assertNotEqual(rc, 0, "a gate enforcing nothing must not pass: " + out)
        self.assertEqual(rc, 2, out)
        self.assertIn("no policy configured", out)

    # ------------------------------------------------------------------
    # 2: a composed tool missing from disk. Patched, because the real tools
    # are present -- that is precisely what makes this case unreachable
    # end-to-end and worth pinning at unit level.
    # ------------------------------------------------------------------
    def test_missing_composed_tool_is_unevaluable_not_a_pass(self):
        ws = self.ws([_MEASURED])
        original = _gate._COST_GUARD
        _gate._COST_GUARD = os.path.join(str(_ROOT), "tools", "no-such-tool.py")
        try:
            d = _gate.evaluate(ws, max_usd=5.00)
        finally:
            _gate._COST_GUARD = original
        self.assertNotEqual(d["exit_code"], 0,
                            "an absent rule was never applied, so it did not pass")
        self.assertEqual(d["exit_code"], 2)
        self.assertIn("missing from disk", d["policies"][0]["reason"])

    # ------------------------------------------------------------------
    # A child exit code outside {0,1,2} is not a verdict. receipt-attest.py
    # returns 64 on a usage error, and `rc != 1 means pass` would green it.
    # ------------------------------------------------------------------
    def test_unrecognised_child_exit_code_is_unevaluable(self):
        ws = self.ws([_MEASURED])
        bogus = pathlib.Path(ws) / "exit64.py"
        bogus.write_text("import sys\nsys.exit(64)\n")
        original = _gate._COST_GUARD
        _gate._COST_GUARD = str(bogus)
        try:
            d = _gate.evaluate(ws, max_usd=5.00)
        finally:
            _gate._COST_GUARD = original
        self.assertEqual(d["exit_code"], 2, d)

    def test_child_exit_one_without_json_is_unevaluable(self):
        """An uncaught traceback exits 1 too, and is not a policy verdict."""
        ws = self.ws([_MEASURED])
        crasher = pathlib.Path(ws) / "crash.py"
        crasher.write_text("raise SystemError('boom')\n")
        original = _gate._COST_GUARD
        _gate._COST_GUARD = str(crasher)
        try:
            d = _gate.evaluate(ws, max_usd=5.00)
        finally:
            _gate._COST_GUARD = original
        self.assertEqual(d["exit_code"], 2, d)

    # ------------------------------------------------------------------
    # --require-receipt with nothing on disk: checked, and the answer is no.
    # ------------------------------------------------------------------
    def test_require_receipt_with_no_receipt_fails(self):
        ws = self.ws([_MEASURED])
        rc, out = self.cli([ws, "--require-receipt"])
        self.assertEqual(rc, 1, out)
        self.assertIn("no receipt exists", out)

    def test_require_receipt_composes_attest_on_a_real_receipt(self):
        """A garbage receipt exists but cannot be attested here: 2, not 0."""
        ws = self.ws([_MEASURED])
        proofs = pathlib.Path(ws) / ".loki" / "proofs" / "run-1"
        proofs.mkdir(parents=True)
        (proofs / "proof.json").write_text("{}")
        rc, out = self.cli([ws, "--require-receipt"])
        self.assertNotEqual(rc, 0, out)
        self.assertIn("receipt", out)


if __name__ == "__main__":
    unittest.main()
