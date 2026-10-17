"""Regression: bench iterations metric reads events.jsonl 'iteration_complete'
as the CANONICAL source (matching speed-benchmark.sh len(completes)), with
session.json only as a fallback. Prevents the two harnesses disagreeing, which
would corrupt every iterations before/after comparison in the loop-efficiency
bench. Run: python3 -m pytest benchmarks/bench/tests/test_iteration_source.py
(or: python3 benchmarks/bench/tests/test_iteration_source.py)."""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from adapters.loki import _read_iteration_count, _count_iteration_completes  # noqa: E402


def _write_events(d, types):
    with open(os.path.join(d, "events.jsonl"), "w") as f:
        for t in types:
            f.write(json.dumps({"type": t, "data": {}}) + "\n")


def test_events_jsonl_is_canonical_and_beats_session_json():
    d = tempfile.mkdtemp()
    try:
        _write_events(d, [
            "iteration_start", "iteration_complete",
            "iteration_start", "iteration_complete",
            "other", "iteration_complete",
        ])
        with open(os.path.join(d, "session.json"), "w") as f:
            json.dump({"iteration": 99}, f)  # must be ignored
        assert _count_iteration_completes(d) == 3
        assert _read_iteration_count(d) == 3
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_falls_back_to_session_json_when_no_events():
    d = tempfile.mkdtemp()
    try:
        with open(os.path.join(d, "session.json"), "w") as f:
            json.dump({"iteration": 7}, f)
        assert _count_iteration_completes(d) is None
        assert _read_iteration_count(d) == 7
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_empty_is_honest_none():
    d = tempfile.mkdtemp()
    try:
        assert _read_iteration_count(d) is None
    finally:
        shutil.rmtree(d, ignore_errors=True)


def _run_with_records(records):
    """Drive adapters.loki.run (the bench entry path) with a mocked CLI that
    leaves efficiency records in the workdir's .loki, as a group run does."""
    from adapters import loki as loki_adapter
    wd = tempfile.mkdtemp()

    def fake_runner(cmd, **kw):
        eff = os.path.join(wd, ".loki", "metrics", "efficiency")
        os.makedirs(eff, exist_ok=True)
        for i, rec in enumerate(records):
            with open(os.path.join(eff, "iteration-%03d.json" % i), "w") as fh:
                json.dump(rec, fh)

        class R:
            returncode = 0
            stdout = "Loki Mode vTEST"
            stderr = ""
        return R()

    try:
        return loki_adapter.run(wd, "spec.md", model="claude", timeout=10, runner=fake_runner)
    finally:
        shutil.rmtree(wd, ignore_errors=True)


GROUP = {"phase": "implement", "kind": "group_cost", "status": "group"}


def test_group_cost_surfaces_in_loki_row_and_splits_phase():
    out = _run_with_records([
        {"phase": "implement", "cost_usd": 0.05, "input_tokens": 10},
        dict(GROUP, cost_usd=0.30, units_measured=3),
        dict(GROUP, cost_usd=0.10, units_measured=1),
    ])
    gc = out["provenance"]["group_cost"]
    assert gc == {"usd": 0.4, "units_measured": 4, "units_unmeasured": 0}, gc
    phases = out["provenance"]["cost_by_phase"]
    assert phases["group"] == 0.4 and phases["main_session"] == 0.05, phases
    assert out["cost_usd"] == 0.45  # the split does not change the total


def test_group_unmeasured_units_stay_unknown_and_partial():
    out = _run_with_records([
        {"phase": "implement", "input_tokens": 10, "cost_usd": 0.05},
        dict(GROUP, cost_unmeasured_reason="unit reported no dollar figure"),
        dict(GROUP, cost_unmeasured_reason="unit reported no dollar figure"),
    ])
    gc = out["provenance"]["group_cost"]
    assert gc == {"usd": None, "units_measured": 0, "units_unmeasured": 2}, gc
    assert out["provenance"]["cost_partial"] is True
    assert "group" not in (out["provenance"]["cost_by_phase"] or {})


def test_no_group_records_means_group_cost_none():
    out = _run_with_records([{"phase": "implement", "cost_usd": 0.05, "input_tokens": 10}])
    assert out["provenance"]["group_cost"] is None
    assert "group" not in out["provenance"]["cost_by_phase"]


def test_group_cost_sums_numerically():
    # 10 and 9 unit records: a string compare or max() would pick the wrong one.
    out = _run_with_records([
        {"phase": "implement", "cost_usd": 0.01, "input_tokens": 1},
        dict(GROUP, cost_usd=0.10, units_measured=10),
        dict(GROUP, cost_usd=0.9, units_measured=9),
    ])
    gc = out["provenance"]["group_cost"]
    assert gc["usd"] == 1.0 and gc["units_measured"] == 19, gc


if __name__ == "__main__":
    test_events_jsonl_is_canonical_and_beats_session_json()
    test_falls_back_to_session_json_when_no_events()
    test_empty_is_honest_none()
    test_group_cost_surfaces_in_loki_row_and_splits_phase()
    test_group_unmeasured_units_stay_unknown_and_partial()
    test_no_group_records_means_group_cost_none()
    test_group_cost_sums_numerically()
    print("ALL GREEN")
