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

# Retired task ids. A pre-registered task or overlay cannot be edited after a paid trial has seen it (its sha is pinned),
# so a defective one is retired HERE, by id, and replaced by a new id. A retired task never runs and its rows never feed a claim.
RETIRED_TASKS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "retired_tasks.json")


def retired_tasks(path: Optional[str] = None) -> Dict[str, Dict[str, str]]:
    """{task_id: {reason, superseded_by, retired}} from retired_tasks.json. An unreadable manifest raises: a claim must not
    silently include a retired task because the list could not be read."""
    with open(path or RETIRED_TASKS_FILE, "r") as fh:
        data = json.load(fh)
    tasks = data.get("tasks") if isinstance(data, dict) else None
    if not isinstance(tasks, dict):
        raise ValueError("retired_tasks.json must be an object with a 'tasks' object")
    return tasks


def without_retired(rows: List[Dict[str, Any]], path: Optional[str] = None) -> List[Dict[str, Any]]:
    """Rows whose task (task_id, or task for attribution rows) is not retired."""
    gone = retired_tasks(path)
    return [r for r in rows if (r.get("task_id") or r.get("task")) not in gone]


# Identity variables a provider CLI needs to resolve its login. The run4 group
# runs (2026-10-17) lost LOGNAME and every Loki cell failed auth; a run whose
# environment record shows any of these unset is INVALID, never a reading.
IDENTITY_ENV_VARS = ("USER", "LOGNAME", "HOME")


def identity_env_record(environ: Optional[Dict[str, str]] = None) -> Dict[str, bool]:
    """Presence (never the value) of each identity variable."""
    src = os.environ if environ is None else environ
    return {k: bool(src.get(k)) for k in IDENTITY_ENV_VARS}


def identity_env_problems(environment: Any) -> List[str]:
    """Why an environment record cannot back a reading; empty when it can."""
    rec = environment.get("identity_env") if isinstance(environment, dict) else None
    if not isinstance(rec, dict):
        return ["identity_env record absent"]
    dropped = [k for k in IDENTITY_ENV_VARS if rec.get(k) is not True]
    return ["identity var(s) unset: %s" % ",".join(dropped)] if dropped else []


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


# ---------------------------------------------------------------------------
# "was this trial actually measured?" -- the ONE definition
# ---------------------------------------------------------------------------
# Mirrors autonomy/lib/efficiency_cost.py::record_is_measured: an unmeasured
# value reads UNKNOWN, never 0. Here the unit is a TRIAL rather than an
# efficiency record, but the rule is the same one, and it exists in exactly one
# place for the same reason -- a second copy is how the honesty rule drifts.
#
# The grader sets success = (acceptance exit == 0) on whatever state it finds in
# the workdir. When the tool never ran, that state is the untouched fixture, so
# the acceptance command fails and the trial scores success=false. That is
# indistinguishable from a tool that ran hard and genuinely failed -- and it is
# the number that gets published as a competitor's score.
#
# exit_status is the discriminator, and _base.run_cli already records it
# precisely (cli_not_found / timeout / adapter_error are its own words). It has
# been a REQUIRED adapter-output key since schema 1.0, so every historical
# result row on disk already carries it and retro-classifies correctly. That is
# why measuredness is DERIVED at read time instead of stamped as a new field:
# a new field would be absent on every existing row, and absent must not read as
# unmeasured.
#
# Deliberately NOT a bare falsy check anywhere below: a real measured zero must
# survive as zero.

# The tool ran and terminated under its own control; the grader graded what it
# actually left behind. A failure here is a REAL failure and must stay one.
#   completed   -- ran, exited 0
#   error_rc_N  -- ran, exited non-zero (a genuine failure to solve the task)
#   manual      -- operator-supplied entry (report.py already tags it unverified)
#
# Everything else means no measurement was taken:
#   cli_not_found -- the tool is not installed; it never ran at all
#   timeout       -- killed mid-work; the workdir is a snapshot of an unfinished
#                    run, not a verdict. matrix.sh already treats a timed-out
#                    cell as MISSING (it warns and returns 1), and the "first
#                    pilot produced zero haiku-full rows" incident is exactly
#                    this case. Scoring it 0 would contradict that.
#   adapter_error -- the harness broke, not the tool
UNMEASURED_EXIT_STATUSES = frozenset({
    "cli_not_found", "timeout", "adapter_error",
})


