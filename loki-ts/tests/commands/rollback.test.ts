// v7.5.2 tests for `loki rollback` CLI command.
//
// Pre-v7.5.2 the checkpoint rollback API at loki-ts/src/runner/checkpoint.ts
// (rollbackToCheckpoint, executeRollback, listCheckpoints, readCheckpoint)
// was tested but had no user-visible CLI command. v7.5.2 wires
// loki-ts/src/commands/rollback.ts to provide list/show/to/latest.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runRollback } from "../../src/commands/rollback.ts";

let scratch = "";
let originalLokiDir: string | undefined;
let originalCwd: string;
let captured = { stdout: "", stderr: "" };
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

function captureOutput(): () => { stdout: string; stderr: string } {
  captured = { stdout: "", stderr: "" };
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown): boolean => {
    captured.stdout += String(c);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown): boolean => {
    captured.stderr += String(c);
    return true;
  }) as typeof process.stderr.write;
  return () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    return captured;
  };
}

function seedCheckpoint(id: string, iteration: number): void {
  // checkpointsRoot at loki-ts/src/runner/checkpoint.ts:99 is
  // join(base, "state", "checkpoints") -- NOT join(base, "checkpoints").
  const cpDir = join(scratch, "state", "checkpoints", id);
  mkdirSync(join(cpDir, "state"), { recursive: true });
  mkdirSync(join(cpDir, "queue"), { recursive: true });
  // Index entry
  const indexLine = JSON.stringify({
    id,
    ts: new Date().toISOString(),
    iter: iteration,
    task: "test-task",
    sha: "abc123",
  });
  const indexPath = join(scratch, "state", "checkpoints", "index.jsonl");
  const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf-8") : "";
  writeFileSync(indexPath, existing + indexLine + "\n");
  // Metadata.json
  const metadata = {
    id,
    timestamp: new Date().toISOString(),
    iteration,
    task_id: "test-task",
    task_description: "synthetic",
    git_sha: "abc1234567",
    git_branch: "main",
    provider: "claude",
    phase: "ACT",
  };
  writeFileSync(join(cpDir, "metadata.json"), JSON.stringify(metadata, null, 2));
  // Restore-eligible files
  writeFileSync(join(cpDir, "state", "orchestrator.json"), JSON.stringify({ from: id }));
  writeFileSync(join(cpDir, "queue", "pending.json"), JSON.stringify({ from: id }));
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalLokiDir = process.env["LOKI_DIR"];
  scratch = mkdtempSync(join(tmpdir(), "loki-rollback-cli-"));
  process.env["LOKI_DIR"] = scratch;
});

afterEach(() => {
  if (originalLokiDir === undefined) delete process.env["LOKI_DIR"];
  else process.env["LOKI_DIR"] = originalLokiDir;
  process.chdir(originalCwd);
  if (scratch && existsSync(scratch)) {
    rmSync(scratch, { recursive: true, force: true });
  }
});

describe("v7.5.2 loki rollback CLI", () => {
  it("`rollback help` prints usage and exits 0", async () => {
    const stop = captureOutput();
    const code = await runRollback(["help"]);
    const out = stop();
    expect(code).toBe(0);
    expect(out.stdout).toContain("Usage: loki rollback");
  });

  it("`rollback` (no args) prints usage and exits 1", async () => {
    const stop = captureOutput();
    const code = await runRollback([]);
    stop();
    expect(code).toBe(1);
  });

  it("`rollback list` reports no checkpoints when none exist", async () => {
    const stop = captureOutput();
    const code = await runRollback(["list"]);
    const out = stop();
    expect(code).toBe(0);
    expect(out.stdout).toContain("No checkpoints found");
  });

  it("`rollback list` shows seeded checkpoints", async () => {
    seedCheckpoint("cp-1-1700000001", 1);
    seedCheckpoint("cp-2-1700000002", 2);
    const stop = captureOutput();
    const code = await runRollback(["list"]);
    const out = stop();
    expect(code).toBe(0);
    expect(out.stdout).toContain("cp-1-1700000001");
    expect(out.stdout).toContain("cp-2-1700000002");
  });

  it("`rollback show <id>` prints metadata JSON for valid id", async () => {
    seedCheckpoint("cp-3-1700000003", 3);
    const stop = captureOutput();
    const code = await runRollback(["show", "cp-3-1700000003"]);
    const out = stop();
    expect(code).toBe(0);
    expect(out.stdout).toContain('"id": "cp-3-1700000003"');
    expect(out.stdout).toContain('"iteration": 3');
  });

  it("`rollback show` exits 2 on missing id", async () => {
    const stop = captureOutput();
    const code = await runRollback(["show"]);
    stop();
    expect(code).toBe(2);
  });

  it("`rollback to <id>` restores state files and exits 0", async () => {
    seedCheckpoint("cp-4-1700000004", 4);

    const stop = captureOutput();
    const code = await runRollback(["to", "cp-4-1700000004"]);
    const out = stop();
    if (code !== 0) {
      // Surface the failure detail to the test runner output.
      throw new Error(`rollback returned ${code}; stdout=${out.stdout}; stderr=${out.stderr}`);
    }
    expect(code).toBe(0);
    expect(out.stdout).toMatch(/Rolled back \d+\/\d+ state files/);
    // Files should now exist with the seeded content.
    expect(existsSync(join(scratch, "state", "orchestrator.json"))).toBe(true);
    const restored = JSON.parse(
      readFileSync(join(scratch, "state", "orchestrator.json"), "utf-8"),
    ) as { from: string };
    expect(restored.from).toBe("cp-4-1700000004");
  });

  it("`rollback latest` picks the newest checkpoint", async () => {
    seedCheckpoint("cp-5-1700000005", 5);
    seedCheckpoint("cp-99-1700000099", 99);
    const stop = captureOutput();
    const code = await runRollback(["latest"]);
    const out = stop();
    expect(code).toBe(0);
    expect(out.stdout).toContain("cp-99-1700000099");
  });

  it("`rollback latest` errors when no checkpoints exist", async () => {
    const stop = captureOutput();
    const code = await runRollback(["latest"]);
    stop();
    expect(code).toBe(1);
  });

  it("`rollback unknown-subcmd` exits 2", async () => {
    const stop = captureOutput();
    const code = await runRollback(["frobnicate"]);
    stop();
    expect(code).toBe(2);
  });
});
