#!/usr/bin/env python3
"""A gate that could not check must never render green.

WHAT THIS LOCKS DOWN. tools/ci-gate.py gets the hard decision right: it exits 2
when a policy could not be evaluated, because "we checked and it is fine" and
"we could not check" are opposite facts and only one earns a merge. A renderer
is where that distinction dies quietly, in two ways this asserts against:

  1. VISUALLY. An annotation layer emits ::error for failures and skips the
     rest; a table styles UNEVALUABLE like a footnote. Either way the run page
     has no red on it, and a reviewer reads absence-of-red as pass.
  2. IN THE EXIT CODE. `ci-gate | gate-report` keeps only the LAST status. If
     the renderer exited 0, then adding a human-readable report would convert a
     blocked merge into a green check -- a pipeline made less safe by the act
     of describing itself.

The positive assertions alone cannot catch (1): a row that prints "UNEVALUABLE"
next to a ::notice still contains the word. So every non-pass case asserts the
NEGATIVE too -- no ::notice emitted, no pass emphasis -- which is what makes the
severity map's mutation detectable rather than survivable.

Also asserted: nothing is invented. An empty policies list, a row with no
state, malformed JSON and empty stdin all refuse to report a pass.
"""

import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "gate-report.py"

_spec = importlib.util.spec_from_file_location("gate_report", _TOOL)
_gr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_gr)

# Real ci-gate --json output, captured from tools/ci-gate.py against a
# workspace carrying one measured efficiency record.
_PASS = {
    "exit_code": 0, "state": "PASS",
    "policies": [{"policy": "cost", "state": "PASS", "exit_code": 0,
                  "reason": "within_budget"}],
    "reason": "1 of 1 policies passed",
}

# Captured with --require-receipt against a workspace with no receipt.
_FAIL = {
    "exit_code": 1, "state": "FAIL",
    "policies": [{"policy": "receipt", "state": "FAIL", "exit_code": 1,
                  "reason": "--require-receipt was given but no receipt "
                            "exists under /tmp/ws/.loki/proofs/*/proof.json"}],
    "reason": "0 of 1 policies passed",
}

# Captured with --max-usd against a workspace with no efficiency records.
_UNEVALUABLE = {
    "exit_code": 2, "state": "UNEVALUABLE",
    "policies": [{"policy": "cost", "state": "UNEVALUABLE", "exit_code": 2,
                  "reason": "cost is UNMEASURED for /tmp/ws -- no efficiency "
                            "record carried an observed cost or token count."}],
    "reason": "0 of 1 policies passed",
}

# ci-gate's "no policy configured" verdict: UNEVALUABLE with ZERO rows. The
# case a naive renderer turns into a header and no rows, which reads as clean.
_NO_POLICY = {
    "exit_code": 2, "state": "UNEVALUABLE", "policies": [],
    "reason": "no policy configured: pass --max-usd and/or --require-receipt. "
              "A gate with nothing to enforce checked nothing, and must not "
              "report a pass for it.",
}

_FORMATS = ("markdown", "github", "text")


def _run(payload, fmt="markdown", executable=None):
    """Invoke the real CLI. The pipe is the product surface, so test it."""
    proc = subprocess.run(
        [executable or sys.executable, str(_TOOL), "--format", fmt],
        input=payload, capture_output=True, text=True)
    return proc


class RendersEachVerdict(unittest.TestCase):
    def test_pass_renders_a_pass_table(self):
        out = _gr.render_markdown(_PASS)
        self.assertIn("PASS", out)
        self.assertIn("cost", out)
        self.assertIn("within_budget", out)
        # A pass must not be dressed up as anything else.
        self.assertNotIn("UNEVALUABLE", out)
        self.assertNotIn("FAIL", out)

    def test_fail_renders_an_error_line(self):
        out = _gr.render_github(_FAIL)
        self.assertIn("::error", out)
        self.assertIn("receipt", out)
        self.assertNotIn("::notice", out)

    def test_fail_markdown_is_emphasised(self):
        out = _gr.render_markdown(_FAIL)
        self.assertIn("**FAIL**", out)


