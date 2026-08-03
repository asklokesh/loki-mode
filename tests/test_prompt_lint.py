"""prompt-lint ranks deletion candidates, and must never flag per-iteration state.

THE VACUITY GUARD COMES FIRST, and everything else depends on it. This tool
scans a fixture corpus for instruction blocks. A scan that silently matches
nothing makes every downstream assertion trivially true: "no state block was
flagged" is satisfied by finding no blocks at all, and a broken splitter would
sail through a suite that only checks what is absent. So the first test asserts
the scan found real, NAMED content, and the rest of the file is only meaningful
if that one passes.

THE LINE THIS TOOL MUST NOT CROSS. Above `[CACHE_BREAKPOINT]` is cache-stable
coaching -- fair game to rank. Below it is `<dynamic_context>`: iteration
number, retry count, live state, facts the model cannot infer. Flagging those
as deletable is the one way this tool could do harm, so it is asserted directly
rather than assumed from the splitter's shape.
"""

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "prompt-lint.py"
_CORPUS = _ROOT / "loki-ts" / "tests" / "fixtures" / "build_prompt"

# Measured against the committed corpus: 60 fixtures, 58 with a cache prefix,
# 25 distinct blocks after digit-masked dedupe. The floor is set well below the
# measured value so an added fixture does not fail the suite, but high enough
# that a splitter returning a handful of fragments does.
_MIN_BLOCKS = 15


def _run(*args):
    return subprocess.run([sys.executable, str(_TOOL), *args],
                          capture_output=True, text=True, timeout=120)


def _report():
    r = _run("--json")
    return r, json.loads(r.stdout)["report"]


class VacuityGuard(unittest.TestCase):
    """Assert the scan found real content BEFORE any other assertion is trusted."""

    def test_the_scan_actually_found_instruction_blocks(self):
        r, report = _report()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertGreaterEqual(
            report["blocks_analyzed"], _MIN_BLOCKS,
            "scan found %d blocks; every 'nothing was flagged' assertion in "
            "this file is vacuous below the floor"
            % report["blocks_analyzed"])
        self.assertGreater(report["fixtures_with_prefix"], 0)

    def test_it_found_the_specific_block_we_know_is_there(self):
        """A count can be met by fragments. This names real text.

        RALPH WIGGUM is the largest coaching block in the committed corpus and
        appears in 48 prompts. If the splitter breaks, this fails with a
        specific cause instead of a number that drifted.
        """
        _, report = _report()
        texts = [b["text"] for b in report["blocks"]]
        self.assertTrue(
            any(t.startswith("RALPH WIGGUM MODE ACTIVE") for t in texts),
            "the known RALPH WIGGUM block is missing from the scan; the "
            "splitter is not reading the corpus")


class NeverFlagsPerIterationState(unittest.TestCase):
    """The one way this tool could do harm, asserted directly."""

    def test_no_dynamic_context_state_is_ever_ranked(self):
        _, report = _report()
        self.assertGreaterEqual(report["blocks_analyzed"], _MIN_BLOCKS)
        for b in report["blocks"]:
            for state in ("<dynamic_context", "Iteration 1 of max",
                          "NO COMPLETION PROMISE SET"):
                self.assertNotIn(
                    state, b["text"],
                    "ranked a per-iteration state string (%r); this is "
                    "below the cache breakpoint and must never be flagged"
                    % state)

    def test_fixtures_without_a_breakpoint_are_excluded_not_scored(self):
        """fixture-30 opens with 'Resume iteration #3 (retry #1)' -- pure state.

        Treating a marker-less fixture as all-prefix would rank that. The
        exclusion is the thing most likely to silently rot, so it is pinned by
        name rather than inferred from a count.
        """
        _, report = _report()
        excluded = {e["fixture"] for e in report["fixtures_excluded"]}
        self.assertIn("fixture-30", excluded)
        self.assertIn("fixture-51", excluded)
        for b in report["blocks"]:
            self.assertNotIn("Resume iteration", b["text"])


