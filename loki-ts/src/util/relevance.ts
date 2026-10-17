// Identifier-aware relevance ranking over a repo map (TEN-QUALITY-05). Pure, no IO.
// Rules: a repo path named in the task (traceback frame, file:line:col, dotted module) ranks first;
// otherwise exact identifier tokens only (camelCase, snake_case, dots, slashes split), weights
// basename stem 3, symbol 2, path segment 1; fixed stopwords; ties keep repo map order.
import type { RepoMap } from "../engine10/repomap.ts";

export interface PickedFile { path: string; reason: string }
type Entry = RepoMap["entries"][number];

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "onto", "are", "was", "were", "will", "can", "should", "would", "could",
  "add", "fix", "make", "use", "new", "get", "set", "all", "any", "not", "but", "has", "have", "its", "our", "your", "when", "then",
  "than", "also", "each", "must", "need", "needs", "file", "files", "code", "update", "change", "implement", "create", "support",
  "line", "error", "test", "tests", "bug", "issue", "task", "feature", "please",
]);

const PATH_WEIGHT = 1000;
const EXT_RE = /\.(?:py|ts|tsx|js|jsx|mjs|cjs|go|rs|java|rb|sh|c|cc|cpp|h|hpp|cs|kt|swift|php|md|json|ya?ml|toml)$/;

/** Split identifiers into lowercase word tokens: camelCase, snake_case, dots, slashes, digits. */
export function identTokens(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
}

/** Task words: identifier tokens longer than 2 chars, minus stopwords, deduplicated. */
export function taskKeywords(task: string): string[] {
  return Array.from(new Set(identTokens(task).filter((w) => w.length > 2 && !STOPWORDS.has(w))));
}

/** Repo paths named in the task: literal paths, optional :line:col, and dotted modules mapped to a path. */
function namedPaths(task: string, entries: Entry[]): Map<string, string> {
  const hits = new Map<string, string>();
  const candidates = task.match(/[A-Za-z0-9_@.\-/]+/g) ?? [];
  for (const raw of candidates) {
    const cand = raw.replace(/^\.\//, "").replace(/[.:]+$/, "");
    if (cand.length < 3) continue;
    if (EXT_RE.test(cand) || cand.includes("/")) {
      for (const e of entries) {
        if (e.path === cand || e.path.endsWith(`/${cand}`)) hits.set(e.path, `path: ${cand}`);
      }
    }
    if (!cand.includes("/") && cand.includes(".")) {
      const parts = cand.split(".");
      for (let n = parts.length; n >= 2; n--) {
        const stem = parts.slice(0, n).join("/");
        const found = entries.filter((e) => {
          const noExt = e.path.replace(EXT_RE, "");
          return noExt === stem || noExt.endsWith(`/${stem}`) || noExt === `${stem}/index` || noExt === `${stem}/__init__`;
        });
        if (found.length > 0) {
          for (const e of found) hits.set(e.path, `module: ${cand}`);
          break;
        }
      }
    }
  }
  return hits;
}

export function rankRelevant(task: string, repoMap: RepoMap, max: number): PickedFile[] {
  const entries = repoMap.entries;
  const words = taskKeywords(task);
  const named = namedPaths(task, entries);
  if (words.length === 0 && named.size === 0) return [];
  const scored = entries.map((entry, idx) => {
    const segs = entry.path.split("/");
    const stemSet = new Set(identTokens((segs[segs.length - 1] ?? "").replace(EXT_RE, "")));
    const symSet = new Set(entry.symbols.flatMap(identTokens));
    const segSet = new Set(segs.slice(0, -1).flatMap(identTokens));
    let score = 0;
    const matched: string[] = [];
    for (const w of words) {
      const wt = stemSet.has(w) ? 3 : symSet.has(w) ? 2 : segSet.has(w) ? 1 : 0;
      if (wt > 0) { score += wt; matched.push(w); }
    }
    const via = named.get(entry.path);
    if (via) score += PATH_WEIGHT;
    const tail = matched.length ? `matched: ${matched.join(", ")}` : "";
    const reason = via ? (tail ? `${via}; ${tail}` : via) : tail;
    return { path: entry.path, score, idx, reason };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.idx - b.idx).slice(0, max).map((s) => ({ path: s.path, reason: s.reason }));
}
