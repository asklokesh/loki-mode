# What our verification costs, and what it does not prove

This page exists because the most credible thing 8090 AI published was not a
capability claim. It was a cost:

> "the most common failure mode of vendor evaluation frameworks is to promise
> that no operational burden falls on the customer team. That promise is
> incompatible with a measurement signal that survives audit. The eval that
> costs nothing to run is, in our experience, the eval that cannot be defended
> in a regulatory inspection."

They name a seven-minute-per-document human cost, a 50-document golden dataset,
and several days per quarter of recalibration, and they refuse to automate the
one human signal away. That refusal is what makes the rest of their numbers
believable.

So here are ours. Every figure below was measured on this repository, and the
command that produces it is given so you can measure it yourself and get a
different answer on your hardware.

## Measured cost

| Check | Cost | How it was measured |
|---|---|---|
| FULL local gate | 23 to 26 minutes | `LOCAL_CI_TIER=full bash scripts/local-ci.sh`, 166 checks, five runs on an M-series Mac |
| FAST local gate | about 1 minute | `bash scripts/local-ci.sh`, the documented pre-push tier |
| Shell suite, sharded | 352 seconds | 323 suites, `LOCAL_CI_SHARDS=4`; 1440 seconds serial, so 4.1x |
| `loki outcomes` | under 1 second per receipt | `git blame` and one `git log` per changed file |
| `loki intent status` | milliseconds | hash comparison against `.loki/spec/spec.lock` |
| Agent readiness | milliseconds | filesystem checks only, no network |
| Pre-edit snapshot | one `git diff` per run | write-once, at agent stop |

The FULL gate is the honest headline: **a full verification run costs about 25
minutes of wall clock**. We do not offer a mode that makes that free, because
the checks that take the time are the ones doing the work.

## What our verification does NOT prove

Stated as plainly as we can, because a limits section that reads like marketing
is worse than none.

**A receipt is not proof the code is correct.** It proves a specific diff was
subjected to specific checks and records what each returned. A change can pass
every gate and still be wrong.

**The unsigned receipt path is forgeable.** Someone who rewrites both the facts
and the headline into a mutually consistent lie and recomputes the hash will
pass verification. That is defense in depth, not non-forgeability. Neutral
non-forgeability requires the signed path
(`LOKI_PROOF_GPG_KEY`, see [SIGNED-RECEIPTS.md](SIGNED-RECEIPTS.md)). We removed
our own "non-forgeable" claim in v7.111.0 after finding it false on that path.

**Only four of the eight quality gates are agent-independent.** Static analysis,
mock-integrity, test-mutation and documentation coverage do not ask a model
anything. The other four involve model judgment and are labelled ASSESSMENTS
rather than FACTS in every receipt.

**Verification cannot prove the spec was right.** This is the sharpest limit and
it is structural. Our gates prove code matches spec; if the spec diverged from
what you actually wanted, a passing gate is a correct answer to the wrong
question. `loki intent` measures that divergence where an intent has been
recorded, and reports UNKNOWN where it has not, which is most runs today.

**`loki outcomes` reports UNKNOWN on most existing receipts.** Measured on this
repository: 0 of 9 receipts are anchored, because 8 carry no recorded baseline
and 1 uses the empty-tree sha. A receipt is measured only when sha algebra
proves `base..head` is that change. We would rather print UNKNOWN than a
change-failure rate of 0.0 that no data supports.

**Generation is not air-gapped.** The verification path is local and offline;
generating code calls a model provider.

**We have no independent benchmark placement and no enterprise case studies.**
Neither exists yet. When they do they will be linked here, and until then their
absence is not evidence of anything except their absence.

## What we refuse to build

Each of these would look good in a comparison table and would make the numbers
above less trustworthy:

- **A semantic fidelity score.** Asking a model whether a spec expresses an
  intent and printing a percentage is a judgment wearing the costume of a
  measurement.
- **A composite trust score.** Averaging a revert count, a hash comparison, a
  path match and a model id yields a number whose movement nobody can explain.
- **A readiness percentage.** "There is no test command" tells you what to do.
  "Readiness 62%" does not.
- **Any gate that punishes an agent for needing human edits.** It would train
  the agent toward diffs nobody edits, which is not the same as good diffs.

