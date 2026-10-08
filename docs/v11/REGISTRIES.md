# D91 item 3: hotspot registries

Status: design (Architect). Not implemented. Not committed.
Measured on main @ f754f66cb, 2026-10-08.

## Why

Every 11.3 feature edited the same five places in loki-ts/src. Those edits
serialized the merge queue and made every feature touch the Seal. The goal: a
new feature adds one contributor file plus one registry line, and never edits
the hotspot body again.

This is a pure refactor:
- Every golden stays byte-identical.
- Verdict precedence is preserved exactly.
- Each slice moves logic; it never changes behavior. Behavior bugs found while
  reading are listed in "Findings" and stay as they are.

## Global rules for every registry

1. Explicit order key. Every contributor carries a numeric `order`, unique within
   its registry and spaced by 100 so a feature can slot in between. The registry
   sorts by `order` when it loads and throws on a duplicate key. Import order and
   array literal order never decide output.
2. No self-registration. Contributor files export a plain object. The registry
   file imports each one by name and lists it in one array. A new feature adds
   one file plus one line in that array. Module side effects never register
   anything.
3. Guard test per registry:
   - pin the sorted id sequence (a literal array in the test)
   - reverse the source array, re-sort, and assert identical output
   - assert that a duplicate `order` throws
4. Shared helper: `loki-ts/src/util/ordered.ts` exports
   `ordered<T extends {id: string; order: number}>(xs: T[]): T[]`. It sorts, and
   throws on a duplicate id or a duplicate order.
5. Placement:
   - D42 says every verdict path stays in core, so the verdict registries live
     in core at `loki-ts/src/engine10/verdict/`. They count against the 5000-line
     core cap (measured 4683, so 317 lines of headroom).
   - e10ext (1479/1500) and features/ (2976/3000) are full. Non-verdict
     registries go in a new `loki-ts/src/contrib/` with its own cap (proposed
     1200 lines) and the D66 import rules: no `stages/` import except a
     whole-statement `import type` of seal, verify or wall.
   - The new cap needs CTO sign-off (RG-06).
6. Dist is never committed by a slice. The Release Manager rebuilds dist in the
   main checkout, because a symlinked node_modules breaks the source maps.

## Existing partial registries (reuse, do not duplicate)

| Where | What | Status |
|---|---|---|
| engine10/registry.ts | E-32 lazy module REGISTRY, guarded by registry.test.ts | A real registry. Keep it. The new registries are not lazy-loaded. |
| engine10/cli.ts `TABLE` | subcommand table | A real registry for subcommands. Start flags are not in it. |
| runner/router/route_block.ts | `withRouteLine` (:149), `withSealRoute` (:159), `routeStartLine` (:54) | A decorator pattern. It is the first contributor in each of 3 hotspots: seal route notes, the PR verdict annotation, and the start-line route segment. |
| features/pr_criteria.ts | `layoutPrBody` | Partial PR layout. RG-20 calls it unchanged from a section. |
| engine10/pr_body.ts | `renderPrBody` (48-58) | Test-only: no production caller (pr.ts imports only `draftReason`). Not a registry. Left alone. |

## Hotspot 1: Seal verdict chain (HIGH)

File: `loki-ts/src/engine10/stages/seal.ts` (359 lines).

Current ranges:
- 147-161: `verdictOf`, base rules where the first match wins
- 164-167: `targetProofOf`
- 213-235: gathering facts
- 236-244: the verdict chain:
  1. `capGroupVerdict(verdictOf(...), grp)`
  2. `supplyGuard` then `supplyVerdict` (239-240)
  3. `crossReview` then `minVerdict` (241)
  4. `mutationProof`: runs only when the verdict is VERIFIED and mutation is
     enabled, and downgrades to PARTIAL only when
     `mutationStrict() && plan.behavior_change` (243-244)
- 245-297: not_proven assembly (24 ordered contributors, listed below)
- 299-333: receipt body; key order is load-bearing
- 335: sealContract notes, added after the body is built
- 337-343: signing (adds SIGNING_UNAVAILABLE)
- 351-356: stage data plus the `receipt.sealed` emit, which carries
  `route_line` but not `mutation_line`

Precedence facts the registry must keep:
- RANK (xreview.ts) is FAILED=0, SPEC_CONFLICT=0, PARTIAL=1,
  ALREADY_SATISFIED=2, VERIFIED=2.
