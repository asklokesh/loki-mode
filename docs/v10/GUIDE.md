# Loki 10 engine guide

Default: Loki 10 engine for `loki start`, `loki "<task>"`, `loki owner/repo#N` and `loki quick "<task>"`. `loki legacy` was removed in 11.0.0; the previous loop runs only on an explicit `--engine legacy` or `LOKI_ENGINE=legacy` (see Routing). <!-- loki10-default -->

Loki 10 is the rewritten engine (docs/v10/ENGINE.md). Since the D48 flip it
runs `loki "<task>"`, `loki owner/repo#N` (issue mode) and `loki quick
"<task>"`, each printing one start line beginning `Loki 10 engine`, then the
summary below. `loki start <issue ref | issue URL | "multi-word task">` takes
the same v10 path as `loki <ref>`. `loki keys` and `loki verify --pubkey`
always run on Loki 10. Bare `loki verify` follows the newest run: when the
newest entry in .loki/runs/ is a v10 run newer than the newest legacy proof
it runs the v10 verify, otherwise the legacy verify. If bun is missing or
LOKI_PROVIDER is unsupported, the default mode falls back to the bash path
and prints one stderr line saying why. In 11.0.0 (LEGACY-ZERO W1-01) `loki
legacy` was removed (it exits 2 with a removal message). From 11.4.0
`--engine legacy|engine10` and LOKI_ENGINE select the engine explicitly (see
Routing below).

## Routing

Argument order and input form never change the engine. Flags are normalized
before the routing decision, so these all run on Loki 10:

```
loki start prd.md              loki start --no-pr prd.md
loki start owner/repo#123      loki start --provider codex owner/repo#123
loki start "fix the login bug" loki start --no-pr "fix the login bug"
loki start fixit               loki quick -v "fix the login bug"
```

A PRD file, an issue ref or URL, a multi-word task and a one-word brief take
the same path. `-v` means `--verbose`, `--budget` and `--budget-limit` mean
`--max-cost`, and `--yes`, `-y`, `--no-plan`, `--no-mirofish` and
`--no-dashboard` are accepted and ignored. A PRD file path that does not exist
exits 2 with "PRD file not found".

The previous loop (autonomy/run.sh) runs only when:

1. you pass `--engine legacy` or set `LOKI_ENGINE=legacy` (`--engine engine10`
   forces Loki 10 and refuses a flag it cannot honor; the flag wins over the
   variable), or
2. the call carries a flag Loki 10 does not support (for example `--simple`,
   `--complex`, `--parallel`, `--github`, `--sandbox`, `--max-iterations`).
   Only that call goes to the previous loop, and one stderr line names the flag
   and the engine chosen, or
3. LOKI_PROVIDER (or `--provider`) names a provider Loki 10 has no invoker
   for (anything but claude, codex, cline, aider, opencode), or bun is missing, or the
   PRD is larger than 100000 bytes. One stderr line says why.

`loki <word>` with a single bare word stays the command namespace (`loki doctor`),
so use `loki start <word>` for a one-word brief. A first argument starting with
`-` followed by a multi-word task or an issue ref (`loki --no-pr "fix it now"`)
runs on Loki 10 like the positional form.

### See the route without running

```
loki route start prd.md
loki route quick "fix the login redirect loop" --json
loki start --simple prd.md --explain-route
```

`loki route [start|quick] <same args>` and `--explain-route` on start or quick
print the engine, provider, model, input type and the reason, then exit 0
without running anything. `--json` prints one JSON object with the keys
`engine`, `provider`, `model`, `input_type`, `input`, `reason`.

Some pieces named in this guide are still being built. Each one below says
so plainly instead of describing a finished feature.

## Quickstart

`loki start` is the primary path. Give it a PRD file, an issue ref, a task in
quotes or a one-word brief. Flags may come before or after it; the engine is
the same (see Routing).

```
loki start prd.md
loki start "fix the login redirect loop" --no-pr
```

