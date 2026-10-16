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
    assert env.get("LOKI_SESSION_MODEL") == "claude-opus-4-8"


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


if __name__ == "__main__":
    test_real_alias_pins_session_model()
    test_full_claude_id_pins()
    test_provider_label_default_does_not_pin()
    test_claude_adapter_bare_flag_only_when_requested()
    test_claude_adapter_bare_without_key_raises_not_falls_back()
    print("ALL GREEN")
