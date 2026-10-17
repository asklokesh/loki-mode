// loki-ts/src/engine10/cache.ts -- E-18 per-repo cache (ENGINE.md section 13): repomap/testmap keyed by HEAD^{tree}.
// Reads never throw (missing or corrupt = miss) and write nothing; callers time writes after the PR.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { homeLokiDir } from "../util/paths.ts";
import type { RepoMap } from "./repomap.ts";
import type { TestMap } from "./types.ts";
/** sha256 of the pinned origin URL, or of the absolute repo path when there
 *  is no origin (ENGINE.md section 13). */
export function repoKey(originUrl: string | null, repoDir: string): string {
  const basis = originUrl && originUrl.trim() !== "" ? originUrl : resolve(repoDir);
  return createHash("sha256").update(basis).digest("hex");
}
/** ~/.loki/cache/v10 (ENGINE.md section 13). Callers may pass their own root
 *  (tests do, to stay off the real home directory). */
export function defaultCacheRoot(): string {
  return resolve(homeLokiDir(), "cache", "v10");
}
export function repoCacheDir(key: string, cacheRoot: string = defaultCacheRoot()): string {
  return resolve(cacheRoot, key);
}
// Parses fine but is the wrong shape (e.g. `null`, `{}`, a bare number) is
// just as much a corrupt cache entry as unparseable text: both are a miss,
// never a throw. `isValid` lets each caller state its own shape; callers
// that skip it accept anything JSON.parse produces, same as before.
export function readJson<T>(path: string, isValid: (v: unknown) => v is T = (_v): _v is T => true): T | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isValid(parsed) ? parsed : null;
  } catch {
    return null; // a corrupt cache entry is a miss, never a crash
  }
}
// Top-level shape only (array-ness); a deep per-entry check is a later slice if a corrupt array-shaped file shows up.
function isRepoMap(v: unknown): v is RepoMap {
  return typeof v === "object" && v !== null && Array.isArray((v as RepoMap).files) && Array.isArray((v as RepoMap).entries);
}
function isTestMap(v: unknown): v is TestMap {
  return typeof v === "object" && v !== null && Array.isArray((v as TestMap).runners) && Array.isArray((v as TestMap).tests);
}
export function writeJson(path: string, dir: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}
/** TEN-STABILITY-45: after a write keep the newest 5 `<prefix>*.json` files (the one just written always survives). Never throws. */
export function pruneCache(dir: string, prefix: string, keepPath: string, keep = 5): void {
  const mt = (f: string): number => { try { return statSync(resolve(dir, f)).mtimeMs; } catch { return 0; } };
  try { readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json") && f !== basename(keepPath)).sort((x, y) => mt(y) - mt(x) || (x < y ? 1 : -1)).slice(keep - 1).forEach((f) => { try { unlinkSync(resolve(dir, f)); } catch { /* best effort */ } }); } catch { /* prune failure never fails a write */ }
}
const writeAndPrune = (path: string, dir: string, prefix: string, data: unknown): void => { writeJson(path, dir, data); pruneCache(dir, prefix, path); };
export const readRepoMapCache = (dir: string, tree: string): RepoMap | null => readJson<RepoMap>(resolve(dir, `repomap2-${tree}.json`), isRepoMap);
export const writeRepoMapCache = (dir: string, tree: string, map: RepoMap): void => writeAndPrune(resolve(dir, `repomap2-${tree}.json`), dir, "repomap2-", map);
export const readTestMapCache = (dir: string, tree: string): TestMap | null => readJson<TestMap>(resolve(dir, `testmap-${tree}.json`), isTestMap);
export const writeTestMapCache = (dir: string, tree: string, map: TestMap): void => writeAndPrune(resolve(dir, `testmap-${tree}.json`), dir, "testmap-", map);
/** TEN-SPEED-04: hit/miss counts for the tree-keyed builders below. */
export const cacheStats = { hits: 0, misses: 0 };
function viaCache<T>(hit: T | null, build: () => T, save: (m: T) => void): T {
  if (hit) { cacheStats.hits++; return hit; }
  cacheStats.misses++;
  const m = build();
  try { save(m); } catch { /* an unwritable cache only costs the next round a rebuild */ }
  return m;
}
/** Same tree hash as an earlier fix round: reuse the stored map; otherwise build once and store. */
export const cachedRepoMap = (dir: string, tree: string, build: () => RepoMap): RepoMap => viaCache(readRepoMapCache(dir, tree), build, (m) => writeRepoMapCache(dir, tree, m));
export const cachedTestMap = (dir: string, tree: string, build: () => TestMap): TestMap => viaCache(readTestMapCache(dir, tree), build, (m) => writeTestMapCache(dir, tree, m));
