// D60-5 (INTEL-2): the per-run dollar cap. Resolution order: --max-cost, then LOKI_BUDGET_LIMIT, then loki.yaml budgets.per_run, then the default.
// D82-COSTCAP: the default is $100 when an API key is set in the env, and NO dollar cap on a subscription run (no key).
// Only whether the key variable is SET is checked; its value is never read or printed.
// Enforced in the worker (worker.ts -> machine.ts overCap): once priced cost reaches the cap no further stage starts and the
// run ends BUDGET_STOP (exit 3). Unpriced sessions (usd null) never count, so an unmetered run is not stopped by a guess.
import { existsSync, readFileSync } from "node:fs"; import { dirname, join, resolve } from "node:path"; import { fileURLToPath } from "node:url";
import { yamlKey } from "../util/yaml_key.ts";
// LM-002: the default per-run cap (default_max_cost_usd) lives in loki-ts/data/model-pricing.json, also read by autonomy/run.sh and autonomy/loki.
// The data dir is ../../data from src/e10ext and ../data from the bundled dist; the literal is only the last-resort fallback, and a test pins it to the file.
const DEFAULT_FALLBACK_USD = 100;
export function loadDefaultMaxCostUsd(): number {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of [["..", "..", "data"], ["..", "data"]]) {
    try {
      const j = JSON.parse(readFileSync(resolve(here, ...rel, "model-pricing.json"), "utf8")) as { default_max_cost_usd?: unknown };
      if (typeof j.default_max_cost_usd === "number" && Number.isFinite(j.default_max_cost_usd) && j.default_max_cost_usd > 0) return j.default_max_cost_usd;
    } catch { /* try the next location */ }
  }
  return DEFAULT_FALLBACK_USD;
}
export const DEFAULT_MAX_COST_USD = loadDefaultMaxCostUsd();
export const SUBSCRIPTION_NOTE = "subscription: no dollar cap; usage counts against your plan limits";
export type CapSource = "--max-cost" | "env" | "loki.yaml" | "default" | "subscription";
/** True when a provider API key variable is set (presence only; the value is never read). */
export function hasApiKey(env: NodeJS.ProcessEnv): boolean {
  return ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].some((k) => (env[k] ?? "") !== "");
}
export function parseCapUsd(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : /^\$?\d+(\.\d+)?$/.test(String(raw ?? "").trim()) ? Number(String(raw).trim().replace("$", "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
/** budgets.per_run from loki.yaml text (a two-level read; no YAML dependency). */
export function yamlPerRun(text: string): number | null { return parseCapUsd(yamlKey(text, "budgets", "per_run")); }
/** usd 0 means no dollar cap (subscription run). */
export function resolveCap(cli: string | null, repoDir: string, env: NodeJS.ProcessEnv = process.env): { usd: number; source: CapSource } | { error: string } {
  if (cli !== null) { const n = parseCapUsd(cli); return n === null ? { error: "--max-cost must be a positive number of US dollars" } : { usd: n, source: "--max-cost" }; }
  const envCap = parseCapUsd(env.LOKI_BUDGET_LIMIT); if (envCap !== null) return { usd: envCap, source: "env" }; // same variable the bash route reads; flag > env > loki.yaml > default
  for (const f of ["loki.yaml", "loki.yml"]) {
    const p = join(repoDir, f);
    if (!existsSync(p)) continue;
    let n: number | null = null;
    try { n = yamlPerRun(readFileSync(p, "utf8")); } catch { /* unreadable: fall through to the default */ }
    if (n !== null) return { usd: n, source: "loki.yaml" };
  }
  return hasApiKey(env) ? { usd: DEFAULT_MAX_COST_USD, source: "default" } : { usd: 0, source: "subscription" };
}
export function capNote(usd: number, source: CapSource): string {
  if (usd <= 0) return "no dollar cap (subscription)";
  return `cap $${usd.toFixed(2)} (${source})`; }
/** Worker side: wraps the emit fn so every cost event feeds the meter; `over` is RunContext.overCap. */
export function capMeter<E extends (type: never, stage: never, data: Record<string, unknown>) => void>(raw: E, env: NodeJS.ProcessEnv): { emit: E; over: () => boolean } {
  const m = costMeter(parseCapUsd(env.LOKI_E10_MAX_COST_USD) ?? 0);
  const emit = ((type: string, stage: never, data: Record<string, unknown>) => { if (type === "cost") m.add(data.usd); (raw as unknown as (...a: unknown[]) => void)(type, stage, data); }) as unknown as E;
  return { emit, over: m.over };
}
/** Running priced total for the worker; call with each emitted cost event's usd. */
export function costMeter(capUsd: number): { add(usd: unknown): void; over(): boolean } {
  let sum = 0;
  return { add: (u) => { if (typeof u === "number" && Number.isFinite(u) && u > 0) sum += u; }, over: () => capUsd > 0 && sum >= capUsd };
}
