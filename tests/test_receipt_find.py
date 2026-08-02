"""A filter is a claim about what it did NOT return.

WHAT THIS LOCKS DOWN. tools/receipt-find.py answers "which runs cost over $40",
"which ones did not verify", "what happened since the 12th". Every way that
answer can be wrong is a way an auditor draws a false conclusion from a short,
confident list:

    unmeasured read as $0.00   a run that never recorded cost answers "yes,
                               under $5" -- and answers "no" to over $5 too,
                               so it is invisible in BOTH directions and the
                               archive looks cheaper than it is
    silent exclusion           unmeasured receipts dropped without a count, so
                               a partial result reads as exhaustive
    zero == empty              "the filter matched nothing" and "there was
                               nothing to search" collapse into one blank
                               list, and the second is a broken invocation
    malformed skipped          the archive reports tidier than it is
    bad --since guessed        an unparseable date matches everything or
                               nothing, and looks like a correct answer

The unmeasured axis is asserted in BOTH directions on purpose. A tool that
substitutes 0.0 for unmeasured passes a --min-usd-only suite (0.0 is below any
positive floor, so it correctly fails to match) and only fails on --max-usd.
One direction alone would let the exact defect this file exists for through.

No git work tree here: receipt-bundle's repo scaffolding exists because
verification re-derives a diff. This tool reads JSON, so fixtures are files.
"""

import importlib.util
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "receipt-find.py"


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_rf = _load("receipt_find", _TOOL)


def _receipt(usd=1.0, measured=True, headline="VERIFIED",
             generated_at="2026-06-27T17:21:37Z"):
    """A receipt shaped like the real one in skills/fixtures/demo-receipt/.

    measured=False is the HONEST unmeasured shape: no usd, no tokens. A run
    that did work necessarily consumed tokens, so all-absent means we FAILED
    TO MEASURE -- which must read as unknown, never as free.
    """
    cost = ({"usd": usd, "input_tokens": 1000, "output_tokens": 50,
             "cache_read_tokens": 0, "cache_creation_tokens": 0}
            if measured else
            {"available": False, "usd": None, "input_tokens": 0,
             "output_tokens": 0, "cache_read_tokens": 0,
             "cache_creation_tokens": 0})
    return {
        "schema_version": "1.1",
        "generated_at": generated_at,
        "cost": cost,
        "honesty": {"headline": headline, "degraded": []},
    }


class FindCase(unittest.TestCase):
    def setUp(self):
        self.ws = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.ws, ignore_errors=True)

    def _write(self, name, proof):
        d = pathlib.Path(self.ws) / ".loki" / "proofs" / name
        d.mkdir(parents=True, exist_ok=True)
        path = d / "proof.json"
        path.write_text(json.dumps(proof, indent=2) if isinstance(proof, dict)
                        else proof, encoding="utf-8")
        return str(path)

    def _paths(self, report):
        return [m["path"] for m in report["matches"]]

    def _empty_dir(self):
        d = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        return d


class CostRange(FindCase):
    def test_range_matches_only_receipts_inside_it(self):
        cheap = self._write("cheap", _receipt(usd=0.50))
        mid = self._write("mid", _receipt(usd=10.0))
        pricey = self._write("pricey", _receipt(usd=99.0))

        r = _rf.search(self.ws, min_usd=1.0, max_usd=50.0)
        self.assertEqual(self._paths(r), [mid])
        self.assertNotIn(cheap, self._paths(r))
        self.assertNotIn(pricey, self._paths(r))
        self.assertEqual(r["scanned"], 3)
        # The matched field is named, so the result is auditable.
        self.assertIn("cost.usd=10.0", r["matches"][0]["matched"])

    def test_zero_floor_is_a_filter_not_an_absent_one(self):
        """--min-usd 0 is real. Truthiness would silently drop it."""
        self._write("m", _receipt(usd=5.0))
        self._write("u", _receipt(measured=False))
        r = _rf.search(self.ws, min_usd=0.0)
        self.assertIn("min-usd=0.0", r["filters"])
        self.assertEqual(r["match_count"], 1)
        # The unmeasured one is still excluded, not swept in by a zero floor.
        self.assertEqual(r["excluded_unmeasured"], 1)


