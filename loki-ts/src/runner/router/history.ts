// R1-16 (H4): the router's shape key, the per-repo history floor and the shipped shape defaults.
// The shape is read from the Project Model (workspaceKind and each package's runner label), never
// from file names or regexes (Engine Law L0). Missing or corrupt inputs degrade to "no evidence",
// never a throw.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type RunExecutor, type RunOutcome, readRunHistory } from "./history_store.ts";
import { type ProjectModel } from "../../project_model/schema.ts";
import { loadCached } from "../../project_model/discover.ts";

export { HISTORY_FILE, appendRunOutcome, readRunHistory, type RunExecutor, type RunOutcome, type RunOwner, type RunVerdict } from "./history_store.ts";

/** A shipped shape default. "prior-default" means the LOKI_ROUTER=0 model for the stage; R1-11 resolves it to an id. */
export type ShapeDefault = "sonnet" | "prior-default";
const SHAPE_DEFAULT_VALUES: readonly string[] = ["sonnet", "prior-default"];

const FLOOR_WINDOW = 3;
const FLOOR_LOSSES = 2;
const SHAPE_DEFAULTS_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "router-shape-defaults.json");

/** `<workspaceKind>:<runner>+<runner>`; runners lowercased, de-duplicated, sorted; no runner = "none". Null when unknown. */
export function shapeKey(model: ProjectModel | null): string | null {
  if (!model || model.status !== "ok") return null;
  const runners = new Set(model.packages.map((p) => (p.runner ?? "").trim().toLowerCase() || "none"));
  return `${model.workspaceKind}:${[...runners].sort().join("+")}`;
}

/** Shape key of a repo from its cached Project Model (.loki/project.json); null when none is usable. */
export function shapeKeyForRepo(repoDir: string): string | null {
  return shapeKey(loadCached(repoDir));
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

/**
 * Evidence floor: Haiku is replaced by Sonnet when at least 2 of Haiku's last 3 runs on this shape
 * are code-owned losses. Fewer than 3 Haiku runs on the shape is no evidence, so Haiku stays.
 */
export function haikuFloorExecutor(repoKey: string, shape: string | null, cacheRoot?: string): RunExecutor {
  if (shape === null) return "haiku";
  const last = readRunHistory(repoKey, cacheRoot).filter((r) => r.shape === shape && r.executor === "haiku").slice(-FLOOR_WINDOW);
  if (last.length < FLOOR_WINDOW) return "haiku";
  const losses = last.filter(isCodeLoss).length;
  return losses >= FLOOR_LOSSES ? "sonnet" : "haiku";
}

/**
 * The shipped per-shape default. "sonnet" and "prior-default" are the only legal values; any other
 * value, a shape absent from the file, or a missing or corrupt file returns null (Haiku default).
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
