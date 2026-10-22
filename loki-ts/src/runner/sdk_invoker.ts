// v8 Phase 1: the raw-SDK "judge" path.
//
// The bridge that replaces a `claude -p --json-schema` one-shot judge call with a
// pure-HTTPS `@anthropic-ai/sdk` call (zero binary). One prompt in, one
// schema-constrained JSON object out. No tool loop, no filesystem, no subprocess.
//
// This is the deploy-at-scale layer: enterprise containers / Autonomi SaaS run
// this with just ANTHROPIC_API_KEY (or a gateway/Bedrock/Vertex base URL) and no
// `claude` binary. The agentic RARV dev loop is a SEPARATE, later phase on the
// Agent SDK; do NOT route agentic work through here.
//
// Contract: judgeJson() returns the parsed object matching `schema`, or null on
// ANY failure (missing key, refusal, truncation, transport error, no API key).
// Callers MUST fail closed on null (the bash sites already do: inconclusive /
// REJECT / block). It NEVER throws for a normal failure. judgeJsonOutcome()
// returns the same call as a typed JudgeOutcome naming the cause.

import { assertStaticSchema } from "../council/finding_schema.ts";
import Anthropic from "@anthropic-ai/sdk";
import { appendChildLedger, recordFromUsage, unmeasuredRecord } from "../util/child_ledger.ts";
import { clampThinkingForEffort } from "../providers/claude_flags.ts";
import { oauthDevEnabled, readFreshOauthToken, OAUTH_BETA_HEADER } from "./oauth_dev.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// The marker build_prompt() emits between the static <loki_system> prefix and
// the volatile <dynamic_context> tail (build_prompt.ts:1375, run.sh:15404). On
// the SDK route (in-process) we can split on it and mark the prefix as a cache
// breakpoint so multi-iteration runs re-read cached prefix tokens instead of
// re-billing them. The bash route shells out per iteration, so its copy of this
// marker is inert there.
const CACHE_BREAKPOINT = "[CACHE_BREAKPOINT]";

