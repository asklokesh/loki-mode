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

import hashlib
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

def prepare_workdir(fixture_dir: str, tool: str, dest: Optional[str] = None) -> str:
    """Copy the fixture into a fresh mktemp workdir (or into the empty `dest`).
    Returns the workdir path."""
    if dest:
        if os.path.isdir(dest) and os.listdir(dest):
            raise ValueError("kept workdir already exists and is not empty: %s "
                             "(use an empty LOKI_BENCH_WORKDIRS root per grid)" % dest)
        os.makedirs(dest, exist_ok=True)
        workdir = dest
    else:
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
    _git_baseline(workdir)
    return workdir


def _git_baseline(workdir: str) -> None:
    """Commit the copied fixture as a git baseline. loki start (engine10) refuses a
    folder that is not a git work tree and exits rc 2 in under a second, which a
    bench run would otherwise record as a measured failure of the tool under test.
    Local identity only; the fixture is the baseline so a diff shows what the agent changed.
    A dummy origin remote is set so repo identity resolves for every tool alike; nothing is
    ever fetched or pushed to it (the .invalid TLD never resolves)."""
    git = ["git", "-c", "user.name=bench", "-c", "user.email=bench@localhost"]
    for argv in (["git", "init", "-q"], ["git", "remote", "add", "origin", "https://git.invalid/bench/fixture.git"],
                 ["git", "add", "-A"], git + ["commit", "-q", "-m", "baseline", "--allow-empty"]):
        subprocess.run(argv, cwd=workdir, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _git_out(workdir: str, *argv: str) -> Optional[str]:
    try:
        proc = subprocess.run(["git", *argv], cwd=workdir, capture_output=True, text=True, timeout=60)
    except Exception:
        return None
    return proc.stdout if proc.returncode == 0 else None


def _base_tree(workdir: str) -> Optional[str]:
    """Tree hash of the baseline commit. Content-addressed, so every fresh clone of
    one fixture reports the same value; a commit hash would differ per clone."""
    out = _git_out(workdir, "rev-parse", "HEAD^{tree}")
    return out.strip() if out and out.strip() else None


def _files_changed(workdir: str, base_tree: Optional[str]) -> Optional[int]:
    """Files the agent changed versus the baseline, committed or not, measured by
    the harness on the workdir (never reported by the tool). The prompt file and
    .loki state are the harness's, not the agent's. None when git cannot answer."""
    if not base_tree:
        return None
    tracked = _git_out(workdir, "-c", "core.quotepath=off", "diff", "--name-only", base_tree)
    untracked = _git_out(workdir, "-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard")
    if tracked is None or untracked is None:
        return None
    names = {n for n in (tracked + untracked).splitlines() if n}
    return len([n for n in names if n != PROMPT_FILENAME and not n.startswith(".loki/")])


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


# Benchmark arms that are a configuration of an existing adapter, not a file of
# their own: arm name -> (adapter module, entry point).
ARM_ENTRYPOINTS = {"loki-lean": ("loki", "run_lean")}


def load_adapter(name: str) -> Callable[..., Dict[str, Any]]:
    """Load benchmarks/bench/adapters/<name>.py and return its run() callable.

    Adapters are produced by Slice C. This loader only needs them to exist and
    expose a module-level run() function with the documented signature.
    """
    adapters_dir = os.path.join(_HERE, "adapters")
    if name in ARM_ENTRYPOINTS:
        name, entry = ARM_ENTRYPOINTS[name]
    else:
        entry = "run"
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
    fn = getattr(mod, entry, None)
    if not callable(fn):
        raise AttributeError("adapter %s has no callable %s()" % (name, entry))
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


EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")


def catalog_effort_levels(model: Optional[str]) -> List[str]:
    """Effort levels providers/model_catalog.json lists for `model` (id, alias or cli alias).

    Raises ValueError for a missing model, an unknown model or a model with no
    effort parameter, so a sweep never runs a level the model does not accept.
    """
    if not model:
        raise ValueError("--effort sweep needs --model to know which levels to run")
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.environ.get("LOKI_MODEL_CATALOG") or os.path.join(
        here, "..", "..", "providers", "model_catalog.json")
    with open(path) as fh:
        claude = json.load(fh)["providers"]["claude"]
    mid = claude.get("cli_aliases", {}).get(model, model)
    for m in claude["models"]:
        if m["id"] == mid or m.get("alias") == model:
            levels = [lv for lv in EFFORT_LEVELS if lv in m.get("effort", {}).get("levels", [])]
            if not levels:
                raise ValueError("model %r lists no effort levels; nothing to sweep" % model)
            return levels
    raise ValueError("model %r is not in the catalog; cannot sweep" % model)


def parse_efforts(raw: str, model: Optional[str] = None) -> List[str]:
    """Split a comma list of effort levels; reject anything outside EFFORT_LEVELS.

    The single value "sweep" is the effort_sweep axis: every level the catalog
    lists for `model`, low to max.
    """
    if raw.strip() == "sweep":
        return catalog_effort_levels(model)
    levels = [x.strip() for x in raw.split(",") if x.strip()]
    bad = [x for x in levels if x not in EFFORT_LEVELS]
    if not levels or bad:
        raise ValueError("invalid --effort %r (allowed: %s, or sweep)" % (
            bad or raw, ", ".join(EFFORT_LEVELS)))
    return list(dict.fromkeys(levels))


def adapter_supports_effort(adapter: Callable[..., Dict[str, Any]]) -> bool:
    import inspect
    try:
        return "effort" in inspect.signature(adapter).parameters
    except (TypeError, ValueError):
        return False


def invoke_adapter(adapter: Callable[..., Dict[str, Any]],
                   workdir: str, spec: Dict[str, Any], model: str,
                   timeout_s: int, runner_fn: Any = None,
                   effort: Optional[str] = None) -> Dict[str, Any]:
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
    if effort is not None:
        kwargs["effort"] = effort
    out = adapter(workdir, prompt_path, **kwargs)
    errs = schema.validate_adapter_output(out)
    if errs:
        raise ValueError("adapter returned invalid output: %s" % "; ".join(errs))
    return schema.normalize_adapter_output(out)


# ---------------------------------------------------------------------------
# trial + run orchestration
# ---------------------------------------------------------------------------

def _advisor_field(adapter_out: Dict[str, Any], key: str) -> Optional[int]:
    prov = adapter_out.get("provenance")
    adv = prov.get("advisor") if isinstance(prov, dict) else None
    v = adv.get(key) if isinstance(adv, dict) else None
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _advisor_calls(adapter_out: Dict[str, Any]) -> Optional[int]:
    return _advisor_field(adapter_out, "calls")


def run_trial(adapter: Callable[..., Dict[str, Any]],
              spec: Dict[str, Any], fixture_dir: str, model: str,
              tool: str, trial_index: int,
              keep_workdir: bool = False,
              runner_fn: Any = None,
              task_dir: Optional[str] = None,
              effort: Optional[str] = None,
              trial_label: Optional[str] = None,
              verify_fn: Any = None) -> Dict[str, Any]:
    """One trial: prepare workdir, invoke adapter, GRADE, assemble trial record.

    LOKI_BENCH_WORKDIRS=<root> keeps every workdir at <root>/<tool>/<task>/<label>/
    (label defaults to the trial index) so a later measurement, for example
    trust_time, can read the same trials without a second paid run."""
    agent_timeout = int(spec.get("agent_timeout_s", 1800))
    root = os.environ.get("LOKI_BENCH_WORKDIRS")
    dest = None
    if root:
        keep_workdir = True
        dest = os.path.join(root, tool, spec["id"], trial_label or str(trial_index))
    workdir = prepare_workdir(fixture_dir, tool, dest=dest)
    try:
        base_tree = _base_tree(workdir)
        adapter_out = invoke_adapter(adapter, workdir, spec, model,
                                     agent_timeout, runner_fn=runner_fn,
                                     effort=effort)
        # Diff evidence is measured here, before the grader overlays held-out
        # files, so every arm is judged on the same yardstick.
        if "files_changed" not in adapter_out:
            adapter_out["files_changed"] = _files_changed(workdir, base_tree)
        # GRADE on the produced repo state. Grader sees workdir + spec (+ the
        # task dir to resolve a held-out overlay); never adapter-output.
        verdict = grade(workdir, spec, task_dir=task_dir)
        cost_usd = adapter_out.get("cost_usd")

        # UNMEASURED CLASSIFICATION. A trial where the agent never ran cannot
        # carry success=true, whatever the grader said.
        #
        # OBSERVED, not hypothesised: `loki bench run demo-pass` produced three
        # trials, each `exit_status: "timeout"` at 60s with `iterations: 0` and
        # no tokens, and each recorded `success: True`. The grader's acceptance
        # command was literally `true`, so it exited 0 without inspecting
        # anything. The adapter's timeout status sat in the same row, unread.
        #
        # The two facts answer different questions and both must survive:
        #   grader_verdict  -- did the artifact satisfy the held-out oracle
        #   measured        -- did a run actually happen to produce an artifact
        # Collapsing them is what let a timeout read as a pass. So the grader
        # evidence is PRESERVED verbatim under `grader_verdict`, and `success`
        # is forced to None (not False) when the run is unmeasured: a run that
        # did not happen did not fail, it was not observed, and False would be
        # a different lie in the other direction.
        # Classification is delegated to bench_schema.trial_is_measured so the
        # raw row, the summary, the report and the equivalence table can never
        # disagree about what counts. Duplicating the rule here is how two
        # layers drift into contradicting each other.
        #
        # NOTE zero-iterations is NOT a reason. It looks like one, but a run
        # that genuinely FAILED can legitimately record iterations: 0, and
        # excluding those deletes real failures from the denominator -- the
        # same false-green, inverted. See the comment in trial_is_measured.
        exit_status = adapter_out.get("exit_status")
        unmeasured_reasons = []
        if isinstance(exit_status, str) and exit_status.strip().lower() in \
                schema.UNMEASURED_EXIT_STATUSES:
            unmeasured_reasons.append("adapter exit_status=%s" % exit_status)

        row = {
            "trial": trial_index,
            "base_tree": base_tree,
            "success": verdict["success"],
            "quality": verdict["quality"],
            "acceptance_exit_code": verdict["acceptance_exit_code"],
            "adapter": adapter_out,
            "cost_usd": cost_usd,
            "duration_s": adapter_out.get("duration_s"),
            # Always present so a consumer never has to infer measuredness from
            # a missing key, which is how the original defect stayed invisible.
            "measured": not unmeasured_reasons,
            "unmeasured_reasons": unmeasured_reasons,
            # Advisor calls this trial streamed; None when not recorded (non-loki tool, or no cost
            # record). advisor_verdict treats None as not attached, never as zero calls.
            "advisor_calls": _advisor_calls(adapter_out),
            # Advisor errors this trial hit; a trial with calls but errors is not attached.
            "advisor_errors": _advisor_field(adapter_out, "errors"),
            # Seconds per engine stage (loki only); None when not recorded.
            "stage_durations_s": (adapter_out.get("provenance") or {}).get(
                "stage_durations_s"),
        }
        row["metrics"] = schema.trial_metrics(
            adapter_out, verdict["success"], measured=not unmeasured_reasons)
        stages = stage_records(adapter_out)
        if stages:
            row["stages"] = stages
        if verify_fn is not None:
            # Seal verdict on the produced repo, beside the held-out grader
            # result. A verifier that cannot answer yields None (unmeasured).
            try:
                seal_verdict = verify_fn(workdir, model)
            except Exception:
                seal_verdict = None
            row["seal"] = seal_record(
                spec["id"], tool, model, seal_verdict,
                None if unmeasured_reasons else verdict["success"])
        if unmeasured_reasons:
            # Held-out grader evidence preserved separately, never discarded.
            #
            # `success` STAYS A BOOL. The schema validator requires
            # trials[].success to be a bool (grader-set), and setting it None
            # here made every assembled row invalid -- caught by that validator
            # rather than by me. The bool is the GRADER's answer and remains
            # exactly what the grader said; measuredness is carried by the
            # `measured` flag beside it, which is what bench_schema's
            # split_measured() and every summary/report consumer already read.
            #
            # So the two facts stay separable without breaking the contract:
            #   success        -- did the artifact satisfy the held-out oracle
            #   measured=False -- but no run happened, so it proves nothing
            #                     about the agent and is excluded from k/N
            row["grader_verdict"] = {
                "success": verdict["success"],
                "acceptance_exit_code": verdict["acceptance_exit_code"],
                "note": ("the held-out grader's own verdict on whatever was in "
                         "the workdir. Real evidence about the ARTIFACT; NOT "
                         "evidence that a run happened. measured=False, so "
                         "this trial is excluded from k/N."),
            }
            # Cost and tokens from a run that did not happen are UNKNOWN, never
            # zero. Left untouched if the adapter recorded something real.
            if cost_usd is None:
                row["cost_usd"] = None
        return row
    finally:
        if not keep_workdir:
            shutil.rmtree(workdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# P4(b): Seal verdict vs held-out grader (wrong-pass capture)
# ---------------------------------------------------------------------------

WRONG_PASS_SCHEMA = "loki.seeded-defects.results/v2"  # same schema measure.py emits
SEAL_VERDICTS = {"VERIFIED": 0, "CONCERNS": 1, "BLOCKED": 2}


def seal_record(task: str, arm: str, model: str, verdict: Optional[str],
                grader_pass: Optional[bool]) -> Dict[str, Any]:
    """Per-trial record. wrong_pass is True only for VERIFIED with a failing
    grader; a missing verdict or an unmeasured grader gives None, never a pass."""
    if verdict not in SEAL_VERDICTS:
        verdict = None
    wrong = None
    if verdict is not None and isinstance(grader_pass, bool):
        wrong = (verdict == "VERIFIED" and not grader_pass)
    return {"task": task, "arm": arm, "model": model, "verdict": verdict,
            "grader_pass": grader_pass, "wrong_pass": wrong}


def default_verify(workdir: str, model: str, timeout: int = 600) -> Optional[str]:
    """Run `loki verify --json` on the arm's workdir with LOKI_MODEL=model.
    Spend-gated (the verifier may call a model); returns None when not
    approved, on any failure, or on an exit code that disagrees with the verdict."""
    if os.environ.get("LOKI_BENCH_SPEND_APPROVED") != "1":
        return None
    env = dict(os.environ, LOKI_MODEL=model or "", LOKI_TELEMETRY_DISABLED="true", CI="true")
    try:
        base = subprocess.run(["git", "rev-list", "--max-parents=0", "HEAD"], cwd=workdir,
                              capture_output=True, text=True, timeout=60).stdout.split()
        if len(base) != 1:
            return None
        p = subprocess.run(["loki", "verify", base[0], "--json"], cwd=workdir, env=env,
                           capture_output=True, text=True, timeout=timeout)
        ev = json.loads(p.stdout)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None
    v = ev.get("verdict") if isinstance(ev, dict) else None
    ec = ev.get("exit_code") if isinstance(ev, dict) else None
    if SEAL_VERDICTS.get(v) is None or type(ec) is not int or ec != p.returncode \
            or SEAL_VERDICTS[v] != ec:
        return None
    return v


STAGES = ("wall_author", "review")


def stage_records(adapter_out: Dict[str, Any]) -> Dict[str, Dict[str, str]]:
    """Wall-author and review-stage records an adapter reported as
    stages.<stage> = {"model": str, "outcome": str}. Anything malformed or
    absent is dropped, so a stage with no usable record stays unmeasured."""
    raw = adapter_out.get("stages")
    out: Dict[str, Dict[str, str]] = {}
    if not isinstance(raw, dict):
        return out
    for stage in STAGES:
        rec = raw.get(stage)
        if isinstance(rec, dict) and isinstance(rec.get("model"), str) and rec["model"] \
                and isinstance(rec.get("outcome"), str) and rec["outcome"]:
            out[stage] = {"model": rec["model"], "outcome": rec["outcome"]}
    return out


def stage_outcomes(rows: List[Dict[str, Any]], model: str) -> Dict[str, Any]:
    """Per-model outcome counts for the Wall-author and review stages. When no
    trial carries a record for a stage, by_model is null with a reason: never a
    zero. A stage model that attribution treats as the run model is keyed by the
    run model. Informational only; not a P4 gate."""
    import attribution  # lazy: attribution imports this module
    trials = [t for r in rows for t in r.get("trials", [])]
    res: Dict[str, Any] = {}
    for stage in STAGES:
        by_model: Dict[str, Dict[str, Any]] = {}
        missing = 0
        for t in trials:
            rec = (t.get("stages") or {}).get(stage)
            if not rec:
                missing += 1
                continue
            m = rec["model"]
            key = model if model and attribution.model_match(m, model) else m
            cell = by_model.setdefault(key, {"n": 0, "outcomes": {}})
            cell["n"] += 1
            cell["outcomes"][rec["outcome"]] = cell["outcomes"].get(rec["outcome"], 0) + 1
        if by_model:
            res[stage] = {"by_model": by_model, "reason": None, "trials_without_record": missing}
        else:
            res[stage] = {"by_model": None, "trials_without_record": missing,
                          "reason": "unmeasured: no trial reported a %s record" % stage}
    return res


def wrong_pass_results(rows: List[Dict[str, Any]], setup: str, model: str) -> Dict[str, Any]:
    """Summary in the schema measure.py emits. outcomes maps each MEASURED task
    to SEALED (a wrong pass) or NOT_SEALED; trials with no verdict are listed
    under unmeasured and excluded from n."""
    recs = [t["seal"] for r in rows for t in r.get("trials", []) if "seal" in t]
    by_task: Dict[str, List[Optional[bool]]] = {}
    for rec in recs:
        by_task.setdefault(rec["task"], []).append(rec["wrong_pass"])
    outcomes: Dict[str, str] = {}
    unmeasured: List[str] = []
    for task, flags in by_task.items():
        if any(f is True for f in flags):
            outcomes[task] = "SEALED"  # one wrong-passing trial marks the task
        elif all(f is False for f in flags):
            outcomes[task] = "NOT_SEALED"  # only when EVERY trial was measured
        else:
            unmeasured.append(task)
    digest = hashlib.sha256(json.dumps(sorted(r.get("task_hash", "") for r in rows)).encode()).hexdigest()
    run = {"setup": setup, "model": model, "n": len(outcomes),
           "wrong_pass": sum(1 for v in outcomes.values() if v == "SEALED"),
           "outcomes": outcomes, "unmeasured": unmeasured, "records": recs,
           "stage_outcomes": stage_outcomes(rows, model),
           "route": "heldout-bench", "verifier": None, "loki_version": None}
    return {"schema": WRONG_PASS_SCHEMA, "manifest_sha256": digest, "runs": [run]}


def write_wrong_pass(rows: List[Dict[str, Any]], setup: str, model: str, out: str) -> Dict[str, Any]:
    corpus = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                                           "seeded-defects", "results", "wrong-pass.json"))
    if os.path.realpath(out) == corpus:
        raise ValueError("refusing to write held-out results over the seeded-defects corpus file")
    doc = wrong_pass_results(rows, setup, model)
    d = os.path.dirname(os.path.abspath(out))
    fd, tmp = tempfile.mkstemp(prefix=".wrong-pass-", suffix=".tmp", dir=d)
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(doc, fh, indent=2, sort_keys=True)
            fh.write("\n")
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return doc


