#!/usr/bin/env python3
"""Loki Mode adapter for the R2 benchmark harness.

Runs `loki start <spec> --provider claude --no-dashboard --yes` in the workdir
(the magic-ab/run.sh pattern), then collects cost via the shared
efficiency_cost module so the benchmark's Loki cost equals the proof's Loki
cost. Reports ONLY what the run did: tool/version/model/duration/iterations/
tokens/cost/exit_status/provenance. It NEVER reports success or quality; the
read-only grader (outside the agent container) decides that.

Importable and unit-testable with the CLI mocked: the subprocess call happens
only inside run(), and the loki/version probe accepts an injectable runner.
"""

import json
import os

try:
    from . import _base
except ImportError:  # allow running as a loose script / sys.path import
    import _base  # type: ignore


def _detect_loki_version(runner=None, cwd=None):
    """Best-effort `loki version` probe. Returns a string or None."""
    rc, out, _err, _status, _dur = _base.run_cli(
        ["loki", "version"], cwd=cwd or os.getcwd(), timeout=30, runner=runner
    )
    if rc != 0:
        return None
    text = (out or "").strip()
    return text.splitlines()[0].strip() if text else None


def _read_iteration_count(loki_dir):
    """Read iteration count from .loki state (magic-ab pattern)."""
    for name in ("session.json", "autonomy-state.json"):
        path = os.path.join(loki_dir, name)
        try:
            with open(path) as fh:
                state = json.load(fh)
        except Exception:
            continue
        if isinstance(state, dict):
            val = (state.get("iteration") or state.get("iterations")
                   or state.get("current_iteration"))
            if val is not None:
                try:
                    return int(val)
                except Exception:
                    return None
    return None


def run(workdir, spec, *, model="claude", timeout=900, runner=None,
        provider="claude"):
    """Run Loki on `spec` inside `workdir` and return the adapter-output dict.

    Args:
      workdir: directory to run in (the spec should already be present/copied).
      spec: path (relative to workdir or absolute) of the spec to build from.
      model: provider/model label recorded as model_used fallback.
      timeout: hard wall-clock cap in seconds.
      runner: injectable subprocess.run-compatible callable (tests mock the CLI).
      provider: provider passed to `loki start --provider`.
    """
    tool_version = _detect_loki_version(runner=runner, cwd=workdir)

    cmd = [
        "loki", "start", spec,
        "--provider", provider,
        "--no-dashboard",
        "--yes",
    ]
    rc, _out, _err, status, duration = _base.run_cli(
        cmd, cwd=workdir, timeout=timeout, runner=runner,
        env={"LOKI_AUTO_CONFIRM": "true"},
    )

    loki_dir = os.path.join(workdir, ".loki")
    iterations = _read_iteration_count(loki_dir)

    # Cost: shared with the proof generator. None usd == not recorded.
    cost = {"usd": None, "input_tokens": None, "output_tokens": None}
    model_used = None
    eff = _base.load_efficiency_cost()
    if eff is not None:
        try:
            collected, model_from_eff = eff.collect_efficiency(loki_dir)
            cost = collected
            model_used = model_from_eff or None
        except Exception:
            pass

    return _base.build_output(
        tool="loki",
        tool_version=tool_version,
        model_used=model_used or model,
        duration_s=duration,
        iterations=iterations,
        tokens_in=cost.get("input_tokens"),
        tokens_out=cost.get("output_tokens"),
        cost_usd=cost.get("usd"),
        exit_status=status if rc == 0 else status,
        provenance={
            "kind": "automated",
            "verified": True,
            "harness": "loki.start",
            "command": " ".join(cmd),
        },
    )
