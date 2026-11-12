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
- **Cross-project index + knowledge graph**: `memory/cross_project.py`, `memory/knowledge_graph.py` (added v7.x; FR06: `ingest_repo`/`merge_repo` store per-repo services, CODEOWNERS rules and decision docs in graph.json, `org_context` renders them cited)
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
- **Confidence-spike re-check**: removed. It lived only in the separate Bun loop
  (removed in v11.119.0); `LOKI_CONFIDENCE_SPIKE` and its `_DELTA` / `_MIN` have no reader.
- **Goal scoring** (`autonomy/run.sh`): flags a
  `COMPLETION_PROMISE` with no measurable target. Advisory only. Suppressed for
  an absent goal and in perpetual mode. `LOKI_GOAL_SCORING=0`.
- **Smart retry** (`loki-ts/src/runner/retry_class.ts`): exits early on a
  positively-identified permanent failure. **Fail-safe direction is
  load-bearing**: unrecognized failures stay TRANSIENT and retry as before; rate
  limits are explicitly excluded from the permanent set. Never invert this
  default. `LOKI_SMART_RETRY=0`.

Observability: SDK failures emit a structured `capability_degraded` record to
`.loki/events.jsonl`; `.loki/app-runner/first-preview.json` records
time-to-first-preview write-once (bash route only).

## Anthropic SDK upgrade capability matrix (RQ-104, 2026-10-23)

Pins (exact, all sites): `@anthropic-ai/sdk` 0.124.0 -> 1.3.0 (loki-ts/package.json, loki-ts/bun.lock, docker/Dockerfile peer pin); `@anthropic-ai/claude-agent-sdk` 0.3.293 -> 0.3.314 (loki-ts/package.json, package.json, package-lock.json, bun.lock, docker/Dockerfile). Sources: sdk CHANGELOG 0.125.0..1.3.0, agent-sdk CHANGELOG 0.3.294..0.3.314.

Bump 2026-11-06: agent-sdk 0.3.316 -> 0.3.318 (bundled Claude Code 2.1.316 -> 2.1.318, `SDK_BUNDLED_CLAUDE_CODE`), sdk 1.3.0 -> 1.6.0, Python `anthropic` 2.3.0 -> 2.6.0, at every site above (the Dockerfile line had stayed at 0.3.314 / 1.3.0; tests/min/version-consistency.sh now holds it, both lockfiles and both package.json files to one version). Sources: agent-sdk CHANGELOG 0.3.317..0.3.318, sdk CHANGELOG 1.4.0..1.6.0, anthropic-sdk-python CHANGELOG 2.4.0..2.6.0. No breaking change reaches loki-ts/src (tsc clean): sdk 1.4.0-1.6.0 add Admin API methods and error classes (`err.name` is now the class name; runner/crash.ts reads it only as a label); agent-sdk 0.3.317 removes `file_unchanged` from `FileReadOutput` (no Loki reference).

| Change (0.3.317-0.3.318) | Status |
|---|---|
| agent-sdk 0.3.317 `onFailure: "block"` on hook matchers | WIRED: the host guard (Bash) and config fence (Edit/Write/MultiEdit) PreToolUse matchers on the SDK route (runner/providers.ts) block a call when the hook throws or returns invalid output; the SDK refuses such a session on a CLI that does not honor the option (tests/min/host-guard.sh, against the e2e stub) |
| agent-sdk 0.3.317 repeated Read returns full content (`file_unchanged` removed) | ACCEPTED: may raise tokens on Read-heavy loops; re-measure implement output tokens on the next bench |
| agent-sdk 0.2.89 `startup()`, 0.3.282 `prewarm()` / `SpareProcess.claim()` (alpha) | NOT ADOPTED, measured: a warm `prewarm()` of the bundled 2.1.318 initializes in 0.56-0.75 s (3 runs, 4.0 s cold first), so at a median 3 sessions a run saves about 1.5 s of a 197 s median wall (under 1%). Hooks, env, tools and the system prompt are fixed at prewarm and differ per stage, a claim cannot `resume` (implement resumes plan by default), and a parked spare holds 230-260 MB |
| agent-sdk 0.3.317 `session_writes_lost`, 0.3.318 `credential_expires_at` | NOT ADOPTED in this bump (upstream-parity row 17) |

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
| agent-sdk 0.3.302 refused structured output now an error with no payload | NOT AFFECTED: refusals are handled by sdk_stream_parser.ts refusal frames |
| agent-sdk 0.3.300 `thinking: disabled` runs adaptive on models that cannot disable | NOT ADOPTED: providers.ts:846 query() options pass no thinking setting |
| agent-sdk 0.3.302 fork subagents on by default in SDK sessions | NOT ADOPTED: accepted default, effect on Loki runs unmeasured; `CLAUDE_CODE_FORK_SUBAGENT=0` is the opt-out |
| agent-sdk 0.3.302 omitted `permissionMode` defaults to `default` on third-party providers | N/A: Loki always passes an explicit permissionMode |
| agent-sdk 0.3.301 full-disk login refresh error is `invalid_request`, not `authentication_failed` | NOT ADOPTED: sdk_stream_parser.ts:278 keys only on `authentication_failed`; a full-disk refresh failure surfaces as a generic error, accepted until observed |
| agent-sdk 0.3.300 PreToolUse/PermissionRequest `updatedInput` validated, unknown keys dropped | N/A: runSdkHostGuard (providers.ts:784) returns no updatedInput |
| agent-sdk 0.3.296 `claude_code_version` in the initialize control response | NOT ADOPTED: SDK_BUNDLED_CLAUDE_CODE (providers.ts:364) is read before any session starts and is guarded by a test against the installed SDK claudeCodeVersion; the initialize value only exists after spawn |
| agent-sdk 0.3.295 SDK passes option values as `--flag=value` | N/A: Loki consumes the SDK options API, not CLI argv, on the SDK route |
| agent-sdk 0.3.301 `BUILTIN_TOOL_NAMES`, sdk MCP `permission_policy`; 0.3.304 `suspendSseStream` (browser); 0.3.296 `autoCompactWindow`; 0.3.307 `wakeup_source`; 0.3.305 `startup()` timeout fix | NOT ADOPTED: no existing Loki feature maps to these options |
| agent-sdk 0.3.309 `extractFromBunfs()` per-user temp dir | NOT ADOPTED: Loki does not run the SDK from a Bun-compiled binary |

