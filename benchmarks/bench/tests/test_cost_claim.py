"""Fixtures for cost_claim.py. FABRICATED rows, test only. No network."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cost_claim as cc  # noqa: E402


def _arm(costs_by_task, accepted=None, **extra):
    rows = []
    for ti, costs in enumerate(costs_by_task):
        for ri, c in enumerate(costs):
            ok = True if accepted is None else accepted(ti, ri)
            rows.append({"task_id": "t%d" % ti, "accepted": ok, "cost_usd": c,
                         "engine": "e1", "loki_version": "11.0.0", **extra})
    return rows


def _tight(ratio):
    return _arm([[ratio] * 3] * 8), _arm([[1.0] * 3] * 8)


def test_proven_tight_ratio():
    loki, floor = _tight(0.4)
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "PROVEN_AT(0.5)", v
    assert v["reasons"] == []


def test_partial_row_blocks():
    loki, floor = _tight(0.45)
    loki[0]["cost_partial"] = True
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "NOT PROVEN"
    assert any(r.startswith("partial") for r in v["reasons"])


def test_acceptance_loss_blocks():
    # 22/24 accepted for loki vs 24/24 for floor
    floor = _arm([[1.0] * 3] * 8)
    loki = _arm([[0.4] * 3] * 8, accepted=lambda t, r: not (t < 2 and r == 0))
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "NOT PROVEN"
    assert any(r.startswith("acceptance") for r in v["reasons"])


def test_mixed_versions_block():
    loki, floor = _tight(0.4)
    loki[0]["loki_version"] = "11.0.1"
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "NOT PROVEN"
    assert any(r.startswith("version") for r in v["reasons"])


def test_n_two_blocks():
    floor = _arm([[1.0, 1.0]] * 8)
    loki = _arm([[0.4, 0.4]] * 8)
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "NOT PROVEN"
    assert any(r.startswith("n:") for r in v["reasons"])


def test_same_seed_same_ci():
    loki = _arm([[0.2, 0.3, 0.9], [0.5, 0.2, 0.4], [0.3, 0.3, 0.3]])
    floor = _arm([[1.0, 1.1, 0.9], [1.0, 1.0, 1.2], [0.8, 1.0, 1.0]])
    a = cc.cost_claim_verdict(loki, floor, 0.5, seed=7)
    b = cc.cost_claim_verdict(loki, floor, 0.5, seed=7)
    assert a["ci_low"] is not None
    assert (a["ci_low"], a["ci_high"]) == (b["ci_low"], b["ci_high"])


def test_wide_spread_not_proven_despite_point_estimate():
    # Point estimate under 0.5 but one task dominates: CI upper bound > 0.5.
    floor = _arm([[1.0] * 3] * 6)
    loki = _arm([[0.05] * 3] * 5 + [[2.4] * 3])
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["ratio"] < 0.5 < v["ci_high"], v
    assert v["verdict"] == "NOT PROVEN"
    assert any(r.startswith("ci") for r in v["reasons"])


def test_unmeasured_excluded_and_counted():
    loki, floor = _tight(0.4)
    loki.append({"task_id": "t0", "unmeasured": True})
    ok = cc.cost_claim_verdict(loki, floor, 0.5)
    assert ok["verdict"] == "PROVEN_AT(0.5)"
    assert ok["unmeasured"] == 1
    loki[0]["cost_partial"] = True
    bad = cc.cost_claim_verdict(loki, floor, 0.5)
    assert any(r.startswith("unmeasured") for r in bad["reasons"])
