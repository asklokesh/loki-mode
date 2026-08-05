# RARV-C Loop-Efficiency Upgrade Plan (ultracode phase)

> SUPERSEDED by `docs/RARV-C-100X-PLAN.md` (v8.0.0 arc, 2026-07-13). Kept as history.
> Anchors here are grounded to v7.121.5 and have DRIFTED; use the 100X plan for current
> file:line and for the native-primitives-already-adopted findings.


Architect: synthesis of the six cookbook pattern sets against the current
Loki RARV-C loop. This is a PLAN, not code. Every proposed change carries a
constraint bucket and a bench-gate. No benchmark numbers are asserted here --
the harness (Deliverable #1) produces them.

Grounded against v7.121.5 source. Line numbers drift; re-verify with grep
before editing.

---

## 0. The one-line thesis

The competitors' edge is INFRASTRUCTURE, not loop rigor. Our proof /
never-fake-green RARV-C is the moat. So this plan optimizes the loop's
EFFICIENCY (cost, wall-clock, iterations-to-completion) and NEVER trades away
verification rigor. The lever that proves it is a bench that measures the
moat's OUTPUT (verified pass rate, from a deterministic grader) independently
of the loop's own self-assessment.

---

## 1. The gap split

### 1a. Already-scoped INFRASTRUCTURE (NOT this plan's target)

Yesterday's competitor research (reuse, do not re-run) found the
Replit/Emergent/Bolt advantage is mostly infrastructure: per-build sandbox
isolation, snapshot/checkpoint, warm pools, fast provisioning. That work is
already scoped as #2b / #8b / #10 in
`autonomi-saas/docs/NEXT-AFTER-2026-07-08.md`.

The entire `sandboxes-production` cookbook maps 1:1 onto that scoped k8s work.
Treat it as a reference implementation, do NOT re-derive it, and do NOT rank
it here:

| Cookbook technique | Already-scoped item |
|---|---|
| Pod-per-session = blast radius | Per-build isolation (#2b) |
| Per-session volume + SessionStore mirror (local-first, async, non-fatal) | Snapshot/resume, durability C->A (#10) |
| Lease + heartbeat + reclaim-on-lapse | dead-run-holds-worker (#14) |
| Idempotent get-or-create keyed on session id | (implicit in per-build spawn) |
| Standby warm pool, egress NetworkPolicy, gateway auth, OTel | k8s tier-3 infra |

Their loops are NOT more rigorous (Replit ships zero tests). We are ahead on
verification. Do not re-architect that lead.

Three `sandboxes-production` techniques are net-new for Loki but are
SAFETY/HEALING, not cost/speed/iterations, so they are explicitly OUT of this
plan's ranked list (name them, do not smuggle them in):
- Two-phase investigate(read-only) -> remediate(write) split for
  self-heal-from-logs.
- Narrow-scoped write tools + `PreToolUse` content-validation hooks
  (block-and-let-agent-adapt).
- archive-vs-delete + optimistic-concurrency version check on state updates.

### 1b. LOOP EFFICIENCY (THIS plan's target)

Cost, wall-clock, iterations-to-completion, at constant verified-pass-rate.
The `managed-agents`, `agent-patterns`, and `evals-observability` cookbooks
target this. Techniques: evaluator-optimizer to converge in fewer passes,
outcome-grader discipline to stop early when genuinely done, cheaper model
routing, root-cause-clustered parallel fix-loops, plan-big-execute-small
coordinator economics.

**Honest caveat up front (ponytail rung 2 -- reuse what exists):** the biggest
iterations-win is LARGELY ALREADY SHIPPED. The framework already has
explicit-completion-claim, tunable `COUNCIL_CHECK_INTERVAL`, the tier-aware
`_council_effective_min_iter` floor (v7.105), and the
`COUNCIL_STAGNATION_LIMIT` circuit breaker. The cookbook's outcome-grader and
evaluator-optimizer patterns ARE, structurally, the completion council plus
findings-injection we already run. So most items below are "TUNE an existing
knob and let the bench prove the setting," NOT "build a new grader." Proposing
to build what exists would itself be a fabrication.

---

## 2. Deliverable #1: the metric harness (BUILD THIS FIRST)

We cannot claim "least cost / fewer iterations" without measured before/after.
Founder rule: measurable before/after every commit; an unmeasured claim is a
fabrication under anti-fake-green. So the harness ships before any loop change.

### 2a. Reuse, do not rebuild (the lazy path is the correct path)

Verified against source: the harness is ~95% already built.

- `benchmarks/bench/` already has the frozen contract (`bench_schema.py`,
  `SCHEMA_VERSION = "1.0"`), a runner (`runner.py`), a deterministic grader
  (`success = exit==0`, held-out `acceptance.overlay` copied in AFTER the
  agent finishes), a loki adapter (`adapters/loki.py`), a price table
  (`prices.json`), and `loki bench` + `loki bench verify`.
- `bench_schema.py` ALREADY carries the fields we need: `iterations`
  (`setdefault("iterations", 0)`), `duration_s`, `cost_usd`, `tokens_in/out`,
  `cache_read_tokens`, `success` (grader-set).
- `adapters/loki.py` ALREADY reads iteration count from `.loki` state
  (`_read_iteration_count`, session.json/autonomy-state.json) and captures
  `duration_s`.
- The credibility invariant is ENFORCED in code: `validate_adapter_output()`
  REJECTS any adapter dict carrying `success/quality/passed/score/verdict`.
  Only the grader sets outcome. This is exactly the "grade the artifact, never
  the loop's self-assessment" rule -- already a code invariant, not a
  convention.
- `benchmarks/speed-benchmark.sh` ALREADY parses the target's
  `.loki/events.jsonl` for `act_iterations` and `wall_clock_s` from an
  ISOLATED source copy (never the worktree).

So Deliverable #1 is NOT a build. It is: lock a corpus, reconcile one metric
source, baseline, and wire the gate.

### 2b. The four target metrics -> where each comes from

| Metric | Source (already exists) |
|---|---|
| verified-pass-rate | grader `success = exit==0` on held-out acceptance -> `success_rate` = n_success/n_trials. NEVER council/`completion_claimed`. |
| $/build | `cost_usd` per task (adapter tokens x frozen `prices.json`); `cost_usd_per_solved` aggregate already in schema. |
| iterations-to-completion | `iterations` field, populated by `adapters/loki.py` `_read_iteration_count`. |
| wall-clock/build | `duration_s` (adapter wall-clock around the subprocess). |

### 2c. The genuine delta (small, concrete)

1. **Reconcile the iterations source (harden, do not duplicate).**
   `adapters/loki.py` reads `iteration` from `session.json`;
   `speed-benchmark.sh` parses `events.jsonl`. These CAN disagree. Pick ONE
   canonical source so both harnesses agree -- prefer the `events.jsonl`
   `iteration_complete` count (it is the real per-session timeline; session
   state can be mid-write). Make `adapters/loki.py` read events.jsonl with
   session.json as fallback. One parser, copied from
   `speed-benchmark.sh` lines ~119-179. Bucket (a).
2. **Confirm wall-clock coverage.** `duration_s` already exists; verify it is
   the full subprocess wall-clock, not per-iteration. If it is, no new field
   is needed and we avoid touching the frozen schema at all. If a distinct
   `wall_clock_s` is truly required, it is an ADDITIVE optional field
   (`setdefault`), but the schema header says "do not change without updating
   SCHEMA_VERSION and every slice" -- so treat any field add as a
   SCHEMA_VERSION bump + all-slice update. PREFER reusing `duration_s`.
3. **Lock the corpus.** 5-15 fixed specs under `benchmarks/bench/tasks/` (or
   a new `benchmarks/corpus/`), each with machine-checkable held-out
   acceptance (exit code / http status / file exists / regex). Dev on 2, run
   on all. `task_hash` (spec + acceptance + model, already computed) is the
   reproducibility anchor.
4. **Ship the 2-spec smoke sanity check:** one spec that MUST pass, one
   deliberately-underspecified that MUST fail; assert
   `verified_pass == [True, False]`. If the grader cannot tell those apart it
   measures nothing. This is the single runnable check the harness leaves
   behind.

### 2d. Reproducibility contract (frozen across every before/after)

- Corpus, grader (acceptance harness), and `prices.json` are FROZEN across a
  before/after pair. Changing any of them destroys comparability exactly like
  swapping a grader model would. Adding output fields is safe (`task_hash`
  covers spec+acceptance+model); changing the corpus is not.
- Every results file persists `loki_version` + `task_hash` + price-table hash
  so any past number is reproducible and its config travels with it
  (`benchmarks/results/<version>-<stamp>.json`, already the pattern).
- Baseline = N real off-worktree builds = real dollars and hours. Run from an
  isolated source copy with cwd AND `LOKI_TARGET_DIR` pinned to scratch, per
  the never-run-from-worktree rule. Per-build try/except + hard timeout: a
  crashed/hung build scores 0 (fail), never aborts the batch. Retry a build
  only on infra error (network/rate-limit), NEVER on a real failure.

### 2e. The gate rule (operationalizes anchors 1 + 3)

> A loop-efficiency change SHIPS iff it improves at least one of
> {iterations-to-completion, $/build, wall-clock} BEYOND THE BASELINE'S NOISE
> BAND AND does not regress verified-pass-rate, measured on the frozen corpus
> vs the committed baseline.

No change ships unless the bench moves the right way. That one rule is anchor
1 (optimize efficiency, never trade the proof-moat) and anchor 3
(bench-gated, no unmeasured claims) made mechanical.

### 2e-HARDENING (advisor 2026-07-08 - blocking; decided BEFORE any results)

Three holes that make an unhardened bench produce fake-green "wins":

1. **NOISE FLOOR (blocking).** Agentic builds are non-deterministic; iterations
   /$/wall-clock vary run-to-run. "Improves the right direction" with no variance
   threshold ships random noise as a win ~half the time. RULE: the baseline
   reports SPREAD (std dev or min-max across trials), not just means. A change
   ships only if its metric moves BEYOND the baseline's noise band (mean delta >
   baseline trial std, or non-overlapping min-max). If an effect is smaller than
   trial variance at N trials, either raise trials or report "no measurable
   effect" and DO NOT ship. The noise bar is decided now, not rationalized after.
2. **RECONCILE-METRICS-FIRST (blocking).** Fix the iterations source (2c.1 ->
   events.jsonl canonical) BEFORE baselining. Baselining on an ambiguous source
   (session.json vs events.jsonl disagree) corrupts every iterations before/after.
   This is a PREREQUISITE step, not parallel.
3. **CORPUS FROM DISCRIMINATORS (expensive to reverse - frozen at baseline).**
   Do NOT pick "5-15 representative specs." Derive the corpus BACKWARD from what
   each ranked change must discriminate:
   - Rank 2 (tier routing): MUST include HARD specs that must stay on the strong
     model without pass-rate regression, else the anchor-1 guard (cheap tier must
     not regress hard builds) is untestable and you ship a silent regression.
   - Rank 3 (parallel fix-loops): MUST include specs that produce MULTI-CLUSTER
     failures.
   - Rank 5 (distilled returns): MUST include TOKEN-HEAVY specs.
   Mix: simple + hard + multi-failure + token-heavy. Frozen once baselined (2d).

### 2f. Cost envelope + honesty pre-commit
- Envelope: ~5-10 specs x 3 trials x (1 baseline + ~7 ranked changes) ~= 120-240
  real builds = real dollars + hours. START SMALL: prove the full pipeline
  (baseline->one change->measure->gate) on a 3-spec corpus FIRST to validate the
  machinery mechanically, THEN build the real discriminator-derived corpus and
  baseline. Grow corpus only if variance demands it.
- HONESTY PRE-COMMIT: the plan already says most iteration wins are shipped;
  expect single-digit-% to maybe-2x from tuning, NOT 100x. Pre-commit to reporting
  the real number even if unimpressive, and to stating plainly: "the loop is
  near-optimal; the real 100x is the INFRA work (already scoped #2b/#10), not
  here." Do not let the measurement spend create pressure to dress up a small
  delta - that would be fake-green.

---

## 3. Ranked upgrade list

Ranked by (impact / effort), bucket-(a) first. Every item names its cookbook
pattern, expected effect, bucket, bench validation, and rough effort.

Bucket key:
- **(a)** ORCHESTRATION-LEVEL -- changeable now (run.sh model routing, council
  gating, iteration control constants, sub-invocation that does NOT feed the
  next prompt). No `build_prompt()` change.
- **(b)** NEEDS FOUNDER AUTHORIZATION -- requires unlocking `build_prompt()`
  (60-fixture byte-mirror parity lock).
- **(c)** NEEDS OFF-WORKTREE REAL-BUILD VALIDATION -- cannot be proven without
  real builds that must NOT run from the worktree.

Discriminator for (a) vs (b): *does the change alter `build_prompt()` output
text?* If it changes what text enters the next prompt (findings, rubric,
feedback), it is (b). If it only changes WHEN the council convenes, WHICH model
runs, or a sub-invocation whose output is not concatenated into the next
prompt, it is (a). Prompt-touching patterns are SPLIT into their (a) and (b)
halves below -- do not file a whole pattern under one bucket.

---

### Rank 1 -- Tune the completion-council convergence knobs

- **Pattern:** outcome-grader "stop early when genuinely done" +
  evaluator-optimizer "PASS gate stops the loop the moment criteria are met"
  (`managed-agents`, `agent-patterns`). We already HAVE the grader (the
  council). This item TUNES it, does not build it.
- **Concrete:** sweep `COUNCIL_CHECK_INTERVAL` (default 5,
  `completion-council.sh:84`), `_council_effective_min_iter`
  (`:3555`), and `COUNCIL_STAGNATION_LIMIT` (default 5, `:132`) on the corpus;
  pick the settings that cut iterations-to-completion without regressing
  verified-pass-rate. Also verify the explicit-completion-claim fast path
  (`:3601`) fires on the corpus (the v7.105 lever: a done-at-1 build should
  stop near iter 1, not grind to the next interval).
- **Effect:** fewer wasted idle iterations -> lower $/build + wall-clock.
  Largest iterations lever that is NOT already maxed.
- **Bucket:** (a). Constants + gating only; no prompt text.
- **Bench validation:** iterations + $/build must drop, verified-pass-rate
  flat. If pass-rate drops, the interval is too aggressive -- revert.
- **Effort:** LOW (constant sweep + bench runs). Cost is the real-build $.

### Rank 2 -- Model-tier routing by task complexity

- **Pattern:** Routing (`agent-patterns`) -- a cheap classifier routes easy
  inputs to the cheap model, hard ones to the strong model; plan-big-
  execute-small coordinator economics (`managed-agents`).
- **Concrete:** `LOKI_SESSION_MODEL` is the single largest cost lever
  (`run.sh:16932`) and today it is one pinned tier for the whole run. Wire
  `detect_complexity()` (`run.sh:1338`) -> session tier so simple specs pin
  cheaper (haiku/sonnet) and complex specs pin higher, instead of a flat
  default. Keep it a unified intelligent default (opt-out knob), never a
  fragmented set of flags.
- **Effect:** direct $/build reduction on the simple-spec majority; strong
  model reserved for the hard tail. Dominant cost lever.
- **Bucket:** (a). Model selection, no prompt text.
- **Bench validation:** $/build drops on simple-spec corpus members,
  verified-pass-rate flat across ALL members (guard: cheaper tier must not
  regress pass on the hard ones -- that is the anchor-1 trap).
- **Effort:** LOW-MED. `detect_complexity` already exists; wire it to the tier
  map and gate on the bench.

### Rank 3 -- Root-cause-clustered parallel fix-loops

- **Pattern:** iterate-fix-failing-tests + "cluster before you parallelize"
  (`managed-agents`); Parallelization for independent slices
  (`agent-patterns`).
- **Concrete:** on a code-review/test BLOCK, bucket failures by root module
  and fan out ONE fix-worker per INDEPENDENT cluster (worktree per cluster),
  then re-run the WHOLE suite once at merge as the independent verify. Do NOT
  fan out per-test -- failures share root causes, per-test workers duplicate
  the same fix and conflict (the cookbook's own `test_mean` caveat).
- **Effect:** wall-clock collapse on multi-cluster failures (parallel vs
  serial); fewer iterations via root-cause (not symptom) fixes.
- **Bucket:** (a) for the orchestration (fan-out + merge + whole-suite
  re-verify happen in run.sh / fleet, no prompt-text change). (c) for
  proving it -- parallel worktree fix-loops must be validated off-worktree on
  real multi-failure builds.
- **Bench validation:** wall-clock drops on corpus members that produce
  multi-cluster failures; verified-pass-rate flat (the merge whole-suite
  re-run is the non-negotiable guard against over-fix/regression).
- **Effort:** MED. Clustering heuristic + worktree fan-out + merge verify.

### Rank 4 -- Per-role tool-scoping in the SDLC fleet

- **Pattern:** coordinate-specialist-team "narrowest tool allowlist per role"
  (`managed-agents`); tool descriptions drive behavior.
- **Concrete:** give each fleet role (architect, dev, SDET, reviewer) the
  minimal allowed-tools list it needs (reviewer: read-only; researcher:
  web+read only). Claude and Codex both support per-invocation tool
  restriction -- provider-agnostic.
- **Effect:** fewer wrong-turn iterations (a reviewer cannot wander into
  bash); smaller blast radius. Iterations lever, modest.
- **Bucket:** (a). Invocation tool lists, no prompt text.
- **Bench validation:** iterations flat-or-down, verified-pass-rate flat. This
  one mostly de-risks; expect small bench movement. If the bench does not
  move, ship only if it reduces wrong-turn incidents in the transcript
  (secondary signal), else defer (ponytail: do not ship a no-op).
- **Effort:** LOW.

### Rank 5 -- Structured distilled-return contract for workers (coordinator economics)

- **Pattern:** plan-big-execute-small "workers return DISTILLED summaries, not
  raw material" + XML/JSON structured handoff (`managed-agents`,
  `agent-patterns`).
- **Concrete:** enforce that fleet workers return a small structured payload
  (JSON) up to the coordinator, never dump raw file/log/page content back up
  the chain. Keeps the coordinator context small -> cheaper, sharper
  synthesis. Gate the fan-out on a granularity heuristic (only shard genuinely
  token-heavy INDEPENDENT slices; the cookbook warns over-sharding RAISES the
  bill and narrow tasks do not pay).
- **Effect:** $/build reduction on token-heavy multi-worker builds; guards
  against the degenerate "one frontier round-trip for nothing" case.
- **Bucket:** (a) for the worker return contract and fan-out granularity
  gate (fleet orchestration). NOTE: if the distilled summaries are
  concatenated into the NEXT `build_prompt()` iteration, that concatenation
  path is (b) -- keep the contract change on the worker->coordinator hop, not
  the coordinator->next-prompt hop, to stay in (a).
- **Bench validation:** $/build drops on token-heavy corpus members;
  verified-pass-rate flat (guard: distillation must not summarize away
  nuance the grader checks).
- **Effort:** MED.

### Rank 6 -- Confidence-calibrated escalation lane (already partly shipped)

- **Pattern:** gate-human-in-the-loop decide/escalate calibration
  (`managed-agents`).
- **Concrete:** the uncertainty-gated escalation is already default-on
  (`run.sh:18236`). This item TUNES the confidence threshold so the confident
  majority stays in the fast/cheap autonomous lane and only the genuinely
  low-confidence + unsafe tail escalates/handoffs (never fake-greens, never
  blocks-to-ask -- honors the no-human-in-loop runtime rule). Route the
  low-confidence tail to a stronger model rather than a human where the action
  is reversible.
- **Effect:** avoids MAX_ITERATIONS burn on stuck loops (caps wasted
  iterations); reserves expensive lane for the tail.
- **Bucket:** (a). Threshold + routing, no prompt text.
- **Bench validation:** iterations drop on corpus members that currently
  thrash toward the cap; verified-pass-rate flat.
- **Effort:** LOW.

### Rank 7 -- Enriched findings-injection text (FOUNDER-GATED)

- **Pattern:** evaluator-optimizer "feed specific feedback + prior attempts
  back to the generator" + outcome-grader rubric discipline
  (`agent-patterns`, `managed-agents`). This is our highest-leverage
  iterations lever AND the most likely to be byte-locked.
- **Concrete:** `LOKI_INJECT_FINDINGS` already injects structured per-finding
  records into the next prompt (default-on). ENRICHING that injected TEXT
  (better-targeted, rubric-shaped, one-bullet-per-failure format) would make
  each retry more directed and converge in fewer passes. BUT the injected text
  flows through `build_prompt()`, whose output is pinned by the 60-fixture
  SHA-256 parity lock (`loki-ts/tests/parity/build_prompt.test.ts`,
  `loki-ts/src/runner/build_prompt.ts`, gold under
  `loki-ts/tests/fixtures/build_prompt/`).
- **Split (per anchor 2):**
  - (a) part: tuning WHEN findings are injected / WHICH findings are selected
    (selection logic upstream of the prompt) -- changeable now if it does not
    alter the emitted text bytes.
  - (b) part: changing the injected TEXT / format / rubric wording -- requires
    founder authorization to unlock the byte-lock, then regenerate all 60
    fixtures via `run-bash.sh` and keep bash<->TS parity 60/60.
- **Effect:** fewer iterations-to-completion (directed retries). Potentially
  large, but gated.
- **Bucket:** (b) for the text change; (a) for the selection-logic half.
- **Bench validation:** iterations drop, verified-pass-rate flat-or-up. Prove
  off-worktree (hermetic Bun integration test with stub judge, then real
  builds).
- **Effort:** MED code + HIGH process (founder unlock + fixture regen +
  full council + local-ci). Do NOT start the (b) half without authorization.

---

## 4. Sequencing for the ultracode phase

1. **Deliverable #1 first: lock the harness + baseline.** Reconcile the
   iterations source (2c.1), confirm wall-clock coverage (2c.2), lock the 5-15
   spec corpus (2c.3), ship the 2-spec smoke check (2c.4), then run the
   baseline: N real off-worktree builds -> committed
   `benchmarks/results/<baseline>.json`. Nothing else ships until this exists.
2. **Bucket-(a) wins, ranked, each bench-gated.** In order: Rank 1 (council
   knob sweep) -> Rank 2 (complexity->tier routing) -> Rank 6 (escalation
   threshold) -> Rank 4 (per-role tool scoping) -> Rank 3 orchestration half
   -> Rank 5 worker-return contract. Each one: change, re-run corpus, apply
   the gate rule (2e). If the bench does not move the right way, do not ship
   it (ponytail: no no-ops).
3. **Bucket-(c) validation for anything needing real parallel builds** (Rank 3
   fix-loop fan-out): prove off-worktree on real multi-failure builds before
   shipping.
4. **Founder-gated items LAST.** Rank 7 (b) half only after: (i) bucket-(a)
   wins are banked and measured, (ii) explicit founder authorization to unlock
   `build_prompt()`, (iii) fixture regen + 60/60 parity + full 3-reviewer
   council + local-ci green. Do the (a) selection-logic half of Rank 7 in
   step 2 if it stands alone.
5. **Every ship:** full gate is back (Wednesday 2026-07-08, the 1-week
   relaxation has expired). Runtime/council changes = full 3-reviewer council
   (2 Opus + 1 Sonnet, unanimous APPROVE, loop to 3/3) + `local-ci.sh` green +
   watch all GH workflows. Prove RARV-C changes with hermetic Bun integration
   tests (stub judge, `LOKI_OVERRIDE_REAL_JUDGE=0`, mkdtemp scratch, no token
   cost) -- pattern already established in
   `loki-ts/tests/integration/override_on_block.test.ts`.

---

## 5. Explicit "do NOT do" list

Tempting things that re-architect the moat, hit the byte-lock, or fabricate
numbers:

1. **Do NOT replace the completion council with a single-LLM outcome-grader.**
   That kills the 3-reviewer rigor moat -- the exact thing we are ahead on.
   Lift the rubric DISCIPLINE (checkable criteria, evidence-earned pass,
   one-bullet-per-failure feedback, same-gap non-convergence detection), NOT
   the single-judge architecture.
2. **Do NOT add an LLM-judge to the bench grader.** The grader is
   deterministic (`success = exit==0` on held-out acceptance) and the
   credibility invariant is enforced in code
   (`validate_adapter_output` rejects any self-judged key). An LLM judge is a
   second thing you must hold fixed and it breaks the invariant. Specs are
   code -- acceptance is machine-checkable for free.
3. **Do NOT trust `completion_claimed` / council APPROVE as the bench pass
   signal.** That is grading the loop's self-assessment -- the fake-green
   failure mode. Pass = independent deterministic acceptance only.
4. **Do NOT touch `build_prompt()` output text without founder authorization.**
   60-fixture SHA-256 byte-mirror parity lock. Any text change = regenerate
   gold + keep bash<->TS 60/60 or CI (`parity-drift`) fails. This gates
   Rank 7's (b) half.
5. **Do NOT change the corpus, grader, or price table across a before/after
   pair.** Comparability dies; the number becomes a fabrication. Additive
   output fields are safe; corpus churn is not.
6. **Do NOT cite the cookbook's headline numbers as ours.** "~2.5x cheaper /
   ~3x faster" (plan-big-execute-small) and "84-98% billed at worker rate" are
   THEIR task on THEIR corpus. Our numbers come from our harness, later.
7. **Do NOT over-shard plan-big-execute-small or fan fix-workers per-test.**
   The cookbook's own caveats: over-sharding RAISES the bill (delegation floor
   cost), narrow tasks do not pay, and per-test workers duplicate shared-root
   fixes and conflict. Cluster by root cause first, then parallelize across
   clusters.
8. **Do NOT run a real engine build from the worktree to validate any of
   this.** TARGET_DIR resolves onto the worktree and self-mutates it. Baseline
   and all (c) validation run from an isolated source copy with cwd +
   `LOKI_TARGET_DIR` pinned to scratch (the speed-benchmark.sh discipline).
9. **Do NOT re-scope the sandboxes-production infra work here.** It is already
   #2b/#8b/#10 in autonomi-saas. Reference the cookbook as an impl, do not
   re-derive or re-rank it.
10. **Do NOT ship a change that does not move the bench the right way.** The
    gate rule (2e) is binding: improve >=1 of {iterations, $/build,
    wall-clock} AND no verified-pass-rate regression, or it does not ship.
