#!/usr/bin/env python3
"""benchmarks/bench/runner.py -- shared python core for the R2 benchmark harness.

One implementation, both routes (bash `loki bench` and any future caller). Given
a task-spec and an adapter name it:

  1. loads + validates the task-spec,
  2. for each of N trials:
       a. copies the fixture into a fresh mktemp workdir,
       b. invokes the named adapter on the workdir (with a wall-clock timeout),
       c. GRADES: runs the held-out acceptance command IN the workdir and sets
          success = (exit code == 0); optionally measures lint/tests as quality,
       d. lifts cost + provenance from the adapter-output,
  3. assembles a result-row (schema_version, task_id/path/hash, trials, summary).

CREDIBILITY INVARIANT (enforced here):
  - The grader is the ONLY thing that sets trial.success / trial.quality.
  - The adapter is validated with validate_adapter_output(), which REJECTS any
    judgment key. An adapter that tries to report its own success is refused.
  - No council / RARV-C / LLM-judge participates in scoring.

Cost: the loki adapter (Slice C) collects cost via the shared module
autonomy/lib/efficiency_cost.py::_collect_efficiency(loki_dir). This runner also
exposes collect_efficiency(loki_dir) for adapters/tests: it prefers the shared
module and FALLS BACK to loading proof-generator.py by file path (its hyphenated
name blocks a normal import). Both paths return proof-generator's exact cost
shape, preserving usd=None ("not collected") semantics.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from typing import Any, Callable, Dict, List, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(os.path.dirname(_HERE))

if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import bench_schema as schema  # noqa: E402


# ---------------------------------------------------------------------------
# cost collection (shared module preferred, proof-generator fallback)
# ---------------------------------------------------------------------------

def collect_efficiency(loki_dir: str) -> Tuple[Dict[str, Any], str]:
    """Return (cost_dict, model). Same shape as proof-generator._collect_efficiency.

    Prefers autonomy/lib/efficiency_cost.py (the shared module created by the
    adapters agent / Slice C). Falls back to loading proof-generator.py by path
    when that module is not present yet. cost["usd"] is None when nothing was
    collected -- never coerced to 0.
    """
    # 1. Preferred: the shared module.
    lib_dir = os.path.join(_REPO, "autonomy", "lib")
    shared = os.path.join(lib_dir, "efficiency_cost.py")
    if os.path.isfile(shared):
        if lib_dir not in sys.path:
            sys.path.insert(0, lib_dir)
        try:
            mod = importlib.import_module("efficiency_cost")
            fn = getattr(mod, "_collect_efficiency", None) or getattr(mod, "collect_efficiency", None)
            if fn is not None:
                return fn(loki_dir)
        except Exception:
            pass  # fall through to proof-generator

    # 2. Fallback: load proof-generator.py by path (hyphen blocks normal import).
    pg_path = os.path.join(lib_dir, "proof-generator.py")
    if os.path.isfile(pg_path):
        try:
            spec = importlib.util.spec_from_file_location("_loki_proof_generator", pg_path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)  # type: ignore[union-attr]
            fn = getattr(mod, "_collect_efficiency", None)
            if fn is not None:
                return fn(loki_dir)
        except Exception:
            pass

    # 3. Nothing available: honest "not collected".
    return ({
        "usd": None,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
    }, "")


# ---------------------------------------------------------------------------
# task-spec loading
# ---------------------------------------------------------------------------

def load_task(task_path: str) -> Dict[str, Any]:
    """Load + validate a task-spec JSON file. Raises ValueError on problems."""
    with open(task_path, "r") as fh:
        spec = json.load(fh)
    errs = schema.validate_task_spec(spec)
    if errs:
        raise ValueError("invalid task-spec %s: %s" % (task_path, "; ".join(errs)))
    return spec


def resolve_fixture_dir(task_path: str, spec: Dict[str, Any]) -> str:
    """Resolve spec.fixture relative to the task-spec file's directory."""
    base = os.path.dirname(os.path.abspath(task_path))
    return os.path.realpath(os.path.join(base, spec["fixture"]))


