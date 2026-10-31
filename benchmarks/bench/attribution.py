#!/usr/bin/env python3
"""Harness attribution benchmark: does Loki beat raw Claude Code on the SAME model?

Runs each task twice under matched conditions:
  raw-configured : `claude -p` as the operator has it configured (hooks, skills,
               CLAUDE.md load as usual), pinned model, same permissions, same budget
  raw-bare   : `claude -p --bare` (no hooks, skills or CLAUDE.md); needs
               ANTHROPIC_API_KEY, else every raw-bare cell is UNMEASURED with a reason
  raw-lean   : `claude -p` with the engine10 tool set and no MCP/slash commands
               (OAuth-safe same-config floor, TEN-COST-02)
  loki       : `loki start --provider claude` with the same pinned model
  loki-lean  : loki with LOKI_COST_PROFILE=lean (TEN-COST-01 cost levers)
  droid      : optional `droid exec` arm (its own model). When `droid exec` is
               absent or fails its probe, every droid cell is UNMEASURED: never
               run, never zero, no rate published for that arm.

Both arms get the same seed repo (byte-identical, fresh git repo), the same
prompt text, the same wall-clock cap and the same budget. The acceptance test
lives OUTSIDE the agent workspace (benchmarks/attribution/tasks/<id>/acceptance)
and is copied in only AFTER the run, so the implementer cannot modify it.
Neither arm grades itself: acceptance = held-out command exit code 0.

Metrics follow the harness attribution protocol in docs/EVALUATING.md:
failures and timeouts stay in every denominator, unmeasured cost is reported as
unmeasured (never zero), cost per accepted task is undefined when none accepted.

Reuses runner._apply_overlay, report._median and benchmarks/bench/adapters (_base.run_cli process-group reaping, the
claude JSON parser, the loki adapter and its cost collection). No model call is
made by --dry-run, by the default (no --execute) invocation, or by the tests.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import fnmatch
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from adapters import _base  # noqa: E402
from adapters import claude_code as _claude_adapter  # noqa: E402
from adapters import loki as _loki_adapter  # noqa: E402
import bench_schema as _schema  # noqa: E402
import equivalence_report as _equivalence  # noqa: E402
import cost_claim as _cost_claim  # noqa: E402
import report as _report  # noqa: E402
import runner as _runner  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(HERE))
DEFAULT_TASKS_DIR = os.path.join(REPO_ROOT, "benchmarks", "attribution", "tasks")
DEFAULT_OUT_DIR = os.path.join(REPO_ROOT, "benchmarks", "attribution", "results")

ARMS = ("raw-configured", "raw-bare", "loki", "droid")
# Every selectable arm. ARMS stays the default set so a bare run costs what it did.
ALL_ARMS = ("raw-configured", "raw-bare", "raw-lean", "loki", "loki-lean", "droid")
LOKI_ARMS = ("loki", "loki-lean")
RAW_ARMS = ("raw-configured", "raw-bare", "raw-lean")
LOKI_ARM_PROFILE = {"loki": "off", "loki-lean": "lean"}
MODEL_PINNED_ARMS = ("raw-configured", "raw-bare", "raw-lean", "loki", "loki-lean")
LEVER_ENV_KEY = re.compile(r"^LOKI_[A-Z0-9_]+$")
# Owned by the arm or the pin, so an ablation flag may not override them.
LEVER_ENV_RESERVED = ("LOKI_COST_PROFILE", "LOKI_SESSION_MODEL", "LOKI_BUDGET_LIMIT")
LEDGER_REL = os.path.join(".loki", "metrics", "child-sessions.jsonl")
TASK_CLASSES = ("bugfix", "feature", "refactor", "integration")
PILOT_MIX = {"bugfix": 2, "feature": 3, "refactor": 1, "integration": 2}
DEFAULT_MODEL = "claude-sonnet-5"
DEFAULT_BUDGET_USD = 5.0
DEFAULT_TIMEOUT_S = 900
SCHEMA_VERSION = "1.0"


# ---------------------------------------------------------------------------
# Task set
# ---------------------------------------------------------------------------


def _read(path: str) -> str:
    with open(path) as fh:
        return fh.read()


def _nonempty_dir(path: str) -> bool:
    return os.path.isdir(path) and bool(os.listdir(path))


def load_tasks(tasks_dir: str, only: Optional[List[str]] = None
               ) -> Tuple[List[Dict[str, Any]], List[str], List[str]]:
    """Return (tasks, errors, warnings). Errors make the set unusable."""
    errors: List[str] = []
    warnings: List[str] = []
    tasks: List[Dict[str, Any]] = []
    if not os.path.isdir(tasks_dir):
        return [], ["tasks dir not found: %s" % tasks_dir], []
    for name in sorted(os.listdir(tasks_dir)):
        tdir = os.path.join(tasks_dir, name)
        spec_path = os.path.join(tdir, "task.json")
        if not os.path.isfile(spec_path):
            continue
        if only and name not in only:
            continue
        try:
            with open(spec_path) as fh:
                spec = json.load(fh)
        except Exception as exc:  # noqa: BLE001
            errors.append("%s: task.json unreadable: %s" % (name, exc))
            continue
        errs = _validate_task(name, tdir, spec)
        if errs:
            errors.extend(errs)
            continue
        acc = spec["acceptance"]
        prompt_path = os.path.join(tdir, spec["prompt"])
        with open(prompt_path) as fh:
            prompt = fh.read()
        tasks.append({
            "id": spec["id"],
            "class": spec["class"],
            "title": spec.get("title", spec["id"]),
            "dir": tdir,
            "prompt": prompt,
            "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
            "seed_dir": os.path.join(tdir, spec["seed"]),
            "seed_sha256": _schema._hash_fixture_dir(os.path.join(tdir, spec["seed"])),
            "acceptance_dir": os.path.join(tdir, acc["dir"]),
            "acceptance_sha256": _schema._hash_fixture_dir(os.path.join(tdir, acc["dir"])),
            "acceptance_cmd": acc["cmd"],
            "acceptance_timeout_s": int(acc.get("timeout_s", 60)),
            "reference_dir": (os.path.join(tdir, spec["reference"])
                              if spec.get("reference") else None),
            "agent_timeout_s": spec.get("agent_timeout_s"),
        })
    if only:
        missing = sorted(set(only) - {t["id"] for t in tasks})
        for m in missing:
            errors.append("requested task not found or invalid: %s" % m)
    if not only and tasks and not errors:
        mix: Dict[str, int] = {}
        for t in tasks:
            mix[t["class"]] = mix.get(t["class"], 0) + 1
        if mix != PILOT_MIX:
            warnings.append("task mix %s differs from the pilot mix %s"
                            % (json.dumps(mix, sort_keys=True),
                               json.dumps(PILOT_MIX, sort_keys=True)))
    return tasks, errors, warnings


def _validate_task(name: str, tdir: str, spec: Any) -> List[str]:
    errs: List[str] = []
    if not isinstance(spec, dict):
        return ["%s: task.json is not an object" % name]
    for key in ("id", "class", "prompt", "seed", "acceptance"):
        if key not in spec:
            errs.append("%s: missing field '%s'" % (name, key))
    if errs:
        return errs
    if spec["id"] != name:
        errs.append("%s: id '%s' does not match directory name" % (name, spec["id"]))
    if spec["class"] not in TASK_CLASSES:
        errs.append("%s: class '%s' not in %s" % (name, spec["class"], list(TASK_CLASSES)))
    pp = os.path.join(tdir, str(spec["prompt"]))
    if not os.path.isfile(pp) or not _read(pp).strip():
        errs.append("%s: prompt file missing or empty" % name)
    if not _nonempty_dir(os.path.join(tdir, str(spec["seed"]))):
        errs.append("%s: seed dir missing or empty" % name)
    acc = spec["acceptance"]
    if not isinstance(acc, dict) or not acc.get("cmd") or not acc.get("dir"):
        errs.append("%s: acceptance needs 'dir' and 'cmd'" % name)
        return errs
    if not _nonempty_dir(os.path.join(tdir, str(acc["dir"]))):
        errs.append("%s: acceptance dir missing or empty" % name)
    # The hidden test must not already sit in the agent-visible seed.
    seed_dir = os.path.join(tdir, str(spec["seed"]))
    acc_dir = os.path.join(tdir, str(acc["dir"]))
    if os.path.isdir(seed_dir) and os.path.isdir(acc_dir):
        for fname in os.listdir(acc_dir):
            sp = os.path.join(seed_dir, fname)
            ap = os.path.join(acc_dir, fname)
            if os.path.isfile(sp) and "test" in fname.lower() \
                    and os.path.isfile(ap):
                errs.append("%s: acceptance test '%s' also present in seed" % (name, fname))
    if os.path.realpath(acc_dir).startswith(os.path.realpath(seed_dir) + os.sep):
        errs.append("%s: acceptance dir is inside the seed dir" % name)
    return errs


# ---------------------------------------------------------------------------
# Environment pinning
# ---------------------------------------------------------------------------

def _git_sha(path: str) -> Optional[str]:
    try:
        out = subprocess.run(["git", "-C", path, "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=15,
                             env=_scoped_env())
        return out.stdout.strip() or None if out.returncode == 0 else None
    except Exception:  # noqa: BLE001
        return None


def _scoped_env(extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    keep = ("PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL",
            "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR", "LOKI_NO_BROWSER")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["LOKI_NO_BROWSER"] = "1"
    if extra:
        env.update(extra)
    return env


def pin_environment(probe: bool, runner: Optional[Callable] = None,
                    model: Optional[str] = None) -> Dict[str, Any]:
    """Tool versions and commit SHAs. probe=False records them as not probed."""
    if not probe:
        return {"probed": False, "claude_version": None, "loki_version": None,
                "loki_bin": _loki_adapter.loki_bin(),
                "loki_repo_sha": None, "python_version": sys.version.split()[0],
                "loki_session_model_effective": model,
                "loki_session_model_parent_env": os.environ.get("LOKI_SESSION_MODEL"),
                "identity_env": _schema.identity_env_record()}
    return {
        "probed": True,
        "claude_version": _claude_adapter._detect_claude_version(runner=runner),
        "loki_version": _loki_adapter._detect_loki_version(runner=runner),
        "loki_bin": _loki_adapter.loki_bin(),
        "loki_repo_sha": _git_sha(REPO_ROOT),
        "python_version": sys.version.split()[0],
        "loki_session_model_effective": model,
        "loki_session_model_parent_env": os.environ.get("LOKI_SESSION_MODEL"),
        "identity_env": _schema.identity_env_record(),
    }


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------

def arm_order(task_index: int, repeat: int, arms: Tuple[str, ...] = ARMS) -> List[str]:
    """Rotate which arm goes first so time-of-day drift is not one-sided."""
    k = (task_index + repeat) % len(arms)
    return list(arms[k:]) + list(arms[:k])


def build_plan(tasks: List[Dict[str, Any]], repeats: int, model: str,
               budget_usd: float, timeout_s: int,
               arms: Tuple[str, ...] = ARMS,
               loki_env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    cells = []
    for r in range(repeats):
        for i, t in enumerate(tasks):
            for arm in arm_order(i, r, arms):
                cell = {"task": t["id"], "class": t["class"],
                        "arm": arm, "repeat": r + 1}
                if arm in LOKI_ARMS:
                    cell["cost_profile"] = LOKI_ARM_PROFILE[arm]
                    cell["lever_env"] = dict(loki_env or {})
                cells.append(cell)
    return {
        "model": model, "budget_usd": budget_usd, "timeout_s": timeout_s,
        "repeats": repeats, "arms": list(arms),
        "loki_env": dict(loki_env or {}),
        "tasks": [{"id": t["id"], "class": t["class"],
                   "seed_sha256": t["seed_sha256"],
                   "acceptance_sha256": t["acceptance_sha256"],
                   "prompt_sha256": t["prompt_sha256"]} for t in tasks],
        "cells": cells,
        "model_calls_planned": sum(1 for c in cells if c["arm"] in MODEL_PINNED_ARMS),
        "droid_cells_planned": sum(1 for c in cells if c["arm"] == "droid"),
    }


# ---------------------------------------------------------------------------
# Metrics (pure; unit-tested)
# ---------------------------------------------------------------------------

def _wilson_ci95(k: int, n: int) -> Optional[List[float]]:
    """Rounded [low, high] from equivalence_report.wilson_interval; None when n == 0."""
    _p, low, high = _equivalence.wilson_interval(k, n)
    return None if low is None else [round(low, 4), round(high, 4)]


def _median(vals: List[float]) -> Optional[float]:
    m = _report._median(vals)
    return None if m is None else round(m, 3)


_GRADER_TAIL = "; false green = claimed done and the held-out grader did not accept"
# Mirrors each runner's reported_success: raw arms (run_raw_claude) require
# rc == 0 and not is_error; loki and droid arms (run_loki, run_droid) rc == 0.
_RAW_CLAIM = "claimed done = rc == 0 and not is_error" + _GRADER_TAIL
_RC_CLAIM = "claimed done = rc == 0" + _GRADER_TAIL


def _claim_rule_for_arm(arm: Any) -> str:
    """Membership dispatch, same sets as the runners. An arm in none of them has
    no known claim rule: say so, never emit a definite rule."""
    if isinstance(arm, str):
        if arm in RAW_ARMS:
            return _RAW_CLAIM
        if arm in LOKI_ARMS or arm == "droid":
            return _RC_CLAIM
    return "claim rule unknown for arm %s" % (arm if arm else "<missing>")


def _claim_rule(rows: List[Dict[str, Any]]) -> str:
    rules = sorted({_claim_rule_for_arm(r.get("arm")) for r in rows})
    return " | ".join(rules) if rules else "claim rule unknown for arm <missing>"


def compute_metrics(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Metrics for one arm. EVERY row (failure, timeout, harness error) counts.

    acceptance_rate      accepted / assigned
    false_completion     (reported_success and not accepted) / reported_success
                         (null when nothing reported success)
    cost_per_accepted    total spend across ALL attempts / accepted. Null when
                         no run was accepted (undefined) OR when any run's cost
                         was unmeasured (a partial sum is not a total; the
                         measured part is still reported as a lower bound).
    elapsed              median time-to-accepted over accepted runs, reported
                         with the completion rate; elapsed over all runs too.
    """
    assigned = len(rows)
    accepted = sum(1 for r in rows if r.get("accepted"))
    reported = [r for r in rows if r.get("reported_success")]
    false_done = [r for r in reported if not r.get("accepted")]
    completed = sum(1 for r in rows if r.get("status") == "completed")
    timeouts = sum(1 for r in rows if r.get("status") == "timeout")
    unmeasured_runs = sum(1 for r in rows if r.get("status") == "unmeasured")
    errors = sum(1 for r in rows if r.get("status") not in
                 ("completed", "timeout", "unmeasured"))
    any_unmeasured = unmeasured_runs > 0

    # A row's spend is the larger of its stored and true cost; a row whose
    # cost_is_partial (one shared helper) is only a lower bound: it counts toward
    # the measured spend but not as a fully measured run.
    measured = [row_true_spend(r) for r in rows
                if r.get("cost_usd") is not None or r.get("true_cost_usd") is not None]
    partial_n = sum(1 for r in rows
                    if (r.get("cost_usd") is not None or r.get("true_cost_usd") is not None)
                    and row_spend_is_partial(r))
    missing_n = assigned - len(measured)
    unmeasured_n = missing_n + partial_n
    spend = round(sum(measured), 6)
    if assigned == 0:
        cost_status = "no_runs"
    elif unmeasured_runs == assigned:
        cost_status = "unmeasured"
    elif accepted == 0:
        cost_status = "undefined_no_accepted"
    elif missing_n == assigned:
        cost_status = "unmeasured"
    elif unmeasured_n:
        cost_status = "partial_lower_bound"
    else:
        cost_status = "measured"
    per_accepted = (round(spend / accepted, 6)
                    if cost_status == "measured" else None)
    lower_bound = (round(spend / accepted, 6)
                   if cost_status == "partial_lower_bound" else None)

    return {
        "assigned": assigned,
        "accepted": accepted,
        "unmeasured_runs": unmeasured_runs,
        # An arm with any unmeasured run has no honest rate: never zero.
        "acceptance_rate": (round(accepted / assigned, 4)
                            if assigned and not any_unmeasured else None),
        "acceptance_rate_ci95": (None if any_unmeasured
                                 else _wilson_ci95(accepted, assigned)),
        "reported_success": len(reported),
        "false_completions": len(false_done),
        "false_completion_rate": (round(len(false_done) / len(reported), 4)
                                  if reported and not any_unmeasured else None),
        # Scoreboard record: same counts as above, shared Wilson/not_captured
        # math from equivalence_report.false_green_block. Unmeasured runs
        # make the claim count unreliable, so the arm is not_captured.
        "false_green": (_equivalence.false_green_block(
            len(reported), len(false_done), _claim_rule(rows))
            if not any_unmeasured else "not_captured"),
        "completion_rate": (round(completed / assigned, 4)
                            if assigned and not any_unmeasured else None),
        "timeouts": timeouts,
        "errors": errors,
        "spend_measured_usd": spend if measured else None,
        "runs_with_unmeasured_cost": unmeasured_n,
        "cost_status": cost_status,
        "cost_per_accepted_usd": per_accepted,
        "cost_per_accepted_lower_bound_usd": lower_bound,
        "elapsed_median_accepted_s": _median(
            [r["elapsed_s"] for r in rows
             if r.get("accepted") and r.get("elapsed_s") is not None]),
        "elapsed_median_all_s": _median(
            [r["elapsed_s"] for r in rows if r.get("elapsed_s") is not None]),
    }