class RankingIsUsable(unittest.TestCase):
    def test_coaching_outranks_bare_information(self):
        """The scorer's whole claim, checked on two blocks with known character.

        RALPH WIGGUM is large, numbered, and names REASON/REFLECT/VERIFY.
        The AGENTS.md line is short and its content is a concrete filename the
        model cannot infer. If the second outranks the first the scorer is
        inverted.
        """
        _, report = _report()
        ranks = {}
        for i, b in enumerate(report["blocks"]):
            if b["text"].startswith("RALPH WIGGUM"):
                ranks.setdefault("coaching", i)
            if "read AGENTS.md" in b["text"]:
                ranks.setdefault("information", i)
        self.assertIn("coaching", ranks, "known coaching block not found")
        self.assertIn("information", ranks, "known information block not found")
        self.assertLess(
            ranks["coaching"], ranks["information"],
            "an information-bearing block outranked a pure-coaching block; "
            "the scoring direction is inverted")

    def test_a_substituted_value_does_not_split_one_instruction(self):
        """Dedupe, asserted on the case that actually broke it.

        Exact-string dedupe produced SEVEN RALPH WIGGUM rows occupying ranks 3
        through 6. Five of them differed only at `MAX_PARALLEL_AGENTS=10` vs
        `=12` -- one interpolated value, not one authored instruction, and a
        reader cannot run an ablation on "the =10 variant".

        Two rows legitimately survive: they carry OPPOSITE completion
        instructions ("There is NEVER a 'finished' state" against "claim done
        via loki_complete_task and STOP"). That is a real fork in the prompt
        and collapsing it would hide one of the two from the ranking. So this
        asserts the digit-masked count, not 1 -- the tool must merge
        substituted values and must NOT merge different instructions.
        """
        import re
        _, report = _report()
        ralph = [b for b in report["blocks"]
                 if b["text"].startswith("RALPH WIGGUM MODE ACTIVE")]
        self.assertTrue(ralph, "known block missing; scan is broken")
        distinct = {re.sub(r"\d+", "#", b["text"]) for b in ralph}
        self.assertEqual(
            len(ralph), len(distinct),
            "%d rows collapse to %d once digits are masked, so a substituted "
            "value is splitting one instruction across ranks"
            % (len(ralph), len(distinct)))
        top = max(ralph, key=lambda b: b["occurrences"])
        self.assertGreater(
            top["occurrences"], 1,
            "deduped rows must carry the summed occurrence count, or the "
            "reclaim estimate understates every recurring block")

    def test_every_rank_shows_its_reasons(self):
        """And the top rank shows a CONTENT reason, not just a size reason.

        Asserting only that `signals` is non-empty is near-vacuous here: every
        block over 100 bytes gets a `size:` entry automatically and the
        smallest analyzed block is 140 bytes, so that assertion could only fail
        for a size band the corpus does not contain. It would guard the size
        curve while appearing to guard the scorer. So the top-ranked block must
        also carry at least one NAMED content signal.
        """
        _, report = _report()
        self.assertGreaterEqual(report["blocks_analyzed"], _MIN_BLOCKS)
        for b in report["blocks"]:
            self.assertTrue(
                b["signals"],
                "block scored with no named signal; a rank whose reasons are "
                "invisible is one nobody can argue with")
        top = report["blocks"][0]
        content = [s for s in top["signals"]
                   if not s.startswith(("size:", "frequency("))]
        self.assertTrue(
            content,
            "top-ranked block justified by size and frequency alone (%s); "
            "then the ranking is a length sort wearing signal names"
            % top["signals"])


class AdvisoryFramingIsPrinted(unittest.TestCase):
    def test_output_says_it_does_not_decide(self):
        r = _run("--top", "3")
        self.assertEqual(r.returncode, 0)
        self.assertIn("ADVISORY", r.stdout)
        self.assertIn("never a licence to delete", r.stdout)

    def test_unmeasured_value_prints_unknown_not_zero(self):
        r = _run("--top", "3")
        self.assertIn("measured deletion value: UNKNOWN", r.stdout)


class ExitContract(unittest.TestCase):
    def test_missing_input_path_is_66(self):
        r = _run("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, 66)

    def test_usage_error_is_64_not_2(self):
        """2 means 'could not analyse', a real answer. A typo is not that."""
        r = _run("--tpo", "2")
        self.assertEqual(r.returncode, 64)

    def test_help_exits_zero_and_emits_no_verdict(self):
        r = _run("--help")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("RANKED DELETION CANDIDATES", r.stdout)
        self.assertNotIn("NOTHING TO ANALYZE", r.stdout)

    def test_nothing_to_analyze_is_3_and_says_so(self):
        """An empty ranking must never read as 'nothing to delete'."""
        with tempfile.TemporaryDirectory() as tmp:
            fx = pathlib.Path(tmp) / "fixture-1"
            fx.mkdir()
            (fx / "expected.txt").write_text("Resume iteration #3 (retry #1)\n")
            r = _run(str(tmp))
        self.assertEqual(r.returncode, 3)
        self.assertIn("NOTHING TO ANALYZE", r.stdout)

    def test_it_is_an_advisor_not_a_gate(self):
        """Name carries no gate-/guard- prefix or -gate/-guard suffix.

        tests/test_tool_exit_contract.py classifies by name, so a rename into
        gate shape would silently subject an honest exit 0 to the green-leak
        rule.
        """
        stem = _TOOL.name.rsplit(".", 1)[0]
        self.assertFalse(stem.endswith(("-gate", "-guard")))
        self.assertFalse(stem.startswith(("gate-", "guard-")))


if __name__ == "__main__":
    unittest.main()
