"""A model recommendation must never outrun its measured basis.

WHAT THIS LOCKS DOWN. tools/model-advisor.py tells an operator to spend money
differently. That makes it the sharpest surface yet for the defect this repo
has paid down thirteen times: a number with nothing measured behind it. The
earlier instances rendered an unmeasured past as "$0.00"; here the same slip
would render an unmeasured FUTURE as a concrete saving, and a saving is an
argument for making a change.

So the properties asserted are:

  1. A measured history yields a ranked recommendation whose ratio math is
     correct against the real pricing table -- verified by recomputing the
     token-weighted ratio independently here, not by trusting the tool.
  2. NO history yields "no basis" and NO NUMBER anywhere. Asserted on the JSON
     and on the RENDERED TEXT, because the render is a separate code path and a
     guard that protects only the dict leaves the human-facing surface exposed.
  3. A model absent from the pricing table reads "unpriced", never $0 and never
     ranked as though it were free.
  4. Every projection is labelled ESTIMATE with the count of records behind it,
     so a basis of one can never pass for a basis of nine.
  5. Rule 3 of the brief -- a cheaper rate is not a cheaper run -- is stated in
     the OUTPUT, and the unverified token-usage assumption is admitted there.

Both interpreter versions run this (python3 and python3.12): the tool loads
sibling modules through spec_from_file_location, which is exactly the kind of
thing that works on one and not the other.
"""

import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

_ROOT = pathlib.Path(__file__).resolve().parents[1]
_TOOL = _ROOT / "tools" / "model-advisor.py"
_PRICING = _ROOT / "loki-ts" / "data" / "model-pricing.json"

_spec = importlib.util.spec_from_file_location("model_advisor", _TOOL)
_ma = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_ma)


def _record(iteration, model, cost_usd, inp=10000, out=2000,
            cache_read=0, cache_creation=0):
    return {
        "iteration": iteration,
        "model": model,
        "phase": "development",
        "provider": "claude",
        "status": "completed",
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_tokens": cache_read,
        "cache_creation_tokens": cache_creation,
        "cost_usd": cost_usd,
        "duration_ms": 90000,
    }


def _workspace(tmp, records):
    """Write efficiency records into a throwaway workspace."""
    eff = pathlib.Path(tmp) / ".loki" / "metrics" / "efficiency"
    eff.mkdir(parents=True, exist_ok=True)
    for rec in records:
        path = eff / ("iteration-%03d.json" % rec["iteration"])
        path.write_text(json.dumps(rec), encoding="utf-8")
    return str(tmp)


def _no_dollar_figures(text):
    """Every dollar amount in the text, so 'no number' can be asserted."""
    import re
    return re.findall(r"\$[0-9]", text)


class NoBasisEmitsNoNumber(unittest.TestCase):
    """The headline rule. No measured history, no saving -- not even zero."""

    def test_empty_workspace_has_no_basis_and_no_projection(self):
        with tempfile.TemporaryDirectory() as tmp:
            adv = _ma.advise(tmp)
        self.assertFalse(adv["has_basis"])
        self.assertEqual(adv["iterations_found"], 0)
        # Every money-shaped field must be None. A 0.0 here is the exact defect.
        self.assertIsNone(adv["incumbent_recorded_cost_usd"])
        self.assertIsNone(adv["best_candidate"])
        self.assertEqual(adv["candidates"], [])
        self.assertIsNone(adv["incumbent_model"])
        joined = " ".join(adv["notes"]).lower()
        self.assertIn("no basis", joined)
        self.assertIn("not $0.00", joined)

    def test_present_but_unmeasured_records_are_not_a_basis(self):
        """Records existing is not the same as records carrying data."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [
                _record(1, "sonnet", 0, inp=0, out=0),
                _record(2, "sonnet", 0, inp=0, out=0),
            ])
            adv = _ma.advise(ws)
        self.assertEqual(adv["iterations_found"], 2)
        self.assertEqual(adv["iterations_measured"], 0)
        self.assertFalse(adv["has_basis"])
        self.assertIsNone(adv["incumbent_recorded_cost_usd"])
        self.assertEqual(adv["candidates"], [])

    def test_measured_on_tokens_but_unpriced_is_not_a_cost_basis(self):
        """Tokens without cost is real accounting and a useless cost basis."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [_record(1, "sonnet", 0, inp=9000, out=500)])
            adv = _ma.advise(ws)
        self.assertEqual(adv["iterations_measured"], 1)
        self.assertEqual(adv["iterations_priced"], 0)
        self.assertFalse(adv["has_basis"])
        self.assertIsNone(adv["incumbent_recorded_cost_usd"])
        joined = " ".join(adv["notes"]).lower()
        self.assertIn("unknown rather than zero", joined)

    def test_rendered_no_basis_text_carries_no_dollar_figure(self):
        """The render is its own code path and needs its own guard.

        A guard that protects only the dict leaves the human-facing surface
        free to print a saving. The only dollar signs allowed in a no-basis
        render are inside the cited external benchmark, which is a fixed
        published fact about someone else's workload -- never a projection
        about this one.
        """
        with tempfile.TemporaryDirectory() as tmp:
            text = _ma.render(_ma.advise(tmp))
        self.assertIn("NO BASIS", text)
        self.assertIn("Projected saving:    UNKNOWN", text)
        self.assertIn("Recommendation:      NONE", text)
        # Split the citation block off: its $36.64/$275.76 are cited external
        # figures, not projections, and must not mask a leaked projection.
        head = text.split("Cited external benchmark")[0]
        self.assertEqual(
            _no_dollar_figures(head), [],
            "no-basis render leaked a dollar figure outside the citation:\n"
            + head)


