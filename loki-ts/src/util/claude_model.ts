import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./paths.ts";

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
