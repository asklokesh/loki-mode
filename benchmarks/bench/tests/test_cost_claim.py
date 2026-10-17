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
                         "engine": "e1", "loki_version": "11.0.0",
                         "model_used": "m1", "cost_source": "src",
                         **extra})
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
             "loki_version": "11.0.0", "model_used": "m1",
             "cost_source": "claude_json.total_cost_usd"}
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


def test_cli_same_arm_refused_exit_2(tmp_path):
    f = tmp_path / "a.jsonl"
    _write(f, _attr_rows("loki", 0.4) + _attr_rows("raw-lean", 1.0))
    for target in ("0.5", "1.0", "2.0"):
        rc, out = _run("--rows", str(f), "--loki-arm", "loki",
                       "--floor-arm", "loki", "--target", target)
        assert rc == 2, (target, rc, out)
        assert "PROVEN" not in out, (target, out)


def test_cli_target_must_be_finite_and_positive(tmp_path):
    f = tmp_path / "a.jsonl"
    _write(f, _attr_rows("loki", 0.4) + _attr_rows("raw-lean", 1.0))
    for bad in ("nan", "inf", "-inf", "0", "-0.5", "abc"):
        args = _base_args(f)
        args[args.index("--target") + 1] = bad
        rc, out = _run(*args)
        assert rc == 2, (bad, rc, out)
        assert "PROVEN" not in out, (bad, out)
    assert _run(*_base_args(f))[0] == 0


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


def test_non_object_rows_skipped_with_count(tmp_path, capsys):
    loki, floor = _tight(0.4)
    for r in loki:
        r.update(task=r["task_id"], arm="L")
    for r in floor:
        r.update(task=r["task_id"], arm="F")
    f = tmp_path / "rows.jsonl"
    lines = [json.dumps(r) for r in loki + floor]
    lines[1:1] = ["[1, 2]", "7", "\"s\"", "null"]
    f.write_text("\n".join(lines) + "\n")
    rc = cc.main(["--rows", str(f), "--loki-arm", "L", "--floor-arm", "F",
                  "--target", "0.5"])
    cap = capsys.readouterr()
    out = json.loads(cap.out)
    assert rc == 0, cap
    assert out["skipped_non_object_rows"] == 4, out
    assert "skipped 4 non-object" in cap.err
    assert out["verdict"] == "PROVEN_AT(0.5)", out


def _timed(loki_s, floor_s, n_tasks=8):
    loki = _arm([[0.4] * 3] * n_tasks)
    floor = _arm([[1.0] * 3] * n_tasks)
    for r in loki:
        r["elapsed_s"] = loki_s
    for r in floor:
        r["elapsed_s"] = floor_s
    return loki, floor


def test_time_ratio_present_and_directional():
    loki, floor = _timed(100.0, 250.0)
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert abs(v["time_ratio"] - 2.5) < 1e-9, v
    assert v["time_ci"] == [2.5, 2.5], v
    assert v["time_rows_excluded"] == 0
    assert v["verdict"] == "PROVEN_AT(0.5)"


def test_time_ratio_numeric_not_string_compare():
    # 9.0 vs 10.0 differ as strings and numbers: floor 10 / loki 9
    loki, floor = _timed(9.0, 10.0)
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert abs(v["time_ratio"] - 10.0 / 9.0) < 1e-9, v
    lo, hi = v["time_ci"]
    assert lo <= v["time_ratio"] + 1e-9 <= hi + 2e-9


def test_time_ci_spans_when_tasks_vary():
    loki, floor = _timed(100.0, 200.0)
    for r in loki:
        if r["task_id"] in ("t0", "t1"):
            r["elapsed_s"] = 400.0
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    lo, hi = v["time_ci"]
    assert lo < v["time_ratio"] < hi or lo < hi, v
    assert lo < hi


def test_rows_missing_elapsed_excluded_and_counted():
    loki, floor = _timed(100.0, 200.0)
    loki[0].pop("elapsed_s")
    floor[1]["elapsed_s"] = None
    floor[2]["elapsed_s"] = True
    floor[3]["elapsed_s"] = float("nan")
    loki[4]["elapsed_s"] = "12"
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["time_rows_excluded"] == 5, v
    assert abs(v["time_ratio"] - 2.0) < 1e-9, v


