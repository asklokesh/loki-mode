// select: not-src-walker (tmp dir only)
// Multi-process concurrency tests for atomicWriteFileSync.
//
// Verifies that the O_EXCL|O_CREAT advisory lockfile in
// src/runner/state.ts:atomicWriteFileSync prevents torn writes when multiple
// loki processes target the same file. Each child Bun process independently
// imports state.ts and races on the same target -- the post-condition is that
// the surviving file content equals exactly one of the candidate payloads,
// never a partial/interleaved mix.
//
// Why this exists: Phase 4 surfaced that two loki processes (e.g. a `loki
// start` and a `loki status` writer) could both call atomicWriteFileSync on
// .loki/state/orchestrator.json. Without flock the rename steps can race
// and one writer's tmp file can be observed mid-flight by the other.
//
// Pattern parity: autonomy/run.sh:11729-11748 uses bash flock with
// O_EXCL semantics on the same lock-then-modify-then-release flow.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/runner/state.ts";

let tmp: string;
let dir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loki-state-concurrency-"));
  dir = join(tmp, ".loki");
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("atomicWriteFileSync: multi-process flock safety", () => {
  it(
    "10 concurrent child Bun writers leave the file matching exactly one payload",
    async () => {
      const target = join(dir, "concurrent.json");

      // Worker script: each child imports state.ts, takes a payload from argv,
      // then calls atomicWriteFileSync. The script lives in tmp so it inherits
      // the same node_modules resolution (we use the absolute path to the
      // module file under the repo).
      const stateModulePath = join(import.meta.dir, "..", "..", "src", "runner", "state.ts");
      const workerPath = join(tmp, "worker.ts");
      writeFileSync(
        workerPath,
        [
          `import { atomicWriteFileSync } from "${stateModulePath}";`,
          `const target = process.argv[2];`,
          `const payload = process.argv[3];`,
          // Tiny jitter to maximize the contention window.
          `await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 5)));`,
          `atomicWriteFileSync(target, payload);`,
        ].join("\n"),
      );

      // Build 10 distinct payloads. Each one is a complete JSON document so
      // a torn write would surface as a JSON.parse failure.
      const payloads: string[] = [];
      for (let i = 0; i < 10; i++) {
        payloads.push(JSON.stringify({ writer: i, value: `payload-${i}-${"x".repeat(50)}` }));
      }

      // Spawn all 10 in parallel.
      const procs = payloads.map((p) =>
        Bun.spawn({
          cmd: ["bun", workerPath, target, p],
          stdout: "pipe",
          stderr: "pipe",
        }),
      );

      const exitCodes = await Promise.all(procs.map((p) => p.exited));
      // Capture stderr for diagnostics on failure.
      const stderrs = await Promise.all(
        procs.map((p) => new Response(p.stderr).text()),
      );

      for (let i = 0; i < exitCodes.length; i++) {
        expect(exitCodes[i], `worker ${i} stderr: ${stderrs[i]}`).toBe(0);
      }

      // Target must exist and parse as JSON.
      expect(existsSync(target)).toBe(true);
      const finalContent = readFileSync(target, "utf8");
      expect(() => JSON.parse(finalContent)).not.toThrow();

      // Final content must equal exactly one of the 10 payloads (no torn
      // write, no truncation, no interleaving).
      expect(payloads).toContain(finalContent);

      // No leftover tmp files (every winner's tmp got renamed; every loser
      // never wrote because its rename is gated by the lock release).
      const leftoverTmp = readdirSync(dir).filter((n) => n.includes(".tmp."));
      expect(leftoverTmp).toEqual([]);

      // No leftover lockfile (every writer released in finally{}).
      const leftoverLocks = readdirSync(dir).filter((n) => n.endsWith(".lock"));
      expect(leftoverLocks).toEqual([]);
    },
    // Bun spawn + 10 children + a few ms jitter each -- 30s is generous.
    30_000,
  );
});

describe("atomicWriteFileSync: stale lockfile recovery", () => {
  it("steals a lockfile whose mtime is > 120s in the past and writes successfully", () => {
    const target = join(dir, "stale.json");
    const lockPath = `${target}.lock`;

    // Pre-create a lockfile as if a previous loki process crashed mid-write.
    writeFileSync(lockPath, "");
    // Backdate by 200s -- comfortably above the 120s LOCK_TTL_MS in state.ts
    // (raised from 30s in v7.4.7 per W2-R3 HIGH).
    const ageSec = (Date.now() - 200 * 1000) / 1000;
    utimesSync(lockPath, ageSec, ageSec);
    expect(existsSync(lockPath)).toBe(true);

    const payload = '{"recovered":"after-stale-lock"}';
    atomicWriteFileSync(target, payload);

    // Write succeeded.
    expect(readFileSync(target, "utf8")).toBe(payload);
    // Lockfile is released after the write (ours, not the stolen one).
    expect(existsSync(lockPath)).toBe(false);
  });
});
