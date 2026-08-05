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


if __name__ == "__main__":
    test_wilson()
    test_bootstrap_gap()
    test_task_hash_refusal()
    test_harness_sig_refusal()
    test_unsigned_rows_are_unknown_stratum()
    test_not_run_handling()
    test_underpowered_decision()
    print("\nALL EQUIVALENCE-REPORT SELF-CHECKS PASSED")
