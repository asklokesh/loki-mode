#!/usr/bin/env python3
"""Shared helpers for R2 benchmark adapters.

Responsibilities:
  - Robustly make autonomy/lib/efficiency_cost.py importable from anywhere in
    the tree (the adapters live under benchmarks/bench/adapters/, the cost
    module lives under autonomy/lib/). Import is done lazily / defensively so
    that importing an adapter never requires the cost module to load and never
    requires live API keys.
  - Build the canonical adapter-output dict so that NO adapter can accidentally
    emit a success or quality field. The schema is constructed here and the
    builder hard-strips success/quality if a caller ever passes them.

Per the spec (benchmarks/SCHEMA-adapter.md / R2 plan), adapter output is:
  {tool, tool_version, model_used, duration_s, iterations,
   tokens_in, tokens_out, cost_usd|null, exit_status, provenance}

provenance is a dict: {kind, verified, ...}. kind is one of
  "automated" (the adapter ran the tool itself) or
  "manual" (operator-supplied numbers, verified=false).
"""

import os
import subprocess
import sys
import time

# Required keys in every adapter output (the contract the grader/report rely on).
ADAPTER_OUTPUT_KEYS = (
    "tool",
    "tool_version",
    "model_used",
    "duration_s",
    "iterations",
    "tokens_in",
    "tokens_out",
    "cost_usd",
    "exit_status",
    "provenance",
)

# Keys an adapter must NEVER emit. Success/quality belong to the grader only.
FORBIDDEN_ADAPTER_KEYS = ("success", "quality", "passed", "score", "verdict")


def _repo_root():
    """Walk up from this file to the repo root (has VERSION + autonomy/)."""
    here = os.path.dirname(os.path.abspath(__file__))
    probe = here
    for _ in range(8):
        if os.path.isfile(os.path.join(probe, "VERSION")) and \
                os.path.isdir(os.path.join(probe, "autonomy")):
            return probe
        parent = os.path.dirname(probe)
        if parent == probe:
            break
        probe = parent
    # Fallback: benchmarks/bench/adapters -> repo is three levels up.
    return os.path.dirname(os.path.dirname(os.path.dirname(here)))


def load_efficiency_cost():
    """Import the shared efficiency_cost module, bootstrapping sys.path.

    Returns the module, or None if it cannot be loaded. Never raises: a
    benchmark adapter that cannot price tokens reports cost_usd=null rather
    than crashing.
    """
    lib_dir = os.path.join(_repo_root(), "autonomy", "lib")
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    try:
        import efficiency_cost  # noqa: E402
        return efficiency_cost
    except Exception:
        return None


def build_output(*, tool, tool_version, model_used, duration_s, iterations,
                 tokens_in, tokens_out, cost_usd, exit_status, provenance,
                 **ignored):
    """Construct the canonical adapter-output dict.

    success/quality and any other forbidden key passed via **ignored are
    silently dropped: an adapter structurally cannot emit them.
    """
    out = {
        "tool": str(tool),
        "tool_version": (str(tool_version) if tool_version is not None else None),
        "model_used": (str(model_used) if model_used is not None else None),
        "duration_s": (float(duration_s) if duration_s is not None else None),
        "iterations": (int(iterations) if iterations is not None else None),
        "tokens_in": (int(tokens_in) if tokens_in is not None else None),
        "tokens_out": (int(tokens_out) if tokens_out is not None else None),
        "cost_usd": (float(cost_usd) if cost_usd is not None else None),
        "exit_status": str(exit_status),
        "provenance": provenance if isinstance(provenance, dict) else {},
    }
    # Defense in depth: never let a forbidden key survive into the output.
    for k in FORBIDDEN_ADAPTER_KEYS:
        out.pop(k, None)
    return out


def run_cli(cmd, *, cwd, timeout, runner=None, env=None):
    """Run a CLI command headless and return (rc, stdout, stderr, duration_s).

    runner is an injectable subprocess.run-compatible callable so tests can
    mock the CLI without live keys. Done inside this function (never at module
    import time) so importing an adapter never spawns a process.
    """
    _run = runner or subprocess.run
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    start = time.time()
    try:
        proc = _run(
            cmd, cwd=cwd, capture_output=True, text=True,
            timeout=timeout, env=full_env,
        )
        rc = getattr(proc, "returncode", 1)
        out = getattr(proc, "stdout", "") or ""
        err = getattr(proc, "stderr", "") or ""
        status = "completed" if rc == 0 else ("error_rc_%d" % rc)
    except subprocess.TimeoutExpired:
        rc, out, err, status = 124, "", "timeout", "timeout"
    except FileNotFoundError:
        # CLI not installed on PATH. Honest: not an error in the run, the tool
        # is simply absent. Report it so the report can render "tool absent".
        rc, out, err, status = 127, "", "cli_not_found", "cli_not_found"
    except Exception as exc:  # noqa: BLE001
        rc, out, err, status = 1, "", str(exc), "adapter_error"
    duration = round(time.time() - start, 3)
    return rc, out, err, status, duration
