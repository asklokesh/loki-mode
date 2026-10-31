// FC-21b (2): the run wall-clock cap scales with the plan's scope, not the task text. Pure; the CLI gathers the signals.
// An explicit cap (LOKI_E10_CAP_S or loki.yaml budgets.run_cap_s) is fixed: never shrunk or grown, and it wins over the ceiling.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CAP_S, envCapS, warnBadCap } from "../engine10/types.ts";
import { dependentsOf } from "../project_model/graph.ts";
import type { ProjectApi } from "../project_model/api.ts";
import { lokiYamlTexts, yamlKey } from "./yaml_key.ts";

export const PLAN_SCOPE_FILE = "plan-scope.json";
export const MAX_SCOPE_BYTES = 256 * 1024;
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
export type ScopeRead = { status: "ok"; text: string } | { status: "missing" | "not_file" | "too_big" | "unreadable" };
/** The ONE guarded reader of <runDir>/plan-scope.json: regular file only (no symlink, directory or device), at most MAX_SCOPE_BYTES. Never throws. */
export function readScopeText(runDir: string): ScopeRead {
  const p = join(runDir, PLAN_SCOPE_FILE);
  try {
    let st;
    try { st = lstatSync(p); } catch (e) { return { status: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable" }; }
    if (!st.isFile()) return { status: "not_file" };
    if (st.size > MAX_SCOPE_BYTES) return { status: "too_big" };
    return { status: "ok", text: readFileSync(p, "utf8") };
  } catch { return { status: "unreadable" }; }
}
/** A skipped small plan still gives the scope guard its plan-scope.json: the files the task names, never an empty list (that reads as out-of-repo). An existing file is kept. */
export function seedPlanScope(runDir: string, files: string[]): void {
  if (!files.length || existsSync(join(runDir, PLAN_SCOPE_FILE))) return;
  mkdirSync(runDir, { recursive: true }); writeFileSync(join(runDir, PLAN_SCOPE_FILE), JSON.stringify({ files }), "utf8");
}
/** The files the plan session named in <runDir>/plan-scope.json ({"files":[...]}); empty when missing, rejected by the guarded reader, or malformed. Never reads model prose. */
export function readPlanScope(runDir: string): string[] {
  const r = readScopeText(runDir);
  if (r.status !== "ok") return [];
  try {
    const j = JSON.parse(r.text) as { files?: unknown };
    return Array.isArray(j.files) ? [...new Set(j.files.filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim()))] : [];
  } catch { return []; }
}
/** The one post-plan resize. S4 calls it after plan (or wall) with the worker's model; a fixed cap is returned untouched. */
export function resizeCap(runDir: string, api: ProjectApi | null, subscription: boolean, fixedS?: number): number {
  return fixedS && fixedS > 0 ? fixedS : scopeCapS(readPlanScope(runDir), api, subscription);
}
/** budgets.run_cap_s from loki.yaml text (a two-level read, like budgets.per_run). */
export function yamlRunCapS(text: string): number | null {
  const raw = yamlKey(text, "budgets", "run_cap_s");
  if (raw === null || raw.trim() === "") return null;
  const v = Number(raw);
  if (Number.isInteger(v) && v > 0) return v;
  warnBadCap("budgets.run_cap_s", raw);
  return null;
}
/** The cap the run starts with: a fixed cap if one is set, else DEFAULT_CAP_S (no plan exists yet; the worker resizes once after plan). Best effort: unreadable yaml falls back to the default. */
export function resolveRunCapS(repoDir: string, subscription: boolean, env: NodeJS.ProcessEnv = process.env): { capS: number; fixedS?: number; ceilingS: number } {
  const texts = lokiYamlTexts(repoDir);
  const first = texts.find((t) => yamlKey(t, "budgets", "run_cap_s") !== null); // the first file that sets the key wins, like resolveCap
  const yamlS = first !== undefined ? yamlRunCapS(first) : null;
  const fixedS = fixedCapS(envCapS(env.LOKI_E10_CAP_S) ?? undefined, yamlS);
  return { capS: fixedS ?? DEFAULT_CAP_S, fixedS, ceilingS: fixedS ?? capCeilingS(subscription) };
}
/** The line appended to the implement brief (after the cache-stable prefix) so the model can checkpoint. */
export const timeBudgetNote = (limitS: number): string => `Time budget: about ${Math.max(1, Math.round(limitS / 60))} minutes left for this session. Work in small steps, keep the test suite passing at every checkpoint, and leave the tree in a working state when time runs out.`;
/** FC-OUT-OF-REPO: the plan session's own statement that the change has no in-repo target. Fires only when plan-scope.json parsed and names zero files; a missing or malformed scope is unknown, never out-of-repo. */
export function planOutOfRepo(runDir: string): { reason: string } | null {
  const r = readScopeText(runDir);
  if (r.status !== "ok") return null;
  try {
    const j = JSON.parse(r.text) as { files?: unknown; out_of_repo?: unknown };
    if (!Array.isArray(j.files) || j.files.some((f) => typeof f === "string" && f.trim() !== "")) return null;
    const why = typeof j.out_of_repo === "string" ? j.out_of_repo.replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 300) : "";
    return { reason: why || "the plan named no in-repo target files" };
  } catch { return null; }
}
/** FC-OUT-OF-REPO: the plan brief line that lets the planner declare it. */
export const outOfRepoInstruction = (scopePath: string): string => `If the requested change has no target in this repository (for example the code lives in a hosted service or another repo), write {"files":[],"out_of_repo":"<one sentence why>"} to ${scopePath} and do not guess files.`;
/** FC-NO-PUSH-UNVERIFIED: the one line printed when a run that is neither VERIFIED nor PARTIAL (a PARTIAL run opens a labelled draft PR) keeps its branch local. */
export const localBranchNote = (runId: string, verdict: string, repoDir: string): string => `engine10: run ${runId} sealed ${verdict}, not verified: branch loki/${runId} stays local (not pushed); inspect it in ${repoDir}\n`;
