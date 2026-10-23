// Thin delegate over util/relevance.ts. Lives outside stages/ so features/ may import it (D66 fence); plan.ts re-exports it.
import type { RepoMap } from "./repomap.ts";
import { rankRelevant, type PickedFile } from "../util/relevance.ts";

export type { PickedFile };
export const MAX_RELEVANT_FILES = 8;

/** Whole-word task keywords for lean_select's unsplit whole-token match (FC-28); ranking lives in util/relevance.ts. */
export function keywords(task: string): string[] {
  return Array.from(new Set((task.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length > 2)));
}

export const haystack = (entry: RepoMap["entries"][number]): string => `${entry.path} ${entry.symbols.join(" ")}`.toLowerCase();

/** Identifier-aware overlap between task and repo map entry; zero-score files are dropped, ties keep repo map order. */
export function selectRelevantFiles(task: string, repoMap: RepoMap, max: number = MAX_RELEVANT_FILES, repoDir?: string): string[] {
  return rankRelevant(task, repoMap, max, repoDir).map((p) => p.path);
}
