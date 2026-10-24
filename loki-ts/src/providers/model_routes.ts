// loki-ts/src/providers/model_routes.ts
// Mirror of providers/model_routes.sh. Resolves a route spec such as
// "openrouter/anthropic/claude-sonnet-4.5" or "ollama/qwen3-coder" into the env
// a claude child process needs (Claude Code honors ANTHROPIC_BASE_URL and
// ANTHROPIC_AUTH_TOKEN natively). The returned env is for the CHILD only; this
// module never mutates process.env and never logs a token.
// Plain Claude ids (opus, sonnet, claude-*) resolve to null: behavior unchanged.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { REPO_ROOT } from "../util/paths.ts";
import { fileURLToPath } from "node:url";

export interface ModelRoute {
  kind: string;
  model: string;
  baseUrl: string;
  env: Record<string, string>;
}

export const MODEL_ROUTES: Record<string, { baseUrl: string; tokenVar?: string }> = {
  openrouter: { baseUrl: "https://openrouter.ai/api", tokenVar: "OPENROUTER_API_KEY" },
  ollama: { baseUrl: "http://localhost:11434" },
  lmstudio: { baseUrl: "http://localhost:1234" },
  llamacpp: { baseUrl: "http://localhost:8080" },
  vllm: { baseUrl: "http://localhost:8000" },
};

type Env = Record<string, string | undefined>;

/** Spec comes from LOKI_MODEL_ROUTE first, then LOKI_MODEL_OVERRIDE when it is a route spec. */
export function routeSpecFromEnv(env: Env): string {
  const a = (env["LOKI_MODEL_ROUTE"] ?? "").trim();
  if (a) return a;
  const b = (env["LOKI_MODEL_OVERRIDE"] ?? "").trim();
  if (b.startsWith("custom/")) return b;
  const kind = b.split("/")[0] ?? "";
  return b.includes("/") && kind in MODEL_ROUTES ? b : "";
}

export function resolveModelRoute(spec: string, env: Env = process.env): ModelRoute | null {
  const s = spec.trim();
  if (!s) return null;
  const idx = s.indexOf("/");
  if (idx < 0) return null;
  const kind = s.slice(0, idx);
  const model = s.slice(idx + 1);
  if (!model) return null;
  let baseUrl: string;
  let token = "";
  if (kind === "custom") {
    baseUrl = (env["LOKI_MODEL_BASE_URL"] ?? "").trim();
    if (!baseUrl) return null;
    token = env["LOKI_MODEL_API_KEY"] ?? "";
  } else if (kind in MODEL_ROUTES) {
    const r = MODEL_ROUTES[kind]!;
    baseUrl = r.baseUrl;
    if (r.tokenVar) token = env[r.tokenVar] ?? "";
  } else {
    return null;
  }
  return {
    kind,
    model,
    baseUrl,
    env: {
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_SMALL_FAST_MODEL: model,
      ANTHROPIC_AUTH_TOKEN: token || "loki-local-route",
      // Gateways like OpenRouter want the key only as the bearer token.
      ANTHROPIC_API_KEY: "",
    },
  };
}

/** Child env overrides for the active route, or {} when no route is configured. */
export function modelRouteEnv(env: Env = process.env): Record<string, string> {
  return resolveModelRoute(routeSpecFromEnv(env), env)?.env ?? {};
}

/** Model id the route serves, or null when no route is configured. */
export function modelRouteModel(env: Env = process.env): string | null {
  return resolveModelRoute(routeSpecFromEnv(env), env)?.model ?? null;
}

/** Claude Code's alias pinning vars (cloud platforms pin the family aliases by env). */
const ALIAS_PIN_VARS: Record<string, string> = {
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
};

/** A family alias (opus, sonnet, haiku) resolves to its ANTHROPIC_DEFAULT_*_MODEL pin when set and non-blank; any other id, or no pin, is returned unchanged. */
export function applyAliasPin(model: string, env: Env = process.env): string {
  const v = ALIAS_PIN_VARS[model.trim().toLowerCase()];
  const pin = v ? (env[v] ?? "").trim() : "";
  return pin || model;
}

/**
 * LOKI_INFERENCE_GEO picks a price multiplier from "inference_geo_multipliers" in loki-ts/data/model-pricing.json
 * (us is 1.1x), the one source the TS gate, the bash gate and the Python surfaces all read. Unset, global and
 * unknown values are 1x. If the file is unreadable, us falls back to 1.1 so a budget never silently under-counts.
 */
const INFERENCE_GEO_US_FALLBACK = 1.1;
function inferenceGeoTable(): Record<string, number> {
  try {
    const p = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "model-pricing.json");
    const t = (JSON.parse(readFileSync(p, "utf8")) as { inference_geo_multipliers?: unknown }).inference_geo_multipliers;
    if (t && typeof t === "object") return t as Record<string, number>;
  } catch { /* fall through */ }
  return { us: INFERENCE_GEO_US_FALLBACK };
}
export function inferenceGeoMultiplier(env: Env = process.env): number {
  const geo = (env["LOKI_INFERENCE_GEO"] ?? "").trim().toLowerCase();
  const m = geo ? inferenceGeoTable()[geo] : undefined;
  return typeof m === "number" && Number.isFinite(m) && m > 0 ? m : 1;
}

