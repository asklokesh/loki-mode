# Architecture reference: gates, healing, memory, harness knobs

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

Note: unanimous APPROVE is required, and a reproduced blocking finding always
vetoes regardless of vote count. Every council/review agent pins its model
explicitly rather than inheriting the session model.

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
- **Cross-project index + knowledge graph**: `memory/cross_project.py`, `memory/knowledge_graph.py` (added v7.x)
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

## Anthropic SDK upgrade capability matrix (RQ-104, 2026-10-23)

Pins (exact, all sites): `@anthropic-ai/sdk` 0.124.0 -> 1.3.0 (loki-ts/package.json, loki-ts/bun.lock, docker/Dockerfile peer pin); `@anthropic-ai/claude-agent-sdk` 0.3.293 -> 0.3.314 (loki-ts/package.json, package.json, package-lock.json, bun.lock, docker/Dockerfile). `tests/test-sdk-version-sync.sh` asserts both. Sources: sdk CHANGELOG 0.125.0..1.3.0, agent-sdk CHANGELOG 0.3.294..0.3.314.

| Change | Status |
|---|---|
| sdk 1.0.0 BREAKING "new API version 2026-10-21" | WIRED at compile level only: loki-ts/src/runner/sdk_invoker.ts:19,311 (messages.create, output_config) compiles unchanged under tsc rc=0 and sdk_invoker tests pass. Live behavior at API version 2026-10-21 is NOT PROVEN (no API key, no paid run) |
| sdk 0.129.0 `claude-sonnet-5-5`, 0.128.0 `claude-opus-5-5`, 0.132.0 `claude-haiku-5-5` model ids | WIRED: model ids are passed through as strings by sdk_invoker.ts; no allowlist to change |
| sdk 0.135.0 `speed` param and `usage.speed` | NOT ADOPTED: the cost ledger (util/child_ledger.ts:54) has no fast-mode price table; adopting speed without pricing would misreport cost |
| sdk 0.134.0 native OpenTelemetry tracing (auto-on with a global tracer provider) | NOT ADOPTED: Loki registers no global tracer provider, so the SDK stays inert; no opt-in needed |
| sdk 0.126.0 compaction param, 0.127.0 `compactBeforeNextTurn()`, 0.129.0 tool-call-while-streaming, tool runner fixes (0.128.0, 1.2.0) | NOT ADOPTED: sdk_invoker is a one-shot messages.create judge, not a tool runner or multi-turn loop |
| sdk 0.129.0 cache diagnostics on Message | NOT ADOPTED: Loki already accounts cache tokens from usage (util/child_ledger.ts cache_creation_tokens, cache_read_tokens; cost_breakdown); diagnostics would add a second source of truth |
| sdk 0.129.0 `between_tools` thinking | NOT ADOPTED: judge path clamps thinking by effort (sdk_invoker.ts clampThinkingForEffort); between_tools is not offered to judges |
| sdk 0.135.0/0.136.0 streaming fixes (unread stream close, unknown SSE events) | NOT ADOPTED: sdk_invoker does not stream |
| sdk 0.130.0-1.2.0 Admin API (analytics, spend limits, RBAC, plugins, webhooks, message threads, usage/cost reports), Managed Agents additions | NOT ADOPTED: no Loki feature calls these APIs |
| agent-sdk 0.3.302 refused structured output now an error with no payload | NOT AFFECTED: quality_gates.ts:1616 reads `e["structured_output"]` and fails closed to null when it is absent or not an object (falls back to parsing `result`); a refusal with no payload therefore yields null, the same outcome as before. Refusals are also handled by sdk_stream_parser.ts refusal frames |
| agent-sdk 0.3.300 `thinking: disabled` runs adaptive on models that cannot disable | NOT ADOPTED: providers.ts:846 query() options pass no thinking setting |
| agent-sdk 0.3.302 fork subagents on by default in SDK sessions | NOT ADOPTED: accepted default, effect on Loki runs unmeasured; `CLAUDE_CODE_FORK_SUBAGENT=0` is the opt-out |
| agent-sdk 0.3.302 omitted `permissionMode` defaults to `default` on third-party providers | N/A: Loki always passes an explicit permissionMode (providers/claude_flags.ts:1052) |
| agent-sdk 0.3.301 full-disk login refresh error is `invalid_request`, not `authentication_failed` | NOT ADOPTED: sdk_stream_parser.ts:278 keys only on `authentication_failed`; a full-disk refresh failure surfaces as a generic error, accepted until observed |
| agent-sdk 0.3.300 PreToolUse/PermissionRequest `updatedInput` validated, unknown keys dropped | N/A: runSdkHostGuard (providers.ts:784) returns no updatedInput |
| agent-sdk 0.3.296 `claude_code_version` in the initialize control response | NOT ADOPTED: SDK_BUNDLED_CLAUDE_CODE (providers.ts:364) is read before any session starts and is guarded by a test against the installed SDK claudeCodeVersion; the initialize value only exists after spawn |
| agent-sdk 0.3.295 SDK passes option values as `--flag=value` | N/A: Loki consumes the SDK options API, not CLI argv, on the SDK route |
| agent-sdk 0.3.301 `BUILTIN_TOOL_NAMES`, sdk MCP `permission_policy`; 0.3.304 `suspendSseStream` (browser); 0.3.296 `autoCompactWindow`; 0.3.307 `wakeup_source`; 0.3.305 `startup()` timeout fix | NOT ADOPTED: no existing Loki feature maps to these options |
| agent-sdk 0.3.309 `extractFromBunfs()` per-user temp dir | NOT ADOPTED: Loki does not run the SDK from a Bun-compiled binary |

