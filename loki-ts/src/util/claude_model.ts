import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./paths.ts";

/** Recorded when a claude run has no configured model: the provider CLI runs its own default, exactly like raw `claude -p` (L1). */
export const PROVIDER_DEFAULT_MODEL = "claude (provider default)";

const FAMILY_ALIASES = new Set(["haiku", "sonnet", "opus", "fable"]);

/** Resolves a Claude cli_alias (haiku, sonnet, opus, fable) to its providers/model_catalog.json id; an id already, or an unknown alias, passes through unchanged. Catalog is located via REPO_ROOT (works from src and dist) and honours LOKI_MODEL_CATALOG. */
export function resolveClaudeModel(want: string): string {
  try {
    const path = process.env["LOKI_MODEL_CATALOG"] || resolve(REPO_ROOT, "providers/model_catalog.json");
    return JSON.parse(readFileSync(path, "utf8")).providers?.claude?.cli_aliases?.[want] ?? want;
  } catch {
    return want;
  }
}

/** True when a model string is still a bare family alias, which the API would reject with a 404. */
export function isUnresolvedClaudeAlias(model: string): boolean {
  return FAMILY_ALIASES.has(model);
}

/**
 * Strength rank of a Claude model from the catalog's own tier order: the order tiers first appear in the claude models[] (the catalog
 * says position is load-bearing), skipping legacy. 0 is the strongest tier. Null for an unknown model or an unreadable catalog, so a
 * caller never rejects on a guess.
 */
export function claudeTierRank(model: string): number | null {
  try {
    const path = process.env["LOKI_MODEL_CATALOG"] || resolve(REPO_ROOT, "providers/model_catalog.json");
    const models = JSON.parse(readFileSync(path, "utf8")).providers?.claude?.models as Array<{ id: string; alias?: string; tier: string }> | undefined;
    if (!Array.isArray(models)) return null;
    const order: string[] = [];
    for (const m of models) if (m.tier !== "legacy" && !order.includes(m.tier)) order.push(m.tier);
    const id = resolveClaudeModel(model);
    const hit = models.find((m) => m.id === id || m.alias === model);
    const rank = hit ? order.indexOf(hit.tier) : -1;
    return rank >= 0 ? rank : null;
  } catch {
    return null;
  }
}

/**
 * Effort levels the catalog records for a Claude model (providers.claude.models[].effort.levels), ordered low to max. Null when the
 * model is unknown, the catalog is unreadable, or the entry records no capability data, so a caller never clamps on a guess. An empty
 * array means the model accepts no effort parameter.
 */
export function claudeEffortLevels(model: string): string[] | null {
  try {
    const path = process.env["LOKI_MODEL_CATALOG"] || resolve(REPO_ROOT, "providers/model_catalog.json");
    const models = JSON.parse(readFileSync(path, "utf8")).providers?.claude?.models as Array<{ id: string; alias?: string; effort?: { levels?: string[] } }> | undefined;
    if (!Array.isArray(models)) return null;
    const id = resolveClaudeModel(model);
    const levels = models.find((m) => m.id === id || m.alias === model)?.effort?.levels;
    return Array.isArray(levels) ? levels : null;
  } catch {
    return null;
  }
}

interface ThinkingSpec { types?: string[]; max_effort?: Record<string, string>; substitute?: Record<string, string> }

function claudeThinkingSpec(model: string): ThinkingSpec | null {
  try {
    const path = process.env["LOKI_MODEL_CATALOG"] || resolve(REPO_ROOT, "providers/model_catalog.json");
    const models = JSON.parse(readFileSync(path, "utf8")).providers?.claude?.models as Array<{ id: string; alias?: string; thinking?: ThinkingSpec }> | undefined;
    if (!Array.isArray(models)) return null;
    const id = resolveClaudeModel(model);
    return models.find((m) => m.id === id || m.alias === model)?.thinking ?? null;
  } catch {
    return null;
  }
}

/**
 * Highest effort level at which the catalog records a model accepting a thinking type (providers.claude.models[].thinking.max_effort,
 * keyed by type). Null when the model is unknown, the catalog is unreadable, or no limit is recorded for that type, so a caller never
 * clamps on a guess. Example: the previous Opus generation accepts "disabled" only at "high" or below.
 */