## Phase 1 / RARV-C Closure Env Vars

Default-on on the bash loop: `autonomy/run.sh` runs them through `loki internal phase1-hooks` (`loki-ts/src/commands/internal_phase1.ts`) after code review. Set to `0` to disable (see `CHANGELOG.md` v7.x entries and `skills/quality-gates.md`).

- `LOKI_INJECT_FINDINGS` -- inject structured per-finding records into the next-iteration prompt; persists `.loki/state/findings-<iter>.json` after aggregation.
- `LOKI_OVERRIDE_COUNCIL` -- enable the 3-judge override council on a BLOCK verdict. Requires `LOKI_INJECT_FINDINGS=1` (operator setting only this var alone is a no-op).
  **The BLOCK-LIFT arm never adjudicates on the bash loop.** The Bun loop that ran it was removed; on the bash loop (`--engine legacy`) the override lands in a stub that returns `REJECT_OVERRIDE` for every record (`loki-ts/src/commands/internal_phase1.ts:215-227`). Counter-evidence is still parsed and an `override-<iter>.json` transcript is still written, so the feature looks live in the artifacts while never being able to lift a BLOCK.
  This fail-closed direction is DELIBERATE, not a bug: on the agent-authored route the gated agent writes its own counter-evidence, so mechanical verification is forgeable. On bash the only exits from a Critical/High BLOCK are to fix the finding or to use the human-escape path (`rm .loki/PAUSE`). Documented here because the heading above says "default-on" and, for this one knob's block-lift, that is not true.
- `LOKI_AUTO_LEARNINGS` -- auto-write structured learnings per code_review cycle. Optional `LOKI_AUTO_LEARNINGS_EPISODE=1` also writes the learning into the episode store.
  Read by `internal_phase1.ts` (`LOKI_AUTO_LEARNINGS !== "0"`), which `autonomy/run.sh` calls through `loki internal phase1-hooks`; the variable itself never appears in `run.sh`.
- `LOKI_HANDOFF_MD` -- write a structured handoff doc before iteration close.
- `LOKI_REVIEW_ADVISORY` -- default on (`0` restores blocking). architecture-strategist, maintainer-mergeability and test-coverage-auditor are mandatory to run, not to block: they still run and their findings are recorded (`advisory: true` per reviewer plus `advisory_critical` / `advisory_high` in the review `aggregate.json`, one display-only row in the Evidence Receipt), but they carry no veto. `has_blocking` ignores them; security-sentinel and the other reviewers still block. maintainer-mergeability and test-coverage-auditor are routed to haiku at every tier. Implemented by `_is_advisory_reviewer` in `autonomy/run.sh`.

These knobs together implement the RARV-C (closure) loop: findings -> override council -> learnings -> handoff. Reference: `skills/quality-gates.md`, `CHANGELOG.md` entries from v7.x for default-on flip and override-council semantics.

## engine10 sizing knobs (`loki-ts/src/engine10/sizing.ts`)

