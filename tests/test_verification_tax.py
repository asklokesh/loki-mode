#!/usr/bin/env python3
"""The property that matters: an absent measurement is never a cheap one.

A tool that exists to justify shrinking verification overhead has one way to
lie, and it is not a crash. If untimed runs are folded into the mean as zeros,
the average slides toward 0.0s and the tool reports that verification is
already nearly free -- which is the conclusion someone wants, arrived at by
arithmetic rather than evidence. Most of these tests exist to make that
specific lie fail loudly.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOOL = os.path.join(ROOT, "tools", "verification-tax.py")

sys.path.insert(0, os.path.join(ROOT, "tools"))
_spec_path = TOOL


def _load():
    import importlib.util
    spec = importlib.util.spec_from_file_location("verification_tax", _spec_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


vt = _load()


def write_log(lines):
    fh = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    for obj in lines:
        fh.write(json.dumps(obj) + "\n" if isinstance(obj, dict) else obj + "\n")
    fh.close()
    return fh.name


class TestDurationHonesty(unittest.TestCase):
    def test_missing_duration_is_none_not_zero(self):
        self.assertIsNone(vt.duration_of({"verdict": "PASS"}))

    def test_untimed_entries_excluded_from_mean_not_zeroed(self):
        """The core anti-lie property.

        One run took 10s; four recorded nothing. The mean must be 10.0 over the
        one timed run, not 2.0 over five. 2.0 would be the tool inventing four
        zero-cost verifications that never reported a cost.
        """
        entries = [{"verdict": {"verdict": "PASS", "duration_s": 10.0}}]
        entries += [{"verdict": "PASS"} for _ in range(4)]
        summary = vt.summarize(entries, 0)
        self.assertEqual(summary["timed"], 1)
        self.assertEqual(summary["untimed"], 4)
        self.assertEqual(summary["mean_s"], 10.0)

    def test_no_timing_anywhere_reports_unknown_not_zero(self):
        summary = vt.summarize([{"verdict": "PASS"}] * 3, 0)
        self.assertIsNone(summary["mean_s"])
        self.assertIsNone(summary["total_s"])
        self.assertIn("UNMEASURED", vt.render(summary))

    def test_start_end_pair_yields_duration(self):
        entry = {"verdict": {"verdict": "BLOCKED", "produced_by": {
            "run_started_at": "2026-08-03T04:56:00Z",
            "run_completed_at": "2026-08-03T04:56:19Z"}}}
        self.assertAlmostEqual(vt.duration_of(entry), 19.0, places=1)

    def test_negative_and_garbage_durations_are_unknown(self):
        self.assertIsNone(vt.duration_of({"verdict": {"duration_s": -5}}))
        self.assertIsNone(vt.duration_of({"verdict": {"duration_s": "fast"}}))
        self.assertIsNone(vt.duration_of({"verdict": {
            "run_started_at": "not-a-date",
            "run_completed_at": "2026-08-03T04:56:19Z"}}))

    def test_end_before_start_is_unknown(self):
        self.assertIsNone(vt.duration_of({"verdict": {
            "run_started_at": "2026-08-03T05:00:00Z",
            "run_completed_at": "2026-08-03T04:00:00Z"}}))


class TestHitRate(unittest.TestCase):
    def test_only_blocking_verdicts_change_outcome(self):
        self.assertTrue(vt.changed_outcome({"verdict": "BLOCKED"}))
        self.assertTrue(vt.changed_outcome({"verdict": {"verdict": "FAIL"}}))
        self.assertFalse(vt.changed_outcome({"verdict": "PASS"}))
        self.assertFalse(vt.changed_outcome({"verdict": {"verdict": "CONCERNS"}}))

    def test_all_pass_reports_zero_hit_rate(self):
        summary = vt.summarize([{"verdict": {"verdict": "PASS",
                                             "duration_s": 1.0}}] * 4, 0)
        self.assertEqual(summary["hit_rate"], 0.0)
        self.assertIn("changed no outcome", vt.render(summary))

    def test_hit_rate_counts_blocks(self):
        entries = [{"verdict": "BLOCKED"}, {"verdict": "PASS"},
                   {"verdict": "PASS"}, {"verdict": "PASS"}]
        self.assertEqual(vt.summarize(entries, 0)["hit_rate"], 0.25)


class TestNeverBlocks(unittest.TestCase):
    """It measures machinery; it must never become machinery."""

    def test_blocking_verdicts_still_exit_zero(self):
        path = write_log([{"verdict": "BLOCKED"}, {"verdict": "BLOCKED"}])
        try:
            proc = subprocess.run([sys.executable, TOOL, path],
                                  capture_output=True, text=True)
            self.assertEqual(proc.returncode, vt.OK)
        finally:
            os.unlink(path)

    def test_empty_log_is_no_data_not_success(self):
        path = write_log([])
        try:
            proc = subprocess.run([sys.executable, TOOL, path],
                                  capture_output=True, text=True)
            self.assertEqual(proc.returncode, vt.NO_DATA)
        finally:
            os.unlink(path)

    def test_missing_log_is_input_missing_not_could_not_check(self):
        """66, not 2, and the distinction is not pedantry.

        "The path you named does not exist" is a fact about the INVOCATION.
        "I could not evaluate" is a fact about the SUBJECT. A caller that
        retries on 2 would retry forever against a typo; 66 says the
        argument is wrong and retrying cannot help.

        This asserted COULD_NOT_CHECK, which the tool then defined as 4 -- a
        code absent from the repo convention entirely, so a CI caller
        branching on 2/3/64/66 would have fallen through to its default arm.
        """
        proc = subprocess.run([sys.executable, TOOL, "/nonexistent/x.jsonl"],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, vt.INPUT_MISSING)

    def test_a_usage_error_is_64_not_argparse_default_2(self):
        """argparse exits 2 for every usage error unless overridden.

        2 means "could not be checked" here, so an unoverridden parser
        reports a mistyped flag as a real verdict about the subject. This
        tool shipped without the override.
        """
        proc = subprocess.run([sys.executable, TOOL, "--bogus"],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, vt.USAGE_ERROR)

    def test_exit_codes_are_the_repo_convention(self):
        """Pins the constants themselves.

        COULD_NOT_CHECK was 4. Asserting the numbers directly catches a
        drift that every behavioural test above would still pass through,
        because they compare against the constant rather than the value.
        """
        self.assertEqual(vt.OK, 0)
        self.assertEqual(vt.COULD_NOT_CHECK, 2)
        self.assertEqual(vt.NO_DATA, 3)
        self.assertEqual(vt.USAGE_ERROR, 64)
        self.assertEqual(vt.INPUT_MISSING, 66)


class TestCorruption(unittest.TestCase):
    def test_corrupt_lines_counted_not_dropped(self):
        path = write_log([{"verdict": "PASS"}, "{not json", {"verdict": "BLOCKED"}])
        try:
            entries, corrupt = vt.read_log(path)
            self.assertEqual(len(entries), 2)
            self.assertEqual(corrupt, 1)
            self.assertIn("CORRUPT", vt.render(vt.summarize(entries, corrupt)))
        finally:
            os.unlink(path)


class TestJsonOutput(unittest.TestCase):
    def test_json_mode_emits_valid_json(self):
        path = write_log([{"verdict": {"verdict": "PASS", "duration_s": 2.5}}])
        try:
            proc = subprocess.run([sys.executable, TOOL, path, "--json"],
                                  capture_output=True, text=True)
            data = json.loads(proc.stdout)
            self.assertEqual(data["mean_s"], 2.5)
            self.assertEqual(data["untimed"], 0)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
