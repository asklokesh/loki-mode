# Result Row Schema (R2 benchmark harness)

Frozen contract. Source of truth: `benchmarks/bench/bench_schema.py`
(`SCHEMA_VERSION = "1.0"`). The report (Slice D) reads these rows.

A result-row is ONE task x ONE tool, with N trials and a summary.

## Held-out test integrity

The agent gets write access to the whole workdir, so a naive grader (run the
test that was copied in with the fixture) lets the agent edit the test to pass.
To prevent that, a task-spec MAY set `acceptance.overlay` (a dir of held-out
test files) and `acceptance.setup_cmd`. The grader copies the overlay INTO the
workdir AFTER the agent finishes and BEFORE running `acceptance.cmd` (the
SWE-bench test-patch pattern), then optionally runs the non-gating `setup_cmd`.
When `overlay` is absent (e.g. the trivial demo task), the grader runs
`acceptance.cmd` against whatever the agent left. Slice A owns whether each real
public-subset instance ships an overlay. This is the first thing a credibility
reviewer will check.

## Who sets what

- `trial.success` and `trial.quality` are set **only** by the grader
  (`runner.grade`). success = held-out acceptance command exit code == 0.
  quality (lint/tests) is a separate, non-gating signal.
- Everything cost/provenance comes from the adapter (`trial.adapter`).
- No council / RARV-C / LLM-judge anywhere in scoring.

## Top-level fields

| Field | Type | Notes |
|---|---|---|
| `schema_version` | string | `"1.0"` |
| `task_id` | string | stable id; lets `verify` relocate inputs |
| `task_path` | string | path to the task-spec json; lets `verify` re-read spec + fixture |
| `task_hash` | string | `compute_task_hash(spec, fixture_dir)` at run time |
| `tool` | string | tool identifier |
| `model` | string | model used |
| `trials` | list | per-trial records (below) |
| `summary` | object | aggregate (below) |

## trials[]

| Field | Type | Set by | Notes |
|---|---|---|---|
| `trial` | int | runner | 1-based index |
| `success` | bool | GRADER | acceptance exit == 0 |
| `quality.lint_ok` | bool or null | GRADER | null == not measured |
| `quality.tests_ok` | bool or null | GRADER | null == not measured |
| `acceptance_exit_code` | int | GRADER | raw exit code |
| `adapter` | object | adapter | full adapter-output (cost + provenance, never outcome) |
| `cost_usd` | number or null | runner | lifted from adapter; null preserved |
| `duration_s` | number | runner | lifted from adapter |

## summary

| Field | Type | Notes |
|---|---|---|
| `n_trials` | int | |
| `n_success` | int | grader-passed trials |
| `success_rate` | float | `n_success / n_trials`; a 0-success run renders as `0.0`, never vanishes |
| `duration_s_median` / `_min` / `_max` | float or null | report median + spread, lead conservative |
| `cost_usd_median` | float or null | null when no trial recorded cost |
| `cost_usd_per_solved` | float or null | total cost / n_success; null if 0 solved or no cost recorded |

## verify

`loki bench verify <result.json>` reads `task_path`, re-reads the spec + fixture,
recomputes `compute_task_hash`, and compares to the stored `task_hash`. It also
re-queries each trial's tool version against `trial.adapter.tool_version`.
Mismatch == the result no longer corresponds to the inputs on disk.

## Helpers

- `validate_result_row(row) -> [problems]`
- `summarize_trials(trials) -> summary`
