# COST-HALF: Loki dollars per verified task against raw claude -p (D91 item 11)

Status: design, Architect draft 2026-10-08 rev 3 (D93 routing call in LD-01, PRICE-01 merged into PRICE-TRUTH, AS-01 mapped to the built CH-02). This revision folds in the paper survey
(autonomi-dev research/2026-10-08-cost-half/PAPERS.md) and the CTO slice order.
Moat order holds: Seal accuracy and Wall integrity come before every saving. No slice lets the implementer
see, read earlier, or edit the Wall checks. No slice skips wall, verify, commit, seal or pr.

## 0. Honest target (for METRICS)

- Trivial and small tasks: about 0.5x raw per verified task. This is reachable because the gap is mostly
  fixed overhead (cold sessions, prefix writes, effort). The lean arm already beats raw on small tasks:
  27/29 at $0.16 vs raw 27/29 at $0.24 (PROGRESS.md 2026-09-28T02:57Z; METRICS default arm 26/29 at $0.3946).
- Medium tasks: 0.6x to 0.8x raw, unless the cascade (rank 3) does better. PAPERS.md section 5 lands the
  multiplicative stack near raw parity on medium. Half on medium needs Haiku carrying implement work, or a
  much smaller token footprint than raw. Both are unproven.
- Every claim is a B9 row: raw arm vs Loki arm, n>=3, usd per SOLVED task (not mean per run), solve-rate
  95% CI, and p90 usd reported separately. A lever that drops the solve rate below raw's lower CI bound fails
  regardless of savings (PAPERS.md section 6).

## 1. Where the money goes (measured)

### 1.1 Prices (PAPERS.md 1.1, claude.com pricing page read 2026-10-08), $/MTok

| model | input | 5m cache write | cache read | output |
|---|---|---|---|---|
| Opus 5.5 | 4.00 | 5.00 | 0.20 | 20.00 |
| Sonnet 5.5 | 2.00 | 2.50 | 0.10 | 10.00 |
| Haiku 5.5, prompt <= 100K | 0.10 | 0.125 | 0.01 | 0.50 |
| Haiku 5.5, prompt > 100K | 0.50 | 0.625 | 0.05 | 2.50 |

- Sonnet is 2x cheaper than Opus. Haiku is 20x cheaper than Sonnet, but only under 100K.
- Cache reads cost 0.05x input on Opus and Sonnet.
- The advisor tool definition alone is about 1,000 prompt tokens per request.
- Drift found: loki-ts/data/model-pricing.json says Opus is 5/25/0.5/6.25 and Sonnet's cache read is
  0.2. Run spend comes from the SDK's total_cost_usd (runner/sdk_stream_parser.ts:545), so measured runs are
  not affected. Budget estimates in runner/budget.ts:65 do read the json. That is slice PRICE-01.

### 1.2 Per-stage tokens (the only per-stage measurement on disk)

