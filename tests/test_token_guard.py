"""A token gate that greens an unmeasured run is worse than no gate.

tools/token-guard.py exists to fail a merge when token usage regressed. Its
exit code IS the merge decision, so the dangerous defect is not a wrong number
-- it is a confident 0 emitted when nothing was measured. That maps "no
evidence" onto "evidence of compliance", and makes the gate loudest at exactly
the moment instrumentation broke.

TWO DEFECTS SPECIFIC TO A TOKEN GATE, both pinned below:

1. Measured-ness judged with cost_usd included. record_is_measured() is
   satisfied by cost OR tokens. A record carrying a real cost and zero usage
   (what codex wrote before v8.51.0) then reads as measured, and the gate
   reports "0 output tokens, WITHIN BUDGET" for a run whose tokens were never
   recorded. TokensNotCost pins the four-field rule.

2. A total that does not sum what it says. Cache reads dwarf output tokens
   (10,651,759 to 34,729 in one real call here), so a total's honesty rests
   entirely on its stated definition. TotalDefinitionMatchesTheSum uses four
   distinct non-round values, so dropping or adding ANY single field changes
   the number, and checks the printed definition against the arithmetic.

The whole suite runs the CLI through subprocess and asserts the REAL exit
code, because the exit code is the product. Nothing here imports the tool: it
has a hyphen in its name, and a stale .pyc from spec_from_file_location has
produced false mutation-probe results before.

Both directions are asserted. A guard so strict it also refused a genuinely
measured zero would be the same lie pointed the other way.
"""

import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_GUARD = _ROOT / "tools" / "token-guard.py"

# Records present, every field zero: the shape a real run produced when the
# provider wrote no usage. UNMEASURED.
_UNMEASURED = {
    "iteration": 1, "input_tokens": 0, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_creation_tokens": 0,
    "cost_usd": 0, "model": "high", "status": "completed",
}

# Cost recorded, usage NOT. Measured for a COST gate, unmeasured for this one.
_COST_ONLY = {
    "iteration": 1, "input_tokens": 0, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_creation_tokens": 0,
    "cost_usd": 2.50, "model": "gpt-5.6-sol", "status": "completed",
}

_MEASURED = {
    "iteration": 1, "input_tokens": 9412, "output_tokens": 23,
    "cache_read_tokens": 11008, "cache_creation_tokens": 0,
    "cost_usd": 0.018719, "model": "gpt-5.6-sol", "status": "completed",
}

# A REAL observation whose OUTPUT happens to be zero: input tokens were
# counted, the model generated nothing. Distinct from _UNMEASURED, must PASS.
_MEASURED_ZERO_OUTPUT = {
    "iteration": 1, "input_tokens": 5000, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_creation_tokens": 0,
    "cost_usd": 0.01, "model": "local-free", "status": "completed",
}

# Four DISTINCT non-round values: omitting or adding any single field changes
# the total, so a sum over the wrong field list cannot coincidentally match.
_DISTINCT = {
    "iteration": 1, "input_tokens": 1, "output_tokens": 20,
    "cache_read_tokens": 300, "cache_creation_tokens": 4000,
    "cost_usd": 0.5, "model": "m", "status": "completed",
}
_DISTINCT_TOTAL = 1 + 20 + 300 + 4000

# The real ratio measured in this repo: cache reads ~300x the output tokens.
# A gate that conflates the two calls this run enormous when the WORK was tiny.
_CACHE_HEAVY = {
    "iteration": 1, "input_tokens": 12000, "output_tokens": 34729,
    "cache_read_tokens": 10651759, "cache_creation_tokens": 5000,
    "cost_usd": 12.0, "model": "gpt-5.6-sol", "status": "completed",
}


def _workspace(*records):
    d = pathlib.Path(tempfile.mkdtemp())
    eff = d / ".loki" / "metrics" / "efficiency"
    eff.mkdir(parents=True, exist_ok=True)
    for i, rec in enumerate(records, start=1):
        (eff / ("iteration-%d.json" % i)).write_text(
            json.dumps(rec), encoding="utf-8")
    return d


