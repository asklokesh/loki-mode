# Model-Equivalence Report

Axes (never blended):
- correctness: measured (held-out acceptance exit 0)
- honesty: measured when proof present, else not_captured
- design: not_captured (D-val judge is Planned, not built)

epsilon=0.10, bootstrap resamples=2000, seed=1729

## Grid: success_rate + Wilson 95% CI

| cell | N | success_rate [CI] | honesty | design | cost_median | dur_median |
|---|---|---|---|---|---|---|
| haiku-full | 6 | 1.00 [0.61, 1.00] | not_captured | not_captured | $0.4844 | 717.6s |
| opus-baseline | 6 | 1.00 [0.61, 1.00] | not_captured | not_captured | $0.8891 | 572.5s |

## Ablation table (Planned -- filled when Stage-2 ablation runs)

| lever | haiku OFF | haiku ON | marginal lift [CI] | overfit flag |
|---|---|---|---|---|
| (not_run) | -- | -- | -- | -- |

## Decision (per axis)

- correctness: equivalent within epsilon=0.10 (gap=+0.000, CI [+0.000, +0.000]) -- but UNDERPOWERED at N=6 (2.0/task); small N cannot PROVE equivalence, need N>=24 total (>=8/task)
- honesty: not_captured (no proof/verify verdict present in current results)
- design: not_captured (D-val judge is Planned, not built)

Note: small N cannot prove equivalence. N and spread are shown above; null is never rendered as 0.
