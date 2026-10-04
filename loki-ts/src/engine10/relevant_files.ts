// Pure keyword selection over the repo map. Lives outside stages/ so features/ may import it (D66 fence); plan.ts re-exports it.
import type { RepoMap } from "./repomap.ts";

export const MAX_RELEVANT_FILES = 8;

function keywords(task: string): string[] {
  const words = task.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return Array.from(new Set(words.filter((w) => w.length > 2)));
}

const haystack = (entry: RepoMap["entries"][number]): string => `${entry.path} ${entry.symbols.join(" ")}`.toLowerCase();

function rank(words: string[], repoMap: RepoMap, max: number): string[] {
  if (words.length === 0) return [];
  const scored = repoMap.entries.map((entry, idx) => {
    const hay = haystack(entry);
    return { path: entry.path, score: words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0), idx };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.idx - b.idx).slice(0, max).map((s) => s.path);
}

/** Keyword overlap between task and repo map entry (path plus symbols); zero-score files are dropped, ties keep repo map order. */
export function selectRelevantFiles(task: string, repoMap: RepoMap, max: number = MAX_RELEVANT_FILES): string[] {
  return rank(keywords(task), repoMap, max);
}

/** Same overlap, minus tokens that occur in more than half the entries. Those name the tree, not a file.
 *  The lean Wall skip uses this (FC-27). Plan hints stay on selectRelevantFiles. */
export function selectSpecificFiles(task: string, repoMap: RepoMap, max: number = MAX_RELEVANT_FILES): string[] {
  const entries = repoMap.entries;
  if (entries.length === 0) return [];
  const hays = entries.map(haystack);
  const specific = keywords(task).filter((w) => {
    const hits = hays.reduce((n, h) => n + (h.includes(w) ? 1 : 0), 0);
    return hits > 0 && hits * 2 <= hays.length;
  });
  return rank(specific, repoMap, max);
}
