// Pure keyword selection over the repo map. Lives outside stages/ so features/ may import it (D66 fence); plan.ts re-exports it.
import type { RepoMap } from "./repomap.ts";

export const MAX_RELEVANT_FILES = 8;

function keywords(task: string): string[] {
  const words = task.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return Array.from(new Set(words.filter((w) => w.length > 2)));
}

/** Keyword overlap between task and repo map entry (path plus symbols); zero-score files are dropped, ties keep repo map order. */
export function selectRelevantFiles(task: string, repoMap: RepoMap, max: number = MAX_RELEVANT_FILES): string[] {
  const words = keywords(task);
  if (words.length === 0) return [];

  const scored = repoMap.entries.map((entry, idx) => {
    const haystack = `${entry.path} ${entry.symbols.join(" ")}`.toLowerCase();
    const score = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0);
    return { path: entry.path, score, idx };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)
    .slice(0, max)
    .map((s) => s.path);
}
