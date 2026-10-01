// loki-ts/src/e10ext/compound_match.ts -- D50-F5: deterministic compound-token matching for already_done's
// evidence search ("searchbar" vs search-command.tsx). Pure and model-free; lives here to keep engine10 core under its line budget.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RepoMap } from "../engine10/repomap.ts";
import type { TestMap } from "../engine10/types.ts";

export interface LinkedHit {
  source: "code" | "test";
  path: string;
  line: string;
}

/** Lowercase parts of an identifier or file name, splitting camelCase, snake_case and punctuation. */
function parts(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

const MIN_PREFIX = 5; // a stem token this long or longer may be the front of a compound keyword ("search" in "searchbar")

const INFLECTION = /^(s|es|ed|er|ers|ing|ings|ion|ions|ly|less)$/; // "exporting" is "export" inflected, not a compound ("searchbar" is)

const VENDORED = new Set(["vendor", "third_party", "build", ".venv", "coverage", "node_modules", "dist"]);
const vendored = (p: string): boolean => p.split("/").some((s) => VENDORED.has(s));

/** Compound match: `word` is a run of adjacent parts glued together, or starts with a part of at least MIN_PREFIX chars. */
function fuzzyHit(word: string, ps: string[]): boolean {
  if (ps.some((p) => p.length >= MIN_PREFIX && word.length > p.length && word.startsWith(p) && !INFLECTION.test(word.slice(p.length)))) return true;
  for (let i = 0; i < ps.length; i++) for (let j = i + 2; j <= ps.length; j++) if (ps.slice(i, j).join("") === word) return true;
  return false;
}

/** File stem as parts: no extension, no .test/.spec marker ("search-command.test.tsx" and "SearchCommand.tsx" both give search-command). */
const stemOf = (p: string): string => parts(basename(p)).slice(0, -1).filter((x) => x !== "test" && x !== "spec").join("-");

/** A source file and a test file count as two categories only when they share a stem and the test names that stem. */
export function linkedHits(word: string, repoMap: RepoMap, testMap: TestMap, repoDir: string): LinkedHit[] {
  const out: LinkedHit[] = [];
  const srcs = repoMap.entries.filter((e) => !vendored(e.path) && e.symbols.some((s) => fuzzyHit(word, parts(s))) && fuzzyHit(word, parts(basename(e.path))));
  for (const t of testMap.tests) {
    if (vendored(t.path) || !fuzzyHit(word, parts(basename(t.path)))) continue;
    let body: string[];
    try {
      body = readFileSync(join(repoDir, t.path), "utf8").split("\n").filter((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l) && /^\s*(import\b|from\s+\S+\s+import\b)|\brequire\s*\(|\bfrom\s+["']/.test(l)).map((l) => l.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
    } catch {
      continue;
    }
    for (const e of srcs) {
      const stem = stemOf(e.path);
      if (stem && stemOf(t.path) === stem && body.some((l) => l.includes(stem))) {
        const sym = e.symbols.find((x) => fuzzyHit(word, parts(x))) ?? stem;
        out.push({ source: "code", path: e.path, line: sym }, { source: "test", path: t.path, line: t.path });
      }
    }
  }
  return out;
}
