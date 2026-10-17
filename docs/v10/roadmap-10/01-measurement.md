# 01 Measurement (enabler for every other score)

Why: every cost, speed and quality claim so far is either unmeasured or refuted. C-F1 run1 reported 1.81x but the ledger showed about 12.3x raw. Run4 had Loki at 1.41x MORE than lean raw on 6 tasks (CI 1.21-1.68), NOT PROVEN on 8. Medium cost is null on 10, 2 and 11 of 21 rows. The seeded-defect catch rate has never been measured. The newest public SWE-bench result is from 2026-01.

Rule: no score in README.md moves without a result file cited here.

## MEAS-1 Bench rows carry version, profile and one cost truth

Story: as the CTO, I need every bench row to say which build and profile produced it and what it really cost, so a claim cannot mix versions or cost sources.

Acceptance:
- Every Loki row in `benchmarks/bench` output has non-null `loki_version` and `cost_profile` (dry-run fixture test).
- `cost_claim.py` mixed-version refusal stays red-first in a test.
- On a 6-task run, the list of rows where |events cost - reported cost| > 5% is empty; the ledger total is cross-checked against receipt `cost.usd`.
- The real engine rc is stored per row (today `rc` is null; `attribution.py` `run_loki` about line 455-490). Stdout and stderr are kept per row.

Todo:
- [ ] Stamp loki_version and cost_profile in `benchmarks/bench/adapters/loki*.py` and `attribution.py`
- [ ] Store real rc and keep stdout/stderr in `adapters/_base.py` run_cli
- [ ] Reconcile events cost, efficiency and ledger in `attribution.py` and `loki-ts/src/engine10/cost.ts`
- [ ] Red-first fixture tests for all three

## MEAS-2 Bench Wall uses the task interpreter

Story: as the bench, Loki rows must be able to reach VERIFIED, otherwise Loki pays for Wall and gets no proof.

Acceptance:
- On the run4 task set, 0 rows log "ran under the system interpreter".
- Loki verdict VERIFIED on >= 80% of accepted rows.
- Bench seeds that ship no test still yield a Loki-executed check (or the bench records why PARTIAL is correct).

Todo:
- [ ] Wall RUNNER_CMD resolves the task venv interpreter (`loki-ts/src/engine10/stages/wall.ts`)
- [ ] Bench venv setup exposes `python` on PATH
- [ ] Regression fixture: bench row with venv goes VERIFIED

## MEAS-3 C-F1 run5

Story: as the founder, I want one trustworthy cost and time comparison against raw Claude Code.

Acceptance:
- Arms: raw-configured, raw-lean, raw-bare, loki, loki-lean. n=3. sonnet-5-5. Cap set. 20 tasks including coord-1 and longspec-1 group tasks.
- 0 UNMEASURED raw-bare cells.
- Group tasks: 3 of 3 Loki rows have a non-null summed group cost and do not exit in 0.2s.
- One verdict line per arm per floor appended to `docs/v10/METRICS.md` C-F1 section.

Todo:
- [ ] Measure raw-bare floor in the attribution floor runner
- [ ] Re-measure group cells on >= v11.17.16 (USER/LOGNAME fix)
- [ ] Grow task set from 8 to 20 (mix of small, medium, group)
- [ ] Run, append verdicts, link result dir

## MEAS-4 Medium A/B with cost never null

Acceptance:
- `provider_cost()` accepts partial-stream cost; null-cost rows 0 of N on rerun (`eval/loki10/harness.py` about line 698).
- All 14 medium tasks, n=3, arms run back to back at equal `--parallel`.
- Bootstrap CI reported per arm (S41-17).

Todo:
- [ ] Partial-stream cost accepted
- [ ] Run all 14 tasks, n=3
- [ ] Record in METRICS.md with CI

## MEAS-5 Seeded-defect catch rate

Story: as a buyer, I want to know how often Seal says VERIFIED on broken code.

Acceptance:
- A runner executes real agent sessions against the 100-case corpus and writes `benchmarks/seeded-defects/results/wrong-pass.json`.
- Top tier vs floor tier wrong-pass reported; P4 `floor-does-not-raise-wrong-pass` case PASS.
- METRICS.md False-SEALED row filled (target 0 of 100).

Todo:
- [ ] Runner script over the corpus
- [ ] Top vs floor runs
- [ ] METRICS row and moat case flip

## MEAS-6 Public benchmarks

Story: SWE-bench Verified is saturated (about 96%); buyers now read Terminal-Bench 2.0 and SWE-bench Pro.

Acceptance:
- SWE-bench Pro pilot (119 instances) run with Loki and raw Claude Code; results JSON committed under `benchmarks/results/swebench-pro-pilot/`.
- Terminal-Bench 2.0 adapter and one full run, results committed.
- SWE-bench pinned subset marked verified=true or replaced; recall@8 recorded.

Todo:
- [ ] Run SWE-bench Pro pilot both arms
- [ ] Terminal-Bench 2.0 adapter plus run
- [ ] Verify pinned SWE-bench ids, publish recall@8

## MEAS-7 Time to first sealed PR, real provider, nightly

Acceptance:
- Nightly job runs `scripts/first-run-gate.sh --real --entry start-empty` with a token secret and fails above budget.
- Stub `--entry start-empty` also runs in nightly.
- METRICS.md row "time to first sealed PR" has a dated number; p50 <= 120s.

Todo:
- [ ] Add stub start-empty entry to `.github/workflows/nightly.yml`
- [ ] Add real-provider entry with secret, guarded so forks skip
- [ ] METRICS row

## MEAS-8 Public scoreboard

Acceptance:
- One generator reads the result files from MEAS-3..7 and renders the scoreboard; numbers in README.md and METRICS.md match it (test).
- Every number shows date, version, n and CI.

Todo:
- [ ] Generator (extend the existing summarize tooling, do not add a parallel one)
- [ ] Drift test README vs METRICS vs generator