def arm_label(row: Dict[str, Any]) -> str:
    """Pooling key of a row: its arm plus the lever env it ran with. Rows run
    with different lever configs get different labels and never pool."""
    lever = row.get("lever_env") or {}
    if not lever:
        return row["arm"]
    return row["arm"] + "+" + ",".join("%s=%s" % kv for kv in sorted(lever.items()))


def _labels(rows: List[Dict[str, Any]], arms: Tuple[str, ...]) -> List[str]:
    """The requested arms, then any other known arm or ablation label seen in rows
    (so a result file holding raw-lean or loki-lean rows is never dropped)."""
    seen = {arm_label(r) for r in rows if r.get("arm") in ALL_ARMS}
    others = [a for a in ALL_ARMS if a in seen and a not in arms]
    return list(arms) + others + sorted(seen - set(arms) - set(others))


def summarize(rows: List[Dict[str, Any]],
              arms: Tuple[str, ...] = ARMS) -> Dict[str, Any]:
    labels = _labels(rows, arms)
    by_arm = {a: compute_metrics([r for r in rows if arm_label(r) == a]) for a in labels}
    by_class: Dict[str, Any] = {}
    for c in TASK_CLASSES:
        sub = [r for r in rows if r.get("class") == c]
        if sub:
            by_class[c] = {a: compute_metrics([r for r in sub if arm_label(r) == a])
                           for a in labels}
    return {"by_arm": by_arm, "by_class": by_class,
            "attribution_cells": attribution_cells(rows)}


