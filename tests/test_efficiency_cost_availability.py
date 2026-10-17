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


class UnrecordedSessionTests(unittest.TestCase):
    """FC-44: a record flagged tokens_measured:false carries no usage keys; the token totals are NOT RECORDED, not a partial sum."""

    def test_flagged_record_nulls_token_totals_and_flags_partial(self):
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [
                {"iteration": 1, "input_tokens": 100, "output_tokens": 50, "cache_read_tokens": 5,
                 "cache_creation_tokens": 2, "cost_usd": 0.5, "model": "sonnet"},
                {"iteration": 2, "model": "sonnet", "tokens_measured": False},
            ])
            cost, _ = collect_efficiency(loki)
            for key in ("input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens"):
                self.assertIsNone(cost[key], key)
            self.assertTrue(cost["tokens_partial"])
            self.assertEqual(cost["tokens_unmeasured_records"], 1)

    def test_complete_run_dict_has_no_partial_keys(self):
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [{"iteration": 1, "input_tokens": 100, "output_tokens": 50, "cost_usd": 0.5, "model": "sonnet"}])
            cost, _ = collect_efficiency(loki)
            self.assertEqual(cost["input_tokens"], 100)
            self.assertNotIn("tokens_partial", cost)
            self.assertNotIn("tokens_unmeasured_records", cost)


def _ledger(loki_dir, lines):
    m = pathlib.Path(loki_dir) / "metrics"
    m.mkdir(parents=True, exist_ok=True)
    with open(m / "child-sessions.jsonl", "w", encoding="utf-8") as fh:
        for ln in lines:
            fh.write((ln if isinstance(ln, str) else json.dumps(ln)) + "\n")


def _child(phase, usd, inp=10, out=5, cw=100, cr=50, model="sonnet"):
    rec = {"phase": phase, "model": model, "input_tokens": inp,
           "output_tokens": out, "cache_creation_tokens": cw,
           "cache_read_tokens": cr, "source": "claude_json"}
    if usd is not None:
        rec["usd"] = usd
    return rec


MAIN = {"iteration": 1, "input_tokens": 1000, "output_tokens": 200,
        "cache_read_tokens": 300, "cache_creation_tokens": 400,
        "cost_usd": 0.25, "model": "sonnet"}


