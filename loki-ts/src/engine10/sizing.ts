// E-45 cost path: deterministic task sizing (no model call) and knobs. Missing intake inputs size "normal".
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RepoMap } from "./repomap.ts";
import type { TestMap } from "./types.ts";

// ponytail: "named" = repo paths whose basename appears in the task (no keyword scoring); tune from eval data.
export function sizeTask(task: string, map: RepoMap | null, tests: TestMap | null): { size: "small" | "normal"; reasons: string[] } {
  const named = (map?.files ?? []).filter((f) => task.toLowerCase().includes(basename(f).toLowerCase())).length;
  const why = [
    !task.trim() && "no task text", task.length > 600 && `task ${task.length} chars > 600`,
    !map && "no repo map", (map?.files.length ?? 0) > 3000 && `repo ${map?.files.length} files > 3000`,
    map?.truncated && "repo map truncated at the file cap", // buildRepoMap caps files at 2000, so the >3000 rule alone never fires
    !tests?.runners.length && "no test runner detected", named > 2 && `task names ${named} files > 2`,
  ].filter((w): w is string => typeof w === "string");
  return why.length ? { size: "normal", reasons: why } : { size: "small", reasons: [`task ${task.length} chars, names ${named} files`] };
}

const knob = (v: string | undefined, words: string[]): boolean => words.includes((v ?? "").toLowerCase());
/** LOKI_E10_PLAN: 0/off/never skips, 1/on/always forces, anything else sizes. */
export const planMode = (env = process.env): "auto" | "always" | "never" =>
  knob(env.LOKI_E10_PLAN, ["0", "off", "never", "false"]) ? "never" : knob(env.LOKI_E10_PLAN, ["1", "on", "always", "true"]) ? "always" : "auto";
export const wallEnabled = (env = process.env): boolean => !knob(env.LOKI_E10_WALL, ["0", "off", "false"]);

/** LOKI_E10_WALL_TIER (alias or id, default sonnet) resolved via providers/model_catalog.json cli_aliases. */
export function wallModel(env = process.env): string {
  const want = env.LOKI_E10_WALL_TIER || "sonnet";
  try { return JSON.parse(readFileSync(join(import.meta.dir, "../../../providers/model_catalog.json"), "utf8")).providers?.claude?.cli_aliases?.[want] ?? want; } catch { return want; }
}