export function claudeThinkingMaxEffort(model: string, type: string): string | null {
  const max = claudeThinkingSpec(model)?.max_effort?.[type];
  return typeof max === "string" ? max : null;
}

/**
 * The thinking type the catalog says to send in place of a requested one (providers.claude.models[].thinking.substitute). Null when
 * none is recorded. Example: the current Sonnet generation rejects "disabled" at every effort, so "disabled" is sent as "between_tools".
 */
export function claudeThinkingSubstitute(model: string, type: string): string | null {
  const sub = claudeThinkingSpec(model)?.substitute?.[type];
  return typeof sub === "string" ? sub : null;
}

/**
 * False when the catalog lists thinking.types for the model, the requested type is not among them, and no substitute is recorded for it,
 * so the API would answer 400 at every effort. True when the model, the catalog entry or the types list is unknown: never refuse on a guess.
 */
export function claudeThinkingAccepted(model: string, type: string): boolean {
  const spec = claudeThinkingSpec(model);
  if (!spec || !Array.isArray(spec.types)) return true;
  return spec.types.includes(type) || typeof spec.substitute?.[type] === "string";
}

/** Whether the catalog lists adaptive for the model (the type every clamp falls back to). */
export function claudeThinkingHasAdaptive(model: string): boolean {
  const types = claudeThinkingSpec(model)?.types;
  return Array.isArray(types) && types.includes("adaptive");
}

/** Session-pin values run.sh's LOKI_SESSION_MODEL case accepts: the three tier names plus the Claude aliases (opus is the top-only setting; bash dispatches it as opus, not as the sonnet-defaulted planning tier). */
export const VALID_TIERS = new Set(["planning", "development", "fast", "opus", "sonnet", "haiku", "fable"]);

/** Generic capability tiers: small|medium|high -> the canonical tier names, so downstream consumers only ever see the names in VALID_TIERS. Mirrors loki_tier_alias() in providers/models.sh. */
export const GENERIC_TIERS: Record<string, string> = {
  small: "fast",
  medium: "development",
  high: "planning",
};

/**
 * The canonical session pin for a raw LOKI_SESSION_MODEL: trim and lowercase (run.sh's session-pin rule), generic tiers translated.
 * Undefined when unset or blank. Throws on any other value, naming the valid set, so a pin is run or refused and never replaced by the provider default.
 */
export function canonicalSessionPin(raw: string | undefined): string | undefined {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return undefined;
  const pin = GENERIC_TIERS[v] ?? v;
  if (!VALID_TIERS.has(pin)) {
    throw new Error(`unknown LOKI_SESSION_MODEL '${(raw ?? "").trim()}' (small|medium|high, planning|development|fast, or opus|sonnet|haiku|fable)`);
  }
  return pin;
}

/**
 * Explicit top / floor setup, the one rule for every Bun surface: LOKI_SESSION_MODEL high|planning gives opus for the planning tier,
 * small|fast gives haiku for the fast tier (only while LOKI_ALLOW_HAIKU is unset or "true"). Never under legacy tier switching and
 * never over an explicit per-tier pin. Undefined means no setup applies. Mirrors claude.sh resolve_model_for_tier.
 */
export function explicitSetupModel(tier: string, e: NodeJS.ProcessEnv = process.env): string | undefined {
  if (e["LOKI_LEGACY_TIER_SWITCHING"] === "true") return undefined;
  const sess = (e["LOKI_SESSION_MODEL"] ?? "").trim().toLowerCase();
  if (tier === "planning" && (sess === "high" || sess === "planning")) return e["LOKI_CLAUDE_MODEL_PLANNING"] || e["LOKI_MODEL_PLANNING"] ? undefined : "opus";
  if (tier !== "fast" || (sess !== "small" && sess !== "fast") || e["LOKI_CLAUDE_MODEL_FAST"] || e["LOKI_MODEL_FAST"]) return undefined;
  return e["LOKI_ALLOW_HAIKU"] === undefined || e["LOKI_ALLOW_HAIKU"] === "true" ? "haiku" : undefined;
}
