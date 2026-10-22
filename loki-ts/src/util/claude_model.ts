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
