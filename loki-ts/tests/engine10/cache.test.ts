import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  cacheFileName,
  cacheStats,
  cachedRepoMap,
  cachedTestMap,
  pruneCache,
  readRepoMapCache,
  readTestMapCache,
  repoCacheDir,
  readSliceJournal,
  repoKey,
  sliceKey,
  writeRepoMapCache,
  writeSliceJournal,
  writeTestMapCache,
} from "../../src/engine10/cache.ts";
import { computeProducerFingerprint, producerFingerprint, sourceFingerprint } from "../../src/util/producer_fingerprint.ts";
import { readFlaky, recordFailures, recordFlaky, topFailures } from "../../src/util/failure_memory.ts";
import type { RepoMap } from "../../src/engine10/repomap.ts";
import type { TestMap } from "../../src/engine10/types.ts";

// All tests use an injected tmp cacheRoot (never the real ~/.loki), per the
// "test with fakes / injected paths" rule.
const temps: string[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "e10-cache-"));
  temps.push(d);
  return d;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

const REPOMAP: RepoMap = { files: ["a.ts"], entries: [{ path: "a.ts", symbols: ["a"] }], truncated: false };
const TESTMAP: TestMap = { runners: ["vitest"], tests: [{ runner: "vitest", path: "a.test.ts" }] };

describe("repoKey", () => {
  test("is deterministic and origin beats path", () => {
    expect(repoKey("https://github.com/o/r.git", "/tmp/x")).toBe(repoKey("https://github.com/o/r.git", "/tmp/y"));
  });

  test("no origin falls back to the absolute repo path", () => {
    expect(repoKey(null, "/tmp/x")).not.toBe(repoKey(null, "/tmp/y"));
    expect(repoKey(null, "/tmp/x")).toBe(repoKey(null, "/tmp/x"));
  });

  test("empty-string origin is treated as no origin", () => {
    expect(repoKey("", "/tmp/x")).toBe(repoKey(null, "/tmp/x"));
  });
});

