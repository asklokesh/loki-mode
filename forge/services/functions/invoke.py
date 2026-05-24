"""Function invocation harness.

Spawns the runtime as a subprocess with the active version's source on
stdin-redirect. The request payload is passed via env (FORGE_REQ_JSON
for small payloads) plus stdin (for arbitrary size). The response is
captured from stdout; logs from stderr.

Resource limits applied:
    - timeout from manifest.timeout_ms
    - memory cap via setrlimit on Linux (best-effort; macOS approximate)
    - working directory pinned to the version's vdir so functions
      cannot scribble on each other's storage

The MVP shells out to `bun run`, `deno run`, or `python3`. The Bun
warm-pool optimization lands in F-2.16 (a long-running worker that
multiplexes JSON requests over stdin/stdout).
"""

from __future__ import annotations

import json
import os
import resource
import subprocess
import sys
import time
import uuid
from typing import Any, Dict, Optional, Tuple

from .deploy import (
    FunctionError, get_function, source_path, verify_signature,
    _fn_dir, _utc_iso,
)


def _runtime_argv(runtime: str, src: str) -> list:
    if runtime == "bun":
        return ["bun", "run", src]
    if runtime == "deno":
        return ["deno", "run", "--allow-env", "--no-prompt", src]
    if runtime == "python":
        return ["python3", src]
    raise FunctionError(f"unsupported runtime: {runtime}")


def _set_limits(memory_mb: int) -> None:
    """Apply rlimits in the child process. Linux-specific best-effort."""
    try:
        resource.setrlimit(
            resource.RLIMIT_AS,
            (memory_mb * 1024 * 1024, memory_mb * 1024 * 1024),
        )
    except (ValueError, OSError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    except (ValueError, OSError):
        pass
    try:
        resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))
    except (ValueError, OSError):
        pass


def warm(forge_dir: str, name: str,
         version: Optional[int] = None) -> Dict[str, Any]:
    """X-68: pre-warm the runtime so the first invoke skips cold start.

    For Bun/Deno: opens the source path and primes the OS file cache.
    For Python: imports the source as a no-op module to warm the
    bytecode cache.
    Returns {ok, warmed, duration_ms} regardless of runtime.
    """
    m = get_function(forge_dir, name)
    if not m:
        return {"ok": False, "error": "function_not_found", "warmed": False}
    # N-29: respect manifest warm_disabled so cost-sensitive operators
    # can skip the warm pre-touch on functions where the cold start
    # is acceptable. Returns a structured skip result so the metrics
    # counter (N-15) does not increment.
    if m.get("warm_disabled") is True:
        return {"ok": True, "warmed": False, "skipped": True,
                "reason": "warm_disabled",
                "runtime": m.get("runtime", "bun")}
    src = source_path(forge_dir, name, version=version)
    if not src:
        return {"ok": False, "error": "source_missing", "warmed": False}
    t0 = time.time()
    try:
        # Touch the file - this is cheap and works for all 3 runtimes.
        with open(src, "rb") as f:
            f.read()
        # Bun + Deno also benefit from a syntax-only parse via the
        # runtime binary. Best-effort, no failure mode.
        runtime = m.get("runtime", "bun")
        if runtime == "bun":
            import subprocess as _sp
            try:
                _sp.run(["bun", "build", "--no-bundle", "--target=node",
                         src, "--outdir", "/dev/null"],
                        capture_output=True, timeout=5, check=False)
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass
        # N-15: persist a warm counter on the manifest so the metrics
        # render() can emit forge_function_warm_total{name="..."} and
        # operators can see how often the warm-pool actually saved a
        # cold start. Best-effort; failures here never block warm().
        try:
            manifest_path = os.path.join(_fn_dir(forge_dir, name),
                                          "manifest.json")
            if os.path.exists(manifest_path):
                with open(manifest_path, "r", encoding="utf-8") as mf:
                    mani = json.load(mf)
                mani["warm_count"] = int(mani.get("warm_count", 0)) + 1
                mani["last_warm_at"] = _utc_iso()
                tmp = manifest_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as mf:
                    json.dump(mani, mf, indent=2, sort_keys=True)
                os.replace(tmp, manifest_path)
        except Exception:
            pass
        return {"ok": True, "warmed": True,
                "duration_ms": int((time.time() - t0) * 1000),
                "runtime": runtime}
    except Exception as e:
        return {"ok": False, "error": str(e), "warmed": False}


