"""Measurement fixes for the loki bench adapter and the shared CLI runner.

Each test drives the code the way a paid run does, with the CLI mocked or a
real stub script, and has a positive control that can make it fail.
Run: python3 -m pytest benchmarks/bench/tests/test_loki_adapter_measurement.py -q
"""
import json
import os
import shutil
import stat
import sys
import tempfile
import textwrap

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import runner  # noqa: E402
from adapters import _base, loki  # noqa: E402

STAGE_OUT = ("[00:11] intake      done   11s   repo map cached\n"
             "[00:17] plan        done   6s   3 files\n"
             "[01:02] implement   done   45s   ok\n")


class _R:
    def __init__(self, stdout="", rc=0):
        self.returncode, self.stdout, self.stderr = rc, stdout, ""


def _wd():
    return tempfile.mkdtemp(prefix="loki-run.bench-test.")


def test_stop_marker_matches_stage_line_and_start_gets_verbose():
    calls = []

    def fake(cmd, **kw):
        calls.append(list(cmd))
        return _R(STAGE_OUT)

    wd = _wd()
    try:
        out = loki.run(wd, "spec.md", timeout=10, runner=fake,
                       interrupt_after_stage="plan")
    finally:
        shutil.rmtree(wd, ignore_errors=True)
    resume = out["provenance"]["resume"]
    assert resume["killed"] is True, resume
    start = [c for c in calls if "start" in c and "--resume" not in c][0]
    assert "--verbose" in start, start


def test_stop_marker_does_not_fire_on_other_stage():
    def fake(cmd, **kw):
        return _R("[00:11] intake      done   11s   x\n")

    wd = _wd()
    try:
        out = loki.run(wd, "spec.md", timeout=10, runner=fake,
                       interrupt_after_stage="plan")
    finally:
        shutil.rmtree(wd, ignore_errors=True)
    assert out["provenance"]["resume"]["killed"] is False


def test_collect_cost_reads_result_cost_files():
    wd = _wd()
    try:
        m = os.path.join(wd, ".loki", "metrics")
        os.makedirs(m)
        for i, usd in ((1, 0.25), (2, 0.5)):
            with open(os.path.join(m, "result-cost-%d.json" % i), "w") as fh:
                json.dump({"total_cost_usd": usd, "input_tokens": 100,
                           "output_tokens": 10, "cache_read_tokens": 5,
                           "cache_creation_tokens": 1,
                           "model": "claude-sonnet-5-5"}, fh)
        cost, model, _c = loki._collect_cost(os.path.join(wd, ".loki"))
    finally:
        shutil.rmtree(wd, ignore_errors=True)
    assert cost["usd"] == 0.75, cost
    assert cost["input_tokens"] == 200 and cost["output_tokens"] == 20
    assert model == "claude-sonnet-5-5"


def test_collect_cost_none_without_any_record():
    wd = _wd()
    try:
        os.makedirs(os.path.join(wd, ".loki", "metrics"))
        cost, _m, _c = loki._collect_cost(os.path.join(wd, ".loki"))
    finally:
        shutil.rmtree(wd, ignore_errors=True)
    assert cost["usd"] is None


def _pin(model):
    cap = {}

    def fake(cmd, **kw):
        cap["env"] = kw.get("env", {})
        return _R("Loki Mode vTEST")

    wd = _wd()
    try:
        loki.run(wd, "spec.md", model=model, timeout=10, runner=fake)
    finally:
        shutil.rmtree(wd, ignore_errors=True)
    return cap["env"].get("LOKI_SESSION_MODEL")


def test_full_model_ids_are_accepted():
    for mid in ("claude-sonnet-5-5", "claude-opus-4-8[1m]",
                "anthropic/claude-sonnet-5-5",
                "us.anthropic.claude-sonnet-5-5-v1:0"):
        assert _pin(mid) == mid, mid
    assert _pin("claude") is None
    assert _pin("gpt-5") is None


def _stub(dirpath, body):
    path = os.path.join(dirpath, "stub.py")
    with open(path, "w") as fh:
        fh.write("#!/usr/bin/env python3\n" + textwrap.dedent(body))
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path


def test_run_cli_sets_pwd_to_cwd():
    d = _wd()
    try:
        cwd = os.path.realpath(os.path.join(d, "work"))
        os.makedirs(cwd)
        stub = _stub(d, "import os\nprint(os.environ.get('PWD'))\n")
        old = os.environ.get("PWD")
        os.environ["PWD"] = "/somewhere/else"
        try:
            rc, out, _e, _s, _d = _base.run_cli([stub], cwd=cwd, timeout=20)
        finally:
            if old is None:
                os.environ.pop("PWD", None)
            else:
                os.environ["PWD"] = old
    finally:
        shutil.rmtree(d, ignore_errors=True)
    assert rc == 0 and out.strip() == cwd, out


def test_run_cli_pwd_also_reaches_injected_runner():
    cap = {}

    def fake(cmd, **kw):
        cap["env"] = kw["env"]
        return _R("")

    _base.run_cli(["x"], cwd="/tmp/some/dir", timeout=5, runner=fake)
    assert cap["env"]["PWD"] == os.path.abspath("/tmp/some/dir")


def test_stage_durations_from_run_events():
    wd = _wd()
    try:
        run_dir = os.path.join(wd, ".loki", "runs", "20261028-000000-ab")
        os.makedirs(run_dir)
        evs = [
            {"type": "run.started"},
            {"type": "stage.completed", "stage": "intake", "data": {"duration_s": 11}},
            {"type": "stage.completed", "stage": "plan", "data": {"duration_s": 6.5}},
            {"type": "stage.completed", "stage": "bad", "data": {}},
            {"type": "stage.failed", "stage": "implement", "data": {"reason": "x"}},
        ]
        with open(os.path.join(run_dir, "events.jsonl"), "w") as fh:
            fh.write("\n".join(json.dumps(e) for e in evs) + "\n")
        got = loki._read_stage_durations(os.path.join(wd, ".loki"))
        out = loki.run(wd, "spec.md", timeout=10,
                       runner=lambda c, **k: _R("Loki Mode vT"))
    finally:
        shutil.rmtree(wd, ignore_errors=True)
    assert got == {"intake": 11.0, "plan": 6.5}, got
    assert out["provenance"]["stage_durations_s"] == got


def test_stage_durations_none_without_events():
    wd = _wd()
    try:
        assert loki._read_stage_durations(os.path.join(wd, ".loki")) is None
    finally:
        shutil.rmtree(wd, ignore_errors=True)


def test_trial_row_carries_stage_durations():
    spec = {"id": "t", "prompt": "p",
            "acceptance": {"cmd": "true", "timeout_s": 10}}
    fix = tempfile.mkdtemp(prefix="loki-run.fix.")
    open(os.path.join(fix, "seed"), "w").close()

    def adapter(workdir, prompt_path, **kw):
        return _base.build_output(
            tool="loki", tool_version="1", model_used="m", duration_s=1.0,
            iterations=1, tokens_in=1, tokens_out=1, cost_usd=0.01,
            exit_status="completed",
            provenance={"stage_durations_s": {"plan": 6.5}})
    try:
        row = runner.run_trial(adapter, spec, fix, "m", "loki", 1)
    finally:
        shutil.rmtree(fix, ignore_errors=True)
    assert row["stage_durations_s"] == {"plan": 6.5}
