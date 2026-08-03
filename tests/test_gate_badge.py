"""A blind gate must not render as a green badge.

WHY THIS EXISTS. `ci-gate.py` is careful about three states, and this repo has
paid repeatedly for the moment one of them collapses into another. The badge is
the last such moment and the worst one: it is the only surface consumed purely
by glance, so a wrong colour is not a subtle inaccuracy, it is the entire
message. UNEVALUABLE rendered green tells a reader "checked and fine" at the
exact moment the gate could not check anything.

THE ASSERTION THAT CARRIES THE REQUIREMENT is not `color == "orange"` -- that
pins a decoration and would fail on a harmless palette change while passing
anything that happens to spell orange. It is not `color != "brightgreen"`
either, which survives a mutation to "green" or "success". It is the pair:

    the unevaluable colour is in no green family, AND
    it differs from whatever the PASS path actually renders

which is the requirement stated as a property, and holds no matter which
palette a future edit picks.

BOTH DIRECTIONS. Suppressing every badge into grey would also satisfy "never
green when blind", and would be its own dishonesty: it makes a real pass
unreportable and trains readers to ignore the badge. So a genuine PASS is
asserted to still be green with exit 0, end to end through the real
`ci-gate.py`, on a workspace carrying a real measured cost record.
"""

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

# Before any loader touches this tree: a stale .pyc makes a mutation probe
# report a FALSE failure against code that is no longer on disk.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_BADGE = _ROOT / "tools" / "gate-badge.py"
_CI_GATE = _ROOT / "tools" / "ci-gate.py"

# Every spelling shields.io accepts for "everything is fine". A mutation to any
# one of these is the defect this file exists to catch.
_GREEN = {"brightgreen", "green", "success", "#4c1", "4c1", "#97ca00"}

# The shape a real measured iteration writes. Copied from the record already
# pinned in tests/test_cost_honesty_end_to_end.py so the PASS direction runs
# against genuine data, not a hand-tuned stub.
_MEASURED = {
    "iteration": 1, "input_tokens": 9412, "output_tokens": 23,
    "cache_read_tokens": 11008, "cache_creation_tokens": 0,
    "cost_usd": 0.018719, "model": "gpt-5.6-sol",
    "duration_ms": 90000, "status": "completed",
}


def _badge(stdin_text, *args):
    """Run the real tool over real stdin. Returns (parsed_or_None, proc)."""
    proc = subprocess.run(
        [sys.executable, str(_BADGE), *args],
        input=stdin_text, capture_output=True, text=True, timeout=60)
    try:
        return json.loads(proc.stdout), proc
    except ValueError:
        return None, proc


def _gate(workspace, *args):
    """Run the real ci-gate and hand its stdout to the badge, as a CI job would."""
    gate = subprocess.run(
        [sys.executable, str(_CI_GATE), str(workspace), *args, "--json"],
        capture_output=True, text=True, timeout=120)
    body, proc = _badge(gate.stdout)
    return gate, body, proc


def _workspace(record=None):
    root = pathlib.Path(tempfile.mkdtemp())
    (root / ".loki").mkdir(parents=True, exist_ok=True)
    if record is not None:
        eff = root / ".loki" / "metrics" / "efficiency"
        eff.mkdir(parents=True, exist_ok=True)
        (eff / "iteration-1.json").write_text(json.dumps(record),
                                              encoding="utf-8")
    return root


class UnevaluableIsVisiblyNotAPass(unittest.TestCase):
    """The direction that would put a green badge over a blind gate."""

    def setUp(self):
        self.blind, _ = _badge(json.dumps(
            {"state": "UNEVALUABLE", "exit_code": 2, "policies": [],
             "reason": "no policy configured"}))
        self.green, _ = _badge(json.dumps(
            {"state": "PASS", "exit_code": 0, "policies": [],
             "reason": "1 of 1 policies passed"}))

    def test_unevaluable_is_never_a_green(self):
        self.assertNotIn(
            self.blind["color"], _GREEN,
            "an unevaluable gate rendered %r -- a reader glancing at the "
            "README is told the gate checked and passed at the exact moment "
            "it could not check anything" % self.blind["color"])

    def test_unevaluable_differs_from_the_colour_a_pass_renders(self):
        """The requirement itself, independent of which palette is chosen."""
        self.assertNotEqual(
            self.blind["color"], self.green["color"],
            "unevaluable and pass render the identical colour %r, so the "
            "badge cannot express the distinction ci-gate.py exists to make"
            % self.green["color"])

    def test_the_message_names_the_state_not_a_generic_word(self):
        """A badge saying "error" reads the same for a failure and a blind
        gate, which is the collapse this file exists to prevent, moved from
        the colour into the words."""
        self.assertIn("unevaluable", self.blind["message"].lower())
        # Every state must render distinct words, not just a distinct colour.
        self.assertNotEqual(self.blind["message"], self.green["message"])

    def test_end_to_end_a_gate_with_no_policy_is_not_green(self):
        gate, body, proc = _gate(_workspace(), "--max-usd", "5")
        self.assertEqual(gate.returncode, 2, gate.stdout + gate.stderr)
        self.assertNotIn(body["color"], _GREEN)
        self.assertEqual(proc.returncode, 2)


