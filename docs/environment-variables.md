# Environment variables

The operator-facing knobs, with defaults read from the source rather than from
memory. Every variable on this page is asserted by a test to still exist, so
this document cannot quietly rot into fiction.

## What this page is not

The codebase references a few hundred `LOKI_*` tokens. Most are internal
plumbing between the CLI and the runner (`LOKI_REG_TARGET`,
`LOKI_CI_JSON_FINDINGS`, and similar), or prefix fragments that are never a
whole variable. Publishing that number as an "operator surface" would be
misleading, so this page covers only what an operator would deliberately set.

`loki config schema` lists 64 more keys that map to environment variables and
can be written to `.loki/config.yaml`. Those are not repeated here. The
variables below are the ones **not** in that schema -- historically the ones
with nowhere to look them up.

## Running a build

| Variable | Default | Effect |
|---|---|---|
| `LOKI_PRD_FILE` | none | Path to a spec file, as an alternative to the positional argument. |
| `LOKI_MAX_ITERATIONS` | `1000` | Hard cap on iterations. Reaching it is a deterministic terminal failure, not a success. Also in `config schema`. |
| `LOKI_BUDGET_LIMIT` | `100.00` on the previous loop; none on the Loki 10 engine | Spend cap in USD. The previous loop (`autonomy/run.sh`) defaults to $100. The Loki 10 engine sets no dollar cap by default, with an API key or on a subscription; `--max-cost`, this variable or `budgets.per_run` sets one, and an unusable value fails closed. |
| `LOKI_RUN_DEADLINE_S` | unset (no limit) | Loki 10 engine: an outer wall-clock limit the run finishes inside, sealing what is done with a draft PR. `loki start --max-time 90m` sets it. |
| `LOKI_E10_DEFAULT_BUDGETS` | unset (off) | `1` restores the Loki 10 engine's old default budgets (900 s run cap sized up to 3600 s, stage limits, 2 fix rounds, 3 proof re-runs, 4 continues and $5 continue line, turn caps, the 20-file dependents cap). Without it, and with no user time limit, a run has no budget and ends when it is done or makes no progress. |
| `LOKI_E10_VERIFY_MAX_S` | unset (no maximum) | Time limit in seconds for one verify stage; `loki start --verify-max-time 20m` sets it. Without it verify is bounded only by a run time limit you set. |
| `LOKI_E10_NO_PROGRESS_ROUNDS` | `2` | With no budget: fix rounds, proof re-runs and continues end after this many rounds in a row without progress (fewer failing checks or unmet acceptance lines than the best round so far, a check that now ran, a plan file that now exists, or new outstanding work named). |
| `LOKI_E10_STALL_KILL_S` | `1800` with no time limit, else off | A session with no new output and no tree change for this many seconds is ended. |
| `LOKI_E10_LOOP_KILL_S` | `3600` | With no time limit: a session that keeps printing but changes nothing in the tree for this long is ended. |
| `LOKI_E10_CMD_SILENCE_S` | `1800` | A test or check command with no time limit is stopped after this long with no output, reported as not run. |
| `LOKI_E10_HANG_SILENCE_S` | `1800` | With no time limit: the supervisor stops a worker that sent no event and runs no process for this long, and seals what is done. |
| `LOKI_MAX_DURATION` | unset (no cap) | Wall-clock cap in seconds. Stops cleanly at the next iteration boundary with a `max_duration_reached` terminal status. `loki start --max-duration` also accepts `90m` / `2h`. |
| `LOKI_AUTO_CONFIRM` | unset | `true`/`false` to control prompts. Takes precedence over `CI`. |
| `LOKI_CONFIG_DUMP` | `0` | `1` prints the resolved configuration and exits **without starting a run or spending anything**. |
| `LOKI_KEEP_RUN_BRANCH` | unset | When a Loki 10 run ends, Loki returns your checkout to the branch you started from (only when it has no uncommitted changes; otherwise it prints how to return), removes the run's leftover temporary worktrees, and deletes the `loki/e10-*` run branch. A branch that was pushed is simply deleted; an unpushed one is first saved as a git bundle in `.loki/runs/<run-id>/branch.bundle` (with `branch.json` holding the branch name and head SHA), and the summary prints the restore command `git fetch .loki/runs/<run-id>/branch.bundle <branch>:<branch>`. If the bundle cannot be written, the branch is kept. Run branches left by earlier runs are saved and removed the same way at the end of the next run (bundles without a run directory go to `.loki/runs/legacy-branches/`). A run that passed but published nothing (no remote, or `--no-pr`) keeps its branch checked out, a run you can still resume keeps its branch, and a live run's branch or a branch checked out in any worktree is never touched; branches not named `loki/e10-*` are never touched. `1` turns all of this off and keeps every run branch, as before. Independently of this setting, session id files are written in the run directory instead of loose in `.loki/`, and the next run moves older loose ones there. |
| `LOKI_E10_PROVE_BY_RUNNING` | `1` | On an issue run with the Claude provider, the implement session may start the repository's own services (and must stop what it started), is asked to prove the change by running it the way its real caller does, to finish every item the issue lists or end with `LOKI_UNFINISHED: <what is left>`, and gets no time-budget sentence. `0` leaves the issue-run brief as before. |
| `LOKI_E10_ENV_CARD` | `1` | On an issue run with the Claude provider, database and cache servers the repository needs (Postgres, Redis, MySQL or MariaDB, MongoDB) that are installed off PATH, for example as a Homebrew keg-only package, are added to the end of the implement session's PATH and named in its brief. `0` turns this off. |
| `LOKI_E10_PROVE` | `0` (off) | On an issue run with the Claude provider, the issue's asks are listed word for word, a separate session writes one script per ask and the harness runs them on a fresh environment and on the base commit; the run is VERIFIED only when every ask passes on the change and fails without it. Off by default; `1` turns the stage on. `LOKI_E10_PROVE_BUDGET_S` (default `600`) is the stage's time, added to a sized run cap; `LOKI_E10_PROVE_SCRIPT_S` (default `120`) is each script's limit. |
| `LOKI_E10_ISSUE_ACCEPTANCE` | on | On an issue run, the label is checked against the issue's own acceptance lines: one short check marks each line met (with evidence that it was exercised) or not met, and any line not met makes the run PARTIAL. `0` turns the check and the cap off. `LOKI_E10_ISSUE_ACCEPTANCE_MODEL` picks the model for the check (default: the run's own model). |
| `LOKI_PR_LABEL` | on | Loki sets a GitHub label on the pull request and the issue: `loki: safe to merge` on VERIFIED, `loki: needs you` otherwise. `0` turns it off. |
| `LOKI_E10_PROOF_RERUN` | on | On an issue run, Loki runs the session's proof script (`$TMPDIR/loki-proof.sh`) again by itself after the session and every fix round, in a new empty directory; the acceptance check uses that run's real output and a failing re-run keeps the run from VERIFIED. `0` turns it off. `LOKI_E10_PROOF_RERUN_S` is its time limit in seconds (default 600). |
| `LOKI_E10_PROOF_BASE` | off | Set to `1` to turn it on. On an issue run, after its own passing run of the proof script Loki runs the same script once more against the base commit, in a throwaway checkout with the installed `node_modules` copied in (the working tree is not touched), and compares check by check. A check that also passes there proves nothing about the change. An acceptance line whose passing checks all pass there too is handed back to the session during the run, told to the acceptance reviewer and listed on the receipt (`proof_base`). When the base run prints no check (its setup fails there) or every check passes there, the comparison is reported as not available and changes nothing. `0` turns the base run off. `LOKI_E10_PROOF_BASE_CAP=1` (off by default) also makes it a cap: such a line is not met, so the run is not VERIFIED. Lines that ask that something keeps working, and the fresh-install line Loki adds, are never listed. Only `node_modules` is carried over, so on other stacks the base run usually cannot start and the comparison is not available. |
| `LOKI_E10_OWN_PROOF` | on | Set to `0` to turn it off. When no test read through a known runner fails before the change and passes after it, Loki runs the kept proof script in a copy of the checkout with the change's non-test files put back to the base commit (and in an untouched copy, as a control). A step that ran repository code, passes on the change and in the control, and fails without the change for a reason other than a missing file, module, command or symbol is the change's own proof (`own_proof` on the receipt). The working tree is not touched. |
| `LOKI_E10_UNRUNNABLE_CHECK` | on | Set to `0` to turn it off. A check that could not run on the base commit or on the change, with the same start failure on both sides, does not hold the label when the change has its own fail-before, pass-after proof, no changed file is in the check's package or named in its output, and nothing else holds the label. The receipt lists it under `could_not_run`; the check keeps its failed result. |
| `LOKI_E10_PROVE_REPAIR` | `1` | The prove stage sends asks its scripts did not prove back to the implement session, two rounds at most, and reruns the scripts. `0` keeps the first result. |
| `LOKI_RERUN_GUARD` | `1` | Before any model call, `loki start owner/repo#N` stops when an open Loki pull request from the same owner already covers the issue, and prints its URL. It never closes, edits or comments on that pull request. If the open pull requests cannot be listed it stops too. Skipped with `--no-pr` and when the origin is not on GitHub (a local mirror). `0` starts the run anyway. |
| `LOKI_ISSUE_WHOLE_FIRST` | unset (on for Sonnet and stronger models, off on Haiku) | `loki start owner/repo#N` (and the runs `loki backlog` and `loki issues run` start) runs the issue as one whole-issue run and never splits it up front, whatever its size, on Sonnet and stronger models. A run that implements on Haiku (`--session-model haiku` or `small`, `--haiku`, a Haiku model override) keeps the up-front split of a large issue. `1` forces the whole-issue run on any model; `0` restores the split everywhere. Sizing, the plan and the checks are unchanged. |
| `LOKI_EPIC_PARALLEL` | provider slots, at most 4 (claude 4, opencode 1) | How many slices of a split issue (`loki start owner/repo#N` on a large issue under `LOKI_ISSUE_WHOLE_FIRST=0`) run at once. Slices with no dependency run at the same time, each in its own worktree; a slice that depends on another waits for it and starts on its branch. `1` runs them one at a time. A failing or spec-conflicting slice skips only the slices that depend on it. Slices share one `--max-cost` cap, which can be passed by up to (slices in flight - 1) session costs because each running session sees the cap at its next cost event. |
| `LOKI_SPLIT_ONE_PR` | `1` | A split issue ends in ONE pull request for the issue, not one per slice. Each slice still runs and verifies on its own branch; at the end Loki builds `loki/<issue>-combined` from the issue's base, one commit per slice (`<slice id>: <slice title>`) in dependency order, reruns every slice's sealed tests plus the tests the combined change impacts, seals one combined receipt that lists each slice's verdict (the combined verdict is the weakest slice's, lowered by anything the combined tree breaks), and opens one PR with a section per slice. A merge conflict between slices gets one resolve session; if it still conflicts, that slice (and the slices stacked on it) opens its own PR and the `Combined:` line says why. When the push is refused as a non-fast-forward because the origin already holds `loki/<issue>-combined` from an earlier run of the issue, the rerun publishes on `loki/<issue>-combined-<run id>` (never a forced push), and its PR body links the earlier open combined PRs for you to close; Loki never closes, edits or deletes them. Any other push failure is not retried and the `Combined:` line gives its reason. `0` opens one PR per slice, as before. |
| `LOKI_SPLIT_ONE_PR_MAX_FILES` | `150` | When the combined diff of a split issue touches more files than this, the slices open one PR each instead of one combined PR, and the reason is printed. |
| `LOKI_SPLIT_MAX_SLICES` | `8` | The most slices one split may have (at least 2, at most 32). A split over the cap is re-asked once with the limit. |

