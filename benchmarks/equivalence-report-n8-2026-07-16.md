# Model-Equivalence Report

Axes (never blended):
- correctness: measured (held-out acceptance exit 0)
- honesty: measured when proof present, else not_captured
- design: not_captured (D-val judge is Planned, not built)

epsilon=0.10, bootstrap resamples=2000, seed=1729

## Grid: success_rate + Wilson 95% CI

| cell | N | success_rate [CI] | honesty | design | cost_median | dur_median |
|---|---|---|---|---|---|---|
| haiku-baseline | 6 | 0.67 [0.30, 0.90] | not_captured | not_captured | $0.0956 | 147.0s |
| haiku-full | 25 | 1.00 [0.87, 1.00] | 1.0 | not_captured | $0.3035 | 595.2s |
| opus-baseline | 10 | 0.80 [0.49, 0.94] | not_captured | not_captured | $0.7657 | 400.9s |
| sonnet-unknown | 35 | 0.86 [0.71, 0.94] | not_captured | not_captured | $0.4902 | 222.9s |

## Ablation table (Planned -- filled when Stage-2 ablation runs)

| lever | haiku OFF | haiku ON | marginal lift [CI] | overfit flag |
|---|---|---|---|---|
| (not_run) | -- | -- | -- | -- |

## Decision (per axis)

- correctness: equivalent within epsilon=0.10 (gap=+0.200, CI [+0.000, +0.500]) -- but UNDERPOWERED at N=10 (1.4/task); small N cannot PROVE equivalence, need N>=56 total (>=8/task)
- honesty: not_captured (no proof/verify verdict present in current results)
- design: not_captured (D-val judge is Planned, not built)

Note: small N cannot prove equivalence. N and spread are shown above; null is never rendered as 0.
