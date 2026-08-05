"""A summary is the surface where an absent measurement is cheapest to fake.

WHAT THIS GUARDS. receipt-stats.py answers "what IS this archive" -- how many
receipts, how verified, what they cost, over what span. Every one of those is a
count or an aggregate, and an aggregate is exactly where a missing value
disappears without trace: nobody reads a total and asks how many inputs it had.

The MEDIAN is the sharpest case in the whole cost-honesty line, sharper than
the total this repo already fixed on four surfaces (v8.51.0-v8.54.0). Summing
an unmeasured receipt as 0 understates a TOTAL by the spend nobody captured --
bad, but proportional. Feeding those same fake zeros into a MEDIAN is worse and
quieter: nulls-as-zero cluster at the bottom of the sorted list and shove the
midpoint down, so an archive of expensive runs with broken instrumentation
reports a cheap median while every individual real number in it stays correct.
The lie is manufactured entirely out of absences.

BOTH DIRECTIONS ARE ASSERTED, because the over-strict fix is its own dishonesty
and lands on the same line of code. A guard written as `if not total` blanks an
archive of receipts that each genuinely measured $0.0000 -- a real, recorded
observation reported as UNKNOWN. Erasing a measurement and inventing one are
the same failure pointed opposite ways, and `if measured_n` vs `if total` is
where both are decided. The exclusion must also be COUNTED and REPORTED: a
total computed from 3 of 40 receipts is not wrong, but presented without that
ratio it is read as exhaustive, which is.

Also pinned here, because they are judgements a later reader could "fix":

  - Zero receipts exits 3 and says so in words. Nothing to summarise is not a
    clean archive; it is usually the wrong directory.
  - A missing workspace exits 66, NOT 3. "You pointed me at nothing" and "this
    archive is empty" are different facts and only one is about the archive.
  - An unknown flag exits 64, NOT argparse's default 2. Here 2 means "could not
    be checked", so a typo would masquerade as a blind gate.
  - An archive where nothing measured cost still exits 0. That is a complete,
    honest answer -- the output says UNKNOWN in words -- and forcing it
    non-zero would train operators to ignore the tool.
  - A malformed receipt keeps its own bucket, separate from UNVERIFIABLE.
    Unreadable bytes and an unre-derivable diff have different fixes.
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

# A stale .pyc can mask a mutation and make a real probe report a false
# "MUTATION SURVIVED": invalidation is mtime+size, and a probe's restore is
# byte-identical. Set before the loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "receipt-stats.py"

_spec = importlib.util.spec_from_file_location("receipt_stats", _TOOL)
_rs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rs)


def _measured(usd, date="2026-03-01"):
    """A receipt carrying a real measurement.

    Tokens are non-zero so record_is_measured() is satisfied by evidence rather
    than by the `usd` field alone -- that keeps the $0.00-is-real fixture below
    honest, since a receipt with usd=0.0 and no tokens is genuinely unmeasured
    and must not be mistaken for a measured zero.
    """
    return {
        "generated_at": "%sT10:00:00Z" % date,
        "cost": {"usd": usd, "input_tokens": 100, "output_tokens": 50,
                 "cache_read_tokens": 0, "cache_creation_tokens": 0},
    }


def _unmeasured(date="2026-03-01"):
    """The exact shape a real run produced before v8.51.0: present, all zero.

    `available: true` is deliberate. It is a CLAIM, and a real receipt shipped
    it alongside every field zero. The predicate must read the values.
    """
    return {
        "generated_at": "%sT10:00:00Z" % date,
        "cost": {"usd": None, "available": True, "input_tokens": 0,
                 "output_tokens": 0, "cache_read_tokens": 0,
                 "cache_creation_tokens": 0},
    }


class _Workspace(unittest.TestCase):
    """Builds throwaway archives. Nothing is read from tests/fixtures/."""

    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self._n = 0

    def write(self, proof):
        """Drop one receipt into its own directory. Returns the path."""
        self._n += 1
        d = os.path.join(self.ws, "run%02d" % self._n)
        os.makedirs(d)
        p = os.path.join(d, "proof.json")
        with open(p, "w", encoding="utf-8") as f:
            if isinstance(proof, str):
                f.write(proof)
            else:
                json.dump(proof, f)
        return p

    def stats(self):
        return _rs.stats(self.ws, self.ws)

    def run_tool(self, *args):
        return subprocess.run(
            [sys.executable, str(_TOOL), *args],
            capture_output=True, text=True, timeout=120)


class UnmeasuredNeverEntersTheCostStatistics(_Workspace):
    """Rule 1, and the reason this file exists.

    Called directly rather than through the CLI: a mutation that crashes exits
    non-zero through a subprocess boundary too, so a subprocess assertion
    cannot tell "the median is wrong" from "the tool died". A direct call gives
    a clean AssertionError naming the two numbers.
    """

    def test_the_median_ignores_unmeasured_receipts(self):
        """THE mutation target: unmeasured receipts summed as 0 into the median.

        Measured costs are [10, 20, 30] -- a true median of 20.0. Three
        unmeasured receipts sit alongside them. Fold those in as 0.0 and the
        sorted list becomes [0, 0, 0, 10, 20, 30], whose median is 5.0.

        The fixture is built so the wrong answer cannot coincide with the right
        one: the fakes outnumber nothing by accident, they drag the midpoint
        clean out of the measured range entirely.
        """
        for usd in (10.0, 20.0, 30.0):
            self.write(_measured(usd))
        for _ in range(3):
            self.write(_unmeasured())

        cost = self.stats()["cost"]

        self.assertEqual(
            cost["median_usd"], 20.0,
            "the median must be taken over MEASURED costs only; folding "
            "unmeasured receipts in as 0.0 drags it below every real "
            "observation in the archive")
        self.assertEqual(cost["measured_receipts"], 3)
        self.assertEqual(cost["unmeasured_receipts"], 3)

    def test_the_total_ignores_unmeasured_receipts(self):
        for usd in (10.0, 20.0, 30.0):
            self.write(_measured(usd))
        for _ in range(3):
            self.write(_unmeasured())

        self.assertEqual(
            self.stats()["cost"]["total_usd"], 60.0,
            "an unmeasured receipt contributes nothing; adding 0.0 for it "
            "understates the total by exactly the spend nobody captured")

    def test_the_exclusion_is_counted_and_reported(self):
        """A total from 1 of 4 receipts is read as exhaustive without the ratio."""
        self.write(_measured(42.0))
        for _ in range(3):
            self.write(_unmeasured())

        report = self.stats()
        self.assertEqual(report["cost"]["unmeasured_receipts"], 3)
        self.assertIn("EXCLUDED", report["summary"])
        self.assertIn("3 receipt(s)", report["summary"])

    def test_a_receipt_with_tokens_but_no_dollar_figure_has_no_cost(self):
        """Measured is necessary but NOT sufficient for a dollar figure.

        record_is_measured() is true when ANY of five fields is non-zero, so
        this receipt is honestly measured -- and still carries no usd. Reading
        the predicate alone and defaulting the amount to 0.0 would invent a
        measurement out of a receipt that proves only that tokens moved.
        """
        self.write({"generated_at": "2026-03-01T10:00:00Z",
                    "cost": {"usd": None, "input_tokens": 900,
                             "output_tokens": 400}})
        cost = self.stats()["cost"]
        self.assertEqual(cost["measured_receipts"], 0)
        self.assertIsNone(cost["total_usd"])
        self.assertIsNone(cost["median_usd"])


class NothingMeasuredReadsUnknown(_Workspace):
    """Rule 2. The archive-wide case, where $0.00 is the tempting default."""

    def test_totals_are_none_when_no_receipt_measured_cost(self):
        for _ in range(4):
            self.write(_unmeasured())

        cost = self.stats()["cost"]
        self.assertIsNone(
            cost["total_usd"],
            "with nothing measured the total is an ABSENT fact; 0.0 would "
            "assert the archive was free")
        self.assertIsNone(cost["median_usd"])
        self.assertEqual(cost["measured_receipts"], 0)

    def test_the_rendered_summary_says_unknown_and_never_a_dollar_zero(self):
        """Asserts the absence of a rendered FIGURE, not of the characters.

        The summary deliberately contains the phrase "Not $0.00: unmeasured is
        not free", so a bare `assertNotIn("$0.00")` fails on the very sentence
        that makes the tool honest. What must not appear is a total or median
        PRESENTED as a measurement.
        """
        for _ in range(4):
            self.write(_unmeasured())

        summary = self.stats()["summary"]
        self.assertIn("UNKNOWN", summary)
        self.assertNotIn("total $", summary)
        self.assertNotIn("median $", summary)

    def test_the_unknown_sentence_never_states_a_false_count(self):
        """The UNKNOWN branch is reachable with measured receipts present.

        It fires when a figure went missing without the count going with it, so
        a hardcoded "0 of N measured" would print a number contradicted by the
        report it sits in -- this file's whole subject, committed by the tool
        itself.
        """
        line = _rs._cost_line({"measured_receipts": 3, "unmeasured_receipts": 1,
                               "total_usd": None, "median_usd": None})
        self.assertIn("UNKNOWN", line)
        self.assertNotIn("0 of 4", line)
        self.assertIn("3 measured", line)

    def test_an_all_unmeasured_archive_still_exits_zero(self):
        """The judgement pinned so a later reader does not 'fix' it.

        This is an advisor. Every receipt was found and read, and none recorded
        a cost -- that is a complete, successful, honest answer, and the output
        says UNKNOWN in words. A non-zero exit here would make the honest
        answer look like a tool failure.
        """
        for _ in range(3):
            self.write(_unmeasured())

        r = self.run_tool(self.ws)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("UNKNOWN", r.stdout)


class AMeasuredZeroSurvivesAsZero(_Workspace):
    """Rule 3, and the OVER-STRICT direction of the same line of code.

    A guard written `if not total` cannot tell "we measured nothing" from "we
    measured, and it was free". It reports both as UNKNOWN, silently deleting a
    real observation. That is the guard being dishonest in the direction nobody
    watches for, and it would blank the cost surface for exactly the cheap runs
    the 20x cost-per-issue spread is measured from.
    """

    def test_an_archive_of_genuine_zeros_reports_zero_not_unknown(self):
        """The over-strict mutation must fail on THIS assertion, not crash.

        _cost_line() decides UNKNOWN from measured_receipts and is written so a
        None total cannot reach its %.4f -- see the tool. That is what lets an
        over-strict guard (`if total` instead of `if measured_n`) surface here
        as a clean "None is not None" naming the rule, rather than as a
        TypeError in the renderer, which is a crash and evidence of nothing.
        """
        for _ in range(3):
            self.write(_measured(0.0))

        cost = self.stats()["cost"]

        self.assertIsNotNone(
            cost["total_usd"],
            "three receipts that each MEASURED $0.0000 is an observation; "
            "reporting it as UNKNOWN erases real data")
        self.assertIsNotNone(
            cost["median_usd"],
            "a measured zero median is a real midpoint, not an absent one")
        self.assertEqual(cost["total_usd"], 0.0)
        self.assertEqual(cost["median_usd"], 0.0)
        self.assertEqual(cost["measured_receipts"], 3)

    def test_a_measured_zero_does_not_suppress_its_neighbours(self):
        """A real 0.0 belongs IN the median, unlike a null."""
        self.write(_measured(0.0))
        self.write(_measured(10.0))
        self.write(_measured(20.0))

        self.assertEqual(self.stats()["cost"]["median_usd"], 10.0)

    def test_median_of_an_even_count_averages_the_middle_pair(self):
        for usd in (1.0, 3.0, 5.0, 11.0):
            self.write(_measured(usd))

        self.assertEqual(self.stats()["cost"]["median_usd"], 4.0)


class MalformedIsCountedNeverSkipped(_Workspace):
    """Rule 4. A summary that drops what it cannot read invents a tidier archive."""

    def test_a_malformed_receipt_is_counted_in_its_own_bucket(self):
        self.write(_measured(5.0))
        self.write("this is not json {{{")

        report = self.stats()
        self.assertEqual(report["receipt_count"], 2)
        self.assertEqual(report["counts"]["MALFORMED"], 1)
        self.assertEqual(report["malformed_count"], 1)

    def test_a_malformed_receipt_is_named_with_its_reason(self):
        bad = self.write("this is not json {{{")

        entry = self.stats()["malformed"][0]
        self.assertEqual(entry["path"], bad)
        self.assertTrue(entry["reason"],
                        "a count without a reason cannot be acted on")

    def test_a_json_array_is_malformed_not_an_empty_receipt(self):
        """Valid JSON of the wrong shape is unreadable, not blank."""
        self.write("[]")
        self.assertEqual(self.stats()["counts"]["MALFORMED"], 1)

    def test_malformed_stays_separate_from_unverifiable(self):
        """The bucket receipt_state() would have folded it into.

        receipt_state() reports an unloadable receipt as UNVERIFIABLE, which is
        right for a verdict and wrong for a census: "these bytes are not JSON"
        and "this diff cannot be re-derived outside its repo" have different
        fixes, and merging them hides which one an operator is looking at.
        """
        self.write("not json at all")
        counts = self.stats()["counts"]
        self.assertEqual(counts["MALFORMED"], 1)
        self.assertEqual(counts["UNVERIFIABLE"], 0)

    def test_a_malformed_row_carries_the_same_keys_as_every_other_row(self):
        """A consumer must not KeyError on the rows rule 4 exists to surface.

        The malformed row is the one an integration is most likely to want a
        reason from, and it was the one row missing the key.
        """
        self.write(_measured(1.0))
        self.write("not json {")

        rows = self.stats()["receipts"]
        keys = [set(r) for r in rows]
        self.assertEqual(keys[0], keys[1],
                         "malformed rows must share the schema of the rest")
        bad = [r for r in rows if r["state"] == "MALFORMED"][0]
        self.assertTrue(bad["reason"])

    def test_every_receipt_lands_in_exactly_one_bucket(self):
        """The census adds up, so nothing can vanish between the buckets."""
        self.write(_measured(1.0))
        self.write(_unmeasured())
        self.write("nope {")

        report = self.stats()
        self.assertEqual(
            sum(report["counts"].values()), report["receipt_count"],
            "a receipt counted in no bucket has been silently dropped")


class TheDateRangeIsMeasuredNotGuessed(_Workspace):
    def test_the_range_spans_first_to_last(self):
        self.write(_measured(1.0, date="2026-03-05"))
        self.write(_measured(2.0, date="2026-01-02"))
        self.write(_measured(3.0, date="2026-07-30"))

        dates = self.stats()["dates"]
        self.assertEqual(dates["first"], "2026-01-02")
        self.assertEqual(dates["last"], "2026-07-30")
        self.assertEqual(dates["dated_receipts"], 3)

    def test_an_undated_archive_reports_unknown_not_a_fabricated_range(self):
        self.write({"cost": {"usd": 1.0, "input_tokens": 5}})

        dates = self.stats()["dates"]
        self.assertIsNone(dates["first"])
        self.assertIsNone(dates["last"])
        self.assertIn("UNKNOWN", self.stats()["summary"])

    def test_an_unparseable_generated_at_is_not_counted_as_a_date(self):
        self.write({"generated_at": "sometime last tuesday",
                    "cost": {"usd": 1.0, "input_tokens": 5}})
        self.assertEqual(self.stats()["dates"]["dated_receipts"], 0)


class TheExitCodesKeepTheirDistinctions(_Workspace):
    """Rule 5 plus the convention tests/test_tool_exit_contract.py enforces."""

    def test_an_empty_workspace_exits_three_and_says_nothing_was_found(self):
        r = self.run_tool(self.ws)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("NO RECEIPTS", r.stdout)

    def test_a_missing_workspace_exits_sixty_six_not_three(self):
        """Distinct from empty: only one of the two is a fact about an archive."""
        r = self.run_tool("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, 66, r.stdout + r.stderr)

    def test_an_unknown_flag_exits_sixty_four_not_two(self):
        """argparse defaults to 2, which in this convention means "could not
        check" -- so a typo would masquerade as a blind gate."""
        r = self.run_tool(self.ws, "--not-a-real-flag")
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)

    def test_an_unknown_flag_is_never_read_as_a_path(self):
        r = self.run_tool("--not-a-real-flag")
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)
        self.assertNotIn("NO RECEIPTS", r.stdout)

    def test_help_exits_zero_and_emits_no_verdict(self):
        r = self.run_tool("--help")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for word in ("NO RECEIPTS", "UNKNOWN", "receipt(s):"):
            self.assertNotIn(word, r.stdout,
                             "--help answered a question nobody asked")

    def test_a_populated_workspace_exits_zero(self):
        self.write(_measured(1.0))
        r = self.run_tool(self.ws)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_a_failed_receipt_does_not_make_this_a_gate(self):
        """Pins the advisor judgement.

        A receipt with no integrity hash classifies FAILED. This reports the
        count; receipt-bundle.py is the gate that refuses to merge on it.
        Exiting non-zero here would be a second copy of the weakest-link rule,
        which is the predicate drift the honesty line keeps paying for.
        """
        self.write(_measured(1.0))
        report = self.stats()
        self.assertTrue(report["counts"]["FAILED"]
                        or report["counts"]["UNVERIFIABLE"],
                        "fixture assumption: a hashless receipt does not verify")

        r = self.run_tool(self.ws)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


