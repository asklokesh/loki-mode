// D61-03: behind LOKI_SPEED=1, a task that names no file may still go lean when plan.ts keyword
// selection over the repo map finds files. The caller still requires a runner and impacted tests,
// so no match, no flag, or no map all return [] and the task stays on Wall (fail-safe).
import type { RepoMap } from "../../engine10/repomap.ts";
import { selectRelevantFiles } from "../../engine10/relevant_files.ts";

export function speedLikelyFiles(task: string, map: RepoMap | null, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env["LOKI_SPEED"] !== "1" || !map) return [];
  try { return selectRelevantFiles(task, map); } catch { return []; }
}
