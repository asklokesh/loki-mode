# Benchmark Task-Spec Schema (R2)

This document freezes the task-spec format used by the R2 head-to-head benchmark
harness. It is the contract between the task loader (Slice A), the runner +
read-only grader (Slice B), the adapters (Slice C), and the report (Slice D).

## North star

The harness is the product, not the number. A benchmark task is defined entirely
by its CONTENT, captured in a `task_hash` that a stranger can recompute offline.
That makes every published task reproducible and refutable: anyone can confirm
the task they ran is byte-for-byte the task we published. See `README.md` for the
credibility framing.

## Anatomy of a task

Each task lives in its own directory:

```
benchmarks/swebench/tasks/<id>/
  task.json        # the machine-readable task-spec (this schema)
  spec.md          # the brief SHOWN to the agent (problem statement only)
  acceptance/      # HELD-OUT overlay dir (NEVER shown to the agent)
    acceptance.sh  #   the grader script, copied into the workdir AFTER the run
  fixture/         # the working tree the agent starts from (base repo@commit)
```

`spec.md`, `acceptance/acceptance.sh`, and `fixture/` are content files.
`task.json` is metadata that points at them and carries the `task_hash`.

## Canonical contract: bench_schema.py

`task.json` MUST validate against `benchmarks/bench/bench_schema.validate_task_spec`
(the FROZEN runner contract). The loader, the runner, and `loki bench run`/`verify`
all read the FLAT field shape below. The required keys are exactly
`bench_schema.TASK_SPEC_REQUIRED`: `id`, `source`, `fixture`, `prompt`,
`acceptance`, `default_model`.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `schema_version` | string | recommended | Frozen-contract version. Matches `bench_schema.SCHEMA_VERSION` (`1.0`). |
| `id` | string | yes | Unique task id. For SWE-bench: the instance id, e.g. `django__django-11099`. |
| `source` | string | yes | Provenance label of the task set, e.g. `swe-bench-verified`. |
| `fixture` | string | yes | Path (relative to task.json) to the materialized fixture tree. Normally `fixture`. |
| `prompt` | string | yes | The brief HANDED to the agent. Built from the problem statement only; the runner materializes it into a file inside the workdir. NEVER contains held-out acceptance content. |
| `acceptance` | object | yes | The held-out grader. See below. |
| `acceptance.cmd` | string | yes | Shell command the OUT-OF-CONTAINER grader runs IN the workdir to decide pass/fail. Normally `bash acceptance.sh`. |
| `acceptance.timeout_s` | integer | yes | Hard wall-clock timeout for the grader, in seconds. |
| `acceptance.overlay` | string | when held-out files exist | Path (relative to task.json) to a dir the grader copies INTO the workdir AFTER the agent finishes, BEFORE running cmd. This is how `acceptance.sh` reaches the workdir without the agent ever seeing it. Normally `acceptance`. |
| `default_model` | string | yes | The model id this task_hash is bound to (e.g. `claude-opus-4-8`). |
| `agent_timeout_s` | integer | recommended | Cap on the adapter / tool run, in seconds. |
| `quality` | object | no | Non-grading quality signals collected for reporting only. `quality.lint_cmd` / `quality.test_cmd`: string or null. Neither decides success. |

### Extra provenance keys (validator ignores unknown keys)

The loader also writes these informational keys. They are not part of the
required contract; `validate_task_spec` ignores unknown keys.

| Field | Type | Meaning |
|---|---|---|
| `title` | string | Short human title (the instance id). |
| `source_ref` | string | Upstream instance id / citation. |
| `spec_path` | string | Path to `spec.md` (the same text as `prompt`, kept as a file for reference). |
| `task_hash` | string | sha256 OFFLINE-verification content hash (see below). |
| `fixture_source` | object | How to (re)materialize the fixture: `kind` (`git`), `repo`, `git_ref` (base commit), `path`. |
| `source_info` | object | Dataset name, split, url. |

### Held-out acceptance (critical)

"Held out" means held out FROM THE AGENT, not removed from the task definition:

- `acceptance.cmd` and `acceptance/acceptance.sh` ARE part of `task.json` and the
  task directory. The script's bytes feed the `task_hash` (so the task is
  reproducible) and the out-of-container grader runs them to decide success.
- `acceptance/acceptance.sh` lives in a SEPARATE overlay dir, never inside
  `fixture/`. The runner copies only `fixture/` into the agent workdir, then the
  grader applies `acceptance.overlay` AFTER the agent finishes. The agent never
  sees the held-out script.
- They are NEVER injected into `spec.md`, the agent `prompt`, or the agent's
  working tree before grading. The agent only ever sees `prompt` (== `spec.md`).
- Loki NEVER grades itself. Success is decided only by `acceptance.cmd` run by a
  grader OUTSIDE the agent container on a read-only host (Slice B). Council /
  RARV-C / LLM-judge are structurally excluded from scoring.