class UnmeasuredCost(FindCase):
    """The central rule: undefined is not zero, and not infinity either."""

    def test_unmeasured_matches_neither_max_nor_min(self):
        unmeasured = self._write("u", _receipt(measured=False))
        measured = self._write("m", _receipt(usd=5.0))

        # Below-threshold direction: treating unmeasured as 0.0 would match.
        below = _rf.search(self.ws, max_usd=100.0)
        self.assertNotIn(unmeasured, self._paths(below))
        self.assertIn(measured, self._paths(below))

        # Above-threshold direction: treating unmeasured as +inf would match.
        above = _rf.search(self.ws, min_usd=1.0)
        self.assertNotIn(unmeasured, self._paths(above))
        self.assertIn(measured, self._paths(above))

    def test_unmeasured_is_counted_as_excluded_not_silently_dropped(self):
        self._write("u1", _receipt(measured=False))
        self._write("u2", _receipt(measured=False))
        self._write("m", _receipt(usd=5.0))

        r = _rf.search(self.ws, max_usd=100.0)
        self.assertEqual(r["excluded_unmeasured"], 2)
        self.assertIn("EXCLUDED", r["summary"])
        self.assertIn("never measured", r["summary"])

    def test_tokens_without_usd_has_no_comparable_cost(self):
        """record_is_measured is true here, yet there is no dollar figure.

        Measured is necessary but not sufficient. Comparing None against a
        float would raise, and substituting 0.0 would be the same lie.
        """
        p = _receipt(usd=5.0)
        p["cost"]["usd"] = None
        path = self._write("tokens-only", p)
        r = _rf.search(self.ws, max_usd=100.0)
        self.assertNotIn(path, self._paths(r))
        self.assertEqual(r["excluded_unmeasured"], 1)

    def test_no_cost_filter_reports_no_exclusions(self):
        """Nothing excluded them, so claiming an exclusion would be false."""
        self._write("u", _receipt(measured=False))
        r = _rf.search(self.ws, failed_only=False)
        self.assertEqual(r["excluded_unmeasured"], 0)
        self.assertEqual(r["match_count"], 1)


class EmptyVersusNoMatch(FindCase):
    def test_zero_matches_differs_from_no_receipts(self):
        self._write("m", _receipt(usd=1.0))
        no_match = _rf.search(self.ws, min_usd=1000.0)
        empty = _rf.search(self._empty_dir())

        self.assertEqual(no_match["match_count"], 0)
        self.assertEqual(empty["match_count"], 0)
        # Same match count, different FACTS. scanned separates them.
        self.assertEqual(no_match["scanned"], 1)
        self.assertEqual(empty["scanned"], 0)
        self.assertIn("NO MATCHES", no_match["summary"])
        self.assertIn("NO RECEIPTS", empty["summary"])
        self.assertNotIn("NO RECEIPTS", no_match["summary"])

    def test_exit_codes_separate_them(self):
        self._write("m", _receipt(usd=1.0))
        self.assertEqual(_rf.main([self.ws, "--min-usd", "1000"]), 1)
        self.assertEqual(_rf.main([self._empty_dir()]), 3)
        self.assertEqual(_rf.main([self.ws]), 0)


class Malformed(FindCase):
    def test_malformed_receipt_is_counted_and_named(self):
        bad = self._write("broken", "{not json at all")
        good = self._write("good", _receipt(usd=1.0))

        r = _rf.search(self.ws)
        self.assertEqual(r["malformed_count"], 1)
        self.assertEqual(r["malformed"][0]["path"], bad)
        self.assertTrue(r["malformed"][0]["reason"])
        self.assertIn("could not be read", r["summary"])
        self.assertEqual(self._paths(r), [good])

    def test_json_array_receipt_is_malformed_not_a_match(self):
        self._write("arr", "[1, 2, 3]")
        r = _rf.search(self.ws)
        self.assertEqual(r["malformed_count"], 1)
        self.assertEqual(r["match_count"], 0)

    def test_only_malformed_is_a_third_state_not_an_empty_workspace(self):
        """Files were FOUND; none could be searched. Neither prior case.

        The counts must not collapse this into "nothing was there" (exit 3),
        and the summary must not claim the unreadable file was searched while
        the next sentence says it was not.
        """
        self._write("broken", "{nope")
        r = _rf.search(self.ws)
        self.assertEqual(r["scanned"], 1)
        self.assertEqual(r["match_count"], 0)
        self.assertEqual(r["malformed_count"], 1)
        self.assertIn("NO MATCHES", r["summary"])
        self.assertNotIn("NO RECEIPTS", r["summary"])
        self.assertIn("could not be read", r["summary"])
        self.assertNotIn("searched, none matched", r["summary"])
        # Receipts were found, so this is "none matched" (1), not "nothing
        # to search" (3).
        self.assertEqual(_rf.main([self.ws]), 1)

    def test_malformed_is_not_also_counted_as_unmeasured(self):
        self._write("broken", "{nope")
        r = _rf.search(self.ws, max_usd=100.0)
        self.assertEqual(r["malformed_count"], 1)
        self.assertEqual(r["excluded_unmeasured"], 0)


