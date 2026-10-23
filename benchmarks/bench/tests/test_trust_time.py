"""Fixtures for trust_time.py. FABRICATED stub trials, test only. No network, no spend."""

import json
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import trust_time as tt  # noqa: E402

CONTRACT = {"axis", "tool", "tool_version", "model", "task_id", "task_hash", "trial", "value", "unit",
            "correct", "grader_verdict", "provenance", "spend_usd", "manifest"}


def _git(cwd, *a):
    subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True,
                   env=dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t"))


def _world(tmp, grader=True, tools=("loki", "claude_code")):
    """Result JSON, task file, manifest and a kept workdir per tool."""
    tasks, res, wds = tmp / "tasks", tmp / "res", tmp / "wd"
    tasks.mkdir(), res.mkdir()
    (tasks / "t1.json").write_text(json.dumps({"id": "t1", "prompt": "do it", "acceptance": {"cmd": "true"}, "visible_cmd": "true"}))
    (tmp / "m.json").write_text(json.dumps({"name": "stub-manifest", "tasks": ["t1"]}))
    for tool in tools:
        (res / (tool + ".json")).write_text(json.dumps({"tool": tool, "task_id": "t1", "trials": [
            {"trial": 1, "success": grader, "measured": True, "adapter": {"tool_version": "1.0", "model": "m"}}]}))
        wd = wds / tool / "t1" / "1"
        wd.mkdir(parents=True)
        (wd / "a.txt").write_text("x")
        _git(wd, "init", "-q"), _git(wd, "add", "a.txt"), _git(wd, "commit", "-qm", "init")
        rd = wd / ".loki" / "runs" / "r1"
        rd.mkdir(parents=True)
        (rd / "receipt.json").write_text("{}")
        (wd / ".loki" / "state").mkdir()
        (wd / ".loki" / "state" / "secret").write_text("original-state")
    return tmp


def _rows(tmp, mech=None, judge=None, mode="mechanical"):
    return tt.build_rows(str(tmp / "m.json"), [str(tmp / "res")], str(tmp / "wd"), mode, str(tmp / "tasks"),
                         **({"mech": mech} if mech else {}), **({"judge": judge} if judge else {}))


def test_rows_match_contract_for_loki_and_competitor(tmp_path):
    w = _world(tmp_path)
    rows, skipped = _rows(w, mech=lambda tool, wd, spec: (1.5, True, {"steps": []}))
    assert skipped == [] and len(rows) == 2
    for r in rows:
        assert set(r) == CONTRACT and r["axis"] == "B" and r["unit"] == "s" and r["manifest"] == "stub-manifest"
        assert r["correct"] is True and r["spend_usd"] == 0.0 and len(r["task_hash"]) == 64


def test_fast_wrong_trust_is_kept_and_counted(tmp_path):
    w = _world(tmp_path, grader=False)
    rows, _ = _rows(w, mech=lambda tool, wd, spec: (0.1, True, {"steps": []}))
    assert len(rows) == 2 and all(r["correct"] is False and r["grader_verdict"] is False for r in rows)


def test_missing_workdir_is_no_data_not_zero(tmp_path, capsys):
    w = _world(tmp_path)
    import shutil
    shutil.rmtree(w / "wd")
    rc = tt.main(["--manifest", str(w / "m.json"), "--results", str(w / "res"), "--workdirs", str(w / "wd"),
                  "--tasks-dir", str(w / "tasks"), "--out", str(w / "out")])
    assert rc == 3 and "NO DATA" in capsys.readouterr().out and not (w / "out").exists()


def _fake_loki(tmp, body):
    p = tmp / "fakeloki"
    p.write_text("#!/bin/sh\n" + body + "\n")
    p.chmod(0o755)
    return str(p)


def test_independent_clone_leaves_original_state_behind(tmp_path):
    w = _world(tmp_path)
    dest = tmp_path / "clone"
    tt.independent_clone(str(w / "wd" / "loki" / "t1" / "1"), str(dest))
    assert (dest / ".loki" / "runs" / "r1" / "receipt.json").exists()
    assert not (dest / ".loki" / "state").exists()


def test_loki_trust_uses_receipt_alone_and_tamper_fails(tmp_path, monkeypatch):
    w = _world(tmp_path, grader=True)
    wd = str(w / "wd" / "loki" / "t1" / "1")
    spec = {"acceptance": {}}
    # fake CLI: verify passes only if the receipt is intact and the original state dir is absent
    monkeypatch.setattr(tt, "LOKI_BIN", _fake_loki(tmp_path, 'test ! -e .loki/state/secret && grep -q "{}" .loki/runs/"$3"/receipt.json'))
    # proof verify <id> -> $3 is the id; check-fresh has no id and just needs the same clone
    monkeypatch.setattr(tt, "LOKI_BIN", _fake_loki(tmp_path, 'test ! -e .loki/state/secret && { [ "$2" = "--check-fresh" ] || grep -q "{}" .loki/runs/"$3"/receipt.json; }'))
    secs, trusted, prov = tt.mechanical("loki", wd, spec)
    assert trusted is True and [s["step"] for s in prov["steps"]] == ["proof_verify", "check_fresh"] and secs >= 0
    (w / "wd" / "loki" / "t1" / "1" / ".loki" / "runs" / "r1" / "receipt.json").write_text("tampered")
    _, trusted2, _ = tt.mechanical("loki", wd, spec)
    assert trusted2 is False
    rows, _ = _rows(w, mech=lambda tool, wd_, s: tt.mechanical(tool, wd_, s))
    loki = [r for r in rows if r["tool"] == "loki"][0]
    assert loki["grader_verdict"] is True and loki["correct"] is False


