// D60-5 (INTEL-2): the per-run dollar cap. Resolution order: --max-cost, then loki.yaml budgets.per_run, then the default.
// Enforced in the worker (worker.ts -> machine.ts overCap): once priced cost reaches the cap no further stage starts and the
// run ends BUDGET_STOP (exit 3). Unpriced sessions (usd null) never count, so an unmetered run is not stopped by a guess.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
export const DEFAULT_MAX_COST_USD = 20;
export type CapSource = "--max-cost" | "loki.yaml" | "default";
export function parseCapUsd(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : /^\$?\d+(\.\d+)?$/.test(String(raw ?? "").trim()) ? Number(String(raw).trim().replace("$", "")) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}
/** budgets.per_run from loki.yaml text (a two-level read; no YAML dependency). */
export function yamlPerRun(text: string): number | null {
  const m = /^budgets:[ \t]*(?:#.*)?\n((?:[ \t]+.*\n?|[ \t]*\n)*)/m.exec(text);
  const v = m ? /^[ \t]+per_run:[ \t]*([^\s#]+)/m.exec(m[1]!)?.[1] : undefined;
  return v === undefined ? null : parseCapUsd(v);
}
export function resolveCap(cli: string | null, repoDir: string): { usd: number; source: CapSource } | { error: string } {
  if (cli !== null) { const n = parseCapUsd(cli); return n === null ? { error: "--max-cost must be a positive number of US dollars" } : { usd: n, source: "--max-cost" }; }
  for (const f of ["loki.yaml", "loki.yml"]) {
    const p = join(repoDir, f);
    if (!existsSync(p)) continue;
    let n: number | null = null;
    try { n = yamlPerRun(readFileSync(p, "utf8")); } catch { /* unreadable: fall through to the default */ }
    if (n !== null) return { usd: n, source: "loki.yaml" };
  }
  return { usd: DEFAULT_MAX_COST_USD, source: "default" };
}
export function capNote(usd: number, source: CapSource): string { return `cap $${usd.toFixed(2)} (${source})`; }
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