def _spend_gated_adapter(adapter_name: str) -> Callable[..., Dict[str, Any]]:
    """Load a NAMED adapter behind the spend interlock."""
    # SPEND INTERLOCK. Loading a NAMED adapter is the point where this
    # harness starts a real tool and therefore starts costing money.
    #
    # It exists because a task named "demo-pass" was run on the assumption
    # that a demo is free. It invoked the provider for three 60-second
    # trials. Nothing was recorded as billed, but an absent cost record is
    # not a zero cost record, so the true spend of that run is UNKNOWN --
    # which is precisely the outcome an interlock prevents.
    #
    # Default-DENY, and deliberately not a warning: a prompt that can be
    # ignored is not an interlock. An explicitly-passed `adapter` (the mock
    # path used by tests) never reaches here, so offline verification is
    # unaffected and stays runnable with no opt-in.
    if os.environ.get("LOKI_BENCH_SPEND_APPROVED") != "1":
        raise RuntimeError(
            "SPEND INTERLOCK: running adapter %r starts a real tool and "
            "costs money. This is founder-gated. Set "
            "LOKI_BENCH_SPEND_APPROVED=1 to authorise, or pass a mock "
            "adapter for offline verification. No run was started."
            % adapter_name)
    return load_adapter(adapter_name)


