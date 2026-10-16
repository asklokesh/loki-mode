// D60-5 (INTEL-2): the per-run dollar cap. Resolution order: --max-cost, then LOKI_BUDGET_LIMIT, then loki.yaml budgets.per_run, then the default.
// D82-COSTCAP: the default is $100 when an API key is set in the env, and NO dollar cap on a subscription run (no key).
// Only whether the key variable is SET is checked; its value is never read or printed.
// Enforced in the worker (worker.ts -> machine.ts overCap): once priced cost reaches the cap no further stage starts and the
// run ends BUDGET_STOP (exit 3). Unpriced sessions (usd null) never count, so an unmetered run is not stopped by a guess.
import { lokiYamlTexts, yamlKey } from "../util/yaml_key.ts"; import { loadDefaultMaxCostUsd } from "../runner/budget.ts";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"; import { join, resolve } from "node:path"; import { capability } from "../providers/provider_guard.ts";
export const DEFAULT_MAX_COST_USD = loadDefaultMaxCostUsd(); // LM-002: default per-run cap lives in loki-ts/data/model-pricing.json, read by runner/budget.ts
export const SUBSCRIPTION_NOTE = "subscription: no dollar cap; usage counts against your plan limits";
export type CapSource = "--max-cost" | "env" | "loki.yaml" | "default" | "subscription";
/** True when a provider API key variable is set (presence only; the value is never read). */
export function hasApiKey(env: NodeJS.ProcessEnv): boolean { return ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].some((k) => (env[k] ?? "") !== ""); }
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
  for (const text of lokiYamlTexts(repoDir)) {
    const n = yamlPerRun(text);
    if (n !== null) return { usd: n, source: "loki.yaml" };
  }
  return hasApiKey(env) ? { usd: DEFAULT_MAX_COST_USD, source: "default" } : { usd: 0, source: "subscription" };
}
export function capNote(usd: number, source: CapSource): string {
  if (usd <= 0) return "no dollar cap (subscription)";
  return `cap $${usd.toFixed(2)} (${source})`; }
/** Env for group/unit children: the resolved run cap becomes their LOKI_BUDGET_LIMIT, so a flag cap cannot be re-defaulted per unit.
 *  P12-22r: with repoDir, also exports ONE absolute LOKI_BUDGET_LEDGER (kept if already set) so parallel units in separate worktrees share a single cap. */
