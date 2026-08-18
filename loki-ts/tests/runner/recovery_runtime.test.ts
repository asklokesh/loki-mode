import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createCheckpoint } from "../../src/runner/checkpoint.ts";
import {
  checkpointedStateCorrupt,
  providerUnavailableFromThrow,
  rollbackLatestCheckpoint,
} from "../../src/runner/recovery_runtime.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const r = mkdtempSync(resolve(tmpdir(), "loki-recovery-runtime-"));
  roots.push(r);
  mkdirSync(resolve(r, "state"), { recursive: true });
  mkdirSync(resolve(r, "queue"), { recursive: true });
  return r;
}

describe("recovery runtime signals", () => {
  it("detects malformed checkpoint-restorable state but ignores absent files", () => {
    const r = root();
    expect(checkpointedStateCorrupt(r)).toBe(false);
    writeFileSync(resolve(r, "queue/current-task.json"), '{"ok":true}');
    expect(checkpointedStateCorrupt(r)).toBe(false);
    writeFileSync(resolve(r, "queue/current-task.json"), "{truncated");
    expect(checkpointedStateCorrupt(r)).toBe(true);
  });

  it("classifies only explicit provider outage throws", () => {
    expect(providerUnavailableFromThrow("connect ECONNREFUSED 127.0.0.1")).toBe(true);
    expect(providerUnavailableFromThrow("503 service unavailable")).toBe(true);
    expect(providerUnavailableFromThrow("test assertion failed")).toBe(false);
    expect(providerUnavailableFromThrow("unknown exception")).toBe(false);
  });

  it("restores the newest valid checkpoint with a pre-rollback safety snapshot", async () => {
    const r = root();
    const state = resolve(r, "queue/current-task.json");
    writeFileSync(state, '{"task":"known-good"}');
    const cp = await createCheckpoint({
      iteration: 1,
      taskId: "recovery-test",
      taskDescription: "restore a known-good checkpoint",
      forceCreate: true,
      lokiDirOverride: r,
    });
    expect(cp.created).toBe(true);
    if (!cp.created) throw new Error(`checkpoint creation failed: ${cp.reason}`);
    writeFileSync(state, "{truncated");

    const restored = await rollbackLatestCheckpoint(r);
    expect(restored.checkpointId).toBe(cp.id);
    expect(restored.preRollbackSnapshotId).not.toBeNull();
    expect(restored.restored).toBeGreaterThan(0);
    expect(checkpointedStateCorrupt(r)).toBe(false);
  });

  it("fails closed when no valid checkpoint exists", async () => {
    const r = root();
    await expect(rollbackLatestCheckpoint(r)).rejects.toThrow("no valid checkpoint");
  });
});
