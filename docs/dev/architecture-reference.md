# Architecture reference: gates, healing, memory, harness knobs

Moved out of CLAUDE.md (S-78) to keep the root file short. Content unchanged
except where noted.

## Quality Gates (8 gates; see `skills/quality-gates.md` for the canonical table)
1. Static analysis (CodeQL, ESLint)
2. Test suite pass/fail (red blocks; coverage % not measured in this release)
3. Blind 3-reviewer code review with severity blocking (Critical/High = BLOCK; Medium/Low advisory)
4. Anti-sycophancy / Devil's Advocate (on unanimous PASS)
5. Mock-integrity detector (HIGH blocks)
6. Test-mutation detector (HIGH blocks)
7. Documentation coverage
8. Magic Modules debate (ADVISORY by default on both routes; bash enforces only with `LOKI_GATE_MAGIC_DEBATE_BLOCKING=true`, Bun self-skips unless `LOKI_GATE_MAGIC_DEBATE="true"`)

Conditional auditor (not numbered): Backward-compatibility / legacy-healing-auditor (healing mode only - behavioral preservation, v6.67.0).

Note (v10): `docs/v10/DECISIONS.md` D12 refines the review rule above -- unanimous
APPROVE is still required, and a reproduced blocking finding always vetoes
regardless of vote count. D13 requires every council/review agent to pin its
model explicitly rather than inherit the session model.

