#!/usr/bin/env python3
"""Hermetic self-check for equivalence_report.py.

Constructs FABRICATED result-row dicts (clearly marked test fixtures -- NOT real
benchmark runs) and asserts the Wilson CI, the bootstrap gap math, the
mismatched-task_hash refusal, and not_run handling. No network, no real builds.

Run: python3 tests/test_equivalence_report.py
No emojis. No em dashes.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import equivalence_report as eq  # noqa: E402


def _fixture_row(cell, task_id, task_hash, outcomes, cost=0.5, dur=100.0,
                 harness_sig=None):
    """FABRICATED result-row (test fixture). outcomes is a list of 0/1 successes."""
    extra = {"harness_sig": harness_sig} if harness_sig else {}
    return {
        **extra,
        "schema_version": "1.0",
        "task_id": task_id,
        "task_hash": task_hash,
        "tool": "loki",
        "model": {"haiku-full": "haiku", "opus-baseline": "opus"}.get(
            cell, cell.split("-")[0]),
        "cell": cell,
        "trials": [
            {"trial": i + 1, "success": bool(o),
             "cost_usd": cost if o else None, "duration_s": dur}
            for i, o in enumerate(outcomes)
        ],
        "summary": {"n_trials": len(outcomes), "n_success": sum(outcomes)},
    }


def test_wilson():
    # Textbook Wilson: 8/10 successes, 95% CI is approx [0.49, 0.94].
    p, lo, hi = eq.wilson_interval(8, 10)
    assert p == 0.8, p
    assert 0.47 < lo < 0.52, lo
    assert 0.92 < hi < 0.96, hi
    # n == 0 must return None (never a fabricated 0.0).
    assert eq.wilson_interval(0, 0) == (None, None, None)
    # All-success cell: point 1.0, upper bound exactly 1.0, lower < 1.0.
    p, lo, hi = eq.wilson_interval(5, 5)
    assert p == 1.0 and hi == 1.0 and lo < 1.0
    print("[PASS] wilson_interval")


def test_bootstrap_gap():
    # haiku-full all pass, opus-baseline all pass -> gap 0, CI tight around 0.
    gap, lo, hi = eq.bootstrap_gap_ci([1] * 10, [1] * 10)
    assert gap == 0.0, gap
    assert lo == 0.0 and hi == 0.0, (lo, hi)
    # haiku 0.5 vs opus 1.0 -> point gap -0.5.
    gap, lo, hi = eq.bootstrap_gap_ci([1, 0, 1, 0, 1, 0], [1] * 6)
    assert abs(gap - (-0.5)) < 1e-9, gap
    assert lo <= gap <= hi, (lo, gap, hi)
    # Fixed seed -> reproducible CI across calls.
    g1 = eq.bootstrap_gap_ci([1, 0, 1, 1], [0, 1, 0, 0])
    g2 = eq.bootstrap_gap_ci([1, 0, 1, 1], [0, 1, 0, 0])
    assert g1 == g2, (g1, g2)
    # Empty cell -> no gap.
    assert eq.bootstrap_gap_ci([], [1, 1]) == (None, None, None)
    print("[PASS] bootstrap_gap_ci (math + reproducibility)")


def test_task_hash_refusal():
    # Same task, DIFFERENT hash between hero cells -> build_report must raise.
    rows = [
        _fixture_row("haiku-full", "hard-1", "HASH_A", [1, 1, 0]),
        _fixture_row("opus-baseline", "hard-1", "HASH_B", [1, 1, 1]),
    ]
    raised = False
    try:
        eq.build_report(rows)
    except ValueError as exc:
        raised = True
        assert "REFUSING" in str(exc) and "hard-1" in str(exc), str(exc)
    assert raised, "expected build_report to REFUSE mismatched task_hash"
    # Matching hash -> no refusal, gap computed.
    rows_ok = [
        _fixture_row("haiku-full", "hard-1", "HASH_A", [1, 1, 0]),
        _fixture_row("opus-baseline", "hard-1", "HASH_A", [1, 1, 1]),
    ]
    rep = eq.build_report(rows_ok)
    assert rep["hero_correctness"]["gap"] is not None
    print("[PASS] task_hash mismatch refusal + matching-hash comparison")


def test_not_run_handling():
    # Only haiku-full present; opus-baseline absent -> hero not_run, no crash.
    rows = [_fixture_row("haiku-full", "hard-1", "HASH_A", [1, 0, 1])]
    rep = eq.build_report(rows)
    hero = rep["hero_correctness"]
    assert hero["haiku_full"] is True and hero["opus_baseline"] is False
    assert "gap" not in hero  # nothing to compare
    md = eq.render_markdown(rep)
    assert "not_run" in md, "grid/decision must show not_run for the missing cell"
    # Honesty + design axes are not_captured (no proof machinery in fixtures).
    cell = rep["cells"]["haiku-full"]
    assert cell["honesty"] == "not_captured"
    assert cell["design"] == "not_captured"
    print("[PASS] not_run handling (missing hero cell, honesty/design not_captured)")


def test_underpowered_decision():
    # Small N (3/task, 1 task) with equal rates -> equivalent-but-UNDERPOWERED.
    rows = [
        _fixture_row("haiku-full", "hard-1", "H", [1, 1, 1]),
        _fixture_row("opus-baseline", "hard-1", "H", [1, 1, 1]),
    ]
    rep = eq.build_report(rows)
    dec = rep["hero_correctness"]["decision"]
    assert "UNDERPOWERED" in dec, dec
    print("[PASS] underpowered decision line at small N")


def test_harness_sig_refusal():
    # THE GATE: same task, same task_hash, but the haiku-full arm was run by two
    # different harness versions. These are two experiments; pooling them would
    # average across engines. build_report must REFUSE rather than blend.
    rows = [
        _fixture_row("haiku-full", "hard-1", "H", [1, 1, 1], harness_sig="SIG_A"),
        _fixture_row("haiku-full", "hard-1", "H", [0, 0, 0], harness_sig="SIG_B"),
        _fixture_row("opus-baseline", "hard-1", "H", [1, 1, 1], harness_sig="SIG_A"),
    ]
    try:
        eq.build_report(rows)
    except ValueError as exc:
        assert "harness" in str(exc).lower(), str(exc)
        assert "SIG_A"[:12] in str(exc) and "SIG_B"[:12] in str(exc), str(exc)
        print("PASS: harness-signature refusal -- %s" % str(exc).splitlines()[0])
    else:
        raise AssertionError("build_report POOLED two harness versions")

    # Control: one signature per arm is fine and still computes a gap.
    ok = [
        _fixture_row("haiku-full", "hard-1", "H", [1, 1, 1], harness_sig="SIG_A"),
        _fixture_row("opus-baseline", "hard-1", "H", [1, 1, 1], harness_sig="SIG_A"),
    ]
    rep = eq.build_report(ok)
    assert rep["hero_correctness"]["gap"] == 0.0, rep["hero_correctness"]
    print("PASS: single-harness arms still pool")


def test_unsigned_rows_are_unknown_stratum():
    # Legacy rows (written before stamping) have no harness_sig. They must be
    # treated as an explicit "unknown" stratum, not crash and not be silently
    # merged into a signed arm.
    assert eq.harness_sig({}) == "unknown"
    assert eq.harness_sig({"harness_sig": "  "}) == "unknown"

    # All-legacy: one stratum ("unknown"), so the report still builds.
    legacy = [
        _fixture_row("haiku-full", "hard-1", "H", [1, 1, 0]),
        _fixture_row("opus-baseline", "hard-1", "H", [1, 1, 0]),
    ]
    rep = eq.build_report(legacy)
    assert rep["hero_correctness"]["harness_strata"]["haiku_full"] == ["unknown"], rep
    print("PASS: unsigned rows form an explicit 'unknown' stratum")

    # Mixing a legacy row into a signed arm is still a refusal -- we cannot show
    # the unsigned trials came from the stamped engine.
    mixed = [
        _fixture_row("haiku-full", "hard-1", "H", [1, 1, 1], harness_sig="SIG_A"),
        _fixture_row("haiku-full", "hard-1", "H", [0, 0, 0]),
        _fixture_row("opus-baseline", "hard-1", "H", [1, 1, 1], harness_sig="SIG_A"),
    ]
    try:
        eq.build_report(mixed)
    except ValueError as exc:
        assert "unknown" in str(exc), str(exc)
        print("PASS: unknown + signed is refused, not merged")
    else:
        raise AssertionError("build_report merged unsigned rows into a signed arm")


def _partial_row(partial):
    row = _fixture_row("haiku-full", "hard-1", "H", [1, 1], cost=0.4)
    for t in row["trials"]:
        t["adapter"] = {"provenance": {"cost_partial": partial}}
    return row


def test_partial_cost_is_not_published_as_complete_per_verified():
    cell = eq.build_report([_partial_row(True)])["cells"]["haiku-full"]
    assert cell["cost_usd_per_verified"] is None, cell["cost_usd_per_verified"]
    assert cell["cost_partial"] is True
    assert cell["cost_usd_per_verified_lower_bound"] == 0.4
    print("PASS: partial cost per verified is a lower bound, not a total")


def test_partial_cost_median_is_flagged_and_rendered_lower_bound():
    rep = eq.build_report([_partial_row(True)])
    assert rep["cells"]["haiku-full"]["cost_partial"] is True
    assert ">= $0.4" in eq.render_markdown(rep)
    done = eq.build_report([_partial_row(False)])["cells"]["haiku-full"]
    assert done["cost_partial"] is False
    assert done["cost_usd_per_verified"] == 0.4
    print("PASS: partial median labelled, complete unchanged")


def test_bench_report_summary_labels_partial_cost():
    import report as rp
    row = {"tool": "loki", "trials": [
        {"success": True, "cost_usd": 0.4, "duration_s": 1.0,
         "adapter": {"provenance": {"cost_partial": True}}}]}
    s = rp.summarize_row(row)
    assert s["cost_partial"] is True
    clean = rp.summarize_row({"tool": "loki", "trials": [
        {"success": True, "cost_usd": 0.4, "duration_s": 1.0}]})
    assert clean["cost_partial"] is False
    print("PASS: bench report flags partial cost")


def _mixed_cost_row():
    row = _fixture_row("haiku-full", "hard-1", "H", [1, 1], cost=1.0)
    row["trials"][1]["cost_usd"] = None
    return row


def test_measured_trial_without_cost_makes_cell_partial():
    cell = eq.cell_axes([_mixed_cost_row()])
    assert cell["cost_partial"] is True
    assert cell["cost_usd_per_verified"] is None
    assert cell["cost_usd_per_verified_lower_bound"] == 0.5


def test_summarize_trials_partial_nulls_per_solved():
    import bench_schema as bs
    trials = _mixed_cost_row()["trials"]
    out = bs.summarize_trials(trials)
    assert out["cost_partial"] is True
    assert out["cost_usd_per_solved"] is None
    assert out["cost_usd_per_solved_lower_bound"] == 0.5
    done = bs.summarize_trials([{"success": True, "cost_usd": 1.0, "duration_s": 1}])
    assert done["cost_partial"] is False and done["cost_usd_per_solved"] == 1.0


def test_bench_report_markdown_prefixes_lower_bound():
    import report as rp
    res = rp.build_report({"rows": [{"tool": "loki", "trials": [
        {"success": True, "cost_usd": 0.4, "duration_s": 1.0,
         "adapter": {"provenance": {"cost_partial": True}}}]}]})
    assert ">= $0.4" in rp.render_markdown(res)


def test_cost_is_partial_hardening():
    import bench_schema as bs
    assert bs.cost_is_partial({"cost_usd": 1.0, "ledger_invalid_lines": "2"})
    assert not bs.cost_is_partial({"cost_usd": 1.0, "ledger_invalid_lines": "x"})
    assert not bs.cost_is_partial({"cost_usd": 1.0, "cost_unpriced_records": None})
    assert bs.cost_is_partial({"cost_usd": 1.0, "cost_partial": "true"})
    assert not bs.cost_is_partial({"cost_usd": 1.0, "cost_partial": "false"})
    assert not bs.cost_is_partial({"cost_usd": 1.0, "cost_partial": "no"})


def _advisor_row(config, task_id, outcomes, cost, task_hash="h1", sig="s1", calls=None):
    """Advisor-arm fixture. The advisor arm records advisor calls per trial; the off arm records 0."""
    row = _fixture_row("sonnet-" + config, task_id, task_hash, outcomes, cost=cost, harness_sig=sig)
    row["model"] = "sonnet"
    if calls is None:
        calls = 2 if config == "advisor" else 0
    for t in row["trials"]:
        t["cost_usd"] = cost  # a failed trial still spent money; None would read as a partial cost
        t["advisor_calls"] = calls
    return row


def _set_trial(row, i, **kw):
    row["trials"][i].update(kw)
    return row


def _unmeasure(row, n):
    """Mark the last n trials of a row as lost to a timeout (not measured)."""
    for t in row["trials"][-n:]:
        t["adapter"] = {"exit_status": "timeout"}
    return row


def test_advisor_verdict_flips_only_when_both_criteria_met():
    off = [_advisor_row("full", "t1", [1, 1, 0, 1], 1.0)]
    # Same VERIFIED rate, cheaper per VERIFIED task: both criteria met.
    v = eq.advisor_verdict(off + [_advisor_row("advisor", "t1", [1, 1, 0, 1], 0.9)], "sonnet")
    assert v["flip_default"] is True and v["verdict"].startswith("FLIP ON"), v
    # Higher rate but dearer per VERIFIED task: criterion 2 fails, stays off.
    v = eq.advisor_verdict(off + [_advisor_row("advisor", "t1", [1, 1, 1, 1], 1.5)], "sonnet")
    assert v["flip_default"] is False and v["verdict"].startswith("KEEP OFF"), v
    assert v["verified_rate"]["met"] is True and v["cost_per_verified"]["met"] is False, v
    # Lower rate but cheaper: criterion 1 fails, stays off.
    v = eq.advisor_verdict(off + [_advisor_row("advisor", "t1", [1, 0, 0, 1], 0.1)], "sonnet")
    assert v["flip_default"] is False and v["verified_rate"]["met"] is False, v
    print("[PASS] advisor_verdict both criteria")


def test_advisor_verdict_not_proven_keeps_default_off():
    off = [_advisor_row("full", "t1", [1, 1], 1.0)]
    assert "missing arm" in eq.advisor_verdict(off, "sonnet")["verdict"]
    assert "same tasks" in eq.advisor_verdict(
        off + [_advisor_row("advisor", "t1", [1, 1], 0.5, task_hash="h2")], "sonnet")["verdict"]
    assert "unequal" in eq.advisor_verdict(
        off + [_advisor_row("advisor", "t1", [1, 1, 1], 0.5)], "sonnet")["verdict"]
    assert "harness" in eq.advisor_verdict(
        [_advisor_row("full", "t1", [1, 1], 1.0, sig="a")] + [_advisor_row("advisor", "t1", [1, 1], 0.5, sig="b")], "sonnet")["verdict"]
    nothing = eq.advisor_verdict(off + [_advisor_row("advisor", "t1", [0, 0], 0.5)], "sonnet")
    assert nothing["flip_default"] is False and nothing["verdict"].startswith("NOT PROVEN"), nothing
    print("[PASS] advisor_verdict not proven")


def test_advisor_verdict_unequal_per_task_measured_counts_not_proven():
    # (a) Totals match (4 vs 4) but the advisor arm has no measured trial on t2.
    off = [_advisor_row("full", "t1", [1, 1], 1.0), _advisor_row("full", "t2", [1, 1], 1.0)]
    on = [_advisor_row("advisor", "t1", [1, 1, 1, 1], 0.5),
          _unmeasure(_advisor_row("advisor", "t2", [1, 1], 0.5), 2)]
    v = eq.advisor_verdict(off + on, "sonnet")
    assert v["flip_default"] is False and v["verdict"].startswith("NOT PROVEN"), v
    assert "per-task" in v["verdict"], v
    print("[PASS] advisor_verdict per-task measured counts")


def test_advisor_verdict_duplicate_task_id_with_different_hash_not_proven():
    # (b) A duplicate task_id carrying an old and a new task_hash must not collapse to the new one.
    off = [_advisor_row("full", "t1", [1, 1], 1.0, task_hash="new")]
    on = [_advisor_row("advisor", "t1", [1, 1], 0.5, task_hash="old"),
          _advisor_row("advisor", "t1", [1, 1], 0.5, task_hash="new")]
    v = eq.advisor_verdict(off + on, "sonnet")
    assert v["flip_default"] is False and "task_hash" in v["verdict"], v
    v = eq.advisor_verdict(on + off, "sonnet")
    assert v["flip_default"] is False and "task_hash" in v["verdict"], v
    print("[PASS] advisor_verdict duplicate task_id")


def test_advisor_verdict_rows_without_identity_or_harness_not_proven():
    # (c) No task_id, no task_hash, no harness_sig on either arm: nothing ties the arms together.
    off = _advisor_row("full", "t1", [1, 1], 1.0)
    on = _advisor_row("advisor", "t1", [1, 1], 0.5)
    for r in (off, on):
        for k in ("task_id", "task_hash", "harness_sig"):
            r.pop(k)
    v = eq.advisor_verdict([off, on], "sonnet")
    assert v["flip_default"] is False and v["verdict"].startswith("NOT PROVEN"), v
    # Each missing field alone is enough.
    for k in ("task_id", "task_hash", "harness_sig"):
        a, b = _advisor_row("full", "t1", [1, 1], 1.0), _advisor_row("advisor", "t1", [1, 1], 0.5)
        b.pop(k)
        v = eq.advisor_verdict([a, b], "sonnet")
        assert v["flip_default"] is False and v["verdict"].startswith("NOT PROVEN"), (k, v)
    # Both arms unstamped: equal to each other, but nothing shows they ran the same harness.
    a, b = _advisor_row("full", "t1", [1, 1], 1.0, sig=None), _advisor_row("advisor", "t1", [1, 1], 0.5, sig=None)
    v = eq.advisor_verdict([a, b], "sonnet")
    assert v["flip_default"] is False and "harness_sig" in v["verdict"], v
    print("[PASS] advisor_verdict unstamped rows")


def test_advisor_verdict_requires_every_on_trial_attached():
    off = [_advisor_row("full", "t1", [1, 1, 1, 1], 1.0)]
    # Per-task sum is 1 but only trial 0 attached: must be NOT PROVEN, not FLIP ON.
    on = _advisor_row("advisor", "t1", [1, 1, 1, 1], 0.5)
    for i, c in enumerate([1, 0, 0, 0]):
        on["trials"][i]["advisor_calls"] = c
    v = eq.advisor_verdict(off + [on], "sonnet")
    assert v["flip_default"] is False and v["verdict"].startswith("NOT PROVEN") and "t1#2" in v["verdict"] and "t1#1" not in v["verdict"], v
    # An off-arm trial with a call is not an off arm, even when the other trials are 0.
    off2 = _set_trial(_advisor_row("full", "t1", [1, 1, 1, 1], 1.0), 2, advisor_calls=1)
    v = eq.advisor_verdict([off2, _advisor_row("advisor", "t1", [1, 1, 1, 1], 0.5)], "sonnet")
    assert v["flip_default"] is False and "off arm" in v["verdict"], v
    # Control: every trial attached still flips.
    v = eq.advisor_verdict(off + [_advisor_row("advisor", "t1", [1, 1, 1, 1], 0.5)], "sonnet")
    assert v["flip_default"] is True, v
    print("[PASS] advisor_verdict every on-arm trial attached")


def test_advisor_verdict_trial_with_advisor_errors_is_not_attached():
    off = [_advisor_row("full", "t1", [1, 1], 1.0)]
    on = _set_trial(_advisor_row("advisor", "t1", [1, 1], 0.5), 1, advisor_errors=2)
    v = eq.advisor_verdict(off + [on], "sonnet")
    assert v["flip_default"] is False and "errors" in v["verdict"] and "t1#2" in v["verdict"], v
    # Zero errors recorded is fine.
    on = _set_trial(_advisor_row("advisor", "t1", [1, 1], 0.5), 1, advisor_errors=0)
    assert eq.advisor_verdict(off + [on], "sonnet")["flip_default"] is True
    print("[PASS] advisor_verdict advisor errors")


def test_advisor_verdict_requires_advisor_attached_in_on_arm():
    off = [_advisor_row("full", "t1", [1, 1], 1.0)]
    assert eq.advisor_verdict(off + [_advisor_row("advisor", "t1", [1, 1], 0.5)], "sonnet")["flip_default"] is True
    # Advisor arm recorded zero advisor calls: it never attached, so the arms are the same config.
    v = eq.advisor_verdict(off + [_advisor_row("advisor", "t1", [1, 1], 0.5, calls=0)], "sonnet")
    assert v["flip_default"] is False and "attach" in v["verdict"], v
    # Advisor calls not recorded at all: unknown is not attached.
    row = _advisor_row("advisor", "t1", [1, 1], 0.5)
    for t in row["trials"]:
        del t["advisor_calls"]
    v = eq.advisor_verdict(off + [row], "sonnet")
    assert v["flip_default"] is False and "attach" in v["verdict"], v
    # Advisor attached on only one of two tasks.
    off2 = off + [_advisor_row("full", "t2", [1, 1], 1.0)]
    v = eq.advisor_verdict(off2 + [_advisor_row("advisor", "t1", [1, 1], 0.5),
                                   _advisor_row("advisor", "t2", [1, 1], 0.5, calls=0)], "sonnet")
    assert v["flip_default"] is False and "attach" in v["verdict"], v
    # The off arm made advisor calls: it was contaminated.
    v = eq.advisor_verdict([_advisor_row("full", "t1", [1, 1], 1.0, calls=1)]
                           + [_advisor_row("advisor", "t1", [1, 1], 0.5)], "sonnet")
    assert v["flip_default"] is False and "attach" in v["verdict"], v
    print("[PASS] advisor_verdict advisor attached")


if __name__ == "__main__":
    test_wilson()
    test_bootstrap_gap()
    test_task_hash_refusal()
    test_harness_sig_refusal()
    test_unsigned_rows_are_unknown_stratum()
    test_not_run_handling()
    test_underpowered_decision()
    test_partial_cost_is_not_published_as_complete_per_verified()
    test_partial_cost_median_is_flagged_and_rendered_lower_bound()
    test_bench_report_summary_labels_partial_cost()
    test_measured_trial_without_cost_makes_cell_partial()
    test_summarize_trials_partial_nulls_per_solved()
    test_bench_report_markdown_prefixes_lower_bound()
    test_cost_is_partial_hardening()
    test_advisor_verdict_flips_only_when_both_criteria_met()
    test_advisor_verdict_not_proven_keeps_default_off()
    test_advisor_verdict_unequal_per_task_measured_counts_not_proven()
    test_advisor_verdict_duplicate_task_id_with_different_hash_not_proven()
    test_advisor_verdict_rows_without_identity_or_harness_not_proven()
    test_advisor_verdict_requires_advisor_attached_in_on_arm()
    test_advisor_verdict_requires_every_on_trial_attached()
    test_advisor_verdict_trial_with_advisor_errors_is_not_attached()
    print("\nALL EQUIVALENCE-REPORT SELF-CHECKS PASSED")
