// Pure keyword selection over the repo map. Lives outside stages/ so features/ may import it (D66 fence); plan.ts re-exports it.
import type { RepoMap } from "./repomap.ts";

export const MAX_RELEVANT_FILES = 8;

export function keywords(task: string): string[] {
  const words = task.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return Array.from(new Set(words.filter((w) => w.length > 2)));
}

export const haystack = (entry: RepoMap["entries"][number]): string => `${entry.path} ${entry.symbols.join(" ")}`.toLowerCase();

function rank(words: string[], repoMap: RepoMap, max: number): PickedFile[] {
  if (words.length === 0) return [];
  const scored = repoMap.entries.map((entry, idx) => {
    const hay = haystack(entry);
    const matched = words.filter((w) => hay.includes(w));
    return { path: entry.path, score: matched.length, idx, reason: `matched: ${matched.join(", ")}` };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.idx - b.idx).slice(0, max).map((s) => ({ path: s.path, reason: s.reason }));
}

export interface PickedFile { path: string; reason: string }

/** Keyword overlap between task and repo map entry (path plus symbols); zero-score files are dropped, ties keep repo map order. */
export function selectRelevantFiles(task: string, repoMap: RepoMap, max: number = MAX_RELEVANT_FILES): string[] {
  return rank(keywords(task), repoMap, max).map((p) => p.path);
}

/** Same picks as selectRelevantFiles, each with the task keywords that matched it (the pick reason). */
export function selectRelevantFilesWithReason(task: string, repoMap: RepoMap, max: number = MAX_RELEVANT_FILES): PickedFile[] {
  return rank(keywords(task), repoMap, max);
}
