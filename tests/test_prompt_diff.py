"""tools/prompt-diff.py names what LOKI_SIMPLE=1 deletes, and refuses an arm
that would delete STATE.

THE VACUITY PROBLEM THIS FILE IS BUILT AROUND. Every assertion here is of the
form "X is absent from the simple arm" or "the tails match". Both are trivially
true of an empty string. A glob that silently matched nothing, or a corpus that
lost the [CACHE_BREAKPOINT] marker, would turn this whole file green while
proving nothing whatsoever -- so VacuityGuard runs three checks first, and every
later test asserts the FULL arm actually carried the thing before asserting the
simple arm lost it.

The load-bearing test is TailIsNeverAblated. Stripping coaching is an experiment
about prompt bloat; stripping state is a run that cannot see which gate just
failed. A byte count cannot tell those apart, which is why the tool exits 1 on
the second and this file pins that it does.
"""

import importlib.util
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "prompt-diff.py"
_CORPUS = _ROOT / "loki-ts" / "tests" / "fixtures" / "build_prompt"

# Hyphenated filename, so import it by path the way tests/test_cost_honesty_
# end_to_end.py loads proof-verify.py.
_spec = importlib.util.spec_from_file_location("prompt_diff", str(_TOOL))
pd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pd)


def _run(*args):
    return subprocess.run(
        [sys.executable, str(_TOOL), *args],
        capture_output=True, text=True, timeout=120)


def _fixture_texts():
    out = {}
    for path in sorted(_CORPUS.glob("fixture-*/expected.txt")):
        out[path.parent.name] = path.read_text(encoding="utf-8")
    return out


class VacuityGuard(unittest.TestCase):
    """Runs before anything else is believed. No corpus, no conclusions.

    A diff over an empty string reports no differences. If this class fails,
    every other assertion in this file is meaningless regardless of colour.
    """

    def test_the_scan_actually_found_fixtures(self):
        texts = _fixture_texts()
        self.assertGreater(
            len(texts), 0,
            "no fixture-*/expected.txt under %s -- every 'is absent' "
            "assertion below would pass vacuously" % _CORPUS)
        results = pd.scan(str(_CORPUS))
        self.assertEqual(
            len(results), len(texts),
            "scan() lost fixtures the glob can see; a short scan silently "
            "narrows what this file believes it checked")

    def test_the_corpus_carries_the_cache_breakpoint_marker(self):
        texts = _fixture_texts()
        with_marker = [n for n, t in texts.items() if pd.MARKER in t]
        self.assertGreater(
            len(with_marker), 0,
            "no fixture contains the literal %s -- without it there is no "
            "prefix/tail split, so 'the tails are identical' is a statement "
            "about two empty strings" % pd.MARKER)

    def test_the_full_arm_actually_carries_coaching_to_strip(self):
        """The third guard, and the one that catches a broken predicate.

        If is_coaching() ever stopped matching, `removed` would be empty
        everywhere and every absence assertion below would still pass.
        """
        results = [r for r in pd.scan(str(_CORPUS)) if r["checked"]]
        with_removals = [r for r in results if r["removed"]]
        self.assertGreater(
            len(with_removals), 0,
            "the strip predicate removed nothing from any fixture, so the "
            "flag's deletions cannot be observed at all")
        self.assertIn(
            "RALPH WIGGUM MODE ACTIVE.",
            "\n".join(l for r in results for l in r["removed"]),
            "the corpus no longer carries the canonical coaching line")

    def test_no_strip_anchor_is_stale(self):
        """An anchor matching nothing under-reports what the flag deletes.

        Same failure direction as printing 0 for an unmeasured value: the
        output looks complete and is quietly short.
        """
        results = [r for r in pd.scan(str(_CORPUS)) if r["checked"]]
        self.assertEqual(
            pd.unused_anchors(results), [],
            "these strip anchors match nothing in the corpus, so the tool is "
            "under-reporting what LOKI_SIMPLE=1 removes")


