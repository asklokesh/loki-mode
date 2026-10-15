// LM-002: the default per-run cap lives in loki-ts/data/budget-defaults.json, read here and by autonomy/run.sh (one source of truth).
// The data dir is ../../data from src/util and ../data from the bundled dist; the literal is only the last-resort fallback, and a test pins it to the file.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const DEFAULT_FALLBACK_USD = 100;
export function loadDefaultMaxCostUsd(): number {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of [["..", "..", "data"], ["..", "data"]]) {
    try {
      const j = JSON.parse(readFileSync(resolve(here, ...rel, "budget-defaults.json"), "utf8")) as { default_max_cost_usd?: unknown };
      if (typeof j.default_max_cost_usd === "number" && Number.isFinite(j.default_max_cost_usd) && j.default_max_cost_usd > 0) return j.default_max_cost_usd;
    } catch { /* try the next location */ }
  }
  return DEFAULT_FALLBACK_USD;
}
export const DEFAULT_MAX_COST_USD = loadDefaultMaxCostUsd();
