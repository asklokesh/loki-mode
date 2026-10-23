import { setSpawnTimeout } from "../preload.ts";
setSpawnTimeout();
// Tests for src/runner/checkpoint.ts.
// Strategy: every test creates an isolated temp dir as the .loki override so
// nothing leaks into the real .loki/. The `forceCreate` opt bypasses the
// "no uncommitted changes" guard so tests do not depend on git state.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createCheckpoint,
  listCheckpoints,
  readCheckpoint,
  rollbackToCheckpoint,
  executeRollbackWithSnapshot,
  readIndex,
  rebuildIndex,
  CheckpointNotFoundError,
  InvalidCheckpointIdError,
} from "../../src/runner/checkpoint.ts";

let tmpBase = "";

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), "loki-cp-test-"));
});

afterEach(() => {
  if (tmpBase && existsSync(tmpBase)) {
    rmSync(tmpBase, { recursive: true, force: true });
  }
});

function seedOrchestrator(base: string, phase: string): void {
  const dir = join(base, "state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "orchestrator.json"), JSON.stringify({ currentPhase: phase }));
}

describe("createCheckpoint", () => {
  it("creates directory + metadata.json + appends to index.jsonl", async () => {
    seedOrchestrator(tmpBase, "BOOTSTRAP");
    const r = await createCheckpoint({
      taskDescription: "iteration-1 complete",
      taskId: "iteration-1",
      iteration: 1,
      provider: "claude",
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 1772895561,
    });
    expect(r.created).toBe(true);
    if (!r.created) throw new Error("unreachable");
    expect(r.id).toBe("cp-1-1772895561");

    // Directory + metadata.json present.
    const cpDir = join(tmpBase, "state", "checkpoints", "cp-1-1772895561");
    expect(existsSync(cpDir)).toBe(true);
    expect(existsSync(join(cpDir, "metadata.json"))).toBe(true);

    // Verify all 9 fields written.
    const m = JSON.parse(readFileSync(join(cpDir, "metadata.json"), "utf-8")) as Record<string, unknown>;
    expect(Object.keys(m).sort()).toEqual([
      "git_branch",
      "git_sha",
      "id",
      "iteration",
      "phase",
      "provider",
      "task_description",
      "task_id",
      "timestamp",
    ]);
    expect(m["id"]).toBe("cp-1-1772895561");
    expect(m["iteration"]).toBe(1);
    expect(m["task_id"]).toBe("iteration-1");
    expect(m["task_description"]).toBe("iteration-1 complete");
    expect(m["provider"]).toBe("claude");
    expect(m["phase"]).toBe("BOOTSTRAP");
    expect(typeof m["git_sha"]).toBe("string");
    expect(typeof m["git_branch"]).toBe("string");
    expect(typeof m["timestamp"]).toBe("string");

    // Index file should have one line.
    const indexPath = join(tmpBase, "state", "checkpoints", "index.jsonl");
    const lines = readFileSync(indexPath, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry["id"]).toBe("cp-1-1772895561");
    expect(entry["iter"]).toBe(1);
    expect(entry["task"]).toBe("iteration-1 complete");
    // Verify the 5-field summary schema and key order.
    expect(Object.keys(entry)).toEqual(["id", "ts", "iter", "task", "sha"]);
  });

  it("skips creation when there are no uncommitted changes (and not forced)", async () => {
    // forceCreate=false; the test runs in a clean working tree most of the
    // time, but we cannot rely on that. We can rely on the API contract: if
    // git probes report clean, the function returns {created:false}. Use a
    // throwaway temp git repo to guarantee a clean state.
    const repo = mkdtempSync(join(tmpdir(), "loki-cp-clean-"));
    try {
      const env = { cwd: repo };
      await Bun.spawn(["git", "init", "-q"], env).exited;
      await Bun.spawn(["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init", "-q"], env).exited;
      const prevCwd = process.cwd();
      process.chdir(repo);
      try {
        const r = await createCheckpoint({
          taskDescription: "noop",
          lokiDirOverride: tmpBase,
        });
        expect(r.created).toBe(false);
      } finally {
        process.chdir(prevCwd);
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("truncates task_description to 200 chars", async () => {
    const big = "x".repeat(500);
    const r = await createCheckpoint({
      taskDescription: big,
      iteration: 2,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 1000,
    });
    expect(r.created).toBe(true);
    if (!r.created) throw new Error("unreachable");
    expect(r.metadata.task_description.length).toBe(200);
  });

  it("copies state files into checkpoint directory when present", async () => {
    seedOrchestrator(tmpBase, "DEV");
    const queueDir = join(tmpBase, "queue");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, "pending.json"), `{"q":1}`);
    writeFileSync(join(tmpBase, "autonomy-state.json"), `{"a":2}`);

    const r = await createCheckpoint({
      taskDescription: "copy-test",
      iteration: 3,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 2000,
    });
    expect(r.created).toBe(true);
    if (!r.created) throw new Error("unreachable");

    expect(existsSync(join(r.dir, "state", "orchestrator.json"))).toBe(true);
    expect(existsSync(join(r.dir, "queue", "pending.json"))).toBe(true);
    expect(existsSync(join(r.dir, "autonomy-state.json"))).toBe(true);
  });

  // R6: CONTINUITY.md (iteration / conversation handoff context) is captured.
  it("captures CONTINUITY.md when present (R6 context undo)", async () => {
    seedOrchestrator(tmpBase, "DEV");
    writeFileSync(join(tmpBase, "CONTINUITY.md"), "# handoff\niteration 7\n");

    const r = await createCheckpoint({
      taskDescription: "continuity-test",
      iteration: 7,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 2100,
    });
    expect(r.created).toBe(true);
    if (!r.created) throw new Error("unreachable");
    expect(existsSync(join(r.dir, "CONTINUITY.md"))).toBe(true);
    expect(readFileSync(join(r.dir, "CONTINUITY.md"), "utf-8")).toContain("iteration 7");
  });
});

describe("R6: CONTINUITY round-trip + re-undoable restore", () => {
  it("rollback restores CONTINUITY.md to its checkpointed content", async () => {
    seedOrchestrator(tmpBase, "DEV");
    writeFileSync(join(tmpBase, "CONTINUITY.md"), "ORIGINAL CONTEXT\n");

    const r = await createCheckpoint({
      taskDescription: "rb-continuity",
      iteration: 1,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 3000,
    });
    expect(r.created).toBe(true);
    if (!r.created) throw new Error("unreachable");

    // Mutate current context (simulate an iteration that went wrong).
    writeFileSync(join(tmpBase, "CONTINUITY.md"), "MUTATED / BAD CONTEXT\n");

    const plan = rollbackToCheckpoint(r.id, tmpBase);
    // CONTINUITY.md must be in the restore plan.
    expect(plan.restore.some((e) => e.from.endsWith("CONTINUITY.md"))).toBe(true);
    const result = await executeRollbackWithSnapshot(plan, tmpBase);
    expect(result.errors).toEqual([]);
    // Restore actually reverted the file.
    expect(readFileSync(join(tmpBase, "CONTINUITY.md"), "utf-8")).toBe("ORIGINAL CONTEXT\n");
  });

  it("ABORTS (throws) and preserves current state when the pre-rollback snapshot fails and force is not set", async () => {
    seedOrchestrator(tmpBase, "DEV");
    writeFileSync(join(tmpBase, "CONTINUITY.md"), "ORIGINAL CONTEXT\n");

    const r = await createCheckpoint({
      taskDescription: "rb-abort",
      iteration: 1,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 3200,
    });
    expect(r.created).toBe(true);
    if (!r.created) throw new Error("unreachable");

    // Mutate current context (simulate a bad iteration the user wants to undo).
    writeFileSync(join(tmpBase, "CONTINUITY.md"), "MUTATED / BAD CONTEXT\n");
    const plan = rollbackToCheckpoint(r.id, tmpBase);

    // Force the pre-rollback snapshot to fail: make the checkpoints root
    // read-only so createCheckpoint cannot mkdir the new snapshot dir.
    // CONTINUITY.md lives at the project root (writable), so if the destructive
    // executeRollback were to (incorrectly) run, it WOULD revert CONTINUITY.md.
    const cpRoot = join(tmpBase, "state", "checkpoints");
    chmodSync(cpRoot, 0o500);
    try {
      await expect(executeRollbackWithSnapshot(plan, tmpBase)).rejects.toThrow(
        /pre-rollback snapshot failed/,
      );
    } finally {
      chmodSync(cpRoot, 0o700);
    }

    // State preserved: the destructive restore did NOT run, so the mutated
    // file is untouched (NOT reverted to the checkpointed content).
    expect(readFileSync(join(tmpBase, "CONTINUITY.md"), "utf-8")).toBe(
      "MUTATED / BAD CONTEXT\n",
    );
  });

  it("with force=true proceeds (warns) and still restores even if the pre-rollback snapshot fails", async () => {
    seedOrchestrator(tmpBase, "DEV");
    writeFileSync(join(tmpBase, "CONTINUITY.md"), "ORIGINAL CONTEXT\n");

    const r = await createCheckpoint({
      taskDescription: "rb-force",
      iteration: 1,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 3300,
    });
    expect(r.created).toBe(true);
    if (!r.created) throw new Error("unreachable");

    writeFileSync(join(tmpBase, "CONTINUITY.md"), "MUTATED / BAD CONTEXT\n");
    const plan = rollbackToCheckpoint(r.id, tmpBase);

    const cpRoot = join(tmpBase, "state", "checkpoints");
    chmodSync(cpRoot, 0o500);
    try {
      const result = await executeRollbackWithSnapshot(plan, tmpBase, true);
      // No safety snapshot was captured, but the restore still ran.
      expect(result.preRollbackSnapshotId).toBeNull();
      expect(result.errors).toEqual([]);
    } finally {
      chmodSync(cpRoot, 0o700);
    }

    // Restore actually reverted the file despite the failed snapshot.
    expect(readFileSync(join(tmpBase, "CONTINUITY.md"), "utf-8")).toBe(
      "ORIGINAL CONTEXT\n",
    );
  });

  it("executeRollbackWithSnapshot creates a forced pre-rollback snapshot", async () => {
    seedOrchestrator(tmpBase, "DEV");
    const r = await createCheckpoint({
      taskDescription: "rb-snap",
      iteration: 1,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 3100,
    });
    expect(r.created).toBe(true);
    if (!r.created) throw new Error("unreachable");

    const beforeIds = listCheckpoints(tmpBase).map((c) => c.id);
    const plan = rollbackToCheckpoint(r.id, tmpBase);
    const result = await executeRollbackWithSnapshot(plan, tmpBase);
    // A new pre-rollback snapshot id was produced and exists on disk.
    const snapId = result.preRollbackSnapshotId;
    expect(snapId).toBeTruthy();
    if (snapId === null) throw new Error("unreachable: snapshot id was null");
    const afterIds = listCheckpoints(tmpBase).map((c) => c.id);
    expect(afterIds.length).toBeGreaterThan(beforeIds.length);
    expect(afterIds).toContain(snapId);
  });
});

describe("listCheckpoints + readCheckpoint", () => {
  it("round-trips: list returns what was created, read returns metadata", async () => {
    await createCheckpoint({
      taskDescription: "first",
      iteration: 1,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 100,
    });
    await createCheckpoint({
      taskDescription: "second",
      iteration: 2,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 200,
    });

    const list = listCheckpoints(tmpBase);
    expect(list.length).toBe(2);
    // Sorted by epoch ascending.
    expect(list[0]?.id).toBe("cp-1-100");
    expect(list[1]?.id).toBe("cp-2-200");

    const m = readCheckpoint("cp-2-200", tmpBase);
    expect(m.task_description).toBe("second");
    expect(m.iteration).toBe(2);
  });

  it("corrupt metadata warns", async () => {
    for (const [i, e] of [[1, 100], [2, 200], [3, 300]] as const) {
      await createCheckpoint({
        taskDescription: `t${i}`,
        iteration: i,
        lokiDirOverride: tmpBase,
        forceCreate: true,
        epochOverride: e,
      });
    }
    writeFileSync(join(tmpBase, "state", "checkpoints", "cp-2-200", "metadata.json"), "{not json");
    const writes: string[] = [];
    const orig = process.stderr.write;
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      writes.push(String(s));
      return true;
    };
    let list: ReturnType<typeof listCheckpoints>;
    try {
      list = listCheckpoints(tmpBase);
    } finally {
      process.stderr.write = orig;
    }
    expect(list.map((c) => c.id)).toEqual(["cp-1-100", "cp-3-300"]);
    const warns = writes.filter((w) => w.includes("[checkpoint] skipped"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("cp-2-200");
  });

  it("readCheckpoint throws CheckpointNotFoundError for missing id", () => {
    expect(() => readCheckpoint("cp-99-99", tmpBase)).toThrow(CheckpointNotFoundError);
  });

  it("readCheckpoint throws InvalidCheckpointIdError for path-traversal id", () => {
    expect(() => readCheckpoint("../etc/passwd", tmpBase)).toThrow(InvalidCheckpointIdError);
    expect(() => readCheckpoint("foo bar", tmpBase)).toThrow(InvalidCheckpointIdError);
  });
});

describe("naming convention parsing (cp-{iter}-{epoch})", () => {
  it("sorts checkpoints by epoch, not iteration", async () => {
    // Iteration order does not match epoch order; verify epoch wins.
    await createCheckpoint({
      taskDescription: "high-iter-low-epoch",
      iteration: 9,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 50,
    });
    await createCheckpoint({
      taskDescription: "low-iter-high-epoch",
      iteration: 1,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 500,
    });
    const list = listCheckpoints(tmpBase);
    expect(list.map((c) => c.id)).toEqual(["cp-9-50", "cp-1-500"]);
  });
});

describe("index.jsonl append correctness", () => {
  it("appends one line per checkpoint and matches metadata", async () => {
    for (let i = 1; i <= 5; i += 1) {
      await createCheckpoint({
        taskDescription: `task-${i}`,
        iteration: i,
        lokiDirOverride: tmpBase,
        forceCreate: true,
        epochOverride: 1000 + i,
      });
    }
    const idx = readIndex(tmpBase);
    expect(idx.length).toBe(5);
    expect(idx[0]?.id).toBe("cp-1-1001");
    expect(idx[4]?.id).toBe("cp-5-1005");
    for (const e of idx) {
      expect(e.task.startsWith("task-")).toBe(true);
      expect(typeof e.sha).toBe("string");
      expect(typeof e.ts).toBe("string");
    }
  });

  it("concurrent createCheckpoint calls do not corrupt the index", async () => {
    const N = 10;
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < N; i += 1) {
      ops.push(
        createCheckpoint({
          taskDescription: `concurrent-${i}`,
          iteration: i,
          lokiDirOverride: tmpBase,
          forceCreate: true,
          epochOverride: 5000 + i,
        }),
      );
    }
    await Promise.all(ops);

    const idx = readIndex(tmpBase);
    expect(idx.length).toBe(N);

    const ids = new Set(idx.map((e) => e.id));
    expect(ids.size).toBe(N); // no duplicates, no missing entries

    // Every index entry must correspond to an on-disk metadata.json.
    for (const e of idx) {
      const m = readCheckpoint(e.id, tmpBase);
      expect(m.id).toBe(e.id);
      expect(m.iteration).toBe(e.iter);
    }
  });
});

describe("rollbackToCheckpoint", () => {
  it("returns a restore plan referencing files that exist in the checkpoint", async () => {
    seedOrchestrator(tmpBase, "DEV");
    const queueDir = join(tmpBase, "queue");
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, "pending.json"), `{"q":1}`);

    const r = await createCheckpoint({
      taskDescription: "rb",
      iteration: 1,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 9000,
    });
    expect(r.created).toBe(true);
    if (!r.created) throw new Error("unreachable");

    const plan = rollbackToCheckpoint(r.id, tmpBase);
    expect(plan.id).toBe(r.id);
    expect(plan.metadata.id).toBe(r.id);
    // We seeded 2 of the 5 restorable files; expect 2 entries.
    expect(plan.restore.length).toBe(2);
    for (const entry of plan.restore) {
      expect(existsSync(entry.from)).toBe(true);
      // `to` should live under .loki/ (tmpBase).
      expect(entry.to.startsWith(tmpBase)).toBe(true);
    }
  });

  it("throws CheckpointNotFoundError for missing id", () => {
    expect(() => rollbackToCheckpoint("cp-1-1", tmpBase)).toThrow(CheckpointNotFoundError);
  });

  it("throws InvalidCheckpointIdError for invalid id", () => {
    expect(() => rollbackToCheckpoint("../bad", tmpBase)).toThrow(InvalidCheckpointIdError);
  });
});

describe("v7.5.8: control-char rejection + structured drop events", () => {
  it("rejects metadata where `id` contains a NUL byte (returns null + warns)", async () => {
    // Capture console.warn so we can assert the breadcrumb fires.
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      const r = await createCheckpoint({
        taskDescription: "ctrl-char-test",
        iteration: 1,
        lokiDirOverride: tmpBase,
        forceCreate: true,
        epochOverride: 4242,
      });
      expect(r.created).toBe(true);
      if (!r.created) throw new Error("unreachable");

      // Inject a NUL byte into the `id` field on disk.
      const metaPath = join(r.dir, "metadata.json");
      writeFileSync(
        metaPath,
        JSON.stringify({
          id: `${r.id}\x00evil`,
          timestamp: "2026-04-29T00:00:00Z",
          iteration: 1,
          task_id: "x",
          task_description: "x",
          git_sha: "abc",
          git_branch: "main",
          provider: "claude",
          phase: "DEV",
        }),
      );

      // listCheckpoints must skip; readCheckpoint must surface as not-found.
      const list = listCheckpoints(tmpBase);
      expect(list.length).toBe(0);
      expect(() => readCheckpoint(r.id, tmpBase)).toThrow(CheckpointNotFoundError);
      // Warning must have fired and named the offending field.
      expect(warnings.some((w) => w.includes("control characters") && w.includes('"id"'))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  it("rebuildIndex emits a structured event to .loki/events.jsonl on drop", async () => {
    // Seed two checkpoints, then corrupt one (CR/LF in git_sha).
    const r1 = await createCheckpoint({
      taskDescription: "good",
      iteration: 1,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 6001,
    });
    const r2 = await createCheckpoint({
      taskDescription: "bad",
      iteration: 2,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 6002,
    });
    expect(r1.created && r2.created).toBe(true);
    if (!r1.created || !r2.created) throw new Error("unreachable");

    const badMeta = join(r2.dir, "metadata.json");
    writeFileSync(
      badMeta,
      JSON.stringify({
        id: r2.id,
        timestamp: "2026-04-29T00:00:00Z",
        iteration: 2,
        task_id: "x",
        task_description: "x",
        git_sha: "abc\r\ndef", // control chars
        git_branch: "main",
        provider: "claude",
        phase: "DEV",
      }),
    );

    // Trigger rebuildIndex directly (test seam export).
    rebuildIndex(tmpBase);

    const eventsPath = join(tmpBase, "events.jsonl");
    expect(existsSync(eventsPath)).toBe(true);
    const lines = readFileSync(eventsPath, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const drop = parsed.find(
      (e) => e["type"] === "checkpoint.metadata.dropped" && e["field"] === "git_sha",
    );
    expect(drop).toBeDefined();
    expect(drop?.["reason"]).toBe("control_chars");
    expect(typeof drop?.["timestamp"]).toBe("string");
    expect(typeof drop?.["checkpoint_dir"]).toBe("string");
    expect((drop?.["checkpoint_dir"] as string).includes(r2.id)).toBe(true);

    // Index must contain only the good checkpoint.
    const idx = readIndex(tmpBase);
    expect(idx.length).toBe(1);
    expect(idx[0]?.id).toBe(r1.id);
  });
});

describe("v7.5.7: metadata validation + index lock", () => {
  it("readCheckpoint/listCheckpoints reject metadata missing required fields", async () => {
    // First, create a valid checkpoint so the cp-* directory exists.
    const r = await createCheckpoint({
      taskDescription: "valid",
      iteration: 1,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 7000,
    });
    expect(r.created).toBe(true);
    if (!r.created) throw new Error("unreachable");

    // Corrupt the metadata.json: drop required `git_sha` and break `iteration` type.
    const metaPath = join(r.dir, "metadata.json");
    writeFileSync(
      metaPath,
      JSON.stringify({
        id: r.id,
        timestamp: "2026-04-29T00:00:00Z",
        iteration: "not-a-number",
        task_id: "x",
        task_description: "x",
        // git_sha missing entirely
        git_branch: "main",
        provider: "claude",
        phase: "DEV",
      }),
    );

    // listCheckpoints must skip the invalid entry rather than returning bad data.
    const list = listCheckpoints(tmpBase);
    expect(list.length).toBe(0);

    // readCheckpoint must surface the invalid entry as not-found
    // (validateCheckpointMetadata returns null, readCheckpointSafe -> null,
    // which the public readCheckpoint converts to CheckpointNotFoundError).
    expect(() => readCheckpoint(r.id, tmpBase)).toThrow(CheckpointNotFoundError);
  });

  it("creates the index lock sentinel without breaking checkpoint dir scans", async () => {
    await createCheckpoint({
      taskDescription: "lock-sentinel-test",
      iteration: 1,
      lokiDirOverride: tmpBase,
      forceCreate: true,
      epochOverride: 8001,
    });
    const cpRoot = join(tmpBase, "state", "checkpoints");
    // The `.lock` sentinel should have been cleaned up after the append
    // (withFileLockSync removes it in finally). Either way, the directory
    // listing must contain only cp-* entries that listCheckpointDirs
    // recognizes.
    const list = listCheckpoints(tmpBase);
    expect(list.length).toBe(1);
    // Even if the sentinel transiently appeared, anything not starting with
    // "cp-" must be filtered out by listCheckpointDirs.
    const onDisk = readdirSync(cpRoot);
    const cpOnly = onDisk.filter((n) => n.startsWith("cp-"));
    expect(cpOnly.length).toBe(1);
    // index.jsonl.lock must not still be held after the call returns.
    expect(existsSync(join(cpRoot, "index.jsonl.lock"))).toBe(false);
  });
});