class TailIsNeverAblated(unittest.TestCase):
    """The single most important property, in both directions.

    Passing on the real corpus proves nothing on its own -- a tool that always
    printed PASS would also pass. So the negative case is constructed too.
    """

    def test_the_real_corpus_keeps_every_dynamic_tail_identical(self):
        results = [r for r in pd.scan(str(_CORPUS)) if r["checked"]]
        self.assertGreater(len(results), 0)  # vacuity, again, locally
        bad = [r["fixture"] for r in results if r["tail_identical"] is False]
        self.assertEqual(
            bad, [],
            "LOKI_SIMPLE=1 would change per-iteration STATE in %s; that is "
            "not an ablation of coaching, it is the run going blind" % bad)

    def test_the_strip_is_simulated_over_the_whole_document(self):
        """Not just the prefix, or the tail check compares the tail to itself.

        A coaching line placed BELOW the marker must be seen and removed. If
        simulate() only walked the prefix, this line would survive, the two
        tails would match, and the check could never fail.
        """
        text = ("<loki_system>\nLoki Mode\n</loki_system>\n"
                + pd.MARKER + "\n<dynamic_context>\n"
                + "MEMORY SYSTEM: injected below the marker\n"
                + "</dynamic_context>\n")
        r = pd.analyze("synthetic", text)
        self.assertTrue(r["checked"])
        self.assertFalse(
            r["tail_identical"],
            "a coaching-shaped line below the marker was not detected; "
            "simulate() is not walking the whole document")
        self.assertIsNotNone(r["tail_diff"])

    def test_a_tail_difference_exits_one_and_prints_a_loud_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            fx = pathlib.Path(tmp) / "fixture-1"
            fx.mkdir()
            (fx / "expected.txt").write_text(
                "<loki_system>\nLoki Mode\nRALPH WIGGUM MODE ACTIVE. coach\n"
                "</loki_system>\n" + pd.MARKER + "\n<dynamic_context>\n"
                "SDLC_PHASES_ENABLED: [UNIT] leaked into the tail\n"
                "</dynamic_context>\n", encoding="utf-8")
            r = _run(tmp)
        self.assertEqual(
            r.returncode, 1,
            "a fixture whose tail differs between arms must exit 1")
        self.assertIn("FAIL", r.stdout)
        self.assertIn("VERDICT: FAIL", r.stdout)

    def test_removing_the_marker_itself_is_a_fail_not_a_skip(self):
        """The most severe form of the defect must not read as 'cannot check'.

        Exit 2 would tell CI the axis was unevaluable; it was evaluated, and
        the answer was catastrophic.
        """
        text = "<loki_system>\nMEMORY SYSTEM: x " + pd.MARKER + "\ntail\n"
        r = pd.analyze("synthetic", text)
        self.assertTrue(r["checked"])
        self.assertFalse(r["tail_identical"])


class WhatSurvivesIsReported(unittest.TestCase):
    def test_the_task_anchor_survives_the_strip(self):
        """Stripping this would not be ablation, it would delete the question."""
        results = [r for r in pd.scan(str(_CORPUS)) if r["checked"]]
        anchored = [r for r in results
                    if any(l.startswith("Loki Mode") for l in r["survived"])]
        self.assertGreater(
            len(anchored), 0,
            "no fixture reports the task anchor as surviving; the tool cannot "
            "show that the model is still told what to do")

    def test_removed_lines_are_reported_verbatim_not_counted(self):
        """A count cannot say WHICH instruction vanished, which is the point."""
        results = [r for r in pd.scan(str(_CORPUS)) if r["checked"]]
        target = next(r for r in results if r["removed"])
        for line in target["removed"]:
            self.assertTrue(
                pd.is_coaching(line),
                "a non-coaching line was reported as removed: %r" % line[:80])
        out = pd.render(results, str(_CORPUS))
        self.assertIn("RALPH WIGGUM MODE ACTIVE.", out,
                      "render() summarised instead of naming the deletions")

    def test_unsplittable_fixtures_are_reported_not_silently_dropped(self):
        r = _run(str(_CORPUS))
        results = pd.scan(str(_CORPUS))
        skipped = [x for x in results if not x["checked"]]
        if skipped:
            self.assertIn("NOT CHECKED", r.stdout,
                          "fixtures that could not be split vanished from the "
                          "report instead of being declared")
            for x in skipped:
                self.assertIn(x["fixture"], r.stdout)


