"""The plain-English "ready" badge must not go green with trust gates off.

own-render.py restates a run for a NON-TECHNICAL owner. Its _is_ready docstring
already said "this is the line that must never overclaim", and it checked the
headline, the tests and the build -- but not whether the trust gates had
actually run. So a build with code review and security switched off produced a
green "ready" verdict for the reader least equipped to notice what was missing.

Every other surface can show a caveat beside a green badge and trust the reader
to weigh it. On this page the badge IS the message, so the caveat has to change
the badge.

TWO PROPERTIES, and the second matters as much as the first:

  1. a disabled TRUST gate (code review, security, unit tests, e2e) blocks green
  2. a disabled NON-trust phase (performance, web research) does NOT

Getting (2) wrong would push honest runs to amber, and a badge that is amber for
uninteresting reasons teaches owners to ignore the colour -- which costs more
than the overclaim it was meant to prevent.
"""

import importlib.util
import os
import unittest

_SRC = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "autonomy", "lib", "own-render.py")


def _load():
    spec = importlib.util.spec_from_file_location("own_render", _SRC)
    mod = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(mod)
    except SystemExit:  # pragma: no cover - module has a CLI entry point
        pass
    return mod


def _proof(**gates):
    """A proof that is green on every OTHER axis, so only gates decide."""
    p = {
        "honesty": {"headline": "VERIFIED"},
        "facts": {"tests": {"status": "passed"}, "build": {"ran": True}},
    }
    if gates:
        p["quality_gates"] = gates
    return p


class OwnRenderGateVerdictTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load()

    def ready(self, proof):
        return self.mod._is_ready(proof)

    # --- PROPERTY 1: a disabled trust gate blocks green ---------------------
    def test_disabled_trust_gates_block_the_ready_verdict(self):
        for gate in ("code_review", "security", "unit_tests", "e2e_tests"):
            with self.subTest(gate=gate):
                self.assertFalse(
                    self.ready(_proof(disabled_phases=[gate])),
                    "%s was switched off and the owner still sees green" % gate)

    def test_several_disabled_gates_still_block(self):
        self.assertFalse(
            self.ready(_proof(disabled_phases=["code_review", "security"])))

    # --- PROPERTY 2: a non-trust phase must NOT block ------------------------
    def test_non_trust_phases_do_not_block_green(self):
        """Amber for uninteresting reasons teaches owners to ignore the badge."""
        for phase in ("performance", "web_research", "regression", "uat"):
            with self.subTest(phase=phase):
                self.assertTrue(
                    self.ready(_proof(disabled_phases=[phase])),
                    "%s does not bear on correctness; blocking green here "
                    "devalues the badge" % phase)

    # --- the pre-existing conditions must still hold -------------------------
    def test_a_fully_verified_run_is_still_ready(self):
        self.assertTrue(self.ready(_proof(passed=3, total=3)))

    def test_an_unverified_headline_is_still_not_ready(self):
        p = _proof(passed=3, total=3)
        p["honesty"]["headline"] = "UNVERIFIED"
        self.assertFalse(self.ready(p))

    def test_failing_tests_are_still_not_ready(self):
        p = _proof(passed=3, total=3)
        p["facts"]["tests"]["status"] = "failed"
        self.assertFalse(self.ready(p))

    def test_a_build_that_never_ran_is_still_not_ready(self):
        p = _proof(passed=3, total=3)
        p["facts"]["build"] = {"ran": False, "status": "not_run"}
        self.assertFalse(self.ready(p))

    # --- robustness: bad data must not flip the verdict either way ----------
    def test_a_proof_predating_the_field_is_unaffected(self):
        """Legacy proofs have no quality_gates block at all."""
        self.assertTrue(self.ready(_proof()))

    def test_a_malformed_disabled_phases_value_does_not_block(self):
        """A string where a list belongs is bad data, not evidence of a
        skipped gate. Blocking on it would turn honest runs amber for a
        serialisation bug."""
        self.assertTrue(self.ready(_proof(disabled_phases="not-a-list")))

    def test_case_and_whitespace_are_normalised(self):
        self.assertFalse(self.ready(_proof(disabled_phases=["  Code_Review  "])))


class OwnRenderNotReadyExplanationTests(unittest.TestCase):
    """When the badge is not green, the owner must be told WHY.

    A run blocked ONLY by disabled gates has headline VERIFIED and an EMPTY
    honesty.degraded list, so the section fell through to "no specific gaps were
    itemized" -- while the reason was precise and already recorded. It also left
    a visible contradiction on the page: the verdict line read VERIFIED and the
    section refused to call it ready. Naming the skipped gates is what makes
    those two statements consistent.
    """

    @classmethod
    def setUpClass(cls):
        cls.mod = _load()

    def _render(self, proof):
        return "\n".join(self.mod._section_is_it_working(proof, "r1"))

    def test_disabled_gates_are_named_as_the_gap(self):
        out = self._render({
            "honesty": {"headline": "VERIFIED", "degraded": []},
            "facts": {"tests": {"status": "passed"}, "build": {"ran": True}},
            "quality_gates": {"disabled_phases": ["code_review", "security"]},
        })
        self.assertIn("switched OFF", out)
        self.assertIn("code_review", out)
        self.assertIn("security", out)

    def test_the_unhelpful_fallback_is_not_used_when_gates_explain_it(self):
        out = self._render({
            "honesty": {"headline": "VERIFIED", "degraded": []},
            "facts": {"tests": {"status": "passed"}, "build": {"ran": True}},
            "quality_gates": {"disabled_phases": ["code_review"]},
        })
        self.assertNotIn(
            "no specific gaps were itemized", out,
            "the reason was known and recorded; saying it was not itemized is "
            "false and leaves the owner with a VERIFIED verdict they cannot "
            "reconcile with a non-ready badge")

    def test_a_genuinely_unverified_run_keeps_its_own_gaps(self):
        out = self._render({
            "honesty": {"headline": "UNVERIFIED",
                        "degraded": [{"item": "tests", "why": "none ran"}]},
            "facts": {"tests": {"status": "failed"}, "build": {"ran": True}},
        })
        self.assertIn("tests", out)
        self.assertNotIn("switched OFF", out)

    def test_the_fallback_still_exists_when_nothing_explains_the_gap(self):
        """Do not delete the honest 'we cannot itemize this' path."""
        out = self._render({
            "honesty": {"headline": "PARTIAL", "degraded": []},
            "facts": {"tests": {"status": "failed"}, "build": {"ran": True}},
        })
        self.assertIn("no specific gaps were itemized", out)

    def test_a_ready_run_says_nothing_about_disabled_gates(self):
        out = self._render({
            "honesty": {"headline": "VERIFIED", "degraded": []},
            "facts": {"tests": {"status": "passed"}, "build": {"ran": True}},
            "quality_gates": {"passed": 3, "total": 3},
        })
        self.assertNotIn("switched OFF", out)


if __name__ == "__main__":
    unittest.main()
