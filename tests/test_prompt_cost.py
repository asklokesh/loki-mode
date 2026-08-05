"""prompt-cost.py reports the prompt split honestly, or says UNKNOWN.

THE VACUITY GUARD COMES FIRST, and everything else depends on it. This file
measures a real corpus on disk. If the glob silently returns nothing -- corpus
moved, fixture-* renamed, a bad default path -- then every "no fixture reported
a wrong number" assertion below passes trivially, because there were no
fixtures to report anything. A substring scan over an empty listing reports
nothing missing. That is the exact false-green defect this repo keeps paying
for, so the corpus is asserted non-empty BEFORE any assertion about its
contents is trusted.
"""

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "prompt-cost.py"
_FIXTURES = _ROOT / "loki-ts" / "tests" / "fixtures" / "build_prompt"

# Measured reference on the corpus as it stands. Deliberately a floor and not
# an equality: fixtures get added, and a test that pins the exact count becomes
# a chore rather than a check. The floor still fails loudly if the corpus
# vanishes, which is the failure this guards.
_MIN_FIXTURES = 50


def _run(*args):
    return subprocess.run(
        [sys.executable, str(_TOOL), *args],
        capture_output=True, text=True, timeout=120)


def _report(*args):
    r = _run(*(args + ("--json",)))
    assert r.returncode == 0, "tool exited %d: %s" % (r.returncode, r.stderr)
    return json.loads(r.stdout)


class VacuityGuard(unittest.TestCase):
    """Nothing below this class means anything if the corpus is empty."""

    def test_the_tool_and_the_corpus_both_exist(self):
        self.assertTrue(_TOOL.is_file(), "tools/prompt-cost.py is missing")
        self.assertTrue(_FIXTURES.is_dir(),
                        "the build_prompt fixture corpus is missing at %s; "
                        "every measurement below would be vacuous" % _FIXTURES)

    def test_the_scan_actually_found_fixtures(self):
        """The load-bearing guard: a real, non-trivial number of real files."""
        report = _report()
        n = report["aggregate"]["fixtures"]
        self.assertGreaterEqual(
            n, _MIN_FIXTURES,
            "the fixture scan found %d fixture(s); with an empty or truncated "
            "corpus every assertion in this file passes without measuring "
            "anything" % n)
        self.assertEqual(n, len(report["fixtures"]),
                         "the reported count and the reported rows disagree")

    def test_the_scan_found_splittable_fixtures(self):
        """Found-but-unsplittable is its own vacuity: rows with no measurement."""
        agg = _report()["aggregate"]
        self.assertGreater(
            agg["split_fixtures"], 0,
            "no fixture carried the marker, so every prefix/tail assertion "
            "below is about an absent measurement")


