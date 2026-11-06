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

import { inferenceGeoParam } from "../providers/model_routes.ts";
import { assertStaticSchema } from "../council/finding_schema.ts";
import { tmpdir } from "node:os";
import type Anthropic from "@anthropic-ai/sdk";
// The SDK is loaded lazily inside try/catch: a bundle that reaches this module but never calls a model (the control
// plane's server, built without loki-ts's node_modules) must still build, and bun leaves a try-wrapped dynamic import of
// a package it cannot resolve as a runtime import. A missing SDK means no client, which every caller already handles.
let _sdk: typeof Anthropic | null = null;
async function loadSdk(): Promise<typeof Anthropic | null> {
  if (_sdk) return _sdk;
  try { _sdk = (await import("@anthropic-ai/sdk")).default; } catch { _sdk = null; }
  return _sdk;
}
void loadSdk(); // eager, as the static import was: sync callers (sdkJudgeAvailable) see a client once the module settles
import { estimateTokens } from "../providers/price_table.ts";
import { appendChildLedger, type LedgerRecord, recordFromClaudeResult, recordFromUsage, sumChildLedger, unmeasuredRecord } from "../util/child_ledger.ts";
import { parseCapUsd } from "../e10ext/budget_cap.ts";
import { clampThinkingForEffort } from "../providers/claude_flags.ts";
import { oauthDevEnabled, readFreshOauthToken, OAUTH_BETA_HEADER } from "./oauth_dev.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// The marker build_prompt() emits between the static <loki_system> prefix and
// the volatile <dynamic_context> tail (run.sh build_prompt()). On
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

export interface PromptTokens { tokens: number; source: "measured" | "estimated"; ratio?: number }
type TokenCounter = (req: { model: string; system?: string; prompt: string }) => Promise<number>;

// Running measured/estimated ratio for this process: calibrates the chars/4 estimator for later calls.
let calib = { sum: 0, n: 0 };
let counterOverride: TokenCounter | null = null;
// The count runs before the judge call, so it must never add more than this: one attempt, hard-bounded.
const COUNT_TIMEOUT_MS = 3_000;
let countTimeoutMs = COUNT_TIMEOUT_MS;

/** TEST SEAM: inject a fake count_tokens counter (null restores the real one) and reset calibration. Production code must never call this. */
export function __setTokenCounterForTests(fn: TokenCounter | null, timeoutMs = COUNT_TIMEOUT_MS): void { counterOverride = fn; countTimeoutMs = timeoutMs; calib = { sum: 0, n: 0 }; }

/** chars/4 scaled by the mean measured ratio so far (1 before any measurement). */
export function estimatePromptTokens(text: string): number {
  return Math.ceil(estimateTokens(text) * (calib.n ? calib.sum / calib.n : 1));
}

/** Measure judge prompt tokens with messages.countTokens (API key present); on absence or error fall back to the calibrated estimate, labelled "estimated". Never throws. */
export async function measurePromptTokens(c: Anthropic, model: string, prompt: string, system?: string): Promise<PromptTokens> {
  const text = `${system ?? ""}${prompt}`;
  const est = estimateTokens(text);
  try {
    let n: number | null = null;
    // Only the first-party endpoint serves count_tokens: a gateway/proxy base URL never receives it.
    if (process.env["ANTHROPIC_API_KEY"] && onDefaultEndpoint(c)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("count_tokens timeout")), countTimeoutMs); });
      try {
        const count = counterOverride
          ? counterOverride({ model, prompt, ...(system ? { system } : {}) })
          : c.messages.countTokens({ model, ...(system ? { system } : {}), messages: [{ role: "user", content: buildUserContent(prompt) }] }, { timeout: countTimeoutMs, maxRetries: 0 }).then((r) => r.input_tokens);
        n = await Promise.race([count, bound]);
      } finally { clearTimeout(timer); }
    }
    if (typeof n === "number" && Number.isFinite(n) && n > 0 && est > 0) {
      const ratio = n / est;
      calib.sum += ratio; calib.n++;
      return { tokens: n, source: "measured", ratio };
    }
  } catch { /* unavailable or errored: fall through to the estimate */ }
  return { tokens: estimatePromptTokens(text), source: "estimated" };
}

