// D61-03: behind LOKI_SPEED (default on; =0 off), a task that names no file may still go lean when
// a whole token equals a path segment or a symbol. FC-27/FC-28: a token on more than half the
// entries, or a word that only sits inside a longer name, is not a relevant test. The task stays
// on the Wall. The caller still requires a runner and impacted tests. No match or no map returns [].
import type { RepoMap } from "../../engine10/repomap.ts";
import { haystack, keywords, MAX_RELEVANT_FILES } from "../../engine10/relevant_files.ts";

const wordTokens = (text: string): string[] => text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];

/** Whole-token overlap only. A task word counts when it equals a path segment or a symbol, not when it sits inside a longer name.
 *  Tokens that occur in more than half the entries name the tree, not a file (FC-27, FC-28).
 *  The lean Wall skip uses this. Plan hints stay on selectRelevantFiles. */
export function selectSpecificFiles(task: string, repoMap: RepoMap, max: number = MAX_RELEVANT_FILES): string[] {
  const entries = repoMap.entries;
  if (entries.length === 0) return [];
  const sets = entries.map((entry) => new Set(wordTokens(haystack(entry))));
  const specific = keywords(task).filter((w) => {
    const hits = sets.reduce((n, toks) => n + (toks.has(w) ? 1 : 0), 0);
    return hits > 0 && hits * 2 <= sets.length;
  });
  if (specific.length === 0) return [];
  const scored = sets.map((toks, idx) => ({ path: entries[idx]!.path, score: specific.reduce((n, w) => n + (toks.has(w) ? 1 : 0), 0), idx }));
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.idx - b.idx).slice(0, max).map((s) => s.path);
}
export function speedLikelyFiles(task: string, map: RepoMap | null, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env["LOKI_SPEED"] === "0" || !map) return [];
  try { return selectSpecificFiles(task, map); } catch { return []; }
}