- `LOKI_E10_SMALL_NO_RUNNER` -- default on: a missing test runner no longer disqualifies a task from "small". A small task skips the plan session (the implementer plans) and the skipped plan writes `plan-scope.json` from the files the task names. Set to `0` to make a missing runner force "normal".
- `LOKI_E10_SMALL_MAX_CHARS` -- task text length above which a task is not small (positive number, default 600; an invalid value falls back to 600 with a stderr note).
- `LOKI_E10_SCAFFOLD` -- release-note fragment writer (on by default; `=0` opts out). Right before the first verify, when the implement stage ended `done` and the repo keeps changesets (`.changeset/config.json`) or towncrier fragments, and the diff carries no fragment, Loki writes one with no model call: the package of each changed file (public workspace packages only, config `ignore` honored) or `<issue>.<type><ext>` named from the task number and the repo's own fragments, the body from the task title plus one sentence of the implement summary, quote style and trailing period from the newest real fragment. Nothing is written when the task says no changelog, the title is an internal change (chore, refactor, docs, ci, deps), only tests or docs changed, or the type or issue number is unclear; `changeset status` / `towncrier build --draft` remove a fragment they reject. Emits `scaffold.applied`. Whenever it writes a fragment, the receipt (not-proven list) and the PR body both say: "Loki added <path> as the release note for this change; delete it if this change needs no release note (LOKI_E10_SCAFFOLD=0 turns this off)." (`fragmentNoticeLine`). Code: `writeReleaseNoteFragment` in `loki-ts/src/project_model/conventions.ts`; tests in `tests/min/context-pack.sh`.
- `LOKI_E10_ATTEMPTS` -- parallel attempts after a red first attempt (EXP-0010). When the first implement attempt ends with the repo's checks red (fix rounds included), k more independent attempts run in parallel on the same model, each in a detached worktree in its own temp directory with a different instruction (smallest change, test first, read the covering tests first). Each finished attempt is scored on the shared impacted-test set in the primary tree; the first that passes all of it stops the others; otherwise `e10ext/select.ts` ranks them (repo checks green, fail-then-pass proof, fewest files outside the task, smallest diff, the first attempt last). An attempt that loosens an existing test is disqualified. Core re-verifies the winner's tree. Opt-in: unset or `0` is off; `on`/`true`/`yes` is k=2; a whole number 1-5 sets k on any model; anything else is off. Fires only when a check the change introduced is failing (not a full-suite or pre-red failure alone). Shares the run's `--max-cost` cap and time cap; needs enough run time for one window (90 s) plus the re-verify. Journal event `attempts.selected`, receipt data `implement.attempts`. (Before EXP-0010, `LOKI_E10_ATTEMPTS=2` meant two upfront attempts on every task; it now means k=2 after a red first attempt.)
- `LOKI_E10_PATCH` -- the implement patch protocol (`loki-ts/src/features/patch_protocol.ts`, wired in `engine10/stages/implement.ts`). On by default; `0`/`off`/`false` turns it off. Lean path only (plan skipped, router off, no session to continue, claude provider, a named model). One tool-less call (`runner/sdk_invoker.ts` toolLessCall, thinking off; `claude -p --tools ""` under `LOKI_E10_INVOKER=cli`) gets a dossier: the context pack's code, the heads and test names of the tests covering it, and the check command. It answers with FILE/SEARCH/REPLACE edit blocks. Before anything is written the harness refuses edits to lockfiles the task does not ask to change, test-runner and compiler configs (`features/runner_config.ts` RUNNER_CONFIGS), Wall tests, `.git`, `.loki`, paths outside the repo or through any symlink (realpath check), and an edit that changes nothing; the rest applies all-or-nothing (an exact, unique SEARCH match). The harness runs the targeted tests with verify's runner. At most one repair call follows (a red check with a failure digest and the edited regions, a rejected or missed edit, a NEED read, or a green fix with no regression test, which gets a test-only turn that can never make the green tree worse). Green means a check ran and passed and at least one of the checks is a test that existed before the change (the model's own new test alone never counts); the agentic session is then skipped and verify and seal judge the tree as usual. Any other end, including an exception anywhere in the protocol, restores every file the protocol wrote and today's agentic session runs, so the outcome floor is unchanged. A failed patch's spend still lands in the receipt total. Cost lands in the child ledger under phase `implement-patch`; the stage data carries `implement.patch` (status, calls, applied, refused, restored, usd, check) and the run dir keeps `implement-patch-<n>.txt` (prompt and reply). The receipt carries `patch` (outcome green, fallback or error, the protocol status, calls, seconds and dollars), so a scored run can count the fallback rate.
- `LOKI_E10_LEAN_CALLS` -- on by default, `0` opts out (`loki-ts/src/util/cost_profile.ts`): skips the coverage claim re-ask `-c2`, whose result changed no outcome on the 20-task Haiku bench (v11.137.1, patch off: 11 of 11 sessions edited nothing, 3 of 3 on v11.137.0; 4.6% of the arm's dollars). An explicit `LOKI_E10_CLAIM_CHECK=1` keeps the call. The same knob sets three more cheaper defaults, each with its own opt-out: the Opus consult and never-stop are off (`LOKI_E10_OPUS_CONSULT=1` turns them on), the exec-spec generator call is off (`LOKI_E10_EXEC_SPEC=1` turns it on) and the coverage requirement is folded into the implement brief instead of a separate turn (`LOKI_E10_COVERAGE_RESUME=1` restores the turn). `LOKI_E10_LEAN_CALLS=0` restores all four v11.138.0 defaults.
- `LOKI_E10_OPUS_CONSULT` -- off by default under `LOKI_E10_LEAN_CALLS` (`1` turns it on, `0` keeps it off; `loki-ts/src/features/opus_consult.ts` consultEnabled): one knob gates both the tool-less Opus consult (triggers stop, red-verify, open-choice; at most `LOKI_E10_CONSULT_MAX` per run) and never-stop (a headless run that would end SPEC_CONFLICT implements the most likely intent and is capped at PARTIAL). Off, a conflict ends BLOCKED as before v11.138.0. The default is set on cost. On the 20-task Haiku tuning bench (EVAL-2026-11-12-1, v11.138.0) each firing cost about $0.034, about $0.010 per task on average. On the 6 tasks where it fired, the runs cost $0.48 for 3/6 merge-ready with it on against $0.29 for 4/6 with it off. False VERIFIED is no worse with it off (0 against 2). The arm-level merge-ready gap (17/20 against 11/20, paired +0.30) is mostly one-seed variance, not an effect of the consult: it fired on only 1 of the 6 tasks gained.
- `LOKI_E10_EXEC_SPEC` -- off by default under `LOKI_E10_LEAN_CALLS` (`1` turns it on, `0` keeps it off; `loki-ts/src/features/exec_spec.ts` execSpecEnabled): the tool-less generator call that writes an executable spec on the lean path. On the 20-task Haiku bench (v11.137.1, patch off) 16 of 20 tasks paid for it (17.5% of the arm's dollars), it sealed a binding case in 0 of 16 and 7 of 16 replies were dropped because the file did not build on base. With it off the Go tournament (`LOKI_E10_TOURNAMENT`) has no probe block and stays inert; the no-regression differential (`LOKI_E10_NRD`) makes its own call and is unaffected.
- `LOKI_E10_COVERAGE_MAX_TURNS` -- default 10, `0`/`off` opts out (`loki-ts/src/util/conflict_resume.ts`): the coverage turn (`-c`, `-c2`) ends at this many turns. On the v11.137 Haiku bench arms 31 of 36 coverage turns took 2 to 8 turns and the other 5 took 13 to 33 (up to $0.031); a capped turn ends like a reply without LOKI_DONE, so the first result stands.
- `LOKI_E10_SUITE_FIX_SKIP` -- on by default, `0` opts out (`loki-ts/src/engine10/machine.ts` suiteOnlyRed): no fix round when every blocking group is a full-suite or startup failure, no failing full-suite id names a changed file, nothing held out failed and a targeted test of the change passed. 21 such first rounds on the v11.137 bench arms turned no run green (18 made no edit). The receipt carries a NOT PROVEN line; the verify stays red, so the run is never VERIFIED.
- `LOKI_E10_CLAIM_CHECK` -- off by default under `LOKI_E10_LEAN_CALLS` (`1` turns it on; with `LOKI_E10_LEAN_CALLS=0` it is on by default and `0` opts out; only with `LOKI_E10_COVERAGE_RESUME`; one extra session only when a claim is found absent): the coverage turn also asks for `SITE <path>:<line>: changed|unchanged` lines; a site claimed changed whose line is byte-identical to the base (claimed_change_absent) is re-asked once (`-c2`), recorded as `implement.claim_absent`. With `0`, the coverage turn is exactly as before.
- `LOKI_E10_ATTEMPTS_EARLY` -- `1` (off by default): on Haiku, run the `LOKI_E10_ATTEMPTS` attempts (k=2 when that is unset) right after the first red verify, before any fix round, and skip the fix rounds when an attempt goes green; if none does, the fix rounds run on the best tree as usual. The switch also makes k=2 apply to the after-fix hook on Haiku when `LOKI_E10_ATTEMPTS` is unset.

## engine10 improvement knobs, on by default (opt out with `=0`)

- `LOKI_E10_COVERAGE_RESUME` -- lean path only (plan skipped). Default (`fold`, under `LOKI_E10_LEAN_CALLS`): the implement brief carries one fixed line right after `FOLD_PLAN_INSTRUCTION` (cache-stable prefix) asking that every site, symbol, example or case the task names be mapped to its hunk and test, any gap fixed and a test added where none exists, so no separate turn runs (`coverage_resume: folded`). `=1`/`on` (or `LOKI_E10_LEAN_CALLS=0`) restores the separate turn: a clean LOKI_DONE with a non-empty diff gets one more turn in the same session that maps every named site to a change and a test and fixes any gap, with the edit-shape site hints. `=0` (or `off`/`false`) does neither. On the 20-task Haiku bench (v11.137.1, patch off) the separate turn cost 18% of the arm's dollars for 1 source edit in 18 (9 of 18 added tests). Code: `coverageMode` in `loki-ts/src/util/conflict_resume.ts`.
- `LOKI_E10_PACK_DIET` -- the implement context keeps only the code the task names plus its direct callers and callees (no fill up to the budget). `=0` restores the full pack. Code: `packDietEnabled` in `loki-ts/src/util/context_pack.ts`.
- `LOKI_E10_PRECEDENT` -- sibling-implementation precedent is added to open either/or choices in the task. `=0` (or `off`/`false`) removes it. Code: `resolveChoices` in `loki-ts/src/features/spec_ambiguity.ts`.
- `LOKI_E10_DEFECT_PIN` -- existing assertions that pin the wrong value the issue reports are listed in the implement brief, and a pure value replacement of exactly such an assertion is not counted as a weakened test (it never counts as fail-then-pass proof, and the receipt always lists the rewrite). `=0` turns both off. Code: `findDefectPins` in `loki-ts/src/e10ext/context.ts`, `pinLift` in `loki-ts/src/engine10/stages/seal.ts`.
- `LOKI_E10_ATTEMPTS` and `LOKI_E10_ATTEMPTS_EARLY` stay off by default (k=2 raised cost per run 17-47% on the v131 ledger with no accuracy evidence).

## Worktree substrate (autonomy/lib/worktree_prep.py)

`prepare_worktree(source_repo, dest, branch, setup=None, base=None)` creates an isolated git worktree and returns `{path, base_sha, deps, left_out_changes, deps_skipped}`. The start point is `origin/HEAD` after a fetch (when a remote exists), else HEAD. Uncommitted edits in the source checkout are never carried or stashed; their count is reported as `left_out_changes`. An fcntl lock at `~/.loki/repos/<slug>.lock` covers fetch and worktree add. Dependencies: a `setup` command run in the worktree, else a copy-on-write copy of ignored top-level `node_modules`, `.venv`, `venv`, `vendor` (a dir holding absolute symlinks or editable finders is never copied: it (or whose copy fails, with the partial copy removed) is left out, named in `deps_skipped`, `deps` is `skipped`, and the session installs it; a declared `setup` still fails hard), else `none`. CLI: `python3 autonomy/lib/worktree_prep.py SRC DEST BRANCH [--setup CMD] [--base REF]` prints the result as JSON. Callers: `autonomy/lib/backlog.py` (logs skipped deps), `autonomy/lib/workspace.py` (passes the entry `setup`) and `dashboard/api_start.py`.

## Project memory across runs

extract_learnings_from_session (autonomy/run.sh) mirrors learnings and decisions into .loki/memory/learnings/project-*.jsonl. get_relevant_learnings adds a bounded newest-first project_memory list (15 entries, LOKI_PROJECT_MEMORY_MAX_CHARS, default 2000) to .loki/state/relevant-learnings.json at run start. LOKI_PROJECT_MEMORY=0 disables both.

## Verdicts, composite receipts and the autonomy ladder (v11.7.0)
- Two sets: receipt verdicts (`engine10/types.ts` Verdict: VERIFIED, PARTIAL, ALREADY_SATISFIED, SPEC_CONFLICT, FAILED) and run outcomes (`engine10/output.ts` Outcome adds BUDGET_STOP, BLOCKED, STALLED, CANCELLED; exit ladder EXIT). Only receipt verdicts are sealed.
- Composite: `features/speed/seal_group.ts` composeComposite/verifyComposite (schema `loki.v10.composite/1`), sealed by `loki verify --seal-composite <run_dir>`, signed with the existing `signReceipt`, capped by `capGroupVerdict`. Workspace runs seal it after integration.json.
- Autonomy ladder: `src/policies/engine.js` allowedActions(level) (propose = none, execute = pr, operate = pr + deploy; merge never). engine10 `supervisor.ts` prGate consults `src/policies/check.js`; `loki deploy --execute` consults it for `deploy` and fails closed. `loki trust` graduationAdvice is advisory and never writes the policy file.
- Parallel units: `route.ts` maybeRunGroup defaults to `features/speed/run_group.ts`, which freezes per-unit acceptance (`features/contract.ts`), runs units, merges with `engine10/integrate.ts` and seals once via sealGroup.
- Lessons: every sealed run appends a receipt fact (`LOKI_AUTO_LEARN_PR`, default on) outside the receipt body; `implement.ts` injects lessons and relevant learnings inside the untrusted-data fence; `loki memory brief --task T` prints the same block. With `LOKI_ORG_GRAPH=1` (off) `implement.ts` also appends `orgKnowledgeBlock` (util/pr_lessons.ts, python3 by file path, 10 s cap, 1500 bytes) and records org_bytes/org_lines in lessons-injected.json.

- Wall publish (FC-VERIFIED-PR-WITHOUT-ITS-TEST): on a VERIFIED seal only, `publishWall` (`util/check_result.ts`, called from `stages/seal.ts`) makes ONE child commit (trailer `Loki-Wall-Publish: <runId>`) of the SEALED Wall bytes (`runDir/wall`, hash-checked against `wall.files[].sha256`) that verify ran and passed (`publishableWall`). Before writing, the realpath of each Wall file's parent directory must be inside the repo, and an existing file or symlink is removed first. The child commit runs with hooks and signing OFF (the default `git()` call, no `userHooks`), so a pre-commit hook cannot add files or rewrite the Wall bytes. Afterwards the commit must touch exactly the published paths and each committed blob must equal the blob hash of the sealed bytes (computed in process, never read from the worktree); on any mismatch the child is rolled back (`update-ref` HEAD to the product head plus `read-tree`), nothing is published and a NOT PROVEN note is added. The receipt binds the PRODUCT head (head_sha, tree, diff_sha256 are computed before the child commit). A re-seal binds `HEAD^` only when HEAD's message has the exact trailer line for this run, HEAD touches only paths of this run's `wall.files`, and every blob sha256 matches (`wallChild`); a forged trailer is not enough. `util/seal_drift.ts` accepts a moved HEAD after head_sha as benign only when every commit after it is such a Wall publish commit (linear, trailer line for the receipt's run_id, only `wall.files` paths, blob sha256 equal to the sealed one); any commit after head_sha that carries this run's trailer but fails that check is head drift (UNCHECKED). Later commits without the trailer stay under the TEN-GATES-16 sealed-path overlap rule. The PR body gains an "Acceptance tests" section. Commit stage and `backstopCommit` still drop Wall files. `LOKI_COMMIT_WALL=0` restores the old behavior (nothing published).

### Python anthropic SDK (RQ-105: pinned `anthropic==2.6.0`)

`mcp/requirements.txt` pins the Python SDK exactly (was `>=0.40,<1.0.0`; the resolver landed on 0.125.0). Requires Python >=3.10 (Ubuntu 24.04 image ships 3.12). The SDK runs on `httpx2`; no repo code passes `httpx` objects to it. v2.0.0 changes (API version 2026-10-21): `temperature`/`top_p`/`top_k` removed from Messages (no call site uses them), Admin API field renames (unused). Python-side call sites: `memory/managed_memory/client.py` (the only importer) and `providers/managed.py` (lazy import).

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

## Default `loki start` path: route trace and bash entry points (measured at 22823c935)

Scope: trace only, nothing rewritten. All counts below were taken from the working tree at this commit.

### Route results (no model calls)
Command shape: `bin/loki route start <input> --json`. The representative inputs and the engine and adapter reported:

| Input | input_type | engine | adapter |
|---|---|---|---|
| `"add a dark mode toggle"` (one-line brief) | task | engine10 | engine10:claude |
| `./prd.md` (PRD file) | prd | engine10 | engine10:claude |
| `acme/widgets#42` (issue ref) | issue | engine10 | engine10:claude |
| `./api.yaml` and `./api.json` (OpenAPI/JSON spec) | prd | engine10 | engine10:claude |
| `./prd.md --resume` (flagged) | prd | engine10 | engine10:claude |
| `./prd.md --provider opencode` (flagged, other provider) | prd | engine10 | engine10:opencode |
| `./prd.md --engine legacy` (legacy-mode flag) | prd | legacy | legacy-bash:claude (runs `autonomy/run.sh`) |

Other flag outcomes from the same probe: `--parallel` and `--legacy` are refused on the default engine with a message pointing to `loki queue run --parallel K` or `--engine legacy`. `LOKI_LEGACY_BASH=1 loki route ...` answers `Unknown command: route` because that rollback flag forces every command through bash, which has no `route`. Every default-path input lands on engine10; the bash loop is reachable only through an explicit `--engine legacy` (or `LOKI_ENGINE=legacy`) and the `LOKI_LEGACY_BASH=1` rollback.

### Bash-dispatched command inventory
Source: `REGISTRY` in `loki-ts/src/cli/registry.ts` loaded with bun (a throwaway script printing name and `where` for each entry). Totals from that listing: 135 top-level entries; `where` is bash for 103, both for 16, bun for 16. The table covers the 119 entries whose `where` is bash or both. The registry has no field named `impl`; `where` is the field that records the dispatch side. For `both`, Bun handles a subset of subcommands and bash keeps the rest.

Caller columns count matching lines of the text `loki <name>` (followed by a character other than a letter, digit, underscore or hyphen, or end of line) in: `bin/loki` (bin), `loki-ts/src` excluding `registry.ts` (ts), `autonomy/` recursive (aut). Case is the number of `<name>)` dispatch labels in `autonomy/loki`. Literal commands per name N: bin: `grep -Eh "loki N([^a-zA-Z0-9_-]|$)" bin/loki | wc -l`; ts: `grep -rEh --exclude-dir=node_modules --exclude=registry.ts "loki N([^a-zA-Z0-9_-]|$)" loki-ts/src | wc -l`; aut: `grep -rEh "loki N([^a-zA-Z0-9_-]|$)" autonomy | wc -l`; case: `grep -cE "^[[:space:]]*([a-z|-]*\|)?N(\|[a-z|-]*)?\)" autonomy/loki`. Caveat: the aut column includes usage and help text inside `autonomy/loki` itself, so it is an upper bound on real invocations.

| command | where | bin | ts | aut | case |
|---|---|---|---|---|---|
| status | both | 0 | 22 | 36 | 17 |
| doctor | both | 0 | 18 | 40 | 1 |
| provider | both | 0 | 16 | 29 | 3 |
| memory | both | 0 | 15 | 75 | 1 |
| rollback | both | 0 | 12 | 14 | 2 |
| backup | bash | 0 | 0 | 1 | 1 |
| restore | bash | 0 | 0 | 2 | 1 |
| proof | both | 0 | 36 | 74 | 1 |
| wiki | both | 0 | 12 | 15 | 1 |
| control | both | 0 | 27 | 8 | 1 |
| report | both | 0 | 8 | 20 | 2 |
| trust | both | 0 | 14 | 4 | 1 |
| crash | both | 0 | 18 | 12 | 1 |
| start | both | 12 | 71 | 262 | 10 |
| help | bash | 0 | 2 | 32 | 52 |
| chat | bash | 0 | 5 | 12 | 1 |
| edit | bash | 0 | 0 | 20 | 2 |
| diff | bash | 0 | 3 | 3 | 2 |
| models | bash | 0 | 0 | 2 | 2 |
| setup | bash | 0 | 3 | 7 | 2 |
| quick | bash | 2 | 2 | 26 | 4 |
| quickstart | bash | 0 | 2 | 30 | 1 |
| init | bash | 0 | 0 | 23 | 2 |
| template | bash | 0 | 0 | 9 | 1 |
| verify | bash | 1 | 50 | 52 | 6 |
| keys | bash | 0 | 3 | 0 | 1 |
| review | bash | 0 | 1 | 26 | 2 |
| dashboard | bash | 0 | 5 | 41 | 5 |
| config | bash | 0 | 2 | 27 | 2 |
| mcp | bash | 0 | 0 | 12 | 1 |
| acp | bash | 0 | 0 | 0 | 1 |
| stop | bash | 0 | 3 | 37 | 7 |
| pause | both | 0 | 2 | 7 | 1 |
| resume | both | 0 | 6 | 26 | 1 |
| cancel | both | 0 | 1 | 2 | 3 |
| why | bash | 0 | 0 | 36 | 1 |
| next | bash | 0 | 0 | 12 | 2 |
| logs | bash | 0 | 0 | 3 | 3 |
| ship | bash | 0 | 0 | 15 | 1 |
| deploy | bash | 0 | 2 | 37 | 1 |
| import | bash | 0 | 0 | 2 | 2 |
| github | bash | 0 | 0 | 11 | 4 |
| issue | bash | 0 | 0 | 34 | 1 |
| ci | bash | 0 | 0 | 10 | 1 |
| modernize | both | 4 | 10 | 6 | 2 |
| share | bash | 0 | 0 | 10 | 3 |
| assets | bash | 0 | 0 | 18 | 1 |
| export | bash | 0 | 9 | 14 | 5 |
| notify | bash | 0 | 0 | 15 | 1 |
| tour | bash | 0 | 2 | 11 | 2 |
| wow | bash | 0 | 0 | 20 | 1 |
| factory | bash | 0 | 0 | 3 | 1 |
| welcome | bash | 0 | 0 | 5 | 1 |
| onboard | bash | 0 | 0 | 10 | 2 |
| setup-skill | bash | 0 | 6 | 3 | 1 |
| self-update | bash | 0 | 0 | 18 | 0 |
| remote | bash | 0 | 0 | 9 | 1 |
| cockpit | bash | 0 | 8 | 12 | 1 |
| code | bash | 0 | 0 | 17 | 2 |
| context | bash | 0 | 0 | 10 | 2 |
| secrets | bash | 0 | 0 | 1 | 1 |
| api | bash | 0 | 0 | 5 | 1 |
| sandbox | bash | 0 | 0 | 69 | 2 |
| docker | bash | 0 | 0 | 20 | 3 |
| web | bash | 0 | 0 | 18 | 1 |
| preview | bash | 0 | 0 | 7 | 3 |
| telemetry | bash | 1 | 0 | 27 | 1 |
| syslog | bash | 0 | 0 | 4 | 1 |
| explain | bash | 0 | 0 | 11 | 3 |
| docs | bash | 0 | 0 | 41 | 1 |
| test | bash | 0 | 0 | 11 | 5 |
| bench | bash | 0 | 0 | 4 | 1 |
| voice | bash | 0 | 0 | 0 | 1 |
| own | bash | 0 | 1 | 8 | 1 |
| secure | bash | 0 | 0 | 7 | 1 |
| compliance | bash | 0 | 0 | 8 | 1 |
| enterprise | bash | 0 | 0 | 7 | 1 |
| projects | bash | 0 | 5 | 11 | 1 |
| audit | bash | 0 | 0 | 10 | 2 |
| cost | bash | 0 | 1 | 15 | 2 |
| metrics | bash | 0 | 0 | 12 | 2 |
| sentrux | bash | 0 | 1 | 12 | 1 |
| magic | bash | 0 | 3 | 14 | 1 |
| estimate | bash | 0 | 11 | 3 | 1 |
| plan | bash | 0 | 4 | 18 | 2 |
| grill | bash | 0 | 0 | 6 | 1 |
| spec | bash | 0 | 0 | 20 | 1 |
| intent | bash | 0 | 4 | 9 | 1 |
| backlog | bash | 0 | 0 | 9 | 1 |
| workspace | bash | 0 | 0 | 13 | 1 |
| council | bash | 0 | 0 | 2 | 1 |
| compound | bash | 0 | 0 | 6 | 2 |
| cluster | bash | 0 | 0 | 13 | 1 |
| optimize | bash | 0 | 0 | 6 | 1 |
| ultracode | bash | 0 | 0 | 14 | 1 |
| monitor | bash | 0 | 0 | 4 | 1 |
| watch | bash | 0 | 0 | 16 | 5 |
| watchdog | bash | 0 | 0 | 1 | 1 |
| cleanup | bash | 0 | 0 | 4 | 1 |
| state | bash | 0 | 5 | 19 | 1 |
| agent | bash | 0 | 2 | 20 | 1 |
| agents | bash | 0 | 0 | 3 | 1 |
| trigger | bash | 0 | 0 | 15 | 1 |
| failover | bash | 0 | 0 | 6 | 1 |
| reset | bash | 0 | 0 | 5 | 1 |
| merge | bash | 0 | 0 | 6 | 3 |
| heal | bash | 1 | 1 | 23 | 2 |
| migrate | bash | 0 | 0 | 27 | 6 |
| dogfood | bash | 0 | 0 | 3 | 2 |
| steer | bash | 0 | 4 | 14 | 2 |
| outcomes | bash | 0 | 0 | 14 | 1 |
| worktree | bash | 0 | 0 | 5 | 2 |
| checkpoint | bash | 0 | 0 | 14 | 1 |
| analyze | bash | 0 | 2 | 6 | 1 |
| demo | bash | 0 | 2 | 12 | 2 |
| run | bash | 0 | 1 | 41 | 8 |
| trust-metrics | bash | 0 | 0 | 5 | 1 |
| serve | bash | 0 | 0 | 13 | 1 |
| open | bash | 0 | 0 | 1 | 3 |

### Dead-code candidates (bash commands with weak or no callers)
Every listed command has a registry entry, so "no registry route" yields none. By callers:
- Zero callers in bin, ts and aut: `acp` and `voice`. `voice` is a stub that prints "planned for a future release" and exits 0 (case `voice)` in `autonomy/loki`): the strongest removal candidate. `acp` is not dead: its case label execs `autonomy/acp-agent.py` and it is documented in `docs/acp-editors.md` and `docs/CLI-REFERENCE.md`; it only has no internal caller.
- One caller: `backup`, `secrets` (its case branch calls `cmd_secrets "$@"`), `watchdog`, `open`.
- Two callers: `restore`, `models`, `import`, `council`.
- Three callers: `keys` (all in ts), `cancel`, `logs`, `factory`, `agents`, `dogfood`.
- `self-update` has no `self-update)` label under the pattern used (case 0) yet 18 aut lines; it is handled outside that pattern and needs a manual read before judging.

Low caller counts mean the command is user-facing only; they are not proof of deadness. Confirm with `grep -rn` over `tests/`, `docs/` and `completions/` before any removal.
