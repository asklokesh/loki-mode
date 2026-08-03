"""An explanation is where the three gate states quietly become two.

WHY THIS FILE. ci-gate.py keeps PASS, FAIL and UNEVALUABLE apart, and its own
tests pin that. gate-explain.py re-renders the same verdict into prose plus a
command, and prose is the softest surface in the chain: "the gate could not
check this" has no red colour, no exit code of its own once a pipe has eaten
it, and a single reworded sentence turns it into "all good". The whole tool
line exists to stop a check reporting a pass without having checked, and a
renderer is where that rule dies without anything crashing.

THE PROPERTIES ASSERTED, and the defect each one names:

  1. UNEVALUABLE is explained as "could not check" -- never as a failure, never
     as a pass. Three facts, three sentences. Calling it a failure sends an
     operator to fix a budget that was never exceeded; calling it a pass merges
     on an axis nobody checked. Both are wrong in different directions, so both
     are asserted separately.

  2. The exit code survives the pipe, RECONCILED against the rows. A header
     claiming exit_code 0 above an UNEVALUABLE row is the sharp case: relaying
     the header alone makes this tool print "could not check" and exit 0 in the
     same breath.

  3. A remedy is never invented. An unrecognised policy prints the literal
     refusal, because a wrong command is worse than none -- the user runs it
     and then trusts the result.

  4. Empty and malformed stdin are errors, not assumed passes.

BOTH DIRECTIONS. A guard strict enough to call everything unevaluable would
satisfy every honesty assertion above while making the tool useless, so the
over-strict direction is asserted too: a genuine PASS still reads as a pass and
still exits 0, a genuine FAIL still reads as a failure, and the child policy's
own words survive to the output instead of being replaced by a paraphrase. A
renderer that blanks real findings is its own dishonesty.
"""

import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "gate-explain.py"
_CI_GATE = _ROOT / "tools" / "ci-gate.py"

_spec = importlib.util.spec_from_file_location("gate_explain", _TOOL)
_ge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ge)


def _run(stdin_text, *args):
    return subprocess.run(
        [sys.executable, str(_TOOL), *args],
        input=stdin_text, capture_output=True, text=True, timeout=120)


def _verdict(state, code, rows, reason="0 of 1 policies passed"):
    return json.dumps({"exit_code": code, "state": state,
                       "policies": rows, "reason": reason})


def _row(policy, state, code, reason="detail from the policy"):
    return {"policy": policy, "state": state, "exit_code": code,
            "reason": reason}


# Words that assert the axis was checked and found acceptable. If any of these
# describe an UNEVALUABLE row, the blind axis has been rendered as a clean one.
#
# Scoped to the EXPLANATION this file authors, not the whole stdout, and that
# scoping is itself a correctness point: ci-gate's relayed summary legitimately
# reads "0 of 1 policies passed", so a blanket substring ban over the output
# would force this file to censor the gate's own words -- suppressing genuine
# data to satisfy an honesty check, which is the over-strict failure mode.
_PASS_WORDS = ("passed", "it passed", "compliant", "within budget",
               "nothing to do", "all good")


class UnevaluableIsNeitherPassNorFail(unittest.TestCase):
    """The state this whole tool line exists to keep distinct."""

    def setUp(self):
        self.out = _run(_verdict(
            "UNEVALUABLE", 2, [_row("cost", "UNEVALUABLE", 2)]))

    def test_it_is_explained_as_could_not_check(self):
        """The defect: UNEVALUABLE explained as a pass.

        This is the assertion that must fail if the wording of _MEANING
        ["UNEVALUABLE"] is mutated into pass language. Exit code alone cannot
        catch it -- the code stays 2 while the sentence lies.
        """
        self.assertIn("could not check", self.out.stdout,
                      "an unevaluable policy must be explained as one the "
                      "gate could not check; anything else hides a blind axis")

    def test_it_is_never_worded_as_a_pass(self):
        lowered = _ge._MEANING["UNEVALUABLE"].lower()
        for word in _PASS_WORDS:
            self.assertNotIn(
                word, lowered,
                "the explanation of an UNEVALUABLE policy contains %r, which "
                "asserts the axis was checked and found fine -- it was not "
                "checked at all" % word)

    def test_it_is_never_worded_as_a_failure(self):
        """The opposite error, and it is not harmless.

        "the gate checked this and it failed" sends an operator to fix a
        budget that was never exceeded, while the real defect -- broken
        instrumentation -- goes untouched and the axis stays blind.
        """
        self.assertNotIn("checked this and it failed", self.out.stdout,
                         "an unmeasured axis is not a failed one")

    def test_the_three_states_have_three_distinct_sentences(self):
        self.assertEqual(
            3, len(set(_ge._MEANING.values())),
            "two states share one explanation, so the output cannot tell "
            "them apart no matter what the gate reported")

    def test_it_exits_two_not_zero(self):
        self.assertEqual(2, self.out.returncode)


