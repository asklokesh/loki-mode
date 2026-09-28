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
  "timeout_s": 900,
  "tier": "small | medium | large (optional, defaults to small)"
}
```

`eval/loki10/tasks/<id>/hidden/` holds the hidden tests. They exist only in this
repo and are copied into the graded checkout after the arm has finished.

How a hidden run passes. The run gets a fresh random nonce in
`LOKI_EVAL_NONCE`, created after the arm has finished.
- If `hidden.run` is a plain `pytest` or `vitest` command, it passes when it
  exits 0 and the runner's own summary shows at least one passed test and
  zero failures or errors. A conftest that skips everything therefore fails.
  "Plain" means one command with no shell operators outside quotes and no
  `$` or backticks. Examples: `pytest -q tests/test_x.py`,
  `.venv/bin/python -m pytest -q -k "(a or b)"` (any interpreter path),
  `npx vitest run` or `pnpm exec vitest`.
- Any other command must exit 0, and its last stdout line must be the nonce.
  Print it only after every assertion, for example
  `... || exit 1; echo "$LOKI_EVAL_NONCE"`. A test that exits 0 early then
  fails.

A task is `task_invalid` (for every arm) when either of these holds:
- its hidden tests already pass at `repo.ref`, or its hidden files cannot be
  placed there (checked before the arm);
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
eval/loki10/run.sh --arm raw-claude --all --tier medium --out eval/loki10/results
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
   hidden files in and runs `hidden.run`. The copy never follows symlinks, and
   any existing file at a hidden path is unlinked first, so a hardlink cannot
   be written through. If a
   hidden path in the PR tree is a symlink, or a non-directory blocks one of
   its parent paths, the run is graded as a fail, with `grade_refused` saying
   why. With no PR, the hidden tests run in the arm's checkout for diagnostics
   only.

`LOKI_EVAL_MODEL` defaults to the first planning-tier claude model in
`providers/model_catalog.json`. The loki arms receive the same model through
`LOKI_SESSION_MODEL` (the catalog alias) and `LOKI_MODEL_OVERRIDE`.
`manifest.jsonl` in `--out` gets one line per invocation with the arm, model,
arm binary version, harness SHA, isolation method and auth source. The harness
SHA ends in `-dirty` when the repo has local changes. The arm environment drops
every inherited `LOKI_*`, `CLAUDECODE`, `CLAUDE_CODE_*` and
`CLAUDE_PROJECT_DIR` variable, so operator knobs and the harness's own
`LOKI_RUN_TMP` never steer an arm. The auth token is added back to the arm
process only (see Config isolation). Every child process runs under
`timeout -k`. The runner starts no new run while the 1-minute load average is
above `LOKI_EVAL_MAX_LOAD` (default 20). On a stop signal it signals only the
PIDs it recorded.

v10 availability contract (ENGINE.md sections 5 and 10). After the run, the
checkout must hold both of these:
- `.loki/engine.json` containing
  `{"engine": "v10", "run_id": "<id>", "events": ".loki/runs/<id>/events.jsonl"}`,
  where `<id>` matches `[A-Za-z0-9._-]+`. If the `events` field is present, it
  must be exactly that path.
- the event log `.loki/runs/<id>/events.jsonl`: a regular file, not a
  symlink, with an mtime at or after the arm's start

Otherwise, or without the `loki` binary, the run is `arm_unavailable`, never a
pass.

The tasks dir defaults to `eval/loki10/tasks`. Set `LOKI_EVAL_TASKS_DIR` to
use another one. Prefer it over `--tasks-dir`, which puts the path in argv,
where the arm can read it with `ps`.

Loki-arm cost contract. Every `.loki/metrics/efficiency/iteration-N.json`
record must carry `"cost_source": "provider"` and a positive `cost_usd`.
Otherwise the run's cost is null.

## Scoring

Each results JSONL row has these fields: `run_id`, `task`, `arm`, `status`,
`started`, `ended`, `wall_s`, `time_to_pr_s` (first push to the PR branch minus
arm start, null if none), `pr_opened`, `hidden_pass`, `grade_refused`,
`completed`, `cost_usd`, `cost_source`, `exit_code`, `capped`,
`push_time_anomaly`, `invalid_reason`, `unavailable_reason`, `auth_source`,
`logs`.

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
    status ok, or a `harness_error` after the arm started, which counts as
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
  container per arm. The harness's own argv (`python3 .../harness.py run`)
  also reveals where this repo is.
- **A hostile PR can forge a pass.** The nonce and the pytest/vitest summary
  are both visible to the code under test, which runs in the same process
  and env as the hidden test. PR code that echoes `LOKI_EVAL_NONCE`, or
  prints a fake `1 passed in` line, can make a failing run look like a pass.
  The nonce defeats hidden tests that exit early. It does not defeat PR code
  written to cheat, so a completed run still needs a review of the diff.
- **Config isolation is not a sandbox.** Every arm gets a fresh
  `CLAUDE_CONFIG_DIR` (see Config isolation below), so the operator's global
  CLAUDE.md, settings, plugins and hooks no longer steer it. A hostile arm
  running as the same user can still read `~/.claude` and the keychain.
- **Orphan cleanup.** Killing the arm's process group catches the arm's
  children. It does not catch a process that deliberately left the group
  (for example with `setsid`).

## Config isolation (EV-3)

Without isolation, every real arm reads the operator's `~/.claude`: global
CLAUDE.md, settings, hooks, plugins, MCP servers and memory. An instruction
there such as "never commit without approval" can stop every arm from pushing,
and results then depend on the machine.

Method: `arm_env` gives every arm (raw-claude, v10, legacy alike) an empty
per-run `CLAUDE_CONFIG_DIR=<rundir>/claude-config` (mode 700). It overrides any
operator value. The loki arms pass it on to the claude processes they spawn.

Auth. An empty config dir is also logged out. On this macOS machine the login
lives in the keychain entry `Claude Code-credentials`. A fresh
`CLAUDE_CONFIG_DIR` and a fresh `HOME` both reported `loggedIn: false`.
`arm_auth` therefore gives the arm one env credential, in this order:

1. operator `ANTHROPIC_API_KEY`
2. operator `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`; use this on
   CI and Linux)
3. on macOS only, the OAuth access token `claudeAiOauth.accessToken`, read from
   that keychain entry and passed as `CLAUDE_CODE_OAUTH_TOKEN`. The refresh
   token and the MCP tokens are never passed, so an arm cannot rotate the
   operator's login. The token is re-read on each run and must stay valid for
   the run's cap plus 120s.

The credential is added only to the arm process. prepare, setup and grade never
see it, and it is never written to a row, manifest or log. Rows record only
`auth_source`, for example `keychain:claudeAiOauth.accessToken`. With no
credential, `run` exits 2 before cloning anything. A run whose token would
expire mid-run is recorded as `auth_unavailable`, counted as infrastructure,
and is never a miss. `--out` defaults to `results/`, which is gitignored. An
arm can still print its own env into `arm_stdout.log`, so treat `--out` as
sensitive. The keychain is read only through `/usr/bin/security`, an absolute
path with no PATH lookup. A keychain token whose `expiresAt` is missing or not
a number is treated as unusable, so the check fails closed.

This is not a sandbox. The env scrub and the fresh config dir only change what
the arm loads by default. Every arm, setup command and hidden test runs as the
same OS user as the operator. Any of them can still read `~/.claude`, the
keychain item and every other file that user can read. The isolation only
removes the operator's global CLAUDE.md, settings, plugins and hooks from what
the arm loads. It does not stop a hostile arm or task from reaching the
operator's credentials. Run untrusted tasks inside a separate OS user or a
container.

Evidence (2026-09-27, claude 2.1.283, Max OAuth login, cwd an empty dir with no
CLAUDE.md in it or any parent, env built by `harness.arm_env` + `arm_auth`):

- Before the change: `claude auth status` under a fresh `CLAUDE_CONFIG_DIR`
  gave `loggedIn: false`, and under a fresh `HOME` it also gave
  `loggedIn: false`. With a fresh `CLAUDE_CONFIG_DIR` plus the env token it
  gave `loggedIn: true, authMethod: oauth_token`.
- `claude -p "Reply with the single word OK" --output-format json` gave
  `{'result': 'OK', 'is_error': False, 'total_cost_usd': 0.0402238}`.
- `claude -p "What global instructions do you have about committing? Answer in one line." --output-format json`
  - isolated: "Commit messages should end with: `Co-Authored-By: Claude ...`".
    That is Claude Code's built-in default. None of the global CLAUDE.md
    markers appear (`git diff --stat`, `disney`, `asklokesh`, "stop and wait").
  - not isolated: "Never commit without explicit approval (show
    `git diff --stat`, ... then wait), stage files by name, use the repo-local
    asklokesh identity ..., never push to github.disney.com ...". The markers
    are present.
- Harness env per arm (redacted): `CLAUDE_CONFIG_DIR=<rundir>/claude-config`
  (empty), `CLAUDE_CODE_OAUTH_TOKEN=<redacted len=108>`, `ANTHROPIC_API_KEY`,
  `GH_TOKEN` and `GH_CONFIG_DIR` handled as above, and `LOKI_ENGINE=v10` only on
  the v10 arm. `HOME` is unchanged.
- The raw arm's exact flags under the isolation
  (`--dangerously-skip-permissions --model claude-opus-5-5`) gave
  `{'result': 'OK', 'is_error': False, 'total_cost_usd': 0.0451086}` with
  modelUsage `['claude-opus-5-5']`. Bypass mode and the pinned model both work
  headlessly in a fresh config dir.

Loki arms under the isolation (from reading the code, not a paid run):
`autonomy/run.sh` asks for an API key only inside Docker or Kubernetes
(`run.sh` near 3333). Its login check calls `claude auth status` first, and
that honors the env token. Its skill check and `autonomy/loki` resolve
`$HOME/.claude/skills`, which still works because `HOME` is unchanged. The
engine stages `.loki/SKILL.md` into the checkout and points its prompt at it,
so it does not need claude to load `~/.claude/skills`.

An isolated arm also runs without the operator's default-model setting (the
fresh config picked a Sonnet model). The arms are pinned by `--model` and
`LOKI_MODEL_OVERRIDE`, so this does not change the eval.

Re-run the proof by hand (the token is never echoed):

```bash
D=$(mktemp -d); cd "$(mktemp -d)"
TOK=$(security find-generic-password -s 'Claude Code-credentials' -w \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["claudeAiOauth"]["accessToken"])')
CLAUDE_CONFIG_DIR="$D" CLAUDE_CODE_OAUTH_TOKEN="$TOK" env -u CLAUDECODE \
  claude -p "What global instructions do you have about committing? Answer in one line." \
  --output-format json | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"])'
```

## Tests

`bash eval/loki10/test-harness.sh` uses `fixtures/stub-arm.sh` in place of
claude and loki, with the two fixture tasks in `fixtures/`. It also uses
variants of them, built in its temp dir. Their `task.json` files carry
`@SEED_REPO@`/`@SEED_REF@` placeholders, and the test fills them in after
seeding a repo from `seed/`. The test exports a fake
`CLAUDE_CODE_OAUTH_TOKEN`, so it never reads the keychain. Leg 12 runs all three
arms with an operator `CLAUDE_CONFIG_DIR` that holds a CLAUDE.md. It checks
that each arm sees its own empty `<rundir>/claude-config` with no CLAUDE.md
and an auth token. Its task's setup and hidden test print whether the auth
vars are set. The leg requires a probe line in the setup, baseline and grade
hidden-run logs, and every probe line in every log must be empty. The stub
prints its argv, which must not contain the token. The leg repeats all of this
for an operator `ANTHROPIC_API_KEY`, and finally checks that no token value
appears in any log. Three mutations each turn it red: auth passed to
`hidden.run`, `CLAUDE_CODE_` dropped from the scrub, and the token appended to
the arm argv.