class ChildLedgerTests(unittest.TestCase):
    """S1: the cost total must include every child session, not only the main one."""

    def test_total_is_main_plus_ledger_with_phase_map(self):
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [MAIN])
            _ledger(loki, [_child("reviewer", 0.1), _child("reviewer", 0.2),
                           _child("grill", 0.05)])
            cost, _ = collect_efficiency(loki)
            self.assertAlmostEqual(cost["usd"], 0.6, places=4)
            self.assertEqual(cost["ledger"], "present")
            self.assertEqual(cost["ledger_records"], 3)
            by = cost["cost_by_phase"]
            self.assertAlmostEqual(by["implement"], 0.25, places=4)
            self.assertAlmostEqual(by["reviewer"], 0.3, places=4)
            self.assertAlmostEqual(by["grill"], 0.05, places=4)
            self.assertAlmostEqual(sum(by.values()), cost["usd"], places=4)
            self.assertEqual(cost["input_tokens"], 1030)
            self.assertEqual(cost["cache_creation_tokens"], 700)

    def test_token_only_main_plus_priced_ledger_is_partial(self):
        # FC-COST-PARTIAL: main records carry tokens but no cost_usd; one priced
        # ledger line must not present a ledger-only total as complete.
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [{"iteration": 1, "input_tokens": 100,
                           "output_tokens": 50, "model": "sonnet"}])
            _ledger(loki, [_child("reviewer", 0.01)])
            cost, _ = collect_efficiency(loki)
            self.assertAlmostEqual(cost["usd"], 0.01, places=4)
            self.assertTrue(cost["cost_partial"])

    def test_v10_ts_child_lines_are_counted_and_unmeasured_is_lower_bound(self):
        # COST-WALL: lines shaped like loki-ts/src/util/child_ledger.ts output.
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [MAIN])
            priced = {"phase": "council", "model": "haiku", "input_tokens": 100,
                      "output_tokens": 50, "usd": 0.065, "source": "ts-spawn"}
            unmeasured = {"phase": "council", "model": "haiku",
                          "cost_status": "unmeasured", "source": "ts-spawn"}
            _ledger(loki, [priced, unmeasured])
            cost, _ = collect_efficiency(loki)
            self.assertAlmostEqual(cost["usd"], 0.315, places=4)
            self.assertEqual(cost["ledger_records"], 2)
            self.assertTrue(cost["cost_partial"])
            self.assertEqual(cost["cost_unpriced_records"], 1)

    def test_missing_ledger_is_main_only_and_flagged_absent(self):
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [MAIN])
            cost, _ = collect_efficiency(loki)
            self.assertAlmostEqual(cost["usd"], 0.25, places=4)
            self.assertEqual(cost["ledger"], "absent")
            self.assertEqual(cost["cost_by_phase"], {"implement": 0.25})

    def test_no_records_and_no_ledger_stays_unavailable(self):
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            pathlib.Path(loki).mkdir()
            cost, _ = collect_efficiency(loki)
            self.assertFalse(cost["available"])
            self.assertIsNone(cost["usd"])
            self.assertEqual(cost["ledger"], "absent")

    def test_ledger_without_main_record_is_lower_bound(self):
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            pathlib.Path(loki).mkdir()
            _ledger(loki, [_child("council", 0.07)])
            cost, _ = collect_efficiency(loki)
            self.assertTrue(cost["available"])
            self.assertAlmostEqual(cost["usd"], 0.07, places=4)
            self.assertTrue(cost["cost_partial"])

    def test_unpriced_ledger_line_is_not_zero_and_marks_partial(self):
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [MAIN])
            _ledger(loki, [_child("reviewer", 0.1), _child("grill", None)])
            cost, _ = collect_efficiency(loki)
            self.assertAlmostEqual(cost["usd"], 0.35, places=4)
            self.assertTrue(cost["cost_partial"])
            self.assertEqual(cost["cost_unpriced_records"], 1)
            self.assertNotIn("grill", cost["cost_by_phase"])

    def test_malformed_ledger_lines_are_skipped_and_counted(self):
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [MAIN])
            _ledger(loki, ["not json", "[1,2]", _child("docs", 0.1), ""])
            cost, _ = collect_efficiency(loki)
            self.assertAlmostEqual(cost["usd"], 0.35, places=4)
            self.assertEqual(cost["ledger_records"], 1)
            self.assertEqual(cost["ledger_invalid_lines"], 2)

    def test_empty_ledger_file_reads_present_with_zero_records(self):
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [MAIN])
            _ledger(loki, [])
            cost, _ = collect_efficiency(loki)
            self.assertEqual(cost["ledger"], "present")
            self.assertEqual(cost["ledger_records"], 0)
            self.assertAlmostEqual(cost["usd"], 0.25, places=4)


