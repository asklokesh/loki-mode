# Head-to-head benchmark: results

Loki against raw Claude Code (`claude -p`) on the same coding tasks, scored only by hidden tests.
This page states the protocol and the latest numbers, including where Loki loses.

Latest run: `results/2026-11-01-win-bench-v2-after.json` (raw Haiku and Loki on Haiku, 24 tasks, 2
reps, after the changes below), against `results/2026-11-01-65440abaf-before.json` (the v11.114.0
engine, same protocol, run the same day). The four-config run further down is the v11.113.0 engine.
The replay suite below (`results/2026-11-01-2100eda48-replay.json`, real closed issues) ran on
the v11.114.0 engine at commit 2100eda48.

**Citability.** A results file counts only if it was produced from a clean commit: the harness now
stamps every results file with the engine commit, the tool versions and a `citable` flag, and refuses
to run Loki configs from a tree with uncommitted changes. The v11.116.0 before/after files are
**not citable**: `2026-11-01-win-bench-v2-after.json` records that it ran from uncommitted code,
and `2026-11-01-65440abaf-before.json` and `2026-11-01-win-bench-v2-review-fixes.json` record
commits (65440abaf, 38b31e8cc) that are on no published branch, since they predate the release
squash, so nobody can check out the code they measured. The replay file ran Loki from a clean engine commit
(2100eda48) with the benchmark harness changes not yet committed (committed in 070d72ea4), so it
is not citable under this rule either.

## Replay suite (real closed issues)

The synthetic tasks below are written for the benchmark. The replay suite is real work: 8 closed
issues from permissively licensed open source projects, each replayed at the parent commit of the
change that fixed it.

- **Tasks.** `replay/<id>/`, 6 Python and 2 Go. `task.txt` is the issue title and body as written.
  The hidden tests are the test files the merged fix changed, taken from the fix commit and scored
  at their own paths, run with the rest of the project's suite (so a fix that breaks other tests
  fails). The snapshot is vendored (`repo/`, with the project's license file); nothing is cloned at
  run time. `meta.json` "source" records the upstream, license, issue, fix PR, fix and parent
  commits, and every change made to the snapshot.

| task | project (license) | issue |
|---|---|---|
| go-semver-dirty-lte | Masterminds/semver (MIT) | #141 range against a version with missing parts fails |
| go-semver-four-part | Masterminds/semver (MIT) | #185 NewConstraint accepts some four-part versions |
| py-boltons-research-tuples | mahmoud/boltons (BSD-3-Clause) | #393 `research` skips identical small tuples |
| py-cachetools-grow-evict | tkem/cachetools (MIT) | #405 growing an existing key over-evicts |
| py-cachetools-ttl-overflow | tkem/cachetools (MIT) | #440 failed TTL expiry leaves an unusable entry |
| py-moreit-value-chain | more-itertools (MIT) | #1250 value_chain swallows a TypeError |
| py-parse-tz-groups | r1chardj0n3s/parse (MIT) | #262 fields after `%z` are shifted |
| py-toolz-partition-len | pytoolz/toolz (BSD-3-Clause) | #602 partition_all pads on an inaccurate `__len__` |

- **Snapshot changes.** parse: pytest-cov options removed from `addopts`, `tests/check_typing.py`
  ignored (needs typing_extensions). cachetools: a `conftest.py` puts `src/` on the import path.
  toolz: `test_package.py::test_has_version` deselected (needs installed metadata). In all tasks,
  en and em dashes and emoji were rewritten to meet this repository's text rule (escapes inside
  string literals, so behaviour is unchanged); the run below used the snapshot and issue text
  before that rewrite, which differ only in those characters.
- **Self-check.** The merged fix passes all 8 tasks and the parent commit passes none
  (`--suite replay --configs oracle,noop`, run by `tests/min/h2h-harness.sh` on every PR).
