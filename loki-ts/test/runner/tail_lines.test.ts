// RUN-25 iter 17 (Wave C #1/#3): tailLines reads only the last N lines from a
// file's tail (<=64KB), instead of readFileSync-ing the whole (unbounded,
// append-only) events.jsonl / test logs on every council completion check.
// Tests: (1) CORRECTNESS -- tailLines(path,n) equals the old
// readFileSync().split("\n").slice(-n) for files both under and over the tail
// window; (2) a micro-benchmark asserting the tail-read is meaningfully faster
// on a large file (the measurable win, honest: only bites once the file grows).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tailLines } from "../../src/runner/council.ts";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-tail-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fullReadTail(path: string, n: number): string[] {
  return readFileSync(path, "utf-8").split("\n").slice(-n);
}

describe("tailLines: correctness parity with full-read slice(-n)", () => {
  test("small file (fewer than n lines) returns all lines, same as full read", () => {
    const p = join(scratch, "small.log");
    writeFileSync(p, "a\nb\nc\n");
    expect(tailLines(p, 50)).toEqual(fullReadTail(p, 50));
  });

  test("file with more than n lines returns the last n, same as full read", () => {
    const p = join(scratch, "many.log");
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`);
    writeFileSync(p, lines.join("\n") + "\n");
    expect(tailLines(p, 30)).toEqual(fullReadTail(p, 30));
    expect(tailLines(p, 50)).toEqual(fullReadTail(p, 50));
  });

  test("LARGE file exceeding the 64KB tail window: last n lines still exact", () => {
    // ~2MB of ~150-byte lines. The tail window (64KB) holds ~400 lines, far more
    // than the 50 requested, so slice(-50) is byte-for-byte identical to a full
    // read's last 50 -- proving the window never truncates the answer.
    const p = join(scratch, "big.log");
    const pad = "x".repeat(140);
    const lines = Array.from({ length: 14000 }, (_, i) => `line-${i}-${pad}`);
    writeFileSync(p, lines.join("\n") + "\n");
    expect(tailLines(p, 50)).toEqual(fullReadTail(p, 50));
  });

  test("missing/unreadable file returns null (fail-soft)", () => {
    expect(tailLines(join(scratch, "nope.log"), 10)).toBeNull();
  });
});

describe("tailLines: measurable win (honest micro-benchmark)", () => {
  test("tail-read of a large file is faster than a full read + slice", () => {
    const p = join(scratch, "bench.log");
    const pad = "y".repeat(140);
    // ~15MB so the difference is unambiguous on any machine.
    const lines = Array.from({ length: 100000 }, (_, i) => `l-${i}-${pad}`);
    writeFileSync(p, lines.join("\n") + "\n");

    const iters = 20;
    let t0 = performance.now();
    for (let i = 0; i < iters; i++) fullReadTail(p, 50);
    const fullMs = performance.now() - t0;

    t0 = performance.now();
    for (let i = 0; i < iters; i++) tailLines(p, 50);
    const tailMs = performance.now() - t0;

    // Same answer.
    expect(tailLines(p, 50)).toEqual(fullReadTail(p, 50));
    // The win is real and large on a big file; assert a conservative floor (>=3x)
    // so the test is not flaky on a fast disk cache but still fails if the tail
    // path regresses to a full read. (Observed 30-210x; 3x is a safe CI floor.)
    // eslint-disable-next-line no-console
    console.log(`tailLines micro-bench: full=${fullMs.toFixed(1)}ms tail=${tailMs.toFixed(1)}ms (${(fullMs / Math.max(tailMs, 0.001)).toFixed(1)}x)`);
    expect(tailMs).toBeLessThan(fullMs / 3);
  });
});