- `minVerdict` never upgrades.
- `capGroupVerdict`: if problems > 0 the result is FAILED, except that
  SPEC_CONFLICT is kept. If `!allUnitsPass`, VERIFIED or ALREADY_SATISFIED
  becomes PARTIAL.
- `supplyVerdict`: blocked and VERIFIED gives FAILED.
- Step order matters even though every step only lowers the verdict:
  - mutation runs only when the verdict is VERIFIED
  - xreview's notes depend on the verdict it received
  So the order is pinned by key, not left to commutativity.

Interfaces (`engine10/verdict/types.ts`):
```ts
export interface SealState { ctx; plan; facts; grp; supply?; xr?; notes: Set<string>; dropped: Set<string> }
export interface VerdictStep { id: string; order: number;
  run(v: Verdict, s: SealState): Verdict | Promise<Verdict> }
export interface NoteContributor { id: string; order: number; add(s: SealState): void }
export interface ReceiptSection { id: string; order: number;
  slot: "after_verdict" | "after_evidence" | "tail";
  fields(s: SealState): Record<string, unknown> }   // tail sections may add notes
```

Verdict steps and their order:
- base 100 (`verdictOf`)
- group_cap 200
- supply 300 (async)
- xreview 400 (async)
- mutation_strict 500

The runner clamps every step so it can never raise the rank. If a step returns
a higher rank, the runner throws in tests and keeps the lower verdict in
production. A test pins this.

Note contributors, in this order (100 apart, starting at 100):
1. deep, supply, grp and xr notes
2. proof reason
3. wall not_run
4. wall discarded
5. A-103b sealed-copy scan
6. diff not computed
7. weak tests (fills `dropped`)
8. uncovered after limit
9. not_run checks
10. flaky
11. verify not_proven minus dropped
12. commit not_proven and scope_notes
13. pre_red
14. tests_reverted
15. kill blocking
16. model override
17. task source
18. mutation "no" note
19. repo
20. resumed
21. cost: no iteration ids
22. cost: unmetered
23. wall result not recorded
24. route notes

Post-body notes run in their own phase: `seal_contract`, then signing (signing
stays inline).

Why order is a hazard here:
- `not_proven` is a Set, so insertion order lands in receipt.json bytes and in
  the receipt hash.
- receipt.json is written with `JSON.stringify`, so key order matters for the
  file bytes. The hash uses sorted `canonicalJson`, so it does not see key
  order.
- events data key order also lands in output.

Pinning tests:
- loki-ts/tests/engine10:
  - seal.test.ts
  - fc21b_verdict.test.ts
  - cap.test.ts
  - check_result.test.ts
  - supply_guard.test.ts
  - seal_group.test.ts
  - mutation_proof.test.ts
  - portable_receipt
  - seal_verify_roundtrip
  - log_seal
  - failover_receipt
  - dsse
  - dsse_followups
  - route_receipt_golden
  - e2e.test.ts
- tests/moat: p1, p2, p8
- New: RG-00 (precedence) and RG-01 (receipt bytes and note order)

## Hotspot 2: PR body (MEDIUM)

File: `loki-ts/src/engine10/stages/pr.ts` (124 lines).
- Imports: 12-15
- `briefSection`: 59-64
- Seal read: 71-75
- Line 78 awaits `beforeAfterBlock`. Line 79 concatenates:
  `withSealRoute(renderReviewerBody(..), env, seal) + intentSection + evidenceSection + briefSection + beforeAfter + mutation_line`

`e10ext/reviewer_body.ts` (55 lines) renders 5 fixed sections at 40-55:
1. What the issue asked
2. What changed and why
3. How it was tested
4. NOT PROVEN
5. Receipt

Interface (`contrib/pr_sections.ts`):
```ts
export interface PrSection { id: string; order: number; kind: "append";
  prepare?(c: PrCtx): Promise<void>; render(c: PrCtx): string }
export interface PrAnnotation { id: string; order: number; apply(body: string, c: PrCtx): string }
```

Rules:
- All `prepare` calls are awaited first, sequentially, in order. Today that is
  only before_after, which keeps the current single await.
- Then `render` runs in order.
- Annotations wrap the reviewer body before the appends. Route is order 100.
- Append order:
  - intent 200
  - evidence 300
  - brief 400
  - before_after 500
  - mutation 600
- Reviewer body sections (RG-21), 100 to 500, in the order of the 5 sections
  above.