def test_no_elapsed_rows_gives_null_time():
    loki, floor = _tight(0.4)
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["time_ratio"] is None and v["time_ci"] is None
    assert v["time_rows_excluded"] == 48
    assert v["verdict"] == "PROVEN_AT(0.5)"


def test_unmeasured_rows_not_counted_in_time_excluded():
    loki, floor = _timed(100.0, 200.0)
    loki[0]["unmeasured"] = True
    loki[0].pop("elapsed_s")
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["time_rows_excluded"] == 0 and v["unmeasured"] == 1


def test_zero_loki_elapsed_not_computable():
    loki, floor = _timed(0.0, 200.0)
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["time_ratio"] is None


def test_time_only_over_tasks_timed_in_both_arms():
    loki, floor = _timed(100.0, 200.0)
    for r in floor:
        if r["task_id"] == "t0":
            r.pop("elapsed_s")
    for r in loki:
        if r["task_id"] == "t1":
            r["elapsed_s"] = 9999.0
            r["task_id"] = "tx"
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert abs(v["time_ratio"] - 2.0) < 1e-9, v


def test_cli_emits_time_ratio(tmp_path):
    f = tmp_path / "a.jsonl"
    rows = _attr_rows("loki", 0.4) + _attr_rows("raw-lean", 1.0)
    for r in rows:
        r["elapsed_s"] = 50.0 if r["arm"] == "loki" else 150.0
    _write(f, rows)
    rc, out = _run(*_base_args(f))
    j = json.loads(out)
    assert rc == 0, out
    assert abs(j["time_ratio"] - 3.0) < 1e-9, j
    assert len(j["time_ci"]) == 2


def test_negative_and_infinite_elapsed_excluded():
    loki, floor = _timed(100.0, 200.0)
    floor[0]["elapsed_s"] = -5.0
    floor[1]["elapsed_s"] = float("inf")
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["time_rows_excluded"] == 2, v
    assert abs(v["time_ratio"] - 2.0) < 1e-9, v


def test_model_mismatch_between_arms_blocks():
    loki, floor = _tight(0.4)
    for r in loki:
        r["model_used"] = "cheap"
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "NOT PROVEN"
    assert any(r.startswith("model") for r in v["reasons"])


def test_model_mixed_within_arm_blocks():
    loki, floor = _tight(0.4)
    floor[0]["model_used"] = "other"
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert any(r.startswith("model") for r in v["reasons"])


def test_model_missing_blocks():
    loki, floor = _tight(0.4)
    del loki[0]["model_used"]
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "NOT PROVEN"
    assert any(r.startswith("model: missing") for r in v["reasons"])


def test_cli_model_mismatch_not_proven(tmp_path):
    rows = _attr_rows("loki", 0.4) + _attr_rows("raw-lean", 1.0)
    for r in rows:
        if r["arm"] == "loki":
            r["model_used"] = "cheap"
    f = tmp_path / "r.jsonl"
    _write(f, rows)
    rc, out = _run(*_base_args(f))
    assert "NOT PROVEN" in out and "model" in out, out


def test_cost_profile_named_in_verdict():
    loki, floor = _tight(0.4)
    for r in loki:
        r["cost_profile"] = "lean"
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["cost_profile"] == "lean"
    assert v["verdict"] == "PROVEN_AT(0.5)", v


def test_cost_profile_absent_is_null_and_does_not_block():
    loki, floor = _tight(0.4)
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["cost_profile"] is None
    assert v["verdict"] == "PROVEN_AT(0.5)", v


def test_cost_profile_mixed_arm_blocks():
    loki, floor = _tight(0.4)
    for r in loki:
        r["cost_profile"] = "lean"
    loki[0]["cost_profile"] = "off"
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "NOT PROVEN"
    assert v["cost_profile"] == "mixed"
    assert any(r.startswith("cost_profile") for r in v["reasons"])


def test_cost_profile_partly_missing_is_mixed():
    loki, floor = _tight(0.4)
    for r in loki[1:]:
        r["cost_profile"] = "lean"
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["cost_profile"] == "mixed"
    assert any(r.startswith("cost_profile") for r in v["reasons"])


def test_cost_profile_ignores_floor_and_unmeasured_rows():
    loki, floor = _tight(0.4)
    for r in loki:
        r["cost_profile"] = "lean"
    loki.append({"task_id": "t0", "unmeasured": True, "cost_profile": "off"})
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["cost_profile"] == "lean"
    assert v["verdict"] == "PROVEN_AT(0.5)", v