For a cost estimate before committing to a run, `loki plan <spec> --json` is
the better tool: it reports complexity, iterations, tokens and cost without
executing. See [cost controls](./cost-controls.md) for how the three caps
interact and why hitting one is a failure rather than a success.

## Choosing a model and provider

| Variable | Default | Effect |
|---|---|---|
| `LOKI_PROVIDER` | `claude` | `claude` or `opencode`. `codex`, `cline`, `aider` and `gemini` were removed and exit 2 with a migration line. |
| `LOKI_SESSION_MODEL` | `medium` | The capability tier for the run: `small`, `medium`, or `high`. See below. |
| `LOKI_DETACH_SETTLE_S` | `3` | Seconds `--detach` waits to see the run survive before it reports "Detached". An engine exit inside the window is reported with the log tail and the engine's exit code. |
| `LOKI_DETACH_CAFFEINATE` | `1` | On macOS, `--detach` holds `caffeinate -i` for the run (blocks idle sleep, not a closed lid). `0` turns it off. |
| `LOKI_DETACHED` | unset | Set to `1` on a detached run. Informational. |
| `LOKI_MAX_TIER` | unlimited | Caps model tier, so a run cannot escalate past what you are willing to pay for. |
| `LOKI_MODEL_OVERRIDE` | unset | Overrides the resolved model outright. A route spec (`ollama/<id>`) works too. |
| `LOKI_MODEL_ROUTE` | unset | `<kind>/<id>` with kind `openrouter`, `ollama`, `lmstudio`, `llamacpp`, `vllm` or `custom`. Routes the Claude harness to that endpoint; `loki models` lists them, `loki models --local` discovers local runtimes. |
| `LOKI_MODEL_BASE_URL` | unset | Base URL for a `custom/<id>` route (required for `custom`). |
| `LOKI_MODEL_API_KEY` | unset | Token for a `custom/<id>` route (optional). OpenRouter reads `OPENROUTER_API_KEY`. |
| `LOKI_OPENCODE_MODEL` | unset | `provider/model` id passed to opencode (for example `openrouter/deepseek/deepseek-v3.2`). Also `LOKI_OPENCODE_FLAGS` and `LOKI_OPENCODE_CLI`. |
| `LOKI_EDIT_MODEL` | unset | Model for `loki edit`. |
| `LOKI_ROLE_PLAN`, `LOKI_ROLE_DEV`, `LOKI_ROLE_TEST`, `LOKI_ROLE_REVIEW`, `LOKI_ROLE_ADVISOR`, `LOKI_ROLE_HELPER`, `LOKI_ROLE_ESCALATE` | unset | The model for one role of a Loki 10 run (`--plan-model`, `--dev-model`, ... on `loki start`). See "A model per role" below. |
| `LOKI_MODELS` | unset | All roles on one line, `plan=opus,dev=haiku,test=haiku,review=sonnet,advisor=opus` (`--models`). A `LOKI_ROLE_<ROLE>` variable wins over its entry here. |
| `LOKI_ENGINE` | unset | `legacy` forces the previous loop; the `--engine` flag wins over it. |
| `LOKI_SUMMARY_JSON` | unset | `1` prints the end-of-run summary as one JSON line on the previous loop. |
| `LOKI_TIER` | `oss` | **Not a model setting.** The open-core licensing seam. Leave it unset. |
| `LOKI_E10_STABLE_PREFIX` | on | Applies only when `LOKI_E10_PREFIX` is not `lean` (lean is the default for claude sessions and replaces the preset outright): engine10 sessions then send the `claude_code` preset with `excludeDynamicSections: true`, so the system prompt is byte-identical across stages and runs and hits the prompt cache. `0` restores the previous preset. |
| `LOKI_E10_INSTALL` | on | Up-front dependency install at intake. `0` disables it (same as `verify.install_deps: false` in loki.yaml); the run then reports the missing dependencies as NOT PROVEN. When on, each package whose dependencies are absent is installed once per run before the baseline, using the lockfile-frozen form when the package has a lockfile: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable` (Yarn Berry) or `--frozen-lockfile`, `bun install --frozen-lockfile`, `uv sync --locked`, `poetry install` (already lock-honoring, kept as written), `pipenv install --deploy`, `cargo fetch --locked`, `BUNDLE_FROZEN=true bundle install`, `composer install`. These never rewrite the lockfile. A lockfile governs a package only when it sits in the package directory, or in an ancestor that declares a workspace containing it (package.json `workspaces`, pnpm-workspace.yaml, Cargo `[workspace]`, uv `tool.uv.workspace`); a standalone sub-project beside a root lockfile keeps its own install command. The install command is rewritten only if it is simple enough to reason about without a shell parser; otherwise it is left as written and recorded `locked: false`: a `||` anywhere (lock_note "fallback masks install failure"); any character outside letters, digits, space, tab and `_./=:@+,%~-` besides the separators `&&`, `;` and newline, or anything before the first install other than `cd <path>`, `export VAR=value` or plain VAR=value assignments, or any assignment to PATH, NODE_OPTIONS, BASH_ENV or ENV (lock_note "unparsed shell construct"); and an install followed by a `;` or newline command, which would mask its failure (lock_note "later command masks install failure"), so after the install only `&&` is allowed. If the locked install fails (for example the lockfile is out of sync with the manifest), the run reports NOT PROVEN with the real error and does not retry with a mutating install. With no lockfile, or no matching rule, the project's own install command runs and the receipt records `locked: false`. The project's own install scripts (for example npm postinstall) run just as they do for a developer, so disable the install for a repo you do not trust. |
| `verify.test_command` (loki.yaml, not an env var) | unset | The repo's committed test command for a Maven, Gradle, .NET or plain-javac repo, e.g. `verify:` then `  test_command: ./mvnw -B -pl app test`. Verify runs it instead of the detected `mvn`, `gradle` or `dotnet` invocation; its output must still carry the build tool's own test summary or the check is NOT PROVEN, never a pass. Changing loki.yaml in a run caps the verdict. Without it, Loki detects pom.xml, build.gradle(.kts), gradlew, mvnw, *.sln and *.csproj and uses the repo wrapper when present. |
| `LOKI_REPO_BASELINE` | unset | `0` skips the intake repo profile and baseline test run. |
| `LOKI_ALLOW_CLAUDE_SIDECALLS` | unset | `1` (exactly) lets PRD enrichment, done recognition, the council voters, the USAGE.md refresh and the quickstart intent check prompt the `claude` CLI under a non-claude provider; `loki doctor --airgap` then reports that as required egress to Anthropic. |

### A model per role

A Loki 10 run (`loki start`, `loki "<task>"`) can run each kind of work on its own model:

```bash
loki start ./prd.md --plan-model opus --dev-model haiku --test-model haiku --review-model sonnet
loki start ./prd.md --models plan=opus,dev=haiku,test=haiku,review=sonnet,advisor=opus,escalate=sonnet
```

| Role | Flag | What runs on it |
|---|---|---|
| `plan` | `--plan-model` | the plan session |
| `dev` | `--dev-model` | implement, its retries and extra attempts, fix rounds, the patch protocol, the tournament candidates |
| `test` | `--test-model` | the Wall test author and re-author, the executable spec, the prove sessions |
| `review` | `--review-model` | the cross-review, the issue acceptance check, the pick between attempts, the conflict referee, the tournament judge |
| `advisor` | `--advisor-model` | the consult and the router advisor tool. It picks the model only and does not turn the advisor on: the consult is on with `LOKI_E10_OPUS_CONSULT=1`, the advisor tool with `LOKI_ADVISOR=1` (alone) or `LOKI_ROUTER=1` / `LOKI_ROUTER=auto` (with the router) |
| `helper` | `--helper-model` | intake checks: the already-done confirmation, project-model discovery, the open-choice vote, the ranked-remedy check |
| `escalate` | `--escalate-model` | a fix round after the same test failure repeats |

A value is `haiku`, `sonnet`, `opus`, `fable` or a model id (on `--provider opencode`, an opencode id). A role you set is exact: it is never
capped to `--model`, never downgraded, never climbed by the router, and the Wall keeps it instead of re-authoring on another model. With `--dev-model`
set, a repeated failure escalates only when `--escalate-model` names the model. A role you do not set keeps Loki's own choice, so a run with no role
behaves exactly as before. Precedence for each call: an older per-call variable (`LOKI_E10_WALL_TIER`, `LOKI_E10_ATTEMPT_MODELS`, `LOKI_E10_CONSULT_MODEL`,
`LOKI_E10_SELECT_REVIEW_MODEL`, `LOKI_E10_ISSUE_ACCEPTANCE_MODEL`, `LOKI_E10_EXEC_SPEC_MODEL`, `LOKI_E10_TOURNAMENT_MODEL`, `LOKI_E10_PRECEDENT_MODEL`,
`LOKI_E10_RANKED_REMEDY_MODEL`), then the role, then `--model` / `--session-model`, then Loki's default. When a role is set the start line names the
model per role (`models: plan opus, dev haiku, ...`; `auto` means Loki picks per call) and the receipt records the models each role started under
`models_by_role`. On the claude provider a value is `haiku`, `sonnet`, `opus`, `fable` or a model id from the catalog (`providers/model_catalog.json`, or
`LOKI_MODEL_CATALOG`), passed to the provider exactly as written; any other value (a typo such as `sonet`, another vendor's id) exits 2 with the
nearest known id. On opencode a value is passed through and opencode checks it. A bad value, a route id (`openrouter/...`: choose a route for the
whole run with `--model`), a role above `LOKI_MAX_TIER`, or any Claude role while `LOKI_MODEL_ROUTE` is set (the route serves every call; unset the
role or the route) exits 2 before any session, naming the role. On opencode, a call that only runs on the Anthropic API
(the consult, the votes, the acceptance check, the attempt pick, the tournament, the executable spec) is skipped when its role names a
non-Claude model, and the receipt's `tool_calls_skipped` names each skipped call with the reason (as it does for `LOKI_E10_PATCH`, which runs on
claude only). The legacy engine refuses the role flags.

Fable (`fable`, `claude-fable-5-2`) runs as Fable on `loki start`, through `--model fable`, `--session-model fable` or a role; earlier releases ran
Opus for a `fable` pin, and the legacy bash engine still does. Fable answers on the Claude CLI and the Agent SDK sessions. With `ANTHROPIC_API_KEY` set,
the tool-less calls go to `/v1/messages`, where Fable is not yet verified: the start line and the receipt (`fable_raw_api`) say so, and a refused or
failed Fable call prints the API's reason and is never re-run on another model. `claude-fable-5-2` is priced by the fable row of the pricing table
(the Fable 5.1 rate); its own rate is not verified.

### Picking a model without naming one

You do not need to know any vendor's model names. Ask for a capability class
and each provider supplies its own latest model in that class:

| Tier | Means | Claude | opencode |
|---|---|---|---|
| `small` | cheap and fast | `claude-haiku-4-5` | `deepseek-chat` |
| `medium` | the workhorse (**default**) | `claude-sonnet-5` | `deepseek-v3.2` |
| `high` | the most capable | `claude-opus-4-8` | `deepseek-v3.2` |

```bash
LOKI_SESSION_MODEL=small loki start ./prd.md    # or: loki start --session-model small ./prd.md
```

`medium` is the default and resolves to the same model today's builds already
use, so setting it explicitly changes nothing. The older spellings
(`fast`/`development`/`planning`, and the Claude aliases `haiku`/`sonnet`/
`opus`) still work and are unchanged.

**To see what a tier actually resolves to on your machine, run `loki provider
models`.** It prints the dispatched model per tier per provider along with
which environment variable set it, so you can verify what you will really get
rather than trusting the table above.

Override a single tier for one provider with `LOKI_<PROVIDER>_MODEL_<TIER>`
(for example `LOKI_CLAUDE_MODEL_FAST=claude-haiku-4-5`), or every tier at once
with `LOKI_<PROVIDER>_MODEL`.

`LOKI_MAX_TIER` is the cost control worth knowing: it bounds escalation, while
`LOKI_BUDGET_LIMIT` bounds total spend. They answer different questions and are
usefully set together. Note that `LOKI_MAX_TIER` is a **ceiling** and
`LOKI_SESSION_MODEL` is a **choice** -- the ceiling still clamps the choice.

`LOKI_CLAUDE_TASK_BUDGET=<tokens>` sends the Agent SDK `taskBudget {total}` so the
model sees a countdown across the whole loop and wraps up instead of running out.
It is advisory only; `LOKI_BUDGET_LIMIT` is the enforcing cap. Unset, zero or a
non-integer sends nothing.

### Web access is now off by default

Claude workers can no longer search or fetch from the web, and cannot read secret
files, unless you opt in. This is intended, not a bug. A worker that follows a
prompt-injected instruction in a web page or a file could otherwise send your
credentials to an outside site, so the default denies the tools that make that
possible:

- `WebFetch` and `WebSearch` are denied.
- `Read` of anything matching `.env*` (so `.env`, `.env.local`, `.envrc`, `.env.prod`, `.env.keys`, and the templates `.env.example`, `.env.sample`, `.env.template`), `*.pem`, and anything under `.aws/` or `.ssh/` is denied, anywhere on disk. The templates are blocked too: a deny beats any allow, so they cannot be carved out of the glob without missing secret names.

This applies to every Claude route (shell, TypeScript and Python launch sites),
whether `LOKI_PERMISSION_POLICY` is `compiled` or `legacy`. If the policy cannot
be compiled (invalid `LOKI_WEB_ALLOW_DOMAINS`, or Node missing), Loki prints a
warning and runs in `plan` mode instead of skipping the rules. Punycode (`xn--`)
domains are rejected the same way.

This is not complete secret-file protection: `Read` denies do not stop
`Bash(cat .env)` under `--dangerously-skip-permissions`.

To turn web access back on:

| Setting | Effect |
|---|---|
| `LOKI_WEB_ALLOW_DOMAINS=docs.python.org,*.example.com` | Allows `WebFetch` for those hostnames only (comma list, ASCII hostnames). `WebSearch` stays denied. Enforced with `LOKI_PERMISSION_POLICY=compiled`; the legacy route keeps both web tools denied and warns. |
| `allow` entry for `WebFetch` or `WebSearch` in your `claude_permissions` policy | Keeps that tool enabled. |
| `LOKI_WEB_POLICY=off` | Disables this policy entirely: no web or credential deny rules, the previous behavior. |

## Steering the loop

These control how the engine decides what to do next. Every one is on by
default and takes `0` to turn it off, so an operator who needs the older
behaviour has a switch rather than a fork.

| Variable | Default | Effect |
|---|---|---|
| `LOKI_EVAL_TREND` | on | Injects the run's own cost, duration and cache-hit trend into the next prompt, so the agent can steer on its own efficiency. `0` removes the block. |
| `LOKI_INJECT_FINDINGS` | on | Injects the previous iteration's reviewer findings, by severity and file:line. `0` makes the next iteration a blind retry. |
| `LOKI_ITERATION_GRACE` | on | When the agent reports done and no gate is failing, grants ONE extra iteration past the cap to land the work. Granted at most once per run. `0` restores a pure counter. |
| `LOKI_SCOPED_CHANGE` | auto | Forces the scoped-change profile on (`1`) or off (`0`). Auto-detected from an issue-sourced spec on a repository with real history. Never disables a trust gate; it skips phases irrelevant to a scoped fix. |
| `LOKI_RISK_TIER` | computed | Raises the verification tier (`low`, `medium`, `high`) above the one computed from the diff. Lowering is ignored unless `LOKI_RISK_OVERRIDE_REASON` is also set. |
| `LOKI_RISK_OVERRIDE_REASON` | unset | Recorded reason that lets `LOKI_RISK_TIER` lower the computed tier. Stored in the risk record and shown in the run summary. |
| `LOKI_E10_PUBLIC_GAP` | off | `1` caps a run at PARTIAL when an added public function is called by no agent-independent passing test (experimental: line numbers can shift in files with multi-line docstrings or template literals). |
| `LOKI_E10_ALREADY_DONE_CHALLENGE` | on | `0` believes an implement session's first LOKI_ALREADY_DONE without the one challenge resume. |

`LOKI_INJECT_FINDINGS=0` is the one to think twice about. Without it the model
is told to fix problems without being told which, so it re-derives them from
scratch every iteration -- the slowest and least accurate way to converge.

### Opt-in extras

These add a model session or prompt text and are off by default, because the
head-to-head benchmark (`benchmarks/h2h/RESULTS.md`) showed them adding cost
with no gain in pass rate. Set each to `1` to turn it on.

| Variable | Default | Effect |
|---|---|---|
| `LOKI_REVIEW_DEFAULT` | off | With no reviewer configured, a medium risk run asks its own CLI for one code review before seal. Off, the receipt lists "one reviewer" as not proven. A high risk run gets that review by default either way, and a configured reviewer (`review:` in loki.yaml, `LOKI_REVIEW_PROVIDER`, a reviewer agent) always runs. |
| `LOKI_ORG_GRAPH` | off | Adds a short "Org knowledge" block to the implement brief on `loki start`: the services this repo defines, who owns the paths the task touches (CODEOWNERS), services in other ingested repos that depend on this one, and ADRs or decision docs that match the task, each line citing repo, path and line. At most 1500 bytes. This repo is re-ingested on every run; other repos are as fresh as their last `loki memory graph ingest`. The size and line count are recorded in `.loki/runs/<id>/lessons-injected.json`. The graph is per machine (not shared across a team) and does not yet read trackers or chat. Repos without an origin remote are keyed by directory name, so two such directories with the same name share facts. With the switch off nothing is spawned or written. |
| `LOKI_KNOWLEDGE_DIR` | `~/.loki/knowledge` | Directory of the org knowledge store (`graph.json`, `patterns.jsonl`). |
| `LOKI_PR_PASSPORT` | on | Set to `0` to leave the proof passport (signed DSSE receipt and public key) out of the PR receipt comment. Only VERIFIED runs get one, and never when the receipt holds local paths or is over 60000 characters. See `docs/PROOF-PASSPORT.md`. |
| `LOKI_PR_LESSONS` | off | Adds lessons from earlier runs and merged PRs to the implement brief: only a failing check, a restored test edit or a spec conflict on a file this run will touch, one line each, at most 400 bytes. Each run's injected lessons are recorded in `.loki/runs/<id>/lessons-injected.json`. Lessons are recorded either way, including checks that blocked a session stop. |
| `LOKI_WORKED_EXAMPLE` | off | Adds an earlier VERIFIED run as a short worked example to the implement brief, only when the new task is a near-duplicate of it. |
| `LOKI_E10_ALREADY_DONE_CHECK` | off | Runs the separate already-done confirmation on a direct task too. Issue tasks always get it; on a direct task the implement session reports already-done itself. |

### Verification depth (risk tier)

The v10 verify stage classifies risk on the diff (the artifact), never on the
prompt, and records the result in `.loki/state/risk-tier.json`. The run
summary prints its one-line `summary` (also `summary.risk` under `--json`; in
default output only while the 8-line cap still holds). A record older than the
run start is ignored, and a classification failure never fails verify.
`loki review --risk` (`autonomy/lib/review_risk.py`) is a separate 0-100
advisory score and is unchanged.

- high: a sensitive path (auth, crypto, payments, migrations or `.sql`, CI config, lockfiles, infra, `.env`), a deleted test file, public API surface (openapi/swagger, `.proto`, `.d.ts`, `api/`, `routes/`, `public/`, index files), 15+ files, or 500+ changed lines.
- medium: an existing test or test config modified, 4+ files, or 100+ changed lines.
- low: everything else. Test files are never counted as sensitive.

| Tier | Selected checks | Recorded as not run |
|---|---|---|
| low | targeted tests, lint of changed files | full test command, reviewer, council, security scan (skipped by design) |
| medium | low plus full test command, one reviewer | one reviewer (and the full test command when no runner was detected) |
| high | medium plus full suite, council, security scan | council, security scan (and the full test command and full suite when no runner was detected) |

Targeted tests and lint always run. At medium and high, verify also runs the
detected full test command (the `deep.ts` per-runner table); a full-test
failure counts like any failing check, and a `not_run` result is added to
`not_proven`. Reviewer, council and security scan are not run by fast verify at
any tier, so they stay recorded as not run; nothing marks a skipped check as
passing. Record shape: `{version, tier, computed, reasons[], stats{files, lines,
sensitive[], tests_modified[], tests_deleted[], api[]}, checks_selected[],
checks_deferred[], override?, override_ignored?, summary}`.

Known gaps: the bash `run.sh` council triggers and the outcome record do not
yet use this tier; public API detection is path-based, not a semantic diff of
exports; a full-test failure that also fails on the base is not subtracted.

## Timeouts

| Variable | Default | Effect |
|---|---|---|
| `LOKI_PROVIDER_IDLE_TIMEOUT` | `120` (seconds) | Kills a provider call that has produced NO output for this long. Idle, not total: a coding agent streams constantly, so silence is the signal, and a long legitimate iteration is never interrupted. |
| `LOKI_PROVIDER_CALL_TIMEOUT` | `7200` (seconds) | Hard ceiling on a single provider call, as a backstop against a process that streams forever without converging. |

Setting either to `0` disables that guard entirely, which is the pre-v8.12
behaviour: a hung provider then has nothing to stop it. Neither timeout
retries. Re-running a coding agent that may already have edited files is not
protective, so a timed-out call fails to the normal failure path instead.

## Output volume

| Variable | Default | Effect |
|---|---|---|
| `LOKI_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `LOKI_QUIET` | `0` | `1` is shorthand for `warn`. |

