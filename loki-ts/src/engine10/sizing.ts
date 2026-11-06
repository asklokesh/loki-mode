// E-45 cost path: deterministic task sizing (no model call) and knobs; missing intake inputs size "normal". E-64: the small-task lean path (skip Plan+Wall) and the sonnet-then-escalate model cascade.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readRepoMapCache, repoCacheDir, repoKey } from "./cache.ts";
import { speedLikelyFiles } from "../features/speed/lean_select.ts"; import { deliverables } from "../features/decompose.ts";
import { resolveClaudeModel } from "../util/claude_model.ts"; import { presetExecutor, routerPreset } from "../runner/router/flag.ts"; import { envOverride } from "../runner/router/decision.ts"; import { isTestFile } from "../util/test_file_text.ts"; import { wallConcurrent } from "../util/wall_knobs.ts";
import type { RepoMap } from "./repomap.ts";
import type { TestMap, TestRef } from "./types.ts";
import { escapeRegex } from "../util/regex_escape.ts";
/** Repo-map files whose basename appears in the task as an exact token (not inside a longer name like myindex.ts or index.tsx; a trailing sentence period is fine); no keyword scoring, tune from eval data. */
export function namedFiles(task: string, map: RepoMap | null): string[] {
  const text = task.toLowerCase();
  return (map?.files ?? []).filter((f) => new RegExp(`(?<![\\w.-])${escapeRegex(basename(f).toLowerCase())}(?![\\w-]|\\.\\w)`).test(text));
}

/** P12-46: "large" = names more than LARGE_NAMED_FILES distinct non-test files (namedDistinct: "fix index.ts" in a monorepo of nine index.ts is one), or several independent deliverables by structure (features/decompose.ts deliverables); never lean, and an issue ref goes to the MASS-2 split (commands/issues_run.ts startIssueEpic). A large unit never runs in parallel. */
export type TaskSize = "small" | "normal" | "large"; export const LARGE_NAMED_FILES = 8;
/** C-F1 run4 knobs: LOKI_E10_SMALL_MAX_CHARS (positive number, default 600); a missing runner no longer forces normal (default); LOKI_E10_SMALL_NO_RUNNER=0 restores that disqualifier. */
const noted = new Set<string>(); // one stderr note per name=value; a setting that was not honored must be visible, the returned number never changes
const noteOnce = (name: string, raw: string | undefined, why: string): void => { if (raw === undefined || !raw.trim() || noted.has(name + raw)) return; noted.add(name + raw); process.stderr.write(`loki: ${name}="${raw}" ${why}\n`); };
export const smallMaxChars = (env = process.env): number => { const n = Number(env.LOKI_E10_SMALL_MAX_CHARS); if (n > 0) return n; noteOnce("LOKI_E10_SMALL_MAX_CHARS", env.LOKI_E10_SMALL_MAX_CHARS, "is not a positive number; using 600"); return 600; };
export function sizeTask(task: string, map: RepoMap | null, tests: TestMap | null): { size: TaskSize; reasons: string[] } {
  const named = namedFiles(task, map).length, distinct = namedDistinct(task, map);
  if (distinct > LARGE_NAMED_FILES) return { size: "large", reasons: [`task names ${distinct} distinct files > ${LARGE_NAMED_FILES}: decompose`] }; const st = deliverables(task); if (st.large) return { size: "large", reasons: [`${st.reason}: decompose`] };
  const why = [
    !task.trim() && "no task text", task.length > smallMaxChars() && `task ${task.length} chars > ${smallMaxChars()}`,
    !map && "no repo map", (map?.files.length ?? 0) > 3000 && `repo ${map?.files.length} files > 3000`,
    map?.truncated && "repo map truncated at the file cap", // buildRepoMap caps files at 2000, so the >3000 rule alone never fires
    (!tests || (!tests.runners.length && process.env.LOKI_E10_SMALL_NO_RUNNER === "0")) && "no test runner detected", named > 2 && `task names ${named} files > 2`,
  ].filter((w): w is string => typeof w === "string");
  return why.length ? { size: "normal", reasons: why } : { size: "small", reasons: [`task ${task.length} chars, names ${named} files`] };
}