## Check any of this yourself

```bash
LOCAL_CI_TIER=full bash scripts/local-ci.sh   # the full gate, timed
loki outcomes --json                          # post-merge outcomes, or UNKNOWN with reasons
loki intent status --json                     # spec-vs-intent drift
loki proof verify <id>                        # re-hash a receipt, exit 1 on tamper
bash tests/test-competitor-verify-surface.sh  # the competitor CLI measurement
```

If a number here does not reproduce on your machine, that is a defect and we
want the report.

## How we compare, and what we cannot measure

A goal was set to be "2-10x better than factory.ai, cognition devin, 8090.ai
and replit". This section reports what is measurable and refuses the rest.

### What is NOT benchmarked, and why

None of those four products has a runnable local arm. Checked on this machine:

```
droid    NOT installed        devin    NOT installed
replit   NOT installed
claude   on PATH              aider    on PATH
codex    on PATH              loki     on PATH
```

Devin and 8090 are hosted services with no CLI. Factory's droid and Replit run
cloud-side. `benchmarks/bench/adapters/` can drive a competing arm as a
subprocess (`claude_code.py` invokes `claude -p` live), but it cannot drive a
product that has no local binary.

**So there is no "2-10x vs Factory/Devin/8090/Replit" number here, and any such
figure elsewhere should be treated as unearned.** Publishing one would be the
same error as sourcing a colour token from a frontend that does not ship: a
number that looks authoritative and measures something else.

### What IS measured: the verification surface

`tests/test-competitor-verify-surface.sh`, run on this machine:

> **5 installed competitor CLIs. 0 expose an output-verification command.**

That is not a multiplier, it is a category. The comparison is not "our
verification is faster" but "there is nothing on the other side to compare
against". Re-run it yourself; it names each CLI it checked and SKIPs the ones
it could not find rather than counting them as absent.

### What the competitors say about verification, in their own words

Verbatim, with the file each came from, so every line is checkable against the
scraped corpora:

| Source | Their words |
|---|---|
| `factory_ai/docs.factory.ai_missions_overview.md` | "**How do you maximize correctness?** Long-running plans accumulate errors." -- published as an OPEN QUESTION |
| `factory_ai/docs.factory.ai_missions_overview.md` | "Without it, the mission **cannot reliably verify its own work**" (Missions require repo readiness Level 4+) |
| `devin_cognition_ai/docs.devin.ai_admin_security.md.md` | "it can still experience **hallucinations, introduce bugs into code**, or suggest insecure code" |
| `8090_ai/www.8090.ai_terms-of-service.md` | "**HUMAN REVIEW AND VERIFICATION OF ALL OUTPUT**" required, while the same ToS caps liability at "FIFTY US DOLLARS" and disclaims "ACCURACY" |

Factory's is the most honest of the four: they name verification as an open
research question rather than a solved feature, and they state that
self-verification is a property of the ENVIRONMENT, not of the agent. We agree,
which is why `loki readiness` measures the repo and not the model.

### The claim we will actually defend

Not a multiplier. A receipt you can recompute:

```
loki proof verify <id>     # re-hash the receipt; exit 1 on tamper
loki outcomes --json       # anchored, or UNKNOWN with a named reason
```

Against "human review and verification of all output" and "cannot reliably
verify its own work", an anchored receipt is a categorical difference. It is
also falsifiable: if `loki outcomes` reports UNKNOWN, we say UNKNOWN. On this
repo it reported ANCHORED 0 of 9 for weeks, and the fix
(`facts.git.base_sha` was empty) is in the history.

### Honest limits on this section

- The verify-surface count is a check for a COMMAND, not for internal
  verification a product may do without exposing it. A hosted product could
  verify server-side and expose nothing to a CLI.
- It measures what is installed HERE. A CLI absent from this machine is
  reported as SKIP, never as a competitor that lacks the feature.
- Nothing here measures build quality, speed, or cost against those four.
  Those comparisons are not available to us and are not claimed.

### Measured: what the harness is worth, model held constant

The one comparison we CAN run. `benchmarks/bench/matrix.sh` defines two
configs against the same task and the same model:

- `baseline` -- raw model, minimal orchestration (in-repo comment: "the
  Replit/Cursor mode")
- `full` -- the harness: council, code review, self-heal, auto-tune

Paired on identical tasks, both arms on `haiku`, from
`benchmarks/bench/results/`:

| Task | harness (`full`) | raw model (`baseline`) | verdict |
|---|---|---|---|
| `hard-2-ledger` | **4/4**, $0.89 | **0/4**, $0.19 | harness wins outright |
| `hard-1-order-api` | 3 runs, 1.00, $0.58 | 1 run, 1.00, $0.20 | harness cost 2.8x for nothing |
| `multifail-1-two-modules` | 2 runs, 1.00, $0.27 | 1 run, 1.00, $0.14 | harness cost 1.9x for nothing |

**Two of the three paired tasks are UNFAVOURABLE to the harness.** That is the
honest headline, and it is narrower than "the harness is worth more than the
model":

**The harness matters on hard tasks and is pure overhead on easy ones.**

On `hard-2-ledger` the raw model never finished the task across 4 trials and
the harness finished it every time. That is not a percentage improvement; the
baseline success rate is zero. It cost 4.7x more per run and produced a working
result instead of nothing.

On the other two, both arms succeed and the harness simply costs 1.9x-2.8x
more. We publish those rows because the direction is unfavourable to us, and a
benchmark table that only survives its favourable rows is an advertisement.

**Two further baseline cells were attempted and produced NO data.**
`tokenheavy-1-crm` (2 trials) and a wider `hard-1-order-api` (3 trials) both hit
the 1200s cell timeout, which caps all trials of a cell together. The harness
wrote no result file and the runner said so:

> WARNING: cell haiku-baseline / tokenheavy-1-crm wrote NO new result (likely
> timed out at 1200s). This cell is MISSING from the report.

They are absent from the table rather than counted as failures. A timeout is
not evidence the raw model cannot do the task; it is evidence we did not
measure it. Reporting them as baseline losses would have made the harness look
better on data that does not exist.

An earlier version of this section reported only the first two tasks and read
as a stronger claim than the data supported. The `multifail` baseline arm was
run afterwards specifically to test whether the claim would survive more data.
It did not survive intact, and the table was corrected rather than the
measurement dropped.

Aggregate across all recorded cells:

| Cell | n | success (median) | cost (median) |
|---|---|---|---|
| `haiku` + harness | 11 | 1.00 | $0.54 |
| `opus` + baseline | 5 | 1.00 | $0.83 |
| `haiku` + baseline | 8 | 0.50 | $0.19 |

The cheap model WITH the harness matches the expensive model without it, at
35% lower cost. Treat that as directional, not as a headline: the task sets
differ between those three cells, which is exactly why the paired table above
is the one that carries the argument.

**Limits of this measurement, stated so it cannot be over-read:**

- Two paired tasks. `hard-1-order-api`'s baseline arm is n=1.
- It measures OUR harness against OUR baseline config. `baseline` is a
  documented stand-in for "raw model, minimal orchestration", NOT a
  measurement of Replit, Cursor, or any other product.
- Success is a held-out acceptance exit code, not a judgement of code quality.
- Reproduce it: `LOKI_BENCH_SPEND_APPROVED=1 bash benchmarks/bench/matrix.sh pilot`.
  The spend interlock is default-deny on purpose; a benchmark that starts a
  paid tool without an explicit opt-in is how a surprise bill happens.

**The exclusion rule, observed on a live run rather than asserted.** A fresh
`haiku-full` trial on `hard-1-order-api` (2026-08-07) hit the 1200s adapter
timeout. The held-out grader inspected the workdir and returned
`success: true` -- there WAS a passing artifact. The harness still recorded
`measured: false`, `unmeasured_reasons: ["adapter exit_status=timeout"]`, and
excluded the trial from k/N, with this note in the result file:

> "the held-out grader's own verdict on whatever was in the workdir. Real
> evidence about the ARTIFACT; NOT evidence that a run happened."

A naive harness scores that 1/1. Ours scores it 0/0 and says why, so the
`hard-1-order-api` row above stayed at n=3 instead of being inflated to n=4 by
a run that never finished. The number in this document is smaller because of
that rule, which is the point of having it.
