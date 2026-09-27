# Loki 10 eval harness

The v10.0.0 release gate. It runs one arm (`v10`, `raw-claude`, `legacy`) over a
set of tasks and scores each run the same way.

## Task schema

`eval/loki10/tasks/<id>/task.json`:

```json
{
  "id": "<same as the directory name>",
  "kind": "augmentiq | public | quickstart",
  "prompt": "<issue text or brief>",
  "issue_ref": "<owner/repo#N or null>",
  "repo": {"source": "<git url or absolute local path>", "ref": "<commit sha>"},
  "setup": "<optional shell command run in the checkout before the arm>",
  "hidden": {"files": ["<paths relative to hidden/>"], "run": "<command, exit 0 = pass>"},
  "timeout_s": 900
}
```

`eval/loki10/tasks/<id>/hidden/` holds the hidden tests. They exist only in this
repo and are copied into the graded checkout after the arm has finished.

Validate tasks with `python3 eval/loki10/harness.py validate eval/loki10/tasks/*`.
The validator rejects unknown keys, an id that differs from its directory, a
non-sha ref, hidden paths that are absolute or contain `..`, missing hidden
files, and a missing `hidden.run`. `run.sh` validates every selected task first.

## Running

```bash
eval/loki10/run.sh --arm raw-claude --all --parallel 3 --out eval/loki10/results
eval/loki10/run.sh --arm v10 --task <id>
eval/loki10/summarize eval/loki10/results/results.jsonl            # plain text
eval/loki10/summarize eval/loki10/results/results.jsonl --markdown # CHANGELOG block
```

Each run, per task and arm:

1. The runner clones `repo.source` into a run-owned temp dir and checks out
   `repo.ref` as `main`. It then deletes every other ref and runs `git gc`, so
   later upstream commits (the fix) cannot be read.
2. `origin` points at a local bare repo. A post-receive hook there records
   the time of each push. The arm runs without `GITHUB_TOKEN`/`GH_TOKEN`, with
   an empty `GH_CONFIG_DIR`, `GIT_SSH_COMMAND=false`, no credential helper,
   `LOKI_NO_BROWSER=1` and `LOKI_DASHBOARD=false`.
3. `setup` runs, then the arm runs under `timeout -k 10 <timeout_s>`:
   - raw-claude: `claude -p "<prompt + push instruction>" --output-format json --dangerously-skip-permissions --model $LOKI_EVAL_MODEL`
   - v10: `LOKI_ENGINE=v10 loki "<prompt>"`
   - legacy: `loki start <prompt file>`. The prompt file includes the push instruction.
4. If a non-`main` branch was pushed, the runner writes a PR record (`pr.json`).
   It then clones that branch fresh, runs `setup` again, copies the hidden
   files in, and runs `hidden.run`. With no PR, the hidden tests run in the
   arm's checkout for diagnostics only.

`LOKI_EVAL_MODEL` defaults to the first planning-tier claude model in
`providers/model_catalog.json`. The loki arms receive the same model through
`LOKI_SESSION_MODEL` (the catalog alias) and `LOKI_MODEL_OVERRIDE`.
`manifest.json` in `--out` records the model, the arm binary version and the
harness SHA. Every child process runs under `timeout -k`. The runner starts no
new run while the 1-minute load average is above `LOKI_EVAL_MAX_LOAD` (default
20). On a stop signal it signals only the PIDs it recorded.

v10 availability contract: after the run, the v10 engine must have written
`.loki/engine.json` containing `{"engine": "v10"}` in the checkout. Without
that marker, or without the `loki` binary, the run is `arm_unavailable`,
never a pass.

## Scoring

Each results JSONL row has these fields: `task`, `arm`, `status`, `started`,
`ended`, `wall_s`, `time_to_pr_s` (first push to the PR branch minus arm start,
null if none), `pr_opened`, `hidden_pass`, `completed`, `cost_usd`,
`cost_source`, `exit_code`, `capped`, `logs`.

- `completed` = `pr_opened` and `hidden_pass` and not `capped`.
- `cost_usd` is taken only from the provider: claude's `total_cost_usd`, or
  `autonomy/lib/cost-summary.py` for the loki arms, and only when every
  iteration was measured. Otherwise it is null. It is never estimated.
- summarize reports, per arm:
  - completion rate, over runs that were not unavailable. An arm whose runs
    were all unavailable shows n/a.
  - p50 and p90 time to PR over completed runs, using the nearest-rank method.
  - cost per completed task: the total cost of evaluated runs divided by the
    number completed. It shows n/a unless every evaluated run has a cost.
  - the number of runs with a measured cost, capped runs and unavailable runs.
  - with `--markdown`, a list of misses with the reason for each.

## Tests

`bash eval/loki10/test-harness.sh` uses `fixtures/stub-arm.sh` in place of
claude and loki, with the two fixture tasks in `fixtures/`. Their `task.json`
files carry `@SEED_REPO@`/`@SEED_REF@` placeholders, and the test fills them in
after seeding a repo from `seed/`.
