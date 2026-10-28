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
import re
import signal
import subprocess
import sys
import threading
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
                 cache_read_tokens=None, cache_creation_tokens=None,
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
    # Omitted (not zeroed) when unknown so normalize_adapter_output keeps its
    # default; before this pass-through the keys were swallowed by **ignored and
    # every adapter row recorded cache_read_tokens 0 whatever the run read.
    for k, v in (("cache_read_tokens", cache_read_tokens),
                 ("cache_creation_tokens", cache_creation_tokens)):
        if isinstance(v, int) and not isinstance(v, bool):
            out[k] = v
    # Defense in depth: never let a forbidden key survive into the output.
    for k in FORBIDDEN_ADAPTER_KEYS:
        out.pop(k, None)
    return out


def _run_reapable(cmd, cwd, timeout, full_env, stdin=None):
    """Run cmd so that a timeout kills the WHOLE process tree, not just the child.

    WHY: subprocess.run(timeout=...) kills only the process it spawned.
    `loki start` re-execs as /tmp/loki-run-*.sh and spawns its own descendants,
    so a timed-out cell left that tree ALIVE and still holding provider
    capacity. Measured: a stopped matrix leaked SEVEN live loki-bench-loki-*
    runs that survived over an hour, starved later trials into their own 600s
    timeouts, and made clean runs look like they "died immediately". A timeout
    that does not reap manufactures the very failure it reports.

    start_new_session puts the child in its own process group, so killing the
    group reaches every descendant. TERM first (let the engine flush state),
    then KILL what remains. Raises TimeoutExpired like subprocess.run does, so
    the caller's handling is unchanged.
    """
    proc = subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=full_env, start_new_session=True, stdin=stdin,
    )
    try:
        out, err = proc.communicate(timeout=timeout)
        return proc.returncode, out or "", err or ""
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        # Drain whatever was produced so the pipes close; the caller discards
        # it (a timed-out run reports status="timeout", not partial output).
        try:
            proc.communicate(timeout=10)
        except Exception:  # noqa: BLE001 - never mask the timeout itself
            pass
        raise


def _run_until(cmd, cwd, timeout, full_env, stop_marker, stop_after_s,
               stdin=None):
    """Like _run_reapable, but stop the process group early at a deterministic
    point: the first stdout line matching the regex `stop_marker`, or
    `stop_after_s` seconds, whichever comes first. Returns
    (rc, out, err, interrupted); out holds everything read up to the stop.
    Raises TimeoutExpired past `timeout`, like _run_reapable."""
    proc = subprocess.Popen(
        cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, env=full_env, start_new_session=True, stdin=stdin,
    )
    lines, hit = [], threading.Event()
    pat = re.compile(stop_marker) if stop_marker else None

    def _read():
        for line in proc.stdout:
            lines.append(line)
            if pat is not None and pat.search(line):
                hit.set()
                return
    err_chunks = []

    def _drain_err():
        # A child that logs >64KB to stderr before the marker would otherwise
        # block on the full pipe and never reach it (a false timeout).
        try:
            for chunk in proc.stderr:
                err_chunks.append(chunk)
        except Exception:  # noqa: BLE001
            pass
    reader = threading.Thread(target=_read, daemon=True)
    err_reader = threading.Thread(target=_drain_err, daemon=True)
    reader.start()
    err_reader.start()
    started = time.time()
    interrupted = False
    while proc.poll() is None:
        if hit.is_set() or (stop_after_s is not None
                            and time.time() - started >= stop_after_s):
            interrupted = True
            break
        if time.time() - started >= timeout:
            _kill_group(proc)
            raise subprocess.TimeoutExpired(cmd, timeout)
        time.sleep(0.05)
    if interrupted:
        _kill_group(proc)
    reader.join(timeout=5)
    err_reader.join(timeout=5)
    return proc.wait(), "".join(lines), "".join(err_chunks), interrupted


def _kill_group(proc):
    """TERM then KILL the process group led by proc. Best-effort, never raises."""
    try:
        pgid = os.getpgid(proc.pid)
    except OSError:
        return  # already gone
    for sig, grace in ((signal.SIGTERM, 5.0), (signal.SIGKILL, 0.0)):
        try:
            os.killpg(pgid, sig)
        except OSError:
            return  # group is gone; nothing left to signal
        if grace:
            deadline = time.time() + grace
            while time.time() < deadline:
                if proc.poll() is not None:
                    return
                time.sleep(0.1)


def run_cli(cmd, *, cwd, timeout, runner=None, env=None,
            stop_marker=None, stop_after_s=None, stdin_devnull=False):
    """Run a CLI command headless and return (rc, stdout, stderr, duration_s).

    PWD is set to cwd: a child launched with cwd= still inherits the parent's
    PWD, and tools that read $PWD (not getcwd) then work in the wrong tree.
    stdin_devnull=True gives the child /dev/null instead of the parent's stdin.

    runner is an injectable subprocess.run-compatible callable so tests can
    mock the CLI without live keys. Done inside this function (never at module
    import time) so importing an adapter never spawns a process.
    """
    full_env = dict(os.environ)
    if env:
        full_env.update(env)
    if cwd:
        full_env["PWD"] = os.path.abspath(cwd)
    stdin = subprocess.DEVNULL if stdin_devnull else None
    start = time.time()
    interrupted = False
    try:
        if runner is not None:
            # Injected fake (tests). Keep the subprocess.run contract exactly:
            # the mock path must not gain kwargs it does not accept.
            proc = runner(
                cmd, cwd=cwd, capture_output=True, text=True,
                timeout=timeout, env=full_env,
            )
            rc = getattr(proc, "returncode", 1)
            out = getattr(proc, "stdout", "") or ""
            err = getattr(proc, "stderr", "") or ""
            # The fake finished already; cut its output at the stop point so a
            # test sees exactly what a live early stop would have produced.
            if stop_marker:
                m = re.search(stop_marker, out, re.M)
                if m:
                    out, rc, interrupted = out[:m.end()], -15, True
            elif stop_after_s is not None:
                rc, interrupted = -15, True
        elif stop_marker or stop_after_s is not None:
            rc, out, err, interrupted = _run_until(
                cmd, cwd, timeout, full_env, stop_marker, stop_after_s, stdin)
        else:
            rc, out, err = _run_reapable(cmd, cwd, timeout, full_env, stdin)
        status = ("interrupted" if interrupted else
                  "completed" if rc == 0 else ("error_rc_%d" % rc))
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
