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
`manifest.jsonl` in `--out` gets one line per invocation with the arm, model,
arm binary version and harness SHA. The arm environment drops every inherited
`LOKI_*`, `CLAUDECODE`, `CLAUDE_CODE_*` and `CLAUDE_PROJECT_DIR` variable (the auth token is added back, to the arm
process only; see Config isolation), so operator knobs and the harness's own `LOKI_RUN_TMP` never steer an arm. Every child process runs under `timeout -k`. The runner starts no
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
`cost_source`, `exit_code`, `capped`, `logs`, `auth_source`.

- `completed` = `pr_opened` and `hidden_pass` and not `capped`.
- `cost_usd` is taken only from the provider: claude's `total_cost_usd`, or
  `autonomy/lib/cost-summary.py` for the loki arms, and only when every
  iteration was measured. Otherwise it is null. It is never estimated.
- summarize reports, per arm:
  - completion rate, over runs where the arm actually ran (`status` ok).
    Unavailable runs, infrastructure failures (prepare, setup, harness
    error) and runs interrupted by a stop signal are counted separately. An
    arm with no evaluated runs shows n/a.
  - p50 and p90 time to PR over completed runs, using the nearest-rank method.
  - cost per completed task: the total cost of evaluated runs divided by the
    number completed. It shows n/a unless every evaluated run has a cost.
  - the number of runs with a measured cost, capped runs and unavailable runs.
  - with `--markdown`, a list of misses with the reason for each.

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
claude and loki, with the two fixture tasks in `fixtures/`. Their `task.json`
files carry `@SEED_REPO@`/`@SEED_REF@` placeholders, and the test fills them in
after seeding a repo from `seed/`. The test exports a fake
`CLAUDE_CODE_OAUTH_TOKEN`, so it never reads the keychain. Leg 12 runs all three
arms with an operator `CLAUDE_CONFIG_DIR` that holds a CLAUDE.md. It checks
that each arm sees its own empty `<rundir>/claude-config` with no CLAUDE.md
and an auth token. Its task's setup and hidden test print whether the auth
vars are set, and the leg requires both to be empty in `setup.log` and
`grade.log`. The stub prints its argv, which must not contain the token. The
leg repeats all of this for an operator `ANTHROPIC_API_KEY`, and finally checks
that no token value appears in any log. Three mutations each turn it red: auth
passed to `hidden.run`, `CLAUDE_CODE_` dropped from the scrub, and the token
appended to the arm argv.
