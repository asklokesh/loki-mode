// loki-ts/src/engine10/cache.ts -- E-18 per-repo cache (ENGINE.md section 13): repomap/testmap keyed by HEAD^{tree} and the producer fingerprint.
// Reads never throw (missing or corrupt = miss) and write nothing; callers time writes after the PR.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { homeLokiDir } from "../util/paths.ts";
import type { RepoMap } from "./repomap.ts";
import type { TestMap } from "./types.ts";
/** sha256 of the pinned origin URL, or of the absolute repo path when there  is no origin (ENGINE.md section 13). */
export function repoKey(originUrl: string | null, repoDir: string): string {
  const basis = originUrl && originUrl.trim() !== "" ? originUrl : resolve(repoDir);
  return createHash("sha256").update(basis).digest("hex");
}
/** ~/.loki/cache/v10 (ENGINE.md section 13). Callers may pass their own root  (tests do, to stay off the real home directory). */
export function defaultCacheRoot(): string {
  return resolve(homeLokiDir(), "cache", "v10");
}
export function repoCacheDir(key: string, cacheRoot: string = defaultCacheRoot()): string {
  return resolve(cacheRoot, key);
}
// Parses fine but is the wrong shape (e.g. `null`, `{}`, a bare number) is just as much a corrupt cache entry as unparseable text: both are a miss, never a throw. `isValid` lets each caller state its
// own shape; callers that skip it accept anything JSON.parse produces, same as before.
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
/** sha256 over the relative path and bytes of every .ts file under `root`, in sorted order. Hashing the whole tree (not a  hand-picked builder list) means any code the builders import changes the key too. */
export function sourceFingerprint(root: string): string {
  const h = createHash("sha256");
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = resolve(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
      else if (e.isFile() && e.name.endsWith(".ts")) h.update(`${relative(root, p)}\0`).update(readFileSync(p)).update("\0");
    }
  };
  walk(root);
  return h.digest("hex");
}
declare global { var __LOKI_PRODUCER_FP__: string | undefined; }
let producerFp: string | null = null;
/** The producer fingerprint stored maps are bound to. A bundle gets it generated in by scripts/build.ts (the bundle has no  source path to hash); a source run hashes src/ itself. When neither is
 *  possible it is a per-process random value, so  nothing stored can ever match: a cache that cannot name its producer misses, it never serves an unbound map. */
export function computeProducerFingerprint(root: string = resolve(import.meta.dir, ".."), injected: unknown = globalThis.__LOKI_PRODUCER_FP__): string {
  if (typeof injected === "string" && /^[0-9a-f]{64}$/.test(injected)) return injected;
  try { return sourceFingerprint(root); } catch { return createHash("sha256").update(`unbound:${process.pid}:${Date.now()}:${Math.random()}`).digest("hex"); }
}
export function producerFingerprint(): string {
  return (producerFp ??= computeProducerFingerprint());
}
let tmpSeq = 0;
/** Cache files are private (dir 0700, file 0600, re-applied when the dir pre-existed loose) and land through a temp file plus rename, so a reader never sees a partial file and no temp file outlives a failed write. */
export function writeJson(path: string, dir: string, data: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}
/** TEN-STABILITY-45: after a write keep the newest 5 `<prefix>*.json` files (the one just written always survives). Never throws. */
export function pruneCache(dir: string, prefix: string, keepPath: string, keep = prefix === "slice-" ? 500 : 5): void {
  const mt = (f: string): number => { try { return statSync(resolve(dir, f)).mtimeMs; } catch { return 0; } };
  try { readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json") && f !== basename(keepPath)).sort((x, y) => mt(y) - mt(x) || (x < y ? 1 : -1)).slice(keep - 1).forEach((f) => { try { unlinkSync(resolve(dir, f)); } catch { /* best effort */ } }); } catch { /* prune failure never fails a write */ }
}
const LEGACY_PREFIX: Record<string, string> = { "repomap-": "repomap2-" }; // the pre-producer-binding name; nothing reads it any more, so the first write removes them all
const writeAndPrune = (path: string, dir: string, prefix: string, data: unknown): void => { writeJson(path, dir, data); pruneCache(dir, prefix, path); const old = LEGACY_PREFIX[prefix]; if (old) pruneCache(dir, old, path, 1); };
// The producer fingerprint sits in the name next to the tree hash, so a builder change is a different key, not a bumped prefix.
export const cacheFileName = (kind: "repomap" | "testmap", tree: string, fp: string = producerFingerprint()): string => `${kind}-${fp.slice(0, 16)}-${tree}.json`;
export const readRepoMapCache = (dir: string, tree: string, fp: string = producerFingerprint()): RepoMap | null => readJson<RepoMap>(resolve(dir, cacheFileName("repomap", tree, fp)), isRepoMap);
export const writeRepoMapCache = (dir: string, tree: string, map: RepoMap, fp: string = producerFingerprint()): void => writeAndPrune(resolve(dir, cacheFileName("repomap", tree, fp)), dir, "repomap-", map);
export const readTestMapCache = (dir: string, tree: string, fp: string = producerFingerprint()): TestMap | null => readJson<TestMap>(resolve(dir, cacheFileName("testmap", tree, fp)), isTestMap);
export const writeTestMapCache = (dir: string, tree: string, map: TestMap, fp: string = producerFingerprint()): void => writeAndPrune(resolve(dir, cacheFileName("testmap", tree, fp)), dir, "testmap-", map);
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
export const cachedRepoMap = (dir: string, tree: string, build: () => RepoMap, fp: string = producerFingerprint()): RepoMap => viaCache(readRepoMapCache(dir, tree, fp), build, (m) => writeRepoMapCache(dir, tree, m, fp));
export const cachedTestMap = (dir: string, tree: string, build: () => TestMap, fp: string = producerFingerprint()): TestMap => viaCache(readTestMapCache(dir, tree, fp), build, (m) => writeTestMapCache(dir, tree, m, fp));
/** #283 slice journal: sha256 of the slice card plus the base sha. A unit whose card and base are unchanged and whose result is journaled is not dispatched again. The length prefix keeps ("ab","c") and ("a","bc") apart. */
export const sliceKey = (card: string, baseSha: string): string => createHash("sha256").update(`${card.length}:${card}\0${baseSha}`).digest("hex");
export interface SliceJournalEntry { gid: string; n: number; id: string; head: string }
const isJournalEntry = (v: unknown): v is SliceJournalEntry => {
  const e = v as SliceJournalEntry | null;
  return typeof e === "object" && e !== null && typeof e.gid === "string" && typeof e.id === "string" && typeof e.head === "string" && Number.isInteger(e.n);
};
export const readSliceJournal = (dir: string, key: string): SliceJournalEntry | null => readJson<SliceJournalEntry>(resolve(dir, `slice-${key}.json`), isJournalEntry);
export const writeSliceJournal = (dir: string, key: string, entry: SliceJournalEntry): void => writeAndPrune(resolve(dir, `slice-${key}.json`), dir, "slice-", entry);