- **Configs.** `raw-haiku` and `loki-haiku` as below. `raw-haiku-verify` and `raw-opus-verify` are
  raw `claude -p` with the same task text plus one sentence: "Before you finish, run the
  repository's tests and check that your change works." That is the fair baseline: what a careful
  user gets from Claude Code alone.
- **Accepted without edit (old definition, used for this run only).** The hidden tests pass on the
  tree as the run left it, and the run left no test edits in it (a changed file under a protected
  path, in a test directory, or named like a test). Test edits are reverted before scoring in every
  case, so they never affect pass or fail. The harness now uses a narrower definition (see the hard
  suite): only a weakened pre-existing test or a test config change counts, so new test files and
  appended cases are fine. These runs did not keep their diffs, so they cannot be rescored; under
  the new definition Loki's 10 passes would all count as accepted (it only added new test files),
  and the raw configs' cannot be determined.
- **Run.** `--suite replay --reps 2 --jobs 4`, timeout 600 s, on its own ledger with a $15 budget.

### Results

| 2 reps | pass | 95% CI | accepted | 95% CI | median s | total $ | $ per task | $ per passed task | $ per accepted task |
|---|---|---|---|---|---|---|---|---|---|
| raw-haiku | 10/16 | 38.6-81.5% | 0/16 | 0-19.4% | 37.8 | 0.2012 | 0.0126 | 0.0201 | none accepted (at least 0.0650) |
| raw-haiku-verify | 12/16 | 50.5-89.8% | 0/16 | 0-19.4% | 48.2 | 0.2299 | 0.0144 | 0.0192 | none accepted (at least 0.0742) |
| raw-opus-verify | 14/16 | 64.0-96.5% | 0/16 | 0-19.4% | 41.6 | 5.4410 | 0.3401 | 0.3886 | none accepted (at least 1.7565) |
| loki-haiku | 10/16 | 38.6-81.5% | 0/16 | 0-19.4% | 40.6 | 0.1353 | 0.0085 | 0.0135 | none accepted (at least 0.0437) |

The interval for $ per accepted task is $ per task divided by the Wilson bounds of the acceptance
rate; with 0 accepted its upper bound is unbounded, so only the lower bound is shown.

- **Loki on Haiku against raw Haiku with the verify sentence (same model, fair baseline):** 2 fewer
  passes (10 against 12 of 16, intervals overlap) at 0.70 times the cost per passed task and 0.84
  times the median time. Against plain raw Haiku: the same 10 passes at 0.67 times the cost per
  passed task.
- **Against raw Opus with the verify sentence:** 4 fewer passes (10 against 14 of 16) at 0.035
  times the cost per passed task.
- **Accepted without edit is 0 for every config.** Every passing run left test edits behind. The
  raw configs added tests to an existing test file (14, 16 and 16 runs for raw-haiku,
  raw-haiku-verify and raw-opus-verify); Loki added a new test file (14 runs). By this definition no
  config produced a change a user could take without editing it, so the metric does not separate
  the configs here. A user who keeps regression tests would count every pass.
- **Loki's verdict:** VERIFIED 4 runs (2 hidden passes, 2 hidden fails), PARTIAL 12 (8 hidden
  passes, 4 hidden fails). Verdict agreement 6 of 16. These are the first VERIFIED runs on a hidden
  fail in this benchmark (both on go-semver-four-part).

| task | raw-haiku | raw-haiku-verify | raw-opus-verify | loki-haiku |
|---|---|---|---|---|
| go-semver-dirty-lte | 2/2 | 2/2 | 2/2 | 2/2 |
| go-semver-four-part | 0/2 | 0/2 | 2/2 | 0/2 |
| py-boltons-research-tuples | 2/2 | 2/2 | 2/2 | 0/2 |
| py-cachetools-grow-evict | 2/2 | 2/2 | 2/2 | 2/2 |
| py-cachetools-ttl-overflow | 2/2 | 2/2 | 2/2 | 2/2 |
| py-moreit-value-chain | 0/2 | 2/2 | 2/2 | 2/2 |
| py-parse-tz-groups | 2/2 | 2/2 | 2/2 | 2/2 |
| py-toolz-partition-len | 0/2 | 0/2 | 0/2 | 0/2 |

