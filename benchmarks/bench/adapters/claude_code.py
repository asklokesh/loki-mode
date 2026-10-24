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


def _load_result_obj(stdout):
    text = (stdout or "").strip()
    if not text:
        return None
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
    return obj if isinstance(obj, dict) else None


def _int_or_none(v):
    try:
        return int(v) if v is not None and not isinstance(v, bool) else None
    except Exception:
        return None


def parse_usage_detail(stdout):
    """Every raw token class plus the models that actually ran.

    input_tokens alone is only the uncached remainder (8 to 28 on cached runs),
    so cache reads, cache creation (5m and 1h split when present, else the
    total), num_turns and the modelUsage keys are recorded too. Absent fields
    stay None (models_ran stays []); nothing is fabricated.
    """
    obj = _load_result_obj(stdout) or {}
    usage = obj.get("usage") if isinstance(obj.get("usage"), dict) else {}
    cc = usage.get("cache_creation")
    cc = cc if isinstance(cc, dict) else {}
    five = _int_or_none(cc.get("ephemeral_5m_input_tokens"))
    hour = _int_or_none(cc.get("ephemeral_1h_input_tokens"))
    total = _int_or_none(usage.get("cache_creation_input_tokens"))
    if total is None and (five is not None or hour is not None):
        total = (five or 0) + (hour or 0)
    mu = obj.get("modelUsage")
    return {
        "cache_read_input_tokens": _int_or_none(usage.get("cache_read_input_tokens")),
        "cache_creation_5m": five,
        "cache_creation_1h": hour,
        "cache_creation_total": total,
        "num_turns": _int_or_none(obj.get("num_turns")),
        "usage": usage or None,
        "total_cost_usd": obj.get("total_cost_usd") if isinstance(obj.get("total_cost_usd"), (int, float)) and not isinstance(obj.get("total_cost_usd"), bool) else None,
        "models_ran": sorted(str(k) for k in mu) if isinstance(mu, dict) else [],
    }


def _parse_json_result(stdout):
    """Parse claude -p --output-format json output.

    Returns (cost_usd|None, tokens_in|None, tokens_out|None, model|None). Never
    fabricates: any field absent from the JSON stays None.
    """
    obj = _load_result_obj(stdout)
    if obj is None:
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


LEAN_ARGS = (
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--tools", "Bash,Read,Edit,Write,Glob,Grep",
)


def run(workdir, spec, *, model="sonnet", timeout=900, runner=None, bare=False,
        lean=False, effort=None, interrupt_after_s=None):
    """Run Claude Code on `spec` inside `workdir`; return adapter-output dict.

    `spec` is read as the prompt body (a path inside workdir or absolute).
    `bare=True` adds `--bare` (no hooks, skills, CLAUDE.md or OAuth); it needs
    ANTHROPIC_API_KEY and raises rather than silently running configured.
    `lean=True` is the OAuth-safe raw baseline: project settings only, no MCP,
    no slash commands, and the same 6 tools as ENGINE10_TOOLS (providers.ts).
    It cannot combine with `bare`; that raises ValueError.
    `effort` adds `--effort <level>`; None leaves the CLI default untouched.
    `interrupt_after_s` is the resume-cost instrument (100x axis D): stop the
    run after that many seconds, then continue it with claude's own
    `--continue`. The killed leg prints no usage JSON, so its spend is not
    recorded (provenance.resume.leg1_usd None) and the total is a lower bound.
    """
    if lean and bare:
        raise ValueError("claude lean and bare are mutually exclusive")
    if bare and not os.environ.get("ANTHROPIC_API_KEY"):
        raise RuntimeError("claude --bare requires ANTHROPIC_API_KEY")
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
    if effort:
        cmd += ["--effort", effort]
    if bare:
        cmd.append("--bare")
    if lean:
        cmd += list(LEAN_ARGS)
    rc, out, err, status, duration = _base.run_cli(
        cmd, cwd=workdir, timeout=timeout, runner=runner,
        stop_after_s=interrupt_after_s,
    )
    resume = None
    if interrupt_after_s is not None:
        resume = {"interrupt_after_s": interrupt_after_s,
                  "killed": status == "interrupted", "leg1_s": duration,
                  "leg1_usd": None, "leg2_s": None, "leg2_usd": None}
        if status == "interrupted":
            rc, out, err, status, dur2 = _base.run_cli(
                cmd + ["--continue"], cwd=workdir, timeout=timeout,
                runner=runner)
            resume["leg2_s"] = dur2
            duration = round(duration + dur2, 3)

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

    if resume is not None and resume["killed"]:
        resume["leg2_usd"] = cost_usd
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
            "command": "claude -p <prompt> --output-format json --model %s%s%s"
                       % (model, " --bare" if bare else "",
                          " " + " ".join(LEAN_ARGS) if lean else ""),
            "resume": resume,
            "journal_reuse_wall_s": resume["leg2_s"] if resume else None,
            "usage_detail": parse_usage_detail(out),
            "cost_basis": ("native" if native_cost else
                           ("priced_from_tokens" if cost_usd is not None
                            else "not_recorded")),
        },
    )
