// v8 Phase 4: consume the Agent SDK's query() AsyncGenerator<SDKMessage> and
// write the SAME .loki state the embedded bash stream-json parser writes
// (autonomy/run.sh:17475-17829). This is a faithful TRANSLATION of that Python
// parser, not a new design -- the .loki contract must stay byte-compatible so
// every downstream consumer (dashboard, efficiency writer, event bus, council)
// is unchanged whether the loop ran on the bash `claude` binary or the SDK.
//
// The SDK's typed messages map 1:1 to the stream-json events the Python parser
// consumed:
//   SDKPartialAssistantMessage  (type:'stream_event')  -> live delta text
//   SDKAssistantMessage         (type:'assistant')     -> text + tool_use blocks
//   SDKUserMessage              (type:'user')          -> tool_result blocks
//   SDKResultMessage            (type:'result')        -> cost + exit code
//   (hook events arrive as system messages / are surfaced via the hooks option)
//
// Writes (identical to the Python parser):
//   .loki/state/agents.json                    orchestrator + subagent tracking
//   .loki/events.jsonl                         claude_hook_<name> records
//   .loki/metrics/result-cost-<iter>.json      authoritative per-iter cost
//
// PURE + testable: the consumer takes an async-iterable of SDKMessage-shaped
// objects, so a unit test feeds a canned array (no API call) and asserts the
// exact files. Nothing here imports the Agent SDK at runtime -- the caller
// (providers.ts) owns query(); this only consumes what it yields.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// A structural subset of the Agent SDK's SDKMessage union -- only the fields the
// parser reads. Kept local (not imported from the SDK) so the parser is pure and
// unit-testable with plain objects, and so a minor SDK type churn cannot break
// the parser's contract with the .loki files.
export interface StreamMsg {
  type: string; // 'stream_event' | 'assistant' | 'user' | 'result' | 'system' | ...
  // assistant / user carry a nested message with content blocks
  message?: {
    content?: Array<Record<string, unknown>>;
  };
  // stream_event carries a raw streaming event
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  // result fields (SDKResultMessage)
  subtype?: string;
  is_error?: boolean;
  total_cost_usd?: number | null;
  usage?: Record<string, unknown>;
  session_id?: string;
  result?: string; // SDKResultMessage.result (final assistant text summary)
  // SDKAssistantMessage.error: 'rate_limit' | 'overloaded' | ... (structural
  // rate-limit signal). SDKRateLimitEvent carries rate_limit_info.
  error?: string;
  rate_limit_info?: Record<string, unknown>;
  // hook events arrive as type:'system' subtype:'hook_started'|'hook_response'
  // with a hook_event field (SDKHookStartedMessage / SDKHookResponseMessage).
  // NOT a top-level 'hook_event' message (the bash stream-json parser's probe
  // was for the CLI's older shape; the SDK surfaces hooks this way).
  hook_event?: string;
}

export interface ParserContext {
  cwd: string; // repo root under which .loki lives
  iteration: string; // LOKI_ITERATION stamp for the result-cost file
  hookEventsEnabled: boolean; // LOKI_HOOK_EVENTS != "off"
  // Live-output sink. The caller tees the same text to the terminal +
  // iterationOutputPath + captured log (mirroring the bash `tee`). Default: stdout.
  write?: (s: string) => void;
}

interface AgentInfo {
  agent_id: string;
  tool_id: string;
  agent_type: string;
  model: string;
  current_task: string;
  status: string;
  spawned_at: string;
  tasks_completed: string[];
  tool_count?: number;
  completed_at?: string;
}

const ORCHESTRATOR_ID = "orchestrator-main";

// nowIso: the parser stamps timestamps like the Python parser
// (datetime.now(timezone.utc).isoformat() with a trailing Z). Injectable for
// deterministic tests.
function nowIso(clock?: () => string): string {
  // Node's toISOString() already yields e.g. 2026-07-13T12:34:56.789Z (UTC, Z
  // suffix) -- the same shape the Python parser produces via isoformat()+"Z".
  return clock ? clock() : new Date().toISOString();
}

/**
 * Consume a stream of SDK messages, writing the same .loki state the bash
 * Python parser writes. Returns the process-equivalent exit code (0 success,
 * 1 on a result error) so the caller can populate ProviderResult.exitCode.
 *
 * `clock` is injectable so unit tests get deterministic timestamps.
 */