## Legacy System Healing (introduced v6.67.0)
- **Status**: Still active, no breaking changes since v6.67.0. Note: in v7.4.20 the `legacy-healing-auditor` reviewer was gated on healing-mode signals to avoid firing on non-healing changes.
- **Inspired by**: Amazon AGI Lab's "How Agentic AI Helps Heal Systems We Can't Replace"
- **CLI**: `loki heal <path> [--phase archaeology|stabilize|isolate|modernize|validate]` (`autonomy/loki` `cmd_heal`)
- **Principles**: Friction-as-semantics, failure-first learning, universal adapters, incremental healing, institutional knowledge preservation
- **Artifacts**: `.loki/healing/` (friction-map.json, failure-modes.json, institutional-knowledge.md). `loki heal` seeds failure-modes.json as `{"modes":[]}` and the prompt asks the agent to fill it; no code appends to it (NOT WIRED, issue #200)
- **Review**: `legacy-healing-auditor` specialist added to code review pool (gated)
- **Gate**: backward-compatibility / legacy-healing auditor (healing mode; not one of the 8 numbered gates) blocks removal of unclassified friction
- **Hooks**: `hook_pre_healing_modify()` (`autonomy/hooks/migration-hooks.sh:348`), `hook_post_healing_modify()` (`:576`), `hook_healing_phase_gate()`. NOT WIRED (issue #200): the pre/post modify hooks are defined and unit-tested but have no production caller, so the snapshot/revert pairing contract and the failure-modes.json append inside them are not enforced in a real heal run
- **Memory**: `FrictionPoint` and `FailureMode` schemas for healing-specific memory entries
- **Skill**: `skills/healing.md` | **Reference**: `references/legacy-healing-patterns.md`

## Memory System (core complete v5.15.0; managed-memory + RAG injector v7.1.0+)
- **Episodic**: Specific interaction traces (`.loki/memory/episodic/`)
- **Semantic**: Generalized patterns (`.loki/memory/semantic/`)
- **Procedural**: Learned skills (`.loki/memory/skills/`)
- **Progressive Disclosure**: 3-layer loading (index, timeline, full details)
- **Token Economics**: Discovery vs read token tracking
- **Vector Search**: Optional embedding-based similarity (sentence-transformers)
- **Cross-project + RAG injection**: `memory/cross_project.py`, `memory/rag_injector.py`, `memory/knowledge_graph.py` (added v7.x)
- **Managed memory client**: `memory/managed_memory/` -- gated on `LOKI_MANAGED_MEMORY=true`. See `skills/memory.md`.
- **CLI**: `loki memory index|timeline|consolidate|economics|retrieve|episode|pattern|skill|vectors`
- **API**: REST endpoints at `/api/memory/*`
- **Implementation**: `memory/` Python package (15 modules) with RARV integration

## Metrics System (ToolOrchestra-inspired)
- **Efficiency**: Task cost tracking (`.loki/metrics/efficiency/`)

## v8 Harness Intelligence (v8.0.0)

Four measured-harness disciplines on the trust core. None can weaken a gate.

- **Prompt-cache discipline**: the prompt splits into a cache-stable
  `<loki_system>` prefix and a volatile `<dynamic_context>` tail at
  `[CACHE_BREAKPOINT]`. **Any new always-on instruction MUST go in the prefix**
  or it busts the cache every iteration.
  Two accuracy notes, because an earlier version of this bullet overstated it:
  explicit `cache_control` on that split lives in `sdk_invoker.ts` (the raw-SDK
  judge path) and is **opt-in, default OFF** behind `LOKI_SDK_PROMPT_CACHE=1`.
  On the main agent path the Agent SDK's `query()` takes a plain string, so the
  split is not applied there and the SDK/CLI does its own caching internally.
  On the bash route the `[CACHE_BREAKPOINT]` marker is a documentation anchor
  that orders the prompt; it sets no `cache_control` header. The ordering rule
  above still matters on every route -- a stable prefix is what any cache, ours
  or the CLI's, can reuse.
- **Confidence-spike re-check** (`loki-ts/src/runner/council.ts`): delays the
  done-signal force-stop by ONE iteration when self-reported confidence spikes.
  Strictly additive (never skips a gate), never delays the stagnation valve,
  one-shot so a re-spiking run cannot postpone the valve forever.
  `LOKI_CONFIDENCE_SPIKE=0` / `_DELTA` (40) / `_MIN` (90).
- **Goal scoring** (`loki-ts/src/runner/goal_score.ts`): flags a
  `COMPLETION_PROMISE` with no measurable target. Advisory only. Suppressed for
  an absent goal and in perpetual mode. **Byte-mirrored in `autonomy/run.sh`** --
  edit BOTH or the `build_prompt` parity fixtures diverge. `LOKI_GOAL_SCORING=0`.
- **Smart retry** (`loki-ts/src/runner/retry_class.ts`): exits early on a
  positively-identified permanent failure. **Fail-safe direction is
  load-bearing**: unrecognized failures stay TRANSIENT and retry as before; rate
  limits are explicitly excluded from the permanent set. Never invert this
  default. `LOKI_SMART_RETRY=0`.

Observability: SDK failures emit a structured `capability_degraded` record to
`.loki/events.jsonl`; `.loki/app-runner/first-preview.json` records
time-to-first-preview write-once (bash route only).

## Phase 1 / RARV-C Closure Env Vars

Default-on in the Bun runner (see `CHANGELOG.md` v7.x entries; documented in `skills/quality-gates.md:88-110`). Set to `0` to disable; set to `1` to force-enable on the bash route.

- `LOKI_INJECT_FINDINGS` -- inject structured per-finding records into the next-iteration prompt; persists `.loki/state/findings-<iter>.json` after aggregation.
- `LOKI_OVERRIDE_COUNCIL` -- enable the 3-judge override council on a BLOCK verdict. Requires `LOKI_INJECT_FINDINGS=1` (operator setting only this var alone is a no-op).
  **The BLOCK-LIFT arm only adjudicates on the Bun route** (`LOKI_SDK_LOOP=1`, or `LOKI_SDK_MODE=full`). A plain `loki start` takes the BASH route (`bin/loki:325`; `LOKI_SDK_MODE` defaults to `off`), where the override lands in a stub that returns `REJECT_OVERRIDE` for every record (`loki-ts/src/commands/internal_phase1.ts:215-227`). Counter-evidence is still parsed and an `override-<iter>.json` transcript is still written, so the feature looks live in the artifacts while never being able to lift a BLOCK.
  This fail-closed direction is DELIBERATE, not a bug: on the agent-authored route the gated agent writes its own counter-evidence, so mechanical verification is forgeable. On bash the only exits from a Critical/High BLOCK are to fix the finding or to use the human-escape path (`rm .loki/PAUSE`). Documented here because the heading above says "default-on" and, for this one knob's block-lift, that is true only on Bun.
- `LOKI_AUTO_LEARNINGS` -- auto-write structured learnings per code_review cycle. Optional `LOKI_AUTO_LEARNINGS_EPISODE=1` also writes the learning into the episode store.
  **Bun route only.** This var has ZERO occurrences in `autonomy/run.sh` and `autonomy/loki` (measured; controls: `LOKI_HANDOFF_MD` returns 2, `LOKI_INJECT_FINDINGS` returns 3), so "set to `1` to force-enable on the bash route" does not apply to this knob -- there is nothing on bash to enable. The bash route DOES have a learnings store (`init_learnings_db`, `run.sh`); what is Bun-only is the automatic per-code_review-cycle write.
- `LOKI_HANDOFF_MD` -- write a structured handoff doc before iteration close.

These knobs together implement the RARV-C (closure) loop: findings -> override council -> learnings -> handoff. Reference: `skills/quality-gates.md`, `CHANGELOG.md` entries from v7.x for default-on flip and override-council semantics.

## Worktree substrate (autonomy/lib/worktree_prep.py)

`prepare_worktree(source_repo, dest, branch, setup=None, base=None)` creates an isolated git worktree and returns `{path, base_sha, deps, left_out_changes}`. The start point is `origin/HEAD` after a fetch (when a remote exists), else HEAD. Uncommitted edits in the source checkout are never carried or stashed; their count is reported as `left_out_changes`. An fcntl lock at `~/.loki/repos/<slug>.lock` covers fetch and worktree add. Dependencies: a `setup` command run in the worktree, else a copy-on-write copy of ignored top-level `node_modules`, `.venv`, `venv`, `vendor` (refused as "copy unsafe, declare setup" if it holds absolute symlinks or editable finders), else `none`. CLI: `python3 autonomy/lib/worktree_prep.py SRC DEST BRANCH [--setup CMD] [--base REF]` prints the result as JSON. Not yet wired into backlog or the UI.