def _num(v: Any) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _count(v: Any) -> int:
    try:
        return max(int(v), 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def trials_cost_partial(trials: Any) -> bool:
    """Aggregate form of cost_is_partial: partial when any trial is partial OR a
    measured trial recorded no numeric cost, because a sum or median over the
    priced trials alone is then only a lower bound. Unmeasured trials are skipped.
    The one decision for equivalence_report, report and summarize_trials."""
    for t in trials or []:
        if not isinstance(t, dict) or not trial_is_measured(t):
            continue
        if cost_is_partial(t) or _num(t.get("cost_usd")) is None:
            return True
    return False


def cost_is_partial(rec: Any, ledger_usd: Optional[float] = None,
                    ledger_invalid: int = 0, ledger_unpriced: int = 0) -> bool:
    """The ONE decision of whether a cost is only a lower bound (FC-COST-PARTIAL-b).

    Every cost consumer (attribution, equivalence_report, report, spend cap) calls
    this; none re-derives it. rec is a result row or trial; the ledger arguments
    are optional extra evidence a caller read from disk. Partial when any of:
    cost_partial already true (also under adapter / adapter.provenance); cost_usd
    missing while a true cost or ledger value exists; stored cost_usd below the
    true cost or ledger sum (covers a stored 0.0); invalid or unpriced ledger lines.
    """
    if not isinstance(rec, dict):
        return False
    adapter = rec.get("adapter") if isinstance(rec.get("adapter"), dict) else {}
    prov = adapter.get("provenance") if isinstance(adapter.get("provenance"), dict) else {}
    for src in (rec, adapter, prov):
        flag = src.get("cost_partial")
        if flag is True or (isinstance(flag, str) and flag.strip().lower() == "true"):
            return True
    invalid = _count(rec.get("ledger_invalid_lines")) + _count(ledger_invalid)
    unpriced = _count(rec.get("cost_unpriced_records")) + _count(ledger_unpriced)
    if invalid > 0 or unpriced > 0:
        return True
    stored = _num(rec.get("cost_usd"))
    others = [v for v in (_num(rec.get("true_cost_usd")), _num(ledger_usd))
              if v is not None]
    if not others:
        return False
    if stored is None:
        return True
    return stored < max(others) - 1e-9


# Per-trial metrics for #348 (CW-15). A value is None when it was not measured:
# never 0, so a missing signal cannot read as a clean result.
TRIAL_METRIC_KEYS = ("claimed_done", "false_pass", "council_cache_share",
                     "journal_reuse_wall_s")
_REVIEWER_PHASE_MARKS = ("review", "council")


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def council_cache_share(cache_by_phase: Any) -> Optional[float]:
    """cache_read / (input + cache_creation + cache_read) over reviewer and
    council phases of the cost ledger. None when no such phase carries tokens."""
    if not isinstance(cache_by_phase, dict):
        return None
    read = total = 0
    for phase, slot in cache_by_phase.items():
        if not isinstance(slot, dict) or not any(
                m in str(phase).lower() for m in _REVIEWER_PHASE_MARKS):
            continue
        cr, cc, inp = (slot.get(k) or 0 for k in
                       ("cache_read", "cache_creation", "input"))
        read += cr
        total += cr + cc + inp
    return round(read / total, 4) if total > 0 else None


def trial_metrics(adapter_out: Dict[str, Any], grader_success: bool,
                  measured: bool = True) -> Dict[str, Any]:
    """The three #348 metrics for one trial, from adapter output plus the
    grader's verdict. Pure: the adapter never judges, the grader does.

    claimed_done: loki only when its own verdict is VERIFIED (PARTIAL and
    FAILED are honest non-claims); any other tool when it ended cleanly.
    false_pass: claimed_done while the hidden grader failed; None without a
    claim or for an unmeasured trial."""
    prov = adapter_out.get("provenance") or {}
    if adapter_out.get("tool") == "loki":
        claimed = prov.get("verify_verdict") == "VERIFIED"
    else:
        claimed = str(adapter_out.get("exit_status", "")).lower() == "completed"
    reuse = prov.get("journal_reuse_wall_s")
    return {
        "claimed_done": bool(claimed) if measured else None,
        "false_pass": (claimed and not grader_success)
        if (measured and claimed) else None,
        "council_cache_share": council_cache_share(
            prov.get("cache_tokens_by_phase")),
        "journal_reuse_wall_s": float(reuse) if _is_number(reuse) else None,
    }


def resume_cost(control_row: Dict[str, Any],
                interrupted_row: Dict[str, Any]) -> Dict[str, Any]:
    """Extra seconds, dollars and tokens an interrupted-then-resumed trial took
    to reach done compared with its uninterrupted control (100x axis D).

    Every delta is None when either side did not record the quantity, never 0.
    A positive value is resume overhead; near 0 or negative means the resume
    reused finished work. reached_done is the HELD-OUT grader's verdict on the
    resumed run, so a resume that lost the work cannot read as cheap. killed
    False means the run finished before the interrupt point: no resume
    happened and the pair says nothing about resume cost."""
    def _delta(a, b):
        return round(a - b, 4) if _is_number(a) and _is_number(b) else None

    def _tokens(row):
        ad = row.get("adapter") or {}
        i, o = ad.get("tokens_in"), ad.get("tokens_out")
        return i + o if _is_number(i) and _is_number(o) else None

    resume = ((interrupted_row.get("adapter") or {}).get("provenance") or {}
              ).get("resume") or {}
    leg1_known = _is_number(resume.get("leg1_usd"))
    return {
        "killed": bool(resume.get("killed")),
        "reached_done": bool(interrupted_row.get("success")),
        "control_reached_done": bool(control_row.get("success")),
        "extra_s": _delta(interrupted_row.get("duration_s"),
                          control_row.get("duration_s")),
        "extra_usd": _delta(interrupted_row.get("cost_usd"),
                            control_row.get("cost_usd")),
        "extra_tokens": _delta(_tokens(interrupted_row), _tokens(control_row)),
        # False: the killed leg's spend was not recorded, extra_usd is a lower bound.
        "extra_usd_complete": leg1_known or not resume.get("killed"),
    }


def trial_is_measured(trial: Dict[str, Any]) -> bool:
    """True when this trial represents a real, gradeable observation.

    False means the tool never produced a state worth grading, so the trial must
    be EXCLUDED from k/N rather than counted as a failure. An unrecognized or
    absent exit_status is treated as MEASURED: that is the fail-safe direction
    here, because it preserves every pre-existing row's k/N exactly and keeps
    this predicate from silently deleting real data it does not recognize.
    """
    if not isinstance(trial, dict):
        return False
    adapter = trial.get("adapter")
    if not isinstance(adapter, dict):
        return True
    status = adapter.get("exit_status")
    if isinstance(status, str) and status.strip().lower() in UNMEASURED_EXIT_STATUSES:
        return False

    # ZERO ITERATIONS IS DELIBERATELY *NOT* TREATED AS UNMEASURED HERE, and
    # this is the second-order trap in this predicate.
    #
    # It looks like it should be: an agent that completed no iteration produced
    # no artifact, so grading it measures the SEED rather than the agent. I
    # added exactly that rule and it broke
    # tests/test_bench_unmeasured_trial.py::test_genuine_failure_still_scores_zero.
    #
    # The reason is the failure it causes is WORSE than the one it prevents. A
    # run that genuinely FAILED can legitimately record iterations: 0. Treating
    # that as unmeasured deletes a real failure from the denominator, which
    # inflates the success rate -- the same false-green shape, pointed the
    # other way. The existing test pins that a genuine failure must still score
    # 0.0 rather than vanish.
    #
    # exit_status already carries the distinction correctly: a run that could
    # not happen reports timeout / cli_not_found / adapter_error, while a run
    # that happened and failed reports a normal status. Iteration count is a
    # symptom of both and discriminates neither.
    return True


def split_measured(trials: List[Dict[str, Any]]
                   ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Partition trials into (measured, unmeasured). Order preserved."""
    measured = [t for t in trials if trial_is_measured(t)]
    unmeasured = [t for t in trials if not trial_is_measured(t)]
    return measured, unmeasured


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

    success_rate = n_success / n_trials over MEASURED trials only. A 0-success
    run yields success_rate 0.0 (a real zero renders, it does not vanish), but a
    trial that produced no measurement (tool absent, timed out, harness error)
    is excluded from BOTH numerator and denominator rather than counted as a
    failure -- the denominator is the measured count, never the attempted count.
    n_unmeasured records how many were dropped so the loss is visible.

    With nothing measured there is no rate at all: success_rate is None, not
    0.0. An unmeasured cell must never publish as a perfect failure.

    Cost summaries are null when no trial recorded a cost (never invented).
    """
    n_attempted = len(trials)
    measured, unmeasured = split_measured(trials)
    n = len(measured)
    n_success = sum(1 for t in measured if t.get("success") is True)
    durations = [t.get("duration_s") for t in measured if t.get("duration_s") is not None]
    costs = [t.get("cost_usd") for t in measured if t.get("cost_usd") is not None]
    total_cost = sum(costs) if costs else None
    per_solved = None
    if total_cost is not None and n_success > 0:
        per_solved = round(total_cost / n_success, 4)
    partial = trials_cost_partial(measured)
    return {
        "cost_partial": partial,
        "n_trials": n,
        "n_attempted": n_attempted,
        "n_unmeasured": len(unmeasured),
        "n_success": n_success,
        # None (not 0.0) when nothing was measured: no observation, no rate.
        "success_rate": round(n_success / n, 4) if n else None,
        "duration_s_median": _median(durations),
        "duration_s_min": min(durations) if durations else None,
        "duration_s_max": max(durations) if durations else None,
        "cost_usd_median": _median(costs),
        "cost_usd_per_solved": None if partial else per_solved,
        "cost_usd_per_solved_lower_bound": per_solved if partial else None,
    }
