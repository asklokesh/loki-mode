# Model-Equivalence Pilot Result (2026-07-16)

**Question:** Can a cheap model (Haiku) with the full RARV-C harness match an
expensive model (Opus) run bare, on hard build tasks?

**Method:** 6 cells = {haiku-full, opus-baseline} x 3 hard tasks x 2 trials each.
- `haiku-full` = Haiku + full harness (8 iterations, council, code-review, self-heal, auto-tune).
- `opus-baseline` = Opus, minimal orchestration (2 iterations, no council/review/heal) -- the
  "throw the frontier model at it" mode the giants use.
- Grader = deterministic held-out acceptance test (exit 0), never a self-report or council vote.
- Model labels verified: every haiku-full trial recorded `model_used=haiku`, every opus-baseline
  trial `model_used=opus` (the efficiency-label fix, commit 6f71643).

## Per-task result (all 6/6 passed)

| Task | haiku-full | opus-baseline | haiku cost advantage |
|---|---|---|---|
| hard-1-order-api | 2/2 pass, $0.48, iters [3,2] | 2/2 pass, $0.96, iters [1,1] | 2.0x cheaper |
| multifail-1-two-modules | 2/2 pass, $0.31, iters [3,1] | 2/2 pass, $0.70, iters [1,1] | 2.3x cheaper |
| tokenheavy-1-crm | 2/2 pass, $0.37, iters [1,3] | 2/2 pass, $1.00, iters [1,1] | 2.7x cheaper |

## Aggregate (equivalence_report.py, Wilson 95% CI, bootstrap gap CI)

| cell | N | success_rate [CI] | cost_median | dur_median |
|---|---|---|---|---|
| haiku-full | 6 | 1.00 [0.61, 1.00] | $0.4844 | 717.6s |
| opus-baseline | 6 | 1.00 [0.61, 1.00] | $0.8891 | 572.5s |

- **Correctness:** equivalent within epsilon=0.10 (gap = +0.000, both solved every task).
- **Cost:** haiku-full ~1.8x cheaper at the aggregate median ($0.48 vs $0.89); 2.0-2.7x per task.
- **Latency:** haiku-full is slower per build (717s vs 572s median) -- the harness trades wall-clock
  for the cost/correctness win (more iterations at a far cheaper per-token rate).

## Honest limits (do NOT overclaim)

- **UNDERPOWERED at N=6 (2/task).** A 100% pass rate on 6 trials has a Wilson 95% CI floor of only
  0.61 -- this is consistent with equivalence but does NOT prove it. Proving equivalence needs
  N>=24 total (>=8/task). This pilot is a strong SIGNAL, not a proof.
- **Only correctness + cost measured.** Honesty (proof/verify verdict) and design quality were
  not_captured in this run.
- 3 tasks, one instance each -- not a broad corpus. The tasks are discriminator-derived (hard,
  multi-failure, token-heavy) but a full claim needs breadth.

## Bottom line

On these 3 hard tasks, Haiku + the full RARV-C harness solved everything Opus-baseline solved, at
roughly half the cost. That is the model-equivalence thesis (rigor substitutes for raw model
strength) demonstrated with real, deterministically-graded, correctly-labeled data -- and reported
with its statistical limits intact. Next step to harden into a proof: scale to >=8 trials/task.

Artifacts: benchmarks/bench/results/*20260716T0[678]*.json (the 6 cells).
Report tooling: benchmarks/bench/equivalence_report.py.