class TheJsonReportCarriesTheSameFacts(_Workspace):
    """--json is what a machine reads; it must not be more confident than the text."""

    def test_json_is_parseable_and_nulls_stay_null(self):
        for _ in range(2):
            self.write(_unmeasured())

        r = self.run_tool(self.ws, "--json")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        report = json.loads(r.stdout)
        self.assertIsNone(report["cost"]["total_usd"])
        self.assertIsNone(report["cost"]["median_usd"])

    def test_json_reports_a_measured_zero_as_zero(self):
        self.write(_measured(0.0))

        report = json.loads(self.run_tool(self.ws, "--json").stdout)
        self.assertEqual(report["cost"]["total_usd"], 0.0)

    def test_the_table_renders_an_unmeasured_cost_as_a_dash(self):
        """The surface an operator eyeballs must not be where the archive
        looks free.

        The cost COLUMN is asserted, not the presence of a hyphen anywhere in
        the output -- every temp path contains hyphens, so a bare substring
        check here would pass no matter what the tool printed.
        """
        path = self.write(_unmeasured())

        row = [ln for ln in self.run_tool(self.ws).stdout.splitlines()
               if path in ln]
        self.assertEqual(len(row), 1, "expected exactly one row per receipt")
        self.assertNotIn("$", row[0],
                         "an unmeasured receipt must show no dollar figure")
        self.assertIn("-", row[0].split(path)[0])


class MedianIsCorrectInIsolation(unittest.TestCase):
    """The helper, exercised directly. It must take only what it was given."""

    def test_empty_is_none_never_zero(self):
        self.assertIsNone(_rs.median([]))

    def test_odd_count_takes_the_middle(self):
        self.assertEqual(_rs.median([5.0, 1.0, 3.0]), 3.0)

    def test_even_count_averages_the_middle_pair(self):
        self.assertEqual(_rs.median([1.0, 2.0, 3.0, 4.0]), 2.5)

    def test_a_list_of_real_zeros_medians_to_zero(self):
        self.assertEqual(_rs.median([0.0, 0.0, 0.0]), 0.0)


if __name__ == "__main__":
    unittest.main()
