// TEN-QUALITY-31: a non-numeric LOKI_E10_SNAPSHOT_MAX must fall back to the 50MB default, not disable the size cap.
import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotUntracked } from "../../src/e10ext/preexisting_dirty.ts";

const dirs: string[] = [];
const saved = process.env.LOKI_E10_SNAPSHOT_MAX;
afterAll(() => {
  if (saved === undefined) delete process.env.LOKI_E10_SNAPSHOT_MAX; else process.env.LOKI_E10_SNAPSHOT_MAX = saved;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repoWithFile(bytes: number): string {
  const repo = mkdtempSync(join(tmpdir(), "snapmax-")); dirs.push(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "big.bin"), Buffer.alloc(bytes, 1));
  return repo;
}

const skipped = (repo: string): boolean => snapshotUntracked(repo)["big.bin"]!.startsWith("!");

describe("snapshotUntracked size cap", () => {
  test("numeric cap skips a file over it", () => {
    process.env.LOKI_E10_SNAPSHOT_MAX = "10";
    expect(skipped(repoWithFile(100))).toBe(true);
  });
  test("bad snapshot max falls back to the 50MB default (small file is hashed)", () => {
    const repo = repoWithFile(100);
    for (const bad of ["abc", "", "-5", "0", "Infinity", "NaN"]) {
      process.env.LOKI_E10_SNAPSHOT_MAX = bad;
      expect(skipped(repo)).toBe(false);
    }
  });
  test("bad snapshot max still skips a file over the 50MB default", () => {
    process.env.LOKI_E10_SNAPSHOT_MAX = "abc";
    expect(skipped(repoWithFile(50e6 + 1))).toBe(true);
  });
});