def test_competitor_times_install_suite_and_diff(tmp_path):
    w = _world(tmp_path, grader=True)
    wd = str(w / "wd" / "claude_code" / "t1" / "1")
    secs, trusted, prov = tt.mechanical("claude_code", wd, {"visible_cmd": "true", "acceptance": {"setup_cmd": "true"}})
    assert trusted is True and [s["step"] for s in prov["steps"]] == ["install", "visible_suite", "diff_stat"]
    _, trusted2, _ = tt.mechanical("claude_code", wd, {"visible_cmd": "false", "acceptance": {}})
    assert trusted2 is False


def test_no_receipt_means_loki_trust_fails_and_no_row(tmp_path):
    w = _world(tmp_path)
    import shutil
    shutil.rmtree(w / "wd" / "loki" / "t1" / "1" / ".loki")
    secs, trusted, prov = tt.mechanical("loki", str(w / "wd" / "loki" / "t1" / "1"), {})
    assert secs is None and trusted is False and "no receipt" in prov["note"]


def test_judged_refuses_without_spend_env(tmp_path, monkeypatch):
    monkeypatch.delenv("LOKI_BENCH_SPEND_APPROVED", raising=False)
    with pytest.raises(SystemExit):
        tt.judged("loki", str(tmp_path), {})


def test_judge_env_has_no_loki_vars_and_emits_token_row(tmp_path, monkeypatch):
    w = _world(tmp_path)
    monkeypatch.setenv("LOKI_BENCH_SPEND_APPROVED", "1")
    monkeypatch.setenv("LOKI_SOMETHING", "leak")
    seen = {}

    def fake(argv, cwd, env, timeout=0, shell=False):
        seen.update(env=env, argv=argv, timeout=timeout)
        return 0, 4.0, json.dumps({"result": "DONE\nlooks fine", "usage": {"input_tokens": 100, "output_tokens": 20}, "total_cost_usd": 0.05})

    rows, _ = tt.build_rows(str(w / "m.json"), [str(w / "res")], str(w / "wd"), "judged", str(w / "tasks"),
                            judge=lambda tool, wd, spec: tt.judged(tool, wd, spec, runner=fake))
    assert not [k for k in seen["env"] if k.startswith("LOKI_")]
    assert seen["argv"][:2] == ["claude", "-p"] and "sonnet" in seen["argv"] and seen["timeout"] == 600
    units = sorted(r["unit"] for r in rows if r["tool"] == "loki")
    assert units == ["s", "tok"] and all(r["spend_usd"] == 0.05 for r in rows)
    tok = [r for r in rows if r["unit"] == "tok" and r["tool"] == "loki"][0]
    assert tok["value"] == 120 and tok["provenance"]["prompt_hash"] == tt.PROMPT_HASH


def test_loki_cli_missing_is_skipped_not_a_fast_correct_row(tmp_path, monkeypatch, capsys):
    w = _world(tmp_path, grader=False, tools=("loki",))
    monkeypatch.setattr(tt, "LOKI_BIN", "/nonexistent/loki")
    secs, trusted, prov = tt.mechanical("loki", str(w / "wd" / "loki" / "t1" / "1"), {"acceptance": {}})
    assert secs is None and trusted is False and "did not run" in prov["note"]
    rows, skipped = _rows(w, mech=lambda tool, wd_, s: tt.mechanical(tool, wd_, s))
    assert rows == [] and len(skipped) == 1


def test_competitor_command_not_found_is_skipped(tmp_path):
    w = _world(tmp_path, grader=False, tools=("claude_code",))
    wd = str(w / "wd" / "claude_code" / "t1" / "1")
    secs, _, prov = tt.mechanical("claude_code", wd, {"visible_cmd": "definitely-not-a-command-xyz", "acceptance": {}})
    assert secs is None and "visible_suite" in prov["note"]
    secs, _, prov = tt.mechanical("claude_code", wd, {"visible_cmd": "true", "acceptance": {"setup_cmd": "definitely-not-a-command-xyz"}})
    assert secs is None and "install" in prov["note"]


@pytest.mark.parametrize("rc", [124, 126, 127])
def test_timeout_or_unrunnable_step_is_skipped_but_diff_stat_is_informational(tmp_path, rc):
    w = _world(tmp_path, grader=True, tools=("claude_code",))
    wd = str(w / "wd" / "claude_code" / "t1" / "1")

    def runner(argv, cwd, env, timeout=0, shell=False):
        return (rc, 300.0, "") if shell else (rc, 0.1, "")  # shell steps are install/suite; the list step is diff_stat
    secs, _, _ = tt.mechanical("claude_code", wd, {"visible_cmd": "true", "acceptance": {}}, runner=runner)
    assert secs is None

    def only_diff_dead(argv, cwd, env, timeout=0, shell=False):
        return (0, 1.0, "") if shell else (rc, 0.1, "")
    secs, trusted, _ = tt.mechanical("claude_code", wd, {"visible_cmd": "true", "acceptance": {}}, runner=only_diff_dead)
    assert secs is not None and trusted is True
