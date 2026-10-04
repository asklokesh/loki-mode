// FC-21b (2): the run wall-clock cap scales with the plan's scope, not the task text. Pure; the CLI gathers the signals.
// An explicit cap (LOKI_E10_CAP_S or loki.yaml budgets.run_cap_s) is fixed: never shrunk or grown, and it wins over the ceiling.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CAP_S } from "../engine10/types.ts";
import { dependentsOf } from "../project_model/graph.ts";
import type { ProjectApi } from "../project_model/api.ts";
import { yamlKey } from "./yaml_key.ts";

export const PLAN_SCOPE_FILE = "plan-scope.json";
const CEILING_SUBSCRIPTION_S = 3600, CEILING_DOLLAR_S = 2400, PER_PACKAGE_S = 450, PER_FILE_S = 20, FREE_FILES = 3;
/** The most a sized cap can reach: 3600 on a subscription (time is the only guard), 2400 with a dollar cap. */
export const capCeilingS = (subscription: boolean): number => (subscription ? CEILING_SUBSCRIPTION_S : CEILING_DOLLAR_S);
/** The fixed cap (explicit env, then loki.yaml), or undefined when the cap is sized. */
export const fixedCapS = (explicitS?: number, yamlS?: number | null): number | undefined => (explicitS && explicitS > 0 ? explicitS : yamlS && yamlS > 0 ? yamlS : undefined);

/** Seconds from the plan scope: 900 + 450 per extra package (owners plus their dependents) + 20 per file beyond 3, clamped to [DEFAULT_CAP_S, ceiling]. No scope or no model sizes as one package. */
export function scopeCapS(files: string[], api: ProjectApi | null, subscription: boolean): number {
  const roots = new Set<string>();
  if (api?.known()) for (const f of files) { const r = api.packageRootOf(f); if (r !== null) roots.add(r); }
  const p = roots.size === 0 ? 1 : roots.size + (api ? dependentsOf(api.model, [...roots]).length : 0);
  const raw = DEFAULT_CAP_S + PER_PACKAGE_S * (p - 1) + PER_FILE_S * Math.max(0, files.length - FREE_FILES);
  return Math.min(capCeilingS(subscription), Math.max(DEFAULT_CAP_S, raw));
}
/** The files the plan session named in <runDir>/plan-scope.json ({"files":[...]}); empty when missing or malformed. Never reads model prose. */
export function readPlanScope(runDir: string): string[] {
  try {
    const j = JSON.parse(readFileSync(join(runDir, PLAN_SCOPE_FILE), "utf8")) as { files?: unknown };
    return Array.isArray(j.files) ? [...new Set(j.files.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim()))] : [];
  } catch { return []; }
}
/** The one post-plan resize. S4 calls it after plan (or wall) with the worker's model; a fixed cap is returned untouched. */
export function resizeCap(runDir: string, api: ProjectApi | null, subscription: boolean, fixedS?: number): number {
  return fixedS && fixedS > 0 ? fixedS : scopeCapS(readPlanScope(runDir), api, subscription);
}
/** budgets.run_cap_s from loki.yaml text (a two-level read, like budgets.per_run). */
export function yamlRunCapS(text: string): number | null {
  const v = Number(yamlKey(text, "budgets", "run_cap_s"));
  return Number.isInteger(v) && v > 0 ? v : null;
}
/** The cap the run starts with: a fixed cap if one is set, else DEFAULT_CAP_S (no plan exists yet; the worker resizes once after plan). Best effort: unreadable yaml falls back to the default. */
export function resolveRunCapS(repoDir: string, subscription: boolean, env: NodeJS.ProcessEnv = process.env): { capS: number; fixedS?: number; ceilingS: number } {
  let yamlS: number | null = null;
  for (const f of ["loki.yaml", "loki.yml"]) { const p = join(repoDir, f); if (existsSync(p)) try { yamlS = yamlRunCapS(readFileSync(p, "utf8")); } catch { /* unreadable */ } }
  const fixedS = fixedCapS(Number(env.LOKI_E10_CAP_S) || undefined, yamlS);
  return { capS: fixedS ?? DEFAULT_CAP_S, fixedS, ceilingS: fixedS ?? capCeilingS(subscription) };
}
/** The line appended to the implement brief (after the cache-stable prefix) so the model can checkpoint. */
export const timeBudgetNote = (limitS: number): string => `Time budget: about ${Math.max(1, Math.round(limitS / 60))} minutes left for this session. Work in small steps, keep the test suite passing at every checkpoint, and leave the tree in a working state when time runs out.`;
