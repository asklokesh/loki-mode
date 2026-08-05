# V8: SDK-Based Runtime Migration Plan

Status: IMPLEMENTED (shipped on feature/v8-agent-sdk as v8.0.0 + v8.1; kept as design history)
Target branch: `feature/v8-agent-sdk`
Author: architecture spike (research-grounded, live SDK docs verified)
Scope: replace the bash `claude -p` wrapper with the Anthropic TypeScript SDKs. Codex/Cline/Aider stay on bash. This is a multi-week arc, not one workflow.

---

## 0. The one fact that reframes everything

Loki already has a full TypeScript port of the autonomous runner. It is not hypothetical and it is not a stub.

`loki-ts/src/runner/` contains 12,300 lines across 22 modules that mirror the bash runner byte-for-byte: `autonomous.ts` (983), `build_prompt.ts` (1582), `council.ts` (806), `quality_gates.ts` (2805), `providers.ts` (562), `rarv.ts`, `budget.ts`, `checkpoint.ts`, `completion.ts`, `state.ts`, etc. Many of these are explicitly "parity-locked" with their bash siblings (grep `run.sh` for "Parity-locked with ... loki-ts/src/runner").

The catch, verified at `autonomy/run.sh:17271`:

> "The claude provider in loki-ts/src/runner/providers.ts is implemented but is NOT reached for `start` (start is not ported to the Bun router; the shim falls through to bash), so its flag set has zero live impact today."

And the transport, `loki-ts/src/runner/providers.ts:305`: `const r = await shellRun(argv, ...)` - the TS runner shells out to the `claude` binary exactly like bash does.

So the v8 work is NOT "port 35k lines of bash to TypeScript." That port largely exists. The v8 work is two much smaller things:

1. **Finish wiring the existing TS runner into `loki start`** (the Bun router in `bin/loki` already routes ~8 commands to Bun and falls through to bash for the rest, including `start`).
2. **Swap the invocation transport inside that TS runner** from `shellRun(["claude", ...])` to the SDK: `query()` for the agentic loop, `messages.create()` for the one-shot judges.

This changes the shape, risk, and phasing of the whole migration. It is a transport swap inside an existing, parity-locked TS codebase, done incrementally behind the `LOKI_LEGACY_BASH` rollback flag that already exists.

---

## 1. Target architecture

### 1.1 Two SDKs, two layers (the split is real and load-bearing)

| Layer | What runs there | SDK | Why |
|---|---|---|---|
| **One-shot judges / graders** - code review (B1), completion council members (B3/B4), council-v2 (B5/B6), done-recognition (B7), PRD enrich (C1), grill (C2), USAGE regen (C3), doc-gen (C4), merge-conflict resolve (B8) | `@anthropic-ai/sdk` (raw Client SDK, `messages.create` / `messages.parse` / `messages.stream`) | Pure HTTPS to `api.anthropic.com`. **Zero binary.** One prompt in, one (optionally schema-constrained) JSON answer out. No tool loop, no filesystem, no subprocess. This is the honest `--bare` path. |
| **The autonomous RARV dev loop** (A1) and the migration/heal agentic execs (C5/C6/C7) | `@anthropic-ai/claude-agent-sdk` (`query()`) | Needs the built-in Read/Write/Edit/Bash/Glob/Grep tool loop, MCP, hooks, subagents, sessions. Reimplementing all of that on the raw SDK is exactly the wheel the Agent SDK exists to avoid. |

**This split is not gold-plating - it is forced by what each site needs.** A judge that returns one JSON verdict must not carry a filesystem-agent harness. A dev iteration that writes files agentically must not be hand-rolled on `messages.create`. The `providers/` abstraction already models a per-provider invoke; we add an SDK-backed claude invoker with two code paths keyed on a flag the runner already threads: `call.mainLoop` (agentic → Agent SDK) vs one-shot (raw SDK).

### 1.2 Who owns it: the existing loki-ts runner (do NOT start a new module)

The runner lives in `loki-ts/src/runner/`. It is parity-locked and mostly written. We do not create a parallel module and we do not move logic out of it. We:

- Add `loki-ts/src/runner/sdk_invoker.ts` - the SDK-backed replacement for the `shellRun(["claude", ...])` call inside `providers.ts` `claudeProvider()`. Same `ProviderInvoker` contract (`invoke(call): {exitCode, capturedOutputPath}`), so the runner above it does not change.
- Add `loki-ts/src/runner/sdk_stream_parser.ts` - consumes typed `SDKMessage` objects and writes the same `.loki/state/agents.json`, `.loki/events.jsonl` hook events, and `.loki/metrics/result-cost-<iter>.json` that the ~350-line embedded Python stream-json parser writes today (`run.sh:17371+`). This is the one genuinely new piece of logic, and it is a translation of an existing parser, not a new design.
- Finish the `bin/loki` router so `start` (and `heal`, `migrate`) route to Bun when the SDK path is enabled, and fall through to bash otherwise.

### 1.3 Honest correction to the founder premise: "no binary" is only true of the raw SDK

Verified from the unpacked `@anthropic-ai/claude-agent-sdk@0.3.207` tarball and live docs:

- **`@anthropic-ai/claude-agent-sdk` bundles and spawns a native Claude Code binary** (8 platform-specific `optionalDependencies`; `sdk.mjs` calls `spawn()`; `Options.pathToClaudeCodeExecutable` exists). It is Claude Code as a library, not a pure HTTP client. It removes the *separately-installed, interactively-authed, independently-versioned* CLI - but a native executable still runs as a child process.
- **`@anthropic-ai/sdk` (raw Client SDK, v0.111.0) is pure HTTPS. No binary.**

So the accurate strategic pitch (Section 3) is: **the judge layer (raw SDK) is genuinely binary-free; the dev-loop layer (Agent SDK) replaces the unmanaged PATH CLI with a bundled, version-pinned, API-key-authed one.** Both deliver "no `claude auth`, no CLI install step, no runtime flag drift." Only the raw-SDK layer delivers "literally zero binary." State it that way to the founder - a reviewer will catch "no binary at all" and it is not true of the Agent SDK.

### 1.4 Model IDs (verified against live model catalog, replacing the placeholders in the codebase)

The codebase memory lists placeholder model names. The live, correct IDs to wire in:

| RARV tier | Model ID | Used for |
|---|---|---|
| planning / architecture | `claude-opus-4-8` | Opus tier - planning, devil's advocate, requirements-verifier |
| development / execution | `claude-sonnet-5` | Sonnet tier - the main dev loop default (`LOKI_SESSION_MODEL`), test-auditor |
| fast / unit / simple judges | `claude-haiku-4-5` | Haiku tier - council members, convergence-voter, USAGE regen |

Effort maps directly: `output_config.effort` / Agent SDK `effort` supports `low|medium|high|xhigh|max`. `xhigh` is the recommended default for coding/agentic work on Sonnet 5 / Opus 4.8.

---

## 2. Feature-preservation matrix ("lose nothing")

Every capability the bash route uses today, and how v8 preserves or enhances it. Nothing is silently dropped. Grounded in `autonomy/run.sh:17195-17369`, `lib/claude-flags.sh`, and the two SDKs' verified APIs.