## Phase 1 / RARV-C Closure Env Vars

Default-on in the Bun runner (see `CHANGELOG.md` v7.x entries; documented in `skills/quality-gates.md:88-110`). Set to `0` to disable; set to `1` to force-enable on the bash route.

- `LOKI_INJECT_FINDINGS` -- inject structured per-finding records into the next-iteration prompt; persists `.loki/state/findings-<iter>.json` after aggregation.
- `LOKI_OVERRIDE_COUNCIL` -- enable the 3-judge override council on a BLOCK verdict. Requires `LOKI_INJECT_FINDINGS=1` (operator setting only this var alone is a no-op).
  **The BLOCK-LIFT arm only adjudicates on the Bun route** (`LOKI_SDK_LOOP=1`, or `LOKI_SDK_MODE=full`). A plain `loki start` takes the BASH route (`bin/loki:325`; `LOKI_SDK_MODE` defaults to `off`), where the override lands in a stub that returns `REJECT_OVERRIDE` for every record (`loki-ts/src/commands/internal_phase1.ts:215-227`). Counter-evidence is still parsed and an `override-<iter>.json` transcript is still written, so the feature looks live in the artifacts while never being able to lift a BLOCK.
  This fail-closed direction is DELIBERATE, not a bug: on the agent-authored route the gated agent writes its own counter-evidence, so mechanical verification is forgeable. On bash the only exits from a Critical/High BLOCK are to fix the finding or to use the human-escape path (`rm .loki/PAUSE`). Documented here because the heading above says "default-on" and, for this one knob's block-lift, that is true only on Bun.
- `LOKI_AUTO_LEARNINGS` -- auto-write structured learnings per code_review cycle. Optional `LOKI_AUTO_LEARNINGS_EPISODE=1` also writes the learning into the episode store.
  **Bun route only.** This var has ZERO occurrences in `autonomy/run.sh` and `autonomy/loki` (measured; controls: `LOKI_HANDOFF_MD` returns 2, `LOKI_INJECT_FINDINGS` returns 3), so "set to `1` to force-enable on the bash route" does not apply to this knob -- there is nothing on bash to enable. The bash route DOES have a learnings store (`init_learnings_db`, `run.sh`); what is Bun-only is the automatic per-code_review-cycle write.
- `LOKI_HANDOFF_MD` -- write a structured handoff doc before iteration close.
- `LOKI_REVIEW_ADVISORY` -- default on (`0` restores blocking). architecture-strategist, maintainer-mergeability and test-coverage-auditor are mandatory to run, not to block: they still run and their findings are recorded (`advisory: true` per reviewer plus `advisory_critical` / `advisory_high` in the review `aggregate.json`, one display-only row in the Evidence Receipt), but they carry no veto. `has_blocking` ignores them; security-sentinel and the other reviewers still block. maintainer-mergeability and test-coverage-auditor are routed to haiku at every tier. Bun: `ADVISORY_REVIEWERS` in `loki-ts/src/runner/quality_gates.ts`; bash: `_is_advisory_reviewer` in `autonomy/run.sh` (parity-locked in `tests/test-mergeability-review.sh`).

These knobs together implement the RARV-C (closure) loop: findings -> override council -> learnings -> handoff. Reference: `skills/quality-gates.md`, `CHANGELOG.md` entries from v7.x for default-on flip and override-council semantics.

## engine10 sizing knobs (`loki-ts/src/engine10/sizing.ts`)

