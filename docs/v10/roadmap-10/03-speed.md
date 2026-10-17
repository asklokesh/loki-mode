# 03 Speed

Now 7. Winner today: Cursor Composer 2.5 Fast (about 6.7 min average per task), Codex.

Why we are not 10:
- Medium p50 209s default vs raw 56-70s (2.5-4x). Small run4 p50 31.9s vs 24.3s (1.31x).
- Implement is 72-86% of p50; Wall is 23-29% and is killed at its 90s limit in 9-11 of 21 runs; implement starts within 1ms of Wall closing.
- Fix rounds add 18.9-35.7s at p90.
- Pre-model overhead (cold bun child per session) is not measured.

Bar for 10: TEN-SPEED-01 paired time ratio CI lower bound >= 1.0 on small; medium p50 <= raw at equal parallelism.

Owns `loki-ts/src/engine10/stages/wall.ts` for this program.

## SPD-A Wall off the critical path

Story: implement starts immediately; Wall runs beside it and never blocks it.

Acceptance:
- `LOKI_E10_WALL_CONCURRENT` default on after HIGH review (S41-14).
- Medium p50 down >= 20% vs 209s at equal `--parallel`.
- Wall still red-on-base; completion not lower.
- Wall limit kills <= 2 of 21; Wall share of p50 < 15%.

Todo:
- [ ] HIGH review S41-14 (opus adversarial)
- [ ] Measured arm, flip default (`machine.ts`)
- [ ] `wallLimitS` tuning or skip-on-haiku-timeout in `sizing.ts`

## SPD-B Pre-model overhead

Acceptance:
- `pre_model` p50 reported per arm on eval rows (`eval/loki10/harness.py`, `stage-profile.py`).
- p50 < 2s warm.

Todo:
- [ ] Timer in harness
- [ ] Warm-process or socket reuse if over 2s

## SPD-C Parallel verify and base jobs

Acceptance:
- Paid A/B of `LOKI_E10_VERIFY_JOBS=4` and `LOKI_E10_BASE_JOBS=4`: verify plus Wall base time down >= 30%, 0 new flakes over 3 reps.
- Defaults flipped only if it passes.

Todo:
- [ ] A/B run
- [ ] Flip in `stages/verify.ts` and `util/check_result.ts`

## SPD-D Speed tier tasks

Acceptance:
- `eval/loki10/tasks/spd-*` exist (D61 slice 17).
- `LOKI_SPEED=0/1` A/B: parallel wall <= 0.5x sequential on decomposable tasks, tokens not higher.

Todo:
- [ ] Author spd tasks
- [ ] A/B run, METRICS row

## SPD-E Equal-parallelism scorecard rule

Acceptance: `eval/loki10/summarize` refuses a pool with mixed `--parallel` (red-first test) and runs arms back to back.

Todo:
- [ ] Guard plus test