| # | Claude Code capability today | Bash site | v8 preservation | E = enhancement |
|---|---|---|---|---|
| 1 | Agentic tool-use loop (RARV dev iteration) | `run.sh:17365` `-p` + stream-json | Agent SDK `query()` runs the loop; consume `SDKMessage` stream | E: typed messages replace ~350-line stdout parser |
| 2 | Built-in tools Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch | implicit in `claude -p` | Agent SDK ships them; gate via `allowedTools` | E: adds `Monitor` (watch background script), not available today |
| 3 | `--dangerously-skip-permissions` | `run.sh:17195` | `permissionMode: 'bypassPermissions'` | - |
| 4 | `--allowedTools` least-privilege allowlist | `run.sh:11003` (review) | `allowedTools: [...]` | note: SDK `allowedTools` = auto-approve, not restrict; use `disallowedTools` to actually block |
| 5 | `--disallowedTools` reviewer denylist | council/grill | `disallowedTools: ["Bash(rm *)", ...]` | E: scoped patterns block even under bypass - stronger than today |
| 6 | Subagents `--agents <json>` | `voter-agents.sh:284` | `agents: Record<string, AgentDefinition>` + `Agent` in allowedTools | E: typed AgentDefinition; delete the `VOTE:` regex fallback (structured output guaranteed) |
| 7 | Hooks (SessionStart/PreToolUse/Stop) | `.claude/settings.json`, migration-hooks | Agent SDK `hooks: {...}` in-process callbacks | E: healing hooks run in-process with structured input, not shelled scripts |
| 8 | MCP `--mcp-config` / `--strict-mcp-config` | `run.sh:4166` | Agent SDK `mcpServers: {...}` + `strictMcpConfig`; raw SDK `mcp_servers` (beta `mcp-client-2025-11-20`) | Loki's own `mcp/server.py` (34 tools) plugs in unchanged |
| 9 | `--append-system-prompt` (autonomy override) | `run.sh:17200` | Agent SDK `systemPrompt: {preset:'claude_code', append}`; raw SDK `system:"..."` | - |
| 10 | `--setting-sources user,project,local` | `run.sh:17210` | Agent SDK `settingSources: ['user','project','local']` | 1:1 |
| 11 | CLAUDE.md auto-discovery | implicit | Agent SDK loads it when `settingSources` includes source | E: native; the bash route fights CLAUDE.md via `--append-system-prompt` |
| 12 | Prompt caching | implicit | Agent SDK: managed by harness. Raw SDK: manual `cache_control` breakpoints | E: the inert `[CACHE_BREAKPOINT]` marker in `build_prompt` can finally set real `cache_control` on the stable prefix |
| 13 | `--json-schema` structured output | `done-recognition.sh:66`, `council-v2.sh:312`, `voter-agents.sh` | raw SDK `output_config:{format:{type:'json_schema',schema}}` / `messages.parse()`; Agent SDK `outputFormat:{type:'json_schema',schema}` | E: `messages.parse()` validates + types the result; deletes `cr-rematerialize.py` re-materialization step |
| 14 | `--effort` per RARV tier | `run.sh:17307` | raw SDK `output_config.effort`; Agent SDK `effort` | 1:1 (`low..max`) |
| 15 | **`--max-budget-usd` per-call backstop** | `run.sh:17315` | **NO per-call USD cap primitive in either SDK.** Keep Loki's own cumulative `check_budget_limit` PAUSE gate (already ported: `loki-ts/src/runner/budget.ts`). Nearest SDK primitive: `output_config.task_budget` (TOKENS, beta `task-budgets-2026-03-13`) or Agent SDK `maxBudgetUsd` field | **REAL GAP - see Risks §8.** Agent SDK exposes `maxBudgetUsd` per docs; raw SDK does not. Convert USD estimate to token `task_budget` on the judge path, keep the deterministic budget gate on both. |
| 16 | `--fallback-model` | `run.sh:17323` | Agent SDK `fallbackModel` field; raw SDK: catch overload error + retry with fallback model, or server-side `fallbacks` (Fable-5-only beta - not applicable to Opus/Sonnet tiers) | verify Agent SDK `fallbackModel` before relying (Risks §8) |
| 17 | Session resume `--resume`/`--fork-session`/`--session-id` | `run.sh:17239` | Agent SDK `resume`, `forkSession`, `sessionId`, `continue`, `persistSession`, `resumeSessionAt` | E: `resumeSessionAt` (resume at a message UUID) finer than CLI; `listSessions()`/`getSessionMessages()` replace `~/.claude` JSONL filename-scraping for dashboard correlation |
| 18 | Streaming `stream-json --verbose` + `--include-partial-messages` | `run.sh:17366` | Agent SDK `query()` async iterator; `includePartialMessages`; `includeHookEvents` | E: dashboard stream parser replaced by typed message objects |
| 19 | `--bare` cheap-subcall mode | `claude-flags.sh:147` | raw SDK IS the bare path - one HTTP call, no discovery. The `--bare` OAuth-vs-keychain gymnastics (`claude-flags.sh:157-185`) vanish | E: always `ANTHROPIC_API_KEY`, no OAuth branch |
| 20 | Model selection `--model` (tiers) | `run.sh:17195` | Agent SDK `model:'opus'/'sonnet'/'haiku'` or full ID; raw SDK `model:"claude-opus-4-8"` | 1:1 |
| 21 | `claude auth status` preflight | `run.sh:2169`,`2382` | replaced by "is `ANTHROPIC_API_KEY` set?" (or Bedrock/Vertex/Foundry env). Third-party products may NOT use claude.ai login | E: auth-preflight branch (`run.sh:2355-2456`) collapses to a key check |
| D1 | `claude ultrareview` (native cloud review) | `loki:18013` | **NO SDK equivalent.** Keep the binary for this command OR reimplement as an Agent SDK multi-agent workflow | BLOCKER - see §2.1 |
| D2 | `claude -p "ultracode: ..."` (Dynamic Workflows) | `loki:18137` | **NO SDK equivalent.** Same options as D1 | BLOCKER |
| D3 | `claude remote-control` (cockpit) | `loki:23619` | **NO SDK equivalent** (long-lived interactive exec). Keep the binary | BLOCKER |
| D4 | quick-start `claude --dangerously-skip-permissions` (literal launcher) | `loki:13274` | printed entrypoint for humans; keep as-is or point at `claude` if installed | cosmetic |

### 2.1 The Cluster-D landmine (the real "lose no features" risk)

`ultrareview`, `ultracode`/Dynamic Workflows, and `remote-control` are native Claude Code *CLI subcommands* with no `@anthropic-ai/sdk` or `@anthropic-ai/claude-agent-sdk` equivalent. Two honest options, decided before claiming zero-binary deployment:

- **(a) Carve-out (recommended for v8):** keep the `claude` binary available for exactly these three commands; everything else goes SDK. The SaaS/enterprise win (Section 3) still lands for the 99% hot path (RARV loop + judges); these three are power-user/interactive commands rarely run in a headless container.
- **(b) Reimplement** each as an Agent SDK multi-agent workflow (`ultrareview` → a review subagent fan-out; `ultracode` → a planned Agent SDK workflow). Large, deferrable, out of the v8 critical path.

The plan proceeds with (a). D1-D4 are explicitly OUT of the v8 phases below and tracked as a separate arc. This must be stated to the founder: "zero binary" is true of the hot path, not of these three commands, unless we fund option (b).

---

## 3. Enterprise / SaaS deployment section (the headline win, made concrete)

The strategic win is real, with the §1.3 correction applied. Three concrete deletions and three concrete gains.

### 3.1 What gets deleted from the deployment surface

1. **No CLI install step.** Today a container needs the `claude` binary installed and on PATH (`curl | sh`, PATH wiring in the Dockerfile). With the raw SDK: `npm install @anthropic-ai/sdk` - pure JS, no native dep. With the Agent SDK: `npm install @anthropic-ai/claude-agent-sdk` - the platform binary ships as a pinned optional dependency inside the package; still no separate install step, no PATH wiring.
2. **No interactive login.** The bash route runs `claude auth status` preflight and branches on OAuth vs keychain (`run.sh:2355-2456`, `claude-flags.sh:157-185`). Both SDKs authenticate from `ANTHROPIC_API_KEY` (or Bedrock `CLAUDE_CODE_USE_BEDROCK=1` + `ANTHROPIC_AWS_WORKSPACE_ID`, Vertex `CLAUDE_CODE_USE_VERTEX=1`, Foundry `CLAUDE_CODE_USE_FOUNDRY=1`). No `claude login`, no `~/.claude/.credentials.json` dance. Third-party products may NOT use claude.ai subscription login via the SDK - API-key/cloud-provider only. This deletes the entire auth-preflight branch.
3. **No runtime CLI-version drift.** Today Loki greps `claude --help` at runtime to feature-detect `--json-schema`/`--agents`/`--effort`/`--fallback-model` (`claude-flags.sh:120-136`, `loki_claude_flag_supported` gating ~10 flags) precisely *because* the external CLI drifts. The SDK either has the typed option or it does not - no `--help` grep. The whole capability-probe layer (`lib/claude-flags.sh`) plus ~12 `command -v claude` presence probes and the `pkill claude` cleanup disappear.

### 3.2 The three concrete gains for Autonomi SaaS

1. **Multi-tenant by env injection.** Per-tenant `ANTHROPIC_API_KEY` (or per-tenant Bedrock workspace via `ANTHROPIC_AWS_WORKSPACE_ID`) injected as env at container spawn. One image, no per-container CLI provisioning, no per-tenant `claude login`.
2. **Deterministic packaging / reproducible builds.** `loki@X ⇒ @anthropic-ai/sdk@Y` (judges) and `⇒ @anthropic-ai/claude-agent-sdk@Z ⇒ pinned binary@Z` (loop). No "works-on-my-CLI-version." The Agent SDK pins its own binary to its package version in `package.json`.
3. **Richer structured telemetry, no stdout scraping.** Result messages carry `total_cost_usd`, `usage` (incl. cache read/creation), `modelUsage`, `num_turns`, `duration_ms`, `permission_denials`. The dashboard reads a typed object instead of the embedded Python stream-json parser (`run.sh:17371+`).

