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
| `LOKI_BUDGET_LIMIT` | `100.00` | Spend cap in USD on the previous loop (the Loki 10 engine uses `--max-cost`, `budgets.per_run` or a default of $100 only when `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set; none on a subscription). Also enforced by kill on codex, cline, aider and opencode in the Loki 10 engine. Breaching it **pauses** the run (writes `.loki/PAUSE` and saves state); it never kills work or discards a deliverable. Remove `.loki/PAUSE` to resume, or raise the cap. Set to `""` for no cap. A warning is logged at 80%. |
| `LOKI_MAX_DURATION` | unset (no cap) | Wall-clock cap in seconds. Stops cleanly at the next iteration boundary with a `max_duration_reached` terminal status. `loki start --max-duration` also accepts `90m` / `2h`. |
| `LOKI_AUTO_CONFIRM` | unset | `true`/`false` to control prompts. Takes precedence over `CI`. |
| `LOKI_CONFIG_DUMP` | `0` | `1` prints the resolved configuration and exits **without starting a run or spending anything**. |

For a cost estimate before committing to a run, `loki plan <spec> --json` is
the better tool: it reports complexity, iterations, tokens and cost without
executing. See [cost controls](./cost-controls.md) for how the three caps
interact and why hitting one is a failure rather than a success.

## Choosing a model and provider

| Variable | Default | Effect |
|---|---|---|
| `LOKI_PROVIDER` | `claude` | `claude`, `cline`, `codex`, `aider`, or `opencode`. |
| `LOKI_SESSION_MODEL` | `medium` | The capability tier for the run: `small`, `medium`, or `high`. See below. |
| `LOKI_MAX_TIER` | unlimited | Caps model tier, so a run cannot escalate past what you are willing to pay for. |
| `LOKI_MODEL_OVERRIDE` | unset | Overrides the resolved model outright. A route spec (`ollama/<id>`) works too. |
| `LOKI_MODEL_ROUTE` | unset | `<kind>/<id>` with kind `openrouter`, `ollama`, `lmstudio`, `llamacpp`, `vllm` or `custom`. Routes the Claude harness to that endpoint; `loki models` lists them, `loki models --local` discovers local runtimes. |
| `LOKI_MODEL_BASE_URL` | unset | Base URL for a `custom/<id>` route (required for `custom`). |
| `LOKI_MODEL_API_KEY` | unset | Token for a `custom/<id>` route (optional). OpenRouter reads `OPENROUTER_API_KEY`. |
| `LOKI_OPENCODE_MODEL` | unset | `provider/model` id passed to opencode (for example `openrouter/deepseek/deepseek-v3.2`). Also `LOKI_OPENCODE_FLAGS` and `LOKI_OPENCODE_CLI`. |
| `LOKI_EDIT_MODEL` | unset | Model for `loki edit`. |
| `LOKI_ENGINE` | unset | `legacy` forces the previous loop; the `--engine` flag wins over it. |
| `LOKI_SUMMARY_JSON` | unset | `1` prints the end-of-run summary as one JSON line on the previous loop. |
| `LOKI_TIER` | `oss` | **Not a model setting.** The open-core licensing seam. Leave it unset. |
| `LOKI_E10_STABLE_PREFIX` | on | Engine10 sessions send the `claude_code` preset with `excludeDynamicSections: true`, so the system prompt is byte-identical across stages and runs and hits the prompt cache. `0` restores the previous preset. `LOKI_E10_PREFIX=lean` still wins when set. |
| `LOKI_E10_INSTALL` | on | Up-front dependency install at intake. `0` disables it (same as `verify.install_deps: false` in loki.yaml); the run then reports the missing dependencies as NOT PROVEN. When on, each package whose dependencies are absent is installed once per run before the baseline, using the lockfile-frozen form when the package has a lockfile: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --immutable` (Yarn Berry) or `--frozen-lockfile`, `bun install --frozen-lockfile`, `uv sync --locked`, `poetry install` (already lock-honoring, kept as written), `pipenv install --deploy`, `cargo fetch --locked`, `BUNDLE_FROZEN=true bundle install`, `composer install`. These never rewrite the lockfile. A lockfile governs a package only when it sits in the package directory, or in an ancestor that declares a workspace containing it (package.json `workspaces`, pnpm-workspace.yaml, Cargo `[workspace]`, uv `tool.uv.workspace`); a standalone sub-project beside a root lockfile keeps its own install command. The install command is rewritten only if it is simple enough to reason about without a shell parser; otherwise it is left as written and recorded `locked: false`: a `||` anywhere (lock_note "fallback masks install failure"); any character outside letters, digits, space, tab and `_./=:@+,%~-` besides the separators `&&`, `;` and newline, or anything before the first install other than `cd <path>`, `export VAR=value` or plain VAR=value assignments, or any assignment to PATH, NODE_OPTIONS, BASH_ENV or ENV (lock_note "unparsed shell construct"); and an install followed by a `;` or newline command, which would mask its failure (lock_note "later command masks install failure"), so after the install only `&&` is allowed. If the locked install fails (for example the lockfile is out of sync with the manifest), the run reports NOT PROVEN with the real error and does not retry with a mutating install. With no lockfile, or no matching rule, the project's own install command runs and the receipt records `locked: false`. The project's own install scripts (for example npm postinstall) run just as they do for a developer, so disable the install for a repo you do not trust. |
| `LOKI_REPO_BASELINE` | unset | `0` skips the intake repo profile and baseline test run (see docs/HARNESS-INTELLIGENCE-PLAN.md). |
| `LOKI_ALLOW_CLAUDE_SIDECALLS` | unset | `1` (exactly) lets PRD enrichment, done recognition, the council voters, the USAGE.md refresh and the quickstart intent check prompt the `claude` CLI under a non-claude provider; `loki doctor --airgap` then reports that as required egress to Anthropic. |

### Picking a model without naming one

You do not need to know any vendor's model names. Ask for a capability class
and each provider supplies its own latest model in that class:

| Tier | Means | Claude | Codex | Cline / Aider / OpenCode |
|---|---|---|---|---|
| `small` | cheap and fast | `claude-haiku-4-5` | account default | `deepseek-chat` |
| `medium` | the workhorse (**default**) | `claude-sonnet-5` | account default | `deepseek-v3.2` |
| `high` | the most capable | `claude-opus-4-8` | account default | `deepseek-v3.2` |

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
rather than trusting the table above. Codex deliberately shows a provider
default: it sends no `--model` flag and lets Codex pick a model appropriate to
your account, because a hardcoded name breaks ChatGPT-account users.

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

The same secret-path list also drives Bash deny rules (one list in
`src/policies/claude_permissions.js`, so the Read and Bash sides cannot drift):
`cat`, `head`, `tail`, `sed`, `grep`, `egrep`, `fgrep`, `rg`, `awk`, `less`, `more`, `nl`,
`tac`, `strings`, `xxd`, `od`, `base64`, `cp`, `source` and `.` naming a denied path, and an
input redirect (`< .env`), are denied under `--dangerously-skip-permissions`. The rules
reach every route (bash, TypeScript, Python, SDK) and go away with `LOKI_WEB_POLICY=off`.
Measured on claude 2.1.308 against a stub API: the Read denies alone already refuse most
plain reads (40 of 57 probes); the Bash rules newly deny exactly five more: `cat $PWD/.env`,
`xargs cat <<< .env`, `cat *.pem`, `source .env` and `. ./.env`. Each denial is recorded as a
`permission_denied` event in `.loki/events.jsonl` when the SDK route reports it.

This is not complete secret-file protection. A shell cannot be sandboxed by pattern. These
measured classes still read a denied file: a recursive grep (`grep -r SECRET .`), a
path-qualified reader (`/bin/cat .env`), a case variant on a case-insensitive filesystem
(`CAT .env`), a pipe to xargs (`echo .env | xargs cat`), `dd if=.env`, and shell re-entry
(`bash -c`, `sh -c`, `eval`). An interpreter (`python -c`, `node -e`, `perl`, `ruby`), a
variable or command substitution, a glob that avoids the literal name, or a copy to another
name also read the file. These rules narrow the plain paths; they are not a boundary. The
boundary is the native sandbox (#291).

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

`LOKI_INJECT_FINDINGS=0` is the one to think twice about. Without it the model
is told to fix problems without being told which, so it re-derives them from
scratch every iteration -- the slowest and least accurate way to converge.

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
| `LOKI_SDK_LOOP` | unset | Routes the run through the Bun/TypeScript runner instead of bash. Both implement the same exit contract. |
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