- `LOKI_E10_SMALL_NO_RUNNER` -- default on: a missing test runner no longer disqualifies a task from "small". A small task skips the plan session (the implementer plans) and the skipped plan writes `plan-scope.json` from the files the task names. Set to `0` to make a missing runner force "normal".
- `LOKI_E10_SMALL_MAX_CHARS` -- task text length above which a task is not small (positive number, default 600; an invalid value falls back to 600 with a stderr note).

## Worktree substrate (autonomy/lib/worktree_prep.py)

`prepare_worktree(source_repo, dest, branch, setup=None, base=None)` creates an isolated git worktree and returns `{path, base_sha, deps, left_out_changes, deps_skipped}`. The start point is `origin/HEAD` after a fetch (when a remote exists), else HEAD. Uncommitted edits in the source checkout are never carried or stashed; their count is reported as `left_out_changes`. An fcntl lock at `~/.loki/repos/<slug>.lock` covers fetch and worktree add. Dependencies: a `setup` command run in the worktree, else a copy-on-write copy of ignored top-level `node_modules`, `.venv`, `venv`, `vendor` (a dir holding absolute symlinks or editable finders is never copied: it (or whose copy fails, with the partial copy removed) is left out, named in `deps_skipped`, `deps` is `skipped`, and the session installs it; a declared `setup` still fails hard), else `none`. CLI: `python3 autonomy/lib/worktree_prep.py SRC DEST BRANCH [--setup CMD] [--base REF]` prints the result as JSON. Callers: `autonomy/lib/backlog.py` (logs skipped deps), `autonomy/lib/workspace.py` (passes the entry `setup`) and `dashboard/api_start.py`.

## Project memory across runs

extract_learnings_from_session (autonomy/run.sh) mirrors learnings and decisions into .loki/memory/learnings/project-*.jsonl. get_relevant_learnings adds a bounded newest-first project_memory list (15 entries, LOKI_PROJECT_MEMORY_MAX_CHARS, default 2000) to .loki/state/relevant-learnings.json at run start. LOKI_PROJECT_MEMORY=0 disables both. Test: tests/test-project-memory.sh.

## Verdicts, composite receipts and the autonomy ladder (v11.7.0)
- Two sets: receipt verdicts (`engine10/types.ts` Verdict: VERIFIED, PARTIAL, ALREADY_SATISFIED, SPEC_CONFLICT, FAILED) and run outcomes (`engine10/output.ts` Outcome adds BUDGET_STOP, BLOCKED, STALLED, CANCELLED; exit ladder EXIT). Only receipt verdicts are sealed.
- Composite: `features/speed/seal_group.ts` composeComposite/verifyComposite (schema `loki.v10.composite/1`), sealed by `loki verify --seal-composite <run_dir>`, signed with the existing `signReceipt`, capped by `capGroupVerdict`. Workspace runs seal it after integration.json.
- Autonomy ladder: `src/policies/engine.js` allowedActions(level) (propose = none, execute = pr, operate = pr + deploy; merge never). engine10 `supervisor.ts` prGate consults `src/policies/check.js`; `loki deploy --execute` consults it for `deploy` and fails closed. `loki trust` graduationAdvice is advisory and never writes the policy file.
- Parallel units: `route.ts` maybeRunGroup defaults to `features/speed/run_group.ts`, which freezes per-unit acceptance (`features/contract.ts`), runs units, merges with `engine10/integrate.ts` and seals once via sealGroup.
- Lessons: every sealed run appends a receipt fact (`LOKI_AUTO_LEARN_PR`, default on) outside the receipt body; `implement.ts` injects lessons and relevant learnings inside the untrusted-data fence; `loki memory brief --task T` prints the same block.

- Wall publish (FC-VERIFIED-PR-WITHOUT-ITS-TEST): on a VERIFIED seal only, `publishWall` (`util/check_result.ts`, called from `stages/seal.ts`) makes ONE child commit (trailer `Loki-Wall-Publish: <runId>`) of the SEALED Wall bytes (`runDir/wall`, hash-checked against `wall.files[].sha256`) that verify ran and passed (`publishableWall`). Before writing, the realpath of each Wall file's parent directory must be inside the repo, and an existing file or symlink is removed first. The child commit runs with hooks and signing OFF (the default `git()` call, no `userHooks`), so a pre-commit hook cannot add files or rewrite the Wall bytes. Afterwards the commit must touch exactly the published paths and each committed blob must equal the blob hash of the sealed bytes (computed in process, never read from the worktree); on any mismatch the child is rolled back (`update-ref` HEAD to the product head plus `read-tree`), nothing is published and a NOT PROVEN note is added. The receipt binds the PRODUCT head (head_sha, tree, diff_sha256 are computed before the child commit). A re-seal binds `HEAD^` only when HEAD's message has the exact trailer line for this run, HEAD touches only paths of this run's `wall.files`, and every blob sha256 matches (`wallChild`); a forged trailer is not enough. `util/seal_drift.ts` accepts a moved HEAD after head_sha as benign only when every commit after it is such a Wall publish commit (linear, trailer line for the receipt's run_id, only `wall.files` paths, blob sha256 equal to the sealed one); any commit after head_sha that carries this run's trailer but fails that check is head drift (UNCHECKED). Later commits without the trailer stay under the TEN-GATES-16 sealed-path overlap rule. The PR body gains an "Acceptance tests" section. Commit stage and `backstopCommit` still drop Wall files. `LOKI_COMMIT_WALL=0` restores the old behavior (nothing published).

