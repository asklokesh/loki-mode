// loki-ts/src/engine10/repomap.ts
//
// E-04: repo map for Intake (ENGINE.md section 3 "repomap.ts: file list + top
// level symbols, size-capped"). Deterministic, no LLM: `git ls-files` plus a
// best-effort regex scan (Python methods are Class.method). Caps files, bytes and
// symbols per file so a huge repo cannot blow up Intake's 15s/60s limit.
import { readFileSync } from "node:fs";
import { safeGit } from "../util/safe_git.ts";
import { join } from "node:path";
export interface RepoMapEntry {
  path: string;
  symbols: string[]; // exported names, best effort
}
export interface RepoMap {
  files: string[];
  entries: RepoMapEntry[];
  truncated: boolean; // true when the file cap was hit
}
const MAX_FILES = 2000;
const MAX_SCAN_BYTES = 256_000; // per file, for symbol extraction only
const MAX_SYMBOLS = 300; // per file
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/;
const SYMBOL_RE = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z0-9_$]+)/gm;
const PY_SYMBOL_RE = /^(?:(?:async\s+)?def\s+(\w+)|class\s+(\w+))|^([ \t]+)(?:async\s+)?def\s+(\w+)/gm;
/** git ls-files, capped. Returns [] (never throws) outside a git repo. */
export function listRepoFiles(repoDir: string, maxFiles: number = MAX_FILES): { files: string[]; truncated: boolean } {
  let out: string;
  try {
    out = safeGit(repoDir, ["ls-files"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return { files: [], truncated: false };
  }
  const all = out.split("\n").filter((l) => l.length > 0);
  return { files: all.slice(0, maxFiles), truncated: all.length > maxFiles };
}
function topLevelSymbols(absPath: string, re: RegExp): string[] {
  let text: string;
  try { text = readFileSync(absPath, "utf8").slice(0, MAX_SCAN_BYTES); } catch { return []; }
  const names: string[] = [];
  let cls = "", indent = "";
  for (const m of text.matchAll(re)) {
    if (names.length >= MAX_SYMBOLS) break;
    if (re !== PY_SYMBOL_RE) { if (m[1]) names.push(m[1]); continue; }
    if (m[1] || m[2]) { cls = m[2] ?? ""; indent = ""; names.push((m[1] ?? m[2])!); continue; }
    if (cls && (indent ||= m[3]!) === m[3]) names.push(`${cls}.${m[4]}`);
  }
  return names;
}
export function buildRepoMap(repoDir: string, maxFiles: number = MAX_FILES): RepoMap {
  const { files, truncated } = listRepoFiles(repoDir, maxFiles);
  const entries: RepoMapEntry[] = [];
  for (const rel of files) {
    if (!SOURCE_EXT.test(rel)) continue;
    const symbols = topLevelSymbols(join(repoDir, rel), rel.endsWith(".py") ? PY_SYMBOL_RE : SYMBOL_RE);
    if (symbols.length > 0) entries.push({ path: rel, symbols });
  }
  return { files, entries, truncated };
}