Pinning tests:
- pr_body_golden.test.ts (fixture tests/fixtures/pr-body-firelater17)
- pr.test.ts
- reviewer_body.test.ts
- intent_card
- before_after
- visual_evidence
- pause_audit
- supervisor_backstop
- New: RG-02

## Hotspot 3: supervisor start line (MEDIUM)

File: `loki-ts/src/engine10/supervisor.ts` (351 lines).
- 228-243: `main` argv parse:
  - flags: --no-pr, --deep, --json, --verbose, --max-cost[=], --provider
  - --resume exits 2
- 267-270: start line:
  `START_LINE, baseLine, capNote` joined by ", ", then optional
  `; downgrade: ...`, `; <routeStart>` and `; <startText(estimate)>`, then "\n".
  A SUBSCRIPTION_NOTE line follows when verbose, not json, and the cap source is
  subscription.
- Side effects such as `env.LOKI_E10_COST_ESTIMATE` stay inline. Segments must
  be pure.
- 300-305: `run.started` data, with an optional `downgrades` key
- About 306-312: the pr hook rebuilds `seal` from the `receipt.sealed` event
  data (see Findings)

Interface (`contrib/start_line.ts`):
```ts
export interface StartSegment { id: string; order: number; group: "head" | "tail";
  text(c: StartCtx): string | null }   // null means omit
export interface StartExtraLine { id: string; order: number; line(c: StartCtx): string | null }
```

Rules:
- Head segments are joined by ", ": engine 100, base 200, cap 300.
- Tail segments are each prefixed by "; ": downgrade 400, route 500,
  estimate 600.
- Extra lines: subscription 100.
- `run.started` fields (RG-31) follow the same pattern, with key order by
  `order`.

Pinning tests:
- router_optout_golden.test.ts: the start line is cut before "; estimate: ",
  fixture pre_router_models.json, and LOKI_GOLDEN_UPDATE=1 is the update
  convention (:182). The estimate must stay the last segment.
- e2e.test.ts:131
- budget_cap.test.ts
- cost_preview.test.ts
- route_receipt_golden
- New: RG-03

## Hotspot 4: plan output (MEDIUM)

File: `loki-ts/src/engine10/stages/plan.ts` (126 lines).
- 31-45: `buildPlanBrief(router, intentCard, behaviorChange)` takes positional
  booleans. Instruction order: router, intent, behavior.
- 67: the variant event
- 68-69: skip paths
- 98: the failure path
- 111-123: data, with key order:
  1. plan, relevant_files, iteration_ids, duration_s
  2. `...ic.data` (intent)
  3. `...pr.units()`, route_record (router)
  4. `...readBehaviorChange`
  Field order differs from instruction order, so one order key cannot serve
  both.

Interface (`contrib/plan_fields.ts`):
```ts
export interface PlanContributor { id: string; briefOrder: number; fieldOrder: number;
  enabled(c: PlanCtx): boolean; instruction?(c): string;
  rawTransform?(raw: string, c): string; fields?(c, raw): Record<string, unknown> }
```

Orders:
- router: brief 100, field 200
- intent: brief 200, field 100, plus a `rawTransform`
- behavior: brief 300, field 400

`buildPlanBrief` keeps its exported signature as a thin wrapper, because tests
call it directly. Fixed base fields stay inline, ahead of every contributor
field.

Pinning tests:
- plan.test.ts
- plan_route
- intent_card
- router_optout_golden
- e10ext/prefix_identity
- full_job_brief
- fc21_cap
- sizing
- New: RG-04

## Hotspot 5: start dispatch (MEDIUM)

`loki-ts/src/commands/start.ts` (269 lines):
- 29-37: VALUE_FLAGS
- 39: BOOL_ENV_FLAGS (empty)
- 43: NOOP_BOOL_FLAGS
- 63-70: acceptedFlags
- 107-226: `parseStartArgs`. Validation order: provider, then session-model,
  then attempts.
- 234-237: `runEngine10` argv
- 245-269: `runStart`

`bin/loki` (714 lines):
- 347-376: attempts pre-pass (`if` at 351)
- 384-479: the v10 case; `start)` at 420 maps --budget to --max-cost
- 483-488: missing-bun check; start exits 1 using `command -v bun`, not
  `_loki_bun` (290)
- 511-562: `_loki_start_needs_bash`
- 568-578: the final start block (`exec bun "$BUN_CLI" "$@"` at 577)

