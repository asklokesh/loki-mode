// E-45 cost path: deterministic task sizing (no model call) and knobs. Missing intake inputs size "normal".
// E-64: the small-task lean path (skip Plan+Wall) and the sonnet-then-escalate model cascade.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readRepoMapCache, repoCacheDir, repoKey } from "./cache.ts";
import { speedLikelyFiles } from "../features/speed/lean_select.ts";
import type { RepoMap } from "./repomap.ts";
import type { TestMap, TestRef } from "./types.ts";

/** Repo-map files whose basename appears in the task text; no keyword scoring, tune from eval data. */
export function namedFiles(task: string, map: RepoMap | null): string[] {
  return (map?.files ?? []).filter((f) => task.toLowerCase().includes(basename(f).toLowerCase()));
}

export function sizeTask(task: string, map: RepoMap | null, tests: TestMap | null): { size: "small" | "normal"; reasons: string[] } {
  const named = namedFiles(task, map).length;
  const why = [
    !task.trim() && "no task text", task.length > 600 && `task ${task.length} chars > 600`,
    !map && "no repo map", (map?.files.length ?? 0) > 3000 && `repo ${map?.files.length} files > 3000`,
    map?.truncated && "repo map truncated at the file cap", // buildRepoMap caps files at 2000, so the >3000 rule alone never fires
    !tests?.runners.length && "no test runner detected", named > 2 && `task names ${named} files > 2`,
  ].filter((w): w is string => typeof w === "string");
  return why.length ? { size: "normal", reasons: why } : { size: "small", reasons: [`task ${task.length} chars, names ${named} files`] };
}

/** Best-effort RepoMap load from intake's repomap_ref; missing/unreadable is null, never a crash. */
export function loadRepoMap(repomapRef: string | undefined): RepoMap | null {
  if (!repomapRef || !existsSync(repomapRef)) return null;
  try { return JSON.parse(readFileSync(repomapRef, "utf8")) as RepoMap; } catch { return null; }
}

/** E-64: <=maxLines paths from the tree-keyed cache, else intake's repomap_ref; Wall and implement share this. */
export function repoMapText(repoDir: string, tree: string | undefined, repomapRef: string | undefined, maxLines = 200): string {
  const cached = tree ? readRepoMapCache(repoCacheDir(repoKey(null, repoDir)), tree) : null;
  return ((cached ?? loadRepoMap(repomapRef))?.files ?? []).slice(0, maxLines).join("\n");
}

/** E-64: a runner exists AND a named file has an impacted test; false (fail-safe: keep Wall) when nothing is nameable. */
export function hasRelevantTests(task: string, map: RepoMap | null, tests: TestMap | null, impacted: (m: TestMap, files: string[]) => TestRef[]): boolean {
  if (!tests?.runners.length) return false;
  const likely = namedFiles(task, map);
  if (!likely.length) likely.push(...speedLikelyFiles(task, map)); // D61-03: LOKI_SPEED=1 keyword fallback
  return likely.length > 0 && impacted(tests, likely).length > 0;
}

/** "lean" skips Plan+Wall (one implement session); "wall" keeps Wall (medium/large, or small with no relevant tests). */
export type SmallTaskPath = "lean" | "wall";
export const smallTaskPath = (size: "small" | "normal", relevantTests: boolean): SmallTaskPath => (size === "small" && relevantTests ? "lean" : "wall");
const knob = (v: string | undefined, words: string[]): boolean => words.includes((v ?? "").toLowerCase());
/** LOKI_E10_PLAN: 0/off/never skips, 1/on/always forces, anything else sizes. */
export const planMode = (env = process.env): "auto" | "always" | "never" =>
  knob(env.LOKI_E10_PLAN, ["0", "off", "never", "false"]) ? "never" : knob(env.LOKI_E10_PLAN, ["1", "on", "always", "true"]) ? "always" : "auto";
export const wallEnabled = (env = process.env): boolean => !knob(env.LOKI_E10_WALL, ["0", "off", "false"]);
/** W1-S3: Wall session cap, 90s small / 180s normal; LOKI_E10_WALL_LIMIT_S overrides (clamped to 300; garbage, zero or negative falls back). */
export const wallLimitS = (size: "small" | "normal", env = process.env): number => { const n = Number(env.LOKI_E10_WALL_LIMIT_S); return Number.isFinite(n) && n > 0 ? Math.min(300, n) : size === "small" ? 90 : 180; };
/** LOKI_E10_CASCADE=0/off/false: implement (and any fix round) stays on the run's configured model, as before E-64. */
export const cascadeEnabled = (env = process.env): boolean => !knob(env.LOKI_E10_CASCADE, ["0", "off", "false"]);
/** Resolves a cli_alias (e.g. "sonnet") to its catalog model id; an id already, or an unknown alias, passes through unchanged. */
export function resolveModelAlias(want: string): string {
  try { return JSON.parse(readFileSync(join(import.meta.dir, "../../../providers/model_catalog.json"), "utf8")).providers?.claude?.cli_aliases?.[want] ?? want; } catch { return want; }
}
/** LOKI_E10_WALL_TIER (alias or id, default sonnet) resolved via providers/model_catalog.json cli_aliases. */
export const wallModel = (env = process.env): string => resolveModelAlias(env.LOKI_E10_WALL_TIER || "sonnet");
/** E-64: the cascade's first implement call pins to the same sonnet alias Wall already uses (E-45). */
export const cascadeImplementModel = wallModel;
