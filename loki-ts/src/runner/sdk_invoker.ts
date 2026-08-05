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
// ANY failure (missing key, refusal, transport error, no API key). Callers MUST
// fail closed on null (the bash sites already do: inconclusive / REJECT / block).
// It NEVER throws for a normal failure -- null is the single failure signal.

import Anthropic from "@anthropic-ai/sdk";
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
  model: string; // full model id, e.g. claude-haiku-4-5
  effort?: Effort;
  maxTokens?: number;
  timeoutMs?: number;
  system?: string;
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

/**
 * Run a one-shot schema-constrained judge call via the raw Anthropic SDK.
 * Returns the parsed object (typed loosely as Record) or null on any failure.
 */
export async function judgeJson(params: JudgeParams): Promise<Record<string, unknown> | null> {
  const c = client();
  if (!c) return null;

  const { prompt, schema, model, effort, maxTokens = 4096, timeoutMs = 120_000, system } = params;

  try {
    // messages.create with output_config.format = { type: 'json_schema', schema }
    // constrains the model to emit JSON matching the schema. Verified against
    // @anthropic-ai/sdk@0.111.0 (JSONOutputFormat, OutputConfig).
    const msg = await c.messages.create(
      {
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: buildUserContent(prompt) }],
        output_config: {
          ...(effort ? { effort } : {}),
          format: { type: "json_schema", schema },
        },
      },
      { timeout: timeoutMs },
    );

    // A structured turn ends with the JSON in a text block. Concatenate text
    // blocks and JSON.parse. (parse() would type this, but create() keeps us
    // schema-driven without a compile-time Zod/type dependency.)
    const text = (msg.content ?? [])
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (!text.trim()) return null;

    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch {
      // The schema-constrained turn should always be valid JSON; if a provider/
      // gateway returned prose, fail closed rather than guess.
      return null;
    }
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    return obj as Record<string, unknown>;
  } catch {
    // Transport / auth / rate-limit / refusal -> single null failure signal.
    return null;
  }
}

/**
 * Run a one-shot FREE-FORM text call via the raw Anthropic SDK (no schema).
 * The sibling of judgeJson for prose sites (grill, prd-enrich) whose callers
 * parse the text themselves. Returns the concatenated text, or null on any
 * failure (missing key, transport, refusal, empty) -- same single failure
 * signal, so callers fail closed to their existing claude/deterministic path.
 */
export async function judgeText(params: TextParams): Promise<string | null> {
  const c = client();
  if (!c) return null;

  const { prompt, model, effort, maxTokens = 4096, timeoutMs = 120_000, system } = params;

  try {
    const msg = await c.messages.create(
      {
        model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: buildUserContent(prompt) }],
        // No output_config.format: a plain text turn. effort still applies.
        ...(effort ? { output_config: { effort } } : {}),
      },
      { timeout: timeoutMs },
    );
    const text = (msg.content ?? [])
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}