TS interface (`contrib/start_flags.ts`):
```ts
export interface StartFlag { flag: string; aliases?: string[]; order: number;
  kind: "value" | "bool" | "noop"; validate?(v: string, a: StartArgs): string | null;
  into(a: StartArgs, v?: string): void; engineArgv?(a: StartArgs): string[] }
```
- `acceptedFlags` and the usage text are derived from the table.
- Validation runs in `order`: provider 100, session-model 200, attempts 300.
- `runEngine10` argv is built from `engineArgv` in order: no-pr, provider,
  max-cost.

Bash (`autonomy/lib/start-routes.sh`, sourced the same way bin/loki already
sources autonomy/lib at lines 53 and 132; autonomy/ ships in the npm files
list):
- Ordered handler names in one array, run in this order:
  - 100 attempts
  - 200 e10_ref
  - 300 no_bun
  - 400 legacy_flag_refuse
  - 500 provider_refuse
  - 600 bun_exec
- Each handler reads and rewrites the global `LOKI_START_ARGV` array, because
  `set --` inside a function does not change the caller's positional
  parameters.
- A handler returns 0 to continue, or execs or exits.
- Must stay compatible with bash 3.2.
- Must preserve two quirks byte-for-byte:
  - the bun check uses `command -v bun`
  - `--attempts 1` is stripped

Pinning tests:
- loki-ts/tests/commands/start.test.ts
- runner/attempts-dispatch.test.ts, attempts.test.ts
- tests/test-engine10-dispatch.sh
- test-start-bash-diversion.sh
- test-sdk-loop-routing.sh
- test-d65-routing.sh
- test-opencode-start.sh
- moat p4, p9
- New: RG-05

## Findings (not fixed by this refactor; the refactor preserves them)

F1. The PR `mutation_line` looks unreachable in production. The supervisor pr
hook rebuilds `seal` from the `receipt.sealed` event data (supervisor.ts about
306-312). That emit (seal.ts:351-356) carries `route_line` but no
`mutation_line`. Verify this with a live run before filing it in
FAILURE-CLASSES.md. RG-20 keeps the mutation section as is.

F2. start.ts has dead flag branches. --aider-model, --aider-flags,
--cline-model, --max-iterations and similar flags are rejected as unknown, so
their `argVal` branches never run. START_USAGE still advertises them, which is a
user-visible lie.
- RG-50 derives the usage text from the table. That would change the usage
  bytes, so RG-50 must keep the usage literal as it is.
- Fix the lie in a separate slice after the registry lands.

F3. `renderPrBody` in pr_body.ts is test-only. Candidate for deletion later.

## Wall checks (every slice)

- W1: goldens byte-identical, and no fixture or golden file changes:
  `git diff --name-only main -- 'loki-ts/tests/**/fixtures/**' 'tests/fixtures/**' '*golden*'`
  must be empty, except the new golden files the RG-0x slices add. Never set
  LOKI_GOLDEN_UPDATE=1.
- W2: the precedence suite:
  `cd loki-ts && bun test tests/engine10/verdict_precedence.test.ts tests/engine10/seal_chain_golden.test.ts tests/engine10/fc21b_verdict.test.ts tests/engine10/cap.test.ts tests/engine10/seal.test.ts`
- W3: `cd loki-ts && bun run typecheck`
- W4: size guard:
  `cd loki-ts && bun test tests/engine10/budget.test.ts` and
  `bash scripts/structural-checks.sh`
- W5 (HIGH only): `bash tests/moat/run.sh p1 p2 p8`
- W6 (dispatch slices only): `bash tests/moat/run.sh p4 p9`

Core line allowance:
- RG-10 +40, RG-11 +25, RG-12 +20, RG-13 +10 (total +95, which leaves 222 of
  headroom)
- Every other slice must have a net core delta of 0 or less.

Core measurement:
```
e=loki-ts/src/engine10; m=$(find $e/modernize -name '*.ts' -print0 | xargs -0 cat | wc -l); t=$(find $e -name '*.ts' -print0 | xargs -0 cat | wc -l); echo core=$((t-m))
```

Baton chains (one writer at a time on each shared file):
- seal.ts: RG-10, then RG-11, then RG-12, then RG-13
- supervisor.ts: RG-30, then RG-31, then RG-52
- plan.ts: RG-40, then RG-41