function withPromptTokens<T extends LedgerRecord>(rec: T, pt?: PromptTokens): T {
  if (!pt) return rec;
  rec.prompt_tokens = pt.tokens;
  rec.prompt_tokens_source = pt.source;
  if (pt.ratio !== undefined) rec.token_ratio = pt.ratio;
  return rec;
}

/** COST-WALL: a judge call that threw may still have spent (timeout after the request was accepted): record an unmeasured line, a lower bound never a zero. No-op without params.ledger. */
export function noteJudgeFailure(ledger: JudgeParams["ledger"], model: string, outcome = "transport", maxTokens?: number, pt?: PromptTokens): void {
  if (!ledger) return;
  appendChildLedger(ledger.lokiDir, { ...withPromptTokens(unmeasuredRecord(ledger.phase, model, "sdk-judge"), pt), outcome, ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }), ...(ledger.thinkingClamp ? { thinking_clamp: ledger.thinkingClamp } : {}) });
}

/** COST-WALL: one ledger line per SDK judge call, priced from the response usage (the API returns tokens, not dollars). No-op without params.ledger. */
export function noteJudgeUsage(ledger: JudgeParams["ledger"], model: string, msg: { usage?: unknown } | null | undefined, outcome?: string, maxTokens?: number, pt?: PromptTokens): void {
  if (!ledger) return;
  const rec = withPromptTokens(recordFromUsage(ledger.phase, model, (msg?.usage ?? null) as Record<string, unknown> | null), pt);
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
      _client = _sdk ? new _sdk({ apiKey: key, maxRetries: 1 }) : null;
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
      if (!_sdk) return null;
      return new _sdk({
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
  | { kind: "budget" } // toolLessCall only: the run dollar cap was already reached, no request was sent
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
  await loadSdk();
  const c = client();
  if (!c) return { kind: "transport" };
  const { prompt, model, effort, timeoutMs = 120_000, system } = params;
  // The thinking type is effort-dependent per model: clamp it so the request is never a 400, and record the clamp on the ledger line.
  const { thinking, clamp } = clampThinkingForEffort(model, params.thinking, effort);
  const ledger = params.ledger && clamp ? { ...params.ledger, thinkingClamp: `${clamp.from}->${clamp.to}@${clamp.effort} (max ${clamp.max})` } : params.ledger;

  const pt = ledger ? await measurePromptTokens(c, model, prompt, system) : undefined;
  let max = judgeMaxTokens(effort, params.maxTokens);
  let retriedTruncation = false;
  let usedFallback = false;
  let refused: Extract<JudgeOutcome<string>, { kind: "refused" }> | null = null;
  for (let call = 0; call < 3; call++) {
    const body: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: max,
      ...(system ? { system } : {}),
      ...(thinking ? { thinking: thinking as Anthropic.ThinkingConfigParam } : {}),
      messages: [{ role: "user", content: buildUserContent(prompt) }],
      // LOKI_INFERENCE_GEO is billed at 1.1x (us) only if the request carries it.
      ...(inferenceGeoParam() ? { inference_geo: inferenceGeoParam() } : {}),
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
        noteJudgeFailure(ledger, model, describeJudgeOutcome(refused), max, pt);
        return refused;
      }
      if (isContextOverflow(err)) {
        noteJudgeFailure(ledger, model, "context_exceeded", max, pt);
        return { kind: "context_exceeded" };
      }
      noteJudgeFailure(ledger, model, "transport", max, pt);
      return { kind: "transport" };
    }
    const outcome = classifyStop(msg);
    const billed = typeof msg.model === "string" && msg.model ? msg.model : model;
    noteJudgeUsage(ledger, billed, msg, describeJudgeOutcome(outcome), max, pt);

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

// ---- toolLessCall: the one tool-less completion primitive (PR0) ----------------------------------------------------------
// A single completion with no tools and no agent loop, for the small deterministic-first calls (executable spec, token diet).
// Thinking is the lever: on Haiku it was about 55% of a small call's dollars. Two routes, one outcome type and one ledger:
//   api key (or the dev OAuth token): messages.create through runJudge, thinking "off" -> {type:"disabled"}, "low" -> adaptive at effort low.
//   subscription: one Agent SDK query() with tools [], maxTurns 1, no setting sources, no session file, thinking and effort mirrored.
// Measured 2026-11-05 on claude-haiku-5-5 through the Agent SDK/CLI: thinking:{type:"disabled"} (--thinking=disabled),
// CLAUDE_CODE_DISABLE_THINKING=1 and MAX_THINKING_TOKENS=0 all left thinking on for a prompt that triggers it; the result's
// thinking_tokens is recorded on the ledger line so a run shows what thinking really cost on either route.
export interface ToolLessParams {
  model: string; // full model id
  system?: string;
  prompt: string;
  maxTokens: number;
  thinking: "off" | "low";
  timeoutMs?: number;
  cwd?: string; // Agent SDK route: a directory with no project settings to read; default os tmpdir
  ledger?: { lokiDir: string; phase: string }; // default: LOKI_DIR and phase "toolless"; no directory means no line
  noCache?: boolean; // Agent SDK route: a one-shot call whose prompt is never reused writes no prompt cache (DISABLE_PROMPT_CACHING=1); a 1h cache write costs 2x the input rate
}
export interface ToolLessResult { outcome: JudgeOutcome<string>; route: "api" | "agent-sdk"; usd: number | null; thinkingTokens: number | null }

type ToolLessQuery = (args: { prompt: string; options: Record<string, unknown> }) => AsyncIterable<Record<string, unknown>>;
let queryOverride: ToolLessQuery | null = null;
/** TEST SEAM: replace the Agent SDK query(). Production code must never call this. */
export function __setToolLessQueryForTests(fn: ToolLessQuery | null): void { queryOverride = fn; }

/** Dollars still available under the run cap (LOKI_E10_MAX_COST_USD), or null with no cap. Counts the seeded prior spend and this run's child ledger lines; the live stage meter in the worker stays the authority for stage sessions. */
export function toolLessRemainingUsd(env: NodeJS.ProcessEnv, lokiDir: string | undefined): number | null {
  const cap = parseCapUsd(env["LOKI_E10_MAX_COST_USD"]);
  if (cap === null) return null;
  const runId = env["LOKI_E10_RUN_ID"];
  if (!lokiDir || !runId) return 0; // a cap that cannot be metered (no ledger dir or run id) refuses rather than never tripping
  const seed = Number(env["LOKI_E10_SPENT_USD"]);
  const spent = (Number.isFinite(seed) && seed > 0 ? seed : 0) + sumChildLedger(lokiDir, runId).partialUsd;
  return Math.max(cap - spent, 0);
}

function toolLessThinking(mode: "off" | "low"): { thinking: Anthropic.ThinkingConfigParam; effort?: Effort } {
  if (mode === "off") return { thinking: { type: "disabled" } };
  return { thinking: { type: "adaptive" }, effort: "low" };
}

async function toolLessViaAgentSdk(p: ToolLessParams, ledger: ToolLessParams["ledger"], remaining: number | null): Promise<ToolLessResult> {
  const fail = (): ToolLessResult => { if (ledger) appendChildLedger(ledger.lokiDir, { ...unmeasuredRecord(ledger.phase, p.model, "sdk-toolless"), outcome: "transport" }); return { outcome: { kind: "transport" }, route: "agent-sdk", usd: null, thinkingTokens: null }; };
  try {
    const q = queryOverride ?? ((await import("@anthropic-ai/claude-agent-sdk")).query as unknown as ToolLessQuery);
    const { thinking, effort } = toolLessThinking(p.thinking);
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const k of Object.keys(env)) if (k.startsWith("LOKI_E10_")) delete env[k];
    env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = String(p.maxTokens); // the Agent SDK has no max-tokens option; the CLI reads this env
    if (p.noCache) env["DISABLE_PROMPT_CACHING"] = "1";
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), p.timeoutMs ?? 120_000);
    let text = "", result: Record<string, unknown> | null = null;
    try {
      for await (const m of q({ prompt: p.prompt, options: {
        model: p.model, cwd: p.cwd ?? tmpdir(), tools: [], maxTurns: 1, settingSources: [], persistSession: false,
        systemPrompt: p.system ?? "", title: "loki-toolless", // a fixed title: the SDK otherwise spends a second Haiku call naming the session
        thinking, ...(effort ? { effort } : {}), env, abortController: ac,
        ...(remaining !== null ? { maxBudgetUsd: Math.max(remaining, 1e-6) } : {}),
      } })) {
        if (m["type"] === "assistant") for (const b of ((m["message"] as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [])) if (b.type === "text" && typeof b.text === "string") text += b.text;
        if (m["type"] === "result") result = m;
      }
    } finally { clearTimeout(timer); }
    if (!result) return fail();
    const rec = recordFromClaudeResult(ledger?.phase ?? "toolless", result, "sdk-toolless");
    const mu = result["modelUsage"] as Record<string, { thinkingTokens?: number }> | undefined;
    const thinkingTokens = mu ? Object.values(mu).reduce((t, u) => t + (typeof u?.thinkingTokens === "number" ? u.thinkingTokens : 0), 0) : null;
    const sub = String(result["subtype"] ?? "");
    const outcome: JudgeOutcome<string> = sub === "success" && result["is_error"] !== true
      ? (text.trim() || typeof result["result"] === "string" && (result["result"] as string).trim() ? { kind: "ok", value: text.trim() ? text : String(result["result"]) } : { kind: "malformed" })
      : sub === "error_max_budget_usd" ? { kind: "budget" } : { kind: "transport" };
    if (rec && ledger) appendChildLedger(ledger.lokiDir, { ...rec, outcome: describeJudgeOutcome(outcome), max_tokens: p.maxTokens, ...(thinkingTokens !== null ? { thinking_tokens: thinkingTokens } : {}) });
    return { outcome, route: "agent-sdk", usd: rec && typeof rec.usd === "number" ? rec.usd : null, thinkingTokens };
  } catch { return fail(); }
}

