"""Fixtures for cost_claim.py. FABRICATED rows, test only. No network."""

import json
import os
import subprocess
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


# ---- CLI ----

_CLI = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "cost_claim.py")


def _attr_rows(arm, cost, ntask=8, nrep=3, prefix="t"):
    return [{"task": "%s%d" % (prefix, t), "arm": arm, "accepted": True,
             "cost_usd": cost, "status": "completed", "engine": "e1",
             "loki_version": "11.0.0"}
            for t in range(ntask) for _ in range(nrep)]


def _write(path, rows):
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def _run(*args):
    p = subprocess.run([sys.executable, "-I", _CLI, *args],
                       capture_output=True, text=True)
    return p.returncode, p.stdout


def _base_args(f):
    return ["--rows", str(f), "--loki-arm", "loki", "--floor-arm", "raw-lean",
            "--target", "0.5"]


def test_cli_proven_exit_0(tmp_path):
    f = tmp_path / "a.jsonl"
    _write(f, _attr_rows("loki", 0.4) + _attr_rows("raw-lean", 1.0))
    rc, out = _run(*_base_args(f))
    assert rc == 0, out
    assert json.loads(out)["verdict"] == "PROVEN_AT(0.5)"


def test_cli_not_proven_exit_1_and_multiple_files(tmp_path):
    a, b = tmp_path / "a.jsonl", tmp_path / "b.jsonl"
    _write(a, _attr_rows("loki", 0.9))
    _write(b, _attr_rows("raw-lean", 1.0))
    rc, out = _run("--rows", str(a), str(b), "--loki-arm", "loki",
                   "--floor-arm", "raw-lean", "--target", "0.5")
    assert rc == 1, out
    assert json.loads(out)["verdict"] == "NOT PROVEN"


def test_cli_usage_error_exit_2(tmp_path):
    args = _base_args(tmp_path / "missing.jsonl")
    assert _run(*args)[0] == 2
    assert _run("--loki-arm", "loki")[0] == 2


def test_cli_maps_unmeasured_and_partial(tmp_path):
    f = tmp_path / "a.jsonl"
    rows = _attr_rows("loki", 0.4) + _attr_rows("raw-lean", 1.0)
    rows.append({"task": "t0", "arm": "loki", "status": "harness_error"})
    rows.append({"task": "t1", "arm": "loki", "status": "unmeasured"})
    _write(f, rows)
    rc, out = _run(*_base_args(f))
    assert json.loads(out)["unmeasured"] == 2
    rows[0]["cost_partial"] = True
    _write(f, rows)
    rc, out = _run(*_base_args(f))
    assert rc == 1
    assert any(r.startswith("partial") for r in json.loads(out)["reasons"])


def test_cli_exclude_task_printed(tmp_path):
    f = tmp_path / "a.jsonl"
    rows = _attr_rows("loki", 0.4) + _attr_rows("raw-lean", 1.0)
    rows += _attr_rows("loki", 5.0, 1, prefix="bad")
    rows += _attr_rows("raw-lean", 1.0, 1, prefix="bad")
    _write(f, rows)
    assert _run(*_base_args(f))[0] == 1
    rc, out = _run(*_base_args(f), "--exclude-task", "bad0")
    assert rc == 0, out
    assert json.loads(out)["excluded_tasks"] == ["bad0"]