Review: HIGH slices use pair-mode review under D91 and unanimous opus reviewers
(D12).

## Slice cards

Waves:
- Wave 0 (RG-00 to RG-06): goldens and the home. Fully parallel, test or guard
  files only.
- Wave 1: the first registry per hotspot, with existing logic moved in
  unchanged.
- Waves 2 and 3: migrate the remaining inline pieces.

### RG-00 verdict precedence suite (HIGH, 25 min)
Goal: pin verdict precedence independently of seal.ts before anything moves.
File set: `loki-ts/tests/engine10/verdict_precedence.test.ts` (new).
Steps:
1. Freeze a verbatim copy of today's `verdictOf` rule list inside the test as
   the oracle.
2. Run a full matrix of its inputs (every boolean fact and proof state)
   against the live `verdictOf`.
3. Table-test `capGroupVerdict`, `supplyVerdict`, `minVerdict` and the
   mutation-strict downgrade over every Verdict times every flag.
4. Assert that no step ever raises RANK.
Wall: W2 (this file), W3. It adds no src lines.
Commands: `cd loki-ts && bun test tests/engine10/verdict_precedence.test.ts`
Done when: green on main and red when any rule in seal.ts:147-161 is swapped
(mutate locally, then revert).

### RG-01 seal receipt golden (HIGH, 30 min)
Goal: pin receipt.json bytes and not_proven insertion order end to end.
File set:
- `loki-ts/tests/engine10/seal_chain_golden.test.ts` (new)
- `loki-ts/tests/engine10/fixtures/seal_chain_golden.json` (new)
Steps:
1. Drive `seal` through about 8 scenarios that together fire every note
   contributor and every optional receipt key:
   - group
   - supply blocked
   - xreview notes
   - mutation strict
   - failover
   - spec_conflict
   - pre_existing_dirty
   - unsigned
2. Normalize only time, paths and sha fields.
3. Assert exact file bytes, the not_proven array order, the receipt.sealed
   event data key order, and stage data.
Wall: W2, W3, W5.
Commands: `cd loki-ts && bun test tests/engine10/seal_chain_golden.test.ts`
Done when: reversing any two `not_proven.add` calls in seal.ts turns it red.

### RG-02 PR sections golden (MEDIUM, 20 min)
File set:
- `loki-ts/tests/engine10/pr_sections_golden.test.ts` (new)
- `loki-ts/tests/engine10/fixtures/pr_sections_golden.json` (new)
Goal: a body golden with every section present (intent, evidence, brief,
before_after, mutation_line, route) and one with every section absent.
Wall: W1, W3. Commands: `bun test tests/engine10/pr_sections_golden.test.ts`

### RG-03 start line and run.started golden (MEDIUM, 20 min)
File set: `loki-ts/tests/engine10/start_line_golden.test.ts` (new, inline
expectations).
Goal: cover every segment combination (downgrade, route, estimate,
subscription with verbose) and the `run.started` data key order including
`downgrades`.
Wall: W1, W3. Commands: `bun test tests/engine10/start_line_golden.test.ts`

### RG-04 plan output golden (MEDIUM, 20 min)
File set: `loki-ts/tests/engine10/plan_output_golden.test.ts` (new).
Goal: cover the brief text and the data key order for all 8 combinations of
router, intent and behavior, plus the skip and failure paths and the variant
event.
Wall: W1, W3. Commands: `bun test tests/engine10/plan_output_golden.test.ts`

### RG-05 start dispatch goldens (MEDIUM, 30 min)
File set:
- `loki-ts/tests/commands/start_parse_golden.test.ts` (new)
- `tests/test-start-dispatch-golden.sh` (new)
- `tests/fixtures/start-dispatch-golden.tsv` (new)
- `tests/run-all-tests.sh` (run_test row)
- `tests/shard-durations.tsv` (row)
- `scripts/local-ci.sh` (run_check row near 1562)
Goal:
- TS: parse result, error text and engine argv for every flag, the validation
  order and the usage text bytes.
- Bash: for about 25 argv cases, the route taken (attempts, e10, no-bun,
  refuse, exec) and the rewritten argv. Stub bun, use `LOKI_NO_BROWSER=1`, and
  keep everything under `loki_run_tmp_create`.