### Every loss, with its reason

| task | config | failed | reason |
|---|---|---|---|
| py-boltons-research-tuples | loki-haiku | 2 of 2 | The implement session changed no file; the run ended PARTIAL with "no tests executed". Every raw config fixed it. |
| go-semver-four-part | loki-haiku | 2 of 2 | Loki rejected the four-part versions in the issue and ended VERIFIED, but the fix's tests also require `12.3.34~ 1.2.3` to be rejected, which the issue does not mention. |
| go-semver-four-part | raw-haiku, raw-haiku-verify | 2 of 2 each | Same missing case. Only raw Opus covered it. |
| py-moreit-value-chain | raw-haiku | 2 of 2 | The session ended after 2 and 4 turns with no change to the tree. |
| py-toolz-partition-len | every config | 2 of 2 each | The fix's test requires a LookupError when `__len__` overstates the length; the issue asks only that no padding tokens appear. No config inferred the exception. |

Loki on Haiku loses one task to raw Haiku with the verify sentence (boltons) and wins none; it wins
one task against plain raw Haiku (more-itertools).

### Threats to validity

- 8 tasks and 2 reps: 16 runs per config. A 2-pass difference is well inside the intervals.
- Several issues are recent and very precise (some name the cause and a fix). Older, terse issues
  are harder; the suite has 2 of those (#141, #185).
- Contestants had network access and could in principle look up the upstream fix. The records do
  not show whether any did.
- Two hidden tests check behaviour the issue does not ask for (go-semver-four-part, toolz). That is
  what replaying a real fix measures, and it hits every config alike.
## Loki on Haiku against raw Haiku, before and after the Wall and session fixes

Same 24 tasks, 2 reps each, `--jobs 4`, `raw-haiku,loki-haiku`. Raw Haiku was rerun in each
invocation, so each row compares runs made under the same load.

| run | config | pass | 95% CI | $ per passed task | median s | p90 s | sessions | verdict agrees | false VERIFIED |
|---|---|---|---|---|---|---|---|---|---|
| before (v11.114.0) | raw-haiku | 48/48 | 92.6-100% | 0.0171 | 28.0 | 206.7 | 1.00 | - | - |
| before (v11.114.0) | loki-haiku | 42/48 | 75.3-94.1% | 0.0457 | 44.0 | 167.6 | 2.83 | 30/48 | 1 |
| after | raw-haiku | 48/48 | 92.6-100% | 0.0192 | 29.3 | 170.7 | 1.00 | - | - |
| after | loki-haiku | 48/48 | 92.6-100% | 0.0126 | 27.8 | 177.8 | 1.96 | 29/48 | 0 |

After the changes Loki on Haiku passes every task raw Haiku passes, at 0.66 times its cost per
passed task and 0.95 times its median time in the same invocation. It still runs about two
sessions per task against one.

Before, all six Loki losses ended with no code in the scored tree: 4 BLOCKED by Loki's own Wall
tests (two Go package clashes, a Rust `Order::new()` call against `Order::new(id: &str)`, a Rust
Wall assertion that contradicts the task), 1 STALLED on a Wall failure, and 1 VERIFIED that the
hidden tests failed (py-semver-range; the default reviewer flagged the bug, but a flag never
lowers a verdict).

What changed, and what each change did on these runs (Loki on Haiku, 48 runs each):

- **A run's code always reaches its branch.** Every unpublished run keeps its `loki/<id>` branch,
  BLOCKED and FAILED included; before, only VERIFIED and PARTIAL did, and a blocked run's code went
  into a bundle file only. BLOCKED or STALLED runs with an empty scored tree: 5 before, 0 after.
- **A Loki Wall test never blocks delivery.** The delivery over a Wall conflict now decides on the
  re-verify: the repo's own checks (a targeted test or the full suite) must run and pass once the
  Wall files are discarded. Before, it needed a passing targeted own test before the re-verify,
  which a Go Wall file that breaks its whole directory's build never allows.
- **Wall tests that cannot compile are discarded before they reach the tree.** A Go file whose
  package clause differs from its directory's is dropped when written; a Rust call whose argument
  count no definition in the crate has is dropped at install, after implement, so a task that
  changes a constructor keeps the test that proves it (an explicit `Type::method(&mut x, ..)` call
  counts its receiver). Both are listed NOT PROVEN, with no fix session spent on them. The Go brief
  now names the directory's package and the import path of the package under test, the Wall
  manifest carries Go and Rust signatures, and a black-box `package tests` file that imports the
  package under test is no longer misread as vacuous. Fix sessions: 14 before, 10 after.
- **The unconfigured default review is opt-in for medium risk (`LOKI_REVIEW_DEFAULT=1`) and stays
  on for high risk** (auth, payments, migrations, CI, public API). It ran on 17 of 48 runs,
  changed no verdict, and was $1.29 of $1.92 (67%) of Loki's spend and 323 of 341 seal seconds.
  A configured reviewer still runs. Review sessions: 17 before, 0 after (in that run the default
  was off for every tier; the review-fixes run below keeps it on for high risk).
- **The separate already-done session runs for issue tasks only.** On a direct task the implement
  session already answers LOKI_ALREADY_DONE itself. **The Project Model discovery session is skipped
  when one runner sits at the repo root** even when that runner lists no test files (cargo). Intake
  sessions: 20 before, 0 after; the Rust discovery session alone took 12 s serial per run.
- **Lessons and worked examples are recorded but not injected by default** (`LOKI_PR_LESSONS=1`,
  `LOKI_WORKED_EXAMPLE=1` opt in), after the learning pilot below.

Where Loki still costs more than raw: the Wall runs on the 13 tasks without a relevant visible
test (all Go and Rust tasks and ts-cron-next), 35 Wall sessions in 48 runs, and Wall assertions
that contradict the task still cost a fix round (10 fix sessions). One run (rs-roman-strict, rep 2)
ended BLOCKED on such an assertion; its code was on the run branch and passed the hidden tests.
Verdict agreement did not improve (29/48): 12 of the 18 passing runs that end PARTIAL are Go tasks, where
no Wall file ran and no passing check names a changed symbol.

Spend for these two runs and the probes behind them: $5.70 on their own ledger.

After review fixes (`results/2026-11-01-win-bench-v2-review-fixes.json`, Loki on Haiku only, 2 reps,
v11.115.0 merged in): the Wall-conflict delivery counts only the repo's own tests (a test check with
n > 0 or a full-suite pass, never lint or the security scan), the Rust argument-count rule is decided
after implement, the Go black-box exemption needs the package under test itself, and the default
review stays on for high risk on the run's own model.

