#!/usr/bin/env python3
"""Aider adapter for the R2 benchmark harness.

Invokes Aider headless on a spec inside a workdir and captures tokens/cost if
Aider exposes them, else cost_usd=null (never fabricated). Reports ONLY
tool/version/model/duration/iterations/tokens/cost/exit_status/provenance. It
NEVER reports success or quality; the read-only grader decides that.

BYO key: this adapter does NOT require live API keys to import. The subprocess
call happens only inside run() and the runner is injectable so tests mock the
CLI. Per the R2 user decision, this adapter is NOT executed for paid runs in
R2 (CI mocks it); it exists and is tested-with-mocks for the deferred paid
head-to-head.

Aider headless pattern: `aider --message-file <spec> --yes --no-auto-commits
--model <model>` run non-interactively in the repo. Aider can emit a per-run
cost line and an analytics JSON; we parse both best-effort and fall back to
the shared price table when only tokens are available.
"""

import os
import re

try:
    from . import _base
except ImportError:
    import _base  # type: ignore


_AIDER_TOKENS_RE = re.compile(
    r"[Tt]okens:\s*([\d,]+)\s*sent[,\s]+([\d,]+)\s*received", re.MULTILINE
)
_AIDER_COST_RE = re.compile(
    r"\$\s*([0-9]+\.[0-9]+)\s*(?:session|message|total)?", re.MULTILINE
)


def _detect_aider_version(runner=None, cwd=None):
    rc, out, _err, _status, _dur = _base.run_cli(
        ["aider", "--version"], cwd=cwd or os.getcwd(), timeout=30, runner=runner
    )
    if rc != 0:
        return None
    text = (out or "").strip()
    if not text:
        return None
    # "aider 0.x.y" -> "0.x.y" when present, else the raw first line.
    m = re.search(r"aider\s+([0-9][\w.\-+]*)", text)
    return m.group(1) if m else text.splitlines()[0].strip()


def _parse_tokens(stdout):
    """Best-effort token parse from Aider stdout. Returns (in, out) or (None, None)."""
    m = _AIDER_TOKENS_RE.search(stdout or "")
    if not m:
        return None, None
    try:
        sent = int(m.group(1).replace(",", ""))
        recv = int(m.group(2).replace(",", ""))
        return sent, recv
    except Exception:
        return None, None


def _parse_native_cost(stdout):
    """Best-effort native cost line. Returns a float or None. Never fabricates."""
    matches = _AIDER_COST_RE.findall(stdout or "")
    if not matches:
        return None
    try:
        # The largest dollar figure on the run is the session total.
        return max(float(x) for x in matches)
    except Exception:
        return None


def run(workdir, spec, *, model="gpt-5", timeout=900, runner=None):
    """Run Aider on `spec` inside `workdir` and return the adapter-output dict."""
    tool_version = _detect_aider_version(runner=runner, cwd=workdir)

    cmd = [
        "aider",
        "--message-file", spec,
        "--model", model,
        "--yes",
        "--no-auto-commits",
        "--no-stream",
    ]
    rc, out, err, status, duration = _base.run_cli(
        cmd, cwd=workdir, timeout=timeout, runner=runner,
    )

    combined = (out or "") + "\n" + (err or "")
    tokens_in, tokens_out = _parse_tokens(combined)
    cost_usd = _parse_native_cost(combined)

    # If Aider did not print a native cost but we have tokens, price uniformly
    # from the shared dated table so cross-tool cost is on one basis.
    if cost_usd is None and tokens_in is not None and tokens_out is not None:
        eff = _base.load_efficiency_cost()
        if eff is not None:
            try:
                cost_usd = eff.price_from_tokens(model, tokens_in, tokens_out)
            except Exception:
                cost_usd = None

    return _base.build_output(
        tool="aider",
        tool_version=tool_version,
        model_used=model,
        duration_s=duration,
        iterations=None,  # Aider headless single message: no Loki-style iters.
        tokens_in=tokens_in,
        tokens_out=tokens_out,
        cost_usd=cost_usd,
        exit_status=status if rc == 0 else status,
        provenance={
            "kind": "automated",
            "verified": True,
            "harness": "aider.headless",
            "command": " ".join(cmd),
            "cost_basis": ("native" if cost_usd is not None and
                           _parse_native_cost(combined) is not None
                           else ("priced_from_tokens" if cost_usd is not None
                                 else "not_recorded")),
        },
    )