def _load(name, fname):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, str(_LIB / fname))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class PartialCostSiblingTests(unittest.TestCase):
    """FC-COST-PARTIAL-b: every cost consumer routes through cost_block_is_partial."""

    def test_shared_helper_decides_partial(self):
        from efficiency_cost import cost_block_is_partial
        self.assertFalse(cost_block_is_partial({"usd": 1.0, "cost_available": True, "cost_partial": False}))
        self.assertTrue(cost_block_is_partial({"usd": 1.0, "cost_partial": True}))
        self.assertTrue(cost_block_is_partial({"usd": None, "cost_available": False}))
        self.assertTrue(cost_block_is_partial({"usd": 1.0, "ledger_invalid_lines": 2}))
        self.assertTrue(cost_block_is_partial({"usd": 1.0, "cost_unpriced_records": 1}))
        self.assertFalse(cost_block_is_partial(None))

    def test_trust_trajectory_cost_per_accepted_refuses_partial_cost(self):
        tt = _load("trust_trajectory_t", "trust_trajectory.py")
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            for i, partial in enumerate((False, True)):
                pd = os.path.join(loki, "proofs", "r%d" % i)
                os.makedirs(pd)
                with open(os.path.join(pd, "proof.json"), "w") as fh:
                    json.dump({"run_id": "r%d" % i, "verdict": "VERIFIED",
                               "cost": {"usd": 0.5, "cost_partial": partial}}, fh)
            runs = tt._load_runs(loki)
            eff = tt.outcome_effort(runs)
            self.assertIsNone(eff["cost_per_accepted_usd"])
            self.assertIn("partial", eff["cost_note"])

    def test_trust_trajectory_complete_cost_still_reported(self):
        tt = _load("trust_trajectory_t2", "trust_trajectory.py")
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            pd = os.path.join(loki, "proofs", "r0")
            os.makedirs(pd)
            with open(os.path.join(pd, "proof.json"), "w") as fh:
                json.dump({"run_id": "r0", "verdict": "VERIFIED",
                           "cost": {"usd": 0.5, "cost_partial": False}}, fh)
            eff = tt.outcome_effort(tt._load_runs(loki))
            self.assertEqual(eff["cost_per_accepted_usd"], 0.5)

    def test_cost_summary_marks_unpriced_iteration_lower_bound(self):
        cs = _load("cost_summary_t", "cost-summary.py")
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [
                {"iteration": 1, "input_tokens": 10, "output_tokens": 5, "cost_usd": 0.1},
                {"iteration": 2, "input_tokens": 10, "output_tokens": 5},
            ])
            s = cs.summarize(d)
            self.assertTrue(s["cost_partial"])
            self.assertIn("LOWER BOUND", cs.render(s))

    def test_cost_summary_complete_is_not_flagged(self):
        cs = _load("cost_summary_t2", "cost-summary.py")
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [{"iteration": 1, "input_tokens": 10, "output_tokens": 5, "cost_usd": 0.1}])
            s = cs.summarize(d)
            self.assertFalse(s["cost_partial"])
            self.assertNotIn("LOWER BOUND", cs.render(s))

    def test_proof_generator_labels_partial_cost_lower_bound(self):
        pg = _load("proof_generator_t", "proof-generator.py")
        hook = pg._build_social_hook({"cost": {"usd": 0.25, "cost_partial": True}})
        self.assertIn("at least $0.25", hook)
        hook = pg._build_social_hook({"cost": {"usd": 0.25, "cost_partial": False}})
        self.assertNotIn("at least", hook)
        self.assertIn("$0.25", hook)

    def test_cost_summary_unmeasured_iteration_alone_marks_lower_bound(self):
        cs = _load("cost_summary_t3", "cost-summary.py")
        with tempfile.TemporaryDirectory() as d:
            loki = os.path.join(d, ".loki")
            _write(loki, [
                {"iteration": 1, "input_tokens": 10, "output_tokens": 5, "cost_usd": 0.1},
                {"iteration": 2, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0},
            ])
            s = cs.summarize(d)
            self.assertEqual(s["iterations_measured"], 1)
            self.assertEqual(s["iterations_found"], 2)
            self.assertEqual(s["cost_iterations_counted"], 1)
            self.assertTrue(s["cost_partial"])

    def test_proof_generator_fallback_html_labels_partial_cost(self):
        pg = _load("proof_generator_t2", "proof-generator.py")
        base = {"run_id": "r", "cost": {"usd": 0.25, "cost_partial": True}}
        self.assertIn("at least $0.25", pg._render_fallback_html(base))
        base["cost"]["cost_partial"] = False
        html = pg._render_fallback_html(base)
        self.assertNotIn("at least $0.25", html)

    def test_proof_template_labels_partial_cost_in_hero_and_cost_card(self):
        html = (_LIB / "proof-template.html").read_text(encoding="utf-8")
        self.assertIn("function costIsPartial(", html)
        for fn in ("renderHero", "renderHeroStats", "renderCost"):
            start = html.index("function " + fn + "(")
            end = html.index("\n  function ", start + 10)
            body = html[start:end]
            if fn != "renderHeroStats":
                self.assertIn("costIsPartial(p)", body, fn)
            self.assertIn('"at least "', body, fn)


if __name__ == "__main__":
    unittest.main()
