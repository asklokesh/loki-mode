# 02 Cost (target: at least 2x cheaper than Claude Code, proven)

Now 6. Winner today: Aider on raw spend; Cursor Composer at about $0.07 per task.

Why we are not 10:
- Run4: Loki 1.41x more than lean raw on 6 tasks; pooled 1.11x NOT PROVEN with acceptance 0.750 vs 0.958.
- Plan and Wall run as fixed sessions even on small tasks: run4 sized all 31 tasks normal (19 "no test runner detected", 12 over 600 chars), `plan_skipped=false` everywhere. Overhead stages are 31% of spend on medium; the planner costs as much as implement.
- Implement cache reads 1.9x raw (9.23M vs 4.79M) because the brief gives no test to run, so the session explores.
- Best measured point is lean config 0.68x raw (opus, single arm, no CI). The lean knobs are built but OFF.

Bar for 10: `cost_claim` reports PROVEN_AT(0.5) against all 3 floors, n >= 3, one version, ledger-checked, with acceptance >= floor.

Depends on: 01 MEAS-1, MEAS-2, MEAS-3.

## COST-A Small-task lean path actually triggers

Story: as a user with a small fix, I pay for one implement session plus verify, not Plan plus Wall plus implement.

Acceptance:
- `plan_skipped=true` on >= 60% of C-F1 tasks.
- Acceptance >= floor on the same run.
- "no test runner detected" no longer forces normal size when the repo has a discoverable test command.

Todo:
- [ ] Revisit `SMALL_NO_RUNNER` and `MAX_CHARS` defaults in `loki-ts/src/engine10/sizing.ts` behind a measured loki-lean arm
- [ ] Better runner detection (feeds sizing)
- [ ] Flip default only after MEAS-3 shows acceptance held

## COST-B Focused implement brief

Story: the implementer gets the up-to-20 relevant files and the exact test command, so it does not explore.

Acceptance:
- Implement cache reads per completed down >= 30% on medium, n=2.
- Completion not lower.

Todo:
- [ ] Brief builder in `loki-ts/src/e10ext/context.ts`
- [ ] Wire into `stages/implement.ts` (Captain edit if hot)
- [ ] Paid A/B

## COST-C Flip measured-OFF knobs

| Knob | Flip when |
|---|---|
| `--cost lean` / `LOKI_COST_PROFILE` | loki-lean arm CI upper bound <= 0.5 and acceptance >= floor |
| `LOKI_IMPLEMENT_HAIKU_FIRST` | same arm plus escalation rate recorded |
| `LOKI_E10_TRIM` | implement cache reads down >= 25% on medium, completion not lower |
| `LOKI_E10_ATTEMPTS=2` | medium completion >= 18/21, cost not red |

Todo:
- [ ] One paid arm per knob, results in METRICS.md
- [ ] Flip each knob that passes, in its own release

## COST-D Cost correctness followups

Todo:
- [ ] Alias duplicate flags: make cost flag aliases resolve to one value and reject conflicting duplicates
- [ ] `autonomy/run.sh` about line 7626: BUDGET_LIMIT ".5" handled like the TS `parseCapUsd` fix (TEN-COST-59); run.sh and goal_score.ts change together
- [ ] Price table negative-price test (reject negative or NaN prices)
- [ ] TEN-COST-59 sibling sweep: every other dollar parser accepts ".5" and "5."
- [ ] BUDGET_BURN pulse miscount: pulse counts 128-132 "active" engineers when the real number is single digits; fix the counter in `scripts/v10-pulse.sh`

Acceptance: each item has a FAILURE-CLASSES row, a red-first test, and a sibling sweep note.

## COST-E Publish the claim

Acceptance:
- PROVEN_AT(0.5) line in METRICS.md with run dir, version, n, CI.
- Scoreboard (MEAS-8) shows it.
- Receipt `cost.usd` matches ledger within 5% on every row used.

Todo:
- [ ] Run after COST-A..C land
- [ ] Publish
