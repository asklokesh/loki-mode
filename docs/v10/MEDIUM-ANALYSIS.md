# E-98: why v10 loses to raw `claude -p` on the medium tier (EV-15)

Source data: EV-15 (2026-09-28, harness `cc4992ed`, v10.2.5, `claude-opus-5-5`, 7 `pub-*` medium tasks, 2 runs per arm, 900s cap). The engine10 code this analysis cites is unchanged between `cc4992ed` and `origin/main` `d811e5c3` (`git diff --stat cc4992ed origin/main -- loki-ts/src/engine10` is empty).
All paths below are relative to `/Users/lokesh/loki-ci-logs/eval/` (called EV below). `EV/ev15-summary.md` and `EV/ev15-stage-detail.md` are the run summaries.

The founder's "12/14 vs 10/14" comes from EV-14. Its result files were lost when a worktree was force-removed (E-96/E-101). EV-15 re-ran the tier: raw 10/14, v10 9/14. The numbers here are EV-15's, and every claim cites an EV-15 file.

## 1. Outcome per task-run

| task | raw r1 | raw r2 | v10 r1 | v10 r2 | class |
|---|---|---|---|---|---|
| pub-jinja-1413 | pass | pass | **miss** | **miss** | **v10 loss (2)** |
| pub-werkzeug-3105 | miss | miss (hidden_pass, no push) | miss | miss | shared miss |
| pub-werkzeug-3271 | miss | miss | miss | pass | shared miss, one v10 win |
| attrs-1313, click-2869, faker-1817, werkzeug-3121 | pass | pass | pass | pass | tie (v10 slower/costlier) |

Only two task-runs were completed by raw and missed by v10: pub-jinja-1413 r1 and r2.
- werkzeug-3105: both arms fail the same hidden test with the same error. `EV/ev15-v10-r{1,2}/logs/pub-werkzeug-3105*/grade_hidden.stdout.log` and `EV/ev15-raw-claude-r1/logs/pub-werkzeug-3105*/grade_hidden.stdout.log` all show `FAILED tests/test_routing.py::test_no_duplicate_head_options - DuplicateRuleError: / -> a`.
- werkzeug-3271 r1: both arms fail with `FAILED tests/test_wrappers.py::test_user_agent - Failed: DID NOT WARN`.
- These are task difficulty, not v10 stage losses.

## 2. Failure table (v10 losses, with log citations)

Event logs:
- `EV/ev15-engine/v10-r1/pub-jinja-1413.v10.71372932a4ef/.loki/runs/e10-20260928T185044Z-5451/events.jsonl` (r1)
- `EV/ev15-engine/v10-r2/pub-jinja-1413.v10.78270c64e4ab/.loki/runs/e10-20260928T190755Z-60df/events.jsonl` (r2)

Hidden grade, in both runs (`EV/ev15-v10-r{1,2}/logs/pub-jinja-1413*/grade_hidden.stdout.log`):
- Result: `2 failed, 12 passed`.
- The failing tests are `TestSet::test_set_invalid` and `TestSet::test_namespace_redefined`, both `DID NOT RAISE TemplateRuntimeError`.
- Both tests passed at baseline (`baseline.stdout.log`: only `test_namespace_set_tuple` failed).
- So v10 broke the namespace runtime check. These are regressions in existing tests, not a missing feature.
- Raw (opus) kept the check: `EV/ev15-raw-claude-r1/logs/pub-jinja-1413*/grade_hidden.stdout.log` shows `14 passed`.