### 3.3 The honest asterisk (must appear in the founder deck)

The Agent SDK layer still spawns a bundled native binary per container. The accurate claim is **"no unmanaged, separately-installed, interactively-authed, independently-versioned CLI"** - not "no binary at all." The judge layer (raw SDK) IS literally binary-free. If the founder needs literally-zero-binary for the whole runtime, the fork is: run the RARV loop on the raw SDK too and re-own the tool loop (which `run_autonomous` + the 8 gates + council mostly already own) - larger, and evaluated as a future arc, not v8.

---

## 4. Phases (ordered by value / risk / dependency)

Each phase is a discrete, agent-sized, independently-shippable unit with parity + rollback. The `LOKI_LEGACY_BASH=1` flag and the per-command `bin/loki` router already exist, so every phase ships behind a flag with bash as the live fallback until SDK-proven.

Guiding principle: **judges before the loop.** The one-shot judges (raw SDK) are low-risk, high-parity-testability (deterministic verdict comparison), and prove the SDK bridge end-to-end without touching the RARV hot path. Do them first. The Agent SDK loop is last and hardest.

### Phase 0 - Spikes (no production code; de-risk the unknowns)

- Spike A: `bun add @anthropic-ai/claude-agent-sdk`, run a trivial `query()` under Bun 1.3.13. Confirm Bun resolves the platform-gated optionalDependencies and spawns the bundled binary. If it fails, the loop runs under Node while judges stay on Bun. **This gates Phase 4's runtime choice.**
- Spike B: confirm `@anthropic-ai/sdk` `messages.parse()` + `output_config.format` produces the exact JSON shape `loki-ts/data/done-recognition-schema.json` expects.
- Spike C: confirm Agent SDK `maxBudgetUsd` and `fallbackModel` fields exist in `sdk.d.ts@0.3.207` (research flagged `fallbackModel` present, `maxBudgetUsd` present; `--max-budget-usd` has no raw-SDK analog).
- Verification: a throwaway script per spike; no `.loki/` writes; results recorded in the phase's PR description.
- Rollback: n/a (no production code).

### Phase 1 - done-recognition on the raw SDK (the bridge proof)

**Smallest real SDK adoption that proves the bridge end-to-end.** done-recognition (B7) is CLAUDE-ONLY (no provider sibling to keep in sync), one prompt → one schema-constrained JSON answer, already has an inline schema (`loki-ts/data/done-recognition-schema.json`), and fails inconclusive-safe. Perfect first target.

- Files touched: `loki-ts/src/runner/sdk_invoker.ts` (new, judge path only), `autonomy/lib/done-recognition.sh` (add an SDK branch gated behind `LOKI_SDK_DONE_RECOG=1`, keeping the `claude`/deterministic fallback), `loki-ts/data/done-recognition-schema.json` (reused as-is).
- Stays on bash (fallback): the existing `claude -p --json-schema` path and the deterministic fallback, both live when the flag is off.
- Moves to SDK: the LLM call becomes `@anthropic-ai/sdk` `messages.parse()` with `output_config.format` + the existing schema, `model: claude-haiku-4-5`, `effort: low`.
- Parity proof: run both routes (`LOKI_SDK_DONE_RECOG=0` vs `=1`) over a fixed corpus of `.loki` states; the parsed `requirements` verdict object must match. Wire into `local-ci.sh` bun-parity matrix.
- Rollback: unset `LOKI_SDK_DONE_RECOG`. One env var. Zero blast radius (single CLAUDE-ONLY helper).

### Phase 2 - the rest of the one-shot judges on the raw SDK

Extend `sdk_invoker.ts`'s judge path to the remaining single-shot sites, one PR per cluster, each behind its own flag with the bash arm intact:

- 2a: council-v2 reviewers (B5/B6) - `council-v2.sh`, schema `loki-ts/data/council-v2-schema.json`. Delete the sed-carving text fallback (structured output guaranteed).
- 2b: completion-council members + devil's advocate (B3/B4) - `completion-council.sh`. Replace `VOTE:` regex parsing with `messages.parse()`.
- 2c: code-review 3-reviewer (B1) - `run.sh:11035`, schema `loki-ts/data/code-review-schema.json`. Deletes the `cr-rematerialize.py` re-materialization to legacy `VERDICT:` text.
- 2d: aux helpers - PRD enrich (C1), grill (C2), USAGE regen (C3), doc-gen (C4), merge-conflict resolve (B8). All captured-text, no schema.
- Files: the six `.sh`/`run.sh` sites above + `sdk_invoker.ts`. Codex/Cline/Aider `case` arms untouched.
- Parity proof: verdict/text comparison per cluster over a fixed corpus; council decisions must be identical.
- Rollback: per-cluster env flag; bash arm live throughout.

### Phase 3 - the council as a single-dispatch Agent SDK `agents` call (the cleanest enhancement)

`voter-agents.sh:284` already fans out to N named reviewers in one `claude --agents <json>` call. This maps 1:1 to Agent SDK `agents: Record<string, AgentDefinition>`.