Wall: W1, W3, W4, W6, shellcheck, `timeout -k` on every external call,
bash 3.2.
Commands:
- `bash tests/test-start-dispatch-golden.sh`
- `cd loki-ts && bun test tests/commands/start_parse_golden.test.ts`
- `bash scripts/structural-checks.sh`

### RG-06 contrib/ home and ordered helper (MEDIUM, 15 min, needs CTO ack)
File set:
- `loki-ts/src/util/ordered.ts` (new)
- `loki-ts/tests/util/ordered.test.ts` (new)
- `loki-ts/tests/engine10/budget.test.ts` (contrib cap 1200 plus D66-style
  import rule)
- `scripts/structural-checks.sh` (line_budgets row, lines 43-55)
Goal:
- `ordered()` sorts by order and throws on a duplicate id or order. Tests for
  each.
- The empty contrib/ cap passes.
- A planted `import { x } from "../engine10/stages/seal"` in contrib fails the
  guard (mutate, then revert).
Wall: W3, W4. Commands:
- `cd loki-ts && bun test tests/util/ordered.test.ts tests/engine10/budget.test.ts`
- `bash scripts/structural-checks.sh`

### RG-10 verdict step registry (HIGH, 30 min, after RG-00, RG-01, RG-06)
File set:
- `loki-ts/src/engine10/verdict/types.ts` (new)
- `loki-ts/src/engine10/verdict/chain.ts` (new)
- `loki-ts/src/engine10/verdict/steps.ts` (new)
- `loki-ts/src/engine10/stages/seal.ts` (lines 236-244 only)
- `loki-ts/tests/engine10/verdict_chain_registry.test.ts` (new)
Goal:
- Move the four transforms (base 100, group_cap 200, supply 300, xreview 400,
  mutation_strict 500) unchanged into step objects.
- `runVerdictChain` sorts with `ordered()` and applies the rank clamp.
- seal.ts calls it once.
- Supply and xreview results land on SealState so the notes still see them.
Guard test:
- pins the id order
- reverse-array invariance
- a test-only step returning a higher rank is clamped, and the runner throws
  under test
Wall: W1, W2, W3, W4 (core +40 max), W5.
Commands: W2 and W5 command lines plus
`bun test tests/engine10/verdict_chain_registry.test.ts`
Reviewers: pair-mode, two opus.

### RG-11 not_proven note registry (HIGH, 30 min, after RG-10)
File set:
- `loki-ts/src/engine10/verdict/notes.ts` (new)
- `loki-ts/src/engine10/stages/seal.ts` (245-297 and 335)
- `loki-ts/tests/engine10/verdict_notes_registry.test.ts` (new)
Goal:
- Move the 24 note blocks, in today's order, into `NoteContributor`s with
  orders 100 to 2400.
- weak_tests (700) fills `s.dropped`, and verify_not_proven (1100) reads it.
  Add a guard assertion that the order of those two can never invert.
- The post-body phase holds `seal_contract`.
Wall: W1, W2 (RG-01 order assertions), W3, W4 (core +25), W5.
Commands: W2 plus `bun test tests/engine10/verdict_notes_registry.test.ts`

### RG-12 receipt section and seal output registry (HIGH, 30 min, after RG-11)
File set:
- `loki-ts/src/engine10/verdict/receipt_sections.ts` (new)
- `loki-ts/src/engine10/stages/seal.ts` (299-333 and 351-356)
- `loki-ts/tests/engine10/receipt_sections_registry.test.ts` (new)
Goal:
- Fixed head keys (schema through verdict) stay inline.
- Optional keys become sections in slots:
  - after_verdict: implement_limit, group, failover, spec_conflict_reason
  - after_evidence: pre_existing_dirty
  - tail: cost, time, provider, model, resumed, events_sha256, seal_evidence
    (adds notes), log_seal, receiptBlock, mutation, route, supply
- Within each slot, key insertion order equals today's order.
- Emit data fields follow the same pattern, so `mutation_line` stays absent
  (F1).
Wall: W1 (byte-identical receipt.json), W2, W3, W4 (core +20), W5, and
`bun test tests/engine10/portable_receipt* tests/engine10/dsse*`

### RG-13 verdictOf base-rule table (HIGH, 30 min, after RG-12)
File set:
- `loki-ts/src/engine10/verdict/base_rules.ts` (new)
- `loki-ts/src/engine10/stages/seal.ts` (147-161)
Goal: the first-match rules become `{id, order, when(facts), verdict}`, evaluated
in order. `verdictOf` stays exported with the same signature.
Wall: W2. RG-00's frozen-oracle matrix is the authority here and must be green
with zero diffs. Also W3, W4 (core +10) and W5.

