#!/usr/bin/env python3
"""opencode adapter for the benchmark harness (model-agnostic route).

Runs `opencode run -m <provider/model> --auto <prompt>` non-interactively on a
spec inside a workdir. Reports ONLY tool/version/model/duration/exit_status/
provenance; success and quality belong to the read-only grader. opencode's
event stream is not parsed for usage, so tokens and cost stay None (never
fabricated).

Two measured hazards are handled in the call: stdin is /dev/null (a child that
inherits the parent's stdin can block waiting for input), and PWD equals the
workdir (set by _base.run_cli) so a tool reading $PWD works in the right tree.
The binary is $LOKI_OPENCODE_CLI when set, else `opencode` on PATH. The
subprocess call happens only inside run(); the runner is injectable.
"""

import os
import re

try:
    from . import _base
except ImportError:
    import _base  # type: ignore

TAIL_CHARS = 2000

_SECRET = re.compile(
    r"(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}"
    r"|github_pat_[A-Za-z0-9_]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})"
)


def _bin():
    return os.environ.get("LOKI_OPENCODE_CLI") or "opencode"


def _tail(text, n=TAIL_CHARS):
    return _SECRET.sub("[REDACTED]", (text or "")[-n:])


def _detect_version(runner=None, cwd=None):
    rc, out, _err, _status, _dur = _base.run_cli(
        [_bin(), "--version"], cwd=cwd or os.getcwd(), timeout=30,
        runner=runner, stdin_devnull=True)
    if rc != 0:
        return None
    text = (out or "").strip()
    if not text:
        return None
    m = re.search(r"([0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.]+)?)", text)
    return m.group(1) if m else text.splitlines()[0].strip()


def run(workdir, spec, *, model=None, timeout=900, runner=None, effort=None):
    """Run opencode on `spec` inside `workdir`; return the adapter-output dict.

    `model` is opencode's provider/model form; None leaves opencode's default.
    `effort` maps to --variant when given.
    """
    tool_version = _detect_version(runner=runner, cwd=workdir)
    prompt = (
        "Implement the project described in the spec file '%s' in this "
        "directory. Make the changes directly." % spec
    )
    cmd = [_bin(), "run", "--auto"]
    if model:
        cmd += ["-m", model]
    if effort:
        cmd += ["--variant", effort]
    cmd.append(prompt)
    rc, out, err, status, duration = _base.run_cli(
        cmd, cwd=workdir, timeout=timeout, runner=runner, stdin_devnull=True)
    return _base.build_output(
        tool="opencode",
        tool_version=tool_version,
        model_used=model,
        duration_s=duration,
        iterations=None,
        tokens_in=None,
        tokens_out=None,
        cost_usd=None,
        exit_status=status,
        provenance={
            "kind": "automated",
            "verified": True,
            "harness": "opencode.run",
            "command": "opencode run --auto%s <prompt>"
                       % ((" -m %s" % model) if model else ""),
            "rc": rc,
            "stdout_tail": _tail(out),
            "stderr_tail": _tail(err),
            "cost_basis": "not_recorded",
        },
    )
