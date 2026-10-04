// D61-03: behind LOKI_SPEED (default on; =0 off), a task that names no file may still go lean when
// keyword selection finds files. FC-27: a token that hits more than half the entries names the tree,
// not a file, so it is not a relevant-test signal and the task stays on the Wall (fail-safe).
// The caller still requires a runner and impacted tests. No match, no flag, or no map all return [].
import type { RepoMap } from "../../engine10/repomap.ts";
import { selectSpecificFiles } from "../../engine10/relevant_files.ts";

export function speedLikelyFiles(task: string, map: RepoMap | null, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env["LOKI_SPEED"] === "0" || !map) return [];
  try { return selectSpecificFiles(task, map); } catch { return []; }
}