export function groupEnv(env: NodeJS.ProcessEnv, capUsd: number, repoDir?: string): NodeJS.ProcessEnv {
  if (!(capUsd > 0)) return env;
  const out: NodeJS.ProcessEnv = { ...env, LOKI_BUDGET_LIMIT: String(capUsd) };
  if (repoDir && !out.LOKI_BUDGET_LEDGER) { try { const d = join(resolve(repoDir), ".loki", "runs"); mkdirSync(d, { recursive: true }); out.LOKI_BUDGET_LEDGER = join(d, `group-${process.pid}-${Date.now()}.ledger`); } catch (e) { out.LOKI_BUDGET_LEDGER = join(resolve(repoDir), ".loki", "runs", "unusable", "group.ledger"); /* deliberately unreachable path, used only when mkdir fails */ process.stderr.write(`budget: cannot create the shared ledger dir (${e instanceof Error ? e.message : String(e)}); units will stop, failing closed\n`); } } // P12-22s: a path under a non-directory, so capMeter fails closed on it
  return out;
}
/** P12-22r: shared ledger. One JSON line per priced cost, written with a single O_APPEND write (atomic for small lines). Sum = spend of every unit. */
export function ledgerSum(path: string): number | null {
  try { let t = 0, seeded = false; for (const l of readFileSync(path, "utf8").split("\n")) { if (!l) continue; const r = JSON.parse(l) as { usd?: unknown; seed?: unknown }, u = r.usd; if (r.seed === true) { if (seeded) continue; seeded = true; } /* first seed wins when units carry different seeds */ if (typeof u === "number" && Number.isFinite(u) && u > 0) t += u; } return t; } catch { return null; }
}
/** Worker side: wraps the emit fn so every cost event feeds the meter; `over` is RunContext.overCap. */
export function capMeter<E extends (type: never, stage: never, data: Record<string, unknown>) => void>(raw: E, env: NodeJS.ProcessEnv): { emit: E; over: () => boolean; remaining: () => number | null } {
  const capUsd = parseCapUsd(env.LOKI_E10_MAX_COST_USD) ?? 0, seed = Number(env.LOKI_E10_SPENT_USD);
  const m = costMeter(capUsd, seed); // LOKI_E10_SPENT_USD: prior spend on this task, so kill-and-rerun cannot reset the cap
  const ledger = env.LOKI_BUDGET_LEDGER ? resolve(env.LOKI_BUDGET_LEDGER) : "";
  let broken = false; // P12-22r: a set but unusable ledger fails closed (stop), never a private ledger
  if (ledger) { try { appendFileSync(ledger, ""); readFileSync(ledger); } catch { broken = true; } }
  const base = Number.isFinite(seed) && seed > 0 ? seed : 0;
  if (ledger && !broken && base > 0) { try { if (!((ledgerSum(ledger) ?? 0) > 0)) appendFileSync(ledger, JSON.stringify({ pid: process.pid, usd: base, seed: true }) + "\n"); } catch { broken = true; } } // P12-22s: the rerun seed is recorded once in the ledger (first seed line counts), never added on top of spend it already holds
  const spent = (): number | null => ledgerSum(ledger);
  const emit = ((type: string, stage: never, data: Record<string, unknown>) => {
    if (type === "cost") { m.add(data.usd); if (ledger && typeof data.usd === "number" && data.usd > 0) { try { appendFileSync(ledger, JSON.stringify({ pid: process.pid, usd: data.usd }) + "\n"); } catch { broken = true; } } }
    (raw as unknown as (...a: unknown[]) => void)(type, stage, data);
  }) as unknown as E;
  if (!ledger) return { emit, over: m.over, remaining: m.remaining };
  const over = (): boolean => { if (broken) return true; const s = spent(); if (s === null) { broken = true; return true; } return capUsd > 0 && s >= capUsd; };
  const remaining = (): number | null => { if (capUsd <= 0) return null; const s = broken ? null : spent(); return s === null ? 0 : Math.max(capUsd - s, 0); };
  return { emit, over, remaining };
}
/** Running priced total for the worker; call with each emitted cost event's usd. */
export function costMeter(capUsd: number, seedUsd = 0): { add(usd: unknown): void; over(): boolean; remaining(): number | null } {
  let sum = Number.isFinite(seedUsd) && seedUsd > 0 ? seedUsd : 0;
  return { add: (u) => { if (typeof u === "number" && Number.isFinite(u) && u > 0) sum += u; }, over: () => capUsd > 0 && sum >= capUsd, remaining: () => (capUsd > 0 ? Math.max(capUsd - sum, 0) : null) };
}
/** LOKI_BUDGET_LIMIT for one session child: what is left of the cap, floored so a spent cap still reads as a (tiny) limit. null = no dollar cap. */
export function childBudgetLimit(remaining: number | null): string | null { return remaining === null ? null : String(Math.round(Math.max(remaining, 0.01) * 100) / 100); }
/** Legacy runner default: an explicit limit wins, else the same resolveCap answer engine10 uses (env, loki.yaml, $100 with an API key); undefined = no dollar cap. */
export function runnerBudget(explicit: number | undefined, repoDir: string, env: NodeJS.ProcessEnv = process.env): { usd: number | undefined; note: string | null } {
  if (explicit !== undefined) return { usd: explicit, note: null };
  const c = resolveCap(null, repoDir, env);
  return "error" in c || c.usd <= 0 ? { usd: undefined, note: null } : { usd: c.usd, note: capNote(c.usd, c.source) };
}
/** `--attempts N` shares one total: each attempt gets total/N (cents, min 0.01). undefined = no dollar cap to divide. */
export function perAttemptCap(totalUsd: number | undefined, n: number): number | undefined {
  return totalUsd === undefined || totalUsd <= 0 || n <= 1 ? totalUsd : Math.max(Math.floor((totalUsd / n) * 100) / 100, 0.01);
}

export type BudgetStop = { task: string; cap_usd: number; spent_usd: number; source: CapSource; outcome: "budget_stopped" };
/** Supervisor side: record a BUDGET_STOP at .loki/runs/<id>/budget.json (best effort; never throws into the run). */
export function writeBudgetStop(repoDir: string, runId: string, rec: Omit<BudgetStop, "outcome">): void {
  try { const d = join(repoDir, ".loki", "runs", runId); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "budget.json"), JSON.stringify({ ...rec, outcome: "budget_stopped" }) + "\n"); } catch { /* the stop itself is already in events.jsonl */ }
}
function readBudgetStop(file: string): BudgetStop | null {
  try { const b = JSON.parse(readFileSync(file, "utf8")) as BudgetStop; return b.outcome === "budget_stopped" && typeof b.spent_usd === "number" && typeof b.cap_usd === "number" ? b : null; } catch { return null; }
}
/** Most recent budget-stopped run (run ids sort by time) for this task, or null with no task filter match. Its spent_usd is already cumulative. */
export function lastBudgetStop(repoDir: string, task?: string): (BudgetStop & { runId: string }) | null {
  const root = join(repoDir, ".loki", "runs");
  let ids: string[] = []; try { ids = existsSync(root) ? readdirSync(root).sort().reverse() : []; } catch { return null; }
  for (const id of ids) { const b = readBudgetStop(join(root, id, "budget.json")); if (b && (task === undefined || b.task === task.trim())) return { ...b, runId: id }; }
  return null;
}
/** Dollars already spent on this exact task by budget-stopped runs; 0 when none. */
export function priorSpend(repoDir: string, task: string): number { return lastBudgetStop(repoDir, task)?.spent_usd ?? 0; }
/** The one next step after a budget stop. */
export function budgetNext(spentUsd: number, capUsd: number): string { return `raise with --max-cost (spent $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}), then rerun the same task`; }
/** Start-time warning when a dollar cap is set but the provider reports no cost, so the cap cannot stop anything. null otherwise. */
export function unenforceableNote(provider: string, capUsd: number): string | null {
  return capUsd > 0 && capability(provider)?.cost === "none" ? `warning: ${provider} reports no cost, so the $${capUsd.toFixed(2)} cap cannot be enforced` : null;
}
