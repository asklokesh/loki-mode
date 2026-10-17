// loki-ts/src/engine10/cache.ts -- E-18 per-repo cache (ENGINE.md section 13): repomap/testmap keyed
// by HEAD^{tree}, plus flaky tests and failure signatures for the brief's "top 3 past failures".
// Reads are O(1) and never throw (missing or corrupt = miss); nothing writes as a side effect of a
// read. Callers time writes after the PR. Not yet in RunContext (a later CacheProvider slice).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
// ponytail: top-level shape only (array-ness), not per-entry field checks --
// this is what closes the demonstrated crash; a future slice can deep-check
// RepoMap/TestMap entries if a corrupt-but-array-shaped file shows up.
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
export function readRepoMapCache(dir: string, tree: string): RepoMap | null {
  return readJson<RepoMap>(resolve(dir, `repomap2-${tree}.json`), isRepoMap);
}
export function writeRepoMapCache(dir: string, tree: string, map: RepoMap): void {
  writeJson(resolve(dir, `repomap2-${tree}.json`), dir, map);
}
export function readTestMapCache(dir: string, tree: string): TestMap | null {
  return readJson<TestMap>(resolve(dir, `testmap-${tree}.json`), isTestMap);
}
export function writeTestMapCache(dir: string, tree: string, map: TestMap): void {
  writeJson(resolve(dir, `testmap-${tree}.json`), dir, map);
}