### Python anthropic SDK (RQ-105: pinned `anthropic==2.3.0`)

`mcp/requirements.txt` pins the Python SDK exactly (was `>=0.40,<1.0.0`; the resolver landed on 0.125.0). Requires Python >=3.10 (Ubuntu 24.04 image ships 3.12). The SDK runs on `httpx2`; no repo code passes `httpx` objects to it. v2.0.0 changes (API version 2026-10-21): `temperature`/`top_p`/`top_k` removed from Messages (no call site uses them), Admin API field renames (unused). Python-side call sites: `memory/managed_memory/client.py` (the only importer) and `providers/managed.py` (lazy import, `tests/managed/test_registry_lazy.py` contract unchanged).

| Capability (SDK release notes 0.40 to 2.2.0) | Status | Evidence / reason |
| --- | --- | --- |
| Client construction `anthropic.Anthropic(api_key, timeout, default_headers)` | WIRED | `memory/managed_memory/client.py:76`, `providers/managed.py:223`; unchanged in 2.x |
| Managed Agents memory stores (`beta.memory_stores`) | WIRED | `memory/managed_memory/client.py:127`; `create()` has no `scope` in 2.x, scope now sent as `metadata` |
| Memories nested at `beta.memory_stores.memories` (`memory_store_id`) | WIRED | `memory/managed_memory/client.py:96`; legacy `beta.memories` kept for fakes/preview |
| Memory paths | WIRED | 2.x paths are absolute and unique per store: `client.py:157` `_abs` plus leading "/" logical paths (`shadow_write.py` verdict/pattern/episode, `retrieve.py` list prefixes); wire test `RealSdkWireTests` asserts the request path |
| Memories list view and paging | WIRED | `client.py:242` `memories_list` sends `view="full"` (default basic view returns null content), follows `next_page` (20 per page) and drops `memory_prefix` rows; wire test pages 45 rows over 3 requests |
| Memory create precondition | NOT ADOPTED | 2.x `memories.create` has no precondition; an existing path answers 409 (`client.py:161`, status kept visible) |
| Memory update with `content_sha256` precondition | WIRED | `client.py:198` `memory_update`; the shadow-write 409 path (`shadow_write.py:197`) re-reads, merges, then updates with the hash of the content currently stored, never the hash of the new content |
| Memory versions (`memory_stores.memory_versions`) | NOT ADOPTED | `redact` path still reads the legacy shape; separate slice, behind ManagedDisabled fallback |
| Managed Agents sessions, environments, multiagent coordinator | WIRED | `providers/managed.py` `_RealMultiagentSession.run`: coordinator agent (`multiagent={"type":"coordinator"}`) + cached environment, then `sessions.create(agent=, environment_id=, initial_events=)`; ids cached in `.loki/managed/agent_ids.json`; contract test binds kwargs to the real SDK signatures. Fails safe (ManagedUnavailable) on timeout, terminated status, or any reply set that is not exactly one reply per roster agent; replies are the coordinator's `agent.thread_message_received` events, attributed via `from_session_thread_id` and `sessions.threads.list` to thread.agent.id (agent threads only); the session is ready only when every roster agent has replied; coordinator cache key includes the model, resolved from the model catalog (non-Claude env overrides ignored). WIRED, live reply shape NOT PROVEN (no key) |
| Vaults, deployments, dreams, webhooks | NOT ADOPTED | no Loki consumer; research preview |
| Tool runner (`beta.messages.tool_runner`), compaction, structured outputs, adaptive thinking, advisor tool, citations, files API, web search / code execution, prompt cache TTL | NOT ADOPTED | Loki drives models through provider CLIs and the TS Agent SDK; the Python SDK is only the managed-agents bridge |
| Bedrock / Vertex clients | NOT ADOPTED | no use |
