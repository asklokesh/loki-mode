#!/usr/bin/env python3
"""benchmarks/bench/bench_schema.py -- FROZEN schemas for the R2 benchmark harness.

This module is the CONTRACT. Slice A (task-spec + public-subset loader),
Slice B (runner + grader + cmd_bench), Slice C (adapters + efficiency + prices),
and Slice D (report + methodology) all build against these definitions. Do not
change a field name or type without updating SCHEMA_VERSION and every slice.

THREE schemas live here:

  1. task-spec       -- a benchmark task: fixture + prompt + held-out acceptance.
  2. adapter-output  -- what an adapter returns after running a tool on a workdir.
  3. result-row      -- one task x one tool, N trials, with grader verdicts.

CREDIBILITY INVARIANT (the whole point of R2):
  Loki NEVER grades its own success. An adapter runs a tool and reports cost +
  provenance ONLY. It NEVER reports success/quality/passed/score. The GRADER
  (runner.grade) runs the held-out acceptance command OUTSIDE the agent, on the
  produced repo state, and sets success = (exit code == 0). quality (lint/tests)
  is a separate, non-gating signal. No council / RARV-C / LLM-judge anywhere in
  scoring.

This invariant is ENFORCED, not merely documented: validate_adapter_output()
REJECTS an adapter-output dict that carries any forbidden judgment key. That
converts "Loki never grades itself" from a convention into a code invariant.

task_hash is the reproducibility anchor. compute_task_hash() is defined here ONCE
and imported by the runner (to stamp results) and by `loki bench verify` (to
recompute and check). It MUST be deterministic across machines:
  - spec / acceptance / model are canonicalized via _canonical (matches
    proof-generator.py: json.dumps(sort_keys=True, separators=(",", ":"))).
  - the fixture dir is hashed as sorted relative POSIX paths + each file's raw
    bytes, excluding .git / .loki / node_modules / __pycache__, binary-safe.
"""

from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Dict, List, Optional, Tuple

# Bump on ANY breaking schema change. Stamped into every result-row.
SCHEMA_VERSION = "1.0"

# Directories never folded into the fixture hash (volatile / generated state).
_FIXTURE_EXCLUDE_DIRS = {".git", ".loki", "node_modules", "__pycache__"}


# ---------------------------------------------------------------------------
# canonicalization (must match proof-generator.py:_canonical byte-for-byte)
# ---------------------------------------------------------------------------