class DegradedProviderFlagIsInert(unittest.TestCase):
    """The flag does NOTHING on a degraded provider, and saying otherwise is a
    fabricated saving.

    buildPrompt returns buildStaticFirstDegraded (build_prompt.ts:1574-1577)
    before `const simple` is read at 1606, so LOKI_SIMPLE never reaches the
    gate. Verified against the real builder: both arms emit 4202 bytes on the
    degraded path, versus 7900 -> 1653 on the normal one.

    A text-only anchor match cannot see this. Before the fix, these fixtures
    were reported as saving ~992 tokens the flag cannot save.
    """

    def _degraded(self):
        out = []
        for path in sorted(_CORPUS.glob("fixture-*/env.txt")):
            if "PROVIDER_DEGRADED=true" in path.read_text(encoding="utf-8"):
                out.append(path.parent.name)
        return out

    def test_the_corpus_actually_contains_degraded_fixtures(self):
        """Vacuity guard for this class specifically."""
        self.assertGreater(
            len(self._degraded()), 0,
            "no PROVIDER_DEGRADED=true fixture, so every assertion in this "
            "class passes without exercising the degraded path")

    def test_a_degraded_fixture_reports_zero_removals(self):
        names = set(self._degraded())
        results = {r["fixture"]: r for r in pd.scan(str(_CORPUS))}
        for name in names:
            with self.subTest(fixture=name):
                r = results[name]
                self.assertTrue(r["degraded"])
                self.assertEqual(
                    r["removed"], [],
                    "%s is on the degraded path where LOKI_SIMPLE is inert, "
                    "but the tool claims the flag deletes lines there" % name)

    def test_a_degraded_fixture_reports_a_measured_zero_byte_delta(self):
        results = {r["fixture"]: r for r in pd.scan(str(_CORPUS))}
        for name in self._degraded():
            with self.subTest(fixture=name):
                r = results[name]
                self.assertEqual(
                    r["full_bytes"], r["simple_bytes"],
                    "%s must show identical arms, not a saving" % name)
                self.assertNotEqual(
                    r["full_bytes"], 0,
                    "a zero byte count would make equality vacuous")

    def test_the_inert_flag_is_stated_in_the_report(self):
        """Silently showing zero would read as 'nothing to strip', which is a
        different and false claim from 'the flag cannot act here'."""
        out = pd.render(pd.scan(str(_CORPUS)), str(_CORPUS))
        self.assertIn("FLAG INERT", out)
        for name in self._degraded():
            self.assertIn(name, out)


class AnchorsTrackTheSource(unittest.TestCase):
    """The docstring claims the anchors mirror the nine values pushed inside
    `if (!simple)`. Nothing verified that claim, so a tenth push added to that
    block would silently appear in the SURVIVES list as an instruction the flag
    keeps -- an affirmatively false statement, not merely a missing one.

    unused_anchors() catches a STALE anchor; this catches a NEW push.
    """

    SRC = _ROOT / "loki-ts" / "src" / "runner" / "build_prompt.ts"

    def test_the_strip_block_pushes_exactly_as_many_lines_as_we_have_anchors(self):
        text = self.SRC.read_text(encoding="utf-8")
        marker = "if (!simple) {"
        self.assertIn(
            marker, text,
            "the LOKI_SIMPLE gate is gone from build_prompt.ts; this tool's "
            "whole model of the flag is stale")
        block = text.split(marker, 1)[1].split("\n  }", 1)[0]
        pushes = block.count("lines.push(")
        self.assertEqual(
            pushes, len(pd.STRIP_ANCHORS),
            "build_prompt.ts strips %d lines but prompt-diff.py knows %d "
            "anchors; the tool is misreporting what LOKI_SIMPLE deletes"
            % (pushes, len(pd.STRIP_ANCHORS)))


