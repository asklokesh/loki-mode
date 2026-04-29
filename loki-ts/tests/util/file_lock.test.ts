// Cross-process advisory file lock unit tests (#201).
//
// withFileLock / withFileLockSync use O_CREAT|O_EXCL on a `<target>.lock`
// sentinel to coordinate read-modify-write sequences across processes.
// These tests cover same-process serialization, stale-lock reaping, and
// timeout semantics. Multi-process behavior is exercised end-to-end by the
// trackGateFailure call sites in quality_gates.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, withFileLockSync } from "../../src/util/atomic.ts";

function newDir(): string {
  return mkdtempSync(join(tmpdir(), "loki-flock-"));
}

describe("withFileLock", () => {
  test("serializes concurrent async increments without loss", async () => {
    const dir = newDir();
    const target = join(dir, "counter.json");
    writeFileSync(target, JSON.stringify({ n: 0 }));
    const inc = () =>
      withFileLock(target, async () => {
        const cur = JSON.parse(readFileSync(target, "utf-8")) as { n: number };
        await new Promise((r) => setTimeout(r, 5));
        cur.n += 1;
        writeFileSync(target, JSON.stringify(cur));
      });
    await Promise.all(Array.from({ length: 25 }, () => inc()));
    const final = JSON.parse(readFileSync(target, "utf-8")) as { n: number };
    expect(final.n).toBe(25);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("removes lock sentinel even when fn throws", async () => {
    const dir = newDir();
    const target = join(dir, "counter.json");
    writeFileSync(target, "{}");
    await expect(
      withFileLock(target, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("times out when an external holder never releases", async () => {
    const dir = newDir();
    const target = join(dir, "counter.json");
    writeFileSync(target, "{}");
    // Simulate an external holder by writing a sentinel with our own pid
    // (which IS alive) so the stale-reaper refuses to take it over.
    writeFileSync(`${target}.lock`, `${process.pid}\n`);
    await expect(
      withFileLock(target, () => {}, { timeoutMs: 200, pollMs: 20, staleMs: 60_000 }),
    ).rejects.toThrow(/timed out/);
    // External holder's sentinel should be untouched.
    expect(existsSync(`${target}.lock`)).toBe(true);
  });

  test("reaps a stale lock whose pid is gone", async () => {
    const dir = newDir();
    const target = join(dir, "counter.json");
    writeFileSync(target, "{}");
    // pid 0 is never a real process; force it stale by predating mtime.
    writeFileSync(`${target}.lock`, "0\n");
    const past = (Date.now() - 60_000) / 1000;
    const fs = await import("node:fs");
    fs.utimesSync(`${target}.lock`, past, past);
    await withFileLock(target, () => {}, { staleMs: 1, timeoutMs: 1_000 });
    expect(existsSync(`${target}.lock`)).toBe(false);
  });
});

describe("withFileLockSync", () => {
  test("acquires + releases on the happy path", () => {
    const dir = newDir();
    const target = join(dir, "counter.json");
    writeFileSync(target, JSON.stringify({ n: 0 }));
    const out = withFileLockSync(target, () => {
      const cur = JSON.parse(readFileSync(target, "utf-8")) as { n: number };
      cur.n += 1;
      writeFileSync(target, JSON.stringify(cur));
      return cur.n;
    });
    expect(out).toBe(1);
    expect(existsSync(`${target}.lock`)).toBe(false);
  });

  test("removes sentinel even when fn throws", () => {
    const dir = newDir();
    const target = join(dir, "counter.json");
    writeFileSync(target, "{}");
    expect(() =>
      withFileLockSync(target, () => {
        throw new Error("sync-boom");
      }),
    ).toThrow("sync-boom");
    expect(existsSync(`${target}.lock`)).toBe(false);
  });
});
