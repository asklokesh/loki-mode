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
| `loki verify` | 77 seconds | `loki verify HEAD~1` on this repository, 5 changed files; dominated by the project's own test suite, not by our gates |
| of which, shipped-vs-dev CVE split | 418 ms | one extra `npm audit --omit=dev`; 0.5% of the run, and the reason the audit finding can say whether a CVE reaches users |
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

**The tests gate depends on correctly identifying YOUR test runner, and it has
been wrong before.** Until 2026-08-07 the runner was chosen by grepping
`package.json` for `"jest"` / `"vitest"` / `"mocha"`, which matches a
**devDependency**. This repository is the case that exposed it: jest is a
devDependency with no jest config while `scripts.test` runs `bash -n` plus
`node --test`, so verify ran jest, jest globbed 895 files that are not jest
tests, and `loki verify` returned BLOCKED on a clean tree -- permanently, for a
defect that did not exist. It now reads `scripts.test` with a JSON parser and
runs what the project declares.

We record this rather than quietly fixing it because a false BLOCK is the more
damaging direction of that error: a gate that cries wolf on every run trains
you to ignore the verdict, which costs more than the gate ever earned. If the
tests gate reports a runner you do not use, that is a bug in our detection, not
a finding about your code -- the runner is named in
`.loki/verify/evidence.json` under `deterministic_gates[].runner` so you can
check which one it picked.

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
loki proof verify <id>                        # re-hash a receipt (see below)
bash tests/test-competitor-verify-surface.sh  # the competitor CLI measurement
```

### Prove the tamper detection yourself, in three commands

The claim is narrow and worth stating exactly: editing a receipt's recorded
facts is DETECTED. Run this against any receipt in `.loki/proofs/`:

```bash
ID=$(ls .loki/proofs | head -1)
V() { loki proof verify "$ID" --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["hash_ok"])'; }
V                                                    # True
python3 -c "import json;p='.loki/proofs/$ID/proof.json';d=json.load(open(p));d['files_changed']={'count':999999};json.dump(d,open(p,'w'))"
V                                                    # False
```

Measured on this repository: `True` -> `False` -> `True` after restoring.

**Read `hash_ok`, not `ok`.** They answer different questions and conflating
them produces a false alarm. `hash_ok` is integrity: do the recorded facts still
hash to the recorded digest. `ok` also folds in `tree_drift`, which is true
whenever the working tree has moved since the receipt was written -- so an
untampered receipt from last month correctly reports `ok: false` with
`hash_ok: true`. An earlier version of this document said "exit 1 on tamper",
which is wrong in exactly that way: a drifted-but-intact receipt also exits 1.

**What this does NOT establish.** Integrity is not provenance. On the unsigned
path a party who rewrites the facts AND recomputes the digest passes this check
-- see the forgeability limit above. Provenance requires the signed path
(`LOKI_PROOF_GPG_KEY`, [SIGNED-RECEIPTS.md](SIGNED-RECEIPTS.md)), and the remote
client reports the two separately for that reason: VERIFIED, UNSIGNED,
UNCHECKED and TAMPERED are four distinct verdicts, never collapsed.

If a number here does not reproduce on your machine, that is a defect and we
want the report.