def _models_of(row: Dict[str, Any]) -> List[str]:
    ran = (row.get("usage_detail") or {}).get("models_ran") or []
    if ran:
        return sorted(ran)
    return [row["model_used"]] if row.get("model_used") else []


def model_match(a: str, b: str) -> bool:
    a, b = a.lower(), b.lower()
    return a == b or a in b or b in a


def attribution_cells(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """One cell per (task, repeat) holding a loki row and a raw row. The cell is
    invalid, with a reason, when the models that actually ran differ: the
    loki-vs-raw comparison is then not an attribution of the harness."""
    cells: List[Dict[str, Any]] = []
    keys = sorted({(r.get("task"), r.get("repeat")) for r in rows},
                  key=lambda k: (str(k[0]), str(k[1])))
    for task, rep in keys:
        grp = [r for r in rows if r.get("task") == task and r.get("repeat") == rep]
        for loki, raw in ((lk, rw) for lk in grp if lk.get("arm") in LOKI_ARMS
                          for rw in grp if rw.get("arm") in RAW_ARMS):
            lm, rm = _models_of(loki), _models_of(raw)
            ok = bool(lm) and bool(rm) and all(
                any(model_match(x, y) for y in rm) for x in lm) and all(
                any(model_match(x, y) for y in lm) for x in rm)
            reason = None
            if not ok:
                reason = ("model mismatch: loki ran %s, %s ran %s"
                          % (lm or "unknown", raw["arm"], rm or "unknown"))
            cells.append({"task": task, "repeat": rep, "raw_arm": raw["arm"],
                          "loki_arm": arm_label(loki), "valid": ok, "reason": reason})
    return cells


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------

def ensure_task_venv(workdir: str) -> bool:
    """Create workdir/.venv (no pip, no network; system site-packages so pytest
    resolves) and exclude it from the repo. Returns True when .venv/bin/python
    exists afterwards. Never raises."""
    try:
        ex = os.path.join(workdir, ".git", "info", "exclude")
        os.makedirs(os.path.dirname(ex), exist_ok=True)
        with open(ex, "a") as fh:
            fh.write("/.venv/\n")
        venv = os.path.join(workdir, ".venv")
        if not os.path.exists(os.path.join(venv, "bin", "python")):
            subprocess.run([sys.executable, "-m", "venv", "--without-pip",
                            "--system-site-packages", venv],
                           check=True, capture_output=True, timeout=60)
    except Exception:  # noqa: BLE001
        pass
    return os.path.exists(os.path.join(workdir, ".venv", "bin", "python"))


def materialize_seed(task: Dict[str, Any], workdir: str) -> None:
    """Copy the seed into workdir and make it a fresh, identical git repo."""
    shutil.copytree(task["seed_dir"], workdir, dirs_exist_ok=True)
    env = _scoped_env({"GIT_AUTHOR_DATE": "2026-01-01T00:00:00Z",
                       "GIT_COMMITTER_DATE": "2026-01-01T00:00:00Z"})
    ident = ["-c", "user.name=attribution-bench", "-c", "user.email=bench@example.invalid"]
    # run_group.ts only parses `git remote get-url origin` against owner/repo (no
    # fetch), so a URL-only remote lets multi-unit specs start. The URL is only
    # parsed: the PR stage is disabled by --no-pr in the loki adapter, and any
    # stray fetch fails fast because the adapter turns credential prompts off.
    remote = "https://github.com/loki-bench/%s.git" % re.sub(
        r"[^A-Za-z0-9_.-]", "-", str(task.get("id") or "seed"))
    # Task .venv: a bare interpreter shim so the loki verify stage resolves a project
    # python (.venv/bin/python) instead of reporting not_run. Excluded before the seed
    # commit so it never enters a diff. Best effort: no venv means system python.
    subprocess.run(["git", "-C", workdir, "init", "-q"], check=True,
                   capture_output=True, env=env, timeout=60)
    ensure_task_venv(workdir)
    for args in (["add", "-A"], ident + ["commit", "-q", "-m", "seed"],
                 ["remote", "add", "origin", remote]):
        subprocess.run(["git", "-C", workdir] + args, check=True,
                       capture_output=True, env=env, timeout=60)


def grade(task: Dict[str, Any], workdir: str) -> Dict[str, Any]:
    """Copy the hidden acceptance files in AFTER the run, run them, exit 0 = pass."""
    _runner._apply_overlay(workdir, task["acceptance_dir"])
    try:
        rc, out, err = _base._run_reapable(
            shlex.split(task["acceptance_cmd"]), workdir,
            task["acceptance_timeout_s"], _scoped_env())
    except subprocess.TimeoutExpired:
        return {"passed": False, "rc": 124, "tail": "acceptance timeout"}
    except Exception as exc:  # noqa: BLE001
        return {"passed": False, "rc": 1, "tail": "grader error: %s" % exc}
    tail = ((out or "") + (err or "")).strip().splitlines()[-8:]
    return {"passed": rc == 0, "rc": rc, "tail": "\n".join(tail)}


def ledger_read(workdir: str) -> Tuple[Optional[float], int, int]:
    """(usd sum or None, invalid lines, unpriced lines) of the child-session ledger.
    Invalid = not a JSON object; unpriced = an object without a numeric usd."""
    path = os.path.join(workdir, LEDGER_REL)
    try:
        with open(path) as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None, 0, 0
    total, seen, invalid, unpriced = 0.0, False, 0, 0
    for ln in lines:
        if not ln.strip():
            continue
        try:
            rec = json.loads(ln)
        except ValueError:
            invalid += 1
            continue
        if not isinstance(rec, dict):
            invalid += 1
            continue
        v = rec.get("usd")
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            unpriced += 1
            continue
        total += float(v)
        seen = True
    return (round(total, 6) if seen else None), invalid, unpriced


def ledger_spend(workdir: str) -> Optional[float]:
    """Sum of `usd` over the child-session ledger, or None when absent/unreadable."""
    return ledger_read(workdir)[0]


def row_spend_is_partial(row: Dict[str, Any]) -> bool:
    """True when the row's reported cost is a lower bound (bench_schema.cost_is_partial,
    the one decision shared by every cost consumer)."""
    return _schema.cost_is_partial(row)


def row_true_spend(row: Dict[str, Any]) -> float:
    """Spend a row counts toward the cap: the larger of the tool-reported cost and
    the ledger sum, so a partial report can never hide child-session spend. When
    row_spend_is_partial(row) the value is a lower bound, not a complete total."""
    vals = [v for v in (row.get("cost_usd"), row.get("true_cost_usd")) if v is not None]
    return float(max(vals)) if vals else 0.0


def probe_bare(env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """raw-bare needs an API key: `claude --bare` skips OAuth and keychain reads."""
    e = os.environ if env is None else env
    if e.get("ANTHROPIC_API_KEY"):
        return {"available": True}
    return {"available": False,
            "reason": "raw-bare needs ANTHROPIC_API_KEY (claude --bare skips OAuth); "
                      "no fallback to raw-configured"}


def run_raw_claude(workdir: str, prompt: str, *, model: str, budget_usd: float,
                   timeout_s: int, runner: Optional[Callable] = None,
                   bare: bool = False, lean: bool = False) -> Dict[str, Any]:
    if lean and bare:
        raise ValueError("claude lean and bare are mutually exclusive")
    cmd = ["claude", "-p", prompt, "--output-format", "json", "--model", model,
           "--dangerously-skip-permissions", "--max-budget-usd", str(budget_usd)]
    if bare:
        cmd.append("--bare")
    if lean:
        cmd += list(_claude_adapter.LEAN_ARGS)
    rc, out, _err, status, dur = _base.run_cli(
        cmd, cwd=workdir, timeout=timeout_s, runner=runner,
        env={"LOKI_NO_BROWSER": "1"})
    cost, t_in, t_out, model_used = _claude_adapter._parse_json_result(out)
    is_error = False
    try:
        obj = json.loads((out or "").strip())
        is_error = bool(isinstance(obj, dict) and obj.get("is_error"))
    except Exception:  # noqa: BLE001
        pass
    return {
        "status": status, "rc": rc, "elapsed_s": dur,
        "reported_success": rc == 0 and not is_error,
        "cost_usd": cost, "cost_source": "claude_json.total_cost_usd" if cost is not None else None,
        "tokens_in": t_in, "tokens_out": t_out, "model_used": model_used or model,
        "usage_detail": _claude_adapter.parse_usage_detail(out),
        "command": "claude -p <prompt> --output-format json --model %s "
                   "--dangerously-skip-permissions --max-budget-usd %s%s"
                   % (model, budget_usd,
                      (" --bare" if bare else "")
                      + (" " + " ".join(_claude_adapter.LEAN_ARGS) if lean else "")),
    }


def run_loki(workdir: str, prompt_file: str, *, model: str, budget_usd: float,
             timeout_s: int, runner: Optional[Callable] = None,
             profile: Optional[str] = "off",
             lever_env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    prev = os.environ.get("LOKI_BUDGET_LIMIT")
    prev_model = os.environ.get("LOKI_SESSION_MODEL")
    os.environ["LOKI_BUDGET_LIMIT"] = str(budget_usd)
    # Force the pinned model for the loki arm even if the operator exported a
    # different LOKI_SESSION_MODEL; the adapter only pins when it is absent.
    os.environ["LOKI_SESSION_MODEL"] = model
    try:
        res = _loki_adapter.run(workdir, prompt_file, model=model,
                                timeout=timeout_s, runner=runner, provider="claude",
                                profile=profile, extra_env=lever_env)
    finally:
        if prev is None:
            os.environ.pop("LOKI_BUDGET_LIMIT", None)
        else:
            os.environ["LOKI_BUDGET_LIMIT"] = prev
        if prev_model is None:
            os.environ.pop("LOKI_SESSION_MODEL", None)
        else:
            os.environ["LOKI_SESSION_MODEL"] = prev_model
    prov = res.get("provenance") or {}
    status = res["exit_status"]
    rc = prov.get("rc")
    return {
        "status": status, "rc": rc,
        "elapsed_s": res["duration_s"],
        # Engine verdict: exit 0 is VERIFIED/success; anything else (including an
        # unknown rc) is not.
        "reported_success": rc == 0,
        "stderr_tail": prov.get("stderr_tail"),
        "stdout_tail": prov.get("stdout_tail"),
        "cost_usd": res["cost_usd"],
        "cost_partial": bool((res.get("provenance") or {}).get("cost_partial")),
        "cost_source": "loki.efficiency_cost" if res["cost_usd"] is not None else None,
        "tokens_in": res["tokens_in"], "tokens_out": res["tokens_out"],
        "model_used": res["model_used"], "iterations": res["iterations"],
        "verify_verdict": prov.get("verify_verdict"),
        "failure_reason": prov.get("failure_reason"),
        "honesty": prov.get("honesty"),
        "engine": prov.get("engine"),
        "loki_version": _loki_adapter.parse_loki_version(res.get("tool_version")),
        "cost_profile": prov.get("cost_profile"),
        "lever_env": prov.get("lever_env") or {},
        "cache_tokens_by_phase": prov.get("cache_tokens_by_phase"),
        "cost_by_phase": prov.get("cost_by_phase"),
        "group_cost": prov.get("group_cost"),
        "ledger": prov.get("ledger"),
        "command": prov.get("command"),
    }


def probe_droid(runner: Optional[Callable] = None) -> Dict[str, Any]:
    """Is `droid exec` usable here? Absent or failing means the arm is UNMEASURED."""
    rc, _out, _err, status, _dur = _base.run_cli(
        ["droid", "exec", "--help"], cwd=REPO_ROOT, timeout=30, runner=runner,
        env={"LOKI_NO_BROWSER": "1"})
    if status == "cli_not_found":
        return {"available": False, "reason": "droid CLI not found on PATH"}
    if rc != 0:
        return {"available": False, "reason": "`droid exec --help` exited %s" % rc}
    return {"available": True, "reason": None}


def run_droid(workdir: str, prompt: str, *, timeout_s: int,
              runner: Optional[Callable] = None) -> Dict[str, Any]:
    cmd = ["droid", "exec", "--auto", "high", prompt]
    rc, _out, _err, status, dur = _base.run_cli(
        cmd, cwd=workdir, timeout=timeout_s, runner=runner,
        env={"LOKI_NO_BROWSER": "1"})
    return {
        "status": status, "rc": rc, "elapsed_s": dur,
        "reported_success": rc == 0,
        "cost_usd": None, "cost_source": None,
        "tokens_in": None, "tokens_out": None, "model_used": None,
        "command": "droid exec --auto high <prompt>",
    }


EVIDENCE_SKIP_DIRS = ("node_modules", "cache", "caches", "worktrees", ".git", "__pycache__",
                      ".venv", "venv")
EVIDENCE_MAX_FILE_BYTES = 5 * 1024 * 1024


def _evidence_secret_name(name: str) -> bool:
    """True for names that may hold credentials. receipt*.json is the one exemption."""
    low = name.lower()
    if low.startswith("receipt") and low.endswith(".json"):
        return False
    return any(fnmatch.fnmatch(low, pat)
               for pat in ("*.env", "*token*", "*secret*", "*key*"))


def keep_evidence(workdir: str, dest: str, row: Dict[str, Any]) -> None:
    """Copy .loki/ (minus large caches) and the stderr tail out of a workdir that is
    about to be deleted. Best effort: evidence loss never fails a measured cell."""
    try:
        os.makedirs(dest, exist_ok=True)
        src = os.path.join(workdir, ".loki")
        if os.path.isdir(src):
            def _ignore(d: str, names: List[str]) -> List[str]:
                skip = [n for n in names if n in EVIDENCE_SKIP_DIRS]
                skip += [n for n in names if _evidence_secret_name(n)]
                for n in names:
                    fp = os.path.join(d, n)
                    try:
                        if (os.path.isfile(fp) and not os.path.islink(fp)
                                and os.path.getsize(fp) > EVIDENCE_MAX_FILE_BYTES):
                            skip.append(n)
                    except OSError:
                        skip.append(n)
                return skip
            shutil.copytree(src, os.path.join(dest, ".loki"), ignore=_ignore,
                            symlinks=True, dirs_exist_ok=True)
        tail = row.get("stderr_tail")
        if tail:
            with open(os.path.join(dest, "stderr.txt"), "w") as fh:
                fh.write(tail)
    except Exception as exc:  # noqa: BLE001
        # Loss stays non-fatal but visible: the row says evidence is incomplete.
        row["evidence_error"] = str(exc)[:200]


def run_cell(task: Dict[str, Any], arm: str, repeat: int, *, model: str,
             budget_usd: float, timeout_s: int, scratch: str,
             runner: Optional[Callable] = None,
             droid_probe: Optional[Dict[str, Any]] = None,
             bare_probe: Optional[Dict[str, Any]] = None,
             evidence_dir: Optional[str] = None,
             loki_env: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    row: Dict[str, Any] = {"task": task["id"], "class": task["class"], "arm": arm,
                           "repeat": repeat, "accepted": False,
                           "reported_success": False}
    if arm in LOKI_ARMS:
        # Stamped before the run so unmeasured and failed rows still key correctly.
        row["cost_profile"] = LOKI_ARM_PROFILE[arm]
        row["lever_env"] = dict(loki_env or {})
    if arm == "droid" and not (droid_probe and droid_probe.get("available")):
        # Never run, never graded: an unavailable arm is UNMEASURED, not a failure.
        row.update({"status": "unmeasured", "cost_usd": None, "elapsed_s": None,
                    "unmeasured_reason": (droid_probe or {}).get(
                        "reason", "droid availability not probed")})
        return row
    if arm == "raw-bare" and not (bare_probe and bare_probe.get("available")):
        row.update({"status": "unmeasured", "cost_usd": None, "elapsed_s": None,
                    "unmeasured_reason": (bare_probe or {}).get(
                        "reason", "raw-bare availability not probed")})
        return row
    workdir = os.path.join(scratch, "%s-%s-%d" % (task["id"], arm, repeat))
    try:
        materialize_seed(task, workdir)
        cap = task.get("agent_timeout_s")
        eff_timeout = min(timeout_s, cap) if cap else timeout_s
        if arm == "droid":
            res = run_droid(workdir, task["prompt"], timeout_s=eff_timeout,
                            runner=runner)
        elif arm in RAW_ARMS:
            res = run_raw_claude(workdir, task["prompt"], model=model,
                                 budget_usd=budget_usd, timeout_s=eff_timeout,
                                 runner=runner, bare=(arm == "raw-bare"),
                                 lean=(arm == "raw-lean"))
        else:
            # PRD lives OUTSIDE the workspace so it is not part of the repo.
            pf = os.path.join(scratch, "%s-%d.prd.md" % (task["id"], repeat))
            with open(pf, "w") as fh:
                fh.write(task["prompt"])
            res = run_loki(workdir, pf, model=model, budget_usd=budget_usd,
                           timeout_s=eff_timeout, runner=runner,
                           profile=LOKI_ARM_PROFILE[arm], lever_env=loki_env)
        row.update(res)
        led = ledger_spend(workdir)
        if led is not None:
            row["true_cost_usd"] = led
        g = grade(task, workdir)
        row["accepted"] = bool(g["passed"])
        row["acceptance"] = {"rc": g["rc"], "tail": g["tail"]}
    except Exception as exc:  # noqa: BLE001 - a harness failure stays in the denominator
        row["status"] = "harness_error"
        row["error"] = str(exc)
        row.setdefault("cost_usd", None)
        row.setdefault("elapsed_s", None)
    finally:
        if evidence_dir:
            keep_evidence(workdir, os.path.join(evidence_dir, os.path.basename(workdir)), row)
        shutil.rmtree(workdir, ignore_errors=True)
    return row


def run_all(tasks: List[Dict[str, Any]], plan: Dict[str, Any],
            runner: Optional[Callable] = None,
            progress: Callable[[str], None] = lambda s: None,
            droid_probe: Optional[Dict[str, Any]] = None,
            bare_probe: Optional[Dict[str, Any]] = None,
            max_spend_usd: Optional[float] = None,
            evidence_dir: Optional[str] = None,
            loki_env: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
    by_id = {t["id"]: t for t in tasks}
    scratch = tempfile.mkdtemp(prefix="loki-attr-")
    rows: List[Dict[str, Any]] = []
    try:
        spent = 0.0
        lower_bound = False
        for cell in plan["cells"]:
            if max_spend_usd is not None and spent >= max_spend_usd:
                # Abort before the next run; the cell stays in the table as UNMEASURED.
                t = by_id[cell["task"]]
                rows.append({"task": t["id"], "class": t["class"], "arm": cell["arm"],
                             "repeat": cell["repeat"], "accepted": False,
                             "reported_success": False, "status": "unmeasured",
                             "cost_usd": None, "elapsed_s": None,
                             **({"cost_profile": LOKI_ARM_PROFILE[cell["arm"]],
                                 "lever_env": dict(loki_env or {})}
                                if cell["arm"] in LOKI_ARMS else {}),
                             "unmeasured_reason": "spend cap reached: true spend %.4f USD%s >= "
                                                  "--max-spend-usd %s"
                                                  % (spent, " (lower bound)" if lower_bound else "",
                                                     max_spend_usd)})
                continue
            progress("run %s %s #%d" % (cell["task"], cell["arm"], cell["repeat"]))
            rows.append(run_cell(by_id[cell["task"]], cell["arm"], cell["repeat"],
                                 model=plan["model"], budget_usd=plan["budget_usd"],
                                 timeout_s=plan["timeout_s"], scratch=scratch,
                                 runner=runner, droid_probe=droid_probe,
                                 bare_probe=bare_probe, evidence_dir=evidence_dir,
                                 loki_env=loki_env))
            spent += row_true_spend(rows[-1])
            lower_bound = lower_bound or row_spend_is_partial(rows[-1])
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return rows


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def _fmt(v: Any, pct: bool = False, usd: bool = False, secs: bool = False) -> str:
    if v is None:
        return "n/a"
    if pct:
        return "%.1f%%" % (v * 100)
    if usd:
        return "$%.4f" % v
    if secs:
        return "%.1fs" % v
    return str(v)


def _cost_cell(m: Dict[str, Any]) -> str:
    s = m["cost_status"]
    if s == "measured":
        return _fmt(m["cost_per_accepted_usd"], usd=True)
    if s == "partial_lower_bound":
        return ">= %s (%d runs unmeasured)" % (
            _fmt(m["cost_per_accepted_lower_bound_usd"], usd=True),
            m["runs_with_unmeasured_cost"])
    if s == "undefined_no_accepted":
        return "undefined (none accepted)"
    return "unmeasured"


def _ci(m: Dict[str, Any]) -> str:
    ci = m.get("acceptance_rate_ci95")
    return "n/a" if not ci else "%.0f-%.0f%%" % (ci[0] * 100, ci[1] * 100)


def render_markdown(result: Dict[str, Any]) -> str:
    plan, env, rows = result["plan"], result["environment"], result["rows"]
    summ = result["summary"]
    L: List[str] = []
    L.append("# Harness attribution benchmark: Loki vs raw Claude Code")
    L.append("")
    L.append("Generated: %s. This is a pilot; small n is not statistical proof." % result["generated_utc"])
    L.append("")
    L.append("Metric definitions (accepted outcome, misleading completion = false_completion, cost per accepted, waited vs active minutes) are shared with `loki trust`: see \"Outcome analytics\" in docs/EVALUATING.md.")
    L.append("")
    L.append("## Pinned conditions")
    L.append("")
    L.append("- Model id (claude arms): `%s`" % plan["model"])
    L.append("- Budget per run: $%s; wall-clock cap per run: %ss; repeats: %d" % (
        plan["budget_usd"], plan["timeout_s"], plan["repeats"]))
    L.append("- Claude Code version: %s" % (env.get("claude_version") or "not recorded"))
    L.append("- Loki version: %s; Loki repo SHA: %s" % (
        env.get("loki_version") or "not recorded", env.get("loki_repo_sha") or "not recorded"))
    L.append("- Tasks: %s" % ", ".join("%s (seed %s, acceptance %s)" % (
        t["id"], t["seed_sha256"][:8], t["acceptance_sha256"][:8]) for t in plan["tasks"]))
    L.append("")
    L.append("## Summary by arm")
    L.append("")
    L.append("| Arm | Assigned | Accepted | Acceptance rate (95% CI) | Reported success | False-completion rate | Completion rate | Timeouts | Errors | Cost per accepted | Median time to accepted |")
    L.append("|---|---|---|---|---|---|---|---|---|---|---|")
    for arm in plan["arms"]:
        m = summ["by_arm"][arm]
        if m.get("unmeasured_runs"):
            L.append("| %s | %d | UNMEASURED | UNMEASURED (%d of %d runs not measured) | - | - | - | - | - | unmeasured | - |" % (
                arm, m["assigned"], m["unmeasured_runs"], m["assigned"]))
            continue
        L.append("| %s | %d | %d | %s (%s) | %d | %s | %s | %d | %d | %s | %s |" % (
            arm, m["assigned"], m["accepted"], _fmt(m["acceptance_rate"], pct=True), _ci(m),
            m["reported_success"], _fmt(m["false_completion_rate"], pct=True),
            _fmt(m["completion_rate"], pct=True), m["timeouts"], m["errors"],
            _cost_cell(m), _fmt(m["elapsed_median_accepted_s"], secs=True)))
    L.append("")
    L.append("Failures, timeouts and harness errors of measured runs are included in every denominator; unmeasured runs are excluded from all rates. "
             "Cost totals cover all attempts, not only accepted ones.")
    L.append("")
    L.append("## Summary by task class")
    L.append("")
    L.append("| Class | Arm | Assigned | Accepted | Acceptance rate | False-completion rate |")
    L.append("|---|---|---|---|---|---|")
    for c, per in summ["by_class"].items():
        for arm in plan["arms"]:
            m = per[arm]
            if m.get("unmeasured_runs"):
                L.append("| %s | %s | %d | UNMEASURED | UNMEASURED | UNMEASURED |" % (
                    c, arm, m["assigned"]))
                continue
            L.append("| %s | %s | %d | %d | %s | %s |" % (
                c, arm, m["assigned"], m["accepted"],
                _fmt(m["acceptance_rate"], pct=True),
                _fmt(m["false_completion_rate"], pct=True)))
    L.append("")
    L.append("## Task-level results")
    L.append("")
    L.append("| Task | Class | Arm | Run | Status | Reported success | Accepted | Elapsed | Cost |")
    L.append("|---|---|---|---|---|---|---|---|---|")
    for r in rows:
        cost = ("unmeasured" if r.get("cost_usd") is None else _fmt(r["cost_usd"], usd=True))
        if r.get("cost_usd") is not None and row_spend_is_partial(r):
            cost = ">= " + cost
        unm = r.get("status") == "unmeasured"
        L.append("| %s | %s | %s | %d | %s | %s | %s | %s | %s |" % (
            r["task"], r["class"], r["arm"], r["repeat"], r.get("status", "n/a"),
            "-" if unm else ("yes" if r.get("reported_success") else "no"),
            "-" if unm else ("yes" if r.get("accepted") else "no"),
            _fmt(r.get("elapsed_s"), secs=True), cost))
    L.append("")
    L.append("## Disclosures")
    L.append("")
    L.append("- Baselines: `raw-configured` is `claude -p` with this host's hooks, skills and "
             "CLAUDE.md loaded (it carries that host's context cost); `raw-bare` is `claude -p --bare` and "
             "is the floor. Cost ratios are reported against both, never only the favorable one.")
    L.append("- Cost: `cost_usd` is what each tool reported; `true_cost_usd` is the Loki "
             "child-session ledger sum. Spend caps use the larger of the two.")
    L.append("- Reported success: raw arms are `claude -p` exit 0 with is_error false; "
             "Loki arm is `loki start` exit 0. Acceptance is the held-out test only.")
    L.append("- Unmeasured cost is reported as unmeasured, never as zero. Subscription "
             "usage and API dollars are not interchangeable; costs here are API-dollar "
             "figures reported by each tool.")
    reasons = sorted({r["unmeasured_reason"] for r in rows if r.get("unmeasured_reason")})
    for why in reasons:
        L.append("- UNMEASURED arm cells: %s. They are not counted as failures and no "
                 "rate is published for that arm." % why)
    if "droid" in plan["arms"]:
        L.append("- The droid arm uses its own model and settings, not the pinned model; "
                 "its flags were not verified against a live run here.")
    L.append("- Human effort, recovery success and review quality are not measured by this harness.")
    L.append("- Known unavoidable difference: Loki receives the prompt as a PRD file; "
             "raw Claude receives it inline.")
    return "\n".join(L) + "\n"


COST_TARGET_FRACTION = 0.5
COST_FLOORS = ("raw-configured", "raw-bare", "raw-lean")


def _result_rows(out_dir: str) -> List[Dict[str, Any]]:
    """Rows of every attribution-<stamp>.json in out_dir. Each row's spend is the
    larger of the reported cost and the child-session ledger kept in the matching
    evidence dir, when that ledger exists. Unmeasured stays None, never zero."""
    rows: List[Dict[str, Any]] = []
    try:
        names = sorted(os.listdir(out_dir))
    except OSError:
        return rows
    for name in names:
        if not (name.startswith("attribution-") and name.endswith(".json")):
            continue
        try:
            with open(os.path.join(out_dir, name)) as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            continue
        stamp = name[len("attribution-"):-len(".json")]
        for r in data.get("rows", []) if isinstance(data, dict) else []:
            r = dict(r)
            ev = os.path.join(out_dir, "evidence-%s" % stamp,
                              "%s-%s-%d" % (r.get("task"), r.get("arm"), r.get("repeat", 1)))
            led, bad, unpriced = ledger_read(ev)
            vals = [v for v in (r.get("cost_usd"), r.get("true_cost_usd"), led)
                    if v is not None]
            if _schema.cost_is_partial(r, ledger_usd=led, ledger_invalid=bad,
                                       ledger_unpriced=unpriced):
                r["cost_partial"] = True
            r["cost_usd"] = float(max(vals)) if vals else None
            rows.append(r)
    return rows


def _verdict_lines(rows: List[Dict[str, Any]], labels: List[str]) -> List[str]:
    """One TEN-COST-03 verdict line per Loki label against each floor that has
    rows. Floor rows carry no engine or loki_version, so they inherit the Loki
    rows' value only when those rows agree on exactly one; mixed or missing
    values stay None and the verdict reports them."""
    out: List[str] = []
    for lab in labels:
        if lab.split("+", 1)[0] not in LOKI_ARMS:
            continue
        loki = [_cost_claim._map_row(r) for r in rows if arm_label(r) == lab]
        if not loki:
            continue
        stamps = {}
        for key in ("engine", "loki_version"):
            vals = {r.get(key) for r in loki}
            stamps[key] = next(iter(vals)) if len(vals) == 1 else None
        for f in COST_FLOORS:
            floor = [dict(_cost_claim._map_row(r), **stamps)
                     for r in rows if arm_label(r) == f]
            if not floor:
                continue
            v = _cost_claim.cost_claim_verdict(loki, floor, COST_TARGET_FRACTION)
            ci = ("ratio %.2fx, CI95 [%.2f, %.2f]" % (v["ratio"], v["ci_low"], v["ci_high"])
                  if v["ratio"] is not None else "ratio not computable")
            why = "; reasons: " + " | ".join(v["reasons"]) if v["reasons"] else ""
            out.append("verdict %s vs %s (target %.1fx): %s (%s; %s)%s"
                       % (lab, f, COST_TARGET_FRACTION, v["verdict"], ci,
                          _cost_fields(v), why))
    return out


def _cost_fields(v: Dict[str, Any]) -> str:
    """Metered share, cost per accepted (failed attempts included) and the
    console reconciliation of one verdict; an unmetered arm shows a lower bound."""
    def share(c: Dict[str, Any]) -> str:
        return "n/a" if c["metered_share"] is None else "%.2f" % c["metered_share"]

    def cpa(c: Dict[str, Any]) -> str:
        if c["cost_per_accepted_usd"] is not None:
            return "$%.4f" % c["cost_per_accepted_usd"]
        if c["cost_per_accepted_lower_bound_usd"] is not None:
            return ">= $%.4f lower bound" % c["cost_per_accepted_lower_bound_usd"]
        return "undefined"

    lk, fl = v["arm_cost"]["loki"], v["arm_cost"]["floor"]
    rec = v["reconciliation_error"]
    rec = rec if isinstance(rec, str) else "%+.2f%%" % (100 * rec)
    return ("metered loki %s, floor %s; per accepted loki %s, floor %s; "
            "reconciliation %s" % (share(lk), share(fl), cpa(lk), cpa(fl), rec))


def render_cost_table(out_dir: str, arms: Tuple[str, ...] = ARMS) -> str:
    """Cost per accepted task per arm from existing result files. No model call.
    Ratios are against every raw floor; 'target' is COST_TARGET_FRACTION of the
    floor. Rows pool by arm_label, so a different lever config is its own line."""
    rows = _result_rows(out_dir)
    L = ["cost per accepted task (from existing results in %s)" % out_dir]
    if not rows:
        L.append("  no result files found; nothing measured")
        return "\n".join(L) + "\n"
    labels = _labels(rows, arms)
    met = {a: compute_metrics([r for r in rows if arm_label(r) == a])
           for a in labels + [f for f in COST_FLOORS if f not in labels]}

    def per_acc(a: str) -> Optional[float]:
        return met[a]["cost_per_accepted_usd"] if a in met else None

    def ratio(num: Optional[float], den: Optional[float], scale: float = 1.0) -> str:
        if num is None or not den:
            return "unmeasured"
        return "%.2fx" % (num / (den * scale))

    head = ["Arm", "Accepted", "Total USD", "USD per accepted"]
    head += ["vs %s" % f for f in COST_FLOORS]
    head += ["vs %.1fx target (%s)" % (COST_TARGET_FRACTION, f) for f in COST_FLOORS]
    L.append("| " + " | ".join(head) + " |")
    L.append("|" + "---|" * len(head))
    for a in labels:
        m = met[a]
        if m["assigned"] == 0 or m["unmeasured_runs"] == m["assigned"]:
            L.append("| %s | %s |" % (a, " | ".join(["unmeasured"] * (len(head) - 1))))
            continue
        if m["cost_status"] == "undefined_no_accepted":
            usd = "undefined (none accepted)"
        elif m["cost_status"] == "measured":
            usd = _fmt(m["cost_per_accepted_usd"], usd=True)
        else:
            usd = _cost_cell(m)
        cells = [ratio(per_acc(a), per_acc(f)) for f in COST_FLOORS]
        cells += [ratio(per_acc(a), per_acc(f), COST_TARGET_FRACTION) for f in COST_FLOORS]
        L.append("| %s | %d | %s | %s | %s |" % (
            a, m["accepted"], _fmt(m["spend_measured_usd"], usd=True), usd,
            " | ".join(cells)))
    L.append("Ratios are arm / floor cost per accepted; target ratio is arm / (%.1f * floor), "
             "so <= 1.00x meets the target. Every floor is always shown." % COST_TARGET_FRACTION)
    L.extend(_verdict_lines(rows, labels))
    if any(r.get("arm") == "droid" and r.get("cost_usd") is None for r in rows):
        L.append("droid arm: cost_usd is None (no provider-reported cost), so any cost "
                 "claim that includes it stays INVALID.")
    return "\n".join(L) + "\n"


def print_plan(plan: Dict[str, Any], env: Dict[str, Any], warnings: List[str]) -> None:
    print("attribution plan (DRY RUN: no model call is made)")
    print("  model (claude arms): %s" % plan["model"])
    print("  budget per run: $%s   timeout per run: %ss   repeats: %d"
          % (plan["budget_usd"], plan["timeout_s"], plan["repeats"]))
    print("  arms: %s" % ", ".join(plan["arms"]))
    if plan.get("loki_env"):
        print("  loki lever env (ablation, loki arms only): %s" % ", ".join(
            "%s=%s" % kv for kv in sorted(plan["loki_env"].items())))
    print("  tasks (%d):" % len(plan["tasks"]))
    for t in plan["tasks"]:
        print("    %-28s %-12s seed=%s acceptance=%s" % (
            t["id"], t["class"], t["seed_sha256"][:8], t["acceptance_sha256"][:8]))
    print("  cells in run order (%d model-backed runs would execute):" % plan["model_calls_planned"])
    for c in plan["cells"]:
        prof = "  cost_profile=%s" % c["cost_profile"] if "cost_profile" in c else ""
        print("    %-28s %-14s run %d%s" % (c["task"], c["arm"], c["repeat"], prof))
    if plan.get("droid_cells_planned"):
        print("  droid arm: %d cells, availability not probed in dry run; an absent "
              "`droid exec` records UNMEASURED, never zero" % plan["droid_cells_planned"])
    print("  tool versions: %s" % ("probed" if env.get("probed") else "not probed in dry run"))
    for w in warnings:
        print("  warning: %s" % w)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_loki_env(items: List[str]) -> Dict[str, str]:
    """Parse repeated KEY=VALUE ablation flags. Only LOKI_* keys pass; keys the
    arm or the model pin own are refused, so an ablation cannot silently change
    the profile or the pinned model."""
    out: Dict[str, str] = {}
    for item in items:
        key, sep, val = item.partition("=")
        if not sep or not LEVER_ENV_KEY.match(key):
            raise ValueError("%r must be LOKI_<NAME>=<value>" % item)
        if key in LEVER_ENV_RESERVED:
            raise ValueError("%s is set by the arm or the model pin, not by --loki-env" % key)
        if key in out and out[key] != val:
            raise ValueError("%s given twice with different values" % key)
        out[key] = val
    return out


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="loki bench attribution",
        description="Same-model harness attribution: raw Claude Code vs Loki.")
    p.add_argument("--dry-run", action="store_true",
                   help="validate the task set and print the plan; no model call")
    p.add_argument("--execute", action="store_true",
                   help="really run the model-backed cells (spends money); "
                        "without it the command only prints the plan")
    p.add_argument("--report", metavar="RESULT_JSON",
                   help="re-render the markdown report from a result json")
    p.add_argument("--tasks", default="", help="comma-separated task ids (default: all)")
    p.add_argument("--tasks-dir", default=DEFAULT_TASKS_DIR)
    p.add_argument("--arms", default=",".join(ARMS),
                   help="comma-separated arms from %s (default: %s)"
                        % (",".join(ALL_ARMS), ",".join(ARMS)))
    p.add_argument("--loki-env", action="append", default=[], metavar="KEY=VALUE",
                   help="repeatable one-lever ablation env for the loki arms; "
                        "KEY must be LOKI_* (not LOKI_COST_PROFILE, "
                        "LOKI_SESSION_MODEL or LOKI_BUDGET_LIMIT)")
    p.add_argument("--repeats", type=int, default=1)
    p.add_argument("--model", default=os.environ.get("LOKI_BENCH_MODEL", DEFAULT_MODEL),
                   help="exact model id used by the claude arms (default %s)" % DEFAULT_MODEL)
    p.add_argument("--budget-usd", type=float, default=DEFAULT_BUDGET_USD)
    p.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_S)
    p.add_argument("--max-spend-usd", type=float, default=None,
                   help="abort before the next run once cumulative true spend "
                        "(max of reported cost and child-session ledger) reaches this")
    p.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    return p


def main(argv: Optional[List[str]] = None, runner: Optional[Callable] = None) -> int:
    args = _parser().parse_args(argv)
    if args.report:
        with open(args.report) as fh:
            result = json.load(fh)
        sys.stdout.write(render_markdown(result))
        return 0
    if args.repeats < 1 or args.budget_usd <= 0 or args.timeout < 1:
        print("repeats, budget-usd and timeout must be positive", file=sys.stderr)
        return 2
    if args.max_spend_usd is not None and args.max_spend_usd <= 0:
        print("--max-spend-usd must be positive", file=sys.stderr)
        return 2
    arms = tuple(a for a in args.arms.split(",") if a)
    if not arms or any(a not in ALL_ARMS for a in arms) or len(set(arms)) != len(arms):
        print("--arms must be unique names from %s" % ",".join(ALL_ARMS), file=sys.stderr)
        return 2
    try:
        loki_env = parse_loki_env(args.loki_env)
    except ValueError as exc:
        print("--loki-env: %s" % exc, file=sys.stderr)
        return 2
    if loki_env and not set(arms) & set(LOKI_ARMS):
        print("--loki-env needs a loki arm in --arms (loki or loki-lean)", file=sys.stderr)
        return 2
    only = [s for s in args.tasks.split(",") if s] or None
    tasks, errors, warnings = load_tasks(args.tasks_dir, only)
    if errors or not tasks:
        for e in errors or ["no tasks found in %s" % args.tasks_dir]:
            print("task set invalid: %s" % e, file=sys.stderr)
        return 2
    plan = build_plan(tasks, args.repeats, args.model, args.budget_usd, args.timeout,
                      arms, loki_env)
    execute = args.execute and not args.dry_run
    env = pin_environment(probe=execute, runner=runner, model=args.model)
    if not execute:
        print_plan(plan, env, warnings)
        if args.dry_run:
            print(render_cost_table(args.out_dir), end="")
        if not args.dry_run:
            print("  pass --execute to run these cells for real (spends API budget)")
        return 0
    identity = _schema.identity_env_problems(env)
    if identity:
        print("INVALID environment, refusing to spend: %s" % "; ".join(identity),
              file=sys.stderr)
        return 2
    if set(arms) & set(LOKI_ARMS):
        mismatch = _loki_adapter.version_mismatch_error(env.get("loki_version"))
        if mismatch:
            print(mismatch, file=sys.stderr)
            return 2
    if set(arms) & set(MODEL_PINNED_ARMS) and not env.get("claude_version"):
        print("claude CLI not found or not runnable; cannot run the benchmark", file=sys.stderr)
        return 2
    droid_probe = probe_droid(runner=runner) if "droid" in arms else None
    env["droid"] = droid_probe
    bare_probe = probe_bare() if "raw-bare" in arms else None
    env["raw_bare"] = bare_probe
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    evidence_dir = os.path.join(args.out_dir, "evidence-%s" % stamp)
    rows = run_all(tasks, plan, runner=runner, evidence_dir=evidence_dir,
                   progress=lambda s: print(s, file=sys.stderr),
                   droid_probe=droid_probe, bare_probe=bare_probe,
                   max_spend_usd=args.max_spend_usd, loki_env=loki_env)
    result = {
        "schema_version": SCHEMA_VERSION,
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "plan": plan, "environment": env, "warnings": warnings,
        "max_spend_usd": args.max_spend_usd,
        "true_spend_usd": round(sum(row_true_spend(r) for r in rows), 6),
        "true_spend_is_lower_bound": any(row_spend_is_partial(r) for r in rows),
        "rows": rows, "summary": summarize(rows, arms),
    }
    os.makedirs(args.out_dir, exist_ok=True)
    jpath = os.path.join(args.out_dir, "attribution-%s.json" % stamp)
    mpath = os.path.join(args.out_dir, "attribution-%s.md" % stamp)
    with open(jpath, "w") as fh:
        json.dump(result, fh, indent=2)
    with open(mpath, "w") as fh:
        fh.write(render_markdown(result))
    print("json:   %s" % jpath)
    print("report: %s" % mpath)
    return 0


if __name__ == "__main__":
    sys.exit(main())
