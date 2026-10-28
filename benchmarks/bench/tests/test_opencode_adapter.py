"""opencode adapter: stdin is /dev/null (a child must not block on a prompt)
and PWD equals the workdir. A real stub script observes both.
Run: python3 -m pytest benchmarks/bench/tests/test_opencode_adapter.py -q
"""
import json
import os
import shutil
import stat
import sys
import tempfile
import textwrap

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from adapters import _base, opencode  # noqa: E402


def _stub_bin(d):
    path = os.path.join(d, "opencode-stub.py")
    with open(path, "w") as fh:
        fh.write("#!/usr/bin/env python3\n" + textwrap.dedent("""
            import json, os, sys
            if "--version" in sys.argv:
                print("1.18.9")
                sys.exit(0)
            print(json.dumps({
                "pwd": os.environ.get("PWD"),
                "cwd": os.getcwd(),
                "stdin_is_devnull": os.fstat(0).st_rdev == os.stat(os.devnull).st_rdev,
                "argv": sys.argv[1:],
            }))
        """))
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR)
    return path


def test_devnull_stdin_and_pwd_equal_workdir():
    d = tempfile.mkdtemp(prefix="loki-run.oc-test.")
    old = os.environ.get("PWD")
    try:
        wd = os.path.realpath(os.path.join(d, "work"))
        os.makedirs(wd)
        os.environ["LOKI_OPENCODE_CLI"] = _stub_bin(d)
        os.environ["PWD"] = "/somewhere/else"
        # Make the parent's fd 0 a pipe (pytest's is already /dev/null, which
        # would hide a child that merely inherits stdin).
        r, w = os.pipe()
        saved = os.dup(0)
        os.dup2(r, 0)
        try:
            out = opencode.run(wd, "spec.md",
                               model="anthropic/claude-sonnet-5-5", timeout=30)
        finally:
            os.dup2(saved, 0)
            for fd in (r, w, saved):
                os.close(fd)
    finally:
        os.environ.pop("LOKI_OPENCODE_CLI", None)
        if old is None:
            os.environ.pop("PWD", None)
        else:
            os.environ["PWD"] = old
        shutil.rmtree(d, ignore_errors=True)
    seen = json.loads(out["provenance"]["stdout_tail"].strip().splitlines()[-1])
    assert seen["pwd"] == wd, seen
    assert seen["stdin_is_devnull"] is True, seen
    assert "-m" in seen["argv"] and "anthropic/claude-sonnet-5-5" in seen["argv"]
    assert out["tool"] == "opencode" and out["tool_version"] == "1.18.9"
    assert out["cost_usd"] is None and out["exit_status"] == "completed"
    for k in _base.FORBIDDEN_ADAPTER_KEYS:
        assert k not in out


def test_missing_cli_is_reported_not_raised():
    os.environ["LOKI_OPENCODE_CLI"] = "/nonexistent/opencode-xyz"
    wd = tempfile.mkdtemp(prefix="loki-run.oc-test.")
    try:
        out = opencode.run(wd, "spec.md", timeout=5)
    finally:
        os.environ.pop("LOKI_OPENCODE_CLI", None)
        shutil.rmtree(wd, ignore_errors=True)
    assert out["exit_status"] == "cli_not_found"
