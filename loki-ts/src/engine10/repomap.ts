// loki-ts/src/engine10/repomap.ts
//
// E-04: repo map for Intake (ENGINE.md section 3 "repomap.ts: file list + top
// level symbols, size-capped"). Deterministic, no LLM: `git ls-files` plus a
// best-effort regex scan of each source file's top-level exports. Caps both
// the file count and the per-file read so a huge repo cannot blow up Intake's
// 15s target / 60s limit.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
export interface RepoMapEntry {
  path: string;
  symbols: string[]; // top-level exported names, best effort
}
export interface RepoMap {
  files: string[];
  entries: RepoMapEntry[];
  truncated: boolean; // true when the file cap was hit
}
const MAX_FILES = 2000;
const MAX_SCAN_BYTES = 20_000; // per file, for symbol extraction only
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/;
const SYMBOL_RE = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;
/** git ls-files, capped. Returns [] (never throws) outside a git repo. */
export function listRepoFiles(repoDir: string, maxFiles: number = MAX_FILES): { files: string[]; truncated: boolean } {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files"], { cwd: repoDir, encoding: "utf8", env: process.env });
  } catch {
    return { files: [], truncated: false };
  }
  const all = out.split("\n").filter((l) => l.length > 0);
  return { files: all.slice(0, maxFiles), truncated: all.length > maxFiles };
}
function topLevelSymbols(absPath: string): string[] {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8").slice(0, MAX_SCAN_BYTES);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const m of text.matchAll(SYMBOL_RE)) {
    const name = m[1];
    if (name) names.push(name);
  }
  return names;
}
export function buildRepoMap(repoDir: string, maxFiles: number = MAX_FILES): RepoMap {
  const { files, truncated } = listRepoFiles(repoDir, maxFiles);
  const entries: RepoMapEntry[] = [];
  for (const rel of files) {
    if (!SOURCE_EXT.test(rel)) continue;
    const symbols = topLevelSymbols(join(repoDir, rel));
    if (symbols.length > 0) entries.push({ path: rel, symbols });
  }
  return { files, entries, truncated };
}