def _run(*args):
    """The CLI, as CI runs it. sys.executable so a 3.12 run tests 3.12."""
    p = subprocess.run(
        [sys.executable, str(_GUARD)] + [str(a) for a in args],
        capture_output=True, text=True, timeout=60)
    return p.returncode, p.stdout + p.stderr


class UnmeasuredNeverPassesTheGate(unittest.TestCase):
    """The defect this whole feature exists to prevent."""

    def test_output_ceiling_cannot_be_evaluated(self):
        rc, out = _run(_workspace(_UNMEASURED), "--max-output-tokens", "1000")
        self.assertNotEqual(
            rc, 0, "an UNMEASURED run passed a token gate: absence was read "
                   "as compliance, which is the exact failure this gate "
                   "exists to prevent")
        self.assertEqual(rc, 2, "unmeasured must be 'cannot evaluate' (2), "
                                "not a regression verdict")
        self.assertIn("UNMEASURED", out,
                      "the output must SAY it could not measure, or a reader "
                      "cannot tell 2 apart from a broken invocation")

    def test_total_ceiling_fails_closed_the_same_way(self):
        """The second policy path must not have its own idea of measured."""
        rc, out = _run(_workspace(_UNMEASURED), "--max-total-tokens", "1000")
        self.assertNotEqual(rc, 0, "unmeasured passed the total ceiling")
        self.assertEqual(rc, 2)
        self.assertIn("UNMEASURED", out)

    def test_both_ceilings_together_still_refuse(self):
        rc, _ = _run(_workspace(_UNMEASURED), "--max-output-tokens", "1000",
                     "--max-total-tokens", "9999999")
        self.assertEqual(rc, 2)

    def test_json_output_also_refuses(self):
        rc, out = _run(_workspace(_UNMEASURED), "--max-output-tokens", "1000",
                       "--json")
        self.assertEqual(rc, 2)
        d = json.loads(out)
        self.assertEqual(d["status"], "cannot_evaluate")
        self.assertIsNone(d["output_tokens"],
                          "an unmeasured count was rendered as a number")
        self.assertIsNone(d["total_tokens"],
                          "an unmeasured total was rendered as a number")

    def test_missing_workspace_is_not_a_pass(self):
        rc, _ = _run(pathlib.Path(tempfile.mkdtemp()),
                     "--max-output-tokens", "1000")
        self.assertEqual(rc, 2, "a workspace with no records at all passed")

    def test_no_policy_is_not_a_pass(self):
        """A gate given nothing to check must not report a green check."""
        rc, out = _run(_workspace(_MEASURED))
        self.assertEqual(rc, 2, "the gate checked nothing and said PASS")
        self.assertIn("no token policy", out)

    def test_no_policy_on_an_unmeasured_run_is_also_two(self):
        rc, _ = _run(_workspace(_UNMEASURED))
        self.assertEqual(rc, 2)


class TokensNotCost(unittest.TestCase):
    """A cost gate's notion of 'measured' is a hole in a token gate.

    record_is_measured() is satisfied by cost OR tokens. Handing it cost_usd
    makes a cost-only record 'measured', and collect_efficiency then yields
    integer-zero token fields with available=True -- so the gate would report
    '0 output tokens, WITHIN BUDGET' for a run whose tokens were never
    recorded. Verified against the real library, not theoretical.
    """

    def test_cost_recorded_but_no_usage_is_unmeasured(self):
        rc, out = _run(_workspace(_COST_ONLY), "--max-output-tokens", "1000")
        self.assertNotEqual(
            rc, 0, "a record with a real COST and no usage passed a TOKEN "
                   "gate: measured-ness was judged with cost_usd included, so "
                   "the gate reported 0 tokens for a run it never measured")
        self.assertEqual(rc, 2)
        self.assertIn("UNMEASURED", out)

    def test_cost_only_fails_closed_on_the_total_too(self):
        rc, _ = _run(_workspace(_COST_ONLY), "--max-total-tokens", "1000")
        self.assertEqual(rc, 2)

    def test_tokens_without_any_cost_are_still_measured(self):
        """The converse: usage recorded, cost absent. Judged on its number."""
        rec = dict(_MEASURED)
        rec.pop("cost_usd")
        rc, out = _run(_workspace(rec), "--max-output-tokens", "1000")
        self.assertEqual(
            rc, 0, "a run with real token counts and no cost field was "
                   "refused; this gate does not need cost: %s" % out)