`loki "<task>"` and `loki owner/repo#N` are shorthand for the same run.
`loki chat` is an interactive alternative that can start and join these runs
(see Chat below).

`loki quick "<task>"` is the small-task entry. It runs the same engine
without opening a pull request (the legacy quick never opened one), and the
engine's own sizing picks the lean path for a small task: Plan and Wall are
skipped and implement runs on your run's own model, like a raw session.
`LOKI_E10_CASCADE=1` opts in to the cheaper sonnet start (it prints and
records the downgrade); a repeated test failure always escalates up, never
down (Engine Law L1).
`loki quick --help` prints the help; `loki quick -v "<task>"` runs on Loki 10 with
`--verbose`.

```
loki quick "fix the login redirect loop"
```

If bun is not installed, or LOKI_PROVIDER names a provider the v10 engine
has no invoker for (anything but claude, codex, cline, aider, opencode), these entry
points fall back to the legacy engine with a one-line notice instead of failing.

Issue refs work the same way:

```
loki owner/repo#123
loki https://github.com/owner/repo/issues/123
```

bin/loki routes GitHub, GitLab (`.../-/issues/N`) and Jira
(`.../browse/KEY`) issue URLs to the v10 engine, and the issue-fetch step
(autonomy/issue-providers.sh) fetches title/body/labels from all three.
Only the extra already-done check (an issue's `state` and whether it was
closed by a merged PR) is GitHub-only; a GitLab or Jira issue still runs,
just without that extra signal.

Flags, from the engine's own `--help`:

- `--no-pr`: build and verify, but skip opening a pull request.
- `--deep`: request the deep verify pass; the implement time budget goes
  from 480s to 1800s (`loki-ts/src/engine10/types.ts`).
- `--provider <name>`: pick the coding provider for this run. See the
  provider table below.