class HonestyRules(unittest.TestCase):
    def test_tokens_are_labelled_an_estimate_never_a_measurement(self):
        out = pd.render(pd.scan(str(_CORPUS)), str(_CORPUS))
        self.assertIn("tokens saved (est., bytes/4)", out,
                      "a bare token count would dress a bytes/4 derivation up "
                      "as a measurement")

    def test_an_unmeasured_byte_count_reads_unknown_never_zero(self):
        line = pd._delta_line(None, 100)
        self.assertIn(pd.UNKNOWN, line)
        self.assertNotIn("delta +100", line)

    def test_a_measured_zero_delta_still_reads_zero(self):
        """Zero is falsy; a truthiness guard would report a real finding as
        UNKNOWN, which is the same lie pointed the other way."""
        line = pd._delta_line(500, 500)
        self.assertIn("+0", line)
        self.assertNotIn(pd.UNKNOWN, line)

    def test_num_maps_none_empty_and_bool_to_none(self):
        self.assertIsNone(pd._num(None))
        self.assertIsNone(pd._num(""))
        self.assertIsNone(pd._num(True))
        self.assertEqual(pd._num(0), 0)

    def test_an_empty_corpus_says_nothing_to_compare_and_exits_three(self):
        """Never an empty diff that a reader parses as 'no changes'."""
        with tempfile.TemporaryDirectory() as tmp:
            r = _run(tmp)
        self.assertEqual(r.returncode, 3)
        self.assertIn("NOTHING TO COMPARE", r.stdout)

    def test_a_corpus_with_no_marker_anywhere_cannot_check_and_exits_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            fx = pathlib.Path(tmp) / "fixture-1"
            fx.mkdir()
            (fx / "expected.txt").write_text("flat prompt, no marker\n",
                                             encoding="utf-8")
            r = _run(tmp)
        self.assertEqual(
            r.returncode, 2,
            "fixtures that exist but cannot be split is 'could NOT check', "
            "not a pass and not an empty corpus")
        self.assertIn("CANNOT CHECK", r.stdout)


class ExitCodeContract(unittest.TestCase):
    """0 passed, 1 FAILED, 2 could not check, 3 nothing, 64 usage, 66 missing."""

    def test_the_real_corpus_passes_and_exits_zero(self):
        r = _run(str(_CORPUS))
        self.assertEqual(r.returncode, 0, r.stdout[-2000:])
        self.assertIn("VERDICT: PASS", r.stdout)

    def test_a_bogus_flag_exits_sixty_four_not_two(self):
        """argparse defaults to 2, which in this tool line wrongly claims the
        axis could not be checked rather than that the command was malformed."""
        r = _run("--bogus")
        self.assertEqual(r.returncode, 64, r.stderr)

    def test_a_nonexistent_path_exits_sixty_six(self):
        r = _run("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, 66)
        self.assertIn("INPUT MISSING", r.stdout)

    def test_help_exits_zero_and_emits_no_verdict(self):
        r = _run("--help")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("VERDICT", r.stdout)
        self.assertNotIn("INPUT MISSING", r.stdout)

    def test_json_mode_is_parseable_on_every_exit_path(self):
        import json
        r = _run(str(_CORPUS), "--json")
        payload = json.loads(r.stdout)
        self.assertEqual(payload["tail_failures"], [])
        self.assertGreater(payload["checked"], 0)
        with tempfile.TemporaryDirectory() as tmp:
            bad = _run(tmp, "--json")
        json.loads(bad.stdout)  # the failure path must stay JSON


if __name__ == "__main__":
    unittest.main()
