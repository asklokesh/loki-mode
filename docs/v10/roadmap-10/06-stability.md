# 06 Stability

Now 7.5. Winner today: no clear leader; the bar is a public status page plus sustained green.

Why we are not 10:
- Main Tests red about 10 hours on 2026-10-17 (28 of last 30 failed); over 200 runs since 10-02, 87 success, 106 failure; longest green streak 23.
- Failures: structural line budgets (engine10 core 5015 >= 5000), moat P9 allowtoken-only-fetch-callers, L2 destructive registry, 7 FC-01 resolver and multi-root verify tests, stub e2e "worker killed by the supervisor backstop", shell shards 3, 4, 5.
- Releases ship while Tests is red by decision (D102); caps break when parallel slices merge (FC-60) and nothing enforces them after merge.
- Latest nightly read success while every test job was skipped (same-SHA skip).

Bar for 10: 24 hours of consecutive green on main, red-to-green under 1 hour, merged-train guards on every push, public status page.

## STAB-1 Main green now

Todo:
- [ ] Engine10 core under 4950 with headroom (fix/e10-core-budget branch, mapPool into util/check_result.ts)
- [ ] P9 allowToken pin fixed (FC-25c a), moat P9 PROVEN
- [ ] L2 destructive git call registry current
- [ ] 7 FC-01 resolver / multi-root verify tests green
- [ ] Supervisor backstop kills in stub e2e diagnosed (FAILURE-CLASSES row first)
- [ ] Shell shards 3, 4, 5 green

Acceptance: three consecutive green Tests runs on main, each cited by run id.

## STAB-2 Merged-train guard job

Story: a cap that each slice passes alone but the merged main breaks is caught within minutes.

Acceptance: on every main push, a fast job runs budget, L0, moat P9 and structural checks; on red it opens a BOARD P0 row within 5 minutes (fixture test).

Todo:
- [ ] Job in `.github/workflows/tests.yml` (extend, no new workflow)
- [ ] Auto P0 row writer

## STAB-3 Nightly honesty

Acceptance: a nightly where every test job was skipped concludes neutral or failure, never success.

Todo:
- [ ] `.github/workflows/nightly.yml` conclusion rule plus test

## STAB-4 Green streak and time-to-fix in pulse

Acceptance: pulse prints current green streak and `MAIN_RED_MINUTES`; VIOLATION when red over 60 minutes.

Todo:
- [ ] `scripts/v10-pulse.sh`
- [ ] Fix BUDGET_BURN active-engineer miscount (see 02 COST-D)

## STAB-5 Public status page

Acceptance: a page shows main CI streak, last release, npm dist-tags and incident history, generated from the same data as pulse.

Todo:
- [ ] Generator plus publish step

## STAB-6 Repo hygiene

Todo:
- [ ] Triage 295 unmerged local branches (delete only those whose work is on main or parked)
- [ ] Fix BOARD unparsed rows Q17-05b, Q18-03e, A-112b
- [ ] METRICS.md:45 moat count and ENGINE-MEASURE.md refreshed for v10
- [ ] Drift audit cadence kept (pulse DRIFT AUDIT DUE)
- [ ] Remove stale local tag mismatch (local v11.17.53 vs npm next)
