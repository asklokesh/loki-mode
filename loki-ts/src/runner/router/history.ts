// R1-16 (H4): the router's shape key, the per-repo history floor and the shipped shape defaults.
// The shape is read from the Project Model (workspaceKind and each package's runner label), never
// from file names or regexes (Engine Law L0). Missing or corrupt inputs degrade to "no evidence",
// never a throw.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validateAnswer } from "../../project_model/schema.ts";
import { fileURLToPath } from "node:url";
import { type RunExecutor, type RunOutcome, readRunHistory } from "./history_store.ts";
import { type ProjectModel } from "../../project_model/schema.ts";
import { loadCached, loadCommitted } from "../../project_model/discover.ts";
import { computeKey, shallowDirs } from "../../project_model/gather.ts";
import { resolveExecutor } from "./decision.ts";
import { repoKey } from "../../engine10/cache.ts";
import { readOriginUrl } from "../../util/engine_origin.ts";

export { HISTORY_FILE, WALL_KIND, appendRunOutcome, readRunHistory, receiptSealIntact, sealedOutcomesByTier, tierOfModel, type SealedTierRecord, type ShapedReceipt, type TierOutcomeCount, type RunExecutor, type RunOutcome, type RunOwner, type RunVerdict } from "./history_store.ts";

/** A shipped shape default. "prior-default" means the LOKI_ROUTER=0 model for the stage; R1-11 resolves it to an id. */
export type ShapeDefault = "haiku" | "sonnet" | "prior-default";
const SHAPE_DEFAULT_VALUES: readonly string[] = ["haiku", "sonnet", "prior-default"];

const FLOOR_WINDOW = 3;
const FLOOR_LOSSES = 2;
const SHAPE_DEFAULTS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "router-shape-defaults.json");

/** `<workspaceKind>:<runner>+<runner>`; runners lowercased, de-duplicated, sorted; no runner = "none". Null when unknown. */
export function shapeKey(model: ProjectModel | null): string | null {
  if (!model || model.status !== "ok") return null;
  const runners = new Set(model.packages.map((p) => (p.runner ?? "").trim().toLowerCase() || "none"));
  return `${model.workspaceKind}:${[...runners].sort().join("+")}`;
}

/**
 * Shape key of a repo from its Project Model (.loki/project.json); null when none is usable or the
 * cached model is stale. Freshness is the discover.ts cache-hit check: the key recomputed from the
 * fingerprint files must equal the stored key. A committed model is always recomputed (as discovery does).
 */
export function shapeKeyForRepo(repoDir: string): string | null {
  try {
    const dirs = shallowDirs(repoDir);
    const committed = loadCommitted(repoDir);
    if (committed) return shapeKey({ ...committed.model, key: computeKey(repoDir, committed.model.fingerprintFiles, dirs, committed.hash) });
    const cached = loadCached(repoDir);
    if (!cached || computeKey(repoDir, cached.fingerprintFiles, dirs) !== cached.key) return null;
    return shapeKey(cached);
  } catch {
    return null;
  }
}

/**
 * FC-35: shape key for a run. The run's own Project Model answer (<runDir>/project-model.answer.json, schema-checked
 * by validateAnswer) wins; else the repo's cached/committed model. Null when neither is usable.
 */
export function shapeKeyForRun(repoDir: string, runDir: string): string | null {
  try {
    const p = join(runDir, "project-model.answer.json");
    if (existsSync(p)) {
      const v = validateAnswer(repoDir, JSON.parse(readFileSync(p, "utf8")));
      if (v.ok) return shapeKey({ ...v.model, key: "" });
    }
  } catch { /* fall through to the repo model */ }
  return shapeKeyForRepo(repoDir);
}

/**
 * A loss the router may count: a code-owned FAIL, or a code-owned run that escalated. Harness, env
 * and provider outcomes, errors and NOT PROVEN never count, so an infrastructure fault cannot push
 * a shape to Sonnet.
 */
export function isCodeLoss(r: RunOutcome): boolean {
  if (r.owner !== "code" || r.verdict === "error" || r.verdict === "not_proven") return false;
  return r.verdict === "fail" || r.escalated;
}

/** D99 item 3 (P12-32): acceptance prior used while a route has fewer than MIN_SCORED_RUNS counted runs, so a new route is not starved; and the floor that prevents a divide by zero. */
export const PRIOR_ACCEPTANCE = 0.5;
export const ACCEPTANCE_FLOOR = 0.05;
export const MIN_SCORED_RUNS = 3;
/** Only the newest counted runs score a route, so old runs cannot outweigh recent ones. */
export const SCORE_WINDOW = 10;

/** Expected accepted-outcome cost: price per attempt divided by the acceptance rate (never below the floor). Pure. */
export function expectedCost(pricePerAttempt: number, acceptanceRate: number): number {
  return pricePerAttempt / Math.max(acceptanceRate, ACCEPTANCE_FLOOR);
}

/**
 * Score of one executor on one shape from recorded verdicts: accepted = a pass that did not escalate (a VERIFIED Seal);
 * counted = accepted plus code-owned losses (harness, env, provider, error and NOT PROVEN runs say nothing about the route).
 * Fewer than MIN_SCORED_RUNS counted runs uses PRIOR_ACCEPTANCE. Null when no counted run exists.
 */
