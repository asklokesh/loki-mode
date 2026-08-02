"""A cost trend is only worth reading if it cannot flatter itself.

tools/cost-history.py answers "is our agent spend trending up?" over many runs.
Every way that question can be answered dishonestly is cheap and silent:

    an unmeasured run recorded as $0.00   -> drags the median down
    a trend declared from one data point  -> "flat" invented from nothing
    a corrupt line quietly skipped        -> a cleaner series than reality
    an empty history reported as flat     -> stability claimed from zero runs

Each is asserted here as a property, not as a string. The first is the one with
history in this repo: thirteen surfaces once turned "we did not measure" into
"it was free", and a spend trend is the surface where that lie compounds --
every unmeasured run pulls the reported median further below what was actually
paid, and the trend looks BEST exactly when instrumentation is most broken.
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

# Loading tools/cost-history.py by path must not litter the repo with
# __pycache__ for a hyphenated module name.
sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "cost-history.py"

_spec = importlib.util.spec_from_file_location("cost_history", _TOOL)
_ch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ch)

_MEASURED = {
    "iteration": 1, "input_tokens": 9412, "output_tokens": 23,
    "cache_read_tokens": 11008, "cache_creation_tokens": 0,
    "cost_usd": 0.25, "model": "gpt-5.6-sol",
    "duration_ms": 90000, "status": "completed",
}

# The exact shape a real FireLater run produced before v8.51.0: a record is
# present, every field is zero. Present is not measured.
_UNMEASURED = {
    "iteration": 1, "input_tokens": 0, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_creation_tokens": 0,
    "cost_usd": 0, "model": "high",
    "duration_ms": 90000, "status": "completed",
}


def _workspace(record):
    """A workspace whose single efficiency record is `record`."""
    d = tempfile.mkdtemp()
    eff = pathlib.Path(d) / ".loki" / "metrics" / "efficiency"
    eff.mkdir(parents=True, exist_ok=True)
    (eff / "iteration-1.json").write_text(json.dumps(record), encoding="utf-8")
    return d


def _history(lines):
    """A history file containing exactly `lines` (raw strings)."""
    fd, path = tempfile.mkstemp(suffix=".jsonl")
    os.close(fd)
    with open(path, "w", encoding="utf-8") as handle:
        for line in lines:
            handle.write(line + "\n")
    return path


def _row(usd):
    """One history row. usd=None is the unmeasured shape."""
    return json.dumps({"ts": 0, "workspace": "/w", "usd": usd,
                       "measured": usd is not None, "model": "m"})


class TestRecord(unittest.TestCase):

    def test_measured_run_appends_its_cost(self):
        ws = _workspace(_MEASURED)
        path = os.path.join(ws, "history.jsonl")

        d = _ch.record(ws, path)

        self.assertEqual(d["exit_code"], 0)
        self.assertEqual(d["entry"]["usd"], 0.25)
        self.assertTrue(d["entry"]["measured"])

        with open(path, encoding="utf-8") as handle:
            body = handle.read()
        self.assertTrue(body.endswith("\n"),
                        "a row must be newline-terminated, else a truncated "
                        "final write is indistinguishable from a complete one")
        self.assertEqual(len(body.splitlines()), 1)
        self.assertEqual(json.loads(body)["usd"], 0.25)

    def test_appending_twice_keeps_both_rows(self):
        ws = _workspace(_MEASURED)
        path = os.path.join(ws, "history.jsonl")
        _ch.record(ws, path)
        _ch.record(ws, path)

        entries, corrupt = _ch.load(path)
        self.assertEqual(len(entries), 2)
        self.assertEqual(corrupt, 0)

    def test_unmeasured_run_is_never_recorded_as_zero(self):
        """THE CENTRAL PROPERTY. Unmeasured is null and excluded, not 0.

        Asserted on the VALUE, not on a rendered string: a 0.0 here would be
        arithmetically real downstream, silently pulling every median toward
        zero and making a rising spend look flat.
        """
        ws = _workspace(_UNMEASURED)
        path = os.path.join(ws, "history.jsonl")

        d = _ch.record(ws, path)
        entry = d["entry"]

        self.assertIsNone(entry["usd"], "unmeasured must be null, never 0")
        self.assertNotEqual(entry["usd"], 0)
        self.assertFalse(entry["measured"])

        # And it must not reach the trend arithmetic at all.
        rep = _ch.report(path)
        self.assertEqual(rep["runs"], 1)
        self.assertEqual(rep["measured"], 0)
        self.assertEqual(rep["costs"], [])
        self.assertIsNone(rep["median_usd"])
        self.assertNotEqual(rep["exit_code"], 0,
                            "no measured run is nothing to trend")

    def test_unmeasured_row_does_not_drag_the_median(self):
        """A null row among measured rows must be inert, not a zero."""
        path = _history([_row(1.0), _row(None), _row(3.0)])
        d = _ch.report(path)

        self.assertEqual(d["costs"], [1.0, 3.0])
        self.assertEqual(d["median_usd"], 2.0)  # not 1.0, which [0,1,3] gives
        self.assertEqual(d["runs"], 3)
        self.assertEqual(d["measured"], 2)


class TestTrendMath(unittest.TestCase):

    def test_one_data_point_is_insufficient_not_flat(self):
        path = _history([_row(1.0)])
        d = _ch.report(path)

        self.assertEqual(d["direction"], "INSUFFICIENT DATA")
        self.assertNotEqual(d["direction"], "flat")
        self.assertEqual(d["median_usd"], 1.0)

    def test_one_measured_among_unmeasured_is_still_insufficient(self):
        path = _history([_row(None), _row(2.0), _row(None)])
        d = _ch.report(path)
        self.assertEqual(d["direction"], "INSUFFICIENT DATA")

    def test_median_odd_and_even(self):
        self.assertEqual(_ch.median([5.0, 1.0, 3.0]), 3.0)
        self.assertEqual(_ch.median([4.0, 1.0, 3.0, 2.0]), 2.5)

    def test_known_series_reads_rising(self):
        # halves: median([1,1]) = 1.0 vs median([4,4]) = 4.0 -> +300%
        path = _history([_row(1.0), _row(1.0), _row(4.0), _row(4.0)])
        d = _ch.report(path)

        self.assertEqual(d["direction"], "rising")
        self.assertEqual(d["costs"], [1.0, 1.0, 4.0, 4.0])
        self.assertEqual(d["median_usd"], 2.5)
        self.assertIn("median of the oldest 2", d["basis"])
        self.assertEqual(d["exit_code"], 0)

    def test_known_series_reads_falling(self):
        path = _history([_row(4.0), _row(4.0), _row(1.0), _row(1.0)])
        d = _ch.report(path)
        self.assertEqual(d["direction"], "falling")
        self.assertIn("-75.0%", d["basis"])

    def test_identical_series_reads_flat(self):
        path = _history([_row(2.0), _row(2.0), _row(2.0), _row(2.0)])
        d = _ch.report(path)
        self.assertEqual(d["direction"], "flat")
        self.assertEqual(d["median_usd"], 2.0)

    def test_outlier_at_the_end_does_not_name_the_trend(self):
        # first-vs-last would call this rising; halves see it for what it is.
        path = _history([_row(1.0), _row(1.0), _row(1.0), _row(1.0),
                         _row(1.0), _row(1.05)])
        d = _ch.report(path)
        self.assertEqual(d["direction"], "flat")

    def test_direction_is_stated_with_the_comparison_it_used(self):
        path = _history([_row(1.0), _row(4.0)])
        d = _ch.report(path)
        self.assertIsNotNone(d["basis"])
        self.assertIn("$", d["basis"])


class TestCorruptAndEmpty(unittest.TestCase):

    def test_corrupt_line_is_counted_and_reported(self):
        path = _history([_row(1.0), "{not json", _row(3.0)])
        d = _ch.report(path)

        self.assertEqual(d["corrupt_lines"], 1)
        self.assertEqual(d["runs"], 2)
        self.assertIn("CORRUPT", _ch.render(d))

    def test_truncated_final_row_counts_as_corrupt(self):
        """The residual risk of append-mode: a torn last line."""
        path = _history([_row(1.0)])
        with open(path, "a", encoding="utf-8") as handle:
            handle.write('{"ts": 0, "usd": 9.')
        d = _ch.report(path)
        self.assertEqual(d["corrupt_lines"], 1)
        self.assertEqual(d["costs"], [1.0])

    def test_json_that_is_not_a_row_is_corrupt_not_silently_dropped(self):
        path = _history([_row(1.0), "[1,2,3]", '{"no_usd_key": 1}'])
        d = _ch.report(path)
        self.assertEqual(d["corrupt_lines"], 2)

    def test_empty_history_exits_non_zero(self):
        path = _history([])
        d = _ch.report(path)

        self.assertNotEqual(d["exit_code"], 0)
        self.assertEqual(d["direction"], "INSUFFICIENT DATA")
        self.assertNotEqual(d["direction"], "flat")
        self.assertIsNone(d["median_usd"])

    def test_missing_history_exits_non_zero(self):
        d = _ch.report(os.path.join(tempfile.mkdtemp(), "nope.jsonl"))
        self.assertNotEqual(d["exit_code"], 0)
        self.assertEqual(d["runs"], 0)

    def test_all_corrupt_history_is_not_a_flat_trend(self):
        path = _history(["garbage", "also garbage"])
        d = _ch.report(path)
        self.assertNotEqual(d["exit_code"], 0)
        self.assertEqual(d["corrupt_lines"], 2)
        self.assertNotEqual(d["direction"], "flat")


class TestCli(unittest.TestCase):
    """The exit codes are the contract for a CI caller."""

    def _run(self, *args):
        return subprocess.run([sys.executable, str(_TOOL)] + list(args),
                              capture_output=True, text=True, timeout=60)

    def test_record_then_report_end_to_end(self):
        ws = _workspace(_MEASURED)
        path = os.path.join(ws, "h.jsonl")

        self.assertEqual(self._run("record", ws, "--file", path).returncode, 0)
        self.assertEqual(self._run("record", ws, "--file", path).returncode, 0)

        out = self._run("report", "--file", path)
        self.assertEqual(out.returncode, 0)
        self.assertIn("2 run(s), 2 measured", out.stdout)
        self.assertIn("$0.2500", out.stdout)

    def test_cli_empty_history_exits_non_zero(self):
        path = _history([])
        out = self._run("report", "--file", path)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("NO TREND", out.stdout)

    def test_cli_unmeasured_run_prints_unmeasured_not_a_dollar_zero(self):
        ws = _workspace(_UNMEASURED)
        path = os.path.join(ws, "h.jsonl")
        out = self._run("record", ws, "--file", path)
        self.assertIn("UNMEASURED", out.stdout)
        self.assertNotIn("$0.00", out.stdout)

    def test_json_report_is_machine_readable(self):
        path = _history([_row(1.0), _row(4.0)])
        out = self._run("report", "--file", path, "--json")
        d = json.loads(out.stdout)
        self.assertEqual(d["measured"], 2)
        self.assertIn(d["direction"], ("rising", "falling", "flat"))


if __name__ == "__main__":
    unittest.main()
