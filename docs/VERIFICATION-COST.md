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
