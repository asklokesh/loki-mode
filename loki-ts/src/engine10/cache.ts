// loki-ts/src/engine10/cache.ts
//
// E-18: per-repo cache (docs/v10/ENGINE.md section 13 "Cache (cache.ts)").
// Speeds up repeat runs on an unchanged tree: repomap/testmap keyed by
// HEAD^{tree}, plus a per-repo flaky-test list and failure-signature history
// for the implementer brief's "top 3 past failures".
//
// Reads are optional and O(1): a missing or corrupt file is a cache miss
// (null / []), never a throw. Writes are the caller's job to time (ENGINE.md:
// "writes happen after the PR, so nothing slows the first run") -- nothing in
// this module writes as a side effect of a read, and nothing here is called
// from intake/pr yet, so that ordering is enforced wherever a later slice
// wires this in.
//
// Not wired into RunContext/types.ts by this slice: E-18 owns cache.ts only
// (docs/v10/ENGINE.md section 16). A future slice adds a CacheProvider
// interface to types.ts once intake.ts and pr.ts are ready to inject it.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homeLokiDir } from "../util/paths.ts";
import type { RepoMap } from "./repomap.ts";
import type { TestMap } from "./types.ts";

export interface FailureSignature {
  signature: string;
  count: number;
  sample: string;
}

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

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null; // a corrupt cache entry is a miss, never a crash
  }
}

function writeJson(path: string, dir: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

export function readRepoMapCache(dir: string, tree: string): RepoMap | null {
  return readJson<RepoMap>(resolve(dir, `repomap-${tree}.json`));
}

export function writeRepoMapCache(dir: string, tree: string, map: RepoMap): void {
  writeJson(resolve(dir, `repomap-${tree}.json`), dir, map);
}

export function readTestMapCache(dir: string, tree: string): TestMap | null {
  return readJson<TestMap>(resolve(dir, `testmap-${tree}.json`));
}

export function writeTestMapCache(dir: string, tree: string, map: TestMap): void {
  writeJson(resolve(dir, `testmap-${tree}.json`), dir, map);
}

/** Flaky test paths seen across past runs (deduped, sorted). */
export function readFlaky(dir: string): string[] {
  return readJson<string[]>(resolve(dir, "flaky.json")) ?? [];
}

/** Unions `testPaths` into the existing flaky list and writes it back. */
export function recordFlaky(dir: string, testPaths: readonly string[]): void {
  const merged = new Set([...readFlaky(dir), ...testPaths]);
  writeJson(resolve(dir, "flaky.json"), dir, [...merged].sort());
}

function failuresPath(dir: string): string {
  return resolve(dir, "failures.jsonl");
}

/** Appends one failure-signature record per group, one JSON object per line. */
export function recordFailures(dir: string, groups: readonly FailureSignature[]): void {
  if (groups.length === 0) return;
  mkdirSync(dir, { recursive: true });
  const lines = `${groups.map((g) => JSON.stringify(g)).join("\n")}\n`;
  const existing = existsSync(failuresPath(dir)) ? readFileSync(failuresPath(dir), "utf8") : "";
  writeFileSync(failuresPath(dir), existing + lines);
}

/** The top `n` failure signatures by total count across all recorded runs
 *  (ENGINE.md section 13: "the top 3 past failure signatures go into the
 *  implementer brief"). Missing file or all-corrupt lines yield []; a single
 *  bad line is skipped rather than sinking the whole read. */
export function topFailures(dir: string, n = 3): FailureSignature[] {
  const path = failuresPath(dir);
  if (!existsSync(path)) return [];
  const totals = new Map<string, FailureSignature>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let rec: FailureSignature;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const prior = totals.get(rec.signature);
    totals.set(rec.signature, {
      signature: rec.signature,
      count: (prior?.count ?? 0) + rec.count,
      sample: rec.sample, // most recent sample wins
    });
  }
  return [...totals.values()].sort((a, b) => b.count - a.count).slice(0, n);
}