def _store_task_path(task_path: str) -> str:
    """Path to record in a result-row. Repo-relative when inside the repo (so a
    cloned checkout can relocate it), absolute otherwise.
    """
    abspath = os.path.abspath(task_path)
    try:
        rel = os.path.relpath(abspath, _REPO)
    except ValueError:
        return abspath  # different drive (Windows); keep absolute
    # If the task lives outside the repo tree, relpath starts with "..": keep abs.
    if rel.startswith(".."):
        return abspath
    return rel.replace(os.sep, "/")


def _resolve_task_path(stored: str) -> str:
    """Inverse of _store_task_path: locate the task-spec on this machine.

    A repo-relative path resolves against the current repo root; an absolute
    path is used as-is. This is what makes `loki bench verify` work for a
    stranger who cloned the repo to a different location.
    """
    if os.path.isabs(stored):
        return stored
    candidate = os.path.join(_REPO, stored)
    if os.path.isfile(candidate):
        return candidate
    # Fall back to cwd-relative (ad-hoc results produced outside the repo).
    return os.path.abspath(stored)


# ---------------------------------------------------------------------------
# workdir preparation
# ---------------------------------------------------------------------------

def prepare_workdir(fixture_dir: str, tool: str) -> str:
    """Copy the fixture into a fresh mktemp workdir. Returns the workdir path."""
    workdir = tempfile.mkdtemp(prefix="loki-bench-%s-" % tool)
    if os.path.isdir(fixture_dir):
        # Copy contents of the fixture into workdir (workdir already exists).
        for name in os.listdir(fixture_dir):
            src = os.path.join(fixture_dir, name)
            dst = os.path.join(workdir, name)
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
    return workdir


# ---------------------------------------------------------------------------
# the GRADER -- the ONLY thing that decides success
# ---------------------------------------------------------------------------

def _run_cmd(cmd: str, cwd: str, timeout_s: int) -> int:
    """Run a shell command in cwd with a timeout. Returns exit code (124 on TO)."""
    try:
        proc = subprocess.run(
            cmd, cwd=cwd, shell=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=timeout_s,
        )
        return proc.returncode
    except subprocess.TimeoutExpired:
        return 124
    except Exception:
        return 1


def _apply_overlay(workdir: str, overlay_dir: str) -> None:
    """Copy held-out test files from overlay_dir INTO workdir, overwriting.

    Applied by the grader AFTER the agent finishes, so the agent never saw and
    could not tamper with the held-out tests (the SWE-bench test-patch pattern).
    """
    for root, dirs, files in os.walk(overlay_dir):
        for d in dirs:
            src = os.path.join(root, d)
            rel = os.path.relpath(src, overlay_dir)
            os.makedirs(os.path.join(workdir, rel), exist_ok=True)
        for f in files:
            src = os.path.join(root, f)
            rel = os.path.relpath(src, overlay_dir)
            dst = os.path.join(workdir, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)


def grade(workdir: str, spec: Dict[str, Any],
          task_dir: Optional[str] = None) -> Dict[str, Any]:
    """Run the held-out acceptance command IN workdir. success = exit == 0.

    If acceptance.overlay is set, the grader copies those held-out test files
    INTO the workdir first (the agent never saw them, so it cannot edit the test
    to pass). If acceptance.setup_cmd is set, it runs after the overlay and
    before cmd; its exit code is NON-gating (deps/build only).

    Also measures OPTIONAL quality signals (lint / tests). quality is
    NON-GATING. Returns:
      {success: bool, acceptance_exit_code: int,
       quality: {lint_ok: bool|None, tests_ok: bool|None}}

    This function deliberately receives ONLY workdir + spec (+ task_dir to
    resolve the overlay path). It never sees adapter-output. That structural
    separation is the credibility guarantee.
    """
    acc = spec["acceptance"]
    timeout_s = int(acc.get("timeout_s", 300))

    # Held-out test overlay: copy in tests the agent never saw, then optionally
    # run a non-gating setup command.
    overlay = acc.get("overlay")
    if isinstance(overlay, str) and overlay.strip() and task_dir:
        overlay_dir = os.path.realpath(os.path.join(task_dir, overlay))
        if os.path.isdir(overlay_dir):
            _apply_overlay(workdir, overlay_dir)
    setup_cmd = acc.get("setup_cmd")
    if isinstance(setup_cmd, str) and setup_cmd.strip():
        _run_cmd(setup_cmd, workdir, timeout_s)  # non-gating

    exit_code = _run_cmd(acc["cmd"], workdir, timeout_s)
    success = (exit_code == 0)

    quality: Dict[str, Any] = {"lint_ok": None, "tests_ok": None}
    q = spec.get("quality") or {}
    lint_cmd = q.get("lint_cmd")
    test_cmd = q.get("test_cmd")
    if isinstance(lint_cmd, str) and lint_cmd.strip():
        quality["lint_ok"] = (_run_cmd(lint_cmd, workdir, timeout_s) == 0)
    if isinstance(test_cmd, str) and test_cmd.strip():
        quality["tests_ok"] = (_run_cmd(test_cmd, workdir, timeout_s) == 0)

    return {
        "success": success,
        "acceptance_exit_code": exit_code,
        "quality": quality,
    }


