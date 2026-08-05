# Claude Agent SDK Research (TypeScript) - for the v8 Loki migration

Sources: live docs `code.claude.com/docs/en/agent-sdk` + `/agent-sdk/typescript` (WebFetch, today); installed `claude` v2.1.207 `--help`; and the **actual unpacked `@anthropic-ai/claude-agent-sdk@0.3.207` tarball** (published 3 days ago) - `sdk.d.ts` (6923 lines), `package.json`, `sdk.mjs`. Every API shape below was verified against the real `.d.ts`, not just docs (WebFetch invented a few types - those are flagged UNVERIFIED). Package repo: `github.com/anthropics/claude-agent-sdk-typescript`.

## THE ONE FINDING THAT REFRAMES THE FOUNDER'S PREMISE (verified, load-bearing)

**The Claude Agent SDK does NOT remove the `claude` binary dependency. It IS the `claude` binary, wrapped as a subprocess.**

Primary-source evidence from the 0.3.207 tarball:
- `package.json`: `"dependencies": {}` but `"optionalDependencies"` ships **8 platform-specific native Claude Code binaries** (`@anthropic-ai/claude-agent-sdk-{linux,darwin,win32}-{x64,arm64}[-musl]@0.3.207`).
- `sdk.mjs` imports `node:child_process` and calls `spawn()` (2 call sites, 291 refs to `claude`, 13 to `claude-code`).
- `Options` exposes `executable?: 'bun'|'deno'|'node'`, `pathToClaudeCodeExecutable?: string`, `executableArgs`, and `spawnClaudeCodeProcess?: (o) => SpawnedProcess` - all subprocess-management knobs. There's even an `extractFromBunfs()` export whose only job is to locate the embedded `claude` binary when you `bun build --compile`.
- Docs confirm: *"The TypeScript SDK bundles a native Claude Code binary for your platform as an optional dependency."* README: *"The Claude Code SDK is now the Claude Agent SDK."* - it's a rename of the Claude Code SDK.

**Implication for the founder requirements.** Adopting `@anthropic-ai/claude-agent-sdk` gives Loki a first-class TS library, structured messages, in-process tools, and the full Claude Code harness - but it does **not** deliver the stated KEY strategic win (removing the CLI binary / "just an API key" containers). The binary is bundled instead of PATH-installed (so: no interactive login, no separate `claude` install step, no user-managed version drift - the SDK pins its own binary), but a native Claude Code executable still runs as a child process in every container. It's still "Claude Code," just vendored and spawned by your code instead of shelled out to on PATH.

If "NO claude binary at all, pure API calls" is a hard requirement, the surface that actually delivers it is **`@anthropic-ai/sdk` (the Client SDK, v0.111.0)** - pure HTTPS to `api.anthropic.com`, zero binary - but then Loki owns the agent loop, tools, context management, and permissions itself (which RARV-C/run.sh largely already does). Or **Managed Agents** (Anthropic hosts the loop + sandbox; REST only). This is the real architectural fork; recommend surfacing it to the founder before committing.

---

## 1. Core primitives (verified against `sdk.d.ts`)

**Entry point - `query()` (sdk.d.ts:2527):**
```ts
export declare function query(_params: {
 prompt: string | AsyncIterable<SDKUserMessage>;
 options?: Options;
}): Query;
```
- `prompt: string` = one-shot. `prompt: AsyncIterable<SDKUserMessage>` = streaming-input mode (enables mid-session control methods).
- Returns a `Query` (below); you `for await (const message of query(...))` to drive the agentic loop. The SDK runs the whole Reason→Act tool-use loop internally - you don't write the `while stop_reason === 'tool_use'` loop (that's the explicit contrast the docs draw vs the Client SDK).

**`Query` interface (sdk.d.ts:2230) - `extends AsyncGenerator<SDKMessage, void>`** with control methods (all verified present):
`interrupt()`, `setPermissionMode(mode)`, `setModel(model?)`, `setMaxThinkingTokens(n, display?)`, `applyFlagSettings(settings)`, `supportedModels()`, `supportedAgents()`, `supportedCommands()`, `mcpServerStatus()`, `setMcpServers()`, `reconnectMcpServer()`, `toggleMcpServer()`, `rewindFiles(userMessageId, {dryRun?})`, `streamInput(stream)`, `initializationResult()`, `reinitialize()`, `close()`. Mid-session setters (`setModel`, `setPermissionMode`, `applyFlagSettings`) work **only in streaming-input mode**.