| run | stage that lost it | exact event lines | cause (one sentence) |
|---|---|---|---|
| jinja r1 | implement brief, then early exit past verify | seq21 `stage.completed implement {"exit": "spec_conflict", ..., "spec_conflict_reason": "plan step 8 requires adding tests to the existing tests/test_core_tags.py, but the rules make existing test files read-only ...", "impacted_tests": []}`; seq22 `stage.started commit` directly after it (no verify stage); seq25 `receipt.sealed ... "verdict": "SPEC_CONFLICT"` | The brief rule "existing test files are read-only" (implement.ts:33) turned a normal task into `spec_conflict`, and `earlyExit` (machine.ts:55) then skipped verify and the fix loop, so a sonnet diff that regressed two existing tests shipped untested. |
| jinja r2 | verify (blind), so no fix round | seq32 `stage.completed implement {"exit": "done", ..., "impacted_tests": ["examples/basic/loki_wall_test_namespace_tuple_assign.py"]}`; `test.result verify {"name": "pytest:tests/test_core_tags.py", "cmd": "python -m pytest -q tests/test_core_tags.py", "result": "not_run", "reason": "python not found on PATH"}`; no `fix` event; seq45 `run.completed {"verdict": "PARTIAL", ...}` | Verify picked the right file (`tests/test_core_tags.py` contains both regressed tests), but ran it as `python`. The host has only `python3` (`which python` prints `python not found`), and the task's own `work/.venv` was never tried, so the check was `not_run`, `failures_grouped` stayed empty, and the fix loop never started. |

What each session actually ran:
- jinja r2 (`.loki/logs/bash-audit.jsonl`): the implementer ran only the Wall test, with system `python3` and `PYTHONPATH=src`. It never ran `tests/test_core_tags.py`.
- Its log (`iteration-e10-20260928T190755Z-60df-impl.log`) says it added new tests "after `test_namespace_macro`". Seal's `weakened test: tests/test_core_tags.py` fires on any modification (seal.ts:176), not only on weakening.
- The two regressed tests are therefore most likely still intact in the sandbox. A working verify would then have failed them. This is likely, not proven: the EV-15 working trees are gone, so the E-98a/E-98b re-run settles it.
- jinja r1 needed two fixes to reach a fix round: the interpreter fix, and a verify that still runs after `spec_conflict`.

## 3. Engine-wide facts (all 14 v10 event logs)

Commands: the scripts `dump.py`, `sumall.py` and `cost.py` read every `EV/ev15-engine/v10-r*/*/.loki/runs/*/events.jsonl`.

- **Verify never ran a test.**
  - 27 of 27 `test.result` pytest checks are `not_run` / `python not found on PATH`.
  - 9 of 9 ruff checks are `not_run` / `ruff not found on PATH`.
  - 0 checks passed and 0 failed.
  - There were 0 `fix` events in 14 runs. The fix loop is gated on `failures_grouped` (machine.ts:54), which can only fill from a `fail`.
- **Verify was skipped in 5 of 14 runs.** Implement exited `spec_conflict` in jinja r1, werkzeug-3121 r1 and r2, and werkzeug-3271 r1 and r2.
  - 4 of the 5 reasons cite the read-only rule for existing test files.
  - 3121 r1 cites a Wall test that contradicts the plan.
  - 9 verify stages completed, 5 did not start.
- **The implementer is never told which existing tests to run.**
  - Implement reported `impacted_tests: []` in 9 of 14 runs. The 5 non-empty ones are faker x2 (`tests/test_proxy.py`, lean path) and 3 Wall-test-only lists.
  - Root cause: `repomap.ts` extracts symbols only with a JS `export` regex (`SYMBOL_RE`, repomap.ts:23). Every Python repo gets `entries: []`. For example, jinja r2 `repomap.json` has 118 files and 0 entries.
  - So `selectRelevantFiles` returns `[]` (`"relevant_files": []` in 8 of 8 plan stages).
  - Then `impactedTests` (implement.ts:17) takes `[]` from `??` and never falls back to `namedFiles`.
- **Implement always ran on sonnet; raw ran on opus.**
  - Every `session.started implement` has `"model": "claude-sonnet-5"`, because of the E-64 cascade (implement.ts:68, sizing.ts:63).
  - Escalation to the run model happens only in a fix round with a test failure (fix.ts:60). That cannot happen while verify is blind.
  - So on this harness the cascade is sonnet-only. This contributes to jinja, but is not proven as a cause: EV-14 v10 passed jinja 2/2.