### RG-20 PR section registry (MEDIUM, 30 min, after RG-02, RG-06)
File set:
- `loki-ts/src/contrib/pr_sections.ts` (new)
- `loki-ts/src/contrib/pr/` (one file per section: route, intent, evidence,
  brief, before_after, mutation)
- `loki-ts/src/engine10/stages/pr.ts` (12-15, 59-64, 78-79)
- `loki-ts/tests/contrib/pr_sections.test.ts` (new)
Goal:
- pr.ts line 79 becomes `renderPrBody(ctx)` from contrib.
- before_after keeps its single await through `prepare`.
- pr.ts net lines must go down.
- contrib must not import stages/. Pass the seal data in as a type-only value.
Wall: W1 (pr_body_golden, RG-02), W3, W4.
Commands: `bun test tests/engine10/pr_body_golden.test.ts tests/engine10/pr_sections_golden.test.ts tests/engine10/pr.test.ts`

### RG-21 reviewer body sections (MEDIUM, 25 min, after RG-02)
File set:
- `loki-ts/src/e10ext/reviewer_body.ts`
- `loki-ts/tests/e10ext/reviewer_body_registry.test.ts` (new)
Goal: the 5 sections become an ordered array (100 to 500) inside the same file.
e10ext net lines must be 0 or less, because e10ext is at 1479 of 1500.
Wall: W1 (reviewer_body.test.ts, pr_body_golden), W3, W4.

### RG-30 start-line segment registry (MEDIUM, 20 min, after RG-03, RG-06)
File set:
- `loki-ts/src/contrib/start_line.ts` (new)
- `loki-ts/src/engine10/supervisor.ts` (267-270)
- `loki-ts/tests/contrib/start_line.test.ts` (new)
Goal:
- Head segments: engine 100, base 200, cap 300.
- Tail segments: downgrade 400, route 500, estimate 600.
- Extra lines: subscription.
- Side effects stay in supervisor.ts.
- A guard asserts estimate is the last tail segment, because
  router_optout_golden cuts the line there.
Wall: W1 (router_optout_golden, e2e:131, budget_cap, cost_preview, RG-03), W3,
W4 (core 0 or less).

### RG-31 run.started field registry (MEDIUM, 20 min, after RG-30)
File set:
- `loki-ts/src/contrib/run_started.ts` (new)
- `loki-ts/src/engine10/supervisor.ts` (300-305)
Goal: optional data keys (downgrades today) become ordered contributors. Base
keys stay inline and first.
Wall: W1 (RG-03 key order), W3, W4.

### RG-40 plan contributor registry (MEDIUM, 30 min, after RG-04, RG-06)
File set:
- `loki-ts/src/contrib/plan_fields.ts` (new)
- `loki-ts/src/contrib/plan/` (router.ts, intent.ts, behavior.ts)
- `loki-ts/src/engine10/stages/plan.ts` (31-45 and 111-123)
- `loki-ts/tests/contrib/plan_fields.test.ts` (new)
Goal:
- Use the briefOrder and fieldOrder pairs from Hotspot 4.
- `buildPlanBrief(router, intentCard, behaviorChange)` stays exported as a
  wrapper.
- The guard pins both sequences separately.
Wall: W1 (plan.test, plan_route, intent_card, router_optout_golden,
prefix_identity, full_job_brief, RG-04), W3, W4.

### RG-41 plan variant fields (MEDIUM, 20 min, after RG-40)
File set:
- `loki-ts/src/engine10/stages/plan.ts` (67-69 and 98)
- `loki-ts/src/contrib/plan_fields.ts`
Goal: the variant event data and the skip and failure paths read contributor
`fields` through the registry, with key order pinned by RG-04.
Wall: W1, W3, W4.

### RG-50 start flag registry, TS (MEDIUM, 30 min, after RG-05, RG-06)
File set:
- `loki-ts/src/contrib/start_flags.ts` (new)
- `loki-ts/src/commands/start.ts` (29-70 and 107-237)
- `loki-ts/tests/contrib/start_flags.test.ts` (new)
Goal:
- VALUE_FLAGS, NOOP_BOOL_FLAGS, acceptedFlags, the argVal branches, validation
  (provider 100, session-model 200, attempts 300) and `runEngine10` argv all
  come from one table.
