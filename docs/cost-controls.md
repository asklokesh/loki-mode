# Cost controls

You set the ceiling. We stop at it, and the receipt tells you where the money
went.

## Why this page exists

"I paid for the AI's own mistakes" is one of the sharpest complaints in this
category, and it is worth being precise about how our model differs.

Most competitors sell credits. Lovable has already addressed the objection
directly -- their "Try to fix" button does not consume credits, and their
troubleshooting docs push you toward reverting or replanning instead of
retrying the same prompt. That is a good policy and we are not claiming to have
invented a better one.

**Our model is different in kind: you bring your own provider credentials.** We
never bill you, because we are never in the payment path. What we owe you
instead is a hard ceiling and an honest account of what was spent -- which is
what this page describes.

## The three caps

They bound different things, and a run that stalls needs all three.

| Cap | Bounds | Default |
|---|---|---|
| `LOKI_BUDGET_LIMIT` | Total spend, in USD | `100.00` (breaching pauses the run) |
| `LOKI_MAX_ITERATIONS` | Number of iterations | 1000 |
| `LOKI_MAX_DURATION` | Wall-clock time | unset (no cap) |

```sh
LOKI_BUDGET_LIMIT=25 loki start ./prd.md
loki start ./prd.md --max-duration 90m
loki config set budget 25
```

**Why three and not one.** Spend and iterations both assume forward progress. A
run that *stalls* -- a hung provider call, a wedged subprocess -- burns hours
while spending almost nothing and completing no iteration, so neither of those
breakers ever trips. The wall-clock cap is the one that catches it. We added it
after a run burned $34 reaching an external timeout.

## Budget contract

The per-run spend cap: its default, how it is chosen, what it covers, where it is
enforced, how far a run can overshoot, what happens when a price is missing, and
what happens when a run is cancelled. The CLI help, the run-start line and this
section must agree; tests pin them.

### Default

The default cap is **100 USD per run**.

The number lives in one file, `loki-ts/data/model-pricing.json`
(`default_max_cost_usd`). Both routes read it:

- TypeScript: `loki-ts/src/e10ext/budget_cap.ts` (`DEFAULT_MAX_COST_USD`).
- Bash: `autonomy/run.sh` (`BUDGET_LIMIT`) and the help text through
  `loki_budget_default_usd` in `autonomy/loki`.

`loki-ts/tests/engine10/budget_cap.test.ts` asserts that this document, the JSON
file, the TypeScript constant, the bash default and the CLI help all state the same
number. Change the JSON file and the document together.

Where the default applies:

| Route | Default applies | What the cap does |
| --- | --- | --- |
| engine10 (`loki "<task>"`, the Loki 10 engine) | Only when an API key is set (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY`). A subscription run (no key) has no dollar cap. | Ends the run `BUDGET_STOP`, exit 3. |
| Bash loop (`loki start`, `autonomy/run.sh`) | Always, key or not. | Pauses the run (writes `.loki/PAUSE` and `.loki/signals/BUDGET_EXCEEDED`); remove both to resume. |
| Bun SDK loop (`LOKI_SDK_LOOP`) | No default. Opt in with `BUDGET_LIMIT`. | Stops the loop when the limit is reached. |

The README and the engine guide have shown different figures in the past (100 and
20). The figure above is the code's, and the two guides follow it.

### Precedence

Highest first. The first one set wins.

1. `--max-cost USD` (engine10) or `--budget USD` (bash route). `loki start --budget`
   is forwarded to engine10 as `--max-cost`.
2. The environment variable `LOKI_BUDGET_LIMIT`. On the bash route an empty value
   (`LOKI_BUDGET_LIMIT=`) means unlimited.
3. Config file: `budgets.per_run` in `loki.yaml` (engine10), or the budget setting in
   the settings file loaded by `autonomy/run.sh` (bash route).
4. The default above (subject to the API-key rule for engine10).

### Run-start line

Every start prints the active cap and where it came from.

- engine10: the start line ends the cap clause with `cap $X.XX (SOURCE)` where SOURCE
  is `--max-cost`, `env`, `loki.yaml` or `default`, or `no dollar cap (subscription)`.
  The default output stays within its 8-line limit.
- bash route: `Budget limit set: $X.XX (source: flag|env|config|default)`.

A cap set through the bash settings file is reported as `config`; the `--config`
file loader exports the variable, so it reports as `env`.

### Scope

- **Per run.** The cap covers one run, not a day or a repository.
- **Retries.** Every session counts, including retried stages and sessions started
  after a provider failover. Each session writes its own cost record, and the run
  total is the sum over every session started, so a retry adds to the total.
- **Child work.** Subagents and tool calls made inside a provider session are part of
  that session's reported cost. Sessions run in a temporary directory (the Wall stage)
  have their cost record copied into the run before the directory is removed.
- **Not counted.** The detached deep verify that may start after a PR opens is a
  separate process and is not counted against the run cap. Sessions with no known
  price are not counted either (see "Missing prices").

### Enforcement point and overshoot

engine10 checks the cap before each stage starts (`machine.ts`, `capReached`), using
the cost events recorded so far. A stage that is already running is not interrupted by
the dollar cap. The documented overshoot is therefore up to the cost of the stages in
flight when the cap is crossed (the plan and wall stages can run together). Time caps
and the per-session time limit still apply inside a stage.

The bash route checks after each iteration (`check_budget_limit`), so the overshoot is
up to one iteration.

### Missing prices

Cost is never reported as 0 when it was not measured.

- A session with no dollar figure records `usd: null` in its cost event. Token counts
  are kept when the provider reported them.
- A model with no entry in the price table (`loki-ts/src/providers/price_table.ts`)
  is not priced with a default guess. The cost record carries `total_cost_usd: null`,
  `cost_basis: "unpriced"` and an `unmeasured_reason` naming the model.
- The bash iteration record omits `cost_usd` and writes `cost_unmeasured_reason`
  instead of `"cost_usd": 0`.
- Unmeasured sessions never count toward the cap, so a run with unpriced models is not
  stopped by a guess. The run summary says `not measured`, or `partial: $X for N of M
  sessions` when only some sessions were priced. It never prints `$0.00` for a run
  whose cost is unknown. The cap is only as good as the prices behind it: a run on a
  model the table does not know is effectively uncapped, and the summary says so.

### Cancellation

SIGINT or SIGTERM during an engine10 run:

1. The supervisor forwards SIGTERM to the worker process group and keeps reading its
   output.
2. The worker stops every live provider session. All providers share one spawn path
   (`createSessionRunner`), so one rule covers them all: SIGTERM to the session's
   process group, then SIGKILL after 2 seconds. No new session starts.
3. Each stopped session records the usage measured so far, with its unmeasured flag
   when no dollar figure exists (`usd: null`).
4. If the worker has not exited after the cancel grace (10 seconds, set with
   `LOKI_E10_CANCEL_GRACE_MS`), the supervisor SIGKILLs the group. A second signal
   escalates immediately.
5. The supervisor opens no PR and makes no backstop commit, restores the branch the
   run started on, and appends `run.completed` with `cancelled: true`,
   `outcome: "CANCELLED"` and the cost folded from the events. `loki status` shows the
   run as `cancelled`, distinct from `FAILED`.
6. The run summary is printed with `Outcome: CANCELLED` and the process exits **130**.

The test `loki-ts/tests/engine10/supervisor_signal.test.ts` drives this with a stub
provider that sleeps.

## Hitting a cap is a FAILURE, not a success

This is the part that matters for anyone automating against us.

All three caps produce a **terminal failure**: exit 20 under
`LOKI_DURABLE_STATE=1`, with a distinct status (`budget_exceeded`,
`max_iterations_reached`, `max_duration_reached`) so the receipt and `loki why`
can tell you *which* ceiling you hit and therefore which one to raise.

`budget_exceeded` used to exit **0**, on the reasoning that a human would raise
the cap and resume. That is true at a terminal and false inside a Kubernetes
Job, where there is no human: the Job went Complete, the pipeline went green,
and an incomplete build looked finished. Exit 0 now means the work is finished
or a person deliberately stopped it -- never that we ran out of money mid-task.

See [exit codes](./exit-codes.md) for the full contract.

## Preview the cost before spending anything

```sh
loki plan ./prd.md --json
```

Reports complexity, estimated iterations, token usage and cost **without
executing**. No provider call, no spend. `LOKI_CONFIG_DUMP=1 loki start ./prd.md`
prints the resolved configuration and exits, so you can confirm your caps are
actually set before a real run.

## What you are charged for, stated plainly

Every iteration calls your provider, including iterations spent re-running
after a quality gate fails. **We do not exempt our own gate failures from your
budget**, and pretending otherwise would be dishonest -- those calls really do
consume your tokens.

What we do instead:

- the caps above bound the total, so a doom loop has a hard ceiling
- the Evidence Receipt records iteration count and cost, so a re-run is visible
  rather than buried
- reaching a cap reports as a failure with the reason named, so you know whether
  to raise the ceiling or narrow the spec

If a run cost more than you expected, `loki proof show <id>` tells you where it
went.

## Backend capability contract (LM-004)

One table in `loki-ts/src/providers/provider_guard.ts` (`CAPABILITIES`) records what each provider guarantees on engine10. `loki provider matrix` prints it (all engines), `loki provider info <name> --json` prints one provider's rows with the source files each value was read from, and `loki start` prints one disclosure line before the run when the provider falls short of Claude. Claude prints nothing extra. On the legacy bash engine only the invocation and sandbox flags are confirmed from code; every other value there is `unknown`, which means not confirmed, not absent.

- cost: `measured` = provider-reported; `estimated` = parsed or size-based and flagged estimated; `none` = reported as not measured.
- budget kill: `post-iteration` = no further stage starts once priced cost reaches the cap; `none` = no cap applies.
- cancel (pgroup): the session child is killed as a whole process group.
- guard scan: `native` = the provider's own hooks gate each call; `post-iteration` = diff scan after each iteration, reverting destructive changes.
- kill blocking: `native` = enforced; `none` = receipts list `kill blocking not enforced`.

| provider | engine | cost | budget kill | cancel (pgroup) | sandbox flags | receipt | resume | guard scan | kill blocking |
|---|---|---|---|---|---|---|---|---|---|
| claude | engine10 | measured | post-iteration | yes | none | yes | yes | native | native |
| codex | engine10 | estimated | post-iteration | yes | --sandbox workspace-write | yes | no | post-iteration | none |
| cline | engine10 | estimated | post-iteration | yes | none | yes | no | post-iteration | none |
| aider | engine10 | estimated | post-iteration | yes | --no-auto-commits | yes | no | post-iteration | none |
| opencode | engine10 | none | none | yes | none | yes | no | post-iteration | none |

### Parallel units and groups

A decomposed run (`loki backlog --dag`, or a spec that splits into a unit group) shares one
total. The resolved cap is exported to every unit as `LOKI_BUDGET_LIMIT`, and the backlog
runner stops launching pending units with `BUDGET_STOP` once the summed measured cost of
finished units reaches that cap. Units already running when the cap is crossed finish, so
the total can overshoot by at most the in-flight units. `budgets.per_run` is accepted as an
alias of `budgets.per_run_usd` in `loki.yaml`.

## A budget stop survives a rerun

When the Bun engine stops a run on its dollar cap it writes
`.loki/runs/<id>/budget.json` with the cap, the amount spent, where the cap
came from, and the outcome `budget_stopped`. `loki status` shows the latest
stop, and the run summary's next step reads "raise with --max-cost, then rerun
the same task".

Rerunning the same task does not reset the meter. The supervisor finds the
newest budget stop for that exact task text and hands its spend to the worker
as `LOKI_E10_SPENT_USD`, so the cap counts the earlier spend too. To continue,
raise the cap with `--max-cost`.

When a dollar cap is set but the provider reports no cost, the start output
adds a warning: the cap cannot be enforced, because unmeasured sessions never
count toward it.