- **Wall hit its 90s limit in 5 of 14 runs:** 3105 r1 and r2, 3121 r2, 3271 r2, click r2.
  - Evidence: `stage.failed wall {"reason": "limit"}` and `session.ended wall exit=killed dur=90.0`.
  - Wall sealed at least one test in only 3 of 14 runs (3121 r1, 3271 r1, jinja r2).
  - The one jinja Wall test was written under `examples/basic/`. The implementer reports that it was defective: `test_recursive_loop_matches_bug_report` references an undefined `id`.

## 4. Cost: where v10 spends that raw does not

Measured from `cost` events (`usd` non-null) and from raw `arm_stdout.log` usage:

| | usd | cache read tokens | cache write tokens | output tokens |
|---|---|---|---|---|
| raw, 14 runs | $5.09 | 4.79M | 0.29M | 89k |
| v10 implement (sonnet), 14 | $4.91 | 9.23M | 0.41M | 137k |
| v10 wall (sonnet), 8 measured + 4 unmeasured | $1.11 | 0.32M | 0.15M | 40k |
| v10 plan (opus), 8 | $0.90 | 0.30M | 0.06M | 16k |
| v10 intake (sonnet, lean path), 2 | $0.17 | 0.08M | 0.03M | 1k |
| **v10 total measured** | **$7.09** | 9.93M | 0.66M | 195k |

- **Correction to EV-15's lower bound.** Measured v10 spend is at least $7.09, over 9 completions, so cost per completed is at least **$0.788**, not $0.5788. EV-15 summed only the 10 costed rows. It dropped the measured plan and implement dollars inside the 4 null rows ($0.32, $0.59, $0.25, $0.72 before Wall). Raw is $0.5085, so v10 is at least 55% more per completed task.
- **Priority-2 gap, root cause.** All 4 `cost_usd: null` rows (3105 r1 and r2, 3121 r2, 3271 r2) are runs where Wall was killed at its limit.
  - Evidence: `cost wall usd=None ... in=0 out=0`. Only `result-cost-*-impl.json` and `result-cost-*-plan.json` exist under `.loki/metrics/` (for example 3105 r1).
  - A killed session never receives the SDK result message, so no cost file is written. `iteration-2.json` is Wall's efficiency record.
- **Overhead stages.** Plan, Wall and intake cost $2.18, which is 31% of v10's measured spend. Wall bought a sealed test in 3 of 14 runs.
- **Latency.** Implement waits for the whole `["plan", "wall"]` group. When Wall is killed at 90s beside a 15-31s plan, that adds about 60-75s before implement starts.
- **Implement burns 1.9x raw's cache reads** (9.23M vs 4.79M), on a cheaper model. Most of it is in the long runs:
  - attrs r2: 286s, 2.49M cache read, $0.97.
  - jinja r2: 360s, 2.34M, $0.94.
  - werkzeug-3105 r2: 1.11M, $0.47.
  - werkzeug-3271 r2: 239s, 0.94M, $0.63.
  - The brief gives no test to run, so the session explores instead of converging.

Completed runs where v10 was slower or costlier than raw on the same task and run:
- attrs r2: $1.06 and 317s vs $0.28 and 60s. Implement ran 286s.
- click r2: 212s vs 49s. Wall was killed at 90s, then implement ran 121s.
- faker r2: 128s vs 227s, a v10 win on time.
- 3121 r2: 141s vs 29s. Wall was killed at 90s, then implement ended in `spec_conflict`.
- 3271 r2: 330s, a v10 win. Wall was killed at 90s, then implement ran 239s.

In every slow case the time went to Wall hitting its limit, or to a long implement session with no test to run.

## 5. Root causes, ranked by lost completions explained