class TheSplitIsCorrect(unittest.TestCase):
    def test_prefix_plus_marker_plus_tail_reconstructs_every_file(self):
        """The identity that catches a slicing off-by-one.

        94.2%% + 5.6%% rounds to 99.8%%, so an off-by-one hides comfortably
        inside the gap between the two reported percentages. The marker's own
        18 bytes are the third slice, and only the exact identity sees them.
        """
        report = _report()
        marker_len = len(report["marker"].encode("utf-8"))
        checked = 0
        for r in report["fixtures"]:
            if r["prefix_bytes"] is None:
                continue
            with self.subTest(fixture=r["fixture"]):
                self.assertEqual(
                    r["prefix_bytes"] + marker_len + r["tail_bytes"],
                    r["total_bytes"],
                    "%s: the split does not reconstruct the file" % r["fixture"])
                self.assertEqual(
                    r["total_bytes"],
                    pathlib.Path(r["path"]).stat().st_size,
                    "%s: reported total disagrees with the file on disk"
                    % r["fixture"])
            checked += 1
        self.assertGreater(checked, 0, "no fixture was actually checked")

    def test_fixture_1_matches_the_measured_reference(self):
        """The stated reference: ~7909 bytes, prefix 94%, tail 5%."""
        rows = {r["fixture"]: r for r in _report()["fixtures"]}
        self.assertIn("fixture-1", rows)
        r = rows["fixture-1"]
        self.assertEqual(r["total_bytes"], 7909)
        self.assertEqual(r["prefix_bytes"], 7452)
        self.assertEqual(r["tail_bytes"], 439)
        self.assertAlmostEqual(r["prefix_share_pct"], 94.2, places=1)
        # bytes/4, floored.
        self.assertEqual(r["prefix_tokens"], 7452 // 4)
        self.assertEqual(r["tail_tokens"], 439 // 4)


class AnUnmeasuredValueIsUnknown(unittest.TestCase):
    """Rule 2: a fixture with no marker is UNKNOWN and excluded, never 0."""

    def test_marker_less_fixtures_report_unknown_not_zero(self):
        report = _report()
        unsplit = [r for r in report["fixtures"] if r["prefix_bytes"] is None]
        self.assertGreater(
            len(unsplit), 0,
            "expected at least one marker-less fixture (fixture-30, "
            "fixture-51); without one this rule is untested")
        for r in unsplit:
            with self.subTest(fixture=r["fixture"]):
                self.assertIsNone(r["prefix_bytes"])
                self.assertIsNone(r["tail_bytes"])
                self.assertIsNone(r["prefix_tokens"])
                self.assertIsNone(r["prefix_share_pct"])
                self.assertIsNotNone(r["reason"])

    def test_marker_less_fixtures_are_excluded_from_the_aggregate(self):
        """Two zeros folded into a 60-fixture mean drags it down silently."""
        report = _report()
        agg = report["aggregate"]
        rows = report["fixtures"]
        split = [r for r in rows if r["prefix_bytes"] is not None]
        self.assertEqual(agg["split_fixtures"], len(split))
        self.assertEqual(agg["unsplit_fixtures"], len(rows) - len(split))
        # The mean is over SPLIT fixtures only. Dividing the same sum by the
        # full count is the defect, and it produces a strictly smaller number.
        expected = sum(r["prefix_share_pct"] for r in split) / len(split)
        self.assertAlmostEqual(agg["mean_prefix_share_pct"], expected, places=9)
        if agg["unsplit_fixtures"]:
            diluted = sum(r["prefix_share_pct"] for r in split) / len(rows)
            self.assertGreater(
                agg["mean_prefix_share_pct"], diluted,
                "the mean equals the diluted figure, so unsplittable fixtures "
                "are being counted as 0%")

    def test_the_text_report_prints_unknown_never_a_zero_row(self):
        r = _run()
        self.assertEqual(r.returncode, 0)
        self.assertIn("UNKNOWN", r.stdout)
        for line in r.stdout.splitlines():
            if line.startswith("fixture-") and "UNKNOWN" not in line:
                self.assertNotIn(
                    " 0.0%", line,
                    "a measured row reported a 0.0%% prefix share: %r" % line)

    def test_the_summary_names_the_exclusions(self):
        report = _report()
        if report["aggregate"]["unsplit_fixtures"]:
            self.assertIn("EXCLUDED", report["summary"])


class TheSimpleSavingIsNeverFabricated(unittest.TestCase):
    """Rule 1, the sharpest one.

    LOKI_SIMPLE=1 strips nine coaching blocks but keeps <loki_system>, the PRD
    anchor and the closing tag, so the prefix is a CEILING. No fixture sets
    LOKI_SIMPLE, so the real saving was never observed here. Two specific wrong
    numbers are within reach and both are pinned out: the source comment's
    "8090 -> 1776, -78%" describes a prompt that is not in this corpus
    (fixture-1 is 7909 bytes), and "the prefix is 94% so it saves 94%" over-
    claims by everything that survives the strip.
    """

    def test_the_saving_is_reported_as_unknown(self):
        summary = _report()["summary"]
        self.assertIn("LOKI_SIMPLE", summary)
        self.assertIn("UNKNOWN", summary)

    def test_the_prefix_is_labelled_a_bound_not_a_saving(self):
        summary = _report()["summary"]
        self.assertIn("AT MOST", summary)
        self.assertIn("ceiling", summary)

    def test_no_figure_from_the_stale_source_comment_is_reported(self):
        """8090 / 1776 / -78% describe a prompt this corpus does not contain."""
        out = _run().stdout + json.dumps(_report())
        for stale in ("8090", "1776", "-78%", "78%"):
            self.assertNotIn(
                stale, out,
                "reported %r, a figure lifted from build_prompt.ts:1602 that "
                "does not describe this corpus" % stale)


class ExitCodeContract(unittest.TestCase):
    """0 measured, 3 nothing to measure, 64 usage, 66 path missing."""

    def test_measuring_the_real_corpus_exits_zero(self):
        self.assertEqual(_run(str(_FIXTURES)).returncode, 0)

    def test_an_unknown_flag_exits_64_not_2(self):
        """argparse defaults to 2, which in this repo means 'could not check'."""
        r = _run("--bogus")
        self.assertEqual(
            r.returncode, 64,
            "a usage error must be 64; 2 would tell CI the check was blind")

    def test_a_missing_path_exits_66(self):
        r = _run("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, 66)

    def test_an_empty_directory_exits_3_and_says_nothing_to_measure(self):
        """Rule 4: an empty corpus is never a tidy 0-byte report."""
        with tempfile.TemporaryDirectory() as d:
            r = _run(d)
            self.assertEqual(r.returncode, 3)
            self.assertIn("NOTHING TO MEASURE", r.stdout)

    def test_help_exits_zero_and_emits_no_verdict(self):
        r = _run("--help")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("NOTHING TO MEASURE", r.stdout)
        self.assertNotIn("does not exist", r.stdout)


class OutputShape(unittest.TestCase):
    def test_json_is_parseable_and_carries_the_marker_it_used(self):
        report = _report()
        self.assertEqual(report["report"], "loki-prompt-cost/v1")
        self.assertEqual(report["marker"], "[CACHE_BREAKPOINT]")
        self.assertEqual(report["bytes_per_token"], 4)

    def test_bytes_per_token_is_honoured(self):
        report = _report("--bytes-per-token", "2")
        self.assertEqual(report["bytes_per_token"], 2)
        rows = {r["fixture"]: r for r in report["fixtures"]}
        self.assertEqual(rows["fixture-1"]["prefix_tokens"], 7452 // 2)


if __name__ == "__main__":
    unittest.main()