# ---------------------------------------------------------------------------
# adapter loading + invocation
# ---------------------------------------------------------------------------

# An adapter module exposes (Slice C call convention):
#   run(workdir, spec, *, model="...", timeout=N, runner=None) -> dict
# where `spec` is a PATH to a prompt/message file inside the workdir (NOT the
# task-spec dict; the word collides). The runner materializes task_spec["prompt"]
# into PROMPT_FILENAME in the workdir and passes that path. The return value is
# an adapter-output, validated by schema.validate_adapter_output before use.
#
# manual.py is special: run(workdir=None, spec=None, *, manual_entry=, tool=) --
# it records externally-supplied numbers and is NOT invoked through this uniform
# path (default VS_TOOLS keeps it off the hot path).

PROMPT_FILENAME = "BENCH_PROMPT.md"


def load_adapter(name: str) -> Callable[..., Dict[str, Any]]:
    """Load benchmarks/bench/adapters/<name>.py and return its run() callable.

    Adapters are produced by Slice C. This loader only needs them to exist and
    expose a module-level run() function with the documented signature.
    """
    adapters_dir = os.path.join(_HERE, "adapters")
    path = os.path.join(adapters_dir, "%s.py" % name)
    if not os.path.isfile(path):
        raise FileNotFoundError("adapter not found: %s (expected %s)" % (name, path))
    # Adapters fall back to a flat `import _base` when not imported as a package,
    # so the adapters dir must be importable.
    if adapters_dir not in sys.path:
        sys.path.insert(0, adapters_dir)
    spec = importlib.util.spec_from_file_location("_bench_adapter_%s" % name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    fn = getattr(mod, "run", None)
    if not callable(fn):
        raise AttributeError("adapter %s has no callable run()" % name)
    return fn


def materialize_prompt(workdir: str, spec: Dict[str, Any]) -> str:
    """Write task_spec['prompt'] into the workdir and return the file path.

    Adapters consume `spec` as a path to a prompt/message file (loki start <f>,
    aider --message-file <f>, claude -p path). This bridges the task-spec dict
    (Slice A/B world) to the path-based adapter call convention (Slice C world).
    """
    prompt_path = os.path.join(workdir, PROMPT_FILENAME)
    with open(prompt_path, "w") as fh:
        fh.write(spec.get("prompt", ""))
    return prompt_path


def invoke_adapter(adapter: Callable[..., Dict[str, Any]],
                   workdir: str, spec: Dict[str, Any], model: str,
                   timeout_s: int, runner_fn: Any = None) -> Dict[str, Any]:
    """Call an adapter and validate its output. Raises ValueError if it judges.

    Uses the Slice C adapter call convention: run(workdir, prompt_path, *,
    model=, timeout=, runner=). The task-spec's prompt is materialized to a file
    inside workdir and its path is passed as the adapter's `spec` argument.

    Enforces the hard boundary: an adapter-output carrying any forbidden
    judgment key (success/quality/passed/score/...) is rejected here, before it
    can pollute scoring.
    """
    prompt_path = materialize_prompt(workdir, spec)
    kwargs: Dict[str, Any] = {"model": model, "timeout": timeout_s}
    if runner_fn is not None:
        kwargs["runner"] = runner_fn
    out = adapter(workdir, prompt_path, **kwargs)
    errs = schema.validate_adapter_output(out)
    if errs:
        raise ValueError("adapter returned invalid output: %s" % "; ".join(errs))
    return schema.normalize_adapter_output(out)


# ---------------------------------------------------------------------------
# trial + run orchestration
# ---------------------------------------------------------------------------

def run_trial(adapter: Callable[..., Dict[str, Any]],
              spec: Dict[str, Any], fixture_dir: str, model: str,
              tool: str, trial_index: int,
              keep_workdir: bool = False,
              runner_fn: Any = None,
              task_dir: Optional[str] = None) -> Dict[str, Any]:
    """One trial: prepare workdir, invoke adapter, GRADE, assemble trial record."""
    agent_timeout = int(spec.get("agent_timeout_s", 1800))
    workdir = prepare_workdir(fixture_dir, tool)
    try:
        adapter_out = invoke_adapter(adapter, workdir, spec, model,
                                     agent_timeout, runner_fn=runner_fn)
        # GRADE on the produced repo state. Grader sees workdir + spec (+ the
        # task dir to resolve a held-out overlay); never adapter-output.
        verdict = grade(workdir, spec, task_dir=task_dir)
        cost_usd = adapter_out.get("cost_usd")
        return {
            "trial": trial_index,
            "success": verdict["success"],
            "quality": verdict["quality"],
            "acceptance_exit_code": verdict["acceptance_exit_code"],
            "adapter": adapter_out,
            "cost_usd": cost_usd,
            "duration_s": adapter_out.get("duration_s"),
        }
    finally:
        if not keep_workdir:
            shutil.rmtree(workdir, ignore_errors=True)


def run_task(task_path: str, adapter_name: str, *,
             trials: int = 3, model: Optional[str] = None,
             adapter: Optional[Callable[..., Dict[str, Any]]] = None,
             keep_workdir: bool = False,
             runner_fn: Any = None) -> Dict[str, Any]:
    """Run a full task: N trials of one adapter, assemble + validate a result-row.

    `adapter` may be passed directly (used by tests with a mock); otherwise the
    named adapter module is loaded from benchmarks/bench/adapters/<name>.py.
    """
    spec = load_task(task_path)
    fixture_dir = resolve_fixture_dir(task_path, spec)
    task_dir = os.path.dirname(os.path.abspath(task_path))
    task_hash = schema.compute_task_hash(spec, fixture_dir)
    used_model = model or spec.get("default_model", "")

    if adapter is None:
        adapter = load_adapter(adapter_name)

    trial_rows: List[Dict[str, Any]] = []
    for i in range(1, max(1, trials) + 1):
        trial_rows.append(run_trial(
            adapter, spec, fixture_dir, used_model, adapter_name, i,
            keep_workdir=keep_workdir, runner_fn=runner_fn, task_dir=task_dir,
        ))

    row = {
        "schema_version": schema.SCHEMA_VERSION,
        "task_id": spec["id"],
        # Store repo-relative so a third party who clones elsewhere can still
        # `loki bench verify` (reproducibility is the #1 credibility rule). Tasks
        # outside the repo fall back to an absolute path.
        "task_path": _store_task_path(task_path),
        "task_hash": task_hash,
        "tool": adapter_name,
        "model": used_model,
        "trials": trial_rows,
        "summary": schema.summarize_trials(trial_rows),
    }
    errs = schema.validate_result_row(row)
    if errs:
        raise ValueError("assembled result-row invalid: %s" % "; ".join(errs))
    return row


# ---------------------------------------------------------------------------
# verify -- recompute task_hash + check tool versions
# ---------------------------------------------------------------------------

def verify_result(result_path: str) -> Dict[str, Any]:
    """Recompute task_hash from inputs on disk and re-check tool versions.

    Returns a report:
      {ok: bool, task_id, stored_hash, recomputed_hash, hash_match: bool,
       version_checks: [{tool, stored, current, match}], problems: [...]}
    """
    with open(result_path, "r") as fh:
        row = json.load(fh)

    problems: List[str] = []
    rerrs = schema.validate_result_row(row)
    problems.extend(rerrs)

    stored_task_path = row.get("task_path", "")
    task_path = _resolve_task_path(stored_task_path) if stored_task_path else ""
    stored_hash = row.get("task_hash", "")
    recomputed_hash = ""
    hash_match = False
    if not task_path or not os.path.isfile(task_path):
        problems.append("cannot relocate task-spec at task_path: %r" % stored_task_path)
    else:
        try:
            spec = load_task(task_path)
            fixture_dir = resolve_fixture_dir(task_path, spec)
            recomputed_hash = schema.compute_task_hash(spec, fixture_dir)
            hash_match = (recomputed_hash == stored_hash)
            if not hash_match:
                problems.append("task_hash mismatch: inputs on disk differ from the recorded run")
        except Exception as exc:
            problems.append("failed to recompute task_hash: %s" % exc)

    # Tool version re-check (best effort; absence of a tool is a problem note,
    # not a crash). Each adapter records tool_version per trial.
    version_checks: List[Dict[str, Any]] = []
    seen: Dict[str, str] = {}
    for t in row.get("trials", []):
        ad = t.get("adapter") or {}
        tool = ad.get("tool")
        ver = ad.get("tool_version")
        if tool and tool not in seen:
            seen[tool] = ver
    for tool, stored_ver in seen.items():
        current = _current_tool_version(tool)
        match = (current is not None and stored_ver is not None and current == stored_ver)
        version_checks.append({
            "tool": tool, "stored": stored_ver,
            "current": current, "match": match,
        })
        if current is None:
            problems.append("tool %r not found on PATH for version re-check" % tool)
        elif not match:
            problems.append("tool %r version drift: recorded %r, current %r"
                            % (tool, stored_ver, current))

    return {
        "ok": (len(problems) == 0),
        "task_id": row.get("task_id", ""),
        "stored_hash": stored_hash,
        "recomputed_hash": recomputed_hash,
        "hash_match": hash_match,
        "version_checks": version_checks,
        "problems": problems,
    }


def _current_tool_version(tool: str) -> Optional[str]:
    """Best-effort current version string for a tool, or None if unavailable."""
    cmds = {
        "loki": ["loki", "version"],
        "aider": ["aider", "--version"],
        "claude_code": ["claude", "--version"],
        "claude": ["claude", "--version"],
        "manual": None,  # externally supplied; nothing to query
    }
    argv = cmds.get(tool)
    if argv is None:
        return None
    if shutil.which(argv[0]) is None:
        return None
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=20)
        text = (out.stdout or out.stderr or "").strip()
        return text.splitlines()[0].strip() if text else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# CLI (invoked by benchmarks/bench/run.sh)