class MeasuredHistoryYieldsRankedRecommendation(unittest.TestCase):

    def test_ratio_math_matches_an_independent_recomputation(self):
        """Recompute the token-weighted ratio here rather than trust the tool."""
        pricing = json.loads(_PRICING.read_text(encoding="utf-8"))["pricing"]
        self.assertIn("opus", pricing)
        self.assertIn("haiku", pricing)

        inp, out, cread, cwrite = 100000, 20000, 50000, 10000
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [
                _record(1, "opus", 1.5, inp=inp, out=out,
                        cache_read=cread, cache_creation=cwrite),
            ])
            adv = _ma.advise(ws)

        self.assertTrue(adv["has_basis"])
        self.assertEqual(adv["incumbent_model"], "opus")
        self.assertEqual(adv["incumbent_recorded_cost_usd"], 1.5)

        def modelled(alias):
            r = pricing[alias]
            return (inp / 1e6 * r["input"] + out / 1e6 * r["output"]
                    + cread / 1e6 * r["cache_read"]
                    + cwrite / 1e6 * r["cache_write"])

        expected_ratio = modelled("haiku") / modelled("opus")
        haiku = next(c for c in adv["candidates"] if c["model"] == "haiku")
        self.assertAlmostEqual(haiku["rate_ratio"], expected_ratio, places=3)
        # The saving scales the RECORDED cost, not the modelled reconstruction.
        self.assertAlmostEqual(
            haiku["projected_cost_usd"], 1.5 * expected_ratio, places=3)
        self.assertAlmostEqual(
            haiku["projected_saving_usd"], 1.5 - 1.5 * expected_ratio,
            places=3)
        self.assertTrue(haiku["cheaper"])
        # The cheapest priced model in the real table is what must rank first.
        cheapest = min(
            (c for c in adv["candidates"] if c["priced"]),
            key=lambda c: c["rate_ratio"])["model"]
        self.assertEqual(adv["best_candidate"], cheapest)

    def test_output_ratio_uses_full_rate_card_not_input_rate_alone(self):
        """An input-only ratio answers a different question on a real pair.

        opus prices output at 5x input; the gpt family at 8x. So opus ->
        gpt-5.6-luna is genuinely non-proportional and the two formulas
        diverge. Picking a Claude-to-Claude pair here would prove nothing:
        those rate cards ARE proportional, so both formulas agree by accident.
        """
        with tempfile.TemporaryDirectory() as tmp:
            # Output-heavy mix: an input-rate-only ratio ignores the dominant
            # cost component entirely.
            ws = _workspace(tmp, [
                _record(1, "opus", 2.0, inp=1000, out=500000),
            ])
            adv = _ma.advise(ws)
        pricing = json.loads(_PRICING.read_text(encoding="utf-8"))["pricing"]
        cand = next(c for c in adv["candidates"]
                    if c["model"] == "gpt-5.6-luna")
        input_only = pricing["gpt-5.6-luna"]["input"] / pricing["opus"]["input"]
        full = (1000 / 1e6 * pricing["gpt-5.6-luna"]["input"]
                + 500000 / 1e6 * pricing["gpt-5.6-luna"]["output"]) / (
            1000 / 1e6 * pricing["opus"]["input"]
            + 500000 / 1e6 * pricing["opus"]["output"])
        self.assertAlmostEqual(cand["rate_ratio"], full, places=4)
        # Guard the assertion itself: if these coincided the test proves
        # nothing about which formula was used.
        self.assertNotAlmostEqual(full, input_only, places=4)

    def test_cheapest_incumbent_reports_no_cheaper_candidate(self):
        """Already on the cheapest model is a real answer, not an empty list."""
        pricing = json.loads(_PRICING.read_text(encoding="utf-8"))["pricing"]
        # Whichever alias is genuinely cheapest in the shipped table, so this
        # keeps testing the property when the table is repriced.
        cheapest = min(pricing, key=lambda k: pricing[k]["input"])
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [_record(1, cheapest, 0.02)])
            adv = _ma.advise(ws)
        self.assertTrue(adv["has_basis"])
        self.assertEqual(adv["incumbent_model"], cheapest)
        self.assertIsNone(adv["best_candidate"])
        self.assertFalse(any(c["cheaper"] for c in adv["candidates"]))
        self.assertIn("already the cheapest", " ".join(adv["notes"]))
        self.assertIn("none cheaper", _ma.render(adv))

    def test_more_expensive_candidate_reads_as_extra_cost_not_a_saving(self):
        """A negative saving must not render as "$-1.6558" in a SAVING column."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [_record(1, "opus", 1.6558)])
            adv = _ma.advise(ws)
        fable = next(c for c in adv["candidates"] if c["model"] == "fable")
        self.assertFalse(fable["cheaper"])
        self.assertLess(fable["projected_saving_usd"], 0)
        row = [ln for ln in _ma.render(adv).splitlines() if "fable" in ln][0]
        self.assertIn("more", row)
        self.assertNotIn("$-", row)

    def test_incumbent_is_dominant_by_cost_not_last_seen(self):
        """Mixed history must not name whichever model was recorded last."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [
                _record(1, "opus", 5.0),
                _record(2, "haiku", 0.01),   # last seen, tiny share
            ])
            adv = _ma.advise(ws)
        self.assertEqual(adv["incumbent_model"], "opus")
        self.assertTrue(adv["mixed_basis_models"])
        self.assertIn("MIXES models", " ".join(adv["notes"]))


