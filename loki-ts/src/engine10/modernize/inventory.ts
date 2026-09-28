// loki-ts/src/engine10/modernize/inventory.ts -- M-02: Inventory core (docs/v10/MODERNIZE.md
// section 3.1). Deterministic, no model spend. Reuses repomap.ts's git ls-files walk and
// testmap.ts's runner/test detection rather than re-scanning the tree twice.
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { listRepoFiles } from "../repomap.ts";
import { buildTestMap } from "../testmap.ts";
import type { EngineTestMap } from "../testmap.ts";

export type Language = "python" | "java" | "javascript" | "typescript" | "go" | "other";
const EXT_LANGUAGE: Partial<Record<string, Language>> = {
  ".py": "python", ".java": "java", ".go": "go",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript",
};

export type BuildSystemName = "setuptools" | "poetry" | "tox" | "maven" | "gradle";
export interface BuildSystem {
  system: BuildSystemName | null;
  marker: string | null; // repo-relative path of the marker file that identified it
}
// Order matters: the first marker present wins (section 3.1's marker-file list).
const BUILD_MARKERS: readonly [string, BuildSystemName][] = [
  ["pyproject.toml", "poetry"], ["setup.py", "setuptools"], ["tox.ini", "tox"],
  ["pom.xml", "maven"], ["build.gradle", "gradle"], ["build.gradle.kts", "gradle"],
];

const MAX_SCAN_BYTES = 20_000; // per file, matches repomap.ts's cap
const PY_MAIN_RE = /if\s+__name__\s*==\s*['"]__main__['"]/;
const JAVA_MAIN_RE = /public\s+static\s+void\s+main\s*\(/;

export interface InventoryResult {
  files: string[];
  truncated: boolean; // true when the file cap (repomap.ts) was hit
  languages: Partial<Record<Language, number>>; // source file count per language
  buildSystem: BuildSystem;
  entryPoints: string[]; // repo-relative paths with a detected __main__/main() entry
  tests: EngineTestMap;
}

function readCapped(absPath: string): string {
  try {
    return readFileSync(absPath, "utf8").slice(0, MAX_SCAN_BYTES);
  } catch {
    return "";
  }
}

function detectBuildSystem(files: readonly string[]): BuildSystem {
  const present = new Set(files);
  for (const [marker, system] of BUILD_MARKERS) {
    if (present.has(marker)) return { system, marker };
  }
  return { system: null, marker: null };
}

function detectEntryPoints(repoDir: string, files: readonly string[]): string[] {
  const out: string[] = [];
  for (const rel of files) {
    const ext = extname(rel);
    if (ext === ".py" && PY_MAIN_RE.test(readCapped(join(repoDir, rel)))) out.push(rel);
    else if (ext === ".java" && JAVA_MAIN_RE.test(readCapped(join(repoDir, rel)))) out.push(rel);
  }
  return out;
}

/** Section 3.1 Inventory work: files, languages, build system, entry points, tests. No graph
 *  edges here (M-03/M-04): those are language-specific dependency scans, out of this slice. */
export function buildInventory(repoDir: string): InventoryResult {
  const { files, truncated } = listRepoFiles(repoDir);
  const languages: Partial<Record<Language, number>> = {};
  for (const rel of files) {
    const lang = EXT_LANGUAGE[extname(rel)];
    if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
  }
  return {
    files,
    truncated,
    languages,
    buildSystem: detectBuildSystem(files),
    entryPoints: detectEntryPoints(repoDir, files),
    tests: buildTestMap(repoDir),
  };
}