// SLICE 6b: REAL prompt caching on the SDK route.
// Env var: LOKI_SDK_PROMPT_CACHE. Default 0 (unset/"0"/"false" -> current
// single-string behavior, no regression on a stock run). Set to 1/true to
// opt in.
function promptCacheEnabled(): boolean {
  const v = (process.env["LOKI_SDK_PROMPT_CACHE"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Shape the messages.create `content` field for a user turn.
//   - flag OFF, or the [CACHE_BREAKPOINT] marker absent: return the prompt
//     unchanged (a plain string) -- byte-identical to prior behavior.
//   - flag ON and marker present: split ONCE on the marker into a 2-block array
//     [ static-prefix (cache_control ephemeral), dynamic-tail (plain) ]. The
//     marker line itself is dropped from both blocks (it is a documentation
//     anchor, not model-facing content).
// Exported for the hermetic unit test; no network, pure string work.
export function buildUserContent(prompt: string): string | Anthropic.TextBlockParam[] {
  if (!promptCacheEnabled()) return prompt;
  const idx = prompt.indexOf(CACHE_BREAKPOINT);
  if (idx === -1) return prompt;
  const prefix = prompt.slice(0, idx);
  const tail = prompt.slice(idx + CACHE_BREAKPOINT.length);
  return [
    { type: "text", text: prefix, cache_control: { type: "ephemeral" } },
    { type: "text", text: tail },
  ];
}

export interface JudgeParams {
  prompt: string;
  schema: Record<string, unknown>; // JSON Schema (draft-07); Loki's loki-ts/data/*.json
  model: string; // full model id, resolved from the catalog
  effort?: Effort;
  maxTokens?: number; // default sized by effort (EFFORT_MAX_TOKENS), 4096 without one
  thinking?: Anthropic.ThinkingConfigParam; // forwarded to the request unchanged; unset sends nothing
  timeoutMs?: number;
  system?: string;
  ledger?: { lokiDir: string; phase: string; thinkingClamp?: string }; // COST-WALL: append this call's usage to .loki/metrics/child-sessions.jsonl
}

// Thinking tokens count against max_tokens, so a 4096 cap shared by adaptive thinking and the answer starves an xhigh/max judge.
export const EFFORT_MAX_TOKENS: Record<Effort, number> = { low: 4096, medium: 8192, high: 16384, xhigh: 64000, max: 64000 };
// The SDK refuses a non-streaming request above this cap; the catch below would turn that throw into a silent null.
export const STREAM_ABOVE_TOKENS = 21_333;
export const judgeMaxTokens = (effort?: Effort, maxTokens?: number): number => maxTokens ?? (effort ? EFFORT_MAX_TOKENS[effort] : 4096);

/** One judge request: streamed (finalMessage) above STREAM_ABOVE_TOKENS, else messages.create. */
async function sendJudge(c: Anthropic, body: Anthropic.MessageCreateParamsNonStreaming, timeoutMs: number, headers?: Record<string, string>): Promise<Anthropic.Message> {
  const opts = { timeout: timeoutMs, ...(headers ? { headers } : {}) };
  // A stream's timeout covers only the connection; the signal bounds the whole turn.
  return body.max_tokens > STREAM_ABOVE_TOKENS ? c.messages.stream(body, { ...opts, signal: AbortSignal.timeout(timeoutMs) }).finalMessage() : c.messages.create(body, opts);
}

/** COST-WALL: a judge call that threw may still have spent (timeout after the request was accepted): record an unmeasured line, a lower bound never a zero. No-op without params.ledger. */
export function noteJudgeFailure(ledger: JudgeParams["ledger"], model: string, outcome = "transport", maxTokens?: number): void {
  if (!ledger) return;
  appendChildLedger(ledger.lokiDir, { ...unmeasuredRecord(ledger.phase, model, "sdk-judge"), outcome, ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }), ...(ledger.thinkingClamp ? { thinking_clamp: ledger.thinkingClamp } : {}) });
}

/** COST-WALL: one ledger line per SDK judge call, priced from the response usage (the API returns tokens, not dollars). No-op without params.ledger. */
export function noteJudgeUsage(ledger: JudgeParams["ledger"], model: string, msg: { usage?: unknown } | null | undefined, outcome?: string, maxTokens?: number): void {
  if (!ledger) return;
  const rec = recordFromUsage(ledger.phase, model, (msg?.usage ?? null) as Record<string, unknown> | null);
  if (outcome) rec.outcome = outcome;
  if (ledger.thinkingClamp) rec.thinking_clamp = ledger.thinkingClamp;
  if (maxTokens !== undefined) rec.max_tokens = maxTokens; // output_tokens against max_tokens shows a cap that truncated the answer
  appendChildLedger(ledger.lokiDir, rec);
}

// Same shape as JudgeParams but with no schema: a free-form text turn (grill
// questions, prd enrichment). The output is prose, not a schema-constrained
// object, so there is nothing to parse.
export type TextParams = Omit<JudgeParams, "schema">;

// Lazy singleton: constructing the client reads ANTHROPIC_API_KEY. Absent key ->
// we return null from judgeJson rather than throwing, so a missing key degrades
// to the bash/deterministic fallback exactly like an unsupported CLI flag does.
// Cache ONLY a successfully-constructed client. We deliberately do NOT cache the
// no-key/failure state: the key may be injected LATE (enterprise container /
// SaaS that sets ANTHROPIC_API_KEY after this module loads), and a permanently
// cached null would keep the SDK route disabled for the whole process. Reading
// the env and constructing the client are both cheap, so re-probing when we do
// not yet hold a client costs nothing and is correct under late injection.
let _client: Anthropic | null = null;
function client(): Anthropic | null {
  if (_client !== null) return _client;
  const key = process.env["ANTHROPIC_API_KEY"];
  if (key) {
    try {
      // Bound retries (default is 2): a slow judge site must not stack
      // timeout-retries under the OS-level ceiling the bash caller wraps us in.
      // One retry tolerates a transient blip without letting worst-case latency
      // balloon (council review, security-arch lens).
      _client = new Anthropic({ apiKey: key, maxRetries: 1 });
    } catch {
      _client = null;
    }
    return _client;
  }
  // DEV-ONLY OAuth fallback (LOKI_SDK_OAUTH_DEV=1, no API key): use the developer's
  // existing `claude` login (a claude.ai OAuth token) so the SDK route can be
  // exercised in development without a standalone API key. The token expires
  // ~hourly and is not refreshed here, so we build a FRESH client each call
  // (never cache it -- a cached client would keep a token that expires mid-run)
  // and fail closed to null when no fresh token is available. Inert in production
  // (flag unset) and whenever an API key is present (handled above).
  if (oauthDevEnabled()) {
    const token = readFreshOauthToken();
    if (!token) return null;
    try {
      return new Anthropic({
        authToken: token,
        maxRetries: 1,
        // The Messages API requires this beta header to accept a claude.ai OAuth
        // bearer token (verified live 2026-07-15).
        defaultHeaders: { "anthropic-beta": OAUTH_BETA_HEADER },
      });
    } catch {
      return null;
    }
  }
  return null;
}

// Return whether an SDK judge client can be CONSTRUCTED (an API key is present,
// or a fresh dev-OAuth token under LOKI_SDK_OAUTH_DEV). This does NOT probe the
// network -- a true result means "we can attempt a call", not "the endpoint is
// reachable"; judgeJson/judgeText still fail closed to null on any transport
// error. Callers use this to decide the SDK-vs-bash branch before spending.
export function sdkJudgeAvailable(): boolean {
  return client() !== null;
}

/**
 * Drop the cached client so the next call re-reads ANTHROPIC_API_KEY.
 *
 * TEST SEAM. The singleton is deliberately process-lifetime (see the comment on
 * `_client`: a key can be injected late, so we must not cache the no-key state).
 * That is correct in production and wrong under a test runner, where every file
 * shares one process: a sibling test that sets ANTHROPIC_API_KEY populates the
 * singleton, and a later test that DELETES the env var still sees a live client.
 * The failure is order-dependent, so it reproduces in CI and not locally --
 * exactly the kind of flake that reads as a real regression and costs a release
 * cycle to chase.
 *
 * Production code must never call this; it only exists so a test can restore the
 * clean-process assumption it is entitled to.
 */
export function __resetSdkClientForTests(): void {
  _client = null;
}

/** TEST SEAM: inject a stub client. Production code must never call this. */
export function __setSdkClientForTests(stub: unknown): void {
  _client = stub as Anthropic;
}

// Stop reasons are HTTP 200, not errors (handling-stop-reasons). Every judge
// call resolves to ONE typed outcome so a truncated or refused vote is named,
// never a bare null.
export type JudgeOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "truncated" }
  | { kind: "refused"; category: string | null }
  | { kind: "context_exceeded" }
  | { kind: "malformed" }
  | { kind: "transport" };

