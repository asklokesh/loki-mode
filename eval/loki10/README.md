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
  "hidden": {"files": ["<paths relative to hidden/>"], "run": "<command, see below>"},
  "timeout_s": 900
}
```

`eval/loki10/tasks/<id>/hidden/` holds the hidden tests. They exist only in this
repo and are copied into the graded checkout after the arm has finished.

How a hidden run passes. The run gets a fresh random nonce in
`LOKI_EVAL_NONCE`, created after the arm has finished.
- If `hidden.run` is a plain `pytest` or `vitest` command (for example
  `pytest -q tests/test_x.py`, `python -m pytest ...` or `npx vitest run`,
  with no shell operators), it passes when it exits 0 and the runner's own
  summary shows at least one passed test and zero failures or errors. A
  conftest that skips everything therefore fails.
- Any other command must exit 0, and its last stdout line must be the nonce.
  Print it only after every assertion, for example
  `... || exit 1; echo "$LOKI_EVAL_NONCE"`. A test that exits 0 early then
  fails.

A task is `task_invalid` (for every arm) when either of these holds:
- its hidden tests already pass at `repo.ref`, checked before the arm;
- its checkout holds `.loki/engine.json` or `.loki/metrics` after `setup` and
  before the arm.

Validate tasks with `python3 eval/loki10/harness.py validate eval/loki10/tasks/*`.
The validator rejects any of these:
- unknown keys
- an id that differs from its directory
- a non-sha ref
- hidden paths that are absolute or contain `..`
- hidden files that are missing or are symlinks
- a missing `hidden.run`

`run.sh` validates every selected task first.

## Running

```bash
eval/loki10/run.sh --arm raw-claude --all --parallel 3 --out eval/loki10/results
eval/loki10/run.sh --arm v10 --task <id>
eval/loki10/summarize eval/loki10/results/results.jsonl            # plain text
eval/loki10/summarize eval/loki10/results/results.jsonl --markdown # CHANGELOG block
```

Each run, per task and arm:

1. **Clone.** `repo.source` is cloned into a private bare copy inside a
   run-owned temp dir, and the checkout is cloned from that copy. The runner
   checks out `repo.ref` as `main`, deletes every other ref and runs `git gc`,
   so later upstream commits (the fix) cannot be read. It then deletes the
   bare copy, so neither the checkout nor its reflog or config names
   `repo.source`.
2. **Isolation.** `origin` points at a local bare repo, and a post-receive hook
   there records the time of each push. The arm runs with:
   - no `GITHUB_TOKEN`/`GH_TOKEN` and an empty `GH_CONFIG_DIR`
   - `GIT_SSH_COMMAND=false`, `GIT_CONFIG_NOSYSTEM=1` and
     `GIT_CONFIG_GLOBAL=/dev/null`
   - no credential helper and a repo-local commit identity
   - `LOKI_NO_BROWSER=1` and `LOKI_DASHBOARD=false`
3. **Setup and checks.** `setup` runs. The runner then applies the
   pre-arm check and the baseline check described above.
4. **Arm.** The arm runs under `timeout -k 10 <timeout_s>`. When it exits,
   anything left in its process group is killed.
   - raw-claude: `claude -p "<prompt + push instruction>" --output-format json --dangerously-skip-permissions --model $LOKI_EVAL_MODEL`
   - v10: `LOKI_ENGINE=v10 loki "<prompt>"`
   - legacy: `loki start <prompt file>`. The prompt file includes the push instruction.
5. **Grading.** If a non-`main` branch was pushed, the runner writes a PR record
   (`pr.json`). It then clones that branch fresh, runs `setup` again, copies the
   hidden files in (without following symlinks) and runs `hidden.run`. If a
   hidden path in the PR tree is a symlink, or a non-directory blocks one of
   its parent paths, the run is graded as a fail, with `grade_refused` saying
   why. With no PR, the hidden tests run in the arm's checkout for diagnostics
   only.

`LOKI_EVAL_MODEL` defaults to the first planning-tier claude model in
`providers/model_catalog.json`. The loki arms receive the same model through
`LOKI_SESSION_MODEL` (the catalog alias) and `LOKI_MODEL_OVERRIDE`.
`manifest.jsonl` in `--out` gets one line per invocation with the arm, model,
arm binary version and harness SHA. The harness SHA ends in `-dirty` when the
repo has local changes. The arm environment drops every inherited `LOKI_*`,
`CLAUDECODE`, `CLAUDE_CODE_*` and `CLAUDE_PROJECT_DIR` variable. Every child
process runs under `timeout -k`. The runner starts no new run while the
1-minute load average is above `LOKI_EVAL_MAX_LOAD` (default 20). On a stop
signal it signals only the PIDs it recorded.

v10 availability contract. After the run, the checkout must hold both of these:
- `.loki/engine.json` containing `{"engine": "v10", "run_id": "<id>"}`, where
  `<id>` matches `[A-Za-z0-9._-]+`
- `.loki/events/<id>.jsonl`, with an mtime at or after the arm's start

Otherwise, or without the `loki` binary, the run is `arm_unavailable`, never a
pass.

Loki-arm cost contract. Every `.loki/metrics/efficiency/iteration-N.json`
record must carry `"cost_source": "provider"` and a positive `cost_usd`.
Otherwise the run's cost is null.

## Scoring

Each results JSONL row has these fields: `run_id`, `task`, `arm`, `status`,
`started`, `ended`, `wall_s`, `time_to_pr_s` (first push to the PR branch minus
arm start, null if none), `pr_opened`, `hidden_pass`, `grade_refused`,
`completed`, `cost_usd`, `cost_source`, `exit_code`, `capped`,
`push_time_anomaly`, `invalid_reason`, `unavailable_reason`, `logs`.

- `completed` = `pr_opened` and `hidden_pass` and not `capped` and no
  `push_time_anomaly`. A push logged before the arm started is flagged, not
  clamped to zero.
- `cost_usd` is provider-reported only: claude's `total_cost_usd`, or the
  loki-arm contract above. It is never estimated.
- summarize first dedupes: it keeps the newest row per `run_id`, then the
  newest row per (task, arm). It then groups rows by (model, harness_sha) and
  reports, per group:
  - invalid tasks, with the reason for each. They are excluded from every arm.
  - per arm, the completion rate over runs where the arm ran. That means
    status ok, or a `harness_error` after the arm pushed, which counts as
    not completed. Unavailable, infrastructure and interrupted runs are
    counted separately, and an arm with no evaluated runs shows n/a.
  - p50 and p90 time to PR over completed runs, using the nearest-rank method.
  - cost per completed task: the total cost of evaluated runs divided by the
    number completed. It shows n/a unless every evaluated run has a cost.
  - the number of runs with a measured cost, capped runs and unavailable runs.
  - with `--markdown`, a list of misses with the reason for each.

## Known limitations

- **Same-user disk access.** The arm runs as the same OS user as the harness.
  It can read anything that user can read, including this repo's
  `eval/loki10/tasks/*/hidden/` and the grade directories of other runs in
  flight. The harness hides the hidden tests from the checkout, its history,
  argv and env, but it cannot stop a determined arm from searching the disk.
  This applies to every arm equally. Closing it needs a separate OS user or a
  container per arm.
- **Arms read `~/.claude`.** Real `claude` and `loki` arms still read the
  operator's user-level Claude configuration (global CLAUDE.md, plugins,
  hooks). An instruction there such as "never commit without approval" can
  stop an arm from pushing, and it makes results depend on the machine. The
  gate owner must choose an isolation method, for example a clean
  `CLAUDE_CONFIG_DIR`, verify it by hand, and apply it the same way to all
  three arms before trusting a gate run.
- **Orphan cleanup.** Killing the arm's process group catches the arm's
  children. It does not catch a process that deliberately left the group
  (for example with `setsid`).

## Tests

`bash eval/loki10/test-harness.sh` uses `fixtures/stub-arm.sh` in place of
claude and loki, with the two fixture tasks in `fixtures/`. It also uses
variants of them, built in its temp dir. Their `task.json` files carry
`@SEED_REPO@`/`@SEED_REF@` placeholders, and the test fills them in after
seeding a repo from `seed/`.