- `--max-cost <usd>`: per-run cost cap in dollars (`--budget` and
  `--budget-limit` are aliases). Order of precedence: the flag, then
  `budgets.per_run` in the repo's `loki.yaml` (for example `budgets:` then
  `  per_run: 5`), then the default. The default is $100.00 when
  `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set, and no dollar cap on a
  subscription login (usage then counts against your plan limits). Source:
  `loki-ts/src/e10ext/budget_cap.ts`. The start line shows the cap in force,
  for example `cap $100.00 (default)` or `no dollar cap (subscription)`. Once
  priced cost reaches the cap the running stage is stopped, no later stage
  starts, and the run ends BUDGET_STOP with exit code 3. Sessions with no
  provider price never count toward the cap. On the previous loop the same cap
  is `LOKI_BUDGET_LIMIT` (default 100.00 USD; set it to an empty string for
  unlimited), and a breach pauses the run instead of killing it.

`--no-pr`, `--deep` and `--provider` are parsed by the supervisor
(`loki-ts/src/engine10/supervisor.ts`) and take effect on a real run.

`loki status`, `loki verify` and `loki dashboard` are all built on main
(status.ts, verify_cmd.ts, dashboard/server.ts) and route through cli.ts's
table like any other subcommand.

The free-text and issue-ref run itself (the supervisor that plans, builds
and verifies) is wired into the CLI on main: `loki "<task>"` and `loki
<issue-ref>` run the full worker flow (intake, plan, wall, implement,
verify, seal) and then, in the supervisor, the pr stage, ending in the
5-line summary below.

Slack is not part of the v10 engine surface (no command, no notification
hook) and is in progress, tracked with the other wave 3 items.

## Small changes: loki edit

`loki edit` is the lightest path: one Claude pass on the current repo with no
PRD, plan, council, PR, receipt or branch switch. It prints the diff stat, the
diff, and one line with cost and elapsed time.

```
loki edit "rename fooBar to foo_bar"
loki edit src/foo.ts "rename X to Y"
loki edit --verify --commit src/a.ts "add null checks"
loki edit --dry-run "describe the change"
```

- `--verify` runs the fast verifier on the result.
- `--receipt` writes an unsigned receipt to `.loki/edit-receipts/`.
- `--commit` commits only the files the pass touched, by name; skipped when
  verify failed.
- `--dry-run` plans only (plan permission mode); nothing changes.
- `LOKI_EDIT_MODEL` overrides the model. Claude provider only for now.

Use `loki edit` for a single pass, `loki quick "<task>"` for a small task with
a verify loop, and `loki start` for anything that needs a plan, verification
and a sealed receipt. Exit codes: 0 done, 1 provider or verify failure, 2
usage or setup error ([exit-codes.md](../exit-codes.md)).

## Custom agents

Define child agents as markdown with YAML frontmatter in `.loki/agents/<name>.md`
(project) or `~/.config/loki/agents/<name>.md` (user). A project agent wins
over a user agent of the same name. The body is the system prompt.

Frontmatter keys: `name` (must equal the file name without `.md`),
`description` (required), `model`, `provider` (`claude` by default; `codex`,
`cline`, `aider` or `opencode`), `tools` (allow list), `deny` (deny list) and
`permission` (`plan` default, `edit` or `full`).

```
loki agents list
loki agents new reviewer          # reviewer, planner and tester copy shipped examples
loki agents show reviewer
loki agents export --claude       # writes .claude/agents/ (add --user for ~/.claude/agents)
```

`permission: plan` exports as Claude Code `disallowedTools` Edit, Write,
NotebookEdit and Bash. Council reviewers pick up a matching agent: one named
`reviewer`, `tester` or `security` replaces the council-v2 reviewer prompt and
model for the matching roles (`code_quality_reviewer` and
`requirements_verifier` use `reviewer`; `test_auditor` uses `tester`;
`devils_advocate` uses `security`, then `reviewer`). With no agents configured
nothing changes. `loki agent` (singular) is the unchanged built-in agent-type
command.

## Chat (interactive alternative)

`loki start` stays the primary path. `loki chat` is an interactive session for
exploring and small steps, and it hands off to and from `loki start`.

- Start with `loki chat` (needs a TTY; for one-shot tasks use `loki quick`).
  Bare `loki` does not open chat.
- The session starts in Plan mode (read-only); `/plan` and `/build` switch
  modes and the prompt shows `loki[plan]>` or `loki[build]>`. Plan mode is
  enforced for Claude (`--permission-mode plan`); other providers get a
  prompt-level read-only instruction.
- Slash commands: `/plan`, `/build`, `/run <prd|brief>`, `/quick <task>`,
  `/edit <change>`, `/verify`, `/receipt`, `/cost`, `/diff`, `/undo`,
  `/model <id>`, `/provider <name>`, `/help`, `/exit`.
- `/run` starts a normal `loki start` run with the chat's model and provider.
- `loki chat --attach` joins a running or the last `loki start` session, with
  `/status`, `/steer`, `/diff`, `/verify`, `/receipt` and `/stop`.
- `loki chat --tui` launches the full Claude Code TUI with the Loki system
  prompt appended.

## Setup, doctor and config

```
loki setup            # wizard: tools, Claude login, provider, model route, spend cap
loki setup --yes      # non-interactive defaults
loki setup --check    # report only
loki doctor --fix     # create state dirs and a default config; prints exact commands for the rest
loki config list      # also: get <key>, set <key> <value>, path
```

`loki setup` flags: `--provider claude|codex|cline|aider|opencode`,
`--model`, `--budget USD` and `--global`. `loki doctor --fix` never installs
system packages and never runs sudo. Prerequisites are in
[INSTALLATION.md](../INSTALLATION.md).

## Exit codes

One contract, enforced from 11.4.0: [exit-codes.md](../exit-codes.md) lists the
per-command codes, including `loki verify`. CI gates should use
`loki verify || fail`, not `[ $rc -eq 1 ]`, and treat any code of 2 or higher as
worse than CONCERNS. This is a breaking change for scripts that tested rc==1 on
an empty diff or a non-git directory.

## The summary

Every run on both engines also ends with one unified block: `Result:`
(verified, done-unverified, failed or stopped), `Files:` (N changed, +ins
-del), `Cost:` (`$X.XX`, marked `(estimated)` when not provider-reported,
`not measured` when unknown), `Elapsed:`, `Receipt:` (path, when one exists)
and one `next:` line naming the suggested command (`loki diff`, `loki verify`,
`loki undo`, `loki status`, `loki doctor`, or `loki chat --attach`). Pass
`--quiet` to print only this block and `--json` to add a `summary` object to
the JSON output. `NO_COLOR=1` disables color, which is also off when stdout is
not a TTY. On the previous loop, `LOKI_SUMMARY_JSON=1` prints the summary as
one JSON line, and its cost is always an estimate from the context tracker.

A finished engine10 run prints the start line, then one label per line (Outcome,
PR, Receipt, NOT PROVEN, Cost, Time; a Reason line is added for any
outcome other than VERIFIED or ALREADY_SATISFIED). The quiet default stays
within 8 lines. The block below is the older 5-line form; the labels are the
same:

```
PR:         https://github.com/owner/repo/pull/1
Verdict:    VERIFIED
NOT PROVEN: full suite, app boot, council, security scan
Cost:       $0.42 (claude, 212k tokens)
Time:       4m12s (intake 11s, plan 20s, implement 3m10s, verify 31s)
```

- **PR**: the opened pull request URL, or `none` when the run used
  `--no-pr` or never got that far. A draft PR adds the draft reason in
  parentheses.

The PR body is reviewable in 60 seconds (note: the INTEL-3 `renderPrBody` renderer, a 60-line reviewer-first layout, exists but is not yet wired into the live PR stage, which still uses `renderReviewerBody`). It leads with what the issue asked,
then what changed and why, how it was tested, NOT PROVEN, and the receipt digest
with the `loki verify` command. A field the run did not record reads "not
recorded", never a number:

```
## What the issue asked
- handles empty input
- rejects bad tokens