class TheExitCodeSurvivesThePipe(unittest.TestCase):
    """A shell pipe keeps only the last status, so this file re-emits it."""

    def test_unevaluable_input_exits_two(self):
        r = _run(_verdict("UNEVALUABLE", 2, [_row("cost", "UNEVALUABLE", 2)]))
        self.assertEqual(2, r.returncode,
                         "piping through the explainer turned a blind gate "
                         "into a green shell status")

    def test_failed_input_exits_one(self):
        r = _run(_verdict("FAIL", 1, [_row("receipt", "FAIL", 1)]))
        self.assertEqual(1, r.returncode)

    def test_a_header_claiming_zero_over_an_unevaluable_row_is_not_a_pass(self):
        """The sharp case: relaying exit_code alone leaks green.

        The body says PASS and exit_code 0; a row says UNEVALUABLE. Believing
        the header prints "the gate could not check this" and exits 0 in the
        same breath.
        """
        r = _run(_verdict("PASS", 0, [_row("cost", "UNEVALUABLE", 2)],
                          reason="1 of 1 policies passed"))
        self.assertEqual(
            2, r.returncode,
            "a header claiming a pass over an unchecked row was believed; "
            "the rows are the evidence and the header is only a claim")
        self.assertIn("could not check", r.stdout)

    def test_a_row_with_an_unrecognised_state_is_not_a_pass(self):
        r = _run(_verdict("PASS", 0, [_row("cost", "WEIRD", 0)]))
        self.assertEqual(2, r.returncode,
                         "an unrecognised state was defaulted to a pass")

    def test_a_missing_policies_list_is_not_a_pass(self):
        """ci-gate's "no policy configured" verdict, and worse variants."""
        r = _run(json.dumps({"exit_code": 0, "state": "PASS", "policies": [],
                             "reason": "no policy configured"}))
        self.assertEqual(
            2, r.returncode,
            "a gate that enforced nothing was reported as having passed")
        self.assertIn("could not check", r.stdout)


class ARemedyIsNeverInvented(unittest.TestCase):
    """A guessed command is pasted, run, and then trusted."""

    def test_an_unknown_policy_prints_the_literal_refusal(self):
        r = _run(_verdict("FAIL", 1, [_row("quantum-flux", "FAIL", 1)]))
        self.assertIn("no known remedy for this policy", r.stdout,
                      "an unrecognised policy got a guessed remedy")

    def test_an_unknown_policy_is_given_no_command_to_run(self):
        r = _run(_verdict("FAIL", 1, [_row("quantum-flux", "FAIL", 1)]))
        self.assertNotIn(
            "python3 tools/", r.stdout,
            "a command was assembled for a policy this file knows nothing "
            "about; running it would produce a result the user then trusts")

    def test_every_remedy_names_a_tool_that_exists(self):
        """A remedy pointing at a deleted tool is a guess with extra steps."""
        for (policy, state), text in _ge._REMEDY.items():
            for token in text.split():
                if token.startswith("tools/"):
                    self.assertTrue(
                        (_ROOT / token).is_file(),
                        "the %s/%s remedy tells the user to run %s, which "
                        "does not exist" % (policy, state, token))

    def test_remedies_exist_for_both_non_pass_states_of_known_policies(self):
        """UNEVALUABLE is the state that most needs a next step.

        An operator with a FAIL knows roughly what to do. An operator with
        "cost is UNMEASURED" does not, and an unactionable blocker gets
        routed around rather than fixed.
        """
        for policy in ("cost", "receipt"):
            for state in ("FAIL", "UNEVALUABLE"):
                self.assertIn((policy, state), _ge._REMEDY)