export interface StreamResult {
  exitCode: number;
  sessionId?: string;
  totalCostUsd?: number | null;
  // The load-bearing capture: concatenated final assistant text + result.result
  // + any rate-limit error string. The provider writes this to
  // capturedOutputPath so the existing completion-promise / rate-limit /
  // council text scanners fire exactly as on the bash route.
  capturedText: string;
  // Structural rate-limit signal (assistant error 'rate_limit'/'overloaded' or
  // an SDKRateLimitEvent). resetSeconds is the wait if the SDK reported one.
  rateLimit?: { resetSeconds?: number };
  // True iff a terminal `result` message arrived. When false, the loop ended
  // without a result (aborted/crashed) and the caller must treat it as failure.
  sawResult: boolean;
}

export async function consumeSdkStream(
  messages: AsyncIterable<StreamMsg> | Iterable<StreamMsg>,
  ctx: ParserContext,
  clock?: () => string,
): Promise<StreamResult> {
  const write = ctx.write ?? ((s: string) => process.stdout.write(s));
  const lokiRoot = join(ctx.cwd, ".loki");
  const agentsFile = join(lokiRoot, "state", "agents.json");
  const eventsJsonl = join(lokiRoot, "events.jsonl");

  const agents = loadAgents(agentsFile);
  // Always show the main orchestrator (Python init_orchestrator).
  agents[ORCHESTRATOR_ID] = agents[ORCHESTRATOR_ID] ?? {
    agent_id: ORCHESTRATOR_ID,
    tool_id: ORCHESTRATOR_ID,
    agent_type: "orchestrator",
    model: process.env["LOKI_CURRENT_MODEL"] ?? "sonnet",
    current_task: "Initializing...",
    status: "active",
    spawned_at: nowIso(clock),
    tasks_completed: [],
    tool_count: 0,
  };
  saveAgents(agentsFile, agents);

  let streamedText = false; // partial-message deltas already printed this message
  let exitCode = 1; // fail-closed: no result message -> failure (aborted/crashed)
  let sessionId: string | undefined;
  let totalCostUsd: number | null | undefined;
  let captured = ""; // load-bearing capture (final assistant text + result.result)
  let rateLimit: { resetSeconds?: number } | undefined;
  let sawResult = false;

  for await (const data of asAsync(messages)) {
    const msgType = data.type ?? "";

    // --- stream_event: live incremental delta text (--include-partial-messages)
    if (msgType === "stream_event") {
      const ev = data.event ?? {};
      if (ev.type === "message_start") {
        streamedText = false;
      } else if (ev.type === "content_block_delta") {
        const delta = ev.delta ?? {};
        if (delta.type === "text_delta" && delta.text) {
          write(delta.text);
          streamedText = true;
        }
      }
      continue;
    }

    // --- assistant: rate-limit error, text blocks + tool_use blocks
    if (msgType === "assistant") {
      // SDKAssistantMessage.error can be 'rate_limit' | 'overloaded' | ...
      const err = data.error;
      if (err === "rate_limit" || err === "overloaded") {
        rateLimit = rateLimit ?? {};
        captured += `\n[${err}]\n`; // so the file-based rate-limit scanner fires
      }
      const content = data.message?.content ?? [];
      for (const item of content) {
        const itype = item["type"] as string | undefined;
        if (itype === "text") {
          const text = (item["text"] as string) ?? "";
          // Capture EVERY final text block (independent of the live-print dedup):
          // the streamedText guard only prevents double-PRINTING, not capture.
          if (text) captured += text;
          if (text && !streamedText) write(text);
        } else if (itype === "tool_use") {
          const tool = (item["name"] as string) ?? "unknown";
          const toolId = (item["id"] as string) ?? "";
          const input = (item["input"] as Record<string, unknown>) ?? {};
          bumpOrchestratorTool(agents, tool, toolDesc(tool, input));

          if (tool === "Task") {
            const toolIdShort = toolId.slice(0, 8);
            agents[toolId] = {
              agent_id: `agent-${toolIdShort}`,
              tool_id: toolId,
              agent_type: (input["subagent_type"] as string) ?? "general-purpose",
              model: (input["model"] as string) ?? "sonnet",
              current_task: (input["description"] as string) ?? "",
              status: "active",
              spawned_at: nowIso(clock),
              tasks_completed: [],
            };
            saveAgents(agentsFile, agents);
          } else if (tool === "TodoWrite") {
            // Mirror the Python TodoWrite enrichment -> .loki/queue/in-progress.json
            const todos = (input["todos"] as Array<Record<string, unknown>>) ?? [];
            const inProgress = todos.filter((t) => t["status"] === "in_progress");
            const enriched = inProgress.map((t, i) => {
              const content = (t["content"] as string) ?? "";
              const activeForm = (t["activeForm"] as string) || content;
              return {
                id: `todo-${i}`,
                type: "todo",
                title: content,
                description:
                  "Internal task tracked by the agent TodoWrite tool. " +
                  "This is LLM scratch, not a PRD-derived work item, so " +
                  "it has no acceptance criteria or user story. " +
                  `Active form: ${activeForm}`,
                source: "claude_code_todowrite",
                priority: "medium",
                payload: { action: content, activeForm },
              };
            });
            saveInProgress(join(lokiRoot, "queue", "in-progress.json"), enriched);
          }
        }
      }
      // saveAgents once per assistant message (orchestrator tool_count updates)
      saveAgents(agentsFile, agents);
      continue;
    }

    // --- user: tool_result blocks -> mark spawned agents complete
    if (msgType === "user") {
      const content = data.message?.content ?? [];
      for (const item of content) {
        if (item["type"] === "tool_result") {
          const toolId = (item["tool_use_id"] as string) ?? "";
          const a = agents[toolId];
          if (a) {
            a.status = "completed";
            a.completed_at = nowIso(clock);
            saveAgents(agentsFile, agents);
          }
        }
      }
      continue;
    }

    // --- hook events (SDK: type:'system', subtypes hook_started/hook_progress/
    // hook_response, each carrying hook_event; gated by includeHookEvents:true on
    // the query() call) -> .loki/events.jsonl as claude_hook_<name>. Key off the
    // TERMINAL frame (hook_response) so one lifecycle -> exactly one record;
    // started/progress would triple-count. ponytail: keying on hook_response is
    // the dedup; if a hook is cancelled and emits no response, that lifecycle is
    // (correctly) not recorded as a completed hook event.
    if (msgType === "system" && data.subtype === "hook_response" && data.hook_event) {
      appendHookEvent(eventsJsonl, data.hook_event, data, ctx.hookEventsEnabled, clock);
      continue;
    }

    // --- rate_limit event (SDKRateLimitEvent). The SDK emits one on EVERY call
    // as a status heartbeat with rate_limit_info.status === "allowed" -- that is
    // NOT a rate limit and must be IGNORED (verified live: status:"allowed",
    // resetsAt = the window reset epoch, not a wait). Only signal when the status
    // is actually limiting (anything other than "allowed", e.g. rejected/queued).
    if (msgType === "rate_limit" || msgType === "rate_limit_event" || data.rate_limit_info) {
      const info = data.rate_limit_info;
      const status = info?.["status"];
      // "allowed" is the every-call heartbeat; "allowed_warning" means still
      // allowed but approaching the window limit (a warning, NOT a limit yet).
      // Both are non-limiting -> ignore. Only a genuinely limiting status
      // (rejected/queued/etc.) signals a rate limit + a wait (council polish).
      if (status === undefined || status === "allowed" || status === "allowed_warning") {
        continue; // still allowed -> not a rate limit
      }
      let resetSeconds: number | undefined;
      const resetsAt = info?.["resetsAt"] ?? info?.["retryAfter"];
      if (typeof resetsAt === "number") {
        // retryAfter is seconds-from-now; resetsAt is a future epoch (seconds).
        // Convert an epoch to a wait; treat a small value as already seconds.
        if (resetsAt > 1_000_000) {
          const nowS = clock ? 0 : Math.floor(Date.now() / 1000);
          resetSeconds = nowS > 0 ? Math.max(0, resetsAt - nowS) : undefined;
        } else {
          resetSeconds = resetsAt;
        }
      }
      rateLimit = { resetSeconds };
      captured += "\n[rate_limit]\n";
      continue;
    }

    // --- result: mark all agents complete, write cost, set exit code
    if (msgType === "result") {
      sawResult = true;
      if (data.result) captured += data.result;
      const completedAt = nowIso(clock);
      for (const id of Object.keys(agents)) {
        if (agents[id]!.status === "active") {
          agents[id]!.status = "completed";
          agents[id]!.completed_at = completedAt;
          agents[id]!.current_task = "Session complete";
        }
      }
      const orch = agents[ORCHESTRATOR_ID];
      if (orch) orch.tasks_completed.push(`${orch.tool_count ?? 0} tools used`);
      saveAgents(agentsFile, agents);

      // authoritative per-iteration cost (best-effort; never throws to the loop)
      totalCostUsd = data.total_cost_usd ?? null;
      sessionId = data.session_id;
      writeResultCost(lokiRoot, ctx.iteration, data);

      exitCode = data.is_error ? 1 : 0;
      // do not break: a well-formed stream ends after result, but keep draining.
    }
  }

  return { exitCode, sessionId, totalCostUsd, capturedText: captured, rateLimit, sawResult };
}