class SinceValidation(FindCase):
    def test_bad_since_is_rejected(self):
        for bad in ("yesterday", "2026-13-99", "06/27/2026", ""):
            with self.subTest(bad=bad):
                with self.assertRaises(SystemExit) as cm:
                    _rf.main([self.ws, "--since", bad])
                self.assertNotEqual(cm.exception.code, 0)

    def test_since_filters_by_date(self):
        old = self._write("old", _receipt(generated_at="2026-01-05T00:00:00Z"))
        new = self._write("new", _receipt(generated_at="2026-06-27T17:21:37Z"))
        r = _rf.search(self.ws, since="2026-03-01")
        self.assertEqual(self._paths(r), [new])
        self.assertNotIn(old, self._paths(r))

    def test_since_boundary_is_inclusive(self):
        self._write("edge", _receipt(generated_at="2026-03-01T00:00:00Z"))
        self.assertEqual(_rf.search(self.ws, since="2026-03-01")["match_count"], 1)

    def test_undated_receipt_never_matches_a_since_filter(self):
        p = _receipt(usd=1.0)
        p.pop("generated_at")
        undated = self._write("undated", p)
        r = _rf.search(self.ws, since="2020-01-01")
        self.assertNotIn(undated, self._paths(r))


class FailedOnly(FindCase):
    def test_failed_only_matches_not_verified(self):
        bad = self._write("bad", _receipt(headline="NOT VERIFIED"))
        ok = self._write("ok", _receipt(headline="VERIFIED"))
        gaps = self._write("gaps", _receipt(headline="VERIFIED WITH GAPS"))

        r = _rf.search(self.ws, failed_only=True)
        self.assertEqual(self._paths(r), [bad])
        self.assertNotIn(ok, self._paths(r))
        # "VERIFIED WITH GAPS" verified, with recorded gaps. Not a failure.
        self.assertNotIn(gaps, self._paths(r))

    def test_missing_headline_is_not_silently_a_pass_or_a_fail(self):
        p = _receipt(usd=1.0)
        p.pop("honesty")
        path = self._write("noheadline", p)
        # Never claimed as failed: "we cannot tell" is not "it failed".
        self.assertNotIn(path, self._paths(_rf.search(self.ws,
                                                      failed_only=True)))
        # And never vanishes from an unfiltered search.
        self.assertIn(path, self._paths(_rf.search(self.ws)))


class CombinedFilters(FindCase):
    def test_filters_and_together(self):
        """Only the receipt satisfying ALL THREE survives."""
        want = self._write("want", _receipt(
            usd=50.0, headline="NOT VERIFIED",
            generated_at="2026-06-27T00:00:00Z"))
        # Each of these fails exactly one axis.
        cheap = self._write("cheap", _receipt(
            usd=0.10, headline="NOT VERIFIED",
            generated_at="2026-06-27T00:00:00Z"))
        passed = self._write("passed", _receipt(
            usd=50.0, headline="VERIFIED",
            generated_at="2026-06-27T00:00:00Z"))
        old = self._write("old", _receipt(
            usd=50.0, headline="NOT VERIFIED",
            generated_at="2026-01-01T00:00:00Z"))

        r = _rf.search(self.ws, min_usd=10.0, failed_only=True,
                       since="2026-03-01")
        self.assertEqual(self._paths(r), [want])
        for other in (cheap, passed, old):
            self.assertNotIn(other, self._paths(r))

    def test_output_states_which_filters_were_applied(self):
        """Rule 5: without this line a result reads as 'all receipts'."""
        self._write("m", _receipt(usd=50.0, headline="NOT VERIFIED"))
        r = _rf.search(self.ws, min_usd=10.0, failed_only=True,
                       since="2026-03-01")
        self.assertEqual(r["filters"],
                         ["min-usd=10.0", "failed-only", "since=2026-03-01"])
        for token in ("min-usd=10.0", "failed-only", "since=2026-03-01"):
            self.assertIn(token, r["summary"])

    def test_unfiltered_search_says_so(self):
        self._write("m", _receipt(usd=1.0))
        r = _rf.search(self.ws)
        self.assertEqual(r["filters"], [])
        self.assertIn("no filter applied", r["summary"])


class Cli(FindCase):
    def test_json_output_is_parseable_and_carries_the_counts(self):
        self._write("m", _receipt(usd=5.0))
        self._write("u", _receipt(measured=False))
        out = subprocess.run(
            [sys.executable, str(_TOOL), self.ws, "--max-usd", "100",
             "--json"],
            capture_output=True, text=True, timeout=60)
        report = json.loads(out.stdout)
        self.assertEqual(report["match_count"], 1)
        self.assertEqual(report["excluded_unmeasured"], 1)
        self.assertEqual(report["scanned"], 2)


if __name__ == "__main__":
    unittest.main()