# ---------------------------------------------------------------------------

def _main(argv: List[str]) -> int:
    import argparse
    p = argparse.ArgumentParser(prog="bench-runner", description="R2 benchmark runner core")
    sub = p.add_subparsers(dest="cmd")

    pr = sub.add_parser("run", help="run one adapter on one task")
    pr.add_argument("task")
    pr.add_argument("--adapter", default="loki")
    pr.add_argument("--trials", type=int, default=3)
    pr.add_argument("--model", default=None)
    pr.add_argument("--out", default=None)
    pr.add_argument("--keep-workdir", action="store_true")

    pv = sub.add_parser("verify", help="recompute task_hash + check tool versions")
    pv.add_argument("result")

    pl = sub.add_parser("validate-task", help="validate a task-spec file")
    pl.add_argument("task")

    args = p.parse_args(argv)

    if args.cmd == "run":
        row = run_task(args.task, args.adapter, trials=args.trials,
                       model=args.model, keep_workdir=args.keep_workdir)
        payload = json.dumps(row, indent=2, sort_keys=True)
        if args.out:
            with open(args.out, "w") as fh:
                fh.write(payload + "\n")
            print("wrote %s" % args.out)
        else:
            print(payload)
        return 0

    if args.cmd == "verify":
        report = verify_result(args.result)
        print(json.dumps(report, indent=2, sort_keys=True))
        return 0 if report["ok"] else 1

    if args.cmd == "validate-task":
        spec = json.load(open(args.task))
        errs = schema.validate_task_spec(spec)
        if errs:
            print("INVALID: " + "; ".join(errs))
            return 1
        print("OK: %s" % spec.get("id", "<no id>"))
        return 0

    p.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
