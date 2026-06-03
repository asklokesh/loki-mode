# Benchmark Tasks (R2)

This directory defines the task-spec format for the R2 head-to-head benchmark
harness, plus the tooling to verify a task's content hash.

## These are FROZEN PUBLIC tasks, not Loki-authored tasks

The single most-dismissed move in this space is a vendor authoring its own tasks,
scoring them with its own logic, and winning. R2 deliberately does the opposite:

- Tasks come from FROZEN PUBLIC benchmark sets (SWE-bench Verified for Slice A),
  materialized verbatim into the task-spec format. We do NOT invent tasks.
- The pinned subset of instance ids lives in
  `../swebench/pinned-subset.json`. The loader
  (`../swebench/loader.py`) materializes those real instances into task
  directories. See that manifest for the honest verification status of the ids.
- Scope is intentionally a SMALL pinned subset (lean-but-credible). It is
  expandable later. Absolute scores on public sets are an upper bound (likely
  training contamination); the relative gap between tools is the signal.

## Held-out acceptance: Loki never grades itself

Every task carries an `acceptance` (the grader: `acceptance.sh` + a command). It
is "held out" in a specific sense:

- The acceptance bytes ARE part of the task definition and feed `task_hash`, and
  the grader runs them. They are NOT deleted.
- They are NEVER shown to the agent. The agent only ever sees `spec.md`, which is
  built solely from the instance's problem statement. The held-out test names
  (FAIL_TO_PASS / PASS_TO_PASS) never appear in `spec.md`.
- Success is decided ONLY by the acceptance command, run by a grader OUTSIDE the
  agent container on a read-only host (Slice B). Council, RARV-C, and any
  LLM-judge are structurally excluded from scoring.

The loader enforces the anti-contamination boundary by construction (problem
statement -> spec.md; tests -> acceptance.sh only). `tests/test_bench_taskspec.py`
greps `spec.md` for acceptance content as a regression guard.

## task_hash makes every task reproducible and refutable

`task_hash` is a sha256 content fingerprint over four components: the brief
(`spec.md`), the held-out grader (`acceptance.sh`), the fixture tree, and the
model id. A stranger can recompute it offline and confirm the task they ran is
byte-for-byte the task we published. "Don't trust the number, trust the
methodology."

```
python3 hash.py compute \
  --spec ../swebench/tasks/<id>/spec.md \
  --acceptance ../swebench/tasks/<id>/acceptance.sh \
  --fixture ../swebench/tasks/<id>/fixture \
  --model claude-opus-4-8

python3 hash.py verify --expected <published_hash> \
  --spec ... --acceptance ... --fixture ... --model ...
```

The algorithm (hash-of-hashes, fixed order, stdlib-only, no git, no network) is
specified in full in `SCHEMA.md`.

## Files

| File | Role |
|---|---|
| `SCHEMA.md` | The frozen task-spec format + the task_hash algorithm. |
| `hash.py` | Pure-stdlib compute/verify of task_hash. CLI: `compute` / `verify`. |
| `README.md` | This file. |
| `../swebench/loader.py` | Materializes pinned SWE-bench instances into task-spec dirs (offline). |
| `../swebench/pinned-subset.json` | The pinned list of real public instance ids + verification status. |

## Offline by design

The loader makes no network calls and never downloads the full dataset. It reads
a LOCAL cached SWE-bench export (json/jsonl) given via `--dataset` or
`SWEBENCH_DATASET_PATH`. If the dataset is absent it degrades gracefully with a
clear, actionable message rather than crashing or reaching for the network.
