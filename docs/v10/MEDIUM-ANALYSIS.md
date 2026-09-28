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

## After (E-98f)

Eval run 2026-09-28, worktree `agent-a340b90dfe1a90ce0`, branch `slice-E-98f`,
harness_sha `3abb3ac6b5cdcb84467f247c56f15eba964b5b77-dirty` (dirty only from
`loki-ts/dist/cockpit.js`'s non-deterministic build output; source is
`main` with E-98a..e merged, dist rebuilt in this branch). `bin/loki
--version` = v10.4.1, `manifest.jsonl` `arm_binary` is this worktree's own
`bin/loki` (the nocascade arm through a `LOKI_EVAL_LOKI_BIN` shim, see
below), never a global install. Model `claude-opus-5-5`, the same 7 `pub-*`
medium tasks, 900s cap, `--parallel 3`, fresh clone per run, n=3 per arm (21
task-runs each). Raw is not re-run (per instruction); both prior raw
measurements are carried forward for comparison.

**nocascade note:** `LOKI_E10_CASCADE` is not in `eval/loki10/harness.py`'s
`V10_ENGINE_ENV_ALLOWLIST` (only `LOKI_E10_PLAN/WALL/WALL_TIER/CAP_S/
INVOKER/DASHBOARD_PORT` are listed), so it is dropped by `arm_env`'s blanket
`LOKI_*` scrub before reaching the arm. Worked around without a harness code
change: `LOKI_EVAL_LOKI_BIN` pointed at a one-line shim
(`LOKI_E10_CASCADE=0 exec <worktree>/bin/loki "$@"`) that sets the var in
the process `harness.py` execs, outside the scrub. Verified live: 21/21
nocascade implement sessions ran `session.started` with
`"model":"claude-opus-5-5"`; 21/21 default and nowall implement sessions ran
on `"model":"sonnet"`. nowall verified live too: 21/21 nowall runs show a
wall `stage.skipped` with `"reason":"LOKI_E10_WALL=0"`; 0/21 default or
nocascade runs show that skip. This allowlist gap should be closed
(`eval/loki10/harness.py`, add `LOKI_E10_CASCADE`) as a harness follow-up; it
was not fixed here (eval-only, no code changes).

**Auth incident, not concurrency.** r2 for all three arms was lost in full
(21/21 rows `auth_unavailable`) and had to be re-run. Cause: `harness.py`'s
per-row check, `arm_auth(cap + AUTH_MARGIN_S)` = `arm_auth(1020)`, refuses to
start a row unless the keychain OAuth access token has at least 1020s (17
min) left. Claude Code does not refresh that token until it is itself close
to expiry (observed: still only ~415s left immediately after running
`claude --print` as the operator, i.e. the refresh did not fire early), so
across a batch of many-minute arm sessions the token's remaining lifetime
can fall under 1020s well before it actually expires, and every row started
after that point is refused until the operator's own use of `claude`
eventually triggers a real refresh. The r1 `pub-werkzeug-3271` miss (last
task started in each arm) had the same cause; it was retried once
`arm_auth(1020)` and `arm_auth(3600)` both passed (`expiresAt` about 8h out
by then). This is an auth-lifecycle fact of the harness/environment, not
evidence of contention from running 3 arms concurrently (9-12 sessions at
once, load 2.5-4.7 of a 14-core box throughout). No rate-limit signal (429/
`rate_limit`/`overloaded`/529) was found in any arm's stdout/stderr logs, or
in the one apparent hit inside an `arm_stdout.log` (a `seal` receipt hash
substring, `5963429c...`, a false positive).

