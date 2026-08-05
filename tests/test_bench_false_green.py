"""Discrimination guard for the FALSE-GREEN axis (benchmarks/bench/equivalence_report.py).

False-green is the metric the competitive benchmark exists to publish: of the
trials where a tool CLAIMED completion, how many did the held-out grader say did
not actually pass. If the axis cannot tell a truthful claim from a false one it
measures NOTHING, and every published number built on it is meaningless.

This mirrors the discipline of benchmarks/bench/tests/test_grader_discrimination.py
(the equivalent guard for the grader itself): drive the real functions against
synthesized rows, no billable agent call, and assert the axis SEPARATES the
cases rather than merely returning a number.

Normalization rule under test (founder decision 2026-07-24): declared complete
== terminated without error AND non-empty diff, applied identically to EVERY
tool including Loki. Loki's richer proof.json verdict is reported separately as
false_green_structured so the headline comparison cannot be accused of scoring
Loki's strict self-report against a competitor's loose one.

Run: python3 -m pytest -q tests/test_bench_false_green.py
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "benchmarks", "bench"))

import equivalence_report as er  # noqa: E402


def _trial(success, exit_status=0, files_changed=1, verdict=None):
    adapter = {"exit_status": exit_status, "files_changed": files_changed}
    if verdict is not None:
        adapter["provenance"] = {"verify_verdict": verdict}
    return {"success": success, "adapter": adapter}


def _rows(*trials):
    return [{"trials": list(trials)}]


# ---------------------------------------------------------------------------
# The normalization rule itself.
# ---------------------------------------------------------------------------

def test_clean_exit_with_changes_is_a_claim():
    assert er._declared_complete_normalized(_trial(True)) is True


def test_nonzero_exit_is_not_a_claim():
    assert er._declared_complete_normalized(_trial(False, exit_status=1)) is False


def test_empty_diff_is_not_a_claim():
    # Exiting 0 having changed nothing is not a completion claim in any
    # meaningful sense -- same principle as the engine's empty-diff gate.
    assert er._declared_complete_normalized(_trial(True, files_changed=0)) is False


def test_unmeasurable_trial_returns_none_not_false():
    # None keeps the trial OUT of the denominator. Returning False would
    # silently count an unmeasurable run as "did not claim", quietly shrinking
    # the denominator and flattering the rate.
    assert er._declared_complete_normalized({"success": True}) is None
    assert er._declared_complete_normalized({"adapter": {}}) is None


def test_structured_axis_is_loki_only():
    # A tool with no structured verdict must be None (excluded), NOT False --
    # False would read as "claimed nothing" and pollute the axis.
    assert er._declared_complete_structured(_trial(True)) is None
    assert er._declared_complete_structured(_trial(True, verdict="VERIFIED")) is True
    assert er._declared_complete_structured(_trial(False, verdict="NOT VERIFIED")) is False


# ---------------------------------------------------------------------------
# THE DISCRIMINATION TEST: the axis must separate a false green from a true one.
# ---------------------------------------------------------------------------

def test_false_green_detects_a_claimed_but_failing_trial():
    # Claimed complete (clean exit, real diff) but the held-out grader FAILED it.
    # This is precisely the failure the moat claims to prevent.
    got = er._false_green(_rows(_trial(False)), er._declared_complete_normalized)
    assert got != "not_captured", got
    assert got["n_claimed"] == 1, got
    assert got["n_false_green"] == 1, got
    assert got["rate"] == 1.0, got


def test_false_green_is_zero_when_every_claim_was_honest():
    got = er._false_green(_rows(_trial(True), _trial(True)), er._declared_complete_normalized)
    assert got["n_claimed"] == 2, got
    assert got["n_false_green"] == 0, got
    assert got["rate"] == 0.0, got


def test_false_green_separates_mixed_outcomes():
    # 1 of 4 claims was false -> 0.25. A constant-output implementation cannot
    # satisfy this test together with the two above.
    rows = _rows(_trial(True), _trial(True), _trial(True), _trial(False))
    got = er._false_green(rows, er._declared_complete_normalized)
    assert got["n_claimed"] == 4, got
    assert got["n_false_green"] == 1, got
    assert got["rate"] == 0.25, got


def test_unclaimed_failures_are_excluded_from_the_denominator():
    # A tool that failed AND admitted it (non-zero exit) is honest, not a false
    # green. The denominator is CLAIMED trials only.
    rows = _rows(_trial(False, exit_status=1), _trial(True))
    got = er._false_green(rows, er._declared_complete_normalized)
    assert got["n_claimed"] == 1, got
    assert got["n_false_green"] == 0, got


def test_no_measurable_claims_is_not_captured_never_zero():
    # A silent 0.0 would render as a PERFECT score on a run that measured
    # nothing. It must degrade honestly instead.
    got = er._false_green(_rows({"success": True}), er._declared_complete_normalized)
    assert got == "not_captured", got


# ---------------------------------------------------------------------------
# Wiring: the axis must actually reach the report cell.
# ---------------------------------------------------------------------------

def test_cell_axes_exposes_both_axes():
    rows = _rows(_trial(False, verdict="VERIFIED"), _trial(True, verdict="VERIFIED"))
    cell = er.cell_axes(rows)
    assert "false_green" in cell, cell
    assert "false_green_structured" in cell, cell
    assert cell["false_green"]["n_claimed"] == 2, cell
    assert cell["false_green"]["n_false_green"] == 1, cell
    # Loki's own receipt claimed VERIFIED on both, one of which really failed:
    # the structured axis must see that too.
    assert cell["false_green_structured"]["n_false_green"] == 1, cell


def test_cost_per_verified_divides_by_successes_not_attempts():
    # Cost per ATTEMPT flatters a tool that fails cheaply and often. The buyer's
    # question is what a WORKING result costs, so the denominator is
    # grader-confirmed successes.
    trials = [
        dict(_trial(True), cost_usd=2.0),
        dict(_trial(False), cost_usd=1.0),
        dict(_trial(True), cost_usd=3.0),
    ]
    cell = er.cell_axes([{"trials": trials}])
    assert cell["cost_usd_per_verified"] == 3.0, cell  # 6.0 spent / 2 solved


def test_cost_per_verified_is_none_when_nothing_was_solved():
    # Must never render as 0, which would read as "free".
    trials = [dict(_trial(False), cost_usd=5.0)]
    cell = er.cell_axes([{"trials": trials}])
    assert cell["cost_usd_per_verified"] is None, cell


def test_cell_axes_still_reports_correctness_and_honesty():
    # Guard against the new axes displacing the existing ones.
    cell = er.cell_axes(_rows(_trial(True)))
    assert "correctness" in cell and "honesty" in cell, cell
    assert cell["n_trials"] == 1, cell
