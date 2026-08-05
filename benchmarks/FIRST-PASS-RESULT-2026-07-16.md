# First-Pass Excellence: Iteration-Drop Result (2026-07-16)

**Founder mandate:** make Haiku land in the FIRST iteration (not 8 iterations while Opus does 2).

**Change:** a first-pass-excellence directive appended to iteration 1 (commit fd6724a1), gated
LOKI_FIRST_PASS_EXCELLENCE (default on), byte-mirrored across the bash + TS routes. It front-loads
intelligence so ONE informed pass lands the complete, working, well-designed solution instead of a
draft the loop then corrects. NOT an iteration cap - a better first pass.

**Method:** A/B on 3 hard tasks x 2 trials, haiku + full harness, WITH vs WITHOUT the directive.
Deterministic held-out grading (exit 0). Model verified = haiku per trial.

## Per-task (all 6 trials pass in BOTH configs - correctness preserved)

| Task | Baseline iters | First-pass iters | Baseline cost | First-pass cost |
|---|---|---|---|---|
| hard-1-order-api | [3, 2] | [1, 1] | $0.48 | $0.17 (2.8x) |
| tokenheavy-1-crm | [1, 3] | [1, 1] | $0.37 | $0.17 (2.2x) |
| multifail-1-two-modules | [3, 1] | [1, 3] | $0.31 | $0.24 |

## Aggregate

| metric | baseline | first-pass |
|---|---|---|
| median iterations | 2.5 | **1.0** |
| mean iterations | 2.17 | **1.33** |
| one-iteration trials | 2 / 6 (33%) | **5 / 6 (83%)** |
| aggregate cost (3 tasks) | $1.16 | **$0.58 (2.0x cheaper)** |
| success | 6 / 6 | 6 / 6 |

## Honest read

The directive works: median iterations dropped 2.5 -> 1.0, and Haiku now lands in ONE pass on 5 of 6
trials (up from 2 of 6), at half the cost, with correctness fully preserved. The one exception is a
single multifail trial (the hardest, multi-failure task) that still needed 3 iterations - the genuine
tail on the hardest case. This is not "always 1 iteration"; it is "one iteration the large majority of
the time, and never at the expense of correctness". The cost win is a direct consequence: fewer
iterations = less spend, compounding the model-equivalence cost moat.

Artifacts: the fp A/B result JSONs (isolated bench run). Baseline = the N=6 pilot cells.
Directive: providers/claude.sh _loki_autonomy_override_text + loki-ts claude_flags.ts (byte-identical).
