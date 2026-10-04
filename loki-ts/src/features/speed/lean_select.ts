// D61-03: behind LOKI_SPEED (default on; =0 off), a task that names no file may still go lean when
// a whole token equals a path segment or a symbol. FC-27/FC-28: a token on more than half the
// entries, or a word that only sits inside a longer name, is not a relevant test. The task stays
// on the Wall. The caller still requires a runner and impacted tests. No match or no map returns [].
import type { RepoMap } from "../../engine10/repomap.ts";
import { selectSpecificFiles } from "../../engine10/relevant_files.ts";

export function speedLikelyFiles(task: string, map: RepoMap | null, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env["LOKI_SPEED"] === "0" || !map) return [];
  try { return selectSpecificFiles(task, map); } catch { return []; }
}