class UnpricedReadsUnpricedNotZero(unittest.TestCase):

    def test_unpriced_incumbent_blocks_every_projection(self):
        """An incumbent with no rates makes every ratio uncomputable."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [
                _record(1, "openrouter/deepseek/deepseek-v3.2", 0.04),
            ])
            adv = _ma.advise(ws)
        self.assertTrue(adv["has_basis"])
        self.assertFalse(adv["incumbent_priced"])
        self.assertEqual(adv["candidates"], [])
        self.assertIsNone(adv["best_candidate"])
        joined = " ".join(adv["notes"])
        self.assertIn("UNPRICED", joined)
        self.assertIn("not $0", joined)
        self.assertIn("(UNPRICED)", _ma.render(adv))

    def test_unpriced_candidate_reads_unpriced_and_is_not_ranked(self):
        """A model in the table with no rates is unknown, never free."""
        pricing = json.loads(_PRICING.read_text(encoding="utf-8"))["pricing"]
        pricing["minimax-m2.5"] = {"note": "open weights, no rate published"}
        with tempfile.TemporaryDirectory() as tmp:
            table = pathlib.Path(tmp) / "pricing.json"
            table.write_text(json.dumps({"pricing": pricing}), encoding="utf-8")
            ws = _workspace(tmp, [_record(1, "opus", 1.0)])
            adv = _ma.advise(ws, pricing_path=str(table))

        cand = next(c for c in adv["candidates"] if c["model"] == "minimax-m2.5")
        self.assertFalse(cand["priced"])
        self.assertIsNone(cand["rate_ratio"])
        # Not 0.0, not omitted -- unknown.
        self.assertIsNone(cand["projected_cost_usd"])
        self.assertIsNone(cand["projected_saving_usd"])
        self.assertIsNone(cand["cheaper"])
        # An unpriced model must never be recommended as the cheapest.
        self.assertNotEqual(adv["best_candidate"], "minimax-m2.5")
        text = _ma.render(adv)
        self.assertIn("minimax-m2.5", text)
        row = [ln for ln in text.splitlines() if "minimax-m2.5" in ln][0]
        self.assertIn("unpriced", row)
        self.assertNotIn("$0.0000", row)

    def test_missing_pricing_table_prices_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [_record(1, "opus", 1.0)])
            adv = _ma.advise(ws, pricing_path=str(
                pathlib.Path(tmp) / "does-not-exist.json"))
        self.assertFalse(adv["incumbent_priced"])
        self.assertEqual(adv["candidates"], [])
        self.assertIsNone(adv["best_candidate"])


class EstimateIsLabelledWithItsBasis(unittest.TestCase):

    def test_single_point_basis_is_labelled_as_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [_record(1, "opus", 1.0)])
            adv = _ma.advise(ws)
        self.assertEqual(adv["label"], "ESTIMATE")
        self.assertEqual(adv["basis_count"], 1)
        self.assertTrue(adv["single_point_basis"])
        joined = " ".join(adv["notes"])
        self.assertIn("ESTIMATE based on 1 measured, priced iteration(s)",
                      joined)
        self.assertIn("SINGLE data point", joined)
        self.assertIn("ESTIMATE basis: 1 priced iteration(s)", _ma.render(adv))

    def test_partial_basis_states_how_many_were_excluded(self):
        """A 2-of-5 basis must never be mistaken for a 5-of-5 one."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [
                _record(1, "opus", 1.0),
                _record(2, "opus", 1.2),
                _record(3, "opus", 0, inp=0, out=0),
                _record(4, "opus", 0, inp=0, out=0),
                _record(5, "opus", 0, inp=0, out=0),
            ])
            adv = _ma.advise(ws)
        self.assertEqual(adv["iterations_found"], 5)
        self.assertEqual(adv["basis_count"], 2)
        joined = " ".join(adv["notes"])
        self.assertIn("ESTIMATE based on 2 measured, priced iteration(s) of 5",
                      joined)
        self.assertIn("3 of 5 record(s) did not inform", joined)
        self.assertIn("ESTIMATE basis: 2 priced iteration(s) of 5",
                      _ma.render(adv))

    def test_candidate_table_is_labelled_estimate_with_basis(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [
                _record(1, "opus", 1.0), _record(2, "opus", 1.1)])
            text = _ma.render(_ma.advise(ws))
        self.assertIn("Candidates (ESTIMATE, basis 2 iteration(s)):", text)