**Custom tools - `tool()` (sdk.d.ts:6745) + `createSdkMcpServer()` (sdk.d.ts:467):**
```ts
export declare function tool<Schema extends AnyZodRawShape>(
 _name, _description, _inputSchema: Schema,
 _handler: (args: InferShape<Schema>, extra) => Promise<CallToolResult>,
 _extras?: { annotations?: ToolAnnotations }
): SdkMcpToolDefinition<Schema>;

export declare function createSdkMcpServer(_options: CreateSdkMcpServerOptions): McpSdkServerConfigWithInstance;
```
Tools are **in-process** (Zod-schema'd TS functions), bundled into an SDK MCP server, passed via `options.mcpServers`. This is how Loki would expose its own tools (queue, memory, council) to the agent without a separate MCP process - a genuine enhancement over shelling out.

**Built-in tools (no implementation needed):** Read, Write, Edit, Bash, Monitor, Glob, Grep, WebSearch, WebFetch, AskUserQuestion, Agent (subagent invocation), + MCP. Gated by `allowedTools`/`disallowedTools`/`tools`.

**Subagents / multi-agent - `options.agents: Record<string, AgentDefinition>` (sdk.d.ts:1327):**
```ts
type AgentDefinition = {
 description: string; prompt: string;
 tools?: string[]; disallowedTools?: string[];
 model?: string; // alias, full id, or "inherit"
 mcpServers?: AgentMcpServerSpec[]; skills?: string[];
 maxTurns?: number; background?: boolean;
 memory?: 'user'|'project'|'local';
 effort?: 'low'|'medium'|'high'|'xhigh'|'max'|number;
 permissionMode?: PermissionMode;
 initialPrompt?: string; /* + experimental fields */
};
```
Subagents invoked via the `Agent` tool (include `"Agent"` in `allowedTools` to auto-approve). Messages from a subagent carry `parent_tool_use_id` so you can attribute them. This maps cleanly onto Loki's dev-fleet/council pattern - but note it's **one level deep** and runs subagents within the same host process, unlike Loki's current parallel-Task fan-out.

**Memory/context:** three layers. (a) `CLAUDE.md`/`.claude/` loaded via `settingSources` (`'user'|'project'|'local'`). (b) Automatic context compaction is built into the Claude Code harness the SDK spawns. (c) `AgentDefinition.memory` + Skills (`.claude/skills/*/SKILL.md`, `options.skills`). There is no separate vector-memory primitive - Loki's `memory/` Python package has no SDK equivalent; you'd wire it in as SDK MCP tools or hooks.

**Hooks:** `options.hooks` - `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, etc., as in-process callbacks (validate/block/transform/log). Good fit for Loki's quality gates and telemetry.

## 2. Session continuity (verified)
- `options.resume?: string` (session id), `options.continue?: boolean` (most recent), `options.forkSession?: boolean`, `options.resumeSessionAt?: string` (resume at a specific message UUID), `options.sessionId?: string` (pin a UUID), `options.persistSession?: boolean`.
- Session id comes from the `system`/`init` message (`message.session_id`) on the first query; pass it as `resume` on the next.
- Storage: **JSONL on your filesystem** (docs confirm; helpers `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()`, `tagSession()`). `options.sessionStore` can mirror transcripts to an external backend.
- Maps to the CLI's `--resume`/`--session-id`/`--continue`/`--fork-session`/`--resume-session-at` (all present in `claude --help`). This is a strict superset of Loki's current CLI-flag resume usage.

## 3. Structured output (verified - direct CLI `--json-schema` equivalent)
```ts
outputFormat?: OutputFormat; // sdk.d.ts:1686
type OutputFormat = JsonSchemaOutputFormat; // :2016
type JsonSchemaOutputFormat = { type: 'json_schema'; schema: Record<string, unknown> }; // :898
```
Result lands on **`SDKResultSuccess.structured_output?: unknown`** (sdk.d.ts). There's a dedicated error subtype `error_max_structured_output_retries`, so the harness retries to satisfy the schema. This is the exact analog of the CLI's `--json-schema` flag. **Yes, fully supported.**

## 4. Budget / effort / model / fallback (verified - direct CLI-flag parity)
| Need | Agent SDK option | CLI flag |
|---|---|---|
| Budget cap | `maxBudgetUsd?: number` → error subtype `error_max_budget_usd` | `--max-budget-usd` |
| Effort | `effort?: 'low'\|'medium'\|'high'\|'xhigh'\|'max' \| number` (also runtime `applyFlagSettings({effortLevel})`) | `--effort` |
| Model | `model?: string` (alias/full id; runtime `setModel()`) | `--model` |
| Fallback | `fallbackModel?: string` | `--fallback-model` |
| Turn cap | `maxTurns?: number` → `error_max_turns` | (SDK/`--max-turns`) |
| Task budget | `taskBudget?: { total: number }` → sent as API `output_config.task_budget` + beta header `task-budgets-2026-03-13` | - |
| Thinking | `thinking?: ThinkingConfig` (`maxThinkingTokens` deprecated) | - |
| Betas | `betas?: SdkBeta[]` - only `'context-1m-2025-08-07'` is valid | `--betas` |

Result message carries `total_cost_usd`, `usage` (NonNullableUsage), `modelUsage: Record<string, ModelUsage>`, `num_turns`, `duration_ms/api_ms`, `permission_denials` - richer cost/telemetry than parsing CLI stdout. **Every CLI control Loki uses has a typed SDK option.**

## 5. The "outcome" / Managed-Agents primitive vs RARV-C (honest assessment)
There is **no `outcome` primitive in the Agent SDK.** The closest thing is the SDK's built-in agent loop bounded by `maxTurns` / `maxBudgetUsd` / `taskBudget` / structured-output retries - an *effort/budget-bounded* loop, **not** an iterate-until-a-grader-says-done loop.

The grader-driven "iterate until an independent rubric passes" primitive is **Managed Agents' Outcomes** (`user.define_outcome` + rubric + `max_iterations`, with `span.outcome_evaluation_*` events and a separate grader model) - a **different product** (hosted REST API, `client.beta.sessions.*` on `@anthropic-ai/sdk`), not the Agent SDK. Per the docs' own comparison table, Managed Agents runs the loop + sandbox on Anthropic infra; the Agent SDK runs in your process.

**Honest verdict:** RARV-C already *is* Loki's home-grown Outcomes equivalent (iterate → grade via council → close). Neither the Agent SDK nor Managed Agents Outcomes maps onto it 1:1. Do **not** fabricate a wiring where the SDK "provides" RARV-C - the SDK provides a bounded tool-use loop; the grader/council closure stays Loki's. Managed Agents Outcomes is the nearest hosted analog but would mean re-platforming completion onto Anthropic's grader (out of scope, and would cede Loki's council).

## 6. Runtime / auth / cost (verified)
- **Runtime:** Node, Bun, or Deno - `executable?: 'bun'|'deno'|'node'`. TS SDK bundles the native binary per platform (no separate `claude` install). Python variant (`claude-agent-sdk`) needs Python ≥3.10.
- **Auth:** `ANTHROPIC_API_KEY` (docs). Also Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`), Claude Platform on AWS (`CLAUDE_CODE_USE_ANTHROPIC_AWS=1` + `ANTHROPIC_AWS_WORKSPACE_ID`), Vertex (`CLAUDE_CODE_USE_VERTEX=1`), Foundry (`CLAUDE_CODE_USE_FOUNDRY=1`). **Anthropic explicitly prohibits third-party products from using claude.ai login / subscription rate limits via the Agent SDK - API-key auth only.** No interactive login (a real improvement over the CLI's OAuth `claude auth`).
- **Cost:** standard per-token API billing (surfaced live as `total_cost_usd` on the result). Same underlying `/v1/messages` cost as the CLI - the CLI's cost is API cost; the SDK doesn't change the cost model, it just reports it structurally.

## 7. Honest gaps (what each does that the other doesn't)

**Agent SDK gains over Loki's `claude -p` wrapper:**
- Typed streaming messages (`SDKMessage` union) instead of stdout parsing; structured `SDKResultSuccess`/`SDKResultError` with cost/usage/`structured_output`.
- In-process custom tools (`tool()`), in-process hooks, programmatic subagents (`agents`), programmatic MCP.
- Mid-session control (`interrupt`, `setModel`, `setPermissionMode`, `applyFlagSettings`, `streamInput`, `rewindFiles`) - no equivalent when you shell out to `claude -p`.
- `startup()`/`WarmQuery` for low-latency warm spares.

**Provider-agnostic caveat (per founder's constraint):** the Agent SDK is Anthropic/Claude-Code-specific. It does NOT give Loki Codex/Cline/Aider. Those routes need their own story (the OpenAI-compatible layer, explicitly out of scope here). Note the Agent SDK *can* target Bedrock/Vertex/Foundry via env vars, but that's still Claude models.

**What the Agent SDK does NOT do / gaps vs the premise:**
- **Does not remove the native binary** (finding above) - it spawns a bundled Claude Code executable per platform. "Library, just an API key, no binary" is only true of `@anthropic-ai/sdk` (Client SDK).
- No grader/Outcomes primitive (RARV-C stays Loki's; §5).
- No built-in vector memory (Loki's `memory/` package has no SDK analog; wire via MCP/hooks).
- Only one valid `SdkBeta` (`context-1m-2025-08-07`) - other API betas (fast-mode, compaction, etc.) aren't first-class SDK options.
- WebFetch-only claims I could NOT verify in the `.d.ts` and mark **UNVERIFIED**: the exact `SDKAssistantMessage`/`SDKPartialAssistantMessage` content-block shapes, `ThinkingConfig` as a 3-variant union, and `CanUseTool`'s full options object. The `thinking?: ThinkingConfig` field, `includePartialMessages?: boolean`, and `canUseTool?: CanUseTool` fields **are** confirmed present; their inner shapes should be re-read from `sdk.d.ts` before you write code against them.

Verified type-def file (kept for the implementer): `/private/tmp/claude-501/-Users-lokesh-git-lokimode-anthropic/8db286db-3006-49f5-9dc6-cb241e559d45/scratchpad/package/sdk.d.ts` (line refs above are from this file, v0.3.207).

**Recommendation to fold into the v8 plan:** the migration decision is not "Agent SDK vs bash" - it's a three-way fork (Agent SDK = bundled binary + full harness; Client SDK = pure API, Loki owns the loop; Managed Agents = hosted loop+sandbox+Outcomes). Only the Client SDK path delivers the founder's stated "no binary, API-key-only container" win, at the cost of re-owning the loop Loki mostly already owns. Surface this explicitly before locking scope.