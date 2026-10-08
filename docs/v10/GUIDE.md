# Loki 10 engine guide

Default: Loki 10 engine for `loki "<task>"`, `loki owner/repo#N` and `loki quick "<task>"`. `loki legacy` and LOKI_ENGINE were removed in 11.0.0. <!-- loki10-default -->

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
legacy` was removed (it exits 2 with a removal message) and LOKI_ENGINE is no
longer read; any value is ignored.

`loki start owner/repo#N`, `loki start <issue URL>` and `loki start "<multi-word
task>"` run Loki 10, the same as `loki owner/repo#N` and `loki "<task>"`. A PRD
file, a flag-first call (`loki start --simple prd.md`) and a one-word start still
run on the previous bash loop (autonomy/run.sh), and so do the opencode and local-model
providers, until FC38-SWEEP ports them. `loki legacy` and LOKI_ENGINE remain
removed. The previous loop is being removed (see docs/v10/LEGACY-REMOVAL.md).

Some pieces named in this guide are still being built. Each one below says
so plainly instead of describing a finished feature.

## Quickstart

Put the task first, as a quoted multi-word string, so bin/loki's router
sends it to the v10 engine. A one-word argument that is not an issue ref,
or any first argument starting with `-`, stays on the legacy engine.

```
loki "fix the login redirect loop" --no-pr
```

`loki quick "<task>"` is the small-task entry. It runs the same engine
without opening a pull request (the legacy quick never opened one), and the
engine's own sizing picks the lean path for a small task: Plan and Wall are
skipped and implement runs on your run's own model, like a raw session.
`LOKI_E10_CASCADE=1` opts in to the cheaper sonnet start (it prints and
records the downgrade); a repeated test failure always escalates up, never
down (Engine Law L1).
`loki quick --help` and a flag-first `loki quick -v "<task>"` stay on the
legacy quick.

```
loki quick "fix the login redirect loop"
```

If bun is not installed, or LOKI_PROVIDER names a provider the v10 engine
has no invoker for (anything but claude, codex, cline, aider), these entry
points fall back to the legacy engine instead of failing.

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
- `--max-cost <usd>`: per-run cost cap in dollars. Without the flag the cap is
  `budgets.per_run` in the repo's `loki.yaml` (for example
  `budgets:` then `  per_run: 5`), else the default of $20.00. The flag wins over
  the file. The start line shows the cap in force, for example
  `... previous engine), cap $20.00 (default)`. Once priced cost reaches the cap
  the running stage is stopped, no later stage starts, and the run ends
  BUDGET_STOP with exit code 3. Sessions with no provider price never count
  toward the cap.

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

## The summary

A finished run prints the start line, then one label per line (Outcome,
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

| Provider | Cost measured | Kill blocking enforced |
|----------|----------------|--------------------------|
| claude   | yes            | yes                      |
| codex    | no             | no                       |
| cline    | no             | no                       |
| aider    | no             | no                       |
| opencode | not supported  | n/a                      |

For codex, cline and aider, a run's Cost line reads `not measured` and the
NOT PROVEN line adds the literal entry `kill blocking not enforced`
(`loki-ts/src/engine10/stages/seal.ts`). opencode is not one of engine10's
provider names (`claude`, `codex`, `cline`, `aider`); it is not supported.

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

D48 made v10 the default for `loki "<task>"`, `loki owner/repo#N` and
`loki quick "<task>"`. 11.0.0 removed the engine switch: `loki legacy` exits
2 with a removal message and LOKI_ENGINE is ignored. PRD-file starts
(`loki start ./prd.md`), the opencode and local-model providers, and the no-bun
fallback still run on the previous bash loop until FC38-SWEEP ports them; they are tracked in
docs/v10/LEGACY-REMOVAL.md. The marked line near the top of this file and of
README.md's Loki 10 section records the current state.