describe("repomap/testmap cache, keyed by tree hash", () => {
  test("miss on an empty cache dir: never throws, returns null", () => {
    const dir = repoCacheDir(repoKey(null, "/nonexistent"), tmpRoot());
    expect(readRepoMapCache(dir, "tree1")).toBeNull();
    expect(readTestMapCache(dir, "tree1")).toBeNull();
  });

  test("write then read round-trips for the same tree", () => {
    const dir = repoCacheDir("k", tmpRoot());
    writeRepoMapCache(dir, "tree1", REPOMAP);
    writeTestMapCache(dir, "tree1", TESTMAP);
    expect(readRepoMapCache(dir, "tree1")).toEqual(REPOMAP);
    expect(readTestMapCache(dir, "tree1")).toEqual(TESTMAP);
  });

  test("a different tree hash is a separate cache entry (miss until written)", () => {
    const dir = repoCacheDir("k", tmpRoot());
    writeRepoMapCache(dir, "tree1", REPOMAP);
    expect(readRepoMapCache(dir, "tree2")).toBeNull();
    // second run on the SAME tree reads what the first wrote (ENGINE.md E-18
    // green criterion: "the second intake on the same tree reads from the cache")
    expect(readRepoMapCache(dir, "tree1")).toEqual(REPOMAP);
  });

  test("a stale old-format repomap-<tree>.json is ignored", () => {
    const dir = repoCacheDir("k", tmpRoot());
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(resolve(dir, "repomap-tree1.json"), JSON.stringify(REPOMAP));
    expect(readRepoMapCache(dir, "tree1")).toBeNull();
  });

  test("a corrupt cache file is a miss, not a crash", () => {
    const dir = repoCacheDir("k", tmpRoot());
    writeRepoMapCache(dir, "tree1", REPOMAP);
    require("node:fs").writeFileSync(resolve(dir, cacheFileName("repomap", "tree1")), "{not json");
    expect(readRepoMapCache(dir, "tree1")).toBeNull();
  });

  // Valid JSON of the wrong shape is a different failure mode from
  // unparseable text: JSON.parse succeeds, so a shape check is the only
  // thing standing between this and a runtime crash in the caller.
  test("valid JSON of the wrong shape is a miss, not a crash", () => {
    const dir = repoCacheDir("k", tmpRoot());
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(resolve(dir, cacheFileName("repomap", "tree1")), "42");
    require("node:fs").writeFileSync(resolve(dir, cacheFileName("testmap", "tree1")), "null");
    expect(readRepoMapCache(dir, "tree1")).toBeNull();
    expect(readTestMapCache(dir, "tree1")).toBeNull();
  });

  // ENGINE.md:631 "the first run performs no cache write before pr.opened":
  // a miss read must never create the cache file or directory as a side
  // effect, or a read-only intake would start writing to disk.
  test("a miss read writes nothing to disk", () => {
    const root = tmpRoot();
    const dir = repoCacheDir(repoKey(null, "/nonexistent"), root);
    readRepoMapCache(dir, "tree1");
    readTestMapCache(dir, "tree1");
    readFlaky(dir);
    topFailures(dir);
    expect(existsSync(dir)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });
});

describe("flaky list (per repo, not per tree)", () => {
  test("empty by default", () => {
    expect(readFlaky(repoCacheDir("k", tmpRoot()))).toEqual([]);
  });

  test("accumulates across calls, deduped and sorted", () => {
    const dir = repoCacheDir("k", tmpRoot());
    recordFlaky(dir, ["b/x.test.ts"]);
    recordFlaky(dir, ["a/y.test.ts", "b/x.test.ts"]);
    expect(readFlaky(dir)).toEqual(["a/y.test.ts", "b/x.test.ts"]);
  });

  // A partially-written cache file (`{}`) parses fine but is not an array:
  // the same "corrupt is a miss" invariant as a parse failure.
  test("valid JSON that is not an array is a miss, not a crash", () => {
    const dir = repoCacheDir("k", tmpRoot());
    require("node:fs").mkdirSync(dir, { recursive: true });
    require("node:fs").writeFileSync(resolve(dir, "flaky.json"), "{}");
    expect(readFlaky(dir)).toEqual([]);
    // recordFlaky spreads readFlaky()'s result; it must not throw on the
    // same wrong-shape file, and must recover by overwriting it.
    recordFlaky(dir, ["x.test.ts"]);
    expect(readFlaky(dir)).toEqual(["x.test.ts"]);
  });
});

describe("failure signatures (top 3 for the implementer brief)", () => {
  test("empty by default", () => {
    expect(topFailures(repoCacheDir("k", tmpRoot()))).toEqual([]);
  });

  test("sums counts for the same signature across runs and ranks by total", () => {
    const dir = repoCacheDir("k", tmpRoot());
    recordFailures(dir, [{ signature: "sig-a", count: 1, sample: "run1" }]);
    recordFailures(dir, [
      { signature: "sig-a", count: 2, sample: "run2" },
      { signature: "sig-b", count: 5, sample: "run2" },
    ]);
    const top = topFailures(dir, 3);
    expect(top).toEqual([
      { signature: "sig-b", count: 5, sample: "run2" },
      { signature: "sig-a", count: 3, sample: "run2" },
    ]);
  });

  test("caps at n even with more distinct signatures", () => {
    const dir = repoCacheDir("k", tmpRoot());
    recordFailures(dir, [
      { signature: "a", count: 4, sample: "s" },
      { signature: "b", count: 3, sample: "s" },
      { signature: "c", count: 2, sample: "s" },
      { signature: "d", count: 1, sample: "s" },
    ]);
    expect(topFailures(dir, 3).map((f) => f.signature)).toEqual(["a", "b", "c"]);
  });

  test("a bad line is skipped, not fatal", () => {
    const dir = repoCacheDir("k", tmpRoot());
    recordFailures(dir, [{ signature: "a", count: 1, sample: "s" }]);
    require("node:fs").appendFileSync(join(dir, "failures.jsonl"), "not json\n");
    recordFailures(dir, [{ signature: "b", count: 1, sample: "s" }]);
    expect(topFailures(dir).map((f) => f.signature).sort()).toEqual(["a", "b"]);
  });

  // Lines that parse fine but are the wrong shape (null, a bare number, a
  // string, a record missing count, a record with a string count) must be
  // skipped exactly like unparseable text -- never a throw, never NaN
  // corrupting the sum for a signature that does have valid lines.
  test("valid JSON of the wrong shape is skipped, not fatal, and never poisons the sum", () => {
    const dir = repoCacheDir("k", tmpRoot());
    recordFailures(dir, [{ signature: "sig-a", count: 1, sample: "s1" }]);
    require("node:fs").appendFileSync(
      join(dir, "failures.jsonl"),
      [
        "null",
        "42",
        '"a string"',
        JSON.stringify({ signature: "sig-a", sample: "no-count" }),
        JSON.stringify({ signature: "sig-a", count: "3", sample: "string-count" }),
      ].join("\n") + "\n",
    );
    recordFailures(dir, [{ signature: "sig-a", count: 2, sample: "s2" }]);
    const top = topFailures(dir);
    expect(top).toEqual([{ signature: "sig-a", count: 3, sample: "s2" }]);
    expect(Number.isFinite(top[0]?.count)).toBe(true);
  });
});

describe("TEN-SPEED-04 tree-keyed reuse across fix rounds", () => {
  test("same tree: second round is a counted hit and does not rebuild; new tree rebuilds", () => {
    const dir = repoCacheDir("k", tmpRoot());
    cacheStats.hits = 0; cacheStats.misses = 0;
    let repoBuilds = 0, testBuilds = 0;
    const rb = () => { repoBuilds++; return REPOMAP; }, tb = () => { testBuilds++; return TESTMAP; };
    expect(cachedRepoMap(dir, "t1", rb)).toEqual(REPOMAP);
    expect(cachedTestMap(dir, "t1", tb)).toEqual(TESTMAP);
    expect(cachedRepoMap(dir, "t1", rb)).toEqual(REPOMAP);
    expect(cachedTestMap(dir, "t1", tb)).toEqual(TESTMAP);
    expect([repoBuilds, testBuilds, cacheStats.hits, cacheStats.misses]).toEqual([1, 1, 2, 2]);
    cachedRepoMap(dir, "t2", rb);
    expect([repoBuilds, cacheStats.misses]).toEqual([2, 3]);
  });

  test("a corrupt entry rebuilds and heals; an unwritable cache dir still returns the built map", () => {
    const dir = repoCacheDir("k", tmpRoot());
    writeRepoMapCache(dir, "t1", REPOMAP);
    require("node:fs").writeFileSync(resolve(dir, cacheFileName("repomap", "t1")), "42");
    expect(cachedRepoMap(dir, "t1", () => REPOMAP)).toEqual(REPOMAP);
    expect(readRepoMapCache(dir, "t1")).toEqual(REPOMAP);
    const file = join(tmpRoot(), "afile");
    require("node:fs").writeFileSync(file, "x");
    expect(cachedTestMap(join(file, "sub"), "t1", () => TESTMAP)).toEqual(TESTMAP);
  });
});

describe("cache pruning (TEN-STABILITY-45)", () => {
  test("prunes old trees: keeps newest 5 of each kind", () => {
    const dir = repoCacheDir("k", tmpRoot());
    for (let i = 0; i < 8; i++) {
      writeRepoMapCache(dir, `tree${i}`, REPOMAP);
      writeTestMapCache(dir, `tree${i}`, TESTMAP);
    }
    const files = readdirSync(dir);
    expect(files.filter((f) => f.startsWith("repomap-")).length).toBe(5);
    expect(files.filter((f) => f.startsWith("testmap-")).length).toBe(5);
    expect(readRepoMapCache(dir, "tree7")).not.toBeNull();
    expect(readTestMapCache(dir, "tree7")).not.toBeNull();
  });

  test("prune failure never throws", () => {
    const dir = repoCacheDir("k", tmpRoot());
    writeRepoMapCache(dir, "t1", REPOMAP);
    expect(() => pruneCache(join(dir, "missing"), "repomap-", join(dir, "x.json"))).not.toThrow();
  });
});

describe("slice journal (#283: sha256 of slice card plus base sha)", () => {
  const entry = { gid: "g1", n: 1, id: "u1", head: "a".repeat(40) };
  test("same card and base sha hit; a changed base sha or card misses", () => {
    const dir = tmpRoot();
    writeSliceJournal(dir, sliceKey("card-A", "base1"), entry);
    expect(readSliceJournal(dir, sliceKey("card-A", "base1"))).toEqual(entry);
    expect(readSliceJournal(dir, sliceKey("card-A", "base2"))).toBeNull();
    expect(readSliceJournal(dir, sliceKey("card-B", "base1"))).toBeNull();
  });
  test("the key is order-sensitive between card and base (no concatenation collision)", () => {
    expect(sliceKey("ab", "c")).not.toBe(sliceKey("a", "bc"));
  });
  test("a corrupt or wrong-shape entry is a miss", () => {
    const dir = tmpRoot(), k = sliceKey("c", "b");
    writeSliceJournal(dir, k, entry);
    writeFileSync(resolve(dir, `slice-${k}.json`), '{"gid":1}');
    expect(readSliceJournal(dir, k)).toBeNull();
  });
});

// #331 FC-ENGINE10-CACHE-KEY-NOT-PRODUCER-BOUND: the key covers the producer, and cache files are private and atomic.
describe("#331 producer-bound, private, atomic cache", () => {
  const SRC = resolve(import.meta.dir, "..", "..", "src");
  const FP_A = "a".repeat(64), FP_B = "b".repeat(64);

  test("changing one byte of a builder source changes the fingerprint", () => {
    const copy = join(tmpRoot(), "src");
    cpSync(SRC, copy, { recursive: true });
    expect(sourceFingerprint(copy)).toBe(sourceFingerprint(SRC));
    const builder = join(copy, "engine10", "repomap.ts");
    writeFileSync(builder, readFileSync(builder, "utf8") + " ");
    expect(sourceFingerprint(copy)).not.toBe(sourceFingerprint(SRC));
  });

  test("the default fingerprint is the hash of src and is stable in a process", () => {
    expect(producerFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(producerFingerprint()).toBe(sourceFingerprint(SRC));
  });

  test("a second build under a modified builder misses; the same builder hits", () => {
    const dir = repoCacheDir("k", tmpRoot());
    let builds = 0;
    const rb = () => { builds++; return REPOMAP; };
    cachedRepoMap(dir, "t1", rb, FP_A);
    cachedRepoMap(dir, "t1", rb, FP_A);
    expect(builds).toBe(1);
    cachedRepoMap(dir, "t1", rb, FP_B);
    expect(builds).toBe(2);
    let tbuilds = 0;
    const tb = () => { tbuilds++; return TESTMAP; };
    cachedTestMap(dir, "t1", tb, FP_A); cachedTestMap(dir, "t1", tb, FP_B);
    expect(tbuilds).toBe(2);
  });

  test("the key carries the fingerprint, with no hand-bumped version prefix", () => {
    const name = cacheFileName("repomap", "tree1", FP_A);
    expect(name).toBe(`repomap-${"a".repeat(16)}-tree1.json`);
    expect(name).not.toMatch(/repomap\d/);
    expect(cacheFileName("testmap", "tree1", FP_A)).not.toBe(cacheFileName("testmap", "tree1", FP_B));
  });

  test("dir is 0700 and files 0600, including when the dir pre-existed loose", () => {
    const dir = repoCacheDir("k", tmpRoot());
    mkdirSync(dir, { recursive: true, mode: 0o777 }); chmodSync(dir, 0o777);
    writeRepoMapCache(dir, "tree1", REPOMAP, FP_A);
    writeTestMapCache(dir, "tree1", TESTMAP, FP_A);
    writeSliceJournal(dir, "k1", { gid: "g", n: 1, id: "i", head: "h" });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
  });

  test("writes go through a temp file plus rename: none remains after success or failure", () => {
    const dir = repoCacheDir("k", tmpRoot());
    writeRepoMapCache(dir, "tree1", REPOMAP, FP_A);
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    const target = join(dir, cacheFileName("repomap", "tree1", FP_A)), ino = statSync(target).ino;
    writeRepoMapCache(dir, "tree1", REPOMAP, FP_A);
    expect(statSync(target).ino).not.toBe(ino); // replaced by rename, never rewritten in place
    mkdirSync(join(dir, cacheFileName("testmap", "tree2", FP_A))); // rename onto a directory fails
    expect(() => writeTestMapCache(dir, "tree2", TESTMAP, FP_A)).toThrow();
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
  });
});

describe("FC-ENGINE10-CACHE-KEY-NOT-PRODUCER-BOUND: unbound fallback and injected value", () => {
  const SRC_ROOT = resolve(import.meta.dir, "..", "..", "src");
  const probe = (): string => {
    const code = `import { computeProducerFingerprint } from ${JSON.stringify(resolve(SRC_ROOT, "util", "producer_fingerprint.ts"))}; process.stdout.write(computeProducerFingerprint(${JSON.stringify(join(SRC_ROOT, "no-such-dir"))}, undefined));`;
    const r = Bun.spawnSync([process.execPath, "-e", code], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    return r.stdout.toString();
  };
  test("when the source cannot be hashed, separate processes get different 64-hex keys and nothing crosses between them", () => {
    const a = probe(), b = probe();
    expect(a).toMatch(/^[0-9a-f]{64}$/); expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe("0".repeat(64)); expect(b).not.toBe("0".repeat(64));
    const dir = repoCacheDir("k", tmpRoot());
    writeRepoMapCache(dir, "treeX", REPOMAP, a);
    expect(readRepoMapCache(dir, "treeX", a)).not.toBeNull();
    expect(readRepoMapCache(dir, "treeX", b)).toBeNull();
  });
  test("a malformed injected value is ignored in favor of the source hash; a valid one wins", () => {
    const real = sourceFingerprint(SRC_ROOT);
    for (const bad of ["", "x", "g".repeat(64), "a".repeat(63), 42, null, undefined]) expect(computeProducerFingerprint(SRC_ROOT, bad)).toBe(real);
    expect(computeProducerFingerprint(SRC_ROOT, "b".repeat(64))).toBe("b".repeat(64));
  });
  test("writing a repomap removes legacy repomap2-* files", () => {
    const dir = repoCacheDir("k", tmpRoot());
    mkdirSync(dir, { recursive: true });
    for (const n of ["repomap2-old1.json", "repomap2-old2.json"]) writeFileSync(resolve(dir, n), "{}");
    writeRepoMapCache(dir, "treeY", REPOMAP, "c".repeat(64));
    expect(readdirSync(dir).filter((f) => f.startsWith("repomap2-"))).toEqual([]);
  });
});