class UnreadableInputIsAnErrorNotAPass(unittest.TestCase):
    def test_empty_stdin_is_an_error(self):
        r = _run("")
        self.assertEqual(2, r.returncode,
                         "nothing to explain was reported as a clean run")
        self.assertEqual("", r.stdout.strip(),
                         "an empty report reads as a clean gate")

    def test_whitespace_only_stdin_is_an_error(self):
        self.assertEqual(2, _run("   \n\t\n").returncode)

    def test_malformed_json_is_an_error(self):
        r = _run("{not json at all")
        self.assertEqual(2, r.returncode,
                         "unparseable input was assumed to be a pass")

    def test_a_json_scalar_is_an_error(self):
        self.assertEqual(2, _run("42").returncode)

    def test_a_json_list_is_an_error(self):
        self.assertEqual(2, _run("[]").returncode)


class TheExitConventionHolds(unittest.TestCase):
    """0/1/2 come from the verdict; 64 is a usage error, never a path."""

    def test_help_exits_zero_and_emits_no_verdict(self):
        r = subprocess.run([sys.executable, str(_TOOL), "--help"],
                           capture_output=True, text=True, timeout=120)
        self.assertEqual(0, r.returncode)
        self.assertNotIn("GATE:", r.stdout,
                         "--help emitted a verdict about a question nobody "
                         "asked")

    def test_an_unknown_flag_is_a_usage_error_not_unevaluable(self):
        """64, not argparse's default 2.

        2 means "could not be checked" in this repo, so a mistyped flag would
        be indistinguishable from a genuinely blind gate.
        """
        r = subprocess.run([sys.executable, str(_TOOL), "--no-such-flag"],
                           input="", capture_output=True, text=True,
                           timeout=120)
        self.assertEqual(64, r.returncode)

    def test_a_bare_path_is_a_usage_error_never_read_as_input(self):
        """receipt-attest once read --help as a proof path and judged it."""
        r = subprocess.run(
            [sys.executable, str(_TOOL), "/nonexistent/definitely/not/here"],
            input="", capture_output=True, text=True, timeout=120)
        self.assertEqual(
            64, r.returncode,
            "a positional path was accepted; this tool reads a verdict on "
            "stdin, so a path argument is a mistake, not input")


class GenuineDataIsNotSuppressed(unittest.TestCase):
    """The over-strict direction. A tool that flags everything is useless.

    A guard so cautious it rendered every row UNEVALUABLE would satisfy every
    honesty assertion above and still be a regression: real passes would block
    merges, real failures would lose their diagnosis, and operators would
    disable the gate. So a real pass must still read as a pass.
    """

    def test_a_real_pass_reads_as_a_pass_and_exits_zero(self):
        r = _run(_verdict("PASS", 0, [_row("cost", "PASS", 0,
                                           "cost $0.42 is within $5.00")],
                          reason="1 of 1 policies passed"))
        self.assertEqual(0, r.returncode,
                         "a fully checked, fully passing gate was blocked")
        self.assertIn("checked this and it passed", r.stdout)
        self.assertNotIn("could not check", r.stdout)

    def test_a_real_failure_is_explained_as_a_failure(self):
        r = _run(_verdict("FAIL", 1, [_row("cost", "FAIL", 1,
                                           "cost $9.10 exceeds $5.00")]))
        self.assertIn("checked this and it failed", r.stdout)
        self.assertNotIn("could not check", r.stdout)

    def test_the_policys_own_words_survive_to_the_output(self):
        """Never this file's paraphrase of a rule it does not own.

        The child's reason is the only place the ACTUAL number lives. Dropping
        it for a generic sentence makes every cost failure look identical and
        strips the one datum that tells an operator how far over they are.
        """
        r = _run(_verdict("FAIL", 1, [_row("cost", "FAIL", 1,
                                           "cost $9.10 exceeds $5.00")]))
        self.assertIn("cost $9.10 exceeds $5.00", r.stdout)

    def test_a_measured_zero_cost_survives_as_a_reported_pass(self):
        """A measured 0 is a fact. Absent is not zero, but zero is not absent.

        A guard written with a falsy check rather than `is None` would treat a
        genuinely measured $0.00 as missing and blank a real measurement.
        """
        r = _run(_verdict("PASS", 0, [_row("cost", "PASS", 0,
                                           "cost $0.00 is within $5.00")],
                          reason="1 of 1 policies passed"))
        self.assertEqual(0, r.returncode)
        self.assertIn("$0.00", r.stdout,
                      "a measured zero was suppressed as if unmeasured")

    def test_the_gates_own_summary_wording_is_not_censored(self):
        """"0 of 1 policies passed" must survive on an UNEVALUABLE verdict.

        The honesty rule forbids this file from CALLING an unchecked axis
        passed. It does not license deleting the gate's own count, which is
        real relayed data. A fix that banned the substring outright would
        strip the summary and leave the reader unable to see how many
        policies there even were.
        """
        r = _run(_verdict("UNEVALUABLE", 2, [_row("cost", "UNEVALUABLE", 2)],
                          reason="0 of 1 policies passed"))
        self.assertIn("0 of 1 policies passed", r.stdout)

    def test_a_json_pass_carries_a_zero_exit_code(self):
        r = _run(_verdict("PASS", 0, [_row("cost", "PASS", 0)],
                          reason="1 of 1 policies passed"), "--json")
        self.assertEqual(0, r.returncode)
        payload = json.loads(r.stdout)
        self.assertEqual(0, payload["exit_code"])
        self.assertEqual("PASS", payload["state"])
        self.assertEqual("nothing to do",
                         payload["policies"][0]["next_command"])