def _canonical(obj: Any) -> str:
    """Deterministic JSON serialization. Identical to proof-generator's form."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


# ---------------------------------------------------------------------------
# 1. task-spec
# ---------------------------------------------------------------------------
# A single benchmark task. The fixture is copied into a fresh workdir, the agent
# is handed `prompt`, and after it finishes the held-out `acceptance` command is
# run IN that workdir by the grader. Success = acceptance exit code 0.
#
# {
#   "schema_version": "1.0",
#   "id": "swebench-verified-django-12345",   # stable, used by `verify` to relocate
#   "source": "swe-bench-verified",           # provenance of the task (public set)
#   "source_ref": "django__django-12345",     # upstream instance id / citation
#   "title": "human-readable one-liner",
#   "fixture": "fixtures/django-12345",        # rel path (to this spec) of the repo seed
#   "prompt": "Fix the bug where ...",          # what the agent is asked to do
#   "acceptance": {                             # HELD-OUT, run by the grader only
#       "cmd": "python -m pytest tests/foo.py -q",  # success iff exit == 0
#       "timeout_s": 300,                       # grader-side wall-clock cap
#       "overlay": "acceptance/django-12345",   # OPTIONAL: dir of held-out test
#                                               # files the grader copies INTO the
#                                               # workdir AFTER the agent finishes
#                                               # but BEFORE running cmd. This is
#                                               # how the agent is prevented from
#                                               # editing the test to pass (the
#                                               # SWE-bench test-patch pattern).
#       "setup_cmd": "pip install -e ."         # OPTIONAL: run after overlay,
#                                               # before cmd (deps/build). Its
#                                               # exit code does NOT set success.
#   },
#   "quality": {                                # OPTIONAL non-gating signals
#       "lint_cmd": "ruff check .",             # may be null/absent
#       "test_cmd": "python -m pytest -q"       # may be null/absent
#   },
#   "default_model": "claude-sonnet-4-5",       # folded into task_hash
#   "agent_timeout_s": 1800                      # cap on the adapter / tool run
# }

TASK_SPEC_REQUIRED = ("id", "source", "fixture", "prompt", "acceptance", "default_model")


def validate_task_spec(spec: Dict[str, Any]) -> List[str]:
    """Return a list of human-readable problems. Empty list == valid."""
    errs: List[str] = []
    if not isinstance(spec, dict):
        return ["task-spec must be a JSON object"]
    for k in TASK_SPEC_REQUIRED:
        if k not in spec:
            errs.append(f"task-spec missing required key: {k}")
    for k in ("id", "source", "fixture", "prompt", "default_model"):
        if k in spec and not isinstance(spec[k], str):
            errs.append(f"task-spec.{k} must be a string")
    acc = spec.get("acceptance")
    if not isinstance(acc, dict):
        errs.append("task-spec.acceptance must be an object")
    else:
        if not isinstance(acc.get("cmd"), str) or not acc.get("cmd").strip():
            errs.append("task-spec.acceptance.cmd must be a non-empty string")
        if "timeout_s" in acc and not isinstance(acc["timeout_s"], int):
            errs.append("task-spec.acceptance.timeout_s must be an int")
    q = spec.get("quality")
    if q is not None and not isinstance(q, dict):
        errs.append("task-spec.quality must be an object or absent")
    if "agent_timeout_s" in spec and not isinstance(spec["agent_timeout_s"], int):
        errs.append("task-spec.agent_timeout_s must be an int")
    return errs


# ---------------------------------------------------------------------------
# task_hash -- the reproducibility anchor (defined ONCE, imported everywhere)
# ---------------------------------------------------------------------------

def _hash_fixture_dir(fixture_dir: str) -> str:
    """sha256 over sorted (rel POSIX path, raw bytes) of every fixture file.

    Deterministic across machines: paths are sorted, separators normalized to
    "/", excluded dirs pruned, files read in binary. A missing fixture dir
    hashes to the digest of the empty stream (stable, not an error here; the
    caller decides whether absence is acceptable).
    """
    h = hashlib.sha256()
    if not os.path.isdir(fixture_dir):
        return h.hexdigest()
    entries: List[Tuple[str, str]] = []
    for root, dirs, files in os.walk(fixture_dir):
        dirs[:] = sorted(d for d in dirs if d not in _FIXTURE_EXCLUDE_DIRS)
        for fn in files:
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, fixture_dir)
            rel_posix = rel.replace(os.sep, "/")
            entries.append((rel_posix, full))
    for rel_posix, full in sorted(entries, key=lambda t: t[0]):
        h.update(rel_posix.encode("utf-8"))
        h.update(b"\x00")
        try:
            with open(full, "rb") as fh:
                h.update(fh.read())
        except OSError:
            # Unreadable file: fold its path only, deterministically.
            h.update(b"<unreadable>")
        h.update(b"\x00")
    return h.hexdigest()


def compute_task_hash(spec: Dict[str, Any], fixture_dir: str) -> str:
    """sha256 of the task identity: spec body + acceptance + fixture + model.

    spec is the FULL task-spec dict (it already carries acceptance + model).
    fixture_dir is the resolved absolute/real directory the fixture lives in.

    The hash deliberately covers:
      - the canonical spec (prompt, acceptance, quality, ids, model, ...)
      - the fixture tree contents (so a fixture edit invalidates old results)
    Two runs of the same task on the same fixture + model produce the same hash;
    `loki bench verify` recomputes it and refuses results whose inputs drifted.
    """
    fixture_digest = _hash_fixture_dir(fixture_dir)
    payload = {
        "schema_version": SCHEMA_VERSION,
        "spec": spec,
        "fixture_sha256": fixture_digest,
    }
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 2. adapter-output
# ---------------------------------------------------------------------------
# What an adapter returns to the runner. THE ADAPTER NEVER JUDGES OUTCOME.
#
# {
#   "tool": "loki",                  # tool identifier
#   "tool_version": "7.10.0",        # pinned version string (verify re-checks)
#   "model_used": "claude-sonnet-4-5",
#   "duration_s": 412.3,             # wall-clock of the agent run
#   "iterations": 6,                 # tool-reported iteration count (0 if n/a)
#   "tokens_in": 120000,             # may be null when unknown
#   "tokens_out": 45000,             # may be null when unknown
#   "cost_usd": 0.83 | null,         # null == NOT collected (never coerce to 0)
#   "cache_read_tokens": 0,          # optional, default 0
#   "cache_creation_tokens": 0,      # optional, default 0
#   "exit_status": "completed",      # completed | timeout | error_rc_N
#   "provenance": {                  # how this number was produced (free-form)
#       "command": "...", "verified": true, "notes": "..."
#   }
# }

ADAPTER_OUTPUT_REQUIRED = (
    "tool", "tool_version", "model_used", "duration_s",
    "exit_status", "provenance",
)

# Keys an adapter is STRUCTURALLY FORBIDDEN from carrying. If any appear,
# validate_adapter_output() rejects the dict. This is the code-enforced version
# of "Loki never grades its own success" -- only the grader decides outcome.
ADAPTER_FORBIDDEN_KEYS = frozenset({
    "success", "quality", "passed", "score", "graded", "verdict",
    "pass", "fail", "result", "won", "winner",
})


def validate_adapter_output(out: Dict[str, Any]) -> List[str]:
    """Return problems. Empty == valid. REJECTS forbidden judgment keys."""
    errs: List[str] = []
    if not isinstance(out, dict):
        return ["adapter-output must be a JSON object"]

    forbidden = sorted(k for k in out.keys() if k in ADAPTER_FORBIDDEN_KEYS)
    if forbidden:
        errs.append(
            "adapter-output MUST NOT report outcome; forbidden keys present: "
            + ", ".join(forbidden)
            + " (only the grader sets success/quality)"
        )

    for k in ADAPTER_OUTPUT_REQUIRED:
        if k not in out:
            errs.append(f"adapter-output missing required key: {k}")
    if "tool" in out and not isinstance(out["tool"], str):
        errs.append("adapter-output.tool must be a string")
    if "tool_version" in out and not isinstance(out["tool_version"], str):
        errs.append("adapter-output.tool_version must be a string")
    if "duration_s" in out and not isinstance(out["duration_s"], (int, float)):
        errs.append("adapter-output.duration_s must be a number")
    if "cost_usd" in out and out["cost_usd"] is not None \
            and not isinstance(out["cost_usd"], (int, float)):
        errs.append("adapter-output.cost_usd must be a number or null")
    for k in ("tokens_in", "tokens_out"):
        if k in out and out[k] is not None and not isinstance(out[k], int):
            errs.append(f"adapter-output.{k} must be an int or null")
    if "exit_status" in out and not isinstance(out["exit_status"], str):
        errs.append("adapter-output.exit_status must be a string")
    if "provenance" in out and not isinstance(out["provenance"], dict):
        errs.append("adapter-output.provenance must be an object")
    return errs


def normalize_adapter_output(out: Dict[str, Any]) -> Dict[str, Any]:
    """Fill optional fields with defaults. Preserves cost_usd null semantics.

    NEVER coerces cost_usd / tokens null -> 0 (null means "not collected", a
    deliberate honesty signal mirrored from proof-generator._collect_efficiency).
    """
    norm = dict(out)
    norm.setdefault("model_used", "")
    norm.setdefault("iterations", 0)
    norm.setdefault("tokens_in", None)
    norm.setdefault("tokens_out", None)
    norm.setdefault("cost_usd", None)
    norm.setdefault("cache_read_tokens", 0)
    norm.setdefault("cache_creation_tokens", 0)
    norm.setdefault("provenance", {})
    return norm


# ---------------------------------------------------------------------------
# 3. result-row
# ---------------------------------------------------------------------------
# One task x one tool. Carries N trials and a summary. trial.success and
# trial.quality are set ONLY by the grader (runner.grade). The row also carries
# task id + path + per-trial tool_version so `loki bench verify` can relocate
# the inputs, recompute task_hash, and re-check tool versions.
#
# {
#   "schema_version": "1.0",
#   "task_id": "swebench-verified-django-12345",
#   "task_path": "benchmarks/bench/tasks/django-12345.json",  # to relocate inputs
#   "task_hash": "<sha256>",        # compute_task_hash at run time
#   "tool": "loki",
#   "model": "claude-sonnet-4-5",
#   "trials": [
#     {
#       "trial": 1,
#       "success": true,            # GRADER ONLY: acceptance exit == 0
#       "quality": {                # GRADER ONLY: non-gating signals
#           "lint_ok": true | null, # null == not measured
#           "tests_ok": true | null
#       },
#       "acceptance_exit_code": 0,
#       "adapter": { ...adapter-output... },   # cost + provenance, never outcome
#       "cost_usd": 0.83 | null,
#       "duration_s": 412.3
#     }, ...
#   ],
#   "summary": {
#     "n_trials": 3,
#     "n_success": 2,
#     "success_rate": 0.6667,       # k/N over grader-passed trials
#     "duration_s_median": 410.0,
#     "duration_s_min": 380.0,
#     "duration_s_max": 450.0,
#     "cost_usd_median": 0.81 | null,   # null when no trial recorded cost
#     "cost_usd_per_solved": 1.22 | null  # total cost / n_success (null if 0 solved or no cost)
#   }
# }

RESULT_ROW_REQUIRED = (
    "schema_version", "task_id", "task_path", "task_hash",
    "tool", "model", "trials", "summary",
)


def validate_result_row(row: Dict[str, Any]) -> List[str]:
    """Return problems. Empty == valid."""
    errs: List[str] = []
    if not isinstance(row, dict):
        return ["result-row must be a JSON object"]
    for k in RESULT_ROW_REQUIRED:
        if k not in row:
            errs.append(f"result-row missing required key: {k}")
    if "trials" in row:
        if not isinstance(row["trials"], list):
            errs.append("result-row.trials must be a list")
        else:
            for i, t in enumerate(row["trials"]):
                if not isinstance(t, dict):
                    errs.append(f"result-row.trials[{i}] must be an object")
                    continue
                if "success" not in t or not isinstance(t["success"], bool):
                    errs.append(f"result-row.trials[{i}].success must be a bool (grader-set)")
                if "adapter" in t:
                    aerrs = validate_adapter_output(t["adapter"])
                    errs.extend(f"result-row.trials[{i}].adapter: {e}" for e in aerrs)
    if "summary" in row and not isinstance(row["summary"], dict):
        errs.append("result-row.summary must be an object")
    return errs


def _median(values: List[float]) -> Optional[float]:
    vals = sorted(v for v in values if v is not None)
    if not vals:
        return None
    n = len(vals)
    mid = n // 2
    if n % 2 == 1:
        return float(vals[mid])
    return (vals[mid - 1] + vals[mid]) / 2.0


def summarize_trials(trials: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Build the result-row.summary. Lead-conservative, null-honest.

    success_rate = n_success / n_trials over grader-passed trials. A 0-success
    run yields success_rate 0.0 (it renders, it does not vanish). Cost summaries
    are null when no trial recorded a cost (never invented).
    """
    n = len(trials)
    n_success = sum(1 for t in trials if t.get("success") is True)
    durations = [t.get("duration_s") for t in trials if t.get("duration_s") is not None]
    costs = [t.get("cost_usd") for t in trials if t.get("cost_usd") is not None]
    total_cost = sum(costs) if costs else None
    per_solved = None
    if total_cost is not None and n_success > 0:
        per_solved = round(total_cost / n_success, 4)
    return {
        "n_trials": n,
        "n_success": n_success,
        "success_rate": round(n_success / n, 4) if n else 0.0,
        "duration_s_median": _median(durations),
        "duration_s_min": min(durations) if durations else None,
        "duration_s_max": max(durations) if durations else None,
        "cost_usd_median": _median(costs),
        "cost_usd_per_solved": per_solved,
    }
