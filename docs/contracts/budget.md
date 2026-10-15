# Budget contract

This is the one place that defines the per-run spend cap: its default, how it is
chosen, what it covers, where it is enforced, how far a run can overshoot it, what
happens when a price is missing, and what happens when a run is cancelled. The CLI
help, the run-start line and this document must agree; tests pin them.

## Default

The default cap is **100 USD per run**.

The number lives in one file, `loki-ts/data/budget-defaults.json`
(`default_max_cost_usd`). Both routes read it:

- TypeScript: `loki-ts/src/e10ext/budget_cap.ts` (`DEFAULT_MAX_COST_USD`).
- Bash: `autonomy/run.sh` (`BUDGET_LIMIT`) and the help text through
  `autonomy/lib/budget-default.sh` (`loki_budget_default_usd`).

`loki-ts/tests/engine10/budget_contract.test.ts` asserts that this document, the JSON
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

## Precedence

Highest first. The first one set wins.

1. `--max-cost USD` (engine10) or `--budget USD` (bash route). `loki start --budget`
   is forwarded to engine10 as `--max-cost`.
2. The environment variable `LOKI_BUDGET_LIMIT`. On the bash route an empty value
   (`LOKI_BUDGET_LIMIT=`) means unlimited.
3. Config file: `budgets.per_run` in `loki.yaml` (engine10), or the budget setting in
   the settings file loaded by `autonomy/run.sh` (bash route).
4. The default above (subject to the API-key rule for engine10).

## Run-start line

Every start prints the active cap and where it came from.

- engine10: the start line ends the cap clause with `cap $X.XX (SOURCE)` where SOURCE
  is `--max-cost`, `env`, `loki.yaml` or `default`, or `no dollar cap (subscription)`.
  The default output stays within its 8-line limit.
- bash route: `Budget limit set: $X.XX (source: flag|env|config|default)`.

A cap set through the bash settings file is reported as `config`; the `--config`
file loader exports the variable, so it reports as `env`.

## Scope

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

## Enforcement point and overshoot

engine10 checks the cap before each stage starts (`machine.ts`, `capReached`), using
the cost events recorded so far. A stage that is already running is not interrupted by
the dollar cap. The documented overshoot is therefore up to the cost of the stages in
flight when the cap is crossed (the plan and wall stages can run together). Time caps
and the per-session time limit still apply inside a stage.

The bash route checks after each iteration (`check_budget_limit`), so the overshoot is
up to one iteration.

## Missing prices

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

## Cancellation

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

The test `loki-ts/tests/engine10/cancel_sigint_e2e.test.ts` drives this with a stub
provider that sleeps.