/** Compact name for a non-ok outcome (stderr line, ledger field): "refused:cyber", "truncated". */
export function describeJudgeOutcome(o: JudgeOutcome<unknown>): string {
  return o.kind === "refused" && o.category ? `refused:${o.category}` : o.kind;
}

/** The text an in-process caller appends to its gate record for a non-ok outcome, so the cause is named and never a bare miss. */
export function judgeOutcomeNote(o: JudgeOutcome<unknown>): string {
  return `sdk judge outcome: ${describeJudgeOutcome(o)}`;
}

// Server-side fallback (refusals-and-fallback): the API re-runs a refused turn
// on a fallback model. Beta header plus "fallbacks": "default". Not available
// on Batches (retries here are always synchronous). An allowlist: only the
// Claude 5 Fable, Opus and Sonnet ids support it; Haiku 5.5, older models and
// unknown overrides (for example claude-opus-4-8) never send "fallbacks".
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const TRUNCATION_RETRY_CAP = Math.max(...Object.values(EFFORT_MAX_TOKENS)); // the effort table's ceiling, so an xhigh/max default is never capped below its own size

function fallbackEligible(model: string): boolean {
  return /^claude-(fable|opus|sonnet)-5(-\d+)?$/i.test(model);
}

// Refusal categories the default fallback does NOT retry (claude-api model
// migration guide): Sonnet 5.x retries only cyber and frontier_llm; Opus 5.x
// never retries reasoning_extraction. Fable per-category routing is unpublished
// server-side, so retry-all is assumed and fail-safe (a wasted retry, never a
// lost one). A null category is tried: unknown.
function fallbackCovers(model: string, category: string | null): boolean {
  if (category === null) return true;
  if (/^claude-sonnet-/i.test(model)) return category === "cyber" || category === "frontier_llm";
  if (/^claude-opus-/i.test(model)) return category !== "reasoning_extraction";
  return true;
}