**Dedupe rule.** Each result file can hold more than one attempt per task
(an `auth_unavailable`/`interrupted` attempt from a lost run, followed by a
real attempt after re-running that same r-file's `--out`). Rows are deduped
to exactly one per (arm, run-file, task): the latest `status: ok` attempt if
one exists in that run-file, else its latest attempt overall (by `started`,
falling back to file order). This never collapses across r1/r2/r3, since
those are separate files/reps, and it matches EV-15's own "pool the real
rows, one per task per run" method, made explicit here because unlike EV-15
this run needed retries. Rows dropped by this rule (superseded
`auth_unavailable`/`interrupted` attempts, all from the r2 auth incident
above, plus each arm's r1 werkzeug-3271 retry): 22 for default, 15 for
nowall, 15 for nocascade. Each arm's final pooled table has exactly 21 rows,
7 tasks times 3 runs, matching `--tasks` times n=3.

### Before (raw, carried forward)

| source | arm | completed | rate | cost per completed | p50 / p90 |
|---|---|---|---|---|---|
| EV-14 (docs/v10/METRICS.md; raw result files lost, METRICS.md entry is the record) | raw `claude -p` | 12/14 | 85.7% | $0.5119 | 70s / 239s |
| EV-15 (this doc, section 1/4) | raw `claude -p` | 10/14 | 71.4% | $0.5085 | 56s / 104s |
| EV-15 (this doc, section 1/4) | v10 default knobs | 9/14 | 64.3% | >= $0.788 (corrected lower bound, section 4) | 128s / 330s |

### After (E-98f, n=3, 21 task-runs per arm)

| arm | completed | rate | cost per completed | null-cost rows | p50 / p90 |
|---|---|---|---|---|---|
| default | 15/21 | 71.4% | n/a | 10/21 (lower bound $0.6958) | 209s / 457s |
| `LOKI_E10_WALL=0` (nowall) | 16/21 | 76.2% | n/a | 2/21 (lower bound $0.786) | 214s / 500s |
| `LOKI_E10_CASCADE=0` (nocascade) | 15/21 | 71.4% | n/a | 11/21 (lower bound $0.3233, unreliable at this null rate) | 138s / 218s |

p50/p90 were measured at up to 12 concurrent arm sessions (3 arms times
`--parallel 3`, plus single-task retries) against EV-15's 3; not apples to
apples with the before rows. The decision rule below does not use latency.

Null-cost rows persist well above zero in every arm despite E-98e's fix
being present and firing correctly at the iteration level. Root cause,
confirmed by reading both files for one null row
(`e98f-engine/default-r1/pub-werkzeug-3121.../.loki/metrics/`): the killed
wall iteration's `efficiency/iteration-2.json` does carry a real,
non-zero `cost_usd` (`0.0628`) from E-98e, but with `"cost_source":
"partial-stream"`. `eval/loki10/harness.py`'s `provider_cost()` (line
~698) sums a row's cost only if every one of its iteration files has
`cost_source == "provider"` exactly; `"partial-stream"` fails that check by
design, so the entire row's `cost_usd` is `null` even though the money was
correctly recorded. This is not a bug in E-98e or a bug in the harness
reading the wrong field; it is the harness's deliberate "only trust a
provider-reported number" policy colliding with E-98e's necessarily
estimated number for a killed session, and it fires on any stage kill, not
only Wall's: nowall's 2 null rows both trace to `implement` itself hitting
its own stage limit (`stage.failed implement {"reason":"limit"}`), since
Wall is skipped there and has nothing left to kill. This explains the
per-arm null counts directionally: default and nocascade run Wall for real
(more stage-limit kills, more nulls: 10/21 and 11/21) while nowall skips it
(fewer kills, fewer nulls: 2/21). Cost per completed is therefore `n/a`
under the harness's own rule (every evaluated row must have a cost) for all
three arms; the lower bounds above sum only the rows with a `provider`
cost and likely understate the true figure (see MEDIUM-ANALYSIS section 4's
own correction of EV-15's lower bound for the same reason). A harness
follow-up (not made here, eval-only): accept `cost_source in ("provider",
"partial-stream")` in `provider_cost()`, or report the two sums separately.

**Misses**, all three arms: only `pub-werkzeug-3105` (hidden tests failed
in all 9 of 9 attempts across the three arms) and `pub-werkzeug-3271`
(missed in 8 of 9: 7 hidden-tests-failed plus 1 no-branch-pushed, that one
also `hidden_pass: false` so a genuine miss, not EV-15 raw r2's "correct fix
never pushed" pattern; nowall r3 completed it) -- the same two
task-difficulty misses EV-15 found shared with raw (section 1). Unlike
EV-15, `pub-jinja-1413` completed in all 9 attempts across all three arms
(0 misses): the E-98a/E-98b/E-98c fixes (project interpreter, spec_conflict
still verifies, append-only existing tests) removed the jinja regression
that was EV-15's only pure v10-side loss.

**Fix-effect counts** (from `events.jsonl`, filtered to the engine slot of
each `status: ok` row; 21 files per arm):

| arm | pytest not_run / total | ruff not_run / total | fix rounds started | runs with >=1 fix round | spec_conflict runs | spec_conflict, verify started | spec_conflict, verify completed |
|---|---|---|---|---|---|---|---|
| default | 0/80 | 11/25 | 5 | 3 | 1 | 1 | 1 |
| nowall | 0/72 | 16/24 | 6 | 5 | 2 | 2 | 1 (1 verify killed at its own limit) |
| nocascade | 0/58 | 19/22 | 3 | 2 | 1 | 1 | 1 |

pytest `not_run` is 0 of 80/72/58 in every arm, and every one of those
checks ran on the `project` interpreter (0 on `system`): E-98a's interpreter
resolution holds up at n=21 per arm, and this is the evidence the jinja
regression's root cause (a test run against the installed package instead
of `src/`) is closed. ruff `not_run` is high but not a resolution failure:
every `not_run` reason is "ruff not found on PATH" (genuinely absent from
that task's own venv, not a wrong-interpreter miss), and every ruff check
that did find a binary resolved it to the `project` interpreter, same as
pytest (14 of 25 for default, 8 of 24 nowall, 3 of 22 nocascade). E-98a's
resolver (commit `cabf16ef`, verify.ts:148) does cover ruff; most task repos
here simply do not ship ruff in their own environment. Every `spec_conflict`
implement exit started a real `verify` stage in all three arms (E-98b;
unlike EV-15's 0 of 5 verify starts). Of the 4 spec_conflict runs, verify
itself then completed in 3; the 4th (nowall) had verify killed at its own
limit (`stage.failed verify {"reason":"limit"}`), so "spec_conflict reaching
verify" in the table below counts verify *starting*, and the completed/
failed split is called out per arm.

### Decision

Rule (founder, 2026-09-28): the chosen arm must complete at or above raw's
best measured medium rate, EV-14's 85.7% (12/14, 18/21 at this n), and its
cost per completed must be at or below raw's EV-15 $0.5085.

| arm | vs EV-14 85.7% (18/21) | vs EV-15 71.4% (15/21) | vs EV-15 $0.5085 |
|---|---|---|---|
| default | fails (15/21) | ties exactly (15/21) | fails on its own lower bound ($0.6958); true cost n/a |
| nowall | fails (16/21) | passes (16/21) | fails on its own lower bound ($0.786); true cost n/a |
| nocascade | fails (15/21) | ties exactly (15/21) | undetermined: lower bound $0.3233 is below the bar, but 11/21 rows (52%) are uncosted, too many to trust the bound |

No arm reaches 18/21 (85.7%): nowall is highest at 16/21 (76.2%), default
and nocascade both at 15/21 (71.4%, an exact tie with EV-15's raw rate). No
arm's cost per completed is a clean number under the harness's own rule
(`n/a` in all three; see the null-cost cause above). **No arm meets the
founder's rule. `sizing.ts` is left unchanged.**

Order: a, b, c, d and e in parallel (their file sets do not overlap), then f. The "after" table for the founder is the E-98f default arm next to section 1 above.
