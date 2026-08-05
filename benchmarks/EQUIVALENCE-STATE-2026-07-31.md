# Model-equivalence: what is measured, and what the next dollar should buy

Aggregated 2026-07-31 across every result file in `benchmarks/bench/results/`.
Nothing here is projected or interpolated.

## The standing

| Arm | successes/trials | rate | Wilson 95% CI |
|---|---|---|---|
| **haiku + full harness** | 25/25 | **1.00** | [0.87, 1.00] |
| sonnet | 30/35 | 0.86 | [0.71, 0.94] |
| opus, harness off | 8/10 | 0.80 | [0.49, 0.94] |
| haiku, harness off | 5/7 | 0.71 | [0.36, 0.92] |

Success = a held-out acceptance oracle exiting 0. For `hard-1-order-api` that
oracle imports the produced module and asserts full REST semantics -- status
codes, validation, 400s on malformed input. The agent never sees the file.

## What this supports, stated conservatively

Haiku with the harness has not failed in 25 trials, and its lower confidence
bound (0.87) sits above the point estimates of both baseline arms. The harness
lift on the *same model* is the cleanest signal: haiku 0.71 -> 1.00.

**What it does not yet support:** a claim that haiku-full is *better* than
opus-baseline. The intervals overlap. Anyone who reads statistics will say so,
and they will be right.

## Where the next dollar goes, and why not where I first thought

The instinct is to run more haiku-full trials. That is close to worthless: at
25/25 the interval is already tight, and each additional success moves the
lower bound by roughly a point.

**The uncertainty lives in the baseline arms.** opus-baseline at n=10 has a CI
of [0.49, 0.94] -- a span so wide it cannot support any comparison. haiku-
baseline at n=7 is worse.

Priority for spend:

1. **opus-baseline to n>=30** -- the comparison everyone will actually ask about
   ("your cheap model beats their expensive one?"). ~$23 at $0.766/run.
2. **haiku-baseline to n>=30** -- isolates harness lift on a fixed model, the
   strongest form of the argument. ~$2.90 at $0.096/run.
3. Only then, more haiku-full.

Total for 1+2: roughly $26, and it converts a suggestive result into a
defensible one.

## A caveat that matters more than the numbers

`hard-1-order-api` was measured today at haiku-baseline success = 1.0 (single
trial, $0.20, 611s). Every baseline failure in the corpus comes from
`simple-2-fizzbuzz` (0.0 twice) rather than the tasks labelled hard.

That is a warning about the task suite, not about the models: a task where the
baseline already succeeds has no discriminating power, and a suite whose only
failures are on a *simple* task is measuring something other than difficulty.
Before scaling the matrix, the suite needs tasks where a bare model reliably
fails -- otherwise more trials just buy a tighter interval around a ceiling.

## Update: the suite now has a discriminating task

`hard-2-ledger` was authored and measured the same day. First result:

| cell | success | acceptance_exit | cost | duration |
|---|---|---|---|---|
| haiku-baseline | **False** | 1 | $0.307 | 383s |

This is the first task in the corpus where a bare model fails on something
other than `simple-2-fizzbuzz`. The suite can now separate arms, which is the
precondition for every trial purchased after this point.

The paired cell then ran on the same task, same model:

| cell | success | exit | cost | duration |
|---|---|---|---|---|
| haiku-baseline | **False** | 1 | $0.307 | 383s |
| haiku-full | **True** | 0 | $0.541 | 1200s |

**Same model. Same prompt. The harness is the only variable, and it is the
difference between a failing implementation and a passing one.** That is the
thesis, on a task built specifically so a bare model would fail it.

Two caveats stated up front, because n=1 each:

1. This is a single trial per arm. It demonstrates the mechanism; it does not
   establish a rate. The value of further trials is now real, which was not
   true before this task existed.
2. `haiku-full` ran 1199.98s against the task's own `agent_timeout_s` of 1200
   -- it used essentially its entire budget and passed at the wire. The CELL
   cap was 2400s, so this was not a kill, but a task tuned slightly harder
   could plausibly have exhausted it. Worth watching as trials accumulate.

The cost ratio is the other half of the story: $0.54 for a correct
implementation versus $0.31 for an incorrect one. A cheap failure is not
cheaper.

## Reproduce

```sh
LOKI_BENCH_TRIALS=1 bash benchmarks/bench/matrix.sh cell haiku baseline hard-1-order-api
```

Result files land in `benchmarks/bench/results/` and are never overwritten.