| rank | cause | lost completions explained | other effect |
|---|---|---|---|
| 1 | Verify runs pytest as bare `python`: not on PATH, and the task `.venv` is ignored (verify.ts:31) | 2 of 2 (r2 directly; r1 once cause 2 is fixed) | 27/27 checks `not_run`; 0 fix rounds; cascade escalation unreachable |
| 2 | `spec_conflict` early exit skips verify and fix (machine.ts:55), triggered by the "existing test files are read-only" rule (implement.ts:33) | 1 (jinja r1) | 5/14 runs unverified; 4 of the 5 caused by the read-only rule |
| 3 | Implementer is given no impacted tests: Python repomap has 0 entries (repomap.ts:23), and `[]` blocks the `namedFiles` fallback (implement.ts:17) | contributing to 2 (the implementer never ran `test_core_tags.py`) | 9/14 implement runs had no tests to run; long, cache-heavy sessions |
| 4 | Implement pinned to sonnet by the cascade, with escalation only through verify failures | contributing, unproven (EV-14 v10 passed jinja 2/2) | cheaper tokens, but 1.9x the cache reads |
| 5 | Wall 90s limit kills and low yield | 0 | all 4 null-cost rows; +60-75s latency; 3/14 useful |

## 6. Fix slice cards

D33: the core is 4,942 lines against a 5,000 cap, so there are 58 lines of headroom. Card deltas below total +34 or fewer. IDs are E-98a to E-98f, to avoid clashing with an E-102 that exists on a local main.

Re-running the failed tasks uses `eval/loki10/run.sh` with a separate `--out` per run. There is no `--runs` flag, so use n=3 per task: EV-14 passed jinja 2/2, so n=2 cannot tell a fix from noise. Copy each run's `work/.loki` out before cleanup (E-101), with the output under `/Users/lokesh/loki-ci-logs/eval/e98-*`.

### E-98a: verify uses the project interpreter
- Goal: pytest checks run on the repo's own environment, so a regression shows up as `fail` and drives a fix round.
- File set:
  - `loki-ts/src/engine10/stages/verify.ts`: `runnerCmd` resolves `<repoDir>/.venv/bin/python`, then `<repoDir>/venv/bin/python`, then `$VIRTUAL_ENV/bin/python`, then `python3`, then `python`.
  - The same file: each check records the interpreter it used. A check that ran on a system interpreter adds "tests ran on the system interpreter" to not_proven, because system `python3` imported the installed Jinja2 3.1.6, not `src/`, in jinja r2.
  - `loki-ts/tests/engine10/verify*.test.ts`.
  - Net core delta: at most +12.
- Wall check:
  - Red first: a fixture with a `.venv/bin/python` shim and no `python` on PATH gives `not_run` before the change and `pass`/`fail` after. A second fixture with system python3 only records `interpreter: system` plus the not_proven line.
  - Then `eval/loki10/run.sh --arm v10 --tasks pub-jinja-1413 --out /Users/lokesh/loki-ci-logs/eval/e98a-r{1,2,3}`.
  - Expected: `test.result` for `pytest:tests/test_core_tags.py` is `pass` or `fail` (never `not_run`) in 3 of 3 runs, and completed in at least 2 of 3.
- Budget: 30 min. Tier: HIGH (verify).

### E-98b: spec_conflict still verifies
- Goal: a `spec_conflict` implement exit still runs verify and the fix loop. Only `already_satisfied` short-circuits. The receipt keeps the `SPEC_CONFLICT` verdict and reason.
- File set: `loki-ts/src/engine10/machine.ts` (`earlyExit`, plus the verdict carry-through only if seal needs it), `loki-ts/tests/engine10/machine*.test.ts`. Net core delta: at most +3.
- Wall check:
  - A fake-stage test: implement `spec_conflict`, then verify runs, then a `fail` triggers `fix`, then seal still says `SPEC_CONFLICT`. It must fail on current main.
  - Then re-run `pub-jinja-1413`, `pub-werkzeug-3121` and `pub-werkzeug-3271` at n=3 into `EV/e98b-*`, with E-98a merged.
  - Expected: every run with a `spec_conflict` exit has a `stage.completed verify`. Completions are at least EV-15's on these tasks (jinja 0/2, 3121 2/2, 3271 1/2).