def invoke(forge_dir: str, name: str, payload: Optional[Dict[str, Any]] = None,
           version: Optional[int] = None,
           env_overrides: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Invoke a function synchronously. Returns
    {ok, exit_code, stdout, stderr, duration_ms, run_id, version}.
    """
    m = get_function(forge_dir, name)
    if not m:
        raise FunctionError(f"function not found: {name}")
    src = source_path(forge_dir, name, version=version)
    if not src:
        raise FunctionError(f"source not found for {name} v{version}")
    # N-07: verify the deploy-time HMAC signature against the on-disk
    # source bytes before spawning the runtime. A mismatch means the
    # source file was modified after deploy; refuse to execute. Legacy
    # versions with no recorded signature pass through (verify_signature
    # returns ok=True signature_present=False) so this stays back-compat.
    vsig = verify_signature(forge_dir, name, version=version)
    if not vsig.get("ok"):
        raise FunctionError(
            f"function {name} v{vsig.get('version')} signature "
            f"verification failed: {vsig.get('reason')}"
        )
    # N-21: preserve the verify result so callers can see whether the
    # invocation ran against a signed or legacy-unsigned version.
    signature_info = {
        "verified": vsig.get("reason") == "verified",
        "signature_present": vsig.get("signature_present", False),
    }
    runtime = m.get("runtime", "bun")
    timeout_s = max(0.1, m.get("timeout_ms", 10000) / 1000.0)
    memory_mb = m.get("memory_mb", 128)
    payload = payload or {}

    # Build env: a minimal allowlist plus user-declared env_secrets.
    env: Dict[str, str] = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": "/tmp",
        "FORGE_FUNCTION_NAME": name,
        "FORGE_FUNCTION_VERSION": str(m.get("active_version", "?")),
        "FORGE_REQ_JSON": json.dumps(payload, separators=(",", ":")),
    }
    for secret_ref in m.get("env_secrets", []):
        val = (env_overrides or {}).get(secret_ref, os.environ.get(secret_ref))
        if val is not None:
            env[secret_ref] = val
    if env_overrides:
        for k, v in env_overrides.items():
            # Only forward keys explicitly declared by the function.
            if k in m.get("env_secrets", []):
                env[k] = v

    run_id = uuid.uuid4().hex
    log_dir = os.path.join(_fn_dir(forge_dir, name), "logs")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, f"{run_id}.json")

    started = time.time()
    try:
        proc = subprocess.run(
            _runtime_argv(runtime, src),
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=timeout_s,
            cwd=os.path.dirname(src),
            env=env,
            preexec_fn=(lambda: _set_limits(memory_mb)) if sys.platform != "win32" else None,
        )
        duration_ms = int((time.time() - started) * 1000)
        result = {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
            "duration_ms": duration_ms,
            "run_id": run_id,
            "version": m.get("active_version"),
        }
    except subprocess.TimeoutExpired as e:
        duration_ms = int((time.time() - started) * 1000)
        result = {
            "ok": False,
            "exit_code": -1,
            "stdout": (e.stdout or b"").decode("utf-8", errors="replace")
                      if isinstance(e.stdout, bytes) else (e.stdout or ""),
            "stderr": "TimeoutExpired",
            "duration_ms": duration_ms,
            "run_id": run_id,
            "version": m.get("active_version"),
            "error": "timeout",
        }
    except FileNotFoundError as e:
        # Runtime binary missing (bun / deno / python3).
        result = {
            "ok": False,
            "exit_code": -1,
            "stdout": "",
            "stderr": f"runtime not available: {e}",
            "duration_ms": int((time.time() - started) * 1000),
            "run_id": run_id,
            "version": m.get("active_version"),
            "error": "runtime_missing",
        }

    # Persist a structured run log.
    log_entry = {
        "run_id": run_id,
        "function": name,
        "version": result.get("version"),
        "started_at": _utc_iso(),
        "duration_ms": result.get("duration_ms"),
        "ok": result.get("ok"),
        "exit_code": result.get("exit_code"),
        "stderr_head": (result.get("stderr") or "")[:1024],
        "error": result.get("error"),
    }
    with open(log_path, "w", encoding="utf-8") as f:
        json.dump(log_entry, f)

    # X-84: surface the most recent timeout on the function manifest so
    # `forge diagnose` and dashboard surfaces can warn about a function
    # that's chronically slow. Best-effort; never blocks the response.
    # (_fn_dir is already imported at module top - re-importing here
    # would shadow it as a local and trigger UnboundLocalError above.)
    if result.get("error") == "timeout":
        try:
            manifest_path = os.path.join(_fn_dir(forge_dir, name),
                                          "manifest.json")
            if os.path.exists(manifest_path):
                with open(manifest_path, "r", encoding="utf-8") as mf:
                    mani = json.load(mf)
                mani["last_timeout_ms"] = result.get("duration_ms")
                mani["last_timeout_at"] = _utc_iso()
                mani["timeout_count"] = int(mani.get("timeout_count", 0)) + 1
                tmp = manifest_path + ".tmp"
                with open(tmp, "w", encoding="utf-8") as mf:
                    json.dump(mani, mf, indent=2, sort_keys=True)
                os.replace(tmp, manifest_path)
        except Exception:
            pass
    # N-21: attach the signature verification result to the response.
    result["signature"] = signature_info
    return result