export function routeScore(runs: readonly RunOutcome[], shape: string, executor: RunExecutor): { cost: number; acceptance: number; n: number; prior: boolean } | null {
  const counted = runs.filter((r) => r.shape === shape && r.executor === executor && (isCodeLoss(r) || (r.verdict === "pass" && !r.escalated))).slice(-SCORE_WINDOW);
  if (counted.length === 0) return null;
  const price = counted.reduce((a, r) => a + r.usd, 0) / counted.length;
  const prior = counted.length < MIN_SCORED_RUNS;
  const acceptance = prior ? PRIOR_ACCEPTANCE : counted.filter((r) => !isCodeLoss(r)).length / counted.length;
  return { cost: expectedCost(price, acceptance), acceptance, n: counted.length, prior };
}

/** Executors with a score, cheapest expected accepted-outcome cost first; ties keep haiku before sonnet so the order is deterministic. */
export function rankExecutorsByCost(runs: readonly RunOutcome[], shape: string): RunExecutor[] {
  const order: RunExecutor[] = ["haiku", "sonnet"];
  return order.map((e) => ({ e, s: routeScore(runs, shape, e) })).filter((x) => x.s !== null).sort((a, b) => a.s!.cost - b.s!.cost).map((x) => x.e);
}

/**
 * Evidence floor: Haiku is replaced by Sonnet when at least 2 of Haiku's last 3 runs on this shape
 * are code-owned losses, or (D99 item 3) when Haiku has a full window of evidence and Sonnet's expected accepted-outcome
 * cost is strictly lower. Fewer than 3 Haiku runs on the shape is no evidence, so Haiku stays. Only moves up, never lowers.
 */
export function haikuFloorExecutor(repoKey: string, shape: string | null, cacheRoot?: string): RunExecutor {
  if (shape === null) return "haiku";
  const all = readRunHistory(repoKey, cacheRoot);
  const last = all.filter((r) => r.shape === shape && r.executor === "haiku").slice(-FLOOR_WINDOW);
  if (last.length < FLOOR_WINDOW) return "haiku";
  const losses = last.filter(isCodeLoss).length;
  if (losses >= FLOOR_LOSSES) return "sonnet";
  const ranked = rankExecutorsByCost(all, shape);
  return ranked.length === 2 && ranked[0] === "sonnet" ? "sonnet" : "haiku";
}

/**
 * P12-32b: the live caller of the cost objective. "sonnet" only when this repo's history for the shape proves it
 * (haikuFloorExecutor); "haiku" means no raise, i.e. today's routing. An error, no shape or no history is "haiku"
 * (fail-safe: history only moves a route up, never to a cheaper unproven model). `shape` is injectable for tests.
 */
export function repoHistoryFloor(repoDir: string, cacheRoot?: string, shape?: string | null): RunExecutor {
  try {
    return haikuFloorExecutor(repoKey(readOriginUrl(repoDir), repoDir), shape === undefined ? shapeKeyForRepo(repoDir) : shape, cacheRoot);
  } catch {
    return "haiku";
  }
}

/**
 * P12-32b: applies a "sonnet" history floor to an already-valid cheapest-tier route through resolveExecutor, so history can only
 * raise it. Null (keep today's route) for any other floor. The pure decision lives here, outside the L1-guarded stage files.
 */
export function historyRaisedRoute(reason: string, floor: RunExecutor): { model: string; reason: string } | null {
  if (floor !== "sonnet") return null;
  const r = resolveExecutor({ route: { executor: "haiku", source: "opus-plan", risk: "low", reason }, advisorAvailable: true, shapeDefault: "haiku", historyFloor: floor, priorDefaultModel: "sonnet", env: {} });
  return rankOfModel(r.model) > 0 ? { model: r.model, reason: "history: sonnet has the lower expected accepted-outcome cost on this shape (or haiku lost 2 of its last 3 runs)" } : null;
}
const rankOfModel = (m: string): number => (m.toLowerCase().includes("haiku") ? 0 : 1);

/**
 * The shipped per-shape default. "haiku" (the shape earned Haiku), "sonnet" and "prior-default" are the
 * only legal values; any other value, a shape absent from the file, or a missing or corrupt file
 * returns null (Sonnet default, no evidence).
 */
export function shapeDefault(key: string | null, file: string = SHAPE_DEFAULTS_FILE): ShapeDefault | null {
  if (key === null || !existsSync(file)) return null;
  try {
    const shapes = (JSON.parse(readFileSync(file, "utf8")) as { shapes?: unknown } | null)?.shapes;
    if (typeof shapes !== "object" || shapes === null || Array.isArray(shapes)) return null;
    const entry = (shapes as Record<string, unknown>)[key];
    const executor = (entry as { executor?: unknown } | null | undefined)?.executor;
    return typeof executor === "string" && SHAPE_DEFAULT_VALUES.includes(executor) ? (executor as ShapeDefault) : null;
  } catch {
    return null;
  }
}
