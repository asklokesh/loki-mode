"""A timeline must not invent order, adjacency, or change.

WHY THIS EXISTS. tools/receipt-timeline.py lays an archive of receipts out
oldest-first and states what changed at each step. That is a strictly stronger
claim than receipt-stats.py's census, and each extra claim is a way to be
wrong without printing anything obviously false:

    ORDER      -- a receipt with no readable timestamp has no position, and
                  giving it one (path order, mtime, the end of the list) is a
                  fabrication that looks exactly like data.
    ADJACENCY  -- a delta between two rows asserts they are consecutive runs.
                  Across an invented position, that assertion is false.
    CHANGE     -- `curr - prev` with an unmeasured operand read as 0.0 does not
                  print a wrong number, it prints a wrong STORY: the run whose
                  instrumentation broke becomes the moment cost collapsed.
                  That is v8.51.0-v8.54.0 aimed at a trend line.

The sharpest of the three is the first, because its failure mode is SILENCE.
A dropped receipt does not appear as a gap; the history simply reads shorter,
tidier and more complete than it is, and nothing in the output says a receipt
went missing. So it gets its own class below, and it is the mutation this
suite is probed against.

BOTH DIRECTIONS ARE ASSERTED throughout. A guard so strict that it suppressed
genuine data would be its own dishonesty: a measured $0.0000 delta blanked to
UNKNOWN erases the single most useful cell in the table ("cost did not
change"), and a dated receipt misclassified as undated destroys the ordering
the tool exists to provide. Every rule here is tested for what it must catch
AND for what it must not swallow.
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

# A stale .pyc can mask a mutation and turn a real probe into a false
# "MUTATION SURVIVED", since invalidation is mtime+size and a restore is
# byte-identical. Set before the loader below runs.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "receipt-timeline.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_tl = _load("receipt_timeline", _TOOL)


def _row(path, when, cost_usd, state="VERIFIED", gates=None):
    """One timeline input row. `timeline()` is pure, so this is the whole world."""
    return {
        "path": path, "state": state, "reason": "",
        "when": when, "cost_usd": cost_usd, "gates": gates or {},
    }


# The exact shape of a receipt whose instrumentation never fired: cost block
# present, `available` claiming true, every field zero. A real receipt shipped
# this (fixed v8.52.0), which is why the flag is not trusted.
_UNMEASURED_COST = {
    "usd": 0.0, "input_tokens": 0, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_creation_tokens": 0, "available": True,
}

# A run that genuinely cost nothing but DID measure: tokens observed, dollars
# honestly zero. Distinguishing this from the block above is rule 3.
_MEASURED_ZERO_COST = {
    "usd": 0.0, "input_tokens": 9412, "output_tokens": 23,
    "cache_read_tokens": 11008, "cache_creation_tokens": 0, "available": True,
}

_MEASURED_COST = {
    "usd": 0.5, "input_tokens": 9412, "output_tokens": 23,
    "cache_read_tokens": 11008, "cache_creation_tokens": 0, "available": True,
}


def _proof(generated_at=None, cost=None, gates=None):
    p = {"facts": {}, "honesty": {}, "verification": {"hash": "x"}}
    if generated_at is not None:
        p["generated_at"] = generated_at
    if cost is not None:
        p["cost"] = cost
    if gates is not None:
        p["gates"] = gates
    return p


def _workspace(receipts):
    """A temp workspace holding `receipts` as {subdir: proof-dict}."""
    d = tempfile.mkdtemp(prefix="loki-timeline-")
    for name, proof in receipts.items():
        sub = pathlib.Path(d) / name
        sub.mkdir(parents=True, exist_ok=True)
        (sub / "proof.json").write_text(json.dumps(proof), encoding="utf-8")
    return d


def _run(*args):
    return subprocess.run(
        [sys.executable, str(_TOOL), *args],
        capture_output=True, text=True, timeout=120)


class AnUndatedReceiptIsCountedNotDropped(unittest.TestCase):
    """The silent failure: a receipt that vanishes leaves no gap behind.

    The defect this class pins is `[r for r in rows if r["when"] is not None]`
    with no matching undated partition -- the timeline still renders, still
    reads coherently, and is simply missing a run. Nothing in the output says
    so. That is why the assertions below are on the COUNT and on the presence
    of the row, not on a warning string: a tool can be made to print a warning
    while still dropping the receipt.
    """

    def test_an_undated_receipt_survives_into_the_report(self):
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0),
            _row("/b/proof.json", None, 2.0),
            _row("/c/proof.json", "2026-01-02T00:00:00Z", 3.0),
        ])
        seen = ([r["path"] for r in out["dated"]]
                + [r["path"] for r in out["undated"]])
        self.assertIn(
            "/b/proof.json", seen,
            "the undated receipt was dropped from the timeline; the history "
            "now reads shorter and tidier than it is, and nothing says so")
        self.assertEqual(
            len(seen), 3,
            "a receipt went missing between input and report: %r" % (seen,))

    def test_the_undated_receipt_is_in_the_undated_section(self):
        """Counted is not enough -- it must not be counted as DATED."""
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0),
            _row("/b/proof.json", None, 2.0),
        ])
        self.assertEqual([r["path"] for r in out["undated"]], ["/b/proof.json"])
        self.assertNotIn(
            "/b/proof.json", [r["path"] for r in out["dated"]],
            "an undated receipt was given a position in the order it has no "
            "evidence for")

    def test_an_undated_receipt_gets_no_delta(self):
        """No invented adjacency. A neighbour by list position is not a neighbour."""
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0),
            _row("/b/proof.json", None, 9.0),
        ])
        undated = out["undated"][0]
        self.assertIsNone(
            undated["cost_delta_usd"],
            "a delta was computed across an adjacency the data does not "
            "support: the undated receipt may predate everything here")
        self.assertIn("UNDATED", undated["change"])

    def test_the_undated_receipt_does_not_corrupt_the_dated_deltas(self):
        """The opposite error: holding it out must not disturb the real chain."""
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0),
            _row("/undated/proof.json", None, 100.0),
            _row("/c/proof.json", "2026-01-02T00:00:00Z", 3.0),
        ])
        self.assertEqual([r["path"] for r in out["dated"]],
                         ["/a/proof.json", "/c/proof.json"])
        self.assertAlmostEqual(out["dated"][1]["cost_delta_usd"], 2.0)

    def test_end_to_end_an_undated_receipt_reaches_the_json_report(self):
        """Through the real filesystem path, not just the pure function."""
        ws = _workspace({
            "run-a": _proof("2026-01-01T00:00:00Z", _MEASURED_COST),
            "run-b": _proof(None, _MEASURED_COST),
        })
        r = _run(ws, "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads(r.stdout)
        self.assertEqual(
            report["receipt_count"], 2,
            "the census lost a receipt: %s" % r.stdout)
        self.assertEqual(report["undated_count"], 1)
        self.assertEqual(report["dated_count"], 1)


class ADatedReceiptIsNotMisreadAsUndated(unittest.TestCase):
    """The over-strict direction. Blanking real timestamps destroys the order.

    A timestamp parser tightened until it rejects valid receipts converts the
    whole archive into an unordered pile, which is rule 1 failing the other
    way: it does not invent a position, it destroys every real one.
    """

    def test_a_z_suffixed_timestamp_is_read(self):
        """The shape every real receipt uses. fromisoformat rejects it pre-3.11."""
        self.assertEqual(
            _tl._when({"generated_at": "2026-01-01T00:00:00Z"}),
            "2026-01-01T00:00:00Z")

    def test_an_offset_timestamp_is_read(self):
        self.assertEqual(
            _tl._when({"generated_at": "2026-01-01T00:00:00+00:00"}),
            "2026-01-01T00:00:00+00:00")

    def test_a_non_timestamp_is_undated_not_guessed(self):
        for bad in (None, "", "soon", 12345, {"t": 1}, "notadate!!"):
            with self.subTest(value=bad):
                self.assertIsNone(_tl._when({"generated_at": bad}))

    def test_receipts_are_ordered_oldest_first_not_by_path(self):
        out = _tl.timeline([
            _row("/z-newest/proof.json", "2026-03-01T00:00:00Z", 1.0),
            _row("/a-oldest/proof.json", "2026-01-01T00:00:00Z", 1.0),
            _row("/m-middle/proof.json", "2026-02-01T00:00:00Z", 1.0),
        ])
        self.assertEqual(
            [r["when"][:10] for r in out["dated"]],
            ["2026-01-01", "2026-02-01", "2026-03-01"],
            "the timeline is in path order, not time order")


class AnUnmeasuredNeighbourMakesTheDeltaUnknown(unittest.TestCase):
    """v8.51.0-v8.54.0 aimed at a trend line.

    Subtracting an absent measurement does not print a wrong number so much as
    a wrong narrative: the run whose instrumentation broke becomes the moment
    cost collapsed, or exploded, depending on which side went dark.
    """

    def test_delta_against_an_unmeasured_previous_is_unknown(self):
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", None),
            _row("/b/proof.json", "2026-01-02T00:00:00Z", 3.0),
        ])
        step = out["dated"][1]
        self.assertIsNone(
            step["cost_delta_usd"],
            "the delta was computed against a cost nobody measured, so the "
            "archive reports a $3.00 rise that never happened")
        self.assertIn("UNKNOWN", step["change"])
        self.assertNotIn("$3.0000", step["change"])

    def test_delta_against_an_unmeasured_current_is_unknown(self):
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 3.0),
            _row("/b/proof.json", "2026-01-02T00:00:00Z", None),
        ])
        self.assertIsNone(out["dated"][1]["cost_delta_usd"])
        self.assertIn("UNKNOWN", out["dated"][1]["change"])

    def test_an_all_zero_cost_block_is_unmeasured_end_to_end(self):
        """The predicate is record_is_measured(), reached through measured_cost()."""
        self.assertIsNone(
            _tl._usd(_proof("2026-01-01T00:00:00Z", _UNMEASURED_COST)),
            "a cost block of all zeros with available=true was read as a "
            "measured $0.00; that is the receipt v8.52.0 fixed")

    def test_the_rendered_table_shows_a_dash_not_a_dollar_zero(self):
        ws = _workspace({
            "run-a": _proof("2026-01-01T00:00:00Z", _UNMEASURED_COST),
            "run-b": _proof("2026-01-02T00:00:00Z", _UNMEASURED_COST),
        })
        r = _run(ws)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(
            "$0.0000", r.stdout,
            "an unmeasured archive rendered as free; unmeasured is not $0.00")
        self.assertIn("UNKNOWN", r.stdout)


class AMeasuredZeroSurvivesAsZero(unittest.TestCase):
    """The over-strict direction, and the cell an operator most wants.

    "cost did not change" is a finding. `if delta:` blanks exactly that cell,
    so a stable archive becomes indistinguishable from an unmeasured one --
    erasing an observation is the same dishonesty as inventing one, pointed
    the other way.
    """

    def test_a_zero_delta_reads_zero_not_unknown(self):
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 4.25),
            _row("/b/proof.json", "2026-01-02T00:00:00Z", 4.25),
        ])
        step = out["dated"][1]
        self.assertIsNotNone(
            step["cost_delta_usd"],
            "a measured, unchanged cost was reported as UNKNOWN; the archive "
            "can no longer say it was stable")
        self.assertEqual(step["cost_delta_usd"], 0.0)
        self.assertNotIn("UNKNOWN", step["change"])
        self.assertIn("UNCHANGED", step["change"])

    def test_a_measured_zero_cost_on_both_sides_still_yields_zero(self):
        """$0.0000 is a valid operand, not a signal of absence."""
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 0.0),
            _row("/b/proof.json", "2026-01-02T00:00:00Z", 0.0),
        ])
        self.assertEqual(out["dated"][1]["cost_delta_usd"], 0.0)
        self.assertNotIn("UNKNOWN", out["dated"][1]["change"])

    def test_a_receipt_with_tokens_and_zero_usd_is_measured(self):
        usd = _tl._usd(_proof("2026-01-01T00:00:00Z", _MEASURED_ZERO_COST))
        self.assertIsNotNone(
            usd, "a genuinely free run with observed tokens was thrown away")
        self.assertEqual(usd, 0.0)

    def test_a_fall_to_zero_is_reported_as_a_fall(self):
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 2.0),
            _row("/b/proof.json", "2026-01-02T00:00:00Z", 0.0),
        ])
        self.assertEqual(out["dated"][1]["cost_delta_usd"], -2.0)
        self.assertIn("FELL", out["dated"][1]["change"])


class AGateThatPassedAndNowFails(unittest.TestCase):
    """The other half of "what changed": a regression, and only a real one."""

    def test_a_pass_to_fail_transition_is_named(self):
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0,
                 gates={"mock_integrity": True, "tests": True}),
            _row("/b/proof.json", "2026-01-02T00:00:00Z", 1.0,
                 gates={"mock_integrity": False, "tests": True}),
        ])
        step = out["dated"][1]
        self.assertEqual(step["gate_regressions"], ["mock_integrity"])
        self.assertIn("mock_integrity", step["change"])

    def test_a_gate_absent_from_the_previous_receipt_is_not_a_regression(self):
        """Absent is not passing. A first appearance is not a transition."""
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0, gates={}),
            _row("/b/proof.json", "2026-01-02T00:00:00Z", 1.0,
                 gates={"mock_integrity": False}),
        ])
        self.assertEqual(
            out["dated"][1]["gate_regressions"], [],
            "a gate's first-ever appearance was reported as a regression")

    def test_a_gate_still_failing_is_not_a_new_regression(self):
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0,
                 gates={"tests": False}),
            _row("/b/proof.json", "2026-01-02T00:00:00Z", 1.0,
                 gates={"tests": False}),
        ])
        self.assertEqual(out["dated"][1]["gate_regressions"], [])

    def test_an_unreadable_gate_result_is_not_a_failure(self):
        """Not observed is neither passed nor failed."""
        self.assertIsNone(_tl._passed({"weird": "shape"}))
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0,
                 gates={"tests": True}),
            _row("/b/proof.json", "2026-01-02T00:00:00Z", 1.0,
                 gates={"tests": {"weird": "shape"}}),
        ])
        self.assertEqual(
            out["dated"][1]["gate_regressions"], [],
            "an unreadable gate result was reported as a fabricated regression")


class FewerThanTwoReceiptsCannotShowAChange(unittest.TestCase):
    """An empty change column reads as "nothing changed". It must say so instead."""

    def test_one_receipt_says_it_cannot_compare(self):
        out = _tl.timeline([_row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0)])
        self.assertFalse(out["comparable"])
        self.assertIn("at least", out["note"].lower())
        self.assertIn("TWO", out["note"])

    def test_the_single_row_still_carries_a_non_empty_change_cell(self):
        out = _tl.timeline([_row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0)])
        self.assertTrue(
            out["dated"][0]["change"].strip(),
            "an empty change column on the only receipt in the archive reads "
            "as a claim that nothing changed")

    def test_one_dated_plus_one_undated_is_still_not_comparable(self):
        """Two receipts, one position. A chain of one cannot show a change."""
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0),
            _row("/b/proof.json", None, 1.0),
        ])
        self.assertFalse(out["comparable"])
        self.assertIn("UNDATED", out["undated"][0]["change"])

    def test_two_dated_receipts_are_comparable(self):
        """The over-strict direction: a real comparison must not be suppressed."""
        out = _tl.timeline([
            _row("/a/proof.json", "2026-01-01T00:00:00Z", 1.0),
            _row("/b/proof.json", "2026-01-02T00:00:00Z", 2.0),
        ])
        self.assertTrue(out["comparable"])
        self.assertIn("ROSE", out["dated"][1]["change"])


class TheExitCodeConvention(unittest.TestCase):
    """0 checked, 3 nothing to check, 64 usage, 66 input missing."""

    def test_empty_workspace_exits_three(self):
        ws = tempfile.mkdtemp(prefix="loki-timeline-")
        r = _run(ws)
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertIn("NO RECEIPTS", r.stdout)

    def test_missing_workspace_exits_sixty_six(self):
        r = _run("/nonexistent/definitely/not/here")
        self.assertEqual(r.returncode, 66, r.stdout + r.stderr)

    def test_an_unknown_flag_exits_sixty_four_not_two(self):
        """2 means "could not check"; a typo must not masquerade as a blind gate."""
        r = _run("--no-such-flag")
        self.assertEqual(r.returncode, 64, r.stdout + r.stderr)

    def test_help_exits_zero_and_emits_no_verdict(self):
        r = _run("--help")
        self.assertEqual(r.returncode, 0)
        self.assertNotIn("NO RECEIPTS", r.stdout)
        self.assertNotIn("UNDATED", r.stdout)

    def test_a_populated_workspace_exits_zero(self):
        ws = _workspace({
            "run-a": _proof("2026-01-01T00:00:00Z", _MEASURED_COST),
            "run-b": _proof("2026-01-02T00:00:00Z", _MEASURED_COST),
        })
        r = _run(ws)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_an_archive_of_only_undated_receipts_still_exits_zero(self):
        """Rule 1's whole point: those receipts exist, so this is not empty."""
        ws = _workspace({"run-a": _proof(None, _MEASURED_COST)})
        r = _run(ws, "--json")
        self.assertEqual(
            r.returncode, 0,
            "an archive of undated receipts was reported as EMPTY, which is "
            "the drop this file exists to prevent, wearing an exit code")
        self.assertEqual(json.loads(r.stdout)["receipt_count"], 1)


class AMalformedReceiptIsCountedNotDropped(unittest.TestCase):
    """Unreadable bytes are a fact about the archive, not an absence."""

    def test_a_malformed_receipt_appears_in_the_report(self):
        ws = tempfile.mkdtemp(prefix="loki-timeline-")
        sub = pathlib.Path(ws) / "broken"
        sub.mkdir(parents=True)
        (sub / "proof.json").write_text("{not json", encoding="utf-8")
        r = _run(ws, "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        report = json.loads(r.stdout)
        self.assertEqual(report["receipt_count"], 1)
        self.assertEqual(report["malformed_count"], 1)
        self.assertEqual(report["undated"][0]["state"], "MALFORMED")


if __name__ == "__main__":
    unittest.main()
