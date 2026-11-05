# Head-to-head benchmark: results

Loki against raw Claude Code (`claude -p`) on the same coding tasks, scored only by hidden tests.
This page states the protocol and the latest numbers, including where Loki loses.

Latest runs: `results/2026-11-02-0aed07b0f.json` (synthetic suite, commit 0aed07b0f) and
`results/2026-11-02-52904268a-replay.json` (replay suite, commit 52904268a), both from clean
commits that hold the engine change below (`citable: true`). The earlier citable runs from commits
5063feb95, 52904268a (synthetic) and adf20d7ff are kept beside them. Older runs further down name their own engine.

The hard suite (`results/2026-11-01-e13f3dd72-hard.json`, 10 configs on 8 real multi-file fixes) is in
[Hard suite](#hard-suite-real-multi-file-fixes-selected-so-raw-haiku-fails).

## Honest VERIFIED and fewer sessions (commits 5063feb95 to 0aed07b0f)

Each run: 2 reps, `--jobs 4`, the raw config and loki-haiku in one invocation, from a clean commit
(5063feb95; 52904268a after merging v11.122.0; adf20d7ff and 0aed07b0f after the review fixes and
merging v11.124.0). The synthetic "main" row is the committed result on origin/bench/main-haiku-flag
(`results/2026-11-02-pr471-old-haiku-4c51599fb.json`, 4c51599fb): the v11.120.1 engine plus one bench config commit, not a commit on
main and not v11.122.0. The replay "main" row is `results/2026-11-01-2100eda48-replay.json` (2100eda48, the v11.114.0 engine). Neither row
is a run of this branch's base, so a difference against them mixes this PR's changes with main's own v11.121 to v11.124 changes. The "before" rows are the v11.116.0 runs in the sections below; they are **not citable**
under the provenance rule (see Citability), so they are context, not a measured baseline.

Synthetic suite, 24 tasks:

| run | config | pass | 95% CI | $ per passed task | median s | p90 s | sessions | verdict agrees | false VERIFIED |
|---|---|---|---|---|---|---|---|---|---|
| before (v11.116.0, not citable) | loki-haiku | 47/48 | 89.1-99.6% | 0.0131 | 29.0 | 174.3 | 1.90 | 29/48 | 1 |
| 5063feb95 | raw-haiku | 48/48 | 92.6-100% | 0.0201 | 27.2 | 167.6 | 1.00 | - | - |
| 5063feb95 | loki-haiku | 48/48 | 92.6-100% | 0.0108 | 24.4 | 155.7 | 1.58 | 33/48 | 0 |
| 52904268a | raw-haiku | 48/48 | 92.6-100% | 0.0202 | 27.3 | 201.3 | 1.00 | - | - |
| 52904268a | loki-haiku | 48/48 | 92.6-100% | 0.0112 | 27.7 | 183.1 | 1.56 | 31/48 | 0 |
| bench/main-haiku-flag (4c51599fb, v11.120.1) | loki-haiku | 48/48 | 92.6-100% | 0.0118 | 26.8 | - | 1.88 | 32/48 | 0 |
| adf20d7ff | raw-haiku | 48/48 | 92.6-100% | 0.0216 | 26.5 | 185.7 | 1.00 | - | - |
| adf20d7ff | loki-haiku | 47/48 | 89.1-99.6% | 0.0119 | 26.8 | 191.0 | 1.69 | 32/48 | 0 |
| 0aed07b0f | raw-haiku | 48/48 | 92.6-100% | 0.0167 | 29.0 | 170.1 | 1.00 | - | - |
| 0aed07b0f | loki-haiku | 48/48 | 92.6-100% | 0.0113 | 26.5 | 197.2 | 1.54 | 33/48 | 0 |
| 0972a4f97 (1 rep) | raw-haiku | 24/24 | 86-100% | 0.0226 | 26.6 | 187.8 | 1.00 | - | - |
| 0972a4f97 (1 rep) | loki-haiku | 24/24 | 86-100% | 0.0116 | 25.7 | 190.5 | 1.62 | 17/24 | 0 |

The 0972a4f97 rows are one rep of the final head after the review fixes (`results/2026-11-04-0972a4f97.json`, citable, clean tree, loki_sha 0972a4f97): same pass count as raw Haiku, 0 false VERIFIED, about half the cost per passed task in that one run (raw Haiku's cost per pass varies a lot between runs: one py-semver-range run cost $0.204).

Replay suite, 8 real closed issues:

| run | config | pass | $ per passed task | median s | sessions | false VERIFIED |
|---|---|---|---|---|---|---|
| 5063feb95 | raw-haiku-verify | 13/16 | 0.0169 | 41.5 | 1.00 | - |
| 5063feb95 | loki-haiku | 12/16 | 0.0092 | 45.6 | 1.25 | 1 |
| 52904268a | raw-haiku-verify | 12/16 | 0.0181 | 40.5 | 1.00 | - |
| 52904268a | loki-haiku | 12/16 | 0.0097 | 40.6 | 1.25 | 2 |
| bench v2 (2100eda48, v11.114.0) | loki-haiku | 10/16 | 0.0135 | 40.6 | 1.75 | 2 |

Against those main rows there is **no measured false-VERIFIED improvement yet**: they also had 0 false
VERIFIED on the synthetic suite (4c51599fb) and 2 on the replay suite (2100eda48, the same task).
Replay verdict agreement is lower here: main 6/16, this PR 4/16 (loki-haiku, from each result's `verdict_agreement`).
The pass and cost differences below (about 18% fewer sessions per task on the synthetic suite, 1.54 vs 1.88, at $0.0113 vs $0.0118 per
passed task; replay 12/16 vs 10/16; boltons #393 0/2 to 2/2; Go tests counting) are against older engines and include main's own
v11.121 to v11.124 changes, so none of them is attributed to this PR alone.

On the synthetic suite no run read VERIFIED while its hidden tests failed, in any of these runs.
On the replay suite it did happen: go-semver-four-part (semver #185), rep 2 at 5063feb95 and both
reps at 52904268a. The issue does not state the hidden case `12.3.34~ 1.2.3`, and the change
modifies functions the repo's own passing tests already call, so the added-function cap cannot see
it. At 5063feb95 raw Haiku with the verify sentence passed that task once in two runs and Loki on
Haiku in neither (Loki trailed by one task); at 52904268a neither passed it and the two tie at 12/16.
On the replay suite Loki's verdict is also cautious: at 52904268a only 4 of 16 runs read VERIFIED
(all four on Go tasks, two of them false), and 10 passing Python runs read PARTIAL.

At 0aed07b0f, Loki on Haiku costs 32% less per passed task than raw Haiku on the synthetic suite
($0.0113 vs $0.0167; raw Haiku's cost per pass ranged $0.0167 to $0.0216 across these runs), and at
52904268a 46% less than raw Haiku with the verify sentence on the replay suite ($0.0097 vs $0.0181),
at the same pass count and about the same median time. Wall sessions: 16 in 48 synthetic runs at
0aed07b0f, 0 in the replay runs.

The review round between 52904268a and 0aed07b0f: py-invoice-rounding read PARTIAL in both reps
while passing (its added helper is reached only through an untouched file); it reads VERIFIED in
both now. The adf20d7ff run also showed a regression from that round: ts-cart-discounts rep 2 read PARTIAL
naming DiscountDef, the shape a multi-line function type alias produced under the new multi-line
arrow reading (reproduced by hand; fixed in 0aed07b0f). The 0aed07b0f
run then showed a single-line `export type X = (a) => b` alias counted the same way (ts-cart-discounts
rep 1 PARTIAL, naming DiscountRule); the fix for that landed after this run and is not measured.
Its go-topo-schedule rep 1 at adf20d7ff ended BLOCKED on a performance conflict the model raised,
and failed; the same task passed in every other run. Python VERIFIED: 10 of 12 at 0aed07b0f (8 of
12 at 52904268a).

What changed:

- **An added public function no agent-independent test calls caps the run at PARTIAL**, named on the
  receipt. Each changed file is read at HEAD against the base, so a method added to an existing
  class, a def under a module-level `if`, TS methods of exported classes and `export { f }` lists,
  Go `var X = func` and Rust `pub fn` count. A private class, a nested def, a signature-only edit, a
  TS constructor, `.d.ts`, generated files (`*.pb.go` and similar) and test helpers outside test
  files do not. Names inside strings are no reference. A function whose caller an independent test
  calls is covered (indirect coverage), also when that caller sits in a file the run did not edit
  (py-invoice-rounding: the added `line_tax_cents` is reached from the tested `Invoice.tax_cents`
  through `invoice_tax_cents`). Matching is by name, so a common name can be cleared by an unrelated
  call (an added `get` by any `d.get(`), and CommonJS exports (`module.exports`, `exports.f`) are not
  read, so an added CommonJS function is never capped. Independent means a Wall file that passed, or a test the run
  did not touch that counted tests (n > 0). Tests the implementer wrote or edited never clear it.
- **Go tests in a black-box `tests/` package count.** Go corroboration refused any package with no
  non-test files, so every check there read not_run ("no tests executed"); each such package is now
  proven by the coverage of the module packages it imports, and one that imports none never passes
  beside one that does. A changed Go file maps to its own package's tests and to every test that
  imports it by its module import path. Go runs reading VERIFIED: 0 of 12 before, 4 of 12 now.
- **Fewer Wall sessions.** With Go tests mapped, Go tasks with a relevant visible test take the lean
  path. Wall sessions: 30 in 48 runs before, 16 now; sessions per task 1.90 to 1.54.
- **An already-done claim gets one challenge** (boltons #393, where the issue's example asserted
  today's output with the expected lines commented out): before it is believed, the session must
  reproduce the defect the prose describes. A claim made in reply to the empty-done correction is
  challenged too, no empty-done correction follows a challenge, and a session that edits and then
  claims already-done keeps its edit (it is verified as a change, never ALREADY_SATISFIED).
  Boltons: 2 of 2.

Measured alternatives, not citable (they ran from uncommitted code, so their files are not kept):
a Wall also on lean tasks whose text names a new `name(` callable gave 48/48 at 45% more cost per
passed task than the cap alone; no Wall at all gave 48/48 at $0.0068 per passed task and 1.00
session, but only 8 of 48 runs VERIFIED. The Wall stays; dropping it is a product decision.

Still failing: go-semver-four-part as above, and py-toolz-partition-len for every config.

Spend for the citable runs: $3.47 at 5063feb95, $1.84 at 52904268a, $1.60 at adf20d7ff and $1.34
at 0aed07b0f, each on its own ledger (earlier uncitable runs: $4.18).

**Citability.** A results file counts only if it was produced from a clean commit: the harness now
stamps every results file with the engine commit, the tool versions and a `citable` flag, and refuses
to run Loki configs from a tree with uncommitted changes. The v11.116.0 before/after files are
**not citable**: `2026-11-01-win-bench-v2-after.json` records that it ran from uncommitted code,
and `2026-11-01-65440abaf-before.json` and `2026-11-01-win-bench-v2-review-fixes.json` record
commits (65440abaf, 38b31e8cc) that are on no published branch, since they predate the release
squash, so nobody can check out the code they measured. The replay file ran Loki from a clean engine commit
(2100eda48) with the benchmark harness changes not yet committed (committed in 070d72ea4), so it
is not citable under this rule either.

## Hard suite (real multi-file fixes, selected so raw Haiku fails)

Results file: `results/2026-11-01-e13f3dd72-hard.json`, **citable**: every invocation that wrote it
ran from a clean commit (e13f3dd72, then 0d2071933, which changes only a test comment), on the
v11.116.0 engine merged from main. Tool versions are in the file (bun 1.3.13, Claude CLI 2.1.316).

- **Provenance gap.** "Clean" at those two commits did not cover every input. The expr snapshots'
  `internal/` packages (102 files, in go-expr-autoderef and go-expr-withcontext) were on disk but
  matched the then-unanchored `internal/` ignore rule, so neither commit holds them and the
  clean-tree check could not see them. They were added in d915fd672 (the snapshot builder was last
  modified at 20:36, before either run commit, and was not changed after). They are now pinned by
  each task's `snapshot_sha256`. The provenance gate now treats any gitignored file under
  `benchmarks/` (Python bytecode aside) as dirt, so a run like this one would now be marked not
  citable.
- **Scoring command changed after the run.** 2ec9b75d6 (after this run) added
  `--ignore=tests/test_toml_spec_tests.py` to the tomlkit tasks' test commands (that file needs
  PyYAML) and `-W ignore::pytest.PytestRemovedIn10Warning` to the click tasks' (newer pytest warns on
  a pattern in click's tests, and click turns warnings into errors). This makes the commands work on
  CI. No verdict depended on it. The change can only turn a fail into a pass, by skipping that file
  or that warning, and none of the 83 failing runs on the affected tasks (tomlkit #408 and #165,
  click #2836) mentions the skipped file, the warning or yaml in its recorded failure tail.

- **Candidates.** 18 closed issues in `fixtures/hard/` from sqlglot, tomlkit, click, sqlparse,
  mistune and expr (MIT or BSD-3-Clause; each `meta.json` records license, issue, fix PR and
  commits). Each is replayed at the fix's parent commit and scored by the fix's own test files at
  their own paths, together with the rest of the project's suite. Only `meta.json` and `task.txt`
  are in this repository: the snapshot is fetched from the upstream at the pinned commits on first
  use and cached outside it (see "Snapshots" below). The merged fix passes all 18 and the parent
  commit passes none (`tests/min/h2h-harness.sh` with `H2H_SELFCHECK_FETCH=1`). The tasks live
  under `fixtures/` because two issue texts keep characters (emoji, dashes) this repository's text
  rule otherwise bans.
- **Selection rule.** A task qualifies only if the fix touches 2 or more files and raw Haiku with
  the verify sentence passed under half of its pilot runs (2 runs per task over the 19 candidates of
  the time, $0.78). Pilot results file: `results/2026-11-01-2499d6aee-hard-pilot.json` (38 runs,
  $0.78 recorded, citable flag true with the same provenance gap as below: the expr `internal/`
  files were gitignored at 2499d6aee). Each task's `meta.json` pilot counts must match it
  (`tests/min/h2h-harness.sh`). 11 met it. 3 of those were excluded because the fix's tests need something the
  issue cannot tell anyone: a class the fix adds (sqlparse `TypedLiteral`), a method the fix adds
  (`Function.get_window`), and one of two valid HTTP header shapes (chi #446's `Allow`). The chi
  candidate was then removed altogether: its merged fix fills the `Allow` header by iterating a Go
  map, so the fix's own test (which expects `GET, HEAD` in that order) fails about one run in six
  (4 of 24 runs of the fix under 8-way parallel load), which made the self-check flaky.
  **8 qualify**: expr #836 and #823, click #2836, sqlglot #8598, #8808 and #8805, tomlkit #408 and
  #165. A paid run without `--tasks` takes only those. The target was 20 or more; the candidates
  gave 8.
- **Configs.** Raw `claude -p` on Haiku, Sonnet and Opus, each also with the verify sentence; Loki
  pinned to Haiku, Sonnet or Opus (`LOKI_SESSION_MODEL`); and `loki-default`, Loki with no model pin
  so its own routing picks. 3 reps, `--jobs 4`, timeout 900 s.
- **Accepted without edit** now means the hidden tests pass and the run weakened no existing test:
  a pre-existing test file deleted, with a line removed or changed, or with an added skip, or any
  test config changed. New test files and appended cases are fine. Each record keeps its test diff.

| 8 tasks x 3 reps | pass | 95% CI | accepted | $ per task | $ per passed task | median s | p90 s | sessions |
|---|---|---|---|---|---|---|---|---|
| raw-haiku | 1/24 | 0.7-20.2% | 0/24 | 0.0198 | 0.4756 | 63.3 | 158.0 | 1 |
| raw-haiku-verify | 0/24 | 0-13.8% | 0/24 | 0.0219 | - | 79.2 | 206.0 | 1 |
| raw-sonnet | 0/24 | 0-13.8% | 0/24 | 0.1975 | - | 51.4 | 88.5 | 1 |
| raw-sonnet-verify | 1/24 | 0.7-20.2% | 1/24 | 0.1951 | 4.6815 | 43.0 | 86.3 | 1 |
| raw-opus | 3/24 | 4.3-31.0% | 2/24 | 0.6155 | 4.9236 | 104.2 | 215.3 | 1 |
| raw-opus-verify | 3/24 | 4.3-31.0% | 2/24 | 0.6313 | 5.0508 | 118.8 | 256.1 | 1 |
| loki-haiku | 0/24 | 0-13.8% | 0/24 | 0.0171 | - | 92.5 | 159.9 | 1.54 |
| loki-sonnet | 1/24 | 0.7-20.2% | 1/24 | 0.1411 | 3.3852 | 61.6 | 288.4 | 1.50 |
| loki-opus | 5/24 | 9.2-40.5% | 5/24 | 0.2556 | 1.2271 | 83.1 | 362.8 | 1.50 |
| loki-default | 4/24 | 6.7-35.9% | 4/24 | 0.2216 | 1.3296 | 81.0 | 307.6 | 1.50 |

**Headline.** Loki on Haiku does not match raw Sonnet or raw Opus here: it passes 0 of 24, raw
Sonnet 0 of 24 (1 with the verify sentence), raw Opus 3 of 24. Loki with default routing passes 4
of 24 against raw Opus's 3 at 0.27 times raw Opus's cost per passed task ($1.33 against $4.92), and
Loki pinned to Opus passes 5 of 24 at $1.23 per passed task (0.25 times). Every interval overlaps,
and all the passes come from 2 of the 8 tasks, so this shows Loki on a strong model is cheaper per
run than raw on the same model (Opus: $0.26 against $0.62 per task; raw Opus took a median of 16.5
turns), not that it solves more.

| Loki config | VERIFIED | PARTIAL | BLOCKED or STALLED | verdict agrees | false VERIFIED | VERIFIED recall | models per session (count) |
|---|---|---|---|---|---|---|---|
| loki-haiku | 0 | 19 | 5 | 24/24 | 0 | - (no passes) | haiku 37 |
| loki-sonnet | 0 | 20 | 4 | 23/24 | 0 | 0 of 1 | sonnet 36 |
| loki-opus | 0 | 21 | 3 | 19/24 | 0 | 0 of 5 | opus 30, sonnet 6 |
| loki-default | 1 | 19 | 4 | 19/24 | 1 | 0 of 4 | provider default 30, sonnet 6 |

- **Which models ran.** Pinned runs used their pin for implement and fix sessions; the 6 Sonnet
  sessions in each of loki-opus and loki-default are all intake sessions on the two tomlkit tasks. Default routing leaves implement and fix to the Claude CLI's default model; a one-call
  check under the same throwaway HOME ($0.045, on the ledger) showed that default is
  `claude-opus-5-5`. So `loki-default` here is in effect Loki on Opus with a Sonnet intake.
- **Verdicts.** Loki almost never claims VERIFIED on these tasks: 1 VERIFIED in 96 runs, and it was
  wrong (loki-default, go-expr-withcontext rep 3). That run was an ALREADY_SATISFIED seal with 0 files
  changed: Loki judged the issue already fixed and changed nothing. VERIFIED recall is 0: none of the 10 Loki runs
  whose work passed the hidden tests was sealed VERIFIED; all ended PARTIAL. Agreement is high
  only because nearly everything failed and nearly everything was PARTIAL.
- **Accepted.** 3 passing raw runs changed existing tests of expr's patcher to compile against a
  pointer receiver they introduced (raw-haiku rep 2, raw-opus rep 3) or rewrote the issue's own test
  (raw-opus-verify rep 1), so they are not accepted. Every passing Loki run is accepted.

| task | raw-haiku | raw-haiku-verify | raw-sonnet | raw-sonnet-verify | raw-opus | raw-opus-verify | loki-haiku | loki-sonnet | loki-opus | loki-default |
|---|---|---|---|---|---|---|---|---|---|---|
| go-expr-autoderef | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| go-expr-withcontext | 1/3 | 0/3 | 0/3 | 1/3 | 2/3 | 1/3 | 0/3 | 1/3 | 3/3 | 2/3 |
| py-click-show-default-prompt | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-sqlglot-hash-case | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-sqlglot-mysql-timestampadd | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-sqlglot-snowflake-idents | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-tomlkit-array-remove | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-tomlkit-value-bool | 0/3 | 0/3 | 0/3 | 0/3 | 1/3 | 2/3 | 0/3 | 0/3 | 2/3 | 2/3 |

**Why runs fail.** 6 of the 8 tasks were never passed by any config in 30 runs each. The failing
runs made changes and missed cases the fix's tests check, for example: sqlglot #8808 expects exact
DuckDB and Postgres output strings (raw Opus wrote `CAST(... AS TIMESTAMP) + INTERVAL` where the fix
writes the bare literal); sqlglot #8598 needs case-sensitive equality on node types beyond the one
the issue shows (`AnonymousAggFunc(sumMap)` against `summap`); click #2836 expects the custom default
in parentheses and for defaults of `None`; tomlkit #408 expects exact whitespace after removing an
array item; tomlkit #165 expects every value with a `true` prefix to be rejected. Loki's sessions
ended PARTIAL on most of these; on sqlglot #8805
10 of 12 Loki runs stalled in the fix loop and 2 ended BLOCKED, and 4 runs on tomlkit #165 ended
BLOCKED.

**Threats.** 8 tasks, 2 of which carry every pass: one task more or less for any config moves its
rate by 4 points per run and 12.5 points per task. The selection rule picks tasks raw Haiku fails, so raw Haiku's 1 of 24 is
low by construction (regression to the mean would favour it on a fresh draw). Contestants had
network access and could look up the upstream fix. They also have local disk access. The fix commit
(in the bare git cache) and the rebuilt `hidden/` and `solution/` trees sit at a predictable path,
`~/.cache/loki-h2h` by default. Contestants get a throwaway HOME, but the cache path is reachable by
absolute path. This is not new: the vendored tree had the same files inside this repository. The
mitigation is running contestants in a container with restricted egress, which is in progress.

## Replay suite (real closed issues)

The synthetic tasks below are written for the benchmark. The replay suite is real work: 8 closed
issues from permissively licensed open source projects, each replayed at the parent commit of the
change that fixed it.

- **Tasks.** `replay/<id>/`, 6 Python and 2 Go. `task.txt` is the issue title and body as written.
  The hidden tests are the test files the merged fix changed, taken from the fix commit and scored
  at their own paths, run with the rest of the project's suite (so a fix that breaks other tests
  fails). `meta.json` "source" records the upstream, license, issue, fix PR, fix and parent
  commits, and every change made to the snapshot; the snapshot itself is fetched at run time (see
  "Snapshots" below).

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
  before that rewrite, which differ only in those characters. These changes are recorded as
  `add_files` and `patch_files` in `meta.json` and applied when the snapshot is rebuilt.
- **Self-check.** The merged fix passes all 8 tasks and the parent commit passes none
  (`--suite replay --configs oracle,noop`, run by `tests/min/h2h-harness.sh` with
  `H2H_SELFCHECK_FETCH=1`).
- **Snapshots.** Replay and hard tasks were first vendored in this repository (about 1.4 million
  lines). They are now rebuilt on first use: a shallow fetch of the pinned parent and fix commits
  (and any pinned submodule) into a bare cache, `git archive` of the vendored paths, the fix's test
  files as `hidden/`, its other changed files as `solution/`, then `add_files` and `patch_files`.
  The result must match `meta.json` `snapshot_sha256` (every path, executable bit and content), or
  the task is refused. Each digest was taken from the vendored snapshot the results below were
  measured on, and every one of the 26 tasks rebuilds to it. Cache: `$H2H_CACHE`, default
  `${XDG_CACHE_HOME:-~/.cache}/loki-h2h`: for all 26 tasks, about 25 MB of git cache plus about
  69 MB of rebuilt trees. A cold build takes about a minute. A cached snapshot is hashed again on every
  load (0.4 s for all 26) and refused if it was edited. Every `add_files`, `patch_files`, hidden and
  solution path must stay inside the build directory (no absolute path, no `..`, no symlink on the
  way) before anything is written.
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
The replay suite's first run below is `results/2026-11-01-2100eda48-replay.json` (v11.114.0 engine).

**Citability.** A results file counts only if it was produced from a clean commit: the harness now
stamps every results file with the engine commit, the tool versions and a `citable` flag, and refuses
to run Loki configs from a tree with uncommitted changes. The v11.116.0 before/after files are
**not citable**: `2026-11-01-win-bench-v2-after.json` records that it ran from uncommitted code,
and `2026-11-01-65440abaf-before.json` and `2026-11-01-win-bench-v2-review-fixes.json` record
commits (65440abaf, 38b31e8cc) that are on no published branch, since they predate the release
squash, so nobody can check out the code they measured. The replay file ran Loki from a clean engine commit
(2100eda48) with the benchmark harness changes not yet committed (committed in 070d72ea4), so it
is not citable under this rule either.

## Hard suite (real multi-file fixes, selected so raw Haiku fails)

Results file: `results/2026-11-01-e13f3dd72-hard.json`, **citable**: every invocation that wrote it
ran from a clean commit (e13f3dd72, then 0d2071933, which changes only a test comment), on the
v11.116.0 engine merged from main. Tool versions are in the file (bun 1.3.13, Claude CLI 2.1.316).

- **Candidates.** 19 closed issues in `fixtures/hard/` from sqlglot, tomlkit, click, sqlparse,
  mistune, expr and chi (MIT or BSD-3-Clause; each `meta.json` records license, issue, fix PR and
  commits). Each is vendored at the fix's parent commit and scored by the fix's own test files at
  their own paths, together with the rest of the project's suite. The merged fix passes all 19 and
  the parent commit passes none (checked on every PR by `tests/min/h2h-harness.sh`). The snapshots
  live under `fixtures/` because their own tests need characters (emoji, dashes) this repository's
  text rule otherwise bans.
- **Selection rule.** A task qualifies only if the fix touches 2 or more files and raw Haiku with
  the verify sentence passed under half of its pilot runs (2 runs per task, $0.78). 11 met it. 3 of
  those are excluded because the fix's tests need something the issue cannot tell anyone: a class
  the fix adds (sqlparse `TypedLiteral`), a method the fix adds (`Function.get_window`), and one of
  two valid HTTP header shapes (chi's `Allow`). **8 qualify**: expr #836 and #823, click #2836,
  sqlglot #8598, #8808 and #8805, tomlkit #408 and #165. A paid run without `--tasks` takes only
  those. The target was 20 or more; the candidates gave 8.
- **Configs.** Raw `claude -p` on Haiku, Sonnet and Opus, each also with the verify sentence; Loki
  pinned to Haiku, Sonnet or Opus (`LOKI_SESSION_MODEL`); and `loki-default`, Loki with no model pin
  so its own routing picks. 3 reps, `--jobs 4`, timeout 900 s.
- **Accepted without edit** now means the hidden tests pass and the run weakened no existing test:
  a pre-existing test file deleted, with a line removed or changed, or with an added skip, or any
  test config changed. New test files and appended cases are fine. Each record keeps its test diff.

| 8 tasks x 3 reps | pass | 95% CI | accepted | $ per task | $ per passed task | median s | p90 s | sessions |
|---|---|---|---|---|---|---|---|---|
| raw-haiku | 1/24 | 0.7-20.2% | 0/24 | 0.0198 | 0.4756 | 63.3 | 158.0 | 1 |
| raw-haiku-verify | 0/24 | 0-13.8% | 0/24 | 0.0219 | - | 79.2 | 206.0 | 1 |
| raw-sonnet | 0/24 | 0-13.8% | 0/24 | 0.1975 | - | 51.4 | 88.5 | 1 |
| raw-sonnet-verify | 1/24 | 0.7-20.2% | 1/24 | 0.1951 | 4.6815 | 43.0 | 86.3 | 1 |
| raw-opus | 3/24 | 4.3-31.0% | 2/24 | 0.6155 | 4.9236 | 104.2 | 215.3 | 1 |
| raw-opus-verify | 3/24 | 4.3-31.0% | 2/24 | 0.6313 | 5.0508 | 118.8 | 256.1 | 1 |
| loki-haiku | 0/24 | 0-13.8% | 0/24 | 0.0171 | - | 92.5 | 159.9 | 1.54 |
| loki-sonnet | 1/24 | 0.7-20.2% | 1/24 | 0.1411 | 3.3852 | 61.6 | 288.4 | 1.50 |
| loki-opus | 5/24 | 9.2-40.5% | 5/24 | 0.2556 | 1.2271 | 83.1 | 362.8 | 1.50 |
| loki-default | 4/24 | 6.7-35.9% | 4/24 | 0.2216 | 1.3296 | 81.0 | 307.6 | 1.50 |

**Headline.** Loki on Haiku does not match raw Sonnet or raw Opus here: it passes 0 of 24, raw
Sonnet 0 of 24 (1 with the verify sentence), raw Opus 3 of 24. Loki with default routing passes 4
of 24 against raw Opus's 3 at 0.27 times raw Opus's cost per passed task ($1.33 against $4.92), and
Loki pinned to Opus passes 5 of 24 at $1.23 per passed task (0.25 times). Every interval overlaps,
and all the passes come from 2 of the 8 tasks, so this shows Loki on a strong model is cheaper per
run than raw on the same model (Opus: $0.26 against $0.62 per task; raw Opus took a median of 16.5
turns), not that it solves more.

| Loki config | VERIFIED | PARTIAL | BLOCKED or STALLED | verdict agrees | false VERIFIED | VERIFIED recall | models per session (count) |
|---|---|---|---|---|---|---|---|
| loki-haiku | 0 | 19 | 5 | 24/24 | 0 | - (no passes) | haiku 37 |
| loki-sonnet | 0 | 20 | 4 | 23/24 | 0 | 0 of 1 | sonnet 36 |
| loki-opus | 0 | 21 | 3 | 19/24 | 0 | 0 of 5 | opus 30, sonnet 6 |
| loki-default | 1 | 19 | 4 | 19/24 | 1 | 0 of 4 | provider default 30, sonnet 6 |

- **Which models ran.** Pinned runs used their pin for implement and fix sessions; the 6 Sonnet
  sessions in each of loki-opus and loki-default are all intake sessions on the two tomlkit tasks. Default routing leaves implement and fix to the Claude CLI's default model; a one-call
  check under the same throwaway HOME ($0.045, on the ledger) showed that default is
  `claude-opus-5-5`. So `loki-default` here is in effect Loki on Opus with a Sonnet intake.
- **Verdicts.** Loki almost never claims VERIFIED on these tasks: 1 VERIFIED in 96 runs, and it was
  wrong (loki-default, go-expr-withcontext rep 3). VERIFIED recall is 0: none of the 10 Loki runs
  whose work passed the hidden tests was sealed VERIFIED; all ended PARTIAL. Agreement is high
  only because nearly everything failed and nearly everything was PARTIAL.
- **Accepted.** 3 passing raw runs changed existing tests of expr's patcher to compile against a
  pointer receiver they introduced (raw-haiku rep 2, raw-opus rep 3) or rewrote the issue's own test
  (raw-opus-verify rep 1), so they are not accepted. Every passing Loki run is accepted.

| task | raw-haiku | raw-haiku-verify | raw-sonnet | raw-sonnet-verify | raw-opus | raw-opus-verify | loki-haiku | loki-sonnet | loki-opus | loki-default |
|---|---|---|---|---|---|---|---|---|---|---|
| go-expr-autoderef | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| go-expr-withcontext | 1/3 | 0/3 | 0/3 | 1/3 | 2/3 | 1/3 | 0/3 | 1/3 | 3/3 | 2/3 |
| py-click-show-default-prompt | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-sqlglot-hash-case | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-sqlglot-mysql-timestampadd | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-sqlglot-snowflake-idents | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-tomlkit-array-remove | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-tomlkit-value-bool | 0/3 | 0/3 | 0/3 | 0/3 | 1/3 | 2/3 | 0/3 | 0/3 | 2/3 | 2/3 |

**Why runs fail.** 6 of the 8 tasks were never passed by any config in 30 runs each. The failing
runs made changes and missed cases the fix's tests check, for example: sqlglot #8808 expects exact
DuckDB and Postgres output strings (raw Opus wrote `CAST(... AS TIMESTAMP) + INTERVAL` where the fix
writes the bare literal); sqlglot #8598 needs case-sensitive equality on node types beyond the one
the issue shows (`AnonymousAggFunc(sumMap)` against `summap`); click #2836 expects the custom default
in parentheses and for defaults of `None`; tomlkit #408 expects exact whitespace after removing an
array item; tomlkit #165 expects every value with a `true` prefix to be rejected. Loki's sessions
ended PARTIAL on most of these; on sqlglot #8805
10 of 12 Loki runs stalled in the fix loop and 2 ended BLOCKED, and 4 runs on tomlkit #165 ended
BLOCKED.

**Threats.** 8 tasks, 2 of which carry every pass: one task more or less for any config moves its
rate by 4 points per run and 12.5 points per task. The selection rule picks tasks raw Haiku fails, so raw Haiku's 1 of 24 is
low by construction (regression to the mean would favour it on a fresh draw). Contestants had
network access and could look up the upstream fix.

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
- What the learn arm could be given: no run lesson on any later step (its records show none on
  file), the receipt facts of earlier steps (1 or 2 on file before every later step), which the
  v11.116.0 retrieval injects as review lessons ("Run X sealed PARTIAL: <title>") when they share
  a word with the task, and the worked example. The cost gap is one run: `ts-pricing-rules` rep 3
  step 3 cost $0.106, while every other learn-arm step cost $0.002 to $0.007; without it the learn
  arm's later steps cost $0.0041 per pass against nolearn's $0.0061.

## Learning protocol v2 (8 sequences)

Results files: `results/2026-11-01-learning-v2-after.json` (lessons, example and nolearn arms on
the reworked retrieval) and `results/2026-11-01-learning-v2-before.json` (the v11.116.0 engine
with both opted in, run from a checkout of that release with this harness and these sequences).

- **What changed in retrieval** (util/pr_lessons.ts). A run lesson reaches the brief only when
  its class can recur on a file (a failing check, a restored test edit, a spec conflict) and it
  touches a file the run will touch (plan relevant files, their impacted tests, the files the
  task names). Out-of-scope and time-limit lessons, and receipt facts, never do. One imperative
  line per lesson, a 400-byte block (was 1200), and the worked example only for a near-duplicate
  task. A check that blocks the session stop is now learned too (it was never recorded), and each
  run writes `lessons-injected.json`.
- **Protocol.** 8 sequences: the 4 above plus 4 new ones of 4 steps (`py-unit-registry`,
  `ts-format-catalog`, `go-mathx-registry`, `py-textkit-doctest`), each with a repo convention
  enforced by a visible test that no task text mentions (register the new function in a separate
  registry file, add it to `__all__` with a doctest, reject non-numbers). Loki on Haiku, 3 reps.

| arm | later steps pass | 95% CI | $ per passed task | later steps with a lesson injected | repeat mistakes |
|---|---|---|---|---|---|
| nolearn | 55/60 | 82-96% | 0.0041 | 0 | 0/60 |
| lessons (new retrieval) | 54/60 | 80-95% | 0.0042 | 0 | 0/60 |
| example (new retrieval) | 55/60 | 82-96% | 0.0038 | 0 | 0/60 |
| learn (v11.116.0 retrieval) | 54/60 | 80-95% | 0.0043 | not recorded | 0/60 |

- Paired by sequence, step and rep against nolearn: lessons -0.017 pass rate (95% -0.100 to
  +0.050), cost per pass 1.005x (0.89 to 1.14); example 0.000 (-0.083 to +0.083), 0.922x
  (0.81 to 1.04); v11.116.0 learn -0.017 (-0.083 to +0.050), 1.036x (0.93 to 1.16).
- **Nothing was injected.** Haiku met every convention first time: every first step passed in
  every arm (24/24), no check blocked a stop, and only 4 to 6 of 60 later steps per arm recorded
  any recurring-class mistake, none of them a repeat of an earlier step's. The new arms were
  therefore given exactly the brief nolearn was, and their differences are run-to-run noise.
- **What the old retrieval would have taught.** On every rep of the 4 new sequences step 1
  correctly edited the registry file the convention requires, and Loki recorded that as an
  out-of-scope edit ("change only the files the task needs"). The v11.116.0 retrieval injects
  that lesson whenever its file overlaps the next task; the new retrieval never injects it.
- **Decision.** Lessons and the worked example stay opt-in. The lessons arm misses the rule
  (54/60 is below 55/60); the example arm meets it (55/60, 0.92x) only vacuously, with zero
  examples injected, so it is not evidence either way.

## Learning curve vs raw Claude Code (protocol; paid run pending)

Question: on one repo, does Loki get cheaper and more first-pass-correct from run 1 to run 20, against raw
Claude Code on the same model? This section is the protocol and the harness that answers it. It holds no
numbers: the paid run waits for the 3-day benchmark and its results will be added here with a results file.

Arms (`--sequences`, same model in every arm of one comparison):

- `raw-sonnet`, `raw-haiku`: one `claude -p <task>` call per step, no Loki, no memory. The same-model floor.
- `loki-sonnet-learn` and `loki-haiku-learn`: lessons from earlier runs and the worked example both on
  (`LOKI_PR_LESSONS=1 LOKI_WORKED_EXAMPLE=1`, the switch a user sets on `loki start`).
- `loki-sonnet-nolearn` and `loki-haiku-nolearn`: both off (`LOKI_NO_PR_LESSONS=1`). Isolates learning from Loki itself.
- `loki-haiku-lessons`, `loki-haiku-example`: one knob each, as in the v2 section above.
- `loki-auto-learn`: no model pin, `LOKI_ROUTER=auto` plus both learn knobs, so the executor comes from the repo's
  router_history.json. It is compared with `raw-sonnet` and labelled mixed-model: do not read it as same-model.

Definitions:

- `--laps N` runs every sequence N times in a row inside ONE repo copy and ONE throwaway HOME. Between laps the repo
  is reset to its base commit (main, hard reset, clean) and `.loki` memory is kept. `run_index` = (lap - 1) x steps + step,
  so a 4-step sequence at `--laps 5` reaches run 20.
- First-pass: the hidden tests pass and, for a Loki arm, `fix_rounds == 0`. Raw Claude Code has no repair loop, so
  for a raw arm first-pass is the pass itself. The definition is asymmetric by construction, so pass rate and cost per
  pass are the headline numbers; first-pass is reported next to them.
- Pairing: records are paired on (sequence, rep, run_index) between a Loki arm and its raw baseline (`loki-haiku-*`
  vs `raw-haiku`, `loki-sonnet-*` vs `raw-sonnet`, `loki-auto-learn` vs `raw-sonnet`). The paired table gives the
  difference in pass rate, the difference in first-pass rate and the cost ratio (sum of Loki cost over sum of raw cost,
  over pairs where both costs were measured), each with a 95% percentile bootstrap interval: seed 20261104, 2000
  resamples, so a rerun on the same results gives the same interval.
- Reading it: an interval that includes zero (or, for the cost ratio, one) is no effect. Reps must be at least 3.
- Default stays off until measured: lessons, worked example and the router are default off on `loki start`. They flip
  only if the paired pass difference at run 20 has its interval lower bound at or above 0 AND the cost-ratio interval
  upper bound at or below 1.0 against `raw-sonnet`.

Caveat: laps repeat identical tasks. From lap 2 the worked example matches a near-duplicate task exactly, and an
identical base can replay a recorded verdict, so run 20 after laps measures reuse on repeated work, not
generalization to new work. The lap 1 curve (distinct steps) is reported separately for that reason, and a sequence of
20 distinct steps is the follow-up.

The paid command (about 4 sequences x 4 steps x 5 laps x 3 reps x 3 arms; set the budget cap on its own ledger):

```bash
bash benchmarks/h2h/run.sh --sequences py-unit-registry,ts-format-catalog,go-mathx-registry,py-textkit-doctest \
    --configs raw-sonnet,loki-sonnet-learn,loki-sonnet-nolearn --laps 5 --reps 3 --jobs 4 --budget 60 --ledger learn20.jsonl
```

## Spend

- Hard suite, on its own ledger: $56.42 against an $80 cap. Qualifying pilot $0.78 (38 runs of
  raw-haiku-verify), default-model check $0.05, main run $55.60 over 240 runs (raw Opus $14.77, raw
  Opus with the verify sentence $15.15, raw Sonnet $4.74 and $4.68, Loki on Opus $6.14, Loki
  default $5.32, Loki on Sonnet $3.39, raw Haiku $0.48 and $0.53, Loki on Haiku $0.41).
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
- Learning protocol v2, on its own ledger: $1.20 against a $12 budget ($1.18 for the 336 steps
  in the two results files, $0.02 for a one-rep, two-sequence probe kept on disk to read the
  lesson categories).

## Reproduce

```bash
bash benchmarks/h2h/run.sh --configs oracle,noop                     # task self-check, no model
bash benchmarks/h2h/run.sh --reps 3 --jobs 4 --budget 38.5 --ledger spend.jsonl
bash benchmarks/h2h/run.sh --suite replay --configs oracle,noop     # replay self-check, no model
bash benchmarks/h2h/run.sh --suite replay --configs raw-haiku,raw-haiku-verify,raw-opus-verify,loki-haiku \
    --reps 2 --jobs 4 --budget 15 --ledger replay.jsonl
bash benchmarks/h2h/run.sh --suite hard --configs oracle,noop       # all 18 hard candidates, no model
H2H_SELFCHECK_FETCH=1 bash tests/min/h2h-harness.sh                 # the harness test plus both fetched self-checks
bash benchmarks/h2h/run.sh --suite hard --reps 3 --jobs 4 --timeout 900 --budget 73 --ledger hard.jsonl \
    --configs raw-haiku,raw-haiku-verify,raw-sonnet,raw-sonnet-verify,raw-opus,raw-opus-verify,loki-haiku,loki-sonnet,loki-opus,loki-default
bash benchmarks/h2h/run.sh --sequences all --configs loki-haiku-learn,loki-haiku-nolearn \
    --reps 3 --jobs 4 --budget 9.2 --ledger learning.jsonl
bash benchmarks/h2h/run.sh --sequences all --configs loki-haiku-lessons,loki-haiku-example,loki-haiku-nolearn \
    --reps 3 --jobs 4 --budget 12 --ledger learning-v2.jsonl
bash benchmarks/h2h/run.sh --sequences all --configs oracle,noop --laps 2           # lap self-check, no model
bash tests/min/h2h-harness.sh                                          # stub-provider check of the raw arms, laps, curve and paired stats
```

Real configs need a logged-in `claude` CLI plus python3, pytest, bun, go and cargo.