- Files: `loki-ts/src/runner/council.ts` (already ported), `autonomy/lib/voter-agents.sh` (SDK branch behind flag), schema `loki-ts/data/finding-schema.json`.
- Moves to SDK: the Python-generated `agents_json` becomes a typed `Record<string, AgentDefinition>`; `--json-schema` becomes `outputFormat`. KEEP the decision engine (effective-threshold floor, exact-quorum gate, devil's-advocate override, transcript writing) - none of that is an SDK concept.
- Parity proof: `.loki/council/votes/round-<iter>.json` must match across routes over a corpus.
- Rollback: flag; bash `--agents` arm and the heuristic council fallback both stay.
- Note: this is the first use of the Agent SDK (bundled binary). If Spike A found Bun can't spawn it, this phase and Phase 4 run under Node.

### Phase 4 - the RARV main loop on the Agent SDK (the hot path, highest risk, done last)

The single hardest site (A1). Replace `shellRun(["claude", ...stream-json...])` in `providers.ts` `claudeProvider()` with `query()`.

- Files: `loki-ts/src/runner/providers.ts` (claude mainLoop path → `sdk_invoker.ts` agentic path), `loki-ts/src/runner/sdk_stream_parser.ts` (new - translates the embedded Python stream-json parser: writes `.loki/state/agents.json`, `.loki/events.jsonl` hook events, `.loki/metrics/result-cost-<iter>.json`), `bin/loki` (route `start` to Bun when `LOKI_SDK_LOOP=1`).
- KEEP unchanged: `run_autonomous` outer loop, `build_prompt()` (parity-locked; consumed as `query({prompt})`), all 8 quality gates + evidence/checklist/heldout/assumption gates, the completion council, `.loki/` state machine, the stateless-per-iteration session design. **RARV-C is NOT replaced by any SDK primitive** (verified: no `outcome`/iterate-until-done primitive in the Agent SDK; `maxTurns`/`maxBudgetUsd`/`taskBudget` bound ONE call, not the grader loop).
- Flag mapping: `--model`→`model`, `--effort`→`effort`, `--append-system-prompt`→`systemPrompt:{preset:'claude_code',append}`, `--setting-sources`→`settingSources`, `--include-partial-messages`→`includePartialMessages`, `--dangerously-skip-permissions`→`permissionMode:'bypassPermissions'`, `--session-id`/`--resume`/`--fork-session`→`sessionId`/`resume`/`forkSession`. `--max-budget-usd`→ keep the deterministic budget gate + `maxBudgetUsd` if verified (Spike C). `--fallback-model`→`fallbackModel` if verified, else catch-and-retry.
- Enhancement to fold in: split the inert `[CACHE_BREAKPOINT]` in `build_prompt` and set real `cache_control` on the stable prefix (the migration is the moment this becomes possible).
- Parity proof: run a fixed PRD corpus through both routes (`LOKI_SDK_LOOP=0` vs `=1`); compare per-iteration cost/usage, gate outcomes, and completion decision. This is the phase that needs the `sdlc-fleet` council (3 Opus/Sonnet reviewers, unanimous APPROVE) per `CLAUDE.md`.
- Rollback: `LOKI_SDK_LOOP=0` or `LOKI_LEGACY_BASH=1` → `start` falls through to bash. Bash route stays the canonical route until this is SDK-proven across the discriminator corpus.

### Phase 5 - agentic exec sites + probe/cleanup deletion

- Migration/heal execs (C5/C6/C7) → Agent SDK `query()` (same agentic path as Phase 4), behind flags, bash arms intact.
- Delete the now-dead capability layer: `lib/claude-flags.sh` `loki_claude_flag_supported`, the `claude --help` cache, ~12 `command -v claude` probes, `claude --version` calls, `pkill claude` - but ONLY on the SDK route; the bash route still needs them until every phase is proven and the bash route is retired (a later decision, not v8).
- Rollback: flags per site.

### Phase 6 (later arc, NOT v8) - Cluster D + bash-route retirement

`ultrareview`/`ultracode`/`remote-control` reimplementation (or documented binary carve-out), and the eventual removal of the bash route once all SDK phases are proven in production. Explicitly out of v8 scope.

---

## 5. Per-phase: bash vs SDK vs parity vs rollback (summary)

| Phase | Stays on bash (fallback) | Moves to SDK | Parity proof | Rollback flag |
|---|---|---|---|---|
| 1 | done-recog `claude`+deterministic | raw SDK `messages.parse` | verdict object match over corpus | `LOKI_SDK_DONE_RECOG` |
| 2 | all six judge `case` arms (+ codex/cline/aider) | raw SDK judges | per-cluster verdict/text match | per-cluster flag |
| 3 | `--agents` + heuristic council | Agent SDK `agents` | votes/round-N.json match | council SDK flag |
| 4 | full bash RARV route | Agent SDK `query()` loop | cost/gate/completion match over PRD corpus | `LOKI_SDK_LOOP` / `LOKI_LEGACY_BASH` |
| 5 | migration/heal `case` arms | Agent SDK `query()` | display/output equivalence | per-site flag |

In every phase the codex/cline/aider `case` arms are untouched, and bash is the live route until the SDK route passes parity in `local-ci.sh`.

---

## 6. RARV-C / council / memory → SDK primitives (honest mapping)

| Component | Verdict | Grounding |
|---|---|---|
| RARV-C outer loop (`run_autonomous`) | **KEEP** - no SDK primitive replaces it | No `outcome`/iterate-until-grader-says-done in the Agent SDK (verified live). Managed Agents' Outcomes (`user.define_outcome` + rubric, hosted REST) is the nearest analog but is a **different product** - hosting completion on Anthropic's grader would cede Loki's council. Do NOT wire it. |
| The 8 quality gates + evidence/checklist/heldout/assumption gates | **KEEP** - deterministic graders, zero SDK equivalent | Loki's trust moat. Already ported: `quality_gates.ts`. |
| `build_prompt()` | **KEEP verbatim** - SDK consumes its string | Parity-locked with `build_prompt.ts`. `[CACHE_BREAKPOINT]` becomes a real `cache_control` split (E). |
| Completion council dispatch | **WRAP** - `--agents`→`agents`, `--json-schema`→`outputFormat` | Cleanest SDK fit. Delete `VOTE:` regex fallback. KEEP threshold-floor/quorum/devil's-advocate. |
| `memory/` package (15 modules) | **KEEP** - richer than any SDK memory feature | SDK `AgentDefinition.memory` is a source selector, not task-aware top-k retrieval / episodic→semantic consolidation / anti-pattern retrieval / cross-project RAG. Retrieved text still flows into `prompt` (or `systemPrompt.append` for better prefix-cache). **Preserve `rag_injector.py` sanitization** - the SDK does not sanitize stored memory (prompt-injection property). |
| `memory/managed_memory/` | **KEEP** (already on `anthropic` SDK, default-OFF) | The one existing SDK touchpoint; gated on `LOKI_MANAGED_MEMORY=true`. Out of the critical path. |
| Session UUID + resume/fork | **WRAP** - field-for-field SDK options | KEEP stateless-per-iteration design. `resumeSessionAt`/`listSessions` are E wins. |

The founder's "SDK outcome may map onto RARV-C" hypothesis is **false per live docs**. The SDK gives a bounded tool-use loop; the iterate-until-council-says-done loop stays Loki's. This is a WRAP-the-invocation migration, not a re-architecture.

---

## 7. Provider-agnosticism (where Anthropic-only forces a claude-gated path)

Both SDKs are Anthropic-specific. 18 of 25 model-work sites already branch to codex/cline/aider in the same `case`. The v8 SDK port replaces ONLY the `claude)` arm; the sibling arms keep their bash invocation:

- Codex: `codex exec --sandbox workspace-write` (`CODEX_MODEL_REASONING_EFFORT` env). Ported model in `providers.ts` codex arm.
- Cline: `invoke_cline` / `cline -y`.
- Aider: `aider --message ... --yes-always`.

The provider loader gates the SDK path on `LOKI_PROVIDER=claude`. The 7 CLAUDE-ONLY sites (B7, C1, C3, D1-D4) have no cross-provider story today and gain none from v8. An OpenAI-compatible layer (Codex/Cline via a shared HTTP client) is a **LATER arc, explicitly out of scope here**. The bash route staying alive per-piece IS the multi-provider + rollback fallback until each SDK piece is proven.

---

## 8. Risks + unknowns (spikes needed)

All UNVERIFIED items from the research, plus what the phases surface:

1. **Bun + Agent SDK bundled binary (Spike A, gates Phase 3/4).** Whether Bun 1.3.13 resolves the platform-gated `optionalDependencies` and spawns the bundled `claude` binary cleanly is unverified. If not: loop under Node 22+, judges under Bun (raw SDK is pure JS, Bun-safe). Test before choosing the loop runtime.
2. **`--max-budget-usd` has NO raw-SDK equivalent (§2 #15).** Confirmed absent from `messages.create`. Agent SDK exposes `maxBudgetUsd` per research; verify in `sdk.d.ts@0.3.207` (Spike C). Regardless, keep Loki's deterministic cumulative budget gate (`budget.ts`) on both paths - do not delegate budget enforcement to the SDK.
3. **`--fallback-model` (§2 #16).** Agent SDK `fallbackModel` field reported present but not code-verified; raw SDK has no per-call fallback field for Opus/Sonnet (server-side `fallbacks` is Fable-5-only beta). Implement catch-and-retry on the judge path as the safe default; use `fallbackModel` on the loop path only after Spike C confirms it.
4. **UNVERIFIED SDK type shapes.** `SDKAssistantMessage`/`SDKPartialAssistantMessage` content-block shapes, `ThinkingConfig` union, `CanUseTool` options - the fields exist but inner shapes must be re-read from `sdk.d.ts@0.3.207` before writing the stream parser (Phase 4). The verified `.d.ts` is at `scratchpad/package/sdk.d.ts`.
5. **Only one valid `SdkBeta`** (`context-1m-2025-08-07`). Other API betas (compaction, fast-mode) are not first-class Agent SDK options. If a phase needs one, it may require the raw SDK path instead.
6. **Bedrock/Vertex/Foundry env pass-through** through the Agent SDK `env` option is documented at overview level, not shown as a `query()` example - smoke-test before promising enterprise cloud auth in the SaaS pitch.
7. **Cluster D (§2.1)** - `ultrareview`/`ultracode`/`remote-control` have no SDK equivalent. v8 keeps the binary carve-out; "zero binary" is hot-path-only until a later arc reimplements them.
8. **Managed Agents temptation.** It IS the hosted grader/outcome loop the founder hypothesized, but adopting it cedes Loki's council and re-platforms completion onto Anthropic's grader. Deliberately NOT wired in v8. Flag if the founder wants to reconsider - it is a strategy decision, not a migration step.
9. **Model-name drift.** The codebase memory carries placeholder model names; wire the verified live IDs (`claude-opus-4-8` / `claude-sonnet-5` / `claude-haiku-4-5`, §1.4). Re-verify against the live model catalog at implementation time (IDs evolve).

---

## 9. The first implementable work item (concrete enough to start)

**Phase 1: migrate done-recognition to the raw SDK behind `LOKI_SDK_DONE_RECOG=1`.**

Preconditions: run Spike A/B/C first (they are cheap throwaway scripts and de-risk the whole arc). Then:

1. `cd loki-ts && bun add @anthropic-ai/sdk` (pure JS, Bun-safe - no binary).
2. Create `loki-ts/src/runner/sdk_invoker.ts` exporting a judge function:
   - Input: `{ prompt: string, schemaPath: string, model: string, effort: string, timeoutMs: number }`.
   - Body: `const client = new Anthropic()` (reads `ANTHROPIC_API_KEY`); `client.messages.create({ model, max_tokens: 16000, output_config: { format: { type: 'json_schema', schema } }, messages: [{ role: 'user', content: prompt }] })`; parse the single text block as JSON (guaranteed valid by `output_config.format`). Model `claude-haiku-4-5`, effort `low`.
   - Return the parsed object; on any error, throw so the caller falls to the deterministic path (inconclusive-safe, matching current behavior).
   - Load the schema from `loki-ts/data/done-recognition-schema.json` (already exists; do not invent a schema).
3. In `autonomy/lib/done-recognition.sh`, add a branch at the top of the invoke helper: if `LOKI_SDK_DONE_RECOG=1` and `ANTHROPIC_API_KEY` is set, shell into `bun loki-ts/... internal done-recog-sdk "$prompt"` (a thin `internal` subcommand wrapping the judge function); otherwise keep the existing `claude -p --json-schema` → deterministic fallback chain exactly as-is.
4. Parity harness: a script that runs the same fixed set of `.loki` states through both `LOKI_SDK_DONE_RECOG=0` and `=1`, asserts the parsed `requirements` verdict object is equal, and cleans up. Add it to `scripts/local-ci.sh`'s bun-parity matrix.
5. Do NOT bump version, do NOT commit, do NOT touch any other site. One helper, one flag, one parity test.

This proves the entire bridge (SDK auth from env, structured output via `output_config.format`, schema reuse, bash-fallback rollback, parity testing) on the single lowest-risk CLAUDE-ONLY site before anything touches the RARV hot path.

---

## Appendix: verified sources

- Agent SDK types: unpacked `@anthropic-ai/claude-agent-sdk@0.3.207` `sdk.d.ts` (6923 lines) at `scratchpad/package/sdk.d.ts`.
- Raw SDK: `@anthropic-ai/sdk@0.111.0`; `messages.parse` / `output_config.format` / `task_budget` / model IDs from the live claude-api skill (authoritative for API shapes).
- Installed `claude` CLI: v2.1.207.
- Existing TS runner: `loki-ts/src/runner/` (12,300 lines, parity-locked, NOT reached for `start` per `run.sh:17271`).
- Bash invocation surface: `autonomy/run.sh:17195-17369`, `lib/claude-flags.sh`, `lib/done-recognition.sh`, `lib/prd-enrich.sh`, `completion-council.sh`, `council-v2.sh`, `grill.sh`, `lib/voter-agents.sh`, `providers/claude.sh`.
- Existing rollback flag + router: `bin/loki` (`LOKI_LEGACY_BASH`, per-command Bun routing).
- Model IDs: live catalog - `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5`.

---

# Part B: Build-Ready Implementation Specs (per-phase, codeable)

Status: BUILD-READY. Written against verified source on this branch (`feature/v8-agent-sdk`).
This part supersedes the phase sketches in Section 4 where they conflict; Section 4 stays as the
strategic map. All line numbers re-verified against the working tree; re-grep before editing (they drift).

## B.0 Ground-truth delta (what already exists on this branch vs the Section-4 sketch)

The Section-4 phasing assumed nothing was wired. Verified on-branch, several pieces are ALREADY BUILT.
The specs below say "complete" or "extend", not "create from scratch", where that is the true state.

| Piece | Status on branch | Anchor |
|---|---|---|
| `judgeJson()` raw-SDK judge | DONE (+ unit test) | `loki-ts/src/runner/sdk_invoker.ts`; `loki-ts/tests/runner/sdk_invoker.test.ts` |
| `loki internal sdk-judge` bridge | DONE (fail-closed, exit 0/1/2/3) | `loki-ts/src/commands/internal_sdk_judge.ts`; dispatch `loki-ts/src/cli.ts:264` |
| `internal` routes to Bun | DONE | `bin/loki:263` |
| done-recognition SDK branch (`LOKI_SDK_DONE_RECOG=1`) | DONE (runs BEFORE `command -v claude` guard) | `autonomy/lib/done-recognition.sh:54-85` |
| council-v2 SDK branch (`LOKI_SDK_COUNCIL_V2=1`) | DONE | `autonomy/council-v2.sh:284-305` |
| done-recognition schema | DONE | `loki-ts/data/done-recognition-schema.json` |
| council-v2 / code-review schemas | DONE | `loki-ts/data/{council-v2,code-review}-schema.json` |
| `cr-rematerialize.py` (JSON envelope -> legacy VERDICT/FINDINGS text) | DONE | `autonomy/lib/cr-rematerialize.py` |
| structural bridge test (no billable call) | DONE | `tests/test-sdk-done-recog-bridge.sh` (85 lines) |
| **verdict-EQUALITY parity over a real corpus** | **MISSING** | -- Phase 1 gap |
| **`cache_control` on the judge prefix** | **MISSING** (`judgeJson` sets none; `sdk_invoker.ts` has zero `cache`) | -- Phase 1 enhancement |
| code-review site SDK branch (Phase 2c) | MISSING | `autonomy/run.sh:11027-11048` |
| completion-council members SDK branch (Phase 2b) | MISSING | `autonomy/completion-council.sh` |
| council Agent-SDK dispatch (Phase 3) | MISSING | `autonomy/lib/voter-agents.sh` |
| RARV loop on Agent SDK (Phase 4) | MISSING | `loki-ts/src/runner/providers.ts` |

**Honest reframing of the deliverable:** Phase 1's *code path* is already end-to-end. Phase 1 is NOT
"done" because it has (a) no verdict-equality proof against real model output, and (b) does not yet
realize the cost thesis (no `cache_control`). B.1 closes exactly those two gaps. This is the correct,
non-fabricated status.

## B.1 Phase 1 COMPLETE -- prove + optimize the done-recognition bridge

The branch runs the SDK judge; two things make it *complete and testable*.

### B.1.1 (gap) Verdict-equality parity test over a corpus of `.loki` states

The existing `tests/test-sdk-done-recog-bridge.sh` is STRUCTURAL only (asserts wiring, fail-closed,
branch ordering; no model call). It does not prove the SDK route and the claude route reach the SAME
verdict. That proof is the whole point of "parity + rollback per phase".

**Design (billable, opt-in, cheap).** The judge is a pure `prompt -> schema-JSON` function. Parity does
NOT require running the full `reuse_done_recognition_gate` twice; it requires: for each corpus prompt,
call `loki internal sdk-judge` (SDK route) and `claude -p --json-schema` (claude route), then compare the
verdict the SAME downstream parser derives from each. Compare the DERIVED verdict, not raw JSON bytes
(two valid judgments can differ in prose but must not differ in verdict/coverage).

New file `tests/corpus/done-recog/*.json` (3-5 fixtures): each is `{ "prompt": "<full DR prompt>",
"expect": "done|incomplete|inconclusive" }`. Build them by capturing real prompts from
`reuse_done_recognition_gate` on 3-5 tiny throwaway projects (one already-satisfied, one half-built,
one unbuildable) via a `LOKI_DONE_RECOG_DUMP_PROMPT=<path>` hook added at `done-recognition.sh:335`
(one line: `[ -n "${LOKI_DONE_RECOG_DUMP_PROMPT:-}" ] && printf '%s' "$prompt" > "$LOKI_DONE_RECOG_DUMP_PROMPT"`).

New file `tests/test-sdk-done-recog-parity.sh` (billable; gated on `RUN_BILLABLE=1` + `ANTHROPIC_API_KEY`,
SKIP otherwise so `local-ci.sh` stays free):
```
for f in tests/corpus/done-recog/*.json; do
  prompt="$(jq -r .prompt "$f")"; expect="$(jq -r .expect "$f")"
  printf '%s' "$prompt" > "$pf"
  sdk_json="$("$LOKI" internal sdk-judge --prompt-file "$pf" --schema-file "$SCHEMA" \
              --model claude-haiku-4-5 --effort low)"                       # SDK route
  cli_env="$(CAVEMAN_DEFAULT_MODE=off claude --dangerously-skip-permissions -p "$prompt" \
              --json-schema "$(cat "$SCHEMA")" --output-format json)"        # claude route
  cli_json="$(printf '%s' "$cli_env" | jq -c '.structured_output // (.result|fromjson)')"
  # derive the verdict from EACH via the SAME parser done-recognition.sh uses (DR_PARSE_EOF).
  sdk_v="$(printf '%s' "$sdk_json" | LOKI_DR_TESTS=... python3 dr_parse.py)"
  cli_v="$(printf '%s' "$cli_json" | LOKI_DR_TESTS=... python3 dr_parse.py)"
  [ "$sdk_v" = "$cli_v" ] && [ "$sdk_v" = "$expect" ] && ok || bad
done
```
Refactor the inline `DR_PARSE_EOF` python heredoc (`done-recognition.sh:356-645`) into a standalone
`autonomy/lib/dr-parse.py` invoked by BOTH the shell gate and this test (one parser, no divergence --
same discipline `cr-rematerialize.py` already follows). This refactor is itself parity-preserving:
the gate's behavior is unchanged, the heredoc body just moves to a file it now execs.

Wire into `scripts/local-ci.sh`: run structural test always; run parity test only when `RUN_BILLABLE=1`.
Parity acceptance: SDK-derived verdict == claude-derived verdict on 100% of the corpus (verdict axis;
NOT prose). A single divergence blocks the phase.

### B.1.2 (enhancement) realize the cost thesis: `cache_control` on the judge prefix

VERIFIED: `judgeJson()` sets NO `cache_control` (`sdk_invoker.ts` has zero `cache` tokens), and the
`[CACHE_BREAKPOINT]` marker (`build_prompt.ts:1362,1425`; `run.sh:15280,15327`) is inert documentation.
The raw SDK is where a real breakpoint first becomes settable. The done-recognition prompt is
prefix-stable across the requirements it judges (system rubric + PRD + prior-claims header are constant;
only the tail varies), so a 1h ephemeral breakpoint on the stable head is a genuine, cited cost win
(cache-read 0.1x, 1h-write 2.0x, break-even 3 requests -- verified via the claude-api catalog).

Extend `JudgeParams` + `judgeJson()` (`sdk_invoker.ts`) with an OPTIONAL `system` broken into a cached
prefix. Two safe ways, both GA (no beta header -- verified: `output_config.format`/`effort`/`cache_control`
all GA on Opus 4.8 / Sonnet 5 / Haiku 4.5):
```ts
// Option A (precise): put the stable rubric as a system TextBlockParam with a 1h breakpoint.
system: systemPrefix
  ? [{ type: "text", text: systemPrefix, cache_control: { type: "ephemeral", ttl: "1h" } }]
  : undefined,
// Option B (simplest): top-level cache_control auto-marks the last cacheable block.
```
Use Option A: the judge's stable rubric is a natural, explicit prefix. Gate min-prefix: the Haiku/Opus
minimum cacheable prefix is 4096 tokens (catalog-verified) -- the ~8K rubric+PRD prefix clears it;
`sdk-judge` should pass the rubric via a new `--system-file` flag so the bash caller (which already holds
the rubric text) supplies it. Surface `usage.cache_read_input_tokens` on stderr behind
`LOKI_SDK_JUDGE_DEBUG=1` so the parity test can ASSERT cache hits on request 2+ (the observable proof the
optimization fired -- if it's 0 across identical-prefix calls, a silent invalidator is present).

**Parity guard for caching:** `cache_control` MUST NOT change the verdict (it only changes token
accounting). The B.1.1 corpus test already proves verdict-equality; run it once with caching on and once
off (`LOKI_SDK_JUDGE_CACHE=0`) and assert the verdict axis is identical across both -- caching is a
transparent cost lever, never a correctness lever.

### B.1.3 rollback
`unset LOKI_SDK_DONE_RECOG` (already the escape hatch). One env var, single CLAUDE-ONLY helper, zero
blast radius. `LOKI_SDK_JUDGE_CACHE=0` independently disables just the cache breakpoint.

---

## B.2 Phase 2 -- remaining one-shot judges on `judgeJson`, one cluster per flag

Each cluster: the SITE, its SCHEMA, the regex/sed PARSER it deletes, the FLAG, the PARITY proof.
All reuse the SAME `loki internal sdk-judge` bridge (already built) -- Phase 2 adds NO new TS, only new
`.sh` branches (mirroring the done-recognition/council-v2 pattern verbatim) plus, for code-review, reuse
of the existing `cr-rematerialize.py`.

### 2a. council-v2 reviewers -- ALREADY WIRED, needs its parity test
- Site: `autonomy/council-v2.sh:284-305` (branch DONE, `LOKI_SDK_COUNCIL_V2=1`).
- Schema: `loki-ts/data/council-v2-schema.json` (`verdict` enum APPROVE|REJECT + `issues[]`).
- Parser deleted-on-success: the sed-carve at `council-v2.sh:350+` (the `structured_output // fromjson`
  python slice). On SDK success the branch `echo "$_c2_sdk_out" > "$output_file"; return 0` bypasses it.
- Gap: same as B.1.1 -- add `tests/corpus/council-v2/*.json` + a billable parity test asserting the SDK
  verdict token equals the claude verdict token over the corpus. Flag already exists.
- Rollback: `unset LOKI_SDK_COUNCIL_V2`.

### 2b. completion-council members + devil's advocate (VOTE: regex -> schema)
- Site: `autonomy/completion-council.sh` -- the member/contrarian invokers whose output feeds
  `_council_parse_vote` (the word-bounded `VOTE:APPROVE|REJECT|CANNOT_VALIDATE` regex, `:1002-1004`;
  contrarian at `council_devils_advocate`, consumed `:814-816`).
- Schema (NEW): `loki-ts/data/completion-vote-schema.json` --
  `{ verdict: enum["APPROVE","REJECT","CANNOT_VALIDATE"], reasoning: string }`. Model MUST emit the same
  three tokens the regex accepts, so the DERIVED vote is identical.
- Parser deleted-on-success: nothing is *deleted* (the regex stays as fail-closed fallback); on SDK
  success the branch writes a `VOTE:<verdict>` line (re-materialized from JSON, one `printf`) so
  `_council_parse_vote` stays byte-identical -- the cr-rematerialize discipline applied to a 1-token
  verdict. This is the safest possible adoption: the downstream parser never changes.
- Flag: `LOKI_SDK_COMPLETION_COUNCIL=1`. Branch runs BEFORE the `command -v claude` guard (binary-free),
  identical shape to `done-recognition.sh:63-85`.
- Parity: corpus of captured member prompts; assert SDK-derived vote == claude-derived vote == expected,
  AND that a hedged/empty judgment still fails closed to REJECT on BOTH routes (the anti-sycophancy
  invariant at `:824` must not regress).
- Rollback: `unset LOKI_SDK_COMPLETION_COUNCIL`.

### 2c. code-review 3-reviewer (the highest-value delete: reuse cr-rematerialize)
- Site: `autonomy/run.sh:11027-11048` (the `--json-schema` claude branch + text fallback).
- Schema: `loki-ts/data/code-review-schema.json` (`verdict` PASS|FAIL + `findings[].severity`).
- Parser reused, NOT deleted: `autonomy/lib/cr-rematerialize.py` already converts a JSON envelope to
  legacy `VERDICT: X\nFINDINGS:\n- [sev] desc` text AND enforces the cross-field T1 safety rule
  (any Critical/High => force FAIL). The SDK branch feeds `judgeJson`'s object into the SAME
  rematerializer, so `_classify_verdict` / `_severity_is_blocking` / `_count_nonblocking_findings` /
  mergeability / DA arm / aggregate.json stay byte-identical. The ONE change vs 2a/2b: `sdk-judge` prints
  the BARE payload object (top-level `verdict`+`findings`), but `cr-rematerialize.py` reads an ENVELOPE --
  VERIFIED at `cr-rematerialize.py:49-58` it looks only at `env["structured_output"]` then `env["result"]`
  and raises `ValueError(5)` on a bare payload. So a raw `judgeJson` object would fail-close (safe, but
  the SDK path never engages). Fix WITHOUT touching the rematerializer: wrap the payload as an envelope in
  bash before piping it, so the adapter stays byte-identical:
  ```
  if [ "${LOKI_SDK_CODE_REVIEW:-0}" = "1" ]; then
      _cr_sdk_out="$("$LOKI" internal sdk-judge --prompt-file "$pf" \
          --schema-file "$_cr_schema" --model "${LOKI_SDK_JUDGE_MODEL:-claude-haiku-4-5}" --effort low)"
      if [ -n "$_cr_sdk_out" ]; then
          # wrap the bare payload as {structured_output: <payload>, stop_reason: "tool_use"}
          # so cr-rematerialize.py (:49) reads it unchanged; jq -n keeps it valid on any input.
          _cr_env="$(printf '%s' "$_cr_sdk_out" | jq -c '{structured_output: ., stop_reason: "tool_use"}' 2>/dev/null)"
          if [ -n "$_cr_env" ] \
             && _LOKI_CR_JSON="$_cr_env" _LOKI_CR_OUT="$review_output" python3 "$_cr_remat"; then
              return 0
          fi
      fi
      # fall through to the existing --json-schema claude branch (fail-closed)
  fi
  ```
  runs BEFORE the claude branch; on any miss (empty out, malformed, non-zero rematerialize) falls through
  unchanged. NEVER a PASS on a miss (the rematerializer is fail-closed by contract: exit 5 on no payload,
  exit 6 on missing verdict, and force-FAIL on any Critical/High finding). Alternative (if a new dep-free
  seam is preferred over `jq`): `sdk-judge` could grow an `--envelope` flag that prints
  `{"structured_output": <obj>, "stop_reason": "tool_use"}` itself -- but the bash wrap above needs no TS
  change and is the lazier correct fix.
- Flag: `LOKI_SDK_CODE_REVIEW=1`.
- Parity: corpus of captured review prompts + diffs; assert the re-materialized legacy text (hence the
  classified verdict, blocking severity, and mergeability score) is IDENTICAL across SDK and claude
  routes. This is the strongest parity signal in Phase 2 because both routes converge on the exact same
  `cr-rematerialize.py` output.
- Rollback: `unset LOKI_SDK_CODE_REVIEW`.

### 2d. aux helpers (captured-text, no schema): PRD enrich (C1), grill (C2), USAGE regen (C3), doc-gen (C4)
- Sites: `autonomy/lib/prd-enrich.sh:_loki_prd_enrich_invoke:43`, `autonomy/grill.sh`, USAGE/doc-gen.
- These return FREE TEXT, not a gating verdict, so they do NOT go through `judgeJson` (schema path).
  They need a sibling `judgeText()` in `sdk_invoker.ts`: same client, `messages.create` with NO
  `output_config.format`, return the concatenated text blocks (or null). Add `loki internal sdk-text`
  wrapping it. Lower priority: no verdict to protect, failure is cosmetic (a worse PRD, not a wrong gate).
- Flag: `LOKI_SDK_AUX=1` (one flag for the whole low-risk cluster).
- Parity: text sites have no deterministic verdict; "parity" = a smoke assertion that both routes return
  non-empty text of comparable length + that fail-closed still yields the deterministic fallback. Do NOT
  claim byte-parity on free text.
- Rollback: `unset LOKI_SDK_AUX`.

### Phase 2 provider-agnosticism (unchanged, load-bearing)
Every branch above is inside the `claude)` / `PROVIDER_NAME=claude` arm ONLY. The codex/cline/aider
`case` arms are UNTOUCHED. The SDK path is additionally gated by `judgeJson` returning null when
`ANTHROPIC_API_KEY` is absent (fail-closed to the claude arm). Bash stays the live route until each
cluster's parity test passes in `local-ci.sh` under `RUN_BILLABLE=1`.

---

## B.3 Phase 3 -- the council: Batch API on the raw SDK, NOT the Agent SDK. DECISION + why.

The Section-4 sketch offered "Agent SDK `agents` dispatch OR Batch API -- decide". **Decision: neither the
Agent SDK nor the current sync path; use the raw-SDK parallel-`create` fan-out for the ON-critical-path
council, and reserve the Batch API for the OFF-critical-path judge cohort. Reasoning grounded in the
verified cost/latency facts:**

1. The council reviewers are pure one-shot JUDGES (each = one prompt -> one schema verdict). They do NOT
   need the Agent SDK's tool loop / filesystem / subagents. Routing them through the Agent SDK would spawn
   the ~240MB binary per council -- strictly worse on both cost (binary) and the deploy thesis (not
   binary-free). The whole point of the two-SDK split is that judges stay on the raw HTTPS SDK.
2. **Batch API is a COST lever, not a latency lever** (verified: 50% off via `service_tier:"batch"`, but
   async with up to 24h SLA, results keyed by `custom_id`). The completion council is ON the critical path
   (the run blocks on its verdict), so batch's 24h SLA is disqualifying THERE. For N independent reviewers
   on the critical path, N parallel `judgeJson` promises against one in-process client (`Promise.all`) is
   the right primitive: one process, N concurrent HTTPS calls, wall-clock = max(reviewer), no binary.
3. **Where Batch DOES win:** the OFF-critical-path judge cohort -- done-recognition sweeps run ahead of
   time, offline re-scoring, doc-coverage / magic-debate gates that are advisory and not blocking. Those
   can be submitted as one `messages.batches.create({requests:[...]})` at `service_tier:"batch"` for -50%,
   because nothing blocks on them synchronously. This is a SEPARATE, later, opt-in lever
   (`LOKI_SDK_BATCH_ADVISORY=1`), explicitly NOT part of the blocking council.

**Phase 3 build (parallel raw-SDK council, keep Loki's decision engine):**
- New `judgeCouncil(reviewers: JudgeParams[]): Promise<(Record|null)[]>` in `sdk_invoker.ts`:
  `Promise.all(reviewers.map(judgeJson))`. Each reviewer carries its OWN system prefix (its lens) with the
  SHARED evidence+PRD prefix carrying the 1h `cache_control` breakpoint -- so reviewer 2..N read the cache
  reviewer 1 wrote (cross-reviewer cache reuse within one run; the exact cost mechanism from Axis 1, now
  real). Fire reviewer 1, await its first response, then fire 2..N so they hit the warm cache (the catalog
  caveat: a cache entry is only readable after the first response BEGINS -- N truly-parallel calls each
  pay full price; serialize the first, then fan out).
- New `loki internal sdk-council --reviewers-file <json>` wrapping it; `autonomy/lib/voter-agents.sh` gets
  an SDK branch behind `LOKI_SDK_COUNCIL=1` that builds the reviewers JSON (same content it builds for
  `claude --agents` today) and writes each verdict to the same `.loki/council/votes/round-<iter>.json`
  the bash path writes.
- **KEEP unchanged:** the decision engine -- effective-threshold floor, exact-quorum gate,
  devil's-advocate override, transcript writing. None of that is an SDK concept; the SDK only supplies the
  N verdicts. This is the same "WRAP the invocation, keep RARV-C" discipline as everywhere else.
- Parity: `.loki/council/votes/round-<iter>.json` must match across routes over a corpus; the final
  council DECISION (approve/block + quorum) must be identical. Rollback: `unset LOKI_SDK_COUNCIL`.
- Cache-proof: assert reviewer 2..N show `cache_read_input_tokens > 0` (the Axis-1 mechanism, now
  observable). If they don't, the shared-prefix breakpoint has a silent invalidator (per-reviewer bytes
  leaking into the shared head) -- fix by moving the reviewer lens strictly AFTER the breakpoint.

Note: Phase 3 uses the raw SDK, so it does NOT depend on Spike A (Bun-can-spawn-the-Agent-binary). It
ships independently of the Agent SDK. The `--agents` bash path and heuristic council fallback both stay.

---

## B.4 Phase 4 (SPEC ONLY -- highest risk) -- RARV loop on the Agent SDK; what the stream parser MUST emit

This replaces `shellRun(["claude", ...stream-json...])` in `providers.ts` `claudeProvider()` with the
Agent SDK `query()`. It is the ONLY site that needs `@anthropic-ai/claude-agent-sdk` (must be
`bun add`-ed first -- NOT yet installed; only `@anthropic-ai/sdk` is in `loki-ts/package.json`). Spec only:
no code this arc.

### B.4.1 the invocation
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";   // 0.3.208, verified types
const q = query({
  prompt: builtPrompt,                                     // from build_prompt() VERBATIM (parity-locked)
  options: {
    model, effort,                                         // <- --model / --effort tier
    permissionMode: "bypassPermissions",                  // <- --dangerously-skip-permissions
    allowDangerouslySkipPermissions: true,                //    REQUIRED alongside bypassPermissions
    systemPrompt: { type: "preset", preset: "claude_code", append: autonomyAppend }, // <- --append-system-prompt
    settingSources: ["project"],                          // <- load CLAUDE.md (omit=all, []=isolate)
    includePartialMessages: true,                         // <- --include-partial-messages (dashboard stream)
    maxTurns, maxBudgetUsd,                               // budget guards (see B.4.3)
    sessionId, resume, forkSession,                       // <- --session-id / --resume / --fork-session
    mcpServers,                                           // <- Loki's mcp/server.py (34 tools) unchanged
    executable: "bun",                                    // Bun auto-selected (isBun()); pin explicitly
  },
});
for await (const m of q) { sdkStreamParser.consume(m); }  // typed SDKMessage union
```

### B.4.2 what `sdk_stream_parser.ts` MUST emit (the one genuinely new piece)
It translates the typed `SDKMessage` stream into the EXACT `.loki/` artifacts the embedded Python
stream-json parser writes today (`run.sh:17371+`), so every downstream consumer is byte-compatible:

| SDKMessage variant (verified 0.3.208 `sdk.d.ts`) | Emit to `.loki/` | Notes |
|---|---|---|
| `type:"system", subtype:"init"` | `.loki/state/agents.json` seed (session_id, model, tools, mcp_servers, permissionMode) | first frame |
| `type:"assistant"` (`message`: full Beta message w/ content blocks + usage) | append content to the iteration transcript; accumulate `usage` | `subagent_type`/`task_description` when present |
| `type:"stream_event"` (`SDKPartialAssistantMessage`, only when `includePartialMessages`) | dashboard live stream (`.loki/events.jsonl`) | best-effort; ignore if absent |
| `type:"result"` (`SDKResultMessage`) | **`.loki/metrics/result-cost-<iter>.json`** <- `total_cost_usd`, `usage`, `modelUsage`, `num_turns`, `duration_ms` | THE accounting frame; also the completion signal |
| hook events (`SubagentStart/Stop`, `PreCompact/PostCompact`, `PreToolUse/PostToolUse`) | `.loki/events.jsonl` hook records | map to the bash hook-event shape |
| any other `type`/`subtype` (task_progress, rate_limit_event, plugin_install, prompt_suggestion, ...) | IGNORE | parser MUST tolerate unknown variants -- do not throw |

Load-bearing rules for the parser:
- Key completion on `type==="result"`; key content on `type==="assistant"`. Everything else is telemetry
  or ignorable.
- `SDKResultMessage.subtype` is the STOP signal your loop reads: `success` | `error_during_execution` |
  `error_max_turns` | `error_max_budget_usd` | `error_max_structured_output_retries`. Map each to Loki's
  existing iteration outcome (max_budget/max_turns -> the same PAUSE/stop the bash route reaches).
- **RARV-C is NOT replaced** (verified: no outcome/iterate-until-done primitive in the Agent SDK).
  `query()` runs ONE agentic iteration (one tool-use loop, bounded by maxTurns/maxBudgetUsd). Loki's
  `run_autonomous` outer loop, the 8 gates, the completion council, and the `.loki/` state machine ALL
  stay. `maxTurns`/`maxBudgetUsd`/`error_max_*` bound one call, never the grader loop.
- `total_cost_usd` on the result frame REPLACES the price-table computation the raw-SDK judges need
  (the Agent SDK returns dollars; the raw SDK returns tokens only -- note this asymmetry in accounting).

### B.4.3 budget: NO per-call USD cap on the raw SDK; keep the deterministic gate on BOTH
- Agent SDK exposes `maxBudgetUsd` (verified) -> wire `--max-budget-usd` to it.
- The raw-SDK judges have NO USD cap primitive (verified). KEEP Loki's cumulative `check_budget_limit`
  PAUSE gate (`budget.ts`, already ported) on both routes -- do NOT delegate budget enforcement to the
  SDK. `taskBudget:{total}` (@alpha, token budget + `task-budgets-2026-03-13` beta) is optional and NOT
  required for v8.

### B.4.4 the cache enhancement finally lands
Split the inert `[CACHE_BREAKPOINT]` (`build_prompt.ts:1362,1425`) into a real `cache_control` on the
stable RARV/SDLC/constitution prefix (~6K tokens, catalog-verified >= the 4096 Opus min). This is the
Axis-1 dev-loop line item; it becomes settable ONLY at this migration. Guard: verdict/behavior must be
identical with the breakpoint on vs off (transparent cost lever).

### B.4.5 parity + rollback (the sdlc-fleet phase)
- Parity: run a fixed PRD corpus through both routes (`LOKI_SDK_LOOP=0` vs `=1`); compare per-iteration
  cost/usage, all 8 gate outcomes, and the completion decision. Needs the full sdlc-fleet council
  (3 reviewers, unanimous APPROVE) per `CLAUDE.md`.
- Rollback: `LOKI_SDK_LOOP=0` or `LOKI_LEGACY_BASH=1` -> `start` falls through to bash. Bash stays the
  canonical route until SDK-proven across the discriminator corpus.
- Depends on Spike A (does Bun 1.3.14 spawn the 0.3.208 bundled binary cleanly?). If NO: loop runs under
  Node, judges stay on Bun (raw SDK is pure JS). This gates the runtime choice, not the design.

---

## B.5 Cross-phase build order + the single reusable seam

Build order (value / risk / dependency): **B.1 (complete Phase 1) -> 2c (code-review, highest-value delete,
reuses cr-rematerialize) -> 2b (completion council) -> 2a parity (branch already exists) -> 2d aux ->
B.3 (parallel council) -> B.4 (RARV loop, last).**

Every judge phase reuses ONE seam already on the branch: `loki internal sdk-judge` -> `judgeJson()`.
Phase 2 adds only `.sh` branches + (2b) one schema + (2d) a `judgeText` sibling. No phase reinvents the
bridge. The `cache_control` extension (B.1.2) is written once in `judgeJson` and every later judge phase
inherits it. This is why "judges before the loop" is not just risk-ordering -- it amortizes one TS change
(the cached judge) across ~100 call sites before the hard Agent-SDK work begins.


## SPIKE RESULTS (2026-07-13, gating Phase 4 / EPIC D+G) - all PASS, decision = GO

Verified live with `@anthropic-ai/claude-agent-sdk@0.3.208` (LATEST) under Bun 1.3.13,
in an isolated scratch install (no production code touched):

- **Spike A (Bun can spawn the Agent SDK): PASS.** `bun add` resolved the platform-gated
  optionalDependencies and installed `@anthropic-ai/claude-agent-sdk-darwin-arm64`, which
  SHIPS the `claude` binary at `node_modules/.../claude-agent-sdk-darwin-arm64/claude`
  (bundled as an npm dep - no separate CLI install, no interactive login, no version drift;
  the enterprise/SaaS win holds). `bun run` imports `query()` as a function; full export
  surface present: query, tool, createSdkMcpServer, forkSession, getSessionMessages,
  resolveSettings, HOOK_EVENTS, DirectConnectTransport, InMemorySessionStore, etc.
- **Spike B (raw-SDK structured output): ALREADY PROVEN** by the shipped judge sites
  (Epics A+B, council-approved). `messages.create` + `output_config.format` works end to end.
- **Spike C (Agent SDK option fields exist): PASS.** All Phase-4 flag-mapping fields present
  in sdk.d.ts@0.3.208: maxBudgetUsd (L1644 - the `--max-budget-usd` analog the plan flagged
  uncertain; CONFIRMED), fallbackModel (L1436), effort, model, systemPrompt, settingSources,
  includePartialMessages (L1592), permissionMode, sessionId, resume, forkSession, maxTurns.
  No capability loss vs the bash `claude ... stream-json` invocation.

**API shape confirmed for the build:**
- `query({ prompt, options }): Query extends AsyncGenerator<SDKMessage>` (L2231/L2528).
- Message types to consume in `sdk_stream_parser.ts`: SDKAssistantMessage (L2787),
  SDKPartialAssistantMessage (L399), SDKResultMessage (L407), SDKUserMessage,
  SDKAssistantMessageError (L2823: authentication_failed | rate_limit | overloaded | ...).
  This is a TYPED async iterator - far cleaner than parsing raw stream-json TEXT through the
  ~350-line embedded Python parser. The parser's job becomes: iterate typed events -> write the
  same `.loki/state/agents.json`, `.loki/events.jsonl` hook events, `.loki/metrics/result-cost-<iter>.json`.

**Build anchors (both routes):**
- bash main loop: `autonomy/run.sh:17465-17475` (`claude "${_loki_claude_argv[@]}" -p "$prompt"
  --output-format stream-json --verbose | tee | python3 parser`). argv build ~17298-17430.
- TS main loop: `loki-ts/src/runner/providers.ts:274-285` (claudeProvider argv, `call.mainLoop`
  flag; transport `shellRun(argv)` ~L305). RARV outer loop: `loki-ts/src/runner/autonomous.ts`.
- Phase 4 = replace the mainLoop `shellRun(["claude", ...stream-json...])` with `query()` +
  `sdk_stream_parser.ts`, gated `LOKI_SDK_LOOP=1`, bash arm intact. KEEP build_prompt (parity-lock),
  all 8 gates, the council, `.loki/` state machine. RARV-C is NOT an SDK primitive - the grader
  loop stays. Route `bin/loki start` to Bun when `LOKI_SDK_LOOP=1`.

DECISION: GO. Phase 4 is feasible under Bun with zero capability loss. It remains the highest-risk
site (agentic tool loop + streaming) and stays LAST, done behind `LOKI_SDK_LOOP=1` with the bash
`claude` main loop live as the default until E2E-proven on real apps (simple + full-stack).