class MeasuredTokensAreJudgedOnTheirNumber(unittest.TestCase):

    def test_within_budget_passes(self):
        rc, out = _run(_workspace(_MEASURED), "--max-output-tokens", "1000")
        self.assertEqual(rc, 0, out)
        self.assertIn("WITHIN BUDGET", out)
        self.assertIn("23", out, "the measured number was not reported")

    def test_over_budget_fails_and_names_the_number(self):
        rc, out = _run(_workspace(_MEASURED), "--max-output-tokens", "10")
        self.assertEqual(rc, 1)
        self.assertNotIn("FAILED", out.replace("OVER BUDGET", ""),
                         "a bare FAILED tells the operator nothing")
        self.assertIn("23", out, "the breaching count was not named")
        self.assertIn("10", out, "the ceiling it breached was not named")
        # "by 13", not "13": a bare "13" also matches the 13 inside "130.0%",
        # so a wrongly-computed delta would still satisfy it. Requirement 4 is
        # "by how much", and this is the assertion that guards it.
        self.assertIn("by 13", out, "the size of the breach was not named")

    def test_total_over_budget_names_its_own_number(self):
        rc, out = _run(_workspace(_MEASURED), "--max-total-tokens", "100")
        self.assertEqual(rc, 1)
        self.assertIn("total", out.lower(),
                      "the operator cannot tell WHICH ceiling breached")
        self.assertIn("20443", out, "the breaching total was not named")

    def test_a_measured_zero_output_passes(self):
        """Zero is falsy. A falsy guard would call this unmeasured."""
        rc, out = _run(_workspace(_MEASURED_ZERO_OUTPUT),
                       "--max-output-tokens", "1000")
        self.assertEqual(
            rc, 0, "a genuinely measured 0 output tokens was refused, which "
                   "blanks a real observation: %s" % out)
        self.assertIn("0 output tokens", out)

    def test_a_zero_ceiling_is_a_real_policy(self):
        """`if not max_output` would read --max-output-tokens 0 as no policy.

        Measured 23 output tokens against a ceiling of 0 is a BREACH (1), not
        'cannot evaluate' (2).
        """
        rc, out = _run(_workspace(_MEASURED), "--max-output-tokens", "0")
        self.assertEqual(rc, 1, "a zero ceiling was ignored as 'no policy': "
                                "%s" % out)

    def test_exactly_at_the_ceiling_passes(self):
        rc, out = _run(_workspace(_MEASURED), "--max-output-tokens", "23")
        self.assertEqual(rc, 0, "a run exactly at its ceiling was failed: %s"
                                % out)

    def test_one_token_over_the_ceiling_fails(self):
        """Pins the comparison exact: tokens are integers, no tolerance."""
        rc, out = _run(_workspace(_MEASURED), "--max-output-tokens", "22")
        self.assertEqual(rc, 1, "one token over budget was tolerated: %s"
                                % out)

    def test_summed_across_iterations(self):
        rc, out = _run(_workspace(_MEASURED, _MEASURED),
                       "--max-output-tokens", "1000", "--json")
        self.assertEqual(rc, 0, out)
        self.assertEqual(json.loads(out)["output_tokens"], 46,
                         "per-iteration tokens were not summed")

    def test_both_ceilings_apply_independently(self):
        """Under the output ceiling but over the total still fails."""
        rc, out = _run(_workspace(_MEASURED), "--max-output-tokens", "1000",
                       "--max-total-tokens", "100")
        self.assertEqual(rc, 1)
        self.assertIn("total", out.lower())

    def test_a_bool_in_a_record_is_coerced_upstream_not_here(self):
        """INHERITED LIMIT, asserted rather than silently owned.

        A JSON `true` in output_tokens SHOULD not fabricate a measurement.
        This gate cannot prevent it: collect_efficiency() runs _to_int() over
        every field, so True is a genuine int 1 before token-guard sees it,
        and record_is_measured() rightly calls 1 an observation. Verified
        against the real library.

        So the verdict is 0 (a measured 1 output token, under budget), not 2.
        This test pins the ACTUAL behaviour so the limit is visible instead of
        assumed; the fix belongs in _to_int() in autonomy/lib/efficiency_cost
        .py, not in a bool guard here that the coercion has already bypassed.
        """
        rec = dict(_UNMEASURED, output_tokens=True)
        rc, out = _run(_workspace(rec), "--max-output-tokens", "1000", "--json")
        self.assertEqual(rc, 0, out)
        self.assertEqual(json.loads(out)["output_tokens"], 1,
                         "upstream coercion changed; re-examine the bool path")