## What changed and why
- Why: Fix the parser
- src/parser.ts
- tests/parser.test.ts

## How it was tested
- Verdict: VERIFIED
- Checks: 2 passed, 0 failed, 0 not run, 0 flaky (4 individual tests counted)
- Command: `bun test tests/parser.test.ts` -> pass
- Target tests (written before the fix): parser.test.ts
- Before the fix: 2 failing, 0 passing on base; after: pass

## NOT PROVEN
- none

## Receipt
- Digest: sha256:ab12... (signed)
- Verify: `loki verify run-1`
```
- **Verdict**: one of VERIFIED, PARTIAL, ALREADY_SATISFIED, SPEC_CONFLICT or
  FAILED.
- **NOT PROVEN**: everything the run did not check, comma-joined. Never
  empty by omission: a check that was skipped or deferred is always listed
  here, not silently dropped. A flaky test found during verify appears as a
  separate `; flaky ...` clause on the same line.
- **Cost**: the provider-reported dollar figure and token count. When the
  provider does not report cost, this line reads `not measured` instead of
  `$0.00`; a missing cost is never rendered as free. The one exception is the
  CLI invoker (LOKI_E10_INVOKER=cli, which the first-run gate's stub uses): it
  has no dollar figure to report, so the run records 0 with the source marker
  `cli-invoker-unmetered` in the cost event, the receipt (`cost.source`) and
  the efficiency record, shows `$0.00 (...; CLI invoker records no cost)`, and
  adds `cost unmetered (CLI invoker; recorded as 0)` to NOT PROVEN. The cost
  fields are never null on such a run.
- **Time**: total wall time, then each stage's own duration in parentheses.

This formatter (`loki-ts/src/engine10/output.ts`, `formatSummary`) is
called by the supervisor at the end of every run, so a real `loki "<task>"`
or `loki <issue-ref>` run prints this block on completion. The block above
is that function's real output, not a mockup.

## Triggers without a cloud

Both run on your own GitHub Actions minutes; there is no hosted service.

- Issue to PR: copy `.github/workflows/loki-issue-to-pr.yml` into your repository. Label an issue `loki`, or comment `/loki` as an owner, member or collaborator, and it runs `loki owner/repo#N` (the Loki 10 engine) and opens a pull request with an evidence receipt. The agent job holds a read-only token; a separate publish job opens the PR. Set `ANTHROPIC_API_KEY` in repository secrets.
- Nightly backlog: copy `examples/loki-nightly-backlog.yml` into `.github/workflows/`. Its `schedule:` trigger runs `loki backlog owner/repo --label loki`, one Loki 10 run per labeled open issue:

```yaml
on:
  schedule:
    - cron: '17 3 * * *'   # nightly, 03:17 UTC
# ...
      - run: loki backlog "${GITHUB_REPOSITORY}" --label loki --concurrency 2
```

`loki backlog` also takes `--all`, `--issues 1,2,3` and `--dry-run`. The nightly job runs the agent and a write token together, so label only issues you trust.

## NOT PROVEN

NOT PROVEN lists what a run did not verify, so a passing run is never read
as more thorough than it was. One entry is unconditional, written by Seal
every time:

- **The deep checks**: `full suite, app boot, council, security scan`.
  They are deferred to a separate deep-verify pass, so Seal always lists
  all four at seal time.

Seal also adds an entry whenever it applies, for example: `cost not
measured (no iteration ids recorded)`, `kill blocking not enforced` for
any provider other than claude, `worker killed by the supervisor backstop
(cap plus grace)`, `event log modified outside the engine`, a flaky test,
a reverted test edit, a model override a non-claude provider could not
honor, a task source the intake step did not record, an uncomputable
diff, an individual check that did not run, or a failed receipt signature.
The Cost line above separately reads `not measured` (never `$0.00`)
whenever the provider reported no dollar figure.

## Receipts

A run writes `.loki/runs/<run-id>/receipt.json` and a matching
`receipt.md`. The JSON receipt's `receipt_sha256` hashes the canonical JSON
without the `verification` block, so verifying a receipt never has to trust
its own signature field to compute the hash it is checking.

`loki verify [run-id]` re-hashes the receipt and checks its signature. A
receipt with no signing key configured (or a key that failed to load) reads
`UNSIGNED` and is never presented as attested; a signed receipt reads
`SIGNED (kid ...)`.

## Provider table

| Provider | Cost measured | Spend cap enforced | Guardrail scan | Kill blocking enforced |
|----------|---------------|--------------------|----------------|------------------------|
| claude   | yes (provider-reported) | yes | native | yes |
| codex    | yes (parsed or estimated) | yes | yes | no |
| cline    | yes (parsed or estimated) | yes | yes | no |
| aider    | yes (reported or estimated) | yes | yes | no |
| opencode | no | no (cost not measured); wall clock limit still applies | yes | no |

Claude Code is the default and the only Tier-1 provider; the others are
optional. Select one with `--provider <name>` or `LOKI_PROVIDER`.

### Cost and the spend cap on non-Claude providers

