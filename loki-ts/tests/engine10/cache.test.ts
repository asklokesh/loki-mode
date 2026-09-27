import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readFlaky,
  readRepoMapCache,
  readTestMapCache,
  recordFailures,
  recordFlaky,
  repoCacheDir,
  repoKey,
  topFailures,
  writeRepoMapCache,
  writeTestMapCache,
} from "../../src/engine10/cache.ts";
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

  test("a corrupt cache file is a miss, not a crash", () => {
    const dir = repoCacheDir("k", tmpRoot());
    writeRepoMapCache(dir, "tree1", REPOMAP);
    require("node:fs").writeFileSync(resolve(dir, "repomap-tree1.json"), "{not json");
    expect(readRepoMapCache(dir, "tree1")).toBeNull();
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
});
