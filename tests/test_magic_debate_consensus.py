"""A debate where no persona ran must not report consensus.

THE DEFECT. magic/core/debate.py invokes each persona through a provider
CLI. When that CLI is missing, _invoke_provider raises DebateProviderError
(debate.py:447), which every round catches and converts through the single
helper _critique_from_error. That helper used to return approves=True, on
the reasoning that a downed persona should not "spuriously block consensus".

Consensus is computed as:

    consensus = len(critiques) > 0 and all(c.approves for c in critiques)

so four failed invocations produced consensus=True, blocks=[], and
human_needed=False. Measured before the fix, with a nonexistent provider
binary and zero personas actually executed:

    consensus   : True
    human_needed: False
    approves    : [True, True, True, True]

That is a quality gate reporting PASS without running. It propagates: the
verdict lands in the registry as debate_passed (registry.py:40, :223) and
reaches memory_bridge (:130), so the claim outlives the call that made it.
These are MCP tools -- loki_magic_debate is machine-consumed, and no human
reads the parse_error field before acting on consensus.

"the review did not happen" and "the review passed" are opposite facts and
must be distinguishable by the caller. Same rule the cost surfaces learned:
an unmeasured value reads UNKNOWN, never as a passing measurement.

BOTH DIRECTIONS ARE ASSERTED. A fix that simply refused consensus would be
its own dishonesty -- it would make a genuine unanimous approval
unreportable, permanently blanking a real signal. A debate where every
persona actually ran and approved must still report consensus=True.
"""

import pathlib
import sys
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

from magic.core.debate import DEFAULT_PERSONAS, Critique, DebateRunner  # noqa: E402


def _approving(persona: str) -> Critique:
    """A real critique from a persona that actually ran and approved."""
    return Critique(
        persona=persona,
        severity="info",
        issues=[],
        suggestions=[],
        approves=True,
        raw_response='{"approves": true, "severity": "info"}',
        parse_error=None,
    )


def _dissenting(persona: str) -> Critique:
    """A real critique from a persona that ran and objected."""
    return Critique(
        persona=persona,
        severity="block",
        issues=["missing aria-label on the interactive control"],
        suggestions=["add aria-label"],
        approves=False,
        raw_response='{"approves": false, "severity": "block"}',
        parse_error=None,
    )


def _runner(review_impl, parallel=False) -> DebateRunner:
    runner = DebateRunner(provider="claude", parallel=parallel)
    runner._review = review_impl  # noqa: SLF001 - substituting the provider call
    return runner


def _debate(runner, rounds=1):
    return runner.run_debate(
        component_code="export const Widget = () => null;",
        spec="A button that submits the form.",
        target="react",
        rounds=rounds,
    )


class TestFailedPersonaIsNotApproval(unittest.TestCase):
    """Direction 1: a persona that never ran must not count as approval."""

    def test_all_personas_fail_reports_no_consensus(self):
        def boom(*_args, **_kwargs):
            raise RuntimeError("provider CLI not found on PATH")

        result = _debate(_runner(boom))

        self.assertGreater(len(result.critiques), 0, "expected persona slots")
        self.assertFalse(
            result.consensus,
            "a debate in which zero personas ran reported consensus=True",
        )
        for critique in result.critiques:
            self.assertFalse(critique.approves, f"{critique.persona} approved without running")
            self.assertIsNotNone(
                critique.parse_error,
                f"{critique.persona} lost the reason it failed",
            )

    def test_provider_missing_end_to_end_reports_no_consensus(self):
        """The real failure path: a provider binary that is not installed.

        No monkeypatched _review here -- _invoke_provider does the raising,
        exactly as it would for a user without the CLI on PATH.
        """
        runner = DebateRunner(provider="claude", parallel=False)
        runner._build_command = lambda prompt: [  # noqa: SLF001
            "loki-magic-nonexistent-provider-binary",
            prompt,
        ]

        result = _debate(runner)

        self.assertFalse(result.consensus, "missing provider CLI reported consensus")
        self.assertTrue(
            all(c.parse_error for c in result.critiques),
            "expected every persona to carry its provider error",
        )

    def test_one_failure_is_not_absorbed_by_approving_peers(self):
        """A single downed persona must still sink consensus."""
        seen = []

        def one_fails(persona_name, *_args, **_kwargs):
            seen.append(persona_name)
            if len(seen) == 1:
                raise RuntimeError("this persona's provider timed out")
            return _approving(persona_name)

        result = _debate(_runner(one_fails))

        self.assertFalse(
            result.consensus,
            "a failed persona was absorbed by its approving peers",
        )
        failed = [c for c in result.critiques if c.parse_error]
        self.assertEqual(len(failed), 1, "expected exactly one failed persona")

    def test_failed_persona_is_not_reported_as_a_blocking_objection(self):
        """An infrastructure failure is not a dissent.

        It must sink consensus without being laundered into a 'block'
        severity, or callers cannot tell a dead CLI from a real objection.
        """
        def boom(*_args, **_kwargs):
            raise RuntimeError("provider CLI not found on PATH")

        result = _debate(_runner(boom))

        self.assertEqual(result.blocks, [], "a downed persona was recorded as a block")
        for critique in result.critiques:
            self.assertEqual(critique.severity, "info")

    def test_parallel_path_agrees_with_sequential(self):
        """Rounds one and two both route through _critique_from_error."""
        def boom(*_args, **_kwargs):
            raise RuntimeError("provider CLI not found on PATH")

        result = _debate(_runner(boom, parallel=True), rounds=2)

        self.assertFalse(result.consensus, "parallel path reported consensus without running")
        self.assertTrue(all(c.parse_error for c in result.critiques))


class TestGenuineOutputIsNotSuppressed(unittest.TestCase):
    """Direction 2: an over-strict fix must not blank real approvals."""

    def test_all_personas_approve_reports_consensus(self):
        result = _debate(_runner(lambda persona_name, *a, **k: _approving(persona_name)))

        self.assertTrue(
            result.consensus,
            "a genuine unanimous approval was suppressed",
        )
        self.assertFalse(result.human_needed)
        self.assertTrue(
            all(c.parse_error is None for c in result.critiques),
            "clean critiques must carry no parse_error",
        )

    def test_genuine_dissent_still_blocks_and_is_distinguishable(self):
        """A real objection sinks consensus AND is told apart from a failure."""
        def one_dissents(persona_name, *_args, **_kwargs):
            if persona_name == DEFAULT_PERSONAS[2]:  # a11y
                return _dissenting(persona_name)
            return _approving(persona_name)

        result = _debate(_runner(one_dissents))

        # Guard the fixture itself: if the persona roster is renamed, the
        # dissent would never fire and this test would pass vacuously.
        self.assertIn(DEFAULT_PERSONAS[2], [c.persona for c in result.critiques])
        self.assertFalse(result.consensus)
        self.assertEqual(len(result.blocks), 1, "expected the real objection to block")
        self.assertTrue(result.human_needed)
        self.assertTrue(
            all(c.parse_error is None for c in result.critiques),
            "a genuine dissent must not be mistaken for a provider failure",
        )

    def test_multi_round_approval_survives(self):
        """Two rounds of genuine approval still report consensus."""
        result = _debate(
            _runner(lambda persona_name, *a, **k: _approving(persona_name)),
            rounds=2,
        )

        self.assertTrue(result.consensus, "multi-round genuine approval was suppressed")


if __name__ == "__main__":
    unittest.main()