def test_cli_cost_profile_lean_and_mixed(tmp_path):
    rows = _attr_rows("loki", 0.4) + _attr_rows("raw-lean", 1.0)
    for r in rows:
        if r["arm"] == "loki":
            r["cost_profile"] = "lean"
    f = tmp_path / "p.jsonl"
    _write(f, rows)
    rc, out = _run(*_base_args(f))
    assert rc == 0 and json.loads(out)["cost_profile"] == "lean", out
    next(r for r in rows if r["arm"] == "loki")["cost_profile"] = "off"
    _write(f, rows)
    rc, out = _run(*_base_args(f))
    assert rc == 1 and json.loads(out)["cost_profile"] == "mixed", out


def test_unmatched_exclusion_warned_and_listed(tmp_path):
    f = tmp_path / "a.jsonl"
    rows = _attr_rows("loki", 0.4) + _attr_rows("raw-lean", 1.0)
    rows += _attr_rows("loki", 5.0, 1, prefix="bad")
    rows += _attr_rows("raw-lean", 1.0, 1, prefix="bad")
    _write(f, rows)
    p = subprocess.run([sys.executable, "-I", _CLI, *_base_args(f),
                        "--exclude-task", "bad0", "--exclude-task", "typo"],
                       capture_output=True, text=True)
    v = json.loads(p.stdout)
    assert v["unmatched_exclusions"] == ["typo"], v
    assert v["excluded_tasks"] == ["bad0", "typo"]
    assert "typo" in p.stderr and "matches no row" in p.stderr
    assert "bad0" not in p.stderr
    rc, out = _run(*_base_args(f), "--exclude-task", "bad0")
    assert json.loads(out)["unmatched_exclusions"] == []


def test_task_set_mismatch_blocks():
    loki, floor = _tight(0.4)
    floor = [r for r in floor if r["task_id"] != "t7"]
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "NOT PROVEN"
    assert any(r.startswith("tasks: arms cover different task sets")
               and "t7" in r for r in v["reasons"]), v["reasons"]


def test_task_set_mismatch_both_directions_and_match_clean():
    loki, floor = _tight(0.4)
    extra = [dict(r, task_id="tx") for r in floor if r["task_id"] == "t0"]
    v = cc.cost_claim_verdict(loki, floor + extra, 0.5)
    assert any(r.startswith("tasks:") and "tx" in r for r in v["reasons"])
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert not any(r.startswith("tasks:") for r in v["reasons"])


def test_cli_task_set_mismatch_not_proven(tmp_path):
    f = tmp_path / "a.jsonl"
    rows = _attr_rows("loki", 0.4) + _attr_rows("raw-lean", 1.0)
    rows += _attr_rows("loki", 0.4, 1, prefix="only")
    _write(f, rows)
    rc, out = _run(*_base_args(f))
    v = json.loads(out)
    assert rc == 1 and any(r.startswith("tasks:") for r in v["reasons"]), out


def test_cost_source_missing_blocks():
    loki, floor = _tight(0.4)
    del loki[0]["cost_source"]
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "NOT PROVEN"
    assert any(r.startswith("cost_source: missing") for r in v["reasons"])


def test_cost_source_mixed_within_arm_blocks_but_arms_may_differ():
    loki, floor = _tight(0.4)
    for r in loki:
        r["cost_source"] = "loki.efficiency_cost"
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "PROVEN_AT(0.5)", v["reasons"]
    floor[0]["cost_source"] = "loki.efficiency_cost"
    v = cc.cost_claim_verdict(loki, floor, 0.5)
    assert v["verdict"] == "NOT PROVEN"
    assert any(r.startswith("cost_source: floor mixes") for r in v["reasons"])


def test_cli_cost_source_missing_not_proven(tmp_path):
    f = tmp_path / "a.jsonl"
    rows = _attr_rows("loki", 0.4) + _attr_rows("raw-lean", 1.0)
    rows[0]["cost_source"] = None
    _write(f, rows)
    rc, out = _run(*_base_args(f))
    v = json.loads(out)
    assert rc == 1 and any(r.startswith("cost_source:") for r in v["reasons"]), out
