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

  test("times out cleanly when external holder never releases", () => {
    const dir = newDir();
    const target = join(dir, "counter.json");
    writeFileSync(target, "{}");
    writeFileSync(`${target}.lock`, `${process.pid}\n`);
    expect(() =>
      withFileLockSync(target, () => 1, { timeoutMs: 200, pollMs: 20, staleMs: 60_000 }),
    ).toThrow(/timed out/);
    expect(existsSync(`${target}.lock`)).toBe(true);
  });
});

// v7.5.6 (council R4 #1): refuse a symlinked sentinel so a malicious
// local user with write access to the lock dir cannot plant a symlink
// to make the lock look stale and steal it (or coerce reads of an
// unrelated file).
describe("withFileLock -- symlink sentinel rejection", () => {
  test("removes a symlinked sentinel and proceeds", async () => {
    const dir = newDir();
    const target = join(dir, "counter.json");
    writeFileSync(target, "{}");
    const real = join(dir, "decoy.txt");
    writeFileSync(real, "not a pid");
    const fs = await import("node:fs");
    fs.symlinkSync(real, `${target}.lock`);
    await withFileLock(target, () => {}, { staleMs: 1, timeoutMs: 1_000 });
    expect(existsSync(`${target}.lock`)).toBe(false);
    // Decoy untouched: rmSync of a symlink removes only the link, not
    // the target.
    expect(existsSync(real)).toBe(true);
  });
});