class UnevaluableIsNeverAPass(unittest.TestCase):
    """The requirement this whole file exists for."""

    def test_github_emits_a_warning_at_minimum(self):
        out = _gr.render_github(_UNEVALUABLE)
        # At minimum a warning. An error would also satisfy "as prominent as a
        # failure"; a notice never does.
        self.assertTrue("::warning" in out or "::error" in out,
                        "unevaluable produced neither warning nor error: %r"
                        % out)
        # THE MUTATION THIS CATCHES: demoting unevaluable to ::notice. The
        # positive assertion above survives it, this one does not.
        self.assertNotIn("::notice", out)

    def test_github_is_never_silent(self):
        out = _gr.render_github(_UNEVALUABLE)
        self.assertIn("cost", out)
        self.assertTrue(out.strip(), "unevaluable rendered as nothing at all")

    def test_markdown_is_as_prominent_as_a_failure(self):
        unevaluable = _gr.render_markdown(_UNEVALUABLE)
        failed = _gr.render_markdown(_FAIL)
        self.assertIn("**UNEVALUABLE**", unevaluable)
        # Same emphasis treatment as FAIL: not visually quieter.
        self.assertEqual("**FAIL**" in failed, "**UNEVALUABLE**" in unevaluable)

    def test_no_format_calls_it_a_pass(self):
        for fmt in _FORMATS:
            with self.subTest(fmt=fmt):
                out = _FORMATS_FN[fmt](_UNEVALUABLE)
                self.assertNotIn("PASS", out)
                self.assertIn("UNEVALUABLE", out)

    def test_headline_says_it_is_not_a_pass(self):
        self.assertIn("not a pass", _gr.render_markdown(_UNEVALUABLE))

    def test_severity_map_never_maps_unevaluable_to_notice(self):
        self.assertNotEqual(_gr._SEVERITY["UNEVALUABLE"], "notice")


class InventsNoVerdict(unittest.TestCase):
    def test_zero_policies_still_renders_visibly(self):
        for fmt in _FORMATS:
            with self.subTest(fmt=fmt):
                out = _FORMATS_FN[fmt](_NO_POLICY)
                self.assertIn("UNEVALUABLE", out)
                self.assertNotIn("PASS", out)
                self.assertIn("no policy configured", out)

    def test_zero_policies_emit_a_row_not_just_a_summary(self):
        """An empty table under a summary line reads as a clean run.

        Asserting only on the reason text is not enough: the trailing summary
        line carries the same words, so dropping the per-policy row entirely
        leaves those assertions green while the table renders empty.
        """
        self.assertEqual(len(_gr._rows(_NO_POLICY)), 1)
        for fmt in _FORMATS:
            with self.subTest(fmt=fmt):
                out = _FORMATS_FN[fmt](_NO_POLICY)
                # The synthetic row names the absent policy set explicitly.
                self.assertIn("(none)", out)
        # github: one row annotation plus the overall one, never overall alone.
        self.assertEqual(_gr.render_github(_NO_POLICY).count("::warning"), 2)

    def test_zero_policies_github_is_not_a_notice(self):
        out = _gr.render_github(_NO_POLICY)
        self.assertIn("::warning", out)
        self.assertNotIn("::notice", out)

    def test_zero_policies_claiming_pass_is_not_rendered_as_a_pass(self):
        """The header is not evidence. Zero rows means nothing was checked.

        Real ci-gate cannot emit this shape (its `if not rows` branch hardcodes
        UNEVALUABLE), but a renderer that trusts a top-level "PASS" over an
        empty policies list would build a green table out of zero evidence --
        which is the defaulting-to-pass this requirement forbids.
        """
        payload = {"exit_code": 0, "state": "PASS", "policies": [],
                   "reason": "1 of 1 policies passed"}
        out = _gr.render_github(payload)
        self.assertIn("::warning", out)
        self.assertNotIn("::notice", out)
        self.assertIn("**UNEVALUABLE**", _gr.render_markdown(payload))
        self.assertEqual(_gr.exit_code(payload), 2)

    def test_percent_is_escaped_in_annotations_only(self):
        # % opens an escape sequence in a workflow command; cost-guard emits
        # literal percentages via --max-increase-pct.
        payload = {"exit_code": 1, "state": "FAIL", "reason": "over",
                   "policies": [{"policy": "cost", "state": "FAIL",
                                 "exit_code": 1,
                                 "reason": "increased 22% over baseline"}]}
        self.assertIn("22%25", _gr.render_github(payload))
        # Plain text must keep the real sign, not the escape.
        self.assertIn("22% over", _gr.render_text(payload))
        self.assertNotIn("%25", _gr.render_text(payload))

    def test_row_without_a_state_is_unevaluable_not_pass(self):
        payload = {"exit_code": 0, "state": "PASS", "reason": "1 of 1 passed",
                   "policies": [{"policy": "cost", "reason": "x"}]}
        out = _gr.render_github(payload)
        self.assertIn("::warning", out)
        self.assertNotIn("::notice title=gate: cost", out)
        # And the missing verdict must not be laundered into a green exit.
        self.assertEqual(_gr.exit_code(payload), 2)

    def test_unrecognised_state_word_is_unevaluable(self):
        payload = {"exit_code": 0, "state": "PASS", "reason": "r",
                   "policies": [{"policy": "cost", "state": "SKIPPED",
                                 "reason": "x"}]}
        self.assertIn("**UNEVALUABLE**", _gr.render_markdown(payload))
        self.assertEqual(_gr.exit_code(payload), 2)