// --- helpers (translations of the Python functions) -----------------------

async function* asAsync(src: AsyncIterable<StreamMsg> | Iterable<StreamMsg>): AsyncIterable<StreamMsg> {
  if ((src as AsyncIterable<StreamMsg>)[Symbol.asyncIterator]) {
    yield* src as AsyncIterable<StreamMsg>;
  } else {
    for (const m of src as Iterable<StreamMsg>) yield m;
  }
}

function loadAgents(agentsFile: string): Record<string, AgentInfo> {
  try {
    if (existsSync(agentsFile)) {
      const arr = JSON.parse(readFileSync(agentsFile, "utf8")) as AgentInfo[];
      const out: Record<string, AgentInfo> = {};
      for (const a of arr) {
        if (a && typeof a === "object") out[a.tool_id ?? a.agent_id] = a;
      }
      return out;
    }
  } catch {
    // ignore -- start fresh, exactly like the Python load_agents except-pass
  }
  return {};
}

function saveAgents(agentsFile: string, agents: Record<string, AgentInfo>): void {
  try {
    mkdirSync(dirname(agentsFile), { recursive: true });
    // Python writes a LIST with indent=2. Match that shape/order-of-insertion.
    writeFileSync(agentsFile, `${JSON.stringify(Object.values(agents), null, 2)}`);
  } catch {
    // best-effort: a state-write failure must never break the loop
  }
}