/** A task that names more distinct non-test files than this is hard (between the "normal" bar of 2 and the "large" bar of LARGE_NAMED_FILES). */
export const HARD_NAMED_FILES = 4;
/** Distinct non-test files the task names, as written: each path the task spells out (as a whole token, so "src/index.ts" inside
 *  "packages/web/src/index.ts" is not a second one) counts once; a bare basename counts once however many repo files share it, and not
 *  at all when a spelled-out path already has that basename ("fix index.ts" in a monorepo is 1; three spelled-out paths are 3). A leading "./" on a spelled-out path is
 *  allowed ("./src/a.ts" is src/a.ts; "../src/a.ts" is not). A root file has no path to spell out, so its name is a bare basename. */
export function namedDistinct(task: string, map: RepoMap | null): number {
  const text = task.toLowerCase(), named = namedFiles(task, map).filter((f) => !isTestFile(f)).map((f) => f.toLowerCase());
  const spelled = new Set(named.filter((f) => f.includes("/") && new RegExp(`(?<![\\w./-])(?:\\./)?${escapeRegex(f)}(?![\\w-]|\\.\\w)`).test(text)));
  const spelledBase = new Set([...spelled].map((f) => basename(f)));
  return spelled.size + new Set(named.map((f) => basename(f)).filter((b) => !spelledBase.has(b))).size;
}
/** Why a task is hard, from task evidence only, never repo size (a truncated repo map is repo size, so it never counts): sized large (deliverables() or more than LARGE_NAMED_FILES distinct named files), or the task naming more than HARD_NAMED_FILES distinct non-test files. Null otherwise. */
export function hardReason(size: TaskSize, map: RepoMap | null, task: string): string | null {
  if (size === "large") return "task sized large";
  const n = namedDistinct(task, map);
  return n > HARD_NAMED_FILES ? `task names ${n} distinct non-test files > ${HARD_NAMED_FILES}` : null;
}