class GenuineDataIsStillReported(unittest.TestCase):
    """The over-strict direction: a badge that is never green is also useless."""

    def test_a_real_passing_gate_renders_green(self):
        ws = _workspace(_MEASURED)
        gate, body, proc = _gate(ws, "--max-usd", "5")
        self.assertEqual(gate.returncode, 0, gate.stdout + gate.stderr)
        self.assertIn(
            body["color"], _GREEN,
            "a gate that measured a real cost and passed rendered %r; a badge "
            "that is never green makes a real pass unreportable"
            % body["color"])
        self.assertEqual(body["message"], "passing")
        self.assertEqual(proc.returncode, 0)

    def test_a_real_failing_gate_is_neither_green_nor_unevaluable(self):
        ws = _workspace(_MEASURED)
        gate, body, proc = _gate(ws, "--max-usd", "0.001")
        self.assertEqual(gate.returncode, 1, gate.stdout + gate.stderr)
        self.assertNotIn(body["color"], _GREEN)
        self.assertEqual(body["message"], "failing")
        self.assertEqual(proc.returncode, 1)

    def test_a_measured_zero_exit_code_survives(self):
        """0 is the PASS code and is falsy.

        `payload.get("exit_code") or 2` would turn every passing gate into a
        blind one. This is the same absent-is-not-zero rule the cost surfaces
        pay for, landing on an exit code.
        """
        body, proc = _badge(json.dumps({"state": "PASS", "exit_code": 0}))
        self.assertEqual(proc.returncode, 0)
        self.assertIn(body["color"], _GREEN)


class NoVerdictIsNeverInvented(unittest.TestCase):
    def test_empty_stdin_is_an_error_and_not_a_pass(self):
        body, proc = _badge("")
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn(body["color"], _GREEN)

    def test_malformed_stdin_is_an_error_and_not_a_pass(self):
        for junk in ("{not json", "[]", '"PASS"', "null", "42"):
            with self.subTest(stdin=junk):
                body, proc = _badge(junk)
                self.assertNotEqual(
                    proc.returncode, 0,
                    "malformed stdin %r rendered a success" % junk)
                self.assertNotIn(body["color"], _GREEN)

    def test_an_unknown_state_is_rejected_rather_than_guessed(self):
        body, proc = _badge(json.dumps({"state": "MOSTLY_FINE",
                                        "exit_code": 0}))
        self.assertEqual(proc.returncode, 2)
        self.assertNotIn(body["color"], _GREEN)

    def test_a_payload_that_disagrees_with_itself_is_rejected(self):
        """Half-believing a corrupt payload lets the green half through."""
        body, proc = _badge(json.dumps({"state": "UNEVALUABLE",
                                        "exit_code": 0}))
        self.assertEqual(proc.returncode, 2)
        self.assertNotIn(body["color"], _GREEN)


class ObeysTheToolConventions(unittest.TestCase):
    def test_help_exits_zero_and_emits_no_badge(self):
        proc = subprocess.run(
            [sys.executable, str(_BADGE), "--help"],
            input="", capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0)
        self.assertNotIn("schemaVersion", proc.stdout)

    def test_an_unknown_flag_exits_64_not_2(self):
        """64 is a typo; 2 means the gate went blind. Conflating them sends
        an operator hunting for instrumentation that was never broken."""
        proc = subprocess.run(
            [sys.executable, str(_BADGE), "--lable", "x"],
            input="", capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 64)

    def test_a_stray_path_is_a_usage_error_never_a_judged_file(self):
        proc = subprocess.run(
            [sys.executable, str(_BADGE), "/nonexistent/definitely/not/here"],
            input="", capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 64)

    def test_the_label_is_settable(self):
        body, proc = _badge(json.dumps({"state": "PASS", "exit_code": 0}),
                            "--label", "merge policy")
        self.assertEqual(body["label"], "merge policy")
        self.assertEqual(body["schemaVersion"], 1)


if __name__ == "__main__":
    unittest.main()