function saveInProgress(inProgressFile: string, tasks: unknown[]): void {
  try {
    mkdirSync(dirname(inProgressFile), { recursive: true });
    writeFileSync(inProgressFile, `${JSON.stringify(tasks, null, 2)}`);
  } catch {
    // best-effort, mirrors the Python save_in_progress except-pass
  }
}

function bumpOrchestratorTool(
  agents: Record<string, AgentInfo>,
  tool: string,
  desc: string,
): void {
  const o = agents[ORCHESTRATOR_ID];
  if (!o) return;
  o.tool_count = (o.tool_count ?? 0) + 1;
  o.current_task = desc ? `${tool}: ${desc.slice(0, 80)}` : `Using ${tool}...`;
}

// toolDesc: mirror the Python per-tool description extraction exactly.
function toolDesc(tool: string, input: Record<string, unknown>): string {
  const s = (k: string): string => (input[k] as string) ?? "";
  switch (tool) {
    case "Read":
    case "Edit":
    case "Write":
      return s("file_path");
    case "Bash":
      return s("description") || s("command").slice(0, 60);
    case "Grep":
      return `pattern: ${s("pattern")}`;
    case "Glob":
      return s("pattern");
    default:
      return "";
  }
}

function appendHookEvent(
  eventsJsonl: string,
  eventName: string,
  payload: unknown,
  enabled: boolean,
  clock?: () => string,
): void {
  if (!enabled) return;
  try {
    mkdirSync(dirname(eventsJsonl), { recursive: true });
    const record = {
      type: `claude_hook_${String(eventName).toLowerCase()}`,
      source: "claude_cli",
      timestamp: nowIso(clock),
      payload,
    };
    // Single-process SDK loop: an appendFileSync is atomic enough (the bash
    // route needs flock only because multiple processes tee the same file).
    appendFileSync(eventsJsonl, `${JSON.stringify(record)}\n`);
  } catch {
    // best-effort, like the Python append_hook_event except clause
  }
}

function writeResultCost(lokiRoot: string, iteration: string, data: StreamMsg): void {
  try {
    const cost = data.total_cost_usd;
    if (cost === undefined || cost === null) return; // Python skips when None
    const u = (data.usage ?? {}) as Record<string, number>;
    const rec = {
      total_cost_usd: cost,
      input_tokens: u["input_tokens"] ?? 0,
      output_tokens: u["output_tokens"] ?? 0,
      cache_read_tokens: u["cache_read_input_tokens"] ?? 0,
      cache_creation_tokens: u["cache_creation_input_tokens"] ?? 0,
    };
    const dir = join(lokiRoot, "metrics");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, `result-cost-${iteration}.json`);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec));
    renameSync(tmp, target); // os.replace equivalent (atomic)
  } catch {
    // best-effort, mirrors the Python try/except pass
  }
}