/** One tool-less completion: no tools, no agent loop, thinking off or low, priced into the child ledger (so the receipt and the run's dollar cap count it). Never throws. */
export async function toolLessCall(p: ToolLessParams): Promise<ToolLessResult> {
  const lokiDir = p.ledger?.lokiDir ?? process.env["LOKI_DIR"];
  const ledger = lokiDir ? { lokiDir, phase: p.ledger?.phase ?? "toolless" } : undefined;
  const remaining = toolLessRemainingUsd(process.env, lokiDir);
  await loadSdk();
  if (remaining !== null && remaining <= 0) return { outcome: { kind: "budget" }, route: client() ? "api" : "agent-sdk", usd: null, thinkingTokens: null };
  if (client() === null) return toolLessViaAgentSdk(p, ledger, remaining);
  const { thinking, effort } = toolLessThinking(p.thinking);
  const before = ledger ? sumChildLedger(ledger.lokiDir, process.env["LOKI_E10_RUN_ID"] ?? "").partialUsd : 0;
  const outcome = await runJudge({ prompt: p.prompt, model: p.model, maxTokens: p.maxTokens, thinking, ...(effort ? { effort } : {}), ...(p.system ? { system: p.system } : {}), ...(p.timeoutMs ? { timeoutMs: p.timeoutMs } : {}), ...(ledger ? { ledger } : {}) }, null);
  const usd = ledger && process.env["LOKI_E10_RUN_ID"] ? sumChildLedger(ledger.lokiDir, process.env["LOKI_E10_RUN_ID"]).partialUsd - before : null;
  return { outcome, route: "api", usd, thinkingTokens: null };
}
