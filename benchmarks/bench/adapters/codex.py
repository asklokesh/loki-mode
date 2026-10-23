#!/usr/bin/env python3
"""OpenAI Codex CLI adapter for the benchmark harness (second arm of the false-done instrument).

Invokes `codex exec --json` non-interactively on a spec inside a workdir, mirroring
claude_code.py. Reports ONLY tool/version/model/duration/tokens/cost/exit_status/
provenance; success and quality belong to the read-only grader. Absent fields stay
None (never fabricated). A ChatGPT-plan login reports no native cost, so cost_usd is
priced from tokens only when the shared price table knows the model, else null.

Headless pattern: `codex exec --json --skip-git-repo-check --ignore-user-config
-m <model> --dangerously-bypass-approvals-and-sandbox <prompt>`. The bypass flag is the
parity of claude's --dangerously-skip-permissions (the workdir is a throwaway bench dir).
--ignore-user-config and a throwaway CODEX_HOME (auth.json symlinked, nothing else) keep the
user's ~/.codex config, MCP servers and AGENTS.md out of the arm: measured, AGENTS.md otherwise
reaches the model and changes its behavior.
The binary is $LOKI_CODEX_CLI when set, else `codex` on PATH. The subprocess call happens
only inside run(); the runner is injectable so tests mock the CLI.
"""

import json
import os
import re
import shutil
import tempfile

try:
    from . import _base
except ImportError:
    import _base  # type: ignore

TAIL_CHARS = 2000
DEFAULT_MODEL = "gpt-5.6-luna"

# Conservative token-shaped redaction for the stored tails (keys, bearer tokens).
_SECRET = re.compile(
    r"(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}"
    r"|github_pat_[A-Za-z0-9_]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,})"
)


def _bin():
    return os.environ.get("LOKI_CODEX_CLI") or "codex"


def _tail(text, n=TAIL_CHARS):
    return _SECRET.sub("[REDACTED]", (text or "")[-n:])


def _isolated_home():
    """Throwaway CODEX_HOME holding only a symlink to the real auth.json (no config, no AGENTS.md)."""
    home = tempfile.mkdtemp(prefix="loki-run.codexhome.")
    src = os.path.join(os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex"), "auth.json")
    if os.path.isfile(src):
        os.symlink(src, os.path.join(home, "auth.json"))
    return home


def _detect_codex_version(runner=None, cwd=None):
    rc, out, _err, _status, _dur = _base.run_cli(
        [_bin(), "--version"], cwd=cwd or os.getcwd(), timeout=30, runner=runner
    )
    if rc != 0:
        return None
    text = (out or "").strip()
    if not text:
        return None
    m = re.search(r"([0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.]+)?)", text)
    return m.group(1) if m else text.splitlines()[0].strip()


def _events(stdout):
    """JSONL events from `codex exec --json`; non-JSON lines are skipped."""
    evs = []
    for line in (stdout or "").splitlines():
        line = line.strip()
        if line.startswith("{") and line.endswith("}"):
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if isinstance(obj, dict):
                evs.append(obj)
    return evs


def _int_or_none(v):
    try:
        return int(v) if v is not None and not isinstance(v, bool) else None
    except Exception:
        return None


def parse_events(stdout):
    """Sum usage over turn.completed events; capture turn failure text.

    Returns dict(tokens_in, tokens_out, cached_in, reasoning_out, turns, failed|None).
    Totals are None when no turn.completed carried usage (nothing is fabricated).
    """
    tot = {"input_tokens": None, "output_tokens": None,
           "cached_input_tokens": None, "reasoning_output_tokens": None}
    turns = 0
    failed = None
    for ev in _events(stdout):
        t = ev.get("type")
        if t == "turn.failed":
            err = ev.get("error")
            failed = (err.get("message") if isinstance(err, dict) else str(err)) or "turn.failed"
        elif t == "turn.completed":
            turns += 1
            usage = ev.get("usage") if isinstance(ev.get("usage"), dict) else {}
            for k in tot:
                v = _int_or_none(usage.get(k))
                if v is not None:
                    tot[k] = (tot[k] or 0) + v
    return {
        "tokens_in": tot["input_tokens"], "tokens_out": tot["output_tokens"],
        "cached_in": tot["cached_input_tokens"], "reasoning_out": tot["reasoning_output_tokens"],
        "turns": turns, "failed": failed,
    }


def run(workdir, spec, *, model=DEFAULT_MODEL, timeout=900, runner=None, effort=None):
    """Run Codex on `spec` inside `workdir`; return the adapter-output dict.

    `effort` adds `-c model_reasoning_effort="<level>"`; None leaves the default.
    """
    tool_version = _detect_codex_version(runner=runner, cwd=workdir)
    prompt = (
        "Implement the project described in the spec file '%s' in this "
        "directory. Make the changes directly." % spec
    )
    cmd = [
        _bin(), "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
        "-m", model, "--dangerously-bypass-approvals-and-sandbox",
    ]
    if effort:
        cmd += ["-c", 'model_reasoning_effort="%s"' % effort]
    cmd.append(prompt)
    home = _isolated_home()
    try:
        rc, out, err, status, duration = _base.run_cli(
            cmd, cwd=workdir, timeout=timeout, runner=runner, env={"CODEX_HOME": home},
        )
    finally:
        shutil.rmtree(home, ignore_errors=True)

    p = parse_events(out)
    # A turn.failed event with rc 0 is still a failed run; name it, never report completed.
    if rc == 0 and p["failed"]:
        status = "turn_failed"

    cost_usd = None
    if p["tokens_in"] is not None and p["tokens_out"] is not None:
        eff = _base.load_efficiency_cost()
        if eff is not None:
            try:
                cost_usd = eff.price_from_tokens(model, p["tokens_in"], p["tokens_out"])
            except Exception:
                cost_usd = None

    return _base.build_output(
        tool="codex",
        tool_version=tool_version,
        model_used=model,
        duration_s=duration,
        iterations=None,
        tokens_in=p["tokens_in"],
        tokens_out=p["tokens_out"],
        cost_usd=cost_usd,
        exit_status=status,
        provenance={
            "kind": "automated",
            "verified": True,
            "harness": "codex.exec",
            "isolated_codex_home": True,
            "command": "codex exec --json --skip-git-repo-check --ignore-user-config -m %s "
                       "--dangerously-bypass-approvals-and-sandbox <prompt>" % model,
            "rc": rc,
            "stdout_tail": _tail(out),
            "stderr_tail": _tail(err),
            "usage_detail": {
                "cached_input_tokens": p["cached_in"],
                "reasoning_output_tokens": p["reasoning_out"],
                "num_turns": p["turns"] or None,
            },
            "turn_failed": _tail(p["failed"]) if p["failed"] else None,
            "cost_basis": "priced_from_tokens" if cost_usd is not None else "not_recorded",
        },
    )
