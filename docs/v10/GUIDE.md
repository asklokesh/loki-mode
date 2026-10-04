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
file, a flag-first call (`loki start --simple prd.md`) and a one-word start stay
on the legacy engine. The legacy engine is being removed (planned work
resumes 2026-10-07, see docs/v10/LEGACY-REMOVAL.md).

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

## After the flip

D48 made v10 the default for `loki "<task>"`, `loki owner/repo#N` and
`loki quick "<task>"`. 11.0.0 removed the engine switch: `loki legacy` exits
2 with a removal message and LOKI_ENGINE is ignored. Remaining legacy paths
(`loki start ./prd.md` and the no-bun fallback) are tracked in
docs/v10/LEGACY-REMOVAL.md. The marked line near the top of this file and of
README.md's Loki 10 section records the current state.
