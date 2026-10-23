"""Regression: the loki bench adapter must PIN the requested model via
LOKI_SESSION_MODEL (loki start has no --model flag; the whole-run tier pin is
that env var). Before this fix, `--model haiku` was dropped and the run stayed on
the default sonnet, making tier-routing (Rank 2) unmeasurable. The 'claude'
provider-label default must NOT pin (it is not a real model alias).
Run: python3 benchmarks/bench/tests/test_model_pin.py"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from adapters import loki as loki_adapter  # noqa: E402


def _capture_env(model):
    cap = {}

    def fake_runner(cmd, **kw):
        cap["env"] = kw.get("env", {})

        class R:
            returncode = 0
            stdout = "Loki Mode vTEST"
            stderr = ""
        return R()

    wd = tempfile.mkdtemp()
    loki_adapter.run(wd, "spec.md", model=model, timeout=10, runner=fake_runner)
    return cap.get("env", {})


def test_real_alias_pins_session_model():
    for alias in ("haiku", "sonnet", "opus", "fable"):
        env = _capture_env(alias)
        assert env.get("LOKI_SESSION_MODEL") == alias, (alias, env)


def test_full_claude_id_pins():
    env = _capture_env("claude-opus-4-8")
    assert env.get("LOKI_SESSION_MODEL") == "opus"


def test_sonnet_id_pins_family_alias():
    # claude-sonnet-5 is the task-spec label; the engine refuses non-alias pins.
    assert _capture_env("claude-sonnet-5").get("LOKI_SESSION_MODEL") == "sonnet"


def test_provider_label_default_does_not_pin():
    env = _capture_env("claude")  # provider label, not a model
    assert "LOKI_SESSION_MODEL" not in env


def _claude_cmd(**kw):
    from adapters import claude_code
    cap = {}

    def fake_runner(cmd, **k):
        cap.setdefault("cmds", []).append(list(cmd))

        class R:
            returncode = 0
            stdout = "{}"
            stderr = ""
        return R()

    claude_code.run(tempfile.mkdtemp(), "spec.md", timeout=10, runner=fake_runner, **kw)
    return [c for c in cap["cmds"] if "-p" in c][0]


def test_claude_adapter_bare_flag_only_when_requested():
    assert "--bare" not in _claude_cmd()
    old = os.environ.get("ANTHROPIC_API_KEY")
    os.environ["ANTHROPIC_API_KEY"] = "k"
    try:
        assert "--bare" in _claude_cmd(bare=True)
    finally:
        if old is None:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            os.environ["ANTHROPIC_API_KEY"] = old


def test_claude_adapter_bare_without_key_raises_not_falls_back():
    from adapters import claude_code
    old = os.environ.pop("ANTHROPIC_API_KEY", None)
    try:
        try:
            claude_code.run(tempfile.mkdtemp(), "spec.md", bare=True,
                            runner=lambda *a, **k: None)
        except RuntimeError as exc:
            assert "ANTHROPIC_API_KEY" in str(exc)
        else:
            raise AssertionError("bare without key must raise")
    finally:
        if old is not None:
            os.environ["ANTHROPIC_API_KEY"] = old


def test_claude_adapter_lean_exact_argv():
    base = _claude_cmd()
    lean = _claude_cmd(lean=True)
    assert lean[:len(base)] == base
    assert lean[len(base):] == [
        "--setting-sources", "project", "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands",
        "--tools", "Bash,Read,Edit,Write,Glob,Grep",
    ]
    assert "--strict-mcp-config" not in base


def test_claude_adapter_lean_with_bare_raises():
    from adapters import claude_code
    try:
        claude_code.run(tempfile.mkdtemp(), "spec.md", bare=True, lean=True,
                        runner=lambda *a, **k: None)
    except ValueError:
        pass
    else:
        raise AssertionError("lean+bare must raise")


def test_claude_adapter_lean_recorded_in_command():
    from adapters import claude_code

    class R:
        returncode = 0
        stdout = "{}"
        stderr = ""
    out = claude_code.run(tempfile.mkdtemp(), "spec.md", lean=True, timeout=10,
                          runner=lambda *a, **k: R())
    assert "--strict-mcp-config" in out["provenance"]["command"]


RAW_JSON = (
    '{"total_cost_usd":0.5,"num_turns":7,"usage":{"input_tokens":12,'
    '"output_tokens":300,"cache_read_input_tokens":45000,'
    '"cache_creation_input_tokens":9000,'
    '"cache_creation":{"ephemeral_5m_input_tokens":6000,'
    '"ephemeral_1h_input_tokens":3000}},'
    '"modelUsage":{"claude-sonnet-4-6":{"inputTokens":12},'
    '"claude-haiku-4-5":{"inputTokens":3}}}'
)


def test_usage_detail_records_every_token_class():
    from adapters import claude_code
    d = claude_code.parse_usage_detail(RAW_JSON)
    assert d["cache_read_input_tokens"] == 45000
    assert d["cache_creation_5m"] == 6000
    assert d["cache_creation_1h"] == 3000
    assert d["cache_creation_total"] == 9000
    assert d["num_turns"] == 7
    assert d["models_ran"] == ["claude-haiku-4-5", "claude-sonnet-4-6"]


def test_usage_detail_total_only_and_absent():
    from adapters import claude_code
    d = claude_code.parse_usage_detail(
        '{"usage":{"cache_creation_input_tokens":40}}')
    assert d["cache_creation_total"] == 40
    assert d["cache_creation_5m"] is None and d["cache_creation_1h"] is None
    assert d["cache_read_input_tokens"] is None and d["models_ran"] == []
    assert claude_code.parse_usage_detail("")["num_turns"] is None


def test_usage_detail_total_derived_from_split_only():
    from adapters import claude_code
    d = claude_code.parse_usage_detail(
        '{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":6000,'
        '"ephemeral_1h_input_tokens":3000}}}')
    assert d["cache_creation_total"] == 9000
    d = claude_code.parse_usage_detail(
        '{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":3000}}}')
    assert d["cache_creation_total"] == 3000
    assert d["cache_creation_5m"] is None and d["cache_creation_1h"] == 3000


def test_adapter_run_carries_usage_detail():
    from adapters import claude_code

    class R:
        returncode = 0
        stdout = RAW_JSON
        stderr = ""
    out = claude_code.run(tempfile.mkdtemp(), "spec.md", timeout=10,
                          runner=lambda *a, **k: R())
    assert out["provenance"]["usage_detail"]["cache_read_input_tokens"] == 45000


def test_raw_claude_row_has_usage_detail():
    import attribution

    class R:
        returncode = 0
        stdout = RAW_JSON
        stderr = ""
    res = attribution.run_raw_claude(tempfile.mkdtemp(), "p", model="sonnet",
                                     budget_usd=1, timeout_s=10,
                                     runner=lambda *a, **k: R())
    assert res["usage_detail"]["num_turns"] == 7
    assert res["usage_detail"]["cache_creation_1h"] == 3000


def _row(arm, model, ran=None, task="t1", rep=1):
    r = {"task": task, "repeat": rep, "arm": arm, "model_used": model}
    if ran is not None:
        r["usage_detail"] = {"models_ran": ran}
    return r


def test_attribution_invalid_when_models_differ():
    import attribution
    cells = attribution.attribution_cells([
        _row("loki", "claude-opus-4-8"),
        _row("raw-configured", "sonnet", ["claude-sonnet-4-6"])])
    assert cells[0]["valid"] is False
    assert "claude-opus-4-8" in cells[0]["reason"]
    assert "claude-sonnet-4-6" in cells[0]["reason"]


def test_attribution_valid_when_alias_matches_full_id():
    import attribution
    cells = attribution.attribution_cells([
        _row("loki", "sonnet"),
        _row("raw-configured", "sonnet", ["claude-sonnet-4-6"])])
    assert cells[0]["valid"] is True and cells[0]["reason"] is None


def test_summarize_exposes_attribution_cells():
    import attribution
    rows = [_row("loki", "opus"),
            _row("raw-configured", "sonnet", ["claude-sonnet-4-6"])]
    s = attribution.summarize(rows)
    assert s["attribution_cells"][0]["valid"] is False


if __name__ == "__main__":
    test_usage_detail_records_every_token_class()
    test_usage_detail_total_only_and_absent()
    test_adapter_run_carries_usage_detail()
    test_raw_claude_row_has_usage_detail()
    test_attribution_invalid_when_models_differ()
    test_attribution_valid_when_alias_matches_full_id()
    test_summarize_exposes_attribution_cells()
    test_real_alias_pins_session_model()
    test_full_claude_id_pins()
    test_provider_label_default_does_not_pin()
    test_claude_adapter_bare_flag_only_when_requested()
    test_claude_adapter_bare_without_key_raises_not_falls_back()
    test_claude_adapter_lean_exact_argv()
    test_claude_adapter_lean_with_bare_raises()
    test_claude_adapter_lean_recorded_in_command()
    print("ALL GREEN")