class RateIsNotARunAndQualityIsNotClaimed(unittest.TestCase):

    def test_output_states_the_token_assumption_and_that_it_is_unverified(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [_record(1, "opus", 1.0)])
            adv = _ma.advise(ws)
        joined = " ".join(adv["notes"])
        self.assertIn("A CHEAPER RATE IS NOT A CHEAPER RUN", joined)
        self.assertIn("COMPARABLE TOKEN USAGE", joined)
        self.assertIn("NOT VERIFIED", joined)
        self.assertFalse(adv["assumption_verified"])
        # And it must reach the human-facing render, not only the dict.
        self.assertIn("A CHEAPER RATE IS NOT A CHEAPER RUN", _ma.render(adv))

    def test_swebench_figures_are_cited_with_numbers_and_never_a_promise(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [_record(1, "opus", 1.0)])
            adv = _ma.advise(ws)
        cite = adv["swebench_citation"]
        self.assertEqual(cite["benchmark"], "SWE-bench verified")
        scores = {r["model"]: (r["score"], r["cost_usd"])
                  for r in cite["results"]}
        self.assertEqual(scores["MiniMax M2.5 (open weights)"], (75.8, 36.64))
        self.assertEqual(scores["Claude Opus 4.6"], (75.6, 275.76))
        self.assertIn("3.4 points", cite["harness_effect"])
        self.assertIn("NOT a measurement", _ma.render(adv))
        self.assertIn("does not predict", cite["caveat"])
        self.assertIn("quality is not projected",
                      " ".join(adv["notes"]).lower())

    def test_citation_never_ranks_a_candidate(self):
        """Ranking is by computed rate only; the benchmark must not leak in."""
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [_record(1, "opus", 1.0)])
            adv = _ma.advise(ws)
        ratios = [c["rate_ratio"] for c in adv["candidates"] if c["priced"]]
        self.assertEqual(ratios, sorted(ratios))
        # No model named only in the citation may appear as a candidate.
        names = {c["model"] for c in adv["candidates"]}
        self.assertNotIn("MiniMax M2.5 (open weights)", names)