class AgainstTheRealGate(unittest.TestCase):
    """Fixtures drift from the producer. This consumes ci-gate's real output."""

    def _pipe(self, *gate_args):
        gate = subprocess.run(
            [sys.executable, str(_CI_GATE), *gate_args],
            capture_output=True, text=True, timeout=120)
        return gate, _run(gate.stdout)

    def test_a_real_unevaluable_verdict_explains_and_exits_two(self):
        import tempfile
        ws = tempfile.mkdtemp()
        (pathlib.Path(ws) / ".loki").mkdir(parents=True, exist_ok=True)
        gate, out = self._pipe(ws, "--max-usd", "5", "--json")
        self.assertEqual(2, gate.returncode, "ci-gate's own verdict changed")
        self.assertEqual(2, out.returncode)
        self.assertIn("could not check", out.stdout)
        self.assertIn("cost", out.stdout)

    def test_a_real_passing_verdict_reads_as_a_pass_and_exits_zero(self):
        """The PASS path against the real producer, not a fixture.

        Every other real-gate case here is a non-pass, so a tool that hard-coded
        UNEVALUABLE would still satisfy them. This is the case that proves the
        pipeline can actually go green when the run genuinely complied.
        """
        import tempfile
        ws = pathlib.Path(tempfile.mkdtemp())
        eff = ws / ".loki" / "metrics" / "efficiency"
        eff.mkdir(parents=True, exist_ok=True)
        (eff / "iteration-1.json").write_text(json.dumps({
            "iteration": 1, "input_tokens": 9412, "output_tokens": 23,
            "cache_read_tokens": 11008, "cache_creation_tokens": 0,
            "cost_usd": 0.018719, "model": "gpt-5.6-sol",
            "duration_ms": 90000, "status": "completed"}), encoding="utf-8")
        gate, out = self._pipe(str(ws), "--max-usd", "5", "--json")
        self.assertEqual(0, gate.returncode,
                         "ci-gate did not pass a measured, in-budget run: %s"
                         % gate.stdout)
        self.assertEqual(0, out.returncode,
                         "the explainer blocked a genuinely passing gate")
        self.assertIn("checked this and it passed", out.stdout)
        self.assertNotIn("could not check", out.stdout)

    def test_a_real_no_policy_verdict_is_explained_not_blank(self):
        import tempfile
        ws = tempfile.mkdtemp()
        (pathlib.Path(ws) / ".loki").mkdir(parents=True, exist_ok=True)
        gate, out = self._pipe(ws, "--json")
        self.assertEqual(2, out.returncode)
        self.assertIn("enforced nothing", out.stdout)


if __name__ == "__main__":
    unittest.main()