### Anti-contamination invariant

`spec.md` MUST NOT contain the contents of `acceptance.sh`, the names of the
held-out tests (FAIL_TO_PASS / PASS_TO_PASS), or the acceptance command. The
loader enforces this by constructing `spec.md` exclusively from the instance's
`problem_statement` and routing all test information to `acceptance.sh` only.
`tests/test_bench_taskspec.py` greps `spec.md` for acceptance content as a
regression check.

## task_hash algorithm

There are TWO task hashes in the harness, with different consumers. They are NOT
required to be equal and serve distinct purposes:

- The `task_hash` field in `task.json` (and the `hash.py` CLI) is the OFFLINE,
  third-party verification anchor. A stranger recomputes it from the on-disk
  content with `benchmarks/tasks/hash.py` and confirms the task is byte-for-byte
  what was published. It hashes `spec.md`, `acceptance/acceptance.sh`, the
  `fixture/` tree, and the model id.
- The result-row `task_hash` is computed by the RUNNER at run time via
  `benchmarks/bench/bench_schema.compute_task_hash(spec, fixture_dir)` over the
  canonical task-spec dict plus the fixture tree, and stamped into each result.
  The runner NEVER reads `task.json`'s `task_hash` field; `loki bench verify`
  recomputes the runner hash from the inputs on disk.

The rest of this section documents the `hash.py` (offline) algorithm: a
hash-of-hashes over the four content components, in fixed order, with a domain
tag. Implemented in `benchmarks/tasks/hash.py` (pure stdlib, no network, no git).

```
h_spec       = sha256(spec.md bytes)
h_acceptance = sha256(acceptance bytes)          # acceptance.sh, held-out
h_fixture    = fixture_tree_hash(fixture/)       # stdlib directory walk
h_model      = sha256(utf8(model id))

task_hash    = sha256(
    "loki-bench-task-v1\n"
    + h_spec + "\n"
    + h_acceptance + "\n"
    + h_fixture + "\n"
    + h_model + "\n"
)
```

Why hash-of-hashes instead of concatenating raw bytes: concatenation has a
boundary ambiguity (where spec ends and acceptance begins). Hashing each
component first, then combining the four fixed-order hex digests with a single
`\n` separator and a leading domain tag, removes that ambiguity and lets a
verifier reason about one component at a time.

### fixture_tree_hash

A deterministic, pure-stdlib content hash of a directory tree:

1. Walk the tree; prune VCS metadata and caches (`.git`, `__pycache__`,
   `node_modules`, `.loki`, ...) and `.DS_Store`. These are not task content.
2. Sort every remaining file by its relative POSIX path.
3. For each file, update a running sha256 with
   `"<rel_posix_path>" + NUL + sha256(file content) + "\n"`.
4. The leading literal `loki-bench-fixture-v1\n` binds the result to this
   algorithm version. An empty tree hashes to a stable value.

POSIX-normalized paths make the hash identical across operating systems. We use
a stdlib walk rather than `git rev-parse` / `git hash-object` so the hash is
reproducible with no git dependency and no SHA-1. (Git tree SHA is a valid
alternative scheme, but it pulls in git and SHA-1; we deliberately avoid both.)

### Recomputing / verifying

```
# compute
python3 benchmarks/tasks/hash.py compute \
  --spec       benchmarks/swebench/tasks/<id>/spec.md \
  --acceptance benchmarks/swebench/tasks/<id>/acceptance/acceptance.sh \
  --fixture    benchmarks/swebench/tasks/<id>/fixture \
  --model      claude-opus-4-8

# verify a published task_hash
python3 benchmarks/tasks/hash.py verify --expected <hash> \
  --spec ... --acceptance ... --fixture ... --model ...
```

Any byte change to the brief, the held-out grader, the fixture tree, or the
model id changes `task_hash`. That is the point: the hash is the fingerprint of
exactly what was run.

## Example task.json

```json
{
  "schema_version": "1.0",
  "id": "django__django-11099",
  "source": "swe-bench-verified",
  "fixture": "fixture",
  "prompt": "# Task: django__django-11099\n\nRepository: django/django\n...",
  "acceptance": {
    "cmd": "bash acceptance.sh",
    "timeout_s": 1800,
    "overlay": "acceptance"
  },
  "default_model": "claude-opus-4-8",
  "agent_timeout_s": 1800,
  "quality": { "lint_cmd": null, "test_cmd": null },
  "title": "django__django-11099",
  "source_ref": "django__django-11099",
  "spec_path": "spec.md",
  "task_hash": "<sha256>",
  "fixture_source": {
    "kind": "git",
    "repo": "django/django",
    "git_ref": "<base_commit_sha>",
    "path": "fixture"
  },
  "source_info": {
    "dataset": "SWE-bench Verified",
    "split": "test",
    "url": "https://www.swebench.com/"
  }
}
```