class CliContract(unittest.TestCase):
    """The tool must actually run as a script on this interpreter."""

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(_TOOL), *args],
            capture_output=True, text=True, cwd=str(_ROOT))

    def test_json_mode_on_a_measured_workspace(self):
        with tempfile.TemporaryDirectory() as tmp:
            ws = _workspace(tmp, [_record(1, "opus", 1.0)])
            proc = self._run(ws, "--json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        adv = json.loads(proc.stdout)
        self.assertTrue(adv["has_basis"])
        self.assertEqual(adv["incumbent_model"], "opus")
        cheapest = min(
            (c for c in adv["candidates"] if c["priced"]),
            key=lambda c: c["rate_ratio"])["model"]
        self.assertEqual(adv["best_candidate"], cheapest)

    def test_no_basis_exits_zero_because_it_is_an_honest_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            proc = self._run(tmp)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("NO BASIS", proc.stdout)



class AMissingWorkspaceIsNotNoHistory(unittest.TestCase):
    """Exit 0 collapsed two different facts.

    "this workspace has no cost history" and "this workspace does not exist"
    are opposite diagnoses, and a CI job doing `model-advisor.py "$WS" && ...`
    on a mistyped or unmounted path saw green and carried on. Every sibling
    tool distinguishes them (run-replay 66, cost-guard 2, receipt-bundle 3).

    Both directions are asserted: the missing path must fail, and a REAL
    workspace with genuinely no history must still succeed, because "no basis"
    is an honest answer rather than a tool failure.
    """

    def _run(self, ws):
        return subprocess.run(
            [sys.executable, str(_ROOT / "tools" / "model-advisor.py"), ws],
            capture_output=True, text=True, timeout=60)

    def test_a_nonexistent_workspace_fails(self):
        r = self._run("/nonexistent/definitely/not/here")
        self.assertNotEqual(r.returncode, 0,
                            "a missing workspace reported success")
        self.assertIn("does not exist", r.stderr)

    def test_a_real_workspace_with_no_history_still_succeeds(self):
        with tempfile.TemporaryDirectory() as d:
            r = self._run(d)
            self.assertEqual(r.returncode, 0, r.stderr[:200])
            self.assertIn("NO BASIS", r.stdout)


class CalibrationIsACaveatAndNeverARankingInput(unittest.TestCase):
    """The advisor may POINT AT the calibration signal, never consume it.

    WHY THE LINE IS HERE. This module's own docstring refuses to rank on
    quality: "whether the cheaper model would have produced the same result
    on YOUR workload is not something any cost record can answer." The
    calibration audit produces a LOCAL measurement, which makes it tempting
    to treat as the missing quality term.

    It is not one. The audit scores agreement with the council MAJORITY, and
    the council outcome is derived from the votes, so a voter partly causes
    its own label. Feeding that into a recommendation would dress up
    "voted with the pack" as "was correct" -- the fabricated authority this
    tool exists to refuse.

    So the caveat is render-only, and this pins both halves: the text must
    be present for a human, and the machine-readable contract must be
    untouched so no downstream consumer can silently start ranking on it.
    """

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, str(_TOOL), *args],
            capture_output=True, text=True, timeout=120)

    def test_the_caveat_names_the_limit_not_just_the_tool(self):
        with tempfile.TemporaryDirectory() as d:
            out = self._run(d).stdout
            self.assertIn("calibration-audit.py", out,
                          "the advisor does not point at the local signal")
            # Naming the tool without its limit would invite exactly the
            # misreading the audit's own header exists to prevent.
            self.assertIn("NOT accuracy", out,
                          "the caveat cites the audit without stating that it "
                          "measures agreement, not correctness")

    def test_calibration_never_enters_the_machine_readable_contract(self):
        """The load-bearing half.

        A human reading a caveat cannot accidentally rank on it. A script
        reading --json can. If a calibration key ever appears here, someone
        has wired the signal into the recommendation.
        """
        with tempfile.TemporaryDirectory() as d:
            r = self._run(d, "--json")
            self.assertEqual(r.returncode, 0, r.stderr[:200])
            payload = json.loads(r.stdout)
            leaked = [k for k in payload if "calib" in k.lower()
                      or "brier" in k.lower() or "ece" in k.lower()]
            self.assertEqual(
                leaked, [],
                "calibration leaked into the advisor's JSON contract (%s). "
                "It is a caveat for a human, not a term in the ranking."
                % leaked)


if __name__ == "__main__":
    unittest.main()
