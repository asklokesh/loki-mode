"""Trust metrics must count every token a proof records.

Fourth site of the same defect and the most consequential one, because this
number is published: _proof_cost feeds cost-per-verified-task.

When a proof carries its token counts as components rather than a precomputed
total, the fallback summed input + output and ignored the cache tiers -- which
the proof generator does record, and which are ~98% of input volume on real
traffic. A proof whose own record totals 893,701 tokens was reported as 16,436.
A 54x undercount, in a benchmark figure.

The pattern by now is established: bash check_budget_limit, the TypeScript
budget breaker, the dashboard /api/cost, and this. Every one had the data
available and dropped it on the floor.

THE PROPERTIES:
  - an explicit total_tokens still wins (it is the authoritative figure)
  - a proof with no token data reports None, never 0, because zero is a claim
    the data does not support
"""

import os
import sys
import unittest

sys.path.insert(
    0,
    os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "autonomy", "lib"))

import trust_metrics  # noqa: E402

# The measured shape every cost route in this project is tested against.
INP, OUT, CREAD, CWRITE = 10272, 6164, 797496, 79769
REAL_TOTAL = INP + OUT + CREAD + CWRITE  # 893701


class ProofCostTokenTests(unittest.TestCase):
    def test_cache_tiers_are_counted_in_the_fallback(self):
        usd, tokens = trust_metrics._proof_cost({
            "cost": {
                "usd": 0.66,
                "input_tokens": INP,
                "output_tokens": OUT,
                "cache_read_tokens": CREAD,
                "cache_creation_tokens": CWRITE,
            }
        })
        self.assertEqual(usd, 0.66)
        self.assertEqual(
            tokens, REAL_TOTAL,
            "cache tiers dropped: 16436 here means the metric reports 1.8%% of "
            "the tokens the proof itself records")

    def test_explicit_total_still_wins(self):
        """A precomputed total is authoritative; do not re-derive over it."""
        _, tokens = trust_metrics._proof_cost({
            "cost": {"usd": 1.0, "total_tokens": 42,
                     "input_tokens": 9, "cache_read_tokens": 1000},
        })
        self.assertEqual(tokens, 42)

    def test_no_token_data_reports_none_not_zero(self):
        """Absence of data is not a measurement of zero."""
        _, tokens = trust_metrics._proof_cost({"cost": {"usd": 1.0}})
        self.assertIsNone(
            tokens,
            "reporting 0 tokens for a proof with no token data would make a "
            "cost-per-token metric divide by zero or read as free")

    def test_partial_components_still_sum(self):
        """A proof with only some components must not be discarded."""
        _, tokens = trust_metrics._proof_cost({
            "cost": {"usd": 1.0, "input_tokens": 100, "cache_read_tokens": 900},
        })
        self.assertEqual(tokens, 1000)

    def test_cache_only_proof_is_not_treated_as_empty(self):
        """The regression that hid this.

        A proof carrying ONLY cache tokens used to sum to zero from
        input+output, which is indistinguishable from having no data. The
        fallback must recognise cache-only records.
        """
        _, tokens = trust_metrics._proof_cost({
            "cost": {"usd": 1.0, "cache_read_tokens": 500_000},
        })
        self.assertEqual(tokens, 500_000)

    def test_malformed_values_do_not_raise(self):
        _, tokens = trust_metrics._proof_cost({
            "cost": {"usd": "n/a", "input_tokens": "x", "cache_read_tokens": None},
        })
        self.assertIsInstance(tokens, (int, type(None)))


if __name__ == "__main__":
    unittest.main()
