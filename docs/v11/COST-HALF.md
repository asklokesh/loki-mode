# COST-HALF: Loki dollars per verified task at most 0.5x raw claude -p (D91 item 11)

Status: design, Architect draft 2026-10-08. Not committed. Owner of slicing: Architect (cost-half).
Target: on B9, same model family, same task, `loki_cost_per_verified / raw_cost_per_verified <= 0.5`.
Moat order holds: Seal accuracy and Wall integrity outrank every saving below. No slice lets the
implementer see, read earlier, or edit the Wall checks, and no slice skips wall, verify or seal.

## 1. Where the money goes today (measured)

### 1.1 Per-stage tokens (the only per-stage measurement on disk)

Source: docs/v10/METRICS.md "S41-04 Per-stage token table" (E-98f, claude-opus-5-5, 7 medium pub-* tasks,
raw files ~/loki-ci-logs/eval/e98f-engine/*/result-cost*.json). Means per session.

| stage | n | input | cache_read | cache_write | output |
|---|---|---|---|---|---|
| intake already-done confirm | 18 | 6 | 46,305 | 8,742 | 590 |
| plan | 36 | 10 | 44,547 | 8,784 | 2,038 |
| wall | 16 | 7 | 67,611 | 14,512 | 5,530 |
| implement | 58 | 51 | 982,144 (p50 654,959) | 33,750 | 10,893 |
| fix round 1 | 10 | 13 | 116,340 | 10,765 | 2,256 |
| fix round 2 | 4 | 10 | 78,512 | 6,691 | 2,463 |

Cache-read share of all tokens: 94.5%. Time share: implement 72.5%, wall 23% (wall hit its 90s limit 9/21).

### 1.2 Same tokens priced (loki-ts/data/model-pricing.json, $/MTok in/out/cache_read/cache_write)

Sonnet 2/10/0.2/2.5. Opus 5/25/0.5/6.25. Haiku 0.1/0.5/0.01/0.125 up to 100K, 5x above 100K.

| stage | sonnet $ | of which cache_write | of which output | opus $ |
|---|---|---|---|---|
| intake already-done | 0.037 | 0.022 | 0.006 | 0.093 |
| plan | 0.051 | 0.022 | 0.020 | 0.128 |
| wall | 0.105 | 0.036 | 0.055 | 0.263 |
| implement (mean) | 0.390 | 0.084 (cache_read 0.196) | 0.109 | 0.975 |
| implement (p50) | 0.285 | | | 0.713 |
| fix round 1 | 0.073 | 0.027 | 0.023 | 0.182 |

### 1.3 Lead-supplied totals (to be re-measured per stage by CH-05 through scripts/real-run.sh)

- Trivial fixture: $0.09 to $0.11 across 4 cold sessions (project-model, intake, wall, implement); intake 12 to 20s.
- Router on (LOKI_ROUTER=1): +27% to +44%, with 0 advisor calls.
- FireLater#17: raw $0.40 vs Loki $1.73 (4.3x). Fixture receipt loki-ts/tests/fixtures/pr-body-firelater17/receipt.json
  carries totals only: $2.66, 6 sessions, 48,161 output tokens.
- Project-model discovery cost per stage: NOT on disk. Unmeasured until CH-05 lands.

### 1.4 Root causes (each traced to code)

1. Every session is cold and writes its own prefix. Each stage is a separate OS process
   (engine10/session.ts createSessionRunner); resume exists only for fix and defaults off
   (runner/session_resume.ts:38, LOKI_E10_FIX_RESUME). The first-turn cache write is about 8.7K tokens per
   session (table 1.1). Four cold sonnet sessions pay about 4 x $0.022 = $0.087, roughly the whole trivial cost.
2. The prefix cannot be shared across sessions even on one model. resolveSystemPrompt
   (runner/providers.ts:680) sends the claude_code preset, whose dynamic sections (cwd, git status, memory)
   differ per stage: wall runs in a mkdtemp cwd, the branch differs, and LOKI_E10_PREFIX=lean (the static
   option, providers.ts:624) defaults off. tests/e10ext/prefix_identity.test.ts guards only the first 200
   bytes of the BRIEF, never system plus tools, which is what the cache key starts with.
3. Plan and wall start in parallel (engine10/machine.ts FLOW), so neither can read the other's cache write.
4. Stages run on different models (plan fast tier, wall wallModel sonnet pin, implement development tier,
   plan pinned to Opus under the router by runner/router/plan_route.ts pinOpus). The cache is per model.
5. Router overhead: planRouterSession (providers.ts:359) attaches advisor settings to EVERY engine10
   session (tool defs plus a distinct cache key), plan is pinned to Opus, and FC-35 keeps plan running on small
   tasks. Priced from 1.2, plan alone moves $0.051 to $0.128 (+$0.077) on a medium task.
6. Implement cache_read dominates (0.196 of 0.390). It scales with turns x context size. Turns are spent
   re-discovering facts the harness already computed (repomap, test command, failing output).
7. Subscription runs default to a 1h cache TTL; 1h writes bill at 2x input instead of 1.25x. Short runs
   pay the long-TTL premium for nothing (SDK option promptCacheTtl, env CLAUDE_CODE_PROMPT_CACHE_TTL).

### 1.5 Savings budget (sonnet, trivial fixture, $0.10 baseline)

| lever | slices | expected | basis |
|---|---|---|---|
| 6 cache hygiene | CH-01, CH-04, CH-11 | -0.035 to -0.050 | 3 of 4 sessions read 7,136 prefix tokens (E-65) instead of writing: 7,136 x (2.5 - 0.2)/1e6 = $0.0164 each |
| 4 advisor scope | CH-02, CH-10 | router-on back to <= 1.05x router-off | removes advisor defs on unmarked stages and the Opus plan on small tasks |
| 1 warm session | CH-03, CH-09 | -0.010 to -0.025 | one fewer cold session (already-done folded) plus resumed fix rounds |
| 7 prefetch | CH-06 | -10% to -25% implement | fewer discovery turns on a 0.196 cache_read line |
| 5 context diet | CH-07, CH-08 | -10% implement, avoids the Haiku 5x cliff | caps repomap and pack, request ceiling 100K |
| 2 L0 skipping | CH-12 | -0.03 to -0.09 per skipped optional session | plan declares optional stages; wall, verify, seal never skip |
| 3 per-unit Haiku | CH-13 | up to -90% on assigned units | Haiku 0.1/0.5 vs sonnet 2/10 under 100K |

Measured, not assumed: every slice reports its delta with CH-05 on the trivial fixture (n>=3) and on
B9 (scripts/b9-scoreboard.sh with the raw arm from eng-b9-raw-arm). An unmeasured saving is a hypothesis.

## 2. Common Wall checks (every slice, in addition to its own)

- W-GOLD: tests/engine10/router_optout_golden.test.ts and every existing engine10 golden byte-identical.
- W-MOAT: `bash tests/moat/run.sh` green with P1 (portable proof), P2 (honest verdict), P3 (the Wall) and
  P9 (Rule of Two) files untouched (`git diff --stat main -- tests/moat` empty).
- W-COST: cost delta measured with scripts/real-run.sh (eng-real-run) on the trivial fixture, n>=3, and the
  per-stage table from CH-05; B9 row for MEDIUM and HIGH slices once eng-b9-raw-arm lands.
- W-VERIFIED: verified-task rate on the same fixtures does not drop (a cheaper unverified task is a loss).
- W-TEXT: no emojis, em dashes or en dashes; red-then-green test in the slice.

## 3. Slices

Notation: FILES is the exclusive write set. DEPENDS means it merges after that slice (file reuse is
sequenced, never concurrent). START FIRST marks the three slices that open the 11.3.2 cut (about 05:50Z).

### CH-01 (START FIRST, lever 6) Byte-identical system prefix across stages and runs, with a guard
- Goal: every engine10 session on one model sends the same system prompt and tool block bytes, so session
  2..N reads the prefix from cache instead of writing it.
- FILES: loki-ts/src/runner/providers.ts (only the S41-09 engine10 block near line 616-630 and
  resolveSystemPrompt near 674-690), loki-ts/src/features/lean_prefix.ts,
  loki-ts/tests/e10ext/system_prefix_identity.test.ts (new), loki-ts/dist (rebuild).
- Change: for engine10 sessions, send
  `{type:"preset", preset:"claude_code", excludeDynamicSections:true}` (SDK option in the pinned sdk.d.ts;
  cwd, git status and memory move to the first user message). Keep LOKI_E10_PREFIX=lean as is. No run id,
  timestamp, cwd, branch or stage name in system or tools. Opt-out LOKI_E10_STABLE_PREFIX=0 restores today's
  expression byte for byte.
- Guard test: build the options for every stage (intake confirm, project-model, plan, wall with a mkdtemp cwd,
  implement, fix) across two fake runs with different cwd, branch and clock; assert
  JSON.stringify(systemPrompt) and the allowedTools list are identical; mutation: injecting `new Date()` or
  cwd into the prompt turns it red.
- Wall checks: common set; plus live: on the trivial fixture, sessions 2..N show first-turn
  cache_creation_input_tokens under 2,000 (today about 8,700) in the CH-05 table.
- Tier MEDIUM (cost path; moat files untouched; wall still sees only its temp dir). Budget 30 min.
- Expected saving: $0.035 to $0.050 on the $0.10 trivial fixture (35 to 50%); about $0.016 per extra sonnet
  session and $0.041 per extra opus session on medium tasks. Basis: E-65 prefix 7,136 tokens; write 2.5 vs read
  0.2 $/MTok.
- Moat note: a shared static prefix is content-addressed; it carries no Wall content and shares no
  conversation. Wall stays a separate session.

### CH-02 (START FIRST, lever 4) Advisor only on stages Opus marks
- Goal: with LOKI_ROUTER=1, advisor settings attach only to sessions the plan marks (plan itself and fix
  rounds by default, per D89 Amendment 2). Every other session gets the plain router-off options.
- FILES: loki-ts/src/engine10/session.ts (childEnv only: set LOKI_ADVISOR_SCOPE=off unless the stage is in
  the marked set), loki-ts/src/runner/router/advisor_probe.ts (probeAdvisor returns
  `{available:false, reason:"advisor not marked for this stage"}` on LOKI_ADVISOR_SCOPE=off),
  loki-ts/tests/engine10/advisor_scope.test.ts (new), loki-ts/dist (rebuild). Does NOT touch providers.ts.
- Marked set: plan, fix; extended by the plan output field `advisor_stages` once CH-12 lands. Unknown or
  absent means the default set. Wall is never marked (Rule of Two: no second model consults on Wall authorship).
- Change keeps the probe's fail-safe: an unmarked stage behaves exactly like advisor-unavailable, so the
  executor is Sonnet, never Haiku, as today.
- Wall checks: common set; R1-21 opt-out golden byte-identical with LOKI_ROUTER unset; test asserts the
  implement, wall, intake and project-model child envs carry LOKI_ADVISOR_SCOPE=off and plan and fix do not.
  D89 gate: router-on cost <= router-off x 1.05 on the trivial fixture, n>=3 (may need CH-10 to close fully).
- Tier MEDIUM (router behavior, no moat or verifier file). Budget 25 min.
- Expected saving: the advisor-def share of the +27% to +44% router overhead on every unmarked session
  (prefix bytes plus a separate cache key per session). Estimated 5 to 15 points of the overhead; the Opus plan
  pin is the larger share and belongs to CH-10. Basis: 0 advisor calls measured, so all advisor cost is
  overhead; split to be measured by CH-05.

### CH-03 (START FIRST, lever 1) Warm chain: implement and its fix rounds share one session by default
- Goal: fix rounds resume implement's session instead of cold-starting, and implement resumes plan's session
  when they run on the same model. Wall never joins any chain.
- FILES: loki-ts/src/runner/session_resume.ts (default on, LOKI_E10_FIX_RESUME=0 opts out),
  loki-ts/src/engine10/stages/implement.ts (pass plan's session id as resumeSessionId when plan model ==
  implement model and plan exited ok), loki-ts/tests/engine10/warm_chain.test.ts (new); update
  loki-ts/tests/engine10/fix_resume.test.ts expectations for the new default. loki-ts/dist (rebuild).
- Rules: same model only, else fresh (existing fallback). A resume failure falls back to a fresh session with
  the full brief (never a degraded brief). The chain is plan, implement, fix 1..n. Wall, verify and seal stay
  separate. Plan runs before wall output exists, so the chain never carries Wall content forward; the
  implement brief keeps naming Wall tests read-only exactly as today, and restoreReadOnly still runs.
- Wall checks: common set; test that wall's child env never has LOKI_E10_RESUME_SESSION; test that a model
  mismatch starts fresh; test that a resumed fix round still gets readOnlyFiles restored; P3 and P9 green.
- Tier MEDIUM (session lifecycle; the Wall isolation assertions make it reviewable at MEDIUM; escalate to HIGH
  if any change touches wall.ts or verify). Budget 30 min.
- Expected saving: fix round 1 cold write 10,765 tokens plus re-exploration (116K cache_read) replaced by a
  warm read of implement's context: $0.02 to $0.05 per fix round on sonnet; plan to implement removes one
  first-turn write ($0.022). Basis: table 1.1/1.2; MW-2 has no on-disk measurement, so CH-05 measures it.
- Risk: a long resumed context raises per-turn cache_read; the slice records first_turn_prompt_tokens and
  falls back to fresh above 100K (pairs with CH-08).

### CH-04 Cache TTL fit to run length (lever 6)
- FILES: loki-ts/src/runner/providers.ts (query options only). DEPENDS CH-01.
- Change: engine10 sessions set promptCacheTtl "5m" unless LOKI_E10_CACHE_TTL=1h. A run whose stages are
  more than 5 min apart (deep, long fix loops) keeps 1h.
- Wall checks: common set; test of the option per stage.
- Tier LOW. Budget 15 min. Expected: cache_write at 1.25x instead of 2x input on subscription runs, about
  -35% of the write line. Basis: SDK doc for promptCacheTtl. Measure; revert if hit rate drops.

### CH-05 Per-stage cost and cache table (measurement, unblocks every W-COST check)
- FILES: scripts/cost-stage-table.sh (new), tests/test-cost-stage-table.sh (new, registered in the runner and
  the shard table, timeout -k, shellcheck clean).
- Change: reads a run's cost events (session.ts recordCost: input, output, cache_read, cache_creation,
  first_turn_prompt_tokens) and prints stage, n, tokens, dollars from model-pricing.json, cache hit ratio.
  Used by scripts/real-run.sh and the B9 raw-vs-Loki comparison.
- Tier LOW. Budget 20 min. Saving: none directly; it turns every other row from estimate into measurement.
  Start in parallel with the first three if a seat is free.

### CH-06 Prefetch facts in the first message (lever 7)
- FILES: loki-ts/src/e10ext/context.ts (briefContext), loki-ts/src/e10ext/prefetch.ts (new),
  loki-ts/tests/e10ext/prefetch.test.ts (new). DEPENDS CH-03 (implement.ts).
- Change: one FACTS block after the stable blocks: Project Model test command, top-N repomap lines ranked
  by the plan's relevant files, and the failing output of PRE-EXISTING impacted tests from intake's testmap.
  The model decides what to use.
- Moat: never include Wall test source or Wall base-run output; the Wall tests stay named read-only and
  nothing more. Test asserts no path under the sealed set appears in FACTS.
- Tier MEDIUM (sits next to the Wall boundary). Budget 30 min. Expected: -10% to -25% implement cost via
  fewer discovery turns. Basis: implement cache_read is $0.196 of $0.390 and scales with turns.

### CH-07 Context diet: capped, relevance-ranked repomap and pack (lever 5)
- FILES: loki-ts/src/engine10/stages/intake.ts (repomap.json build only), loki-ts/src/engine10/repomap.ts,
  loki-ts/tests/engine10/repomap_cap.test.ts (new). DEPENDS CH-09 (intake.ts).
- Change: repomap capped by bytes (default 8K tokens), ranked by the plan's relevant files and testmap
  proximity. Wall keeps its own WALL_MAP_MAX_LINES=200 view, unchanged.
- Tier LOW. Budget 25 min. Expected: -5% to -10% of implement and plan input. Basis: briefContext already
  caps files at 20 and tests at 10; the repomap is the uncapped part.

### CH-08 Request ceiling at 100K (lever 5, protects lever 3)
- FILES: loki-ts/src/runner/router/session_route.ts, loki-ts/tests/runner/request_ceiling.test.ts (new).
- Change: Haiku-routed units get autoCompactWindow under 100K; any unit whose first_turn_prompt_tokens would
  exceed 100K routes to Sonnet instead of paying the Haiku 5x tier.
- Tier LOW. Budget 20 min. Expected: avoids a 5x price cliff on Haiku requests over 100K. Basis: model-pricing.json.

### CH-09 One intake session instead of two (lever 1)
- FILES: loki-ts/src/project_model/discover.ts, loki-ts/src/engine10/stages/intake.ts
  (checkAlreadyDone call site only), loki-ts/tests/engine10/intake_single_session.test.ts (new).
- Change: the Project Model discovery session also answers the already-done question (one structured output
  with both fields) when discovery is not cached; when discovery is cached, the confirm session runs alone as
  today. Already-done stays advisory to verify, never a verdict.
- Tier MEDIUM (already-done can short-circuit a run). Budget 30 min. Expected: one cold session removed,
  $0.022 write plus about $0.015 re-read on sonnet, and 5 to 10s of the 12 to 20s intake. Basis: table 1.2.

### CH-10 Opus plan only when the router needs it (lever 4, FC-35 revisit)
- FILES: loki-ts/src/runner/router/plan_route.ts, loki-ts/tests/engine10/plan_route_small.test.ts (new).
- Change: on small tasks under the router, plan runs on the implement model (Sonnet) or is skipped as with the
  router off; Opus plan stays for medium and large. Needs a CTO call because FC-35 recorded the opposite.
- Tier HIGH (reverses a recorded decision; CTO approves). Budget 30 min. Expected: +$0.077 per medium-task
  plan removed on small tasks, most of the +27% to +44% router overhead. Basis: table 1.2 plan sonnet vs opus.

### CH-11 Stagger wall behind plan's first turn so wall reads the shared prefix (lever 6)
- FILES: loki-ts/src/engine10/machine.ts (parallel plan+wall block only),
  loki-ts/tests/engine10/stagger_prefix.test.ts (new). DEPENDS CH-01.
- Change: wall starts when plan reports its first assistant turn (or after 5s), not at the same instant. Only
  useful when plan and wall share a model; otherwise no delay.
- Moat: wall's inputs (task.md, repomap.txt, wall_manifest.txt in a temp cwd) are unchanged; no content flows.
- Tier MEDIUM. Budget 20 min. Expected: one prefix write ($0.016 sonnet) per run for at most 5s of wall start.

### CH-12 Plan declares optional stages (lever 2, L0)
- FILES: loki-ts/src/engine10/stages/plan.ts (buildPlanBrief output schema), loki-ts/src/engine10/stage_skip.ts
  (new pure policy), loki-ts/tests/engine10/stage_skip.test.ts (new).
- Change: plan output lists `stages_needed` and `advisor_stages`. Skippable: already-done confirm, deep,
  extra fix rounds beyond the first, advisor attachment. Never skippable, enforced in stage_skip.ts and tested:
  wall, verify, commit, seal, pr. Unknown or malformed output means run everything.
- Tier HIGH (flow control next to seal). Budget 30 min. Expected: $0.03 to $0.09 per skipped optional session.

### CH-13 Per-unit Haiku where Opus assigns it (lever 3, joins ROUTER-1 R1-10)
- FILES: whatever R1-10 owns; this slice adds only loki-ts/tests/engine10/haiku_unit_cost.test.ts and a CH-05
  table row. DEPENDS CH-08 and R1-10.
- Tier LOW. Budget 15 min. Expected: up to -90% on each Haiku unit under 100K. Basis: pricing 0.1/0.5 vs 2/10.

### CH-14 Cost-per-verified row on the B9 scoreboard (the target metric)
- FILES: scripts/b9-scoreboard.sh, tests/test-b9-scoreboard-cost.sh (new, registered). DEPENDS CH-05 and
  eng-b9-raw-arm.
- Change: prints loki $/verified, raw $/verified and the ratio; ratio > 0.5 prints MISS.
- Tier LOW. Budget 20 min.

### CH-15 Cache-hit ratio in the receipt cost block
- FILES: loki-ts/src/engine10/session.ts (recordCost only). DEPENDS CH-02 (session.ts).
- Change: each stage cost event adds cache_hit_ratio = cache_read / (cache_read + cache_write + input).
  Informational; never part of the Seal verdict.
- Tier LOW (P1 receipt shape: additive field; P1 suite must stay green). Budget 15 min.

## 4. Order for the 11.3.2 cut

Wave 1 (now, parallel, disjoint files): CH-01, CH-02, CH-03, plus CH-05 if a seat is free.
Wave 2 after merge: CH-04 (after CH-01), CH-06 (after CH-03), CH-09, CH-08, CH-11 (after CH-01), CH-15 (after CH-02).
Wave 3: CH-07 (after CH-09), CH-10 (CTO), CH-12 (HIGH), CH-13, CH-14.

## 5. Research fold-in (reserved)

research/2026-10-08-cost-half/PAPERS.md is pending. When it lands, the Architect maps each paper to an
existing lever or opens CH-16 onward; no slice above waits on it.