/** Best-effort RepoMap load from intake's repomap_ref; missing/unreadable is null, never a crash. */
export function loadRepoMap(repomapRef: string | undefined): RepoMap | null {
  try { return repomapRef && existsSync(repomapRef) ? JSON.parse(readFileSync(repomapRef, "utf8")) as RepoMap : null; } catch { return null; }
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

/** Tiny greenfield: size small, short brief, no runner and no existing test. The Wall still runs and authors tests; only the test count is bounded. */
export const WALL_TINY_MAX_CHARS = 300, WALL_TINY_BOUND = "Tiny task: write exactly one test file with at most 6 assertions unless more acceptance lines exist, then exactly one per acceptance line.";
export const isTinyGreenfield = (size: TaskSize, task: string, tests: TestMap | null): boolean => size === "small" && task.length <= WALL_TINY_MAX_CHARS && !tests?.runners.length && !tests?.tests.length;

/** "lean" skips Plan+Wall (one implement session): any small or normal task whose named files have a relevant visible test, which verify runs once at the end; "wall" keeps Wall (large, or no relevant test). */
export type SmallTaskPath = "lean" | "wall"; export const smallTaskPath = (size: TaskSize, relevantTests: boolean): SmallTaskPath => (size !== "large" && relevantTests ? "lean" : "wall");
const knob = (v: string | undefined, words: string[]): boolean => words.includes((v ?? "").toLowerCase());
/** LOKI_E10_PLAN: 0/off/never skips, 1/on/always forces, anything else sizes. */
export const planMode = (env = process.env): "auto" | "always" | "never" =>
  knob(env.LOKI_E10_PLAN, ["0", "off", "never", "false"]) ? "never" : knob(env.LOKI_E10_PLAN, ["1", "on", "always", "true"]) ? "always" : "auto";
/** EVAL-2026-11-05-3: the single-attempt Wall session lost to no Wall (merge-ready 9/20 vs 11/20, 1 false VERIFIED vs 0, higher cost per merge-ready), so it is OFF unless LOKI_E10_WALL=1/on/true opts in. The code stays reachable for a parallel-attempt selector. */
export const wallEnabled = (env = process.env): boolean => knob(env.LOKI_E10_WALL, ["1", "on", "true"]);
/** W1-S3: Wall session cap, 90s small / 180s normal; LOKI_E10_WALL_LIMIT_S overrides (clamped to 300; garbage, zero or negative falls back). */
export const wallLimitS = (size: TaskSize, env = process.env): number => {
  const raw = env.LOKI_E10_WALL_LIMIT_S, n = Number(raw), dflt = size === "small" ? 90 : 180;
  if (Number.isFinite(n) && n > 0) { if (n > 300) noteOnce("LOKI_E10_WALL_LIMIT_S", raw, "exceeds the 300s maximum; using 300"); return Math.min(300, n); }
  noteOnce("LOKI_E10_WALL_LIMIT_S", raw, `is not a positive number; using ${dflt}`); return dflt;
};
/** Engine Law L1 (supersedes D31's sonnet-first default; amended 2026-11-01: Haiku may execute when the user asks, LOKI_ROUTER=auto): the cascade is OFF unless LOKI_E10_CASCADE=1/on/true opts in. Off means implement and fix run on the run's own model, as a raw session would. Escalation only goes up. */
export const cascadeEnabled = (env = process.env): boolean => knob(env.LOKI_E10_CASCADE, ["1", "on", "true"]);
/** Resolves a cli_alias (e.g. "sonnet") to its catalog model id; an id already, or an unknown alias, passes through unchanged. */
export const resolveModelAlias = resolveClaudeModel;
/** LOKI_E10_WALL_TIER (alias or id, default sonnet) resolved via providers/model_catalog.json cli_aliases: the judge tier. The already-done confirmation and the Wall referee
 *  stay on it under LOKI_ROUTER=auto, since either one can end or reshape a run on a single call (a Haiku already-done claim is weak evidence). */
export const wallPinModel = (env = process.env): string => resolveModelAlias(env.LOKI_E10_WALL_TIER || "sonnet");
/** The Wall test author's model: wallPinModel, except under LOKI_ROUTER=auto with no LOKI_E10_WALL_TIER and no model pin, where it is the preset executor (Haiku under --haiku).
 *  Measured: benchmarks/h2h/results/2026-11-02-haiku-wall-916ddc95a.json (bench v2, Wall on Haiku: same pass rate, no false VERIFIED, about a tenth of the Sonnet Wall's cost). */
export const wallModel = (env = process.env): string => (!env.LOKI_E10_WALL_TIER && routerPreset(env) && envOverride(env) === null ? resolveModelAlias(presetExecutor(env).model) : wallPinModel(env));
/** COST-11: first Wall author rung. Haiku for small/normal tasks, re-authored once on wallModel() when the result is unusable (wall.ts runWall).
 *  Fail-safe: any pin (LOKI_E10_WALL_TIER, LOKI_MODEL_OVERRIDE), concurrent Wall (its base run is not validated at author time), an unknown/large size or LOKI_E10_WALL_FIRST=0 uses wallModel() directly, so no escalation applies. */
export const wallFirstModel = (size: TaskSize, env = process.env): string => {
  if (knob(env.LOKI_E10_WALL_FIRST, ["0", "off", "false"]) || env.LOKI_E10_WALL_TIER || env.LOKI_MODEL_OVERRIDE || wallConcurrent(env)) return wallModel(env);
  return size === "small" || size === "normal" ? resolveModelAlias("haiku") : wallModel(env);
};
/** E-64: the cascade's first implement call pins to the same sonnet alias Wall already uses (E-45). */
export const cascadeImplementModel = wallPinModel;

export { capToRunTier, modelRank, escalationModel, cascadeDowngrade } from "../runner/model_rank.ts"; export { wallConcurrent, wallMaxTokens, wallOutputCap } from "../util/wall_knobs.ts"; // L1 model ordering and the Wall knobs live outside the engine10 line budget