- Budget: 30 min. Tier: HIGH (moat flow).

### E-98c: brief allows adding tests; impacted tests fall back
- Goal: existing test files are append-only (add new test functions, never edit or delete existing ones). Wall files stay read-only and are restored as today; seal.ts:176 still reports any modification. `impactedTests` falls back to `namedFiles` when `relevant_files` is empty, not only when it is missing.
- File set: `loki-ts/src/engine10/stages/implement.ts` (the brief line at :33, and `impactedTests` at :17 using `?.length ?` in place of `??`), plus its test. Net core delta: at most +2.
- Wall check:
  - A unit test: a brief with `relevant_files: []` and a task naming `parser.py` lists that file's tests.
  - Re-run `pub-werkzeug-3121` and `pub-werkzeug-3271` at n=3 into `EV/e98c-*`.
  - Expected: no run exits `spec_conflict` citing read-only existing tests (4 of 14 did in EV-15), and completions do not drop.
- Budget: 15 min. Tier: MEDIUM.

### E-98d: Python symbols in the repo map
- Goal: `buildRepoMap` extracts Python top-level `def` and `class` names, alongside the JS `export` regex, so `selectRelevantFiles` and the impacted-test map work on Python repos.
- File set: `loki-ts/src/engine10/repomap.ts`, `loki-ts/tests/engine10/repomap*.test.ts`. Net core delta: at most +4 (a second regex applied to `.py`).
- Wall check:
  - Offline, no model: on each of the 7 medium task repos at their `repo_ref`, `relevant_files` is non-empty and contains the file the upstream refdiff touches (`eval/loki10/refdiff/`). At least 5 of 7 must pass. EV-15 had 0 of 7, 8 of 8 plan stages empty.
  - Keyword ties across a package directory are a known ceiling. Record the rank of the upstream file.
- Budget: 30 min. Tier: MEDIUM.

### E-98e: killed sessions still report cost
- Goal: a session killed at its stage limit writes a cost record from the per-message usage already streamed, marked `source: "partial-stream"`, so the harness row is never `cost_usd: null` because Wall was killed.
- File set: `loki-ts/src/engine10/session.ts`, `loki-ts/src/engine10/cost.ts`, and a test. Net core delta: at most +10, or offset by deleting dead code in cost.ts.
- Wall check:
  - A unit test: a fake stream killed after 2 assistant messages gives a non-null usd equal to the summed usage price.
  - Re-run `pub-werkzeug-3105`, `pub-werkzeug-3121` and `pub-werkzeug-3271` at n=3 into `EV/e98e-*`.
  - Expected: `cost_usd` is non-null on every row, and `eval/loki10/summarize` reports a numeric `cost_per_completed`.
- Budget: 30 min. Tier: MEDIUM.

### E-98f: A/B of Wall and cascade on medium (eval-first, then a sizing change)
- Goal: measure whether Wall (`LOKI_E10_WALL=0`) and the sonnet cascade (`LOKI_E10_CASCADE=0`) pay for themselves on medium, with E-98a to E-98c merged. Only if a knob wins on completions without losing on cost, change `sizing.ts` so that `size: "normal"` takes that path by default.
- File set: an eval run only, then `loki-ts/src/engine10/sizing.ts` (at most +3 core lines) and its test.
- Wall check:
  - All 7 medium tasks at n=3 per arm: default, `LOKI_E10_WALL=0`, `LOKI_E10_CASCADE=0`, into `EV/e98f-{default,nowall,nocascade}-r{1,2,3}`.
  - The chosen default must be at or above raw's EV-15 10/14 rate (71.4%) on completions, and below raw's $0.5085 on cost per completed.
  - The results are published in this file as the "after" table.
- Budget: 60 min of eval, then a 15 min code change. Tier: HIGH (it changes the default flow).

Order: a, b, c, d and e in parallel (their file sets do not overlap), then f. The "after" table for the founder is the E-98f default arm next to section 1 above.