def run_task(task_path: str, adapter_name: str, *,
             trials: int = 3, model: Optional[str] = None,
             adapter: Optional[Callable[..., Dict[str, Any]]] = None,
             keep_workdir: bool = False,
             runner_fn: Any = None,
             effort: Optional[str] = None,
             verify_fn: Any = None) -> Dict[str, Any]:
    """Run a full task: N trials of one adapter, assemble + validate a result-row.

    `adapter` may be passed directly (used by tests with a mock); otherwise the
    named adapter module is loaded from benchmarks/bench/adapters/<name>.py.

    `effort` (one of EFFORT_LEVELS) overrides the tier-derived effort for this
    run and is recorded as row["effort"]. None keeps today's behaviour: the
    adapter is called without it and the row carries no effort key. An adapter
    that cannot apply an effort raises rather than record one it did not run.
    """
    spec = load_task(task_path)
    retired = schema.retired_tasks().get(spec["id"])
    if retired:
        raise ValueError("task %s is retired (%s); use %s" % (spec["id"], retired.get("reason", ""), retired.get("superseded_by", "its replacement")))
    fixture_dir = resolve_fixture_dir(task_path, spec)
    task_dir = os.path.dirname(os.path.abspath(task_path))
    task_hash = schema.compute_task_hash(spec, fixture_dir)
    used_model = model or spec.get("default_model", "")

    if adapter is None:
        adapter = _spend_gated_adapter(adapter_name)

    if effort is not None:
        if effort not in EFFORT_LEVELS:
            raise ValueError("invalid effort %r (allowed: %s)" % (
                effort, ", ".join(EFFORT_LEVELS)))
        if not adapter_supports_effort(adapter):
            raise ValueError(
                "adapter %r cannot apply --effort; refusing to record an effort "
                "it did not run" % adapter_name)

    trial_rows: List[Dict[str, Any]] = []
    for i in range(1, max(1, trials) + 1):
        trial_rows.append(run_trial(
            adapter, spec, fixture_dir, used_model, adapter_name, i,
            keep_workdir=keep_workdir, runner_fn=runner_fn, task_dir=task_dir,
            effort=effort, verify_fn=verify_fn,
        ))

    row = {
        "schema_version": schema.SCHEMA_VERSION,
        "task_id": spec["id"],
        # Store repo-relative so a third party who clones elsewhere can still
        # `loki bench verify` (reproducibility is the #1 credibility rule). Tasks
        # outside the repo fall back to an absolute path.
        "task_path": _store_task_path(task_path),
        "task_hash": task_hash,
        # Which engine drove these trials. The report refuses to pool rows whose
        # signatures differ (see equivalence_report.group_by_harness).
        "harness_sig": harness_signature(),
        "tool": adapter_name,
        "model": used_model,
        "trials": trial_rows,
        "summary": schema.summarize_trials(trial_rows),
    }
    # Model-equivalence matrix (matrix.sh) sets LOKI_BENCH_CELL per cell so the
    # aggregation report can group results into the model x config grid. Persist
    # it when set; absent for ordinary (non-matrix) runs.
    _cell = os.environ.get("LOKI_BENCH_CELL")
    if _cell:
        row["cell"] = _cell
    if effort is not None:
        row["effort"] = effort
    errs = schema.validate_result_row(row)
    if errs:
        raise ValueError("assembled result-row invalid: %s" % "; ".join(errs))
    return row