For codex, cline and aider, engine10 reads token usage from the CLI output
(aider's `Cost: $X session` line is used as-is). If the CLI prints no usage,
cost is estimated from prompt and response sizes (about 4 characters per
token) with the built-in price table (`loki-ts/src/providers/price_table.ts`).
A model not in the table prices at a mid-range default of $2 per 1M input
tokens and $10 per 1M output tokens. Estimated figures carry `estimated: true`
and `cost_basis` (`provider-tokens` or `size-estimate`) on the `cost` event in
`events.jsonl`, and the efficiency record has `cost_source: "estimated"`.
Estimates are approximate. The cap in `--max-cost` applies unchanged. A run
with no prompt and no output stays `not measured`, never `$0.00`.

### Guardrails on non-Claude providers

With codex, cline, aider or opencode, engine10 enforces the wall-clock limit
and `BUDGET_LIMIT` (for example `BUDGET_LIMIT=5 loki start prd.md`) by killing
the process group. After each iteration it scans the diff and reverts and
fails the iteration on mass deletion of tracked files, `.git/config` changes,
new git hooks, and symlinks or paths outside the project (a `guard.violation`
event). Native flags are used where the CLI has them: codex runs with
`--sandbox workspace-write`, aider with `--no-auto-commits`. Cline and
opencode have no sandbox flag. The scan is post-hoc rather than inline, so
receipts still list `kill blocking not enforced` for these providers.

For opencode, a run's Cost line reads `not measured` and the NOT PROVEN line
adds the literal entry `kill blocking not enforced`
(`loki-ts/src/engine10/stages/seal.ts`). opencode is a supported
engine10 provider (`loki-ts/src/runner/provider_opencode.ts`): install it with
`npm install -g opencode-ai` and select it with `--provider opencode`. It runs
`opencode run --auto` non-interactively, takes a `provider/model` id from
`LOKI_OPENCODE_MODEL` (for example `openrouter/deepseek/deepseek-v3.2`; unset
uses opencode's own default), passes extra flags from `LOKI_OPENCODE_FLAGS`,
and honors `LOKI_OPENCODE_CLI` for the binary path. `LOKI_HOST_GUARD=1` is
incompatible with non-Claude providers.

### Model routes and local models

To run OpenRouter or a local model through the Claude harness, so every
Tier-1 control (cost, kill blocking, receipts) still applies, set
`LOKI_MODEL_ROUTE=<kind>/<id>` before `loki start`. Selection is by
environment variable; `loki start` has no `--model` flag.

```
LOKI_MODEL_ROUTE=ollama/qwen3-coder loki start prd.md
LOKI_MODEL_ROUTE=openrouter/deepseek/deepseek-v3.2 loki start "fix the login bug"
```

| Kind | Base URL | Token |
|------|----------|-------|
| `openrouter/<id>` | https://openrouter.ai/api | `OPENROUTER_API_KEY` |
| `ollama/<id>` | http://localhost:11434 | none |
| `lmstudio/<id>` | http://localhost:1234 | none |
| `llamacpp/<id>` | http://localhost:8080 | none |
| `vllm/<id>` | http://localhost:8000 | none |
| `custom/<id>` | `LOKI_MODEL_BASE_URL` (required) | `LOKI_MODEL_API_KEY` (optional) |

A route spec in `LOKI_MODEL_OVERRIDE` works too. The route environment
applies to the Claude child process only; the token is never exported into
your shell, put on a command line, or logged. Plain Claude ids (`opus`,
`sonnet`, `claude-*`) behave as before.

`loki models` lists the routes. `loki models --local` probes Ollama, LM
Studio, llama.cpp and vLLM on their default ports (1s timeout each) and prints
ready-to-paste values. Both accept `--json`.

## Model routing

Model routing picks which Claude model does each stage of a run. It is OFF
by default in 11.2.0. Set `LOKI_ROUTER=1` to opt in. `LOKI_ROUTER=0` is the
explicit opt-out and keeps the exact pre-router model behavior, pins
included (guarded by the opt-out golden test in
`loki-ts/tests/engine10/router_optout_golden.test.ts`). Explicit
`LOKI_MODEL_OVERRIDE` and `LOKI_CLAUDE_MODEL_DEVELOPMENT` still win and
bypass the router. The other knobs are `LOKI_ROUTER_EXECUTOR` (post-flip
default sonnet; haiku only by earned evidence), `LOKI_ROUTER_ESCALATE` (default sonnet) and `LOKI_ROUTER_ADVISOR`
(default opus; `off` disables the advisor). The router engine itself lands in
11.2.0; the pieces below marked "shipped in 11.1.0" are already in the code.

### Executor and advisor

When the router is on, the post-flip default executor is Sonnet 5.5;
Haiku 5.5 per work unit when Opus assigns it. Opus 5.5 is the architect,
router and advisor: it plans, assigns each work unit and is consulted on
hard calls. Sonnet is the senior engineer and the default for
implementation and fixes. Haiku does tests, docs and small low-risk changes
only when Opus assigns them in the plan, and is never the blanket default.
The harness never routes by task type or path regex; it only executes,
verifies and escalates. Per-repo history is an input to Opus, not a harness
rule. The per-unit route (`units: [{id, kind, executor, reason}]` plus a run
default of sonnet) lands in 11.2.0 or 11.2.1 depending on what is merged. A
missing or invalid unit route goes to Sonnet and is reported as NOT PROVEN.
The receipt lists the executor, assigner and reason per unit.
The advisor needs Claude Code 2.1.293 or later,
which the Agent SDK 0.3.293 bundles (shipped in 11.1.0). If the advisor is
unavailable, the executor is Sonnet 5.5 and the run is never failed for it.
The advisor is unavailable when the provider is not
claude, when `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` or
`CLAUDE_CODE_USE_FOUNDRY` is set, when `ANTHROPIC_BASE_URL` points at a
non-Anthropic host, when Claude Code is older than 2.1.293, when
`LOKI_ROUTER_ADVISOR=off`, or after a session reports an advisor tool error
(remembered for the rest of the run). The probe is
`loki-ts/src/runner/router/advisor_probe.ts` (shipped in 11.1.0). The
default-on flip happens after the CTO gate; 11.1.0 and 11.2.0 still ship the
router off.

### Escalation

Escalation is gated on evidence and only moves up: haiku to sonnet to opus,
and sonnet to opus. A haiku unit that fails a code-owned check is redone on
Sonnet, then escalates to Opus. A Wall assigned to Haiku gets an Opus review
before implement. A repeated failure on Sonnet gets a fix round on Opus
before the run can stall. A failure owned by the harness, the environment or
the provider causes no transition and is reported as NOT PROVEN.

### Per-repo-shape outcome memory

Loki remembers how each kind of repo went. The shape key is the Project
Model `workspaceKind` plus the sorted runners, for example
`multi-root:pytest+vitest`; a package with no runner contributes `none`.
Outcomes are stored in the per-repo cache. The haiku floor moves a shape to
Sonnet after 2 code-owned losses in the last 3 Haiku runs. Only code-owned
FAILs and escalations count; harness, environment and provider errors and
NOT PROVEN outcomes never do. A missing or corrupt history file is a cold
read, never a crash (shipped in 11.1.0, `loki-ts/src/runner/router/history.ts`).
The shipped `loki-ts/data/router-shape-defaults.json` is empty in 11.1.0.
After the flip a shape is listed as `haiku` once it has earned it with a B9
row, and an absent listing means Sonnet. Shape history and the defaults file
are inputs to Opus, not harness routing rules.

### Pricing

Haiku 5.5 is priced on its exact model id: $0.10 in and $0.50 out per MTok
for prompts up to 100K tokens, and $0.50 in and $2.50 out over 100K, with
the cache rates in `loki-ts/data/model-pricing.json`. The `haiku` family
alias row in that file is still the Haiku 4.5 price of $1 and $5, because
the exact-id key is matched first (`loki-ts/src/runner/budget.ts`).

### What you see

In 11.2.0 the receipt carries a `route` block (initial decision, each
escalation with its trigger, advisor availability and the share of requests
above 100K), and `loki doctor` prints an advisor line. The executor and any
fallback reason are also printed on the start line.

### Comparing models

`scripts/b9-scoreboard.sh` is the comparison harness for routed against raw
runs on the B9 corpus, and it can emit shape defaults from those runs
(lands in 11.2.0).

## After the flip

D48 made v10 the default for `loki start`, `loki "<task>"`,
`loki owner/repo#N` and `loki quick "<task>"`. 11.0.0 removed `loki legacy`
(it exits 2 with a removal message). From 11.4.0, `--engine legacy|engine10`
and `LOKI_ENGINE` select the engine explicitly, and PRD-file starts, flag-first
calls, one-word briefs and the opencode provider run on Loki 10 (see Routing).
The previous bash loop runs only in the cases listed under Routing. The marked
line near the top of this file and of README.md's Loki 10 section records the
current state.
