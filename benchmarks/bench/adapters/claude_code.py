#!/usr/bin/env python3
"""Claude Code CLI adapter for the R2 benchmark harness.

Invokes Claude Code headless (`claude -p`) on a spec inside a workdir and
captures tokens/cost from its JSON output if exposed, else cost_usd=null
(never fabricated). Reports ONLY tool/version/model/duration/iterations/
tokens/cost/exit_status/provenance. It NEVER reports success or quality; the
read-only grader decides that.

BYO key: does NOT require live API keys to import. The subprocess call happens
only inside run() and the runner is injectable so tests mock the CLI. Per the
R2 user decision this adapter is NOT executed for paid runs in R2 (CI mocks
it); it exists and is tested-with-mocks for the deferred paid head-to-head.

Headless pattern: `claude -p <prompt> --output-format json`. The JSON result
includes total_cost_usd and usage token counts on recent CLI versions; we
parse them best-effort and fall back to the shared price table when only
tokens are present.
"""

import json
import os
import re

try:
    from . import _base
except ImportError:
    import _base  # type: ignore


def _detect_claude_version(runner=None, cwd=None):
    rc, out, _err, _status, _dur = _base.run_cli(
        ["claude", "--version"], cwd=cwd or os.getcwd(), timeout=30, runner=runner
    )
    if rc != 0:
        return None
    text = (out or "").strip()
    if not text:
        return None
    m = re.search(r"([0-9]+\.[0-9]+\.[0-9]+)", text)
    return m.group(1) if m else text.splitlines()[0].strip()


def _parse_json_result(stdout):
    """Parse claude -p --output-format json output.

    Returns (cost_usd|None, tokens_in|None, tokens_out|None, model|None). Never
    fabricates: any field absent from the JSON stays None.
    """
    text = (stdout or "").strip()
    if not text:
        return None, None, None, None
    obj = None
    # Try whole-blob parse, then last JSON object line (streaming-json).
    try:
        obj = json.loads(text)
    except Exception:
        for line in reversed(text.splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    obj = json.loads(line)
                    break
                except Exception:
                    continue
    if not isinstance(obj, dict):
        return None, None, None, None

    cost = obj.get("total_cost_usd")
    if cost is None:
        cost = obj.get("cost_usd")
    try:
        cost = float(cost) if cost is not None else None
    except Exception:
        cost = None

    usage = obj.get("usage") if isinstance(obj.get("usage"), dict) else {}
    t_in = usage.get("input_tokens")
    t_out = usage.get("output_tokens")
    try:
        t_in = int(t_in) if t_in is not None else None
    except Exception:
        t_in = None
    try:
        t_out = int(t_out) if t_out is not None else None
    except Exception:
        t_out = None

    model = obj.get("model") or None
    return cost, t_in, t_out, model


def run(workdir, spec, *, model="claude-sonnet-4", timeout=900, runner=None):
    """Run Claude Code on `spec` inside `workdir`; return adapter-output dict.

    `spec` is read as the prompt body (a path inside workdir or absolute).
    """
    tool_version = _detect_claude_version(runner=runner, cwd=workdir)

    # Pass the spec path; the prompt instructs Claude to build from the spec
    # file in the cwd. We do not inline file contents to keep the command
    # bounded and reproducible.
    prompt = (
        "Implement the project described in the spec file '%s' in this "
        "directory. Make the changes directly." % spec
    )
    cmd = [
        "claude", "-p", prompt,
        "--output-format", "json",
        "--model", model,
        "--dangerously-skip-permissions",
    ]
    rc, out, err, status, duration = _base.run_cli(
        cmd, cwd=workdir, timeout=timeout, runner=runner,
    )

    cost_usd, tokens_in, tokens_out, model_used = _parse_json_result(out)
    native_cost = cost_usd is not None

    if cost_usd is None and tokens_in is not None and tokens_out is not None:
        eff = _base.load_efficiency_cost()
        if eff is not None:
            try:
                cost_usd = eff.price_from_tokens(
                    model_used or model, tokens_in, tokens_out
                )
            except Exception:
                cost_usd = None

    return _base.build_output(
        tool="claude_code",
        tool_version=tool_version,
        model_used=model_used or model,
        duration_s=duration,
        iterations=None,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=cost_usd,
        exit_status=status if rc == 0 else status,
        provenance={
            "kind": "automated",
            "verified": True,
            "harness": "claude.headless",
            "command": "claude -p <prompt> --output-format json --model %s" % model,
            "cost_basis": ("native" if native_cost else
                           ("priced_from_tokens" if cost_usd is not None
                            else "not_recorded")),
        },
    )