Source: docs/v10/METRICS.md "S41-04 Per-stage token table" (E-98f, claude-opus-5-5, 7 medium pub-* tasks,
raw files ~/loki-ci-logs/eval/e98f-engine/*/result-cost*.json). Mean per session, priced with 1.1:

| stage | n | cache_read | cache_write | output | Sonnet $ | Opus $ |
|---|---|---|---|---|---|---|
| intake already-done | 18 | 46,305 | 8,742 | 590 | 0.032 | 0.065 |
| plan | 36 | 44,547 | 8,784 | 2,038 | 0.047 | 0.094 |
| wall | 16 | 67,611 | 14,512 | 5,530 | 0.098 | 0.197 |
| implement mean | 58 | 982,144 | 33,750 | 10,893 | 0.292 | 0.583 |
| implement p50 | | 654,959 | | | 0.259 | 0.518 |
| fix round 1 | 10 | 116,340 | 10,765 | 2,256 | 0.061 | 0.122 |
| fix round 2 | 4 | 78,512 | 6,691 | 2,463 | 0.049 | 0.098 |

- Input tokens are under 60 per session, so they are negligible.
- Cache reads are 94.5% of all tokens.
- Time share: implement 72.5%, wall 23%. Wall hit its 90s limit in 9 of 21 runs.
- Implement plus wall are about 74% of a medium run's dollars: (0.292 + 0.098) / 0.530 at Sonnet prices.

### 1.3 Lead-supplied totals (CH-M1 re-measures them per stage through scripts/real-run.sh)

- Trivial fixture: $0.09 to $0.11 across 4 cold sessions (project-model, intake, wall, implement). Intake takes 12 to 20s.
- Router on: +27% to +44%, with 0 advisor calls.
- FireLater#17: raw $0.40 vs Loki $1.73. The fixture receipt
  (loki-ts/tests/fixtures/pr-body-firelater17/receipt.json) carries totals only.
- Project-model per-stage cost is NOT on disk. It stays unmeasured until CH-M1.

### 1.4 Root causes, traced to code

1. Effort. Implement, fix and wall run tier "development", which maps to effort high
   (providers/claude_flags.ts:24, applied at runner/providers.ts:649). No engine10 stage sets opts.effort.
   Raw runs Opus 5.5 at medium. Per unit of work, implement costs about 1.4x raw on the same model (PAPERS.md 1.2).
2. Session graph. Four cold sessions on a normal task, each a separate process
   (engine10/session.ts createSessionRunner). Each pays a first-turn prefix write of about 8.7K tokens
   ($0.022 at Sonnet) and re-reads the files it needs. Resume exists only for fix and defaults off
   (runner/session_resume.ts:38).
3. The prefix is not shared even on one model. resolveSystemPrompt (providers.ts:680) sends the claude_code
   preset with dynamic cwd and git sections, and wall runs in a mkdtemp cwd. LOKI_E10_PREFIX=lean
   (providers.ts:624) defaults off. tests/e10ext/prefix_identity.test.ts guards only the first 200 bytes of
   the brief, never system plus tools.
4. The critical path is serial. Implement waits for wall (machine.ts:12-13 FLOW), and wall writes into
   repoDir and base-runs there (wall.ts:195-203).
5. Router overhead. planRouterSession (providers.ts:359) attaches the advisor to every engine10 session,
   plan is pinned to Opus (router/plan_route.ts), and FC-35 keeps plan on small tasks.
6. Implement's cache_read grows with turns times context size. There is no observation masking and no
   budget stop before the 480s limit.

## 2. Common Wall checks (every slice, in addition to its own)

- W-FLAG: every behavior change ships behind a flag that defaults off. With the flag off, all engine10
  goldens are byte-identical (router_optout_golden, never_below_raw, receipt goldens). A B9 row decides the
  default-on flip, which is a one-line follow-up slice.
- W-MOAT: bash tests/moat/run.sh is green, and `git diff --stat main -- tests/moat` is empty (P1 portable
  proof, P2 honest verdict, P3 the Wall, P9 Rule of Two).
- W-B9: B9 raw vs Loki, n>=3, on scripts/b9-scoreboard.sh with the raw arm (eng-b9-raw-arm) and
  scripts/real-run.sh on trivial-sum (eng-real-run). One lever per arm. Report usd per solved, solve rate
  with CI, p50/p90 wall, p90 usd, and cache_read/cache_creation.
- W-ACCEPT: acceptance test first (red), then the change (green), plus one mutation that turns it red.
- W-BUILD: tsc clean, dist rebuilt in the main checkout, test-release-dist-guard passes. No emojis, em dashes or en dashes.

## 3. Slices in CTO order

Each slice has an exclusive FILES set. DEPENDS means it merges after another slice, and a shared file is
sequenced, never concurrent. Full 60-line cards for ER-01, WC-01a and WC-01b were sent to team-lead
2026-10-08 and are restated in short form here.

### Wave 1 (staff now; disjoint files)

**ER-01 EFFORT-RIGHTSIZE (rank 1). START FIRST. Target 11.3.2.**
- FILES:
  - loki-ts/src/engine10/effort_policy.ts (new, pure)
  - loki-ts/src/engine10/session.ts (childEnv effort precedence and a per-session `effort` in recordCost)
  - loki-ts/src/engine10/stages/fix.ts (pass fixEffort)
  - loki-ts/tests/engine10/effort_policy.test.ts (new)
  - dist
- Change: under LOKI_E10_EFFORT_POLICY=rerun:
  - implement and wall run at medium;
  - fix round 1 runs at high;
  - fix round 2+ runs at xhigh only when the failure is code-owned (testFailures.length > 0, the same signal as
    router/unit_model.ts:47), otherwise high.
  - Precedence: the user's LOKI_E10_EFFORT, then opts.effort, then the policy. This fixes session.ts:56, which
    would otherwise beat a user override.
- Accept:
  - the stage matrix on child envs;
  - a user LOKI_E10_EFFORT=low wins everywhere;
  - with the flag off, no env gains LOKI_E10_EFFORT;
  - mutation: forcing high turns the test red.
- B9 pass: solve rate within CI and usd per solved down at least 20%.
- Tier MEDIUM, 25 min.
- Expected 20 to 25% on medium runs. Basis: medium effort is about 70% of high's cost on the same model
  (PAPERS.md B6), applied to the 74% implement plus wall share (1.2).

**WC-01a WALL-CONCURRENT part a (rank 6). START FIRST. Pure refactor.**
- FILES: loki-ts/src/engine10/stages/wall.ts, loki-ts/tests/engine10/wall_split.test.ts (new), dist.
- Change: split wallStage into wallAuthor() and installWall(ctx, authored, baseDir).
  - wallAuthor() is the session plus the compile check, and writes only to runDir/wall/sealed.
  - installWall() copies the tests in, runs the base run in baseDir, drops not_run tests, and returns
    readOnlyFiles, base_run and alreadySatisfied.
  - wallStage = author, then install(repoDir), so outputs are identical to today.
- Accept:
  - outputs deep-equal before and after the split;
  - wallAuthor leaves repoDir clean;
  - the existing wall, fc23 and E-54 tests pass unchanged.
- Tier HIGH (moat file), 30 min.
- Saving: none alone. It enables WC-01b.

**CP-01 CACHE-PREFIX (rank 7). Was CH-01. Lever 6 for the 11.3.2 cut.**
- FILES:
  - loki-ts/src/runner/providers.ts (only the engine10 block near lines 616-630 and resolveSystemPrompt near 674-690)
  - loki-ts/src/features/lean_prefix.ts
  - loki-ts/tests/e10ext/system_prefix_identity.test.ts (new)
  - dist
- Change: under LOKI_E10_STABLE_PREFIX=1, engine10 sessions send
  `{type:"preset", preset:"claude_code", excludeDynamicSections:true}`. This option is in the pinned sdk.d.ts
  and moves cwd, git and memory into the first user message. No run id, timestamp, path, branch or stage name
  goes in system or tools.
- Accept:
  - JSON.stringify(systemPrompt) and allowedTools are identical for intake, project-model, plan,
    wall (mkdtemp cwd), implement and fix, across two fake runs with different cwd, branch and clock;
  - mutation: injecting the date or cwd turns it red;
  - live trivial fixture: sessions 2..N have first-turn cache_creation under 2,000 tokens (today about 8,700).
- B9 pass: trivial-sum usd per run down at least 10%.
- Tier MEDIUM, 30 min.
- Expected $0.017 per extra Sonnet session ($0.034 Opus), 15 to 25% on trivial, under 5% on medium.
  Basis: E-65 prefix of 7,136 tokens x (2.50 - 0.10) / 1e6.
- Moat: the shared static prefix is content-addressed. It carries no Wall content and no shared conversation.

**CH-M1 per-stage cost and cache table (measurement; every W-B9 check uses it)**
- FILES: scripts/cost-stage-table.sh (new), tests/test-cost-stage-table.sh (new, registered in the runner and
  shard table, with timeout -k, shellcheck clean).
- Change: reads a run's cost events and prints, per stage: n, tokens, effort, model, dollars at the 1.1
  prices, and cache_hit_ratio.
- Tier LOW, 20 min.

### Wave 2

**WC-01b WALL-CONCURRENT part b (rank 6). DEPENDS WC-01a.**
- FILES: loki-ts/src/engine10/machine.ts, loki-ts/tests/engine10/wall_concurrent.test.ts (new), dist.
- Change: under LOKI_E10_WALL_CONCURRENT=1, the flow is intake, then [(plan if run) -> implement] alongside
  wallAuthor, then installWall, then verify.
  - The base run uses a detached worktree at baseSha (the verify.ts:184 mechanism) with node_modules and .venv
    symlinked from repoDir. A no-deps worktree would turn every Wall test into not_run, and not_run tests get dropped.
  - If implement touched a manifest or lockfile, base_run records deps:"head" and seal notes it.
  - An abort before install installs nothing (E-54).
- Accept:
  - implement starts before wallAuthor ends;
  - implement's tree contains no sealed path while it runs;
  - install happens once, before verify;
  - with the flag off, outputs are byte-identical.
- Explicit loss: implement no longer gets the Wall tests as read-only targets (implement.ts:29 reads an
  empty prior.wall), and Wall's already_satisfied exit moves after implement. B9 must report implement's
  first-pass rate.
- Tier HIGH, 30 min, unanimous opus review plus CTO sign-off.
- Expected latency down 20 to 45s per run; cost flat. B9 pass: p50 down at least 20s, solve within CI.

**LD-01 LEAN-DEFAULT plus the routing call (rank 2; CTO amendment D93, absorbs old CH-10). DEPENDS CP-01 (cache-stable prefix) and ER-01 (session.ts).**
- One plan gate, two inputs (reconciles the routing call with the LOKI_NEED_PLAN marker):
  - Under LOKI_ROUTER=1, Opus ALWAYS makes the routing decision, as one short structured-output call:
    - cache-stable prefix (CP-01) and effort low;
    - SDK `outputFormat: {type:"json_schema"}` with the schema
      `{size: "trivial"|"small"|"medium"|"large", units: [...], needs_full_plan: boolean}`;
    - measured target cost under $0.01.
    The full Opus PLAN session runs only when needs_full_plan is true. Trivial and small tasks go straight to
    the routed executor on the lean path.
  - The LOKI_NEED_PLAN marker is no longer a separate trigger. It becomes a second INPUT to the same gate:
    - implement's first turn can raise the gate from false to true (plan runs once, then implement resumes);
    - nothing lowers it from true to false.
    - With the router off (LOKI_E10_PLAN=on_request), there is no routing call, and the gate's inputs are the
      marker and the Project Model's "spans more than one context" fact.
  - The gate records why the plan ran or was skipped as one of: `route_call`, `marker`, `project_model` or
    `skipped`, in route.json and the receipt.
  - FC-35 R-B is unchanged: with the router on, route.json is ALWAYS written (a route, or routed:false with the
    reason). A failed, timed-out or malformed routing call records routed:false with the reason and runs the
    full plan, so the fail-safe always leans toward more planning, never less.
- LD-01 FILES (gate plus routing call):
  - loki-ts/src/engine10/plan_gate.ts (new, pure: the gate over route_call, marker and project_model inputs, plus
    the marker parse beside LOKI_ALREADY_DONE)
  - loki-ts/src/engine10/stages/plan.ts (routing call; the full plan only when the gate is true)
  - loki-ts/src/runner/router/plan_route.ts (pinOpus applies to the routing call)
  - loki-ts/src/runner/router/route_record.ts (size, units, needs_full_plan, plan reason, call cost)
  - loki-ts/src/engine10/sizing.ts (the lean path is no longer small-only)
  - loki-ts/tests/engine10/plan_gate.test.ts (new)
  - dist
- LD-02 FILES (the marker as a late input): stages/implement.ts (brief text describing the marker),
  engine10/machine.ts (plan-then-resume branch), loki-ts/tests/engine10/plan_on_request.test.ts (new).
  DEPENDS LD-01, CP-01 and WC-01b (machine.ts).
- Accept LD-01 (red first):
  - with the router on, a fake routing call returning needs_full_plan:false runs no plan session and still
    writes route.json with size, units and reason `skipped`;
  - needs_full_plan:true runs the full plan once, with reason `route_call`;
  - a malformed or failed call records routed:false plus the reason and runs the full plan;
  - route_record_agreement.test.ts (FC-35 fixture) stays green;
  - with the router off and the flags off, outputs are byte-identical (router_optout_golden);
  - mutation: skipping the route.json write when needs_full_plan is false turns the test red.
- Accept LD-02:
  - a fake implement with no marker runs no plan;
  - with the marker, plan runs once and implement resumes with it, with reason `marker`;
  - the marker can never cancel a plan the routing call requested.
- Wall never skips: wall, verify, commit, seal and pr are never skippable, and that is asserted in
  plan_gate.test.ts.
- Wall checks: the common set in section 2, plus:
  - the B9 row on trivial-sum shows the routing call's cost below 10% of the run's total cost (n>=3, read
    from the call's cost event via CH-M1);
  - router-on cost at most 1.05x router-off on trivial-sum (D89 Amendment 2);
  - B9 medium: solve rate within CI, usd per solved down at least 25%.
- Tier HIGH (FC-35 behavior, flow next to seal), 30 min per part. Reviewers: unanimous opus.
- Expected: 25 to 45% overall.
  - Basis: lean arm $0.16 vs default $0.39 on small (measured). Medium is unmeasured.
  - Under the router, the Opus plan session on small tasks (about $0.094 at S41-04 mean tokens, table 1.2)
    becomes a call under $0.01, which removes most of the measured +27% to +44% router overhead.

**PRICE-01: MERGED INTO PRICE-TRUTH.** eng-price-truth owns loki-ts/data/model-pricing.json under PRICE-TRUTH
(the 1.1 drift: Opus 4/20/0.20/5, Sonnet cache read 0.10). No separate COST-HALF slice.

### Wave 3

**CS-01 CASCADE (rank 3). DEPENDS ER-01.**
- FILES:
  - loki-ts/src/runner/router/decision.ts
  - loki-ts/src/runner/router/unit_model.ts
  - loki-ts/src/engine10/sizing.ts (cascadeImplementModel; after LD-01)
  - loki-ts/tests/engine10/never_below_raw.test.ts (allowlist)
  - loki-ts/tests/engine10/cascade_ladder.test.ts (new)
- Change: under LOKI_E10_CASCADE_LADDER=1, implement starts on Sonnet 5.5 at medium. A code-owned FAIL after
  fix round 1 escalates the next round to Opus 5.5 at high. Harness, env and lint failures never climb (L5).
- Accept: a Sonnet implement whose verify fails twice on tests produces exactly one Opus fix session, and the
  receipt points to the escalation evidence.
- B9 pass for the half-cost claim: usd per solved at most 0.5x raw, with solve rate not below raw's lower CI bound.
- Tier HIGH (Engine Law L1 never-below-raw), 30 min.
- Expected 0.4x to 0.7x raw per solved on tasks Sonnet solves first time. The hard tail costs more.

**HB-01, HB-02, HB-03 HAIKU-BOUNDED (rank 4). One stage per slice. Each is checked by execution.**
- HB-01: the Project Model session on Haiku. FILES: loki-ts/src/project_model/discover.ts plus a test.
  - Check: the discovered test command must run on the base tree.
- HB-02: already-done on Haiku. FILES: loki-ts/src/engine10/already_done.ts plus a test.
  - Check: it must cite files, and verify confirms (advisory only, never a verdict).
- HB-03: the Wall author on Haiku. FILES: sizing.ts wallModel (after CS-01) plus a test.
  - Check: a Wall with zero F2P tests retries once on Sonnet. Wall F2P rate is reported and must not be lower
    than the Sonnet Wall's. Depends on F2P-01.
- All three: prompts stay under 100K (autoCompactWindow), and a prompt over 100K routes to Sonnet to avoid the
  5x tier. Flag LOKI_E10_AUX_MODEL=haiku. Each model pin is added to the never_below_raw allowlist.
- Tier: HB-01 and HB-02 MEDIUM; HB-03 HIGH (Wall quality). 25 to 30 min each.
- Expected: these stages drop to about 1/20th of Sonnet price, 10 to 25% of run cost overall.

**F2P-01 F2P-GATE (rank 5). Pairs with T2. DEPENDS WC-01a.**
- FILES:
  - loki-ts/src/engine10/stages/wall.ts (classify F2P vs P2P in installWall)
  - loki-ts/src/engine10/stages/verify.ts
  - loki-ts/src/engine10/stages/seal.ts (wall.f2p, wall.p2p)
  - loki-ts/src/engine10/pr_body.ts
  - tests
- Change: a Wall test is proof only if it fails on the base tree. Zero F2P tests seals NOT PROVEN for the
  change, not FAIL.
- Accept: a fixture with one F2P and one P2P test gives f2p=1, p2p=1; deleting the fix flips verify to FAIL;
  P2P-only seals NOT PROVEN.
- Tier HIGH (Seal), 30 min; split verify and seal into F2P-02 if it goes over budget.
- No cost change. Receipt precision goes up, and the accuracy-vs-raw claim rests on it.

**BS-01 BUDGET-STOP (rank 8). DEPENDS ER-01 (fix.ts).**
- FILES: loki-ts/src/runner/budget.ts, loki-ts/src/engine10/no_progress.ts (new), tests.
- Change: implement and fix sessions get a dollar budget from the run cap (maxBudgetUsd is already plumbed) and a
  no-progress stop (no file change and no test run for N turns). The stop is classified and escalates once
  through CS-01.
- Tier MEDIUM, 30 min.
- B9 pass: p90 usd down at least 30%, solve within CI. Expected mean down 10 to 20%.

**AS-01 ADVISOR-ONLY-SONNET (rank 9). Was CH-02. Stage scoping BUILT as 7cce4ae85 (branch slice-CH-02).**
- What is built:
  - under LOKI_ROUTER=1, engine10/session.ts childEnv sets LOKI_ADVISOR_SCOPE=off on every stage except plan and
    fix;
  - router/advisor_probe.ts treats that as unavailable, so the executor stays Sonnet;
  - test: tests/engine10/advisor_scope.test.ts.
  - The router ships OFF, so the effect is default-off.
  - It touches session.ts, so ER-01 rebases on it.
- Remaining (AS-02, measure first):
  - never attach the advisor to an Opus executor (route decision unit test);
  - default stays off until B9 arm 4 vs arm 2 shows router-on cost <= 1.05x router-off with solve at least equal
    (D89).
  - Once LD-01 lands, the plan stage's advisor applies to the full plan only, never to the routing call.
  - FILES: loki-ts/src/runner/router/session_route.ts plus a test. Tier MEDIUM, 25 min.
- Expected: removes about 1,000 advisor-definition tokens per request on unmarked sessions (PAPERS.md 1.1).

### Backlog, in order

1. **OBS-MASKING** (rank 10): clear old tool results past a token threshold in implement and fix.
   FILES: providers.ts SDK settings (after CP-01). Expected 20 to 40% on long runs only.
2. **MODEL-SEEDED-REPOMAP** (rank 11; absorbs old CH-07 context diet and CH-06 prefetch):
   - FILES: engine10/repomap.ts, engine10/relevant_files.ts.
   - The model names seeds, and the harness returns top-k signatures by personalized PageRank within a token
     budget.
   - Prefetched facts never include Wall source or Wall base-run output.
3. **SECOND-CANDIDATE-AFTER-FAIL** (rank 12): after fix round 1 fails, a fresh candidate is selected by F2P pass
   count. FILES: runner/attempts.ts, stages/fix.ts. Accuracy lever on the hard tail.

Support slices that stay in the queue: WARM-FIX (old CH-03, LOKI_E10_FIX_RESUME on by default, after ER-01
releases fix.ts), CACHE-TTL (old CH-04, promptCacheTtl 5m, after CP-01), and B9-RATIO (old CH-14, usd per
verified ratio row in scripts/b9-scoreboard.sh, prints MISS above 0.5).

Superseded: old CH-10 (FC-35 Opus plan, now the D93 routing call) and CH-12 (L0 stage declaration) are folded into LD-01. Old CH-11
(stagger wall behind plan) is replaced by WC-01b. Old CH-08 (100K ceiling) is folded into HB-*. Old CH-09
(one intake session) is folded into HB-01 and HB-02.

## 4. Order for the 11.3.2 cut (about 05:50Z)

- Staff now: ER-01, WC-01a, CP-01, CH-M1. No two of them share a file.
- In the cut: ER-01 and CP-01 merged flag-off. WC-01a merged (no behavior change).
- Flag flips only on a passing B9 row (n>=3).
- WC-01b is HIGH with a 60-minute reviewer budget, so it is realistic for the next cut, flag-off.

## 5. Research basis

PAPERS.md ranks 1 to 12 map one-to-one to the slices above. The sources and the B9 protocol are in that file,
sections 4 and 6. Section 5 of that file (the multiplicative stack, medium issue, raw $0.40) is the basis for the
0.6x to 0.8x medium target in section 0.