def run_arms(task_paths: List[str], arms: List[str], *, reps: int = 3,
             model: Optional[str] = None,
             adapters: Optional[Dict[str, Callable[..., Dict[str, Any]]]] = None,
             keep_workdir: bool = False, runner_fn: Any = None,
             verify_fn: Any = None) -> Dict[str, Any]:
    """Run several arms over the same tasks, interleaved, and return one row per
    (task, arm) plus the exact schedule that ran.

    Tasks run in the order given. Within a task each rep runs every arm once, in
    an order rotated per (task, rep) as a Latin square and recorded in
    `schedule`, so provider drift, rate limits and time of day land on every
    arm alike and no arm always goes first. Every trial is a fresh clone of the one
    frozen fixture; the baseline tree hash of each trial is checked equal across
    all arms of a task, so an arm that ran on a different base is an error, not
    a quiet comparison. `adapters` maps an arm to a callable (tests pass mocks);
    an arm without one is loaded behind the spend interlock.
    """
    adapters = adapters or {}
    if len(set(arms)) != len(arms) or len(arms) < 2:
        raise ValueError("arms must be two or more distinct names: %r" % (arms,))
    if os.environ.get("LOKI_LEAN") and "loki" in arms:
        # run_cli merges os.environ under the adapter env, so a parent LOKI_LEAN
        # would turn the plain `loki` arm into the lean one without a trace.
        raise ValueError("LOKI_LEAN is set in the parent env; unset it so the plain loki arm stays plain")
    rows: List[Dict[str, Any]] = []
    schedule: List[Dict[str, Any]] = []
    k = len(arms)
    reps = max(1, reps)
    for ti, task_path in enumerate(task_paths):
        per_arm: Dict[str, Dict[str, Any]] = {}
        for rep in range(1, reps + 1):
            # Latin-square rotation over (task, rep): every arm takes every
            # position as evenly as the counts allow, so order never favours one.
            off = (ti * reps + rep - 1) % k
            for pos, arm in enumerate(arms[off:] + arms[:off]):
                one = run_task(task_path, arm, trials=1, model=model,
                               adapter=adapters.get(arm), keep_workdir=keep_workdir,
                               runner_fn=runner_fn, verify_fn=verify_fn)
                one["trials"][0]["trial"] = rep
                schedule.append({"task_id": one["task_id"], "rep": rep, "arm": arm, "position": pos})
                if arm not in per_arm:
                    per_arm[arm] = one
                else:
                    per_arm[arm]["trials"].extend(one["trials"])
            # Checked after every rep, so rep 1 already proves the shared base.
            trees = {t.get("base_tree") for r in per_arm.values() for t in r["trials"]}
            hashes = {r["task_hash"] for r in per_arm.values()}
            if len(trees) != 1 or len(hashes) != 1:
                raise ValueError("arms ran on different bases for %s: trees=%s task_hash=%s" % (
                    next(iter(per_arm.values()))["task_id"], sorted(map(str, trees)), sorted(hashes)))
        for arm in arms:
            row = per_arm[arm]
            row["summary"] = schema.summarize_trials(row["trials"])
            errs = schema.validate_result_row(row)
            if errs:
                raise ValueError("assembled result-row invalid: %s" % "; ".join(errs))
            rows.append(row)
    return {"rows": rows, "schedule": schedule}