**Errors are never suppressed.** `error` is the floor, so even the quietest
setting still prints failures -- a verbosity control that could hide why a
build failed would be a footgun. An unrecognized value falls back to `info`
rather than silencing the run, so a typo in a pipeline config cannot blind you.

Available as flags too: `loki start --quiet`, `loki start --log-level LEVEL`.

Decorative output (the HUD, the completion card, the start headline) already
suppresses itself when stdout is not a TTY, so CI logs were never the wall of
banners you might expect. These variables control the remaining `[INFO]` and
`[STEP]` lines.

## Platform integration

| Variable | Default | Effect |
|---|---|---|
| `LOKI_DURABLE_STATE` | `0` | `1` enables durable state **and** the richer process-exit contract that lets Kubernetes distinguish a deterministic failure from a crash. See [exit codes](./exit-codes.md). |
| `LOKI_SDK_LOOP` | unset | No longer selects a loop: `loki start` routes through `autonomy/route.sh` to the default engine (Loki 10), whose Claude sessions use the Agent SDK unless `LOKI_E10_INVOKER=cli`. Setting it prints a one-line notice. While it is set (directly, or by `LOKI_SDK_MODE=full` or `LOKI_SDK=full`) with the claude provider, `--engine legacy`, `LOKI_ENGINE=legacy` and a PRD over 100000 bytes exit 2 with one line, because the bash loop has no SDK path. |
| `LOKI_ALLOW_AGENT_GITHUB_TOKEN` | unset | By default `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN` are withheld from the agent's environment (the agent runs as the user, so OS keychain and credential files are not yet isolated; P9-ISOLATION is in design). The two routes differ: on the bash route (`autonomy/run.sh`) the withheld tokens are re-granted only for Loki's own trusted calls, namely the `gh()` CLI wrapper, the `_loki_net` helper used by the optional local-PR path in `on_run_complete()`, the session-end `create_session_pr` call, and `autonomy/lib/proof-check.sh`'s network probe. On the Bun route (`loki-ts/src/runner/github_token.ts`'s `withholdGithubTokens()`) the tokens are dropped from the process outright, with no re-grant and no push/PR step of its own. Exactly `1` lets the agent inherit the tokens as before, on either route; that is a Rule of Two exposure, and a one-line stderr warning is printed. |
| `LOKI_AI_MARKING` | unset (off) | `1` (exactly) adds machine-readable trailers to the Loki commit (`AI-Generated: true`, `AI-Provider`, `AI-Model`, `Loki-Receipt`, after `Loki-Run`) and one `AI-Generated: true (...)` marker line under the verdict in the PR body. Values are single-line and bounded. Off, the commit and PR body are byte-identical to before. |

`LOKI_DURABLE_STATE=1` is the one to set in a Job or task definition. Without
it every failure collapses to exit 1 and the platform cannot tell "re-running
this is pointless" from "this crashed and should resume".

## Precedence

Command-line flags beat environment variables, which beat `.loki/config.yaml`,
which beats `~/.config/loki-mode/config.yaml`.

To see what actually resolved, without starting a run:

```sh
LOKI_CONFIG_DUMP=1 loki start ./prd.md
```

## Setting these persistently

`loki config set` writes to the config file for the keys it supports:

```sh
loki config set budget 25
loki config set provider claude
loki config set maxTier sonnet
```

`loki config schema` lists every key the config file understands, and
`loki config show` prints the current effective values.