- Dead branches (F2) move over as table rows with identical rejection
  behavior.
- START_USAGE stays a literal (byte-identical).
Wall: W1 (start.test, RG-05 TS), W3, W4, W6.

### RG-51 bash start route registry (MEDIUM, 30 min, after RG-05)
File set:
- `autonomy/lib/start-routes.sh` (new)
- `bin/loki` (351-376, 420-438, 483-488, 511-562, 568-578)
Goal:
- Ordered handler array: 100 attempts, 200 e10_ref, 300 no_bun,
  400 legacy_flag_refuse, 500 provider_refuse, 600 bun_exec, using the global
  `LOKI_START_ARGV`.
- Keep `command -v bun` and the `--attempts 1` strip.
- No `${!var}`, because bin/loki may be sourced in contexts where zsh
  semantics leak in.
Wall:
- W1 (RG-05 bash golden, test-engine10-dispatch, test-start-bash-diversion,
  test-sdk-loop-routing, test-d65-routing, test-opencode-start)
- W6
- `bash -n bin/loki autonomy/lib/start-routes.sh`
- shellcheck
- bash 3.2: `/bin/bash tests/test-start-dispatch-golden.sh`

### RG-52 engine10 run flag registry (MEDIUM, 25 min, after RG-31)
File set:
- `loki-ts/src/contrib/run_flags.ts` (new)
- `loki-ts/src/engine10/supervisor.ts` (228-243)
Goal: the supervisor `main` flags (no-pr, deep, json, verbose, max-cost with
both forms, provider, plus the resume exit 2) become ordered rows. Usage and
error bytes stay identical.
Wall: W1 (e2e, test-engine10-dispatch), W3, W4, W6.

## Slice summary

| ID | Tier | Budget | After | Primary files |
|---|---|---|---|---|
| RG-00 | HIGH | 25 | - | tests/engine10/verdict_precedence.test.ts |
| RG-01 | HIGH | 30 | - | tests/engine10/seal_chain_golden.test.ts, fixture |
| RG-02 | MED | 20 | - | tests/engine10/pr_sections_golden.test.ts, fixture |
| RG-03 | MED | 20 | - | tests/engine10/start_line_golden.test.ts |
| RG-04 | MED | 20 | - | tests/engine10/plan_output_golden.test.ts |
| RG-05 | MED | 30 | - | start_parse_golden.test.ts, test-start-dispatch-golden.sh, tsv, runner rows |
| RG-06 | MED | 15 | CTO ack | util/ordered.ts, budget.test.ts, structural-checks.sh |
| RG-10 | HIGH | 30 | 00,01,06 | engine10/verdict/{types,chain,steps}.ts, seal.ts 236-244 |
| RG-11 | HIGH | 30 | 10 | engine10/verdict/notes.ts, seal.ts 245-297,335 |
| RG-12 | HIGH | 30 | 11 | engine10/verdict/receipt_sections.ts, seal.ts 299-333,351-356 |
| RG-13 | HIGH | 30 | 12 | engine10/verdict/base_rules.ts, seal.ts 147-161 |
| RG-20 | MED | 30 | 02,06 | contrib/pr_sections.ts, contrib/pr/*, pr.ts |
| RG-21 | MED | 25 | 02 | e10ext/reviewer_body.ts |
| RG-30 | MED | 20 | 03,06 | contrib/start_line.ts, supervisor.ts 267-270 |
| RG-31 | MED | 20 | 30 | contrib/run_started.ts, supervisor.ts 300-305 |
| RG-40 | MED | 30 | 04,06 | contrib/plan_fields.ts, contrib/plan/*, plan.ts 31-45,111-123 |
| RG-41 | MED | 20 | 40 | plan.ts 67-69,98, contrib/plan_fields.ts |
| RG-50 | MED | 30 | 05,06 | contrib/start_flags.ts, commands/start.ts |
| RG-51 | MED | 30 | 05 | autonomy/lib/start-routes.sh, bin/loki |
| RG-52 | MED | 25 | 31 | contrib/run_flags.ts, supervisor.ts 228-243 |

Start first:
- RG-01: the HIGH receipt golden that every seal slice depends on, and the
  longest pole.
- RG-06: unblocks every contrib/ slice. It needs CTO ack; if that is pending,
  start RG-00 in its place.
All of wave 0 is parallel-safe.