/**
 * The request-level `inference_geo` body parameter (typed in @anthropic-ai/sdk MessageCreateParams). Only the
 * values that name a region are sent, so the 1.1x multiplier above is billed only when the request asked for it.
 */
export function inferenceGeoParam(env: Env = process.env): string | undefined {
  const geo = (env["LOKI_INFERENCE_GEO"] ?? "").trim().toLowerCase();
  return geo === "us" || geo === "global" ? geo : undefined;
}

/** Label for a non-Anthropic model behind the claude CLI (D99 item 1). */
export const GATEWAY_LANE_LABEL = "gateway lane (unqualified)";
export const GATEWAY_LANE_LOSS =
  "prompt caching, extended thinking, server tools and hooks are not guaranteed on this lane";

function isClaudeModelId(m: string): boolean {
  const s = m.trim().toLowerCase();
  return s === "" || s === "opus" || s === "sonnet" || s === "haiku" || s.startsWith("claude-") || s.includes("anthropic/claude");
}

/**
 * GATEWAY_LANE_LABEL when a non-Anthropic model is routed behind the claude CLI
 * (an active model route, or ANTHROPIC_BASE_URL plus a non-Claude
 * LOKI_MODEL_OVERRIDE). Null for Claude routes: no label.
 */
export function gatewayLaneLabel(env: Env = process.env): string | null {
  if (resolveModelRoute(routeSpecFromEnv(env), env)) return GATEWAY_LANE_LABEL;
  const base = (env["ANTHROPIC_BASE_URL"] ?? "").trim();
  return base && !isClaudeModelId(env["LOKI_MODEL_OVERRIDE"] ?? "") ? GATEWAY_LANE_LABEL : null;
}

/**
 * OTel variables handed to the provider child unchanged; only those set, never invented.
 * Both TS routes already inherit process.env, so this is an explicit, documented
 * no-op that pins the contract (and survives any future env scrubbing).
 */
export const OTEL_PASSTHROUGH_VARS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SERVICE_NAME",
  "CLAUDE_CODE_ENABLE_TELEMETRY",
] as const;

export function otelPassthroughEnv(env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of OTEL_PASSTHROUGH_VARS) {
    const v = env[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// LOKI_EFFORT knob (#346 slice 2). Mirror of loki_provider_effort / loki_effort_argv /
// loki_effort_record in providers/models.sh: the catalog row (models[].effort, else
// providers.<p>.effort) clamps the request, and a row with no flag is "unsupported"
// so no flag is ever invented.
// ---------------------------------------------------------------------------

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

export interface ProviderEffort {
  effort: string;
  flag: string;
  clampedFrom: string;
}

/** Null when no valid effort is requested or the catalog has no row. */
export function providerEffortParam(provider: string, model: string, env: Env = process.env, requested?: string): ProviderEffort | null {
  const req = requested ?? env["LOKI_EFFORT"] ?? "";
  if (!EFFORT_ORDER.includes(req)) return null;
  try {
    const path = env["LOKI_MODEL_CATALOG"] || resolve(REPO_ROOT, "providers/model_catalog.json");
    type Row = { flag?: string | null; levels?: string[]; unsupported?: boolean };
    const p = JSON.parse(readFileSync(path, "utf8")).providers?.[provider] as { effort?: Row; models?: Array<{ id?: string; alias?: string; effort?: Row }> } | undefined;
    const m = p?.models?.find((x) => model && (x.id === model || x.alias === model));
    const e = m?.effort ?? p?.effort;
    if (!e) return null;
    const levels = EFFORT_ORDER.filter((l) => (e.levels ?? []).includes(l));
    if (e.unsupported || !e.flag || levels.length === 0) return { effort: "unsupported", flag: "", clampedFrom: req };
    let eff = req;
    if (!levels.includes(eff)) {
      const below = levels.filter((l) => EFFORT_ORDER.indexOf(l) <= EFFORT_ORDER.indexOf(req));
      eff = below.length > 0 ? below[below.length - 1]! : levels[0]!;
    }
    return { effort: eff, flag: e.flag, clampedFrom: eff !== req ? req : "" };
  } catch {
    return null;
  }
}

/** One JSON line per stage in ${LOKI_DIR:-.loki}/state/effort.jsonl. Never throws. */
export function recordEffort(provider: string, stage: string, model: string, effort: string, clampedFrom: string, env: Env = process.env): void {
  try {
    const dir = resolve(env["LOKI_DIR"] || ".loki", "state");
    mkdirSync(dir, { recursive: true });
    appendFileSync(resolve(dir, "effort.jsonl"), JSON.stringify({ provider, stage, model, effort, clamped_from: clampedFrom }) + "\n");
  } catch {
    // an audit line must never fail a run
  }
}

/** The provider's own effort argv (empty when unrequested or unsupported), recorded per stage. */
export function effortArgv(provider: string, model: string, stage: string, env: Env = process.env): string[] {
  const r = providerEffortParam(provider, model, env);
  if (!r) return [];
  recordEffort(provider, stage, model, r.effort, r.clampedFrom, env);
  return r.flag ? [r.flag, r.effort] : [];
}
