import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Resolves a Claude cli_alias (haiku, sonnet, opus, fable) to its providers/model_catalog.json id; an id already, or an unknown alias, passes through unchanged. */
export function resolveClaudeModel(want: string): string {
  try {
    const cat = JSON.parse(readFileSync(join(import.meta.dir, "../../../providers/model_catalog.json"), "utf8"));
    return cat.providers?.claude?.cli_aliases?.[want] ?? want;
  } catch {
    return want;
  }
}