class OutputAloneIsTheWorkSignal(unittest.TestCase):
    """Cache reads are not fresh input, and the operator may gate on work.

    Measured here: 10,651,759 cache reads against 34,729 output tokens. Gating
    on output alone must not be moved by the cache-read mountain.
    """

    def test_a_cache_heavy_run_passes_an_output_ceiling(self):
        rc, out = _run(_workspace(_CACHE_HEAVY), "--max-output-tokens",
                       "50000")
        self.assertEqual(
            rc, 0, "an output-token ceiling was breached by CACHE READS: the "
                   "work signal was contaminated with the context signal: %s"
                   % out)

    def test_the_same_run_breaches_the_total(self):
        """And the total does see them, which is what makes it the total."""
        rc, out = _run(_workspace(_CACHE_HEAVY), "--max-total-tokens", "50000")
        self.assertEqual(rc, 1, "the total ignored 10.6M cache-read tokens")
        self.assertIn("10703488", out, "the real total was not named")


class TotalDefinitionMatchesTheSum(unittest.TestCase):
    """A total whose stated definition is not what it sums is not evidence."""

    def test_the_printed_definition_names_every_summed_field(self):
        rc, out = _run(_workspace(_DISTINCT), "--max-total-tokens", "999999",
                       "--json")
        self.assertEqual(rc, 0, out)
        d = json.loads(out)
        definition = d["total_definition"]
        for field in ("input_tokens", "output_tokens", "cache_read_tokens",
                      "cache_creation_tokens"):
            self.assertIn(field, definition,
                          "%s is summed but absent from the stated "
                          "definition" % field)

    def test_the_total_equals_the_sum_of_the_named_fields(self):
        """Arithmetic, not a string match. Four distinct values, so any

        wrong field list yields a different number.
        """
        rc, out = _run(_workspace(_DISTINCT), "--max-total-tokens", "999999",
                       "--json")
        self.assertEqual(rc, 0, out)
        d = json.loads(out)
        named = [f for f in d["tokens"] if f in d["total_definition"]]
        self.assertEqual(
            d["total_tokens"], sum(d["tokens"][f] for f in named),
            "the reported total is not the sum of the fields it names")
        self.assertEqual(d["total_tokens"], _DISTINCT_TOTAL,
                         "the total summed the wrong field list")

    def test_the_definition_is_printed_on_a_pass(self):
        rc, out = _run(_workspace(_DISTINCT), "--max-total-tokens", "999999")
        self.assertEqual(rc, 0, out)
        self.assertIn("cache_read_tokens", out,
                      "a passing total was reported without saying what it "
                      "sums, so the reader cannot judge it")

    def test_the_definition_is_printed_on_a_breach(self):
        rc, out = _run(_workspace(_DISTINCT), "--max-total-tokens", "10")
        self.assertEqual(rc, 1)
        self.assertIn("cache_read_tokens", out,
                      "a breaching total was reported without saying what it "
                      "sums")

    def test_output_alone_is_not_the_total(self):
        """Pins them as different numbers, so one cannot stand in for both."""
        rc, out = _run(_workspace(_DISTINCT), "--max-total-tokens", "999999",
                       "--json")
        d = json.loads(out)
        self.assertEqual(d["output_tokens"], 20)
        self.assertEqual(d["total_tokens"], _DISTINCT_TOTAL)
        self.assertNotEqual(d["output_tokens"], d["total_tokens"])


if __name__ == "__main__":
    unittest.main()
