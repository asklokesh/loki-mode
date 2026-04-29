// Tests for src/runner/episode_bridge.ts
//
// Covers:
//   - _stubStoreEpisodeTraceForTests: deterministic stub return shape
//   - storeEpisodeTrace: short-circuits when <lokiDir>/memory does not exist
//
// Strategy: each test uses an isolated temp dir under tmpdir() and cleans up
// in afterEach. We deliberately do NOT exercise the real python3.12 + memory
// engine path -- that requires a vendored memory/ tree and chromadb deps,
// neither of which the unit-test environment is expected to provide.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _stubStoreEpisodeTraceForTests,
  storeEpisodeTrace,
} from "../../src/runner/episode_bridge.ts";

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "loki-episode-bridge-test-"));
});

afterEach(() => {
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("_stubStoreEpisodeTraceForTests", () => {
  it("returns {stored:true, reason:'stub'}", () => {
    const r = _stubStoreEpisodeTraceForTests(scratch, {
      taskId: "task-1",
      outcome: "success",
      phase: "ACT",
      goal: "do thing",
    });
    expect(r.stored).toBe(true);
    expect(r.reason).toBe("stub");
  });

  it("returns the same shape regardless of input", () => {
    const r = _stubStoreEpisodeTraceForTests("/no/such/path", {
      taskId: "",
      outcome: "failure",
      phase: "VERIFY",
      goal: "",
      durationSeconds: 99,
    });
    expect(r).toEqual({ stored: true, reason: "stub" });
  });
});

describe("storeEpisodeTrace", () => {
  it("returns {stored:false, reason:'memory dir not initialized'} when <lokiDir>/memory does not exist", async () => {
    // scratch is fresh -- no memory/ subdir.
    const r = await storeEpisodeTrace(scratch, {
      taskId: "learning-abcdef",
      outcome: "failure",
      phase: "VERIFY",
      goal: "test missing memory dir",
    });
    expect(r.stored).toBe(false);
    expect(r.reason).toBe("memory dir not initialized");
  });

  it("short-circuits without spawning a subprocess (fast path)", async () => {
    // Verify the no-memory-dir path returns immediately by timing it. Spawning
    // a real python subprocess would take >100ms; the early return is sub-ms.
    const start = Date.now();
    const r = await storeEpisodeTrace(scratch, {
      taskId: "t",
      outcome: "partial",
      phase: "REASON",
      goal: "g",
      durationSeconds: 0,
    });
    const elapsed = Date.now() - start;
    expect(r.stored).toBe(false);
    expect(r.reason).toBe("memory dir not initialized");
    // Generous bound: even on a busy CI machine the no-op path is well
    // under 50ms because no process is spawned.
    expect(elapsed).toBeLessThan(500);
  });
});