| config | pass | 95% CI | $ per passed task | median s | p90 s | sessions | verdict agrees | false VERIFIED |
|---|---|---|---|---|---|---|---|---|
| loki-haiku | 47/48 | 89.1-99.6% | 0.0131 | 29.0 | 174.3 | 1.90 | 29/48 | 1 |

The one failure is py-semver-range (rep 1): a lean-path run (a relevant visible test, so no Wall)
read VERIFIED while the hidden `intersects` tests failed. The v11.114.0 baseline had the same false
VERIFIED on the same task. Five tasks reached the high risk tier (py-invoice-rounding,
ts-cart-discounts, ts-cron-next, rs-expr-eval, rs-interval-set), so their runs got the default
review: 8 review sessions, $0.052 in total on Haiku.
Spend: $1.15 on its own ledger.

## Protocol

- **Tasks.** 24 tasks in `tasks/`, 6 each in TypeScript (bun), Python (pytest), Go and Rust.
  11 are multi-file: cross-module changes, bugs whose cause sits in a different file from the
  symptom, and refactors that must keep behaviour. 5 are marked hard: long precise specs plus
  scale limits (for example a 100000-deep expression without stack overflow, 200000-task
  scheduling in under 2 seconds). Each task has a starting repo with visible tests, a task
  statement (`task.txt`, what a user would type), hidden tests and a reference solution.
