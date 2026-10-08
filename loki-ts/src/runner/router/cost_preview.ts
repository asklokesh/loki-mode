// 11.3.0 T1: cost preview. The estimate is read from the existing per-repo, per-shape run history
// (runner/router/history_store.ts); nothing here estimates from the task text or the repo's file
// names (Engine Law L0). No usable history prints "NOT AVAILABLE (<reason>)", never a number.
// Off with LOKI_COST_PREVIEW=0: no start-line text, no receipt block, no history append.
import { repoKey } from "../../engine10/cache.ts";
import { appendRunOutcome, readRunHistory, shapeKeyForRepo } from "./history.ts";
import { readOriginUrl } from "../../util/engine_origin.ts";

export const MIN_RUNS = 3;
const WINDOW = 20;
export const NOT_RECORDED = "NOT RECORDED";

export interface Estimate { shape: string; runs: number; usd: [number, number]; wall_s: [number, number] }
export type EstimateResult = { ok: true; est: Estimate } | { ok: false; reason: string };
export type Env = Record<string, string | undefined>;

export const previewOn = (env: Env): boolean => env["LOKI_COST_PREVIEW"] !== "0";

export function estimateFor(repoDir: string, cacheRoot?: string): EstimateResult {
  return estimateFromHistory(shapeKeyForRepo(repoDir), repoKey(readOriginUrl(repoDir), repoDir), cacheRoot);
}

export function estimateFromHistory(shape: string | null, key: string, cacheRoot?: string): EstimateResult {
  if (shape === null) return { ok: false, reason: "no project shape recorded for this repo" };
  const runs = readRunHistory(key, cacheRoot).filter((r) => r.shape === shape && r.verdict === "pass").slice(-WINDOW);
  if (runs.length < MIN_RUNS) return { ok: false, reason: `${runs.length} prior verified run${runs.length === 1 ? "" : "s"} for shape ${shape}, need ${MIN_RUNS}` };
  const usd = runs.map((r) => r.usd), wall = runs.map((r) => r.wallS);
  return { ok: true, est: { shape, runs: runs.length, usd: [Math.min(...usd), Math.max(...usd)], wall_s: [Math.min(...wall), Math.max(...wall)] } };
}

const mins = (s: number): string => (s < 90 ? `${Math.round(s)}s` : `${Math.round(s / 60)}m`);

export function startText(r: EstimateResult): string {
  if (!r.ok) return `estimate: NOT AVAILABLE (${r.reason})`;
  const { est: e } = r;
  return `estimate: $${e.usd[0].toFixed(2)}-$${e.usd[1].toFixed(2)}, ${mins(e.wall_s[0])}-${mins(e.wall_s[1])} (${e.runs} prior runs, shape ${e.shape})`;
}

/** The estimate as carried from the supervisor to the sealing worker, or null when the preview is off. */
export function encodeEstimate(env: Env, repoDir: string, cacheRoot?: string): string | null {
  return previewOn(env) ? JSON.stringify(estimateFor(repoDir, cacheRoot)) : null;
}

/** Receipt block: estimate (as printed at start) against actual. Missing actuals are NOT RECORDED, never 0. */
export function receiptBlock(env: Env, usd: number | null, unmetered: boolean, wallS: number | null): { cost_preview?: Record<string, unknown> } {
  if (!previewOn(env)) return {};
  let r: EstimateResult = { ok: false, reason: "no estimate carried from the run start" };
  try { const raw = env["LOKI_E10_COST_ESTIMATE"]; if (raw) r = JSON.parse(raw) as EstimateResult; } catch { /* keep the NOT AVAILABLE default */ }
  return { cost_preview: {
    estimate: r.ok === true ? { usd_low: r.est.usd[0], usd_high: r.est.usd[1], wall_low_s: r.est.wall_s[0], wall_high_s: r.est.wall_s[1], prior_runs: r.est.runs, shape: r.est.shape } : `NOT AVAILABLE (${r.reason ?? "unreadable estimate"})`,
    actual: { usd: usd === null || unmetered ? NOT_RECORDED : usd, wall_s: wallS === null || wallS <= 0 ? NOT_RECORDED : wallS },
  } };
}

/** Feed the history this estimator reads: only a VERIFIED run with measured cost is recorded. */
export function recordRun(env: Env, repoDir: string, model: string, verdict: string, usd: number | null, unmetered: boolean, wallS: number, cacheRoot?: string): boolean {
  if (!previewOn(env) || verdict !== "VERIFIED" || usd === null || unmetered || wallS <= 0) return false;
  const shape = shapeKeyForRepo(repoDir);
  if (shape === null) return false;
  return appendRunOutcome(repoKey(readOriginUrl(repoDir), repoDir), { shape, executor: /haiku/i.test(model) ? "haiku" : "sonnet", verdict: "pass", owner: null, escalated: false, usd, wallS }, cacheRoot);
}