def run_resume_pair(task_path: str, adapter_name: str, *, interrupt: Any,
                    trials: int = 1, model: Optional[str] = None,
                    adapter: Optional[Callable[..., Dict[str, Any]]] = None,
                    runner_fn: Any = None) -> Dict[str, Any]:
    """Resume-cost instrument (100x axis D). Per trial: an uninterrupted
    control, then the same task interrupted at a deterministic point and
    resumed. `interrupt` is a stage name for loki (kill when `(<stage> done` is
    printed) or seconds for claude_code. Returns every pair with
    schema.resume_cost(control, interrupted); the grader judges both runs."""
    spec = load_task(task_path)
    fixture_dir = resolve_fixture_dir(task_path, spec)
    task_dir = os.path.dirname(os.path.abspath(task_path))
    used_model = model or spec.get("default_model", "")
    if adapter is None:
        adapter = _spend_gated_adapter(adapter_name)
    key = "interrupt_after_stage" if adapter_name == "loki" else "interrupt_after_s"
    resumed = lambda *a, **kw: adapter(*a, **{**kw, key: interrupt})  # noqa: E731
    pairs = []
    for i in range(1, max(1, trials) + 1):
        ctl = run_trial(adapter, spec, fixture_dir, used_model, adapter_name, i,
                        runner_fn=runner_fn, task_dir=task_dir,
                        trial_label="control-%d" % i)
        itr = run_trial(resumed, spec, fixture_dir, used_model, adapter_name, i,
                        runner_fn=runner_fn, task_dir=task_dir)
        pairs.append({"control": ctl, "interrupted": itr,
                      "resume_cost": schema.resume_cost(ctl, itr)})
    return {"task_id": spec["id"], "tool": adapter_name, "model": used_model,
            "interrupt": interrupt, "harness_sig": harness_signature(),
            "pairs": pairs}


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