- **Self-check.** The reference solution passes every task's hidden tests and an untouched repo
  passes none (`--configs oracle,noop`, run by `tests/min/h2h-harness.sh` on every PR).
- **Configs.**
  - `raw-haiku`, `raw-opus`: `claude -p <task> --model haiku|opus --dangerously-skip-permissions`.
  - `loki-haiku`: `bin/loki <task> --no-pr` with every stage pinned to Haiku.
  - `loki-default`: `bin/loki <task> --no-pr` with its default model routing.
- **Isolation.** Every run gets a fresh git copy of the task repo and a throwaway HOME (only the
  Claude login is linked). Hidden tests live outside the copy and are copied in only after the
  contestant's whole process group has exited; test files and test config go back to their base
  content before scoring, so editing tests cannot pass a task. When Loki leaves its work on a
  `loki/<id>` branch, that branch is scored.
- **Scoring.** Pass means the hidden tests exit 0. Cost is the contestant's own reported spend
  (the result JSON for raw runs, Loki's run record for Loki runs). Timeout 600 seconds.
- **Repetitions.** `--reps 3 --jobs 4 --budget 38.5`. Runs go rep by rep, so a budget stop
  leaves whole reps behind it. Wall times were measured with 4 runs in flight at once.
- **Statistics.** Pass rates carry a 95% Wilson interval. Loki's verdict is its exit code:
  0 means VERIFIED (Loki claims the task is done and proven), 6 means PARTIAL, 4 means BLOCKED.
  Verdict agreement counts VERIFIED with a hidden pass and any other exit with a hidden fail.
  VERIFIED on a hidden fail is the worst error and is counted on its own.

## Results

The budget allowed 2 complete reps (192 runs) and the first 10 tasks of rep 3 (39 more runs;
the stop came one run short of the 10th task for `loki-default`). The headline uses the 2
complete reps, where every config ran every task the same number of times.

### Loki on Haiku against raw Haiku (same model)

| reps 1-2 | pass | 95% CI | median s | p90 s | $ per task | $ per passed task | sessions | fix rounds |
|---|---|---|---|---|---|---|---|---|
| raw-haiku | 48/48 (100%) | 92.6-100% | 26.6 | 208.8 | 0.0160 | 0.0160 | 0.98 | - |
| loki-haiku | 46/48 (95.8%) | 86.0-98.9% | 48.8 | 209.4 | 0.0498 | 0.0520 | 2.79 | 0.15 |

On this task set Loki on Haiku does not beat raw Haiku. It passes 2 fewer tasks (the intervals
overlap), costs 3.2 times as much per passed task and takes 1.8 times as long at the median.

### All four configs

| reps 1-2 | pass | 95% CI | hard | median s | p90 s | total $ | $ per task | $ per passed task | sessions | fix rounds |
|---|---|---|---|---|---|---|---|---|---|---|
| raw-haiku | 48/48 (100%) | 92.6-100% | 10/10 | 26.6 | 208.8 | 0.77 | 0.0160 | 0.0160 | 0.98 | - |
| raw-opus | 48/48 (100%) | 92.6-100% | 10/10 | 32.6 | 123.9 | 17.05 | 0.3552 | 0.3552 | 1 | - |
| loki-haiku | 46/48 (95.8%) | 86.0-98.9% | 10/10 | 48.8 | 209.4 | 2.39 | 0.0498 | 0.0520 | 2.79 | 0.15 |
| loki-default | 45/48 (93.8%) | 83.2-97.9% | 10/10 | 55.8 | 132.4 | 11.99 | 0.2498 | 0.2664 | 2.81 | 0.06 |

- Loki on Haiku costs 0.15 times what raw Opus costs per passed task, at 1.5 times its median
  time and 2 fewer passes.
- Loki with default routing costs 0.75 times raw Opus per passed task, at 1.7 times its median
  time and 3 fewer passes.

All runs, including the partial rep 3 (which covers only the 6 Go tasks and 4 Python tasks):

| all 231 runs | pass | 95% CI | median s | $ per passed task |
|---|---|---|---|---|
| raw-haiku | 58/58 (100%) | 93.8-100% | 26.3 | 0.0153 |
| raw-opus | 58/58 (100%) | 93.8-100% | 31.2 | 0.3466 |
| loki-haiku | 53/58 (91.4%) | 81.4-96.3% | 44.2 | 0.0504 |
| loki-default | 51/57 (89.5%) | 78.9-95.1% | 58.6 | 0.2855 |

### Does Loki's verdict match the hidden tests?

Over all 115 Loki runs:

| Loki verdict | runs | hidden pass | hidden fail |
|---|---|---|---|
| VERIFIED (exit 0) | 70 | 70 | 0 |
| PARTIAL (exit 6) | 34 | 34 | 0 |
| BLOCKED (exit 4) | 11 | 0 | 11 |

- Verdict agreement: 81 of 115 (70.4%). Loki on Haiku 40 of 58, Loki default 41 of 57.
- VERIFIED on a hidden fail: 0. When Loki says VERIFIED, the hidden tests agreed every time.
- Every disagreement is a PARTIAL whose work in fact passed the hidden tests (34 runs). Loki is
  too cautious, never too confident, on this set.

### Where Loki loses

Every Loki failure (11 runs, all reps) has the same shape: the run ended BLOCKED with a spec
conflict caused by an acceptance test Loki wrote itself (its Wall), and the scored tree held no
changes at all, so the hidden tests ran against the untouched code.

| task | config | failed runs | reason from the run record |
|---|---|---|---|
| go-ratelimit | loki-haiku | 2 of 3 | Wall test `tests/loki_wall_bucket_test.go` declares `package ratelimit` in a directory whose existing tests are `package tests`, so the directory cannot build |
| go-ratelimit | loki-default | 1 of 3 | same Wall package clash |
| go-store-refactor | loki-haiku | 2 of 3 | Wall test `tests/loki_wall_notes_test.go` declares `package notes` beside `package tests` |
| go-store-refactor | loki-default | 2 of 3 | same Wall package clash; the run record says the refactor itself passed the Wall tests |
| go-topo-schedule | loki-haiku | 1 of 3 | Wall test declares `package sched` beside `package tests` |
| go-topo-schedule | loki-default | 1 of 3 | same Wall package clash, plus a Wall assertion (critical path at least 100000 long) that contradicts the spec |
| rs-stock-reserve | loki-default | 2 of 2 | Wall test calls `Order::new()` with no argument, but the task keeps `Order::new(id: &str)` and the existing visible test calls it with one |

Two engine faults explain all of it: the Wall author puts Go tests in a black-box `tests/`
package with the wrong package clause, and when a run is blocked by its own Wall, the code it
wrote does not reach the tree the user gets. Raw contestants have no Wall and never hit this.

### What the hard tasks did and did not show

Raw Haiku passed every hard task in every run: 10 of 10 here, 11 of 11 counting rep 3, and 27 of
27 pilot runs across the earlier and final versions of those tasks while they were being made
harder (deeper specs, then scale limits). The
hard tasks separate the configs on time and cost (raw Haiku median 225 s and $0.040 per pass on
hard tasks against 23 s and $0.010 on normal ones), not on pass rate. This task set therefore
cannot show a pass-rate advantage for any config over raw Haiku; it can show losses, and it did.

## Learning protocol (pilot)

Does Loki do better on a task when it has already done related tasks in the same repo? Results
file: `results/2026-11-01-7359dab35-learning.json`.

- **Protocol.** 4 sequences in `sequences/` (two Python, one TypeScript, one Go), each 3 related
  tasks that extend the same files in the same pattern (for example a CSV exporter, then a JSON
  exporter, then a Markdown exporter with a registry). All 3 steps run in order in one repo copy
  with one throwaway HOME, so Loki's lessons file carries over. Each step is scored by its own
  hidden tests, which are removed again before the next step. Two arms on Haiku, 3 reps each:
  `loki-haiku-learn` (defaults: run lessons and the worked example from an earlier VERIFIED run
  are read) and `loki-haiku-nolearn` (`LOKI_NO_PR_LESSONS=1`, `LOKI_WORKED_EXAMPLE=0`). Step 1
  has nothing to learn from; steps 2 and 3 are the ones that can benefit.

| arm | steps | pass | 95% CI | $ per passed task | median s | sessions | fix rounds |
|---|---|---|---|---|---|---|---|
| learn | first | 12/12 | 76-100% | 0.0030 | 19.0 | 1.25 | 0 |
| learn | later | 22/24 | 74-98% | 0.0089 | 21.3 | 1.29 | 0 |
| nolearn | first | 11/12 | 65-99% | 0.0071 | 18.5 | 1.50 | 0.08 |
| nolearn | later | 21/24 | 69-96% | 0.0061 | 21.7 | 1.29 | 0 |

- **The arms do not separate.** On the later steps learning passes 22 of 24 against 21 of 24, with
  almost fully overlapping intervals, and costs more per passed task ($0.0089 against $0.0061),
  driven by step 3 ($0.155 against $0.088 for 12 runs each).
- A worked example was on file before 18 of 24 later steps in both arms (Loki still records
  lessons when reading them is switched off), so the learn arm had material to use in 75% of
  its later steps. Run lessons were almost never written (0 and 2 later steps).
- All 5 later-step failures are on the third Go step (`go-cli-commands/s3`), ending PARTIAL in
  both arms. The one first-step failure is the same Go Wall package clash as in the main run.
- This is a pilot: 24 later steps per arm cannot detect a modest effect. It does not support
  the claim that what Loki learns from earlier runs improves pass rate or cost on this set.

## Spend

- Replay run, on its own ledger: $6.01 against a $15 budget ($0.57 for raw-haiku, raw-haiku-verify
  and loki-haiku over 48 runs, $5.44 for raw-opus-verify over 16 runs). The oracle and noop
  self-checks cost nothing.
- Main run: $38.23 recorded in its results file (231 runs). Ledger total including $0.90 of
  pilot runs used to calibrate task difficulty and one $0.02 diagnostic rerun: $39.14, under the
  $40 cap. The budget check stops before starting a run, so up to 3 in-flight runs finish after
  the cap is reached; the ledger ended $0.64 over the $38.50 budget.
- Learning protocol, on its own ledger: $0.44 recorded in its results file (72 steps) plus a
  $0.05 smoke run, $0.49 in total. A first attempt stopped after step 1 on a harness fault (fixed
  and covered by the stub test since); its step-1 costs were not recorded and, at the measured
  step-1 cost, came to under $0.10.

## Reproduce

```bash
bash benchmarks/h2h/run.sh --configs oracle,noop                     # task self-check, no model
bash benchmarks/h2h/run.sh --reps 3 --jobs 4 --budget 38.5 --ledger spend.jsonl
bash benchmarks/h2h/run.sh --suite replay --configs oracle,noop     # replay self-check, no model
bash benchmarks/h2h/run.sh --suite replay --configs raw-haiku,raw-haiku-verify,raw-opus-verify,loki-haiku \
    --reps 2 --jobs 4 --budget 15 --ledger replay.jsonl
bash benchmarks/h2h/run.sh --sequences all --configs loki-haiku-learn,loki-haiku-nolearn \
    --reps 3 --jobs 4 --budget 9.2 --ledger learning.jsonl
```

Real configs need a logged-in `claude` CLI plus python3, pytest, bun, go and cargo.