class ExitCodeMirrorsTheVerdict(unittest.TestCase):
    def test_pass_exits_zero(self):
        proc = _run(json.dumps(_PASS))
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_fail_exits_one(self):
        proc = _run(json.dumps(_FAIL))
        self.assertEqual(proc.returncode, 1, proc.stderr)

    def test_unevaluable_exits_two(self):
        proc = _run(json.dumps(_UNEVALUABLE))
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_no_policy_exits_two(self):
        self.assertEqual(_run(json.dumps(_NO_POLICY)).returncode, 2)

    def test_pipe_cannot_launder_a_failure_into_success(self):
        # The whole point of re-emitting: `ci-gate | gate-report` keeps only
        # this process's status.
        for payload, want in ((_FAIL, 1), (_UNEVALUABLE, 2), (_NO_POLICY, 2)):
            with self.subTest(state=payload["state"]):
                self.assertNotEqual(_run(json.dumps(payload)).returncode, 0)


class MalformedInputIsAnError(unittest.TestCase):
    def test_malformed_json_exits_non_zero(self):
        proc = _run("{not json")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("parse", proc.stderr.lower())

    def test_malformed_json_emits_no_partial_report(self):
        proc = _run('{"exit_code": 0, "state": "PA')
        self.assertEqual(proc.stdout.strip(), "",
                         "a partial report reads as a whole verdict")

    def test_empty_stdin_exits_non_zero(self):
        proc = _run("")
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout.strip(), "")
        self.assertIn("empty", proc.stderr.lower())

    def test_whitespace_stdin_exits_non_zero(self):
        self.assertNotEqual(_run("   \n  ").returncode, 0)

    def test_valid_json_that_is_not_an_object_exits_non_zero(self):
        for payload in ("[]", "null", '"ok"', "0"):
            with self.subTest(payload=payload):
                proc = _run(payload)
                self.assertNotEqual(proc.returncode, 0)
                self.assertEqual(proc.stdout.strip(), "")

    def test_missing_exit_code_is_not_a_pass(self):
        self.assertEqual(_gr.exit_code({"state": "PASS", "policies": []}), 2)

    def test_out_of_range_exit_code_is_not_a_pass(self):
        self.assertEqual(_gr.exit_code({"exit_code": 64, "state": "PASS"}), 2)


class EndToEndThroughCiGate(unittest.TestCase):
    """Real ci-gate output, real pipe. Not a hand-written fixture."""

    def test_real_ci_gate_verdict_pipes_through(self):
        gate = _ROOT / "tools" / "ci-gate.py"
        if not gate.is_file():
            self.skipTest("ci-gate.py absent")
        proc = subprocess.run(
            [sys.executable, str(gate), str(_ROOT), "--json"],
            capture_output=True, text=True)
        # No policy flags: ci-gate's own UNEVALUABLE verdict.
        self.assertEqual(proc.returncode, 2, proc.stderr)
        rendered = _run(proc.stdout, "github")
        self.assertEqual(rendered.returncode, 2, rendered.stderr)
        self.assertIn("::warning", rendered.stdout)
        self.assertNotIn("::notice", rendered.stdout)


_FORMATS_FN = {"markdown": _gr.render_markdown, "github": _gr.render_github,
               "text": _gr.render_text}


if __name__ == "__main__":
    unittest.main()