# ---------------------------------------------------------------------------
# harness signature: which engine produced this row
# ---------------------------------------------------------------------------
# task_hash answers "was the TASK the same?". This answers "was the HARNESS the
# same?". Without it, editing run.sh mid-campaign silently pools trials from two
# different engines into one arm.
#
# Why working-tree bytes and not `git rev-parse HEAD`:
#   - HEAD moves on every unrelated commit (docs, tests), which would shard the
#     strata spuriously and invalidate a valid pooled record.
#   - `git rev-parse HEAD:<file>` ignores UNCOMMITTED edits, which is exactly
#     the threat here (edit run.sh, keep running trials, never commit).
# Hashing the bytes on disk tracks what actually ran, committed or not.

_ENGINE_FILES = (
    "autonomy/run.sh",
    "autonomy/loki",
    "autonomy/completion-council.sh",
)


def harness_signature(repo: Optional[str] = None) -> str:
    """sha256 over the engine files that decide how a trial is driven.

    Returns "unknown" when no engine file is readable (e.g. the runner is
    vendored without the engine) -- an honest absent marker, never a fake
    digest that would let two different harnesses compare equal.
    """
    root = repo or _REPO
    h = hashlib.sha256()
    found = False
    for rel in _ENGINE_FILES:
        path = os.path.join(root, rel)
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError:
            continue
        found = True
        # Length-prefix the path and body so no two file sets can collide by
        # concatenating to the same byte stream.
        h.update(("%s:%d:" % (rel, len(data))).encode("utf-8"))
        h.update(data)
    return h.hexdigest() if found else "unknown"


