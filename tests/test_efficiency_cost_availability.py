"""An unmeasured cost must read UNKNOWN, never $0.00.

W2 in docs/WANG-PRINCIPLES-PLAN.md, and a receipt-integrity defect in its own
right.

`collect_efficiency` feeds the `cost` block of the Evidence Receipt. Its guard
keyed on whether a record FILE could be parsed, not on whether the record
carried any data -- so a run whose efficiency records were all zeros produced:

    {'usd': 0.0, 'input_tokens': 0, ..., 'available': True}

That is the receipt asserting the run cost NOTHING. The receipt exists to stop
exactly that kind of fabricated fact.

MEASURED, not hypothetical: the real FireLater run wrote four efficiency
records with every token field 0 (codex emitted no usage before v8.51.0), and
this function reported usd=0.0 with available=True.

THE DISTINCTION: a run that did work necessarily consumed tokens. All-zero
therefore means "we failed to measure", not "it was free". Those are different
claims and only one of them is honest -- which is the whole argument the
Evidence Receipt makes to a buyer.

The opposite error matters too: a real cost must still be reported. A guard so
strict it suppressed genuine data would make the cost block permanently blank,
which is its own kind of dishonesty.
"""

import json
import os
import pathlib
import sys
import tempfile
import unittest

_LIB = pathlib.Path(__file__).resolve().parents[1] / "autonomy" / "lib"
sys.path.insert(0, str(_LIB))

from efficiency_cost import collect_efficiency  # noqa: E402


def _write(loki_dir, records):
    eff = pathlib.Path(loki_dir) / "metrics" / "efficiency"
    eff.mkdir(parents=True, exist_ok=True)
    for i, rec in enumerate(records, start=1):
        (eff / f"iteration-{i}.json").write_text(json.dumps(rec), encoding="utf-8")


class CostAvailabilityTests(unittest.TestCase):
    def test_all_zero_records_report_unavailable(self):
        """The regression. Files present, no data in them."""
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [
                {"iteration": 1, "input_tokens": 0, "output_tokens": 0,
                 "cache_read_tokens": 0, "cache_creation_tokens": 0,
                 "cost_usd": 0, "model": "high"},
                {"iteration": 2, "input_tokens": 0, "output_tokens": 0,
                 "cache_read_tokens": 0, "cache_creation_tokens": 0,
                 "cost_usd": 0, "model": "high"},
            ])
            cost, _ = collect_efficiency(loki)
            self.assertFalse(
                cost["available"],
                "all-zero records reported available -- the receipt would claim "
                "the run was free")
            self.assertIsNone(
                cost["usd"],
                "unmeasured cost must be None, not 0.0: 'free' and 'unknown' "
                "are different claims")

    def test_real_tokens_are_still_reported(self):
        """The opposite error: a guard must not suppress genuine data."""
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [{
                "iteration": 1, "input_tokens": 9412, "output_tokens": 23,
                "cache_read_tokens": 11008, "cache_creation_tokens": 0,
                "cost_usd": 0.018719, "model": "gpt-5.6-sol",
            }])
            cost, model = collect_efficiency(loki)
            self.assertTrue(cost["available"], "real usage reported unavailable")
            self.assertAlmostEqual(cost["usd"], 0.0187, places=4)
            self.assertEqual(cost["input_tokens"], 9412)
            self.assertEqual(model, "gpt-5.6-sol")

    def test_tokens_without_cost_still_count_as_measured(self):
        """Tokens observed but the model unpriced.

        This is the v8.51.0 shape: codex reports tokens and never dollars, so a
        model missing from the pricing table yields real tokens with no cost.
        That IS a measurement -- suppressing it would discard the token counts
        we did observe.
        """
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [{
                "iteration": 1, "input_tokens": 500, "output_tokens": 10,
                "cache_read_tokens": 0, "cache_creation_tokens": 0,
                "cost_usd": 0, "model": "some-unpriced-model",
            }])
            cost, _ = collect_efficiency(loki)
            self.assertTrue(
                cost["available"],
                "observed tokens with an unpriced model were discarded")
            self.assertEqual(cost["input_tokens"], 500)

    def test_no_records_at_all_is_unavailable(self):
        """Pre-existing behaviour that must not regress."""
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            pathlib.Path(loki).mkdir(parents=True, exist_ok=True)
            cost, _ = collect_efficiency(loki)
            self.assertFalse(cost["available"])
            self.assertIsNone(cost["usd"])


if __name__ == "__main__":
    unittest.main()