// Server-side fallback is an Anthropic API feature. A gateway or proxy base URL
// (ANTHROPIC_BASE_URL or the client's own) may reject the beta field, so only
// the default endpoint gets it.
const DEFAULT_BASE_URL = "https://api.anthropic.com";
function onDefaultEndpoint(c: Anthropic): boolean {
  const raw = (c as { baseURL?: unknown }).baseURL;
  const url = (typeof raw === "string" && raw ? raw : process.env["ANTHROPIC_BASE_URL"] || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return url.toLowerCase() === DEFAULT_BASE_URL;
}

// A 400/413 "prompt is too long" is a context overflow, not a transport fault.
function isContextOverflow(err: unknown): boolean {
  const e = err as { status?: unknown; message?: unknown; error?: unknown } | null;
  if (!e || (e.status !== 400 && e.status !== 413)) return false;
  let detail = String(e.message ?? "");
  try { detail += " " + JSON.stringify(e.error ?? ""); } catch { /* unserializable body */ }
  return /prompt is too long|too long|context (window|length)|exceed(s|ed)? .*(context|token|limit)/i.test(detail);
}

function createWithFallback(
  c: Anthropic,
  body: Anthropic.MessageCreateParamsNonStreaming,
  timeoutMs: number,
): Promise<Anthropic.Message> {
  // The dev-OAuth client carries its own default anthropic-beta header; a
  // per-request header replaces it, so re-send it alongside the fallback beta.
  const beta = process.env["ANTHROPIC_API_KEY"] ? FALLBACK_BETA : `${OAUTH_BETA_HEADER},${FALLBACK_BETA}`;
  return sendJudge(c, { ...body, fallbacks: "default" } as Anthropic.MessageCreateParamsNonStreaming, timeoutMs, { "anthropic-beta": beta });
}

function classifyStop(msg: Anthropic.Message): JudgeOutcome<string> {
  const text = (msg.content ?? [])
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  switch (msg.stop_reason) {
    case "max_tokens":
      return { kind: "truncated" };
    case "refusal":
      return { kind: "refused", category: (msg.stop_details as { category?: string } | null)?.category ?? null };
    case "model_context_window_exceeded":
      return { kind: "context_exceeded" };
    case "end_turn":
    case "stop_sequence":
      return text.trim() ? { kind: "ok", value: text } : { kind: "malformed" };
    default:
      // tool_use, pause_turn, null: text may exist but the turn is not a finished answer.
      return { kind: "malformed" };
  }
}

// Shared core for judgeJson/judgeText. Recovery, bounded to 3 calls:
//   truncated -> ONE retry with a larger max_tokens
//   refused   -> ONE retry with server-side fallback (eligible models only)
// Anything else is returned as its named outcome. Never throws.
async function runJudge(params: JudgeParams | TextParams, schema: Record<string, unknown> | null): Promise<JudgeOutcome<string>> {
  const c = client();
  if (!c) return { kind: "transport" };
  const { prompt, model, effort, timeoutMs = 120_000, system } = params;
  // The thinking type is effort-dependent per model: clamp it so the request is never a 400, and record the clamp on the ledger line.
  const { thinking, clamp } = clampThinkingForEffort(model, params.thinking, effort);
  const ledger = params.ledger && clamp ? { ...params.ledger, thinkingClamp: `${clamp.from}->${clamp.to}@${clamp.effort} (max ${clamp.max})` } : params.ledger;

  let max = judgeMaxTokens(effort, params.maxTokens);
  let retriedTruncation = false;
  let usedFallback = false;
  let refused: Extract<JudgeOutcome<string>, { kind: "refused" }> | null = null;
  for (let call = 0; call < 3; call++) {
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: max,
      ...(system ? { system } : {}),
      ...(thinking ? { thinking } : {}),
      messages: [{ role: "user", content: buildUserContent(prompt) }],
      // messages.create with output_config.format = { type: 'json_schema', schema }
      // constrains the model to emit JSON matching the schema. Verified against
      // @anthropic-ai/sdk@0.111.0 (JSONOutputFormat, OutputConfig). Free-form
      // text turns send effort only.
      ...(schema || effort
        ? { output_config: { ...(effort ? { effort } : {}), ...(schema ? { format: { type: "json_schema" as const, schema } } : {}) } }
        : {}),
    };
    let msg: Anthropic.Message;
    try {
      msg = usedFallback
        ? await createWithFallback(c, body, timeoutMs)
        : await sendJudge(c, body, timeoutMs);
    } catch (err) {
      // A throw, unlike a stop_reason. If the fallback retry threw after a
      // refusal, the refusal is the real answer; do not downgrade it to transport.
      if (usedFallback && refused) {
        noteJudgeFailure(ledger, model, describeJudgeOutcome(refused), max);
        return refused;
      }
      if (isContextOverflow(err)) {
        noteJudgeFailure(ledger, model, "context_exceeded", max);
        return { kind: "context_exceeded" };
      }
      noteJudgeFailure(ledger, model, "transport", max);
      return { kind: "transport" };
    }
    const outcome = classifyStop(msg);
    const billed = typeof msg.model === "string" && msg.model ? msg.model : model;
    noteJudgeUsage(ledger, billed, msg, describeJudgeOutcome(outcome), max);

    if (outcome.kind === "truncated" && !retriedTruncation && Math.min(max * 2, TRUNCATION_RETRY_CAP) > max) {
      retriedTruncation = true;
      max = Math.min(max * 2, TRUNCATION_RETRY_CAP);
      continue;
    }
    if (outcome.kind === "refused" && !usedFallback && fallbackEligible(model) && onDefaultEndpoint(c) && fallbackCovers(model, outcome.category)) {
      usedFallback = true;
      refused = outcome;
      continue;
    }
    return outcome;
  }
  return { kind: "transport" };
}