def _current_tool_version(tool: str) -> Optional[str]:
    """Best-effort current version string for a tool, or None if unavailable."""
    cmds = {
        "loki": ["loki", "version"],
        "loki-lean": ["loki", "version"],
        "aider": ["aider", "--version"],
        "claude_code": ["claude", "--version"],
        "codex": ["codex", "--version"],
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
    pr.add_argument("--effort", default=None,
                    help="comma list of effort levels (%s), or sweep for every level "
                         "the catalog lists for --model; one result row per "
                         "level. Default: tier-derived effort, no effort field"
                         % ",".join(EFFORT_LEVELS))
    pr.add_argument("--out", default=None)
    pr.add_argument("--keep-workdir", action="store_true")
    pr.add_argument("--seal-verify", action="store_true",
                    help="run `loki verify` on each trial's repo and record the verdict beside the "
                         "held-out grader result (needs LOKI_BENCH_SPEND_APPROVED=1, else unmeasured)")
    pr.add_argument("--setup", choices=("top", "floor"), default=None,
                    help="with --wrong-pass-out: which P4 setup this run records")
    pr.add_argument("--wrong-pass-out", default=None,
                    help="write the wrong-pass summary JSON (measure.py schema) here; needs --seal-verify and --setup")

    pc = sub.add_parser("resume-cost", help="control vs interrupted-then-resumed trial pair")
    pc.add_argument("task")
    pc.add_argument("--adapter", default="loki")
    pc.add_argument("--interrupt", required=True,
                    help="loki: stage name; claude_code: seconds")
    pc.add_argument("--trials", type=int, default=1)
    pc.add_argument("--model", default=None)
    pc.add_argument("--out", default=None)

    pa = sub.add_parser("arms", help="interleave several arms over the same tasks")
    pa.add_argument("tasks", nargs="+")
    pa.add_argument("--arms", default="loki-lean,claude_code,loki",
                    help="comma list of arms; claude_code is the raw `claude -p` arm")
    pa.add_argument("--reps", type=int, default=3)
    pa.add_argument("--model", default=None)
    pa.add_argument("--out", required=True)

    pv = sub.add_parser("verify", help="recompute task_hash + check tool versions")
    pv.add_argument("result")

    pl = sub.add_parser("validate-task", help="validate a task-spec file")
    pl.add_argument("task")

    args = p.parse_args(argv)

    if args.cmd == "arms":
        res = run_arms(args.tasks, [a for a in args.arms.split(",") if a],
                       reps=args.reps, model=args.model)
        with open(args.out, "w") as fh:
            fh.write(json.dumps(res, indent=2, sort_keys=True) + "\n")
        print("wrote %s (%d rows)" % (args.out, len(res["rows"])))
        return 0

    if args.cmd == "resume-cost":
        itr = args.interrupt if args.adapter == "loki" else float(args.interrupt)
        res = run_resume_pair(args.task, args.adapter, interrupt=itr,
                              trials=args.trials, model=args.model)
        payload = json.dumps(res, indent=2, sort_keys=True)
        if args.out:
            with open(args.out, "w") as fh:
                fh.write(payload + "\n")
            print("wrote %s" % args.out)
        else:
            print(payload)
        return 0

    if args.cmd == "run":
        vfn = default_verify if args.seal_verify else None
        if args.wrong_pass_out and not (args.seal_verify and args.setup and args.model):
            print("ERROR: --wrong-pass-out needs --seal-verify, --setup and --model", file=sys.stderr)
            return 2
        if args.wrong_pass_out and os.path.realpath(args.wrong_pass_out) == os.path.realpath(
                os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "seeded-defects",
                             "results", "wrong-pass.json")):
            print("ERROR: --wrong-pass-out must not be the seeded-defects corpus results file", file=sys.stderr)
            return 2
        if args.wrong_pass_out and args.effort is not None:
            print("ERROR: --wrong-pass-out cannot be combined with --effort", file=sys.stderr)
            return 2
        if args.wrong_pass_out and args.effort is None:
            row = run_task(args.task, args.adapter, trials=args.trials, model=args.model,
                           keep_workdir=args.keep_workdir, verify_fn=vfn)
            doc = write_wrong_pass([row], args.setup, args.model, args.wrong_pass_out)
            r = doc["runs"][0]
            print("%s %s: wrong_pass %d/%d (%d unmeasured) -> %s" % (
                args.setup, args.model, r["wrong_pass"], r["n"], len(r["unmeasured"]), args.wrong_pass_out))
            return 0
        if args.effort is None:
            row = run_task(args.task, args.adapter, trials=args.trials,
                           model=args.model, keep_workdir=args.keep_workdir,
                           verify_fn=vfn)
            payload = json.dumps(row, indent=2, sort_keys=True)
            if args.out:
                with open(args.out, "w") as fh:
                    fh.write(payload + "\n")
                print("wrote %s" % args.out)
            else:
                print(payload)
            return 0
        try:
            levels = parse_efforts(args.effort, args.model)
        except ValueError as exc:
            print("ERROR: %s" % exc, file=sys.stderr)
            return 2
        rows = [run_task(args.task, args.adapter, trials=args.trials,
                         model=args.model, keep_workdir=args.keep_workdir,
                         effort=lv, verify_fn=vfn) for lv in levels]
        if not args.out:
            print(json.dumps(rows[0] if len(rows) == 1 else rows,
                             indent=2, sort_keys=True))
            return 0
        # One file per row (report.py consumes one row per file); the effort
        # level is suffixed onto the stem when more than one level was run.
        stem, ext = os.path.splitext(args.out)
        for lv, row in zip(levels, rows):
            dest = args.out if len(rows) == 1 else "%s-effort-%s%s" % (stem, lv, ext)
            with open(dest, "w") as fh:
                fh.write(json.dumps(row, indent=2, sort_keys=True) + "\n")
            print("wrote %s" % dest)
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