/** Run a one-shot schema-constrained judge call and return its typed outcome. */
export async function judgeJsonOutcome(params: JudgeParams): Promise<JudgeOutcome<Record<string, unknown>>> {
  // #295: a schema carrying a literal the static schema files do not (run data, a secret) is refused before it reaches the API's 24h schema cache.
  try { assertStaticSchema(params.schema); } catch (e) { process.stderr.write(`[judge] ${(e as Error).message}\n`); return { kind: "malformed" }; }
  const o = await runJudge(params, params.schema);
  if (o.kind !== "ok") return o;
  let obj: unknown;
  try {
    obj = JSON.parse(o.value);
  } catch {
    // The schema-constrained turn should always be valid JSON; if a provider/
    // gateway returned prose, fail closed rather than guess.
    return { kind: "malformed" };
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return { kind: "malformed" };
  return { kind: "ok", value: obj as Record<string, unknown> };
}

/**
 * Run a one-shot schema-constrained judge call via the raw Anthropic SDK.
 * Returns the parsed object (typed loosely as Record) or null on any non-ok
 * outcome. Callers that need the cause use judgeJsonOutcome.
 */
export async function judgeJson(params: JudgeParams): Promise<Record<string, unknown> | null> {
  const o = await judgeJsonOutcome(params);
  return o.kind === "ok" ? o.value : null;
}

/** Free-form sibling of judgeJsonOutcome. */
export async function judgeTextOutcome(params: TextParams): Promise<JudgeOutcome<string>> {
  return runJudge(params, null);
}

/**
 * Run a one-shot FREE-FORM text call via the raw Anthropic SDK (no schema).
 * The sibling of judgeJson for prose sites (grill, prd-enrich) whose callers
 * parse the text themselves. Returns the concatenated text, or null on any
 * non-ok outcome -- same single failure signal, so callers fail closed to their
 * existing claude/deterministic path.
 */
export async function judgeText(params: TextParams): Promise<string | null> {
  const o = await judgeTextOutcome(params);
  return o.kind === "ok" ? o.value : null;
}
