// Tests for src/runner/queues.ts.
// Source-of-truth: autonomy/run.sh:9817-10162 (populate_prd_queue) and
// the BMAD/OpenSpec/MiroFish stubs at lines 9390/9619/9730.

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  populatePrdQueue,
  populateBmadQueue,
  populateOpenspecQueue,
  populateMirofishQueue,
} from "../../src/runner/queues.ts";
import type { RunnerContext } from "../../src/runner/types.ts";

let tmp: string;
let lokiDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "loki-queues-test-"));
  lokiDir = join(tmp, ".loki");
  mkdirSync(lokiDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeCtx(prdPath?: string): RunnerContext {
  return {
    cwd: tmp,
    lokiDir,
    prdPath,
    provider: "claude",
    maxRetries: 5,
    maxIterations: 100,
    baseWaitSeconds: 30,
    maxWaitSeconds: 3600,
    autonomyMode: "checkpoint",
    sessionModel: "sonnet",
    budgetLimit: undefined,
    completionPromise: undefined,
    iterationCount: 0,
    retryCount: 0,
    currentTier: "development",
    log: () => {},
  };
}

const SAMPLE_PRD = `# Sample Project

## Overview
This is meta and should be skipped.

## Core Features
- Build the alpha widget pipeline
- Implement beta authentication flow
- Wire up gamma reporting dashboard

## Tech Stack
This is also meta.
- node 20
- bun 1.3
`;

describe("populatePrdQueue", () => {
  it("extracts tasks from a markdown PRD and writes pending.json atomically", async () => {
    const prdPath = join(tmp, "PRD.md");
    writeFileSync(prdPath, SAMPLE_PRD);
    const ctx = makeCtx(prdPath);

    await populatePrdQueue(ctx);

    const pendingPath = join(lokiDir, "queue", "pending.json");
    expect(existsSync(pendingPath)).toBe(true);
    const tasks = JSON.parse(readFileSync(pendingPath, "utf8")) as Array<{
      id: string;
      title: string;
      source: string;
      status: string;
      priority: string;
    }>;
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(tasks[0]?.id).toBe("prd-001");
    expect(tasks[0]?.source).toBe("prd");
    expect(tasks[0]?.status).toBe("pending");
    expect(tasks.map((t) => t.title)).toContain("Build the alpha widget pipeline");
    expect(tasks.map((t) => t.title)).toContain("Implement beta authentication flow");
    // Tech-stack bullets must be skipped because the section is meta.
    expect(tasks.map((t) => t.title)).not.toContain("node 20");
    // Sentinel file must exist so subsequent calls are no-ops.
    expect(existsSync(join(lokiDir, "queue", ".prd-populated"))).toBe(true);
    // No leftover atomic-write tmp files.
    expect(existsSync(`${pendingPath}.tmp.${process.pid}`)).toBe(false);
  });

  it("is a no-op when prdPath is missing", async () => {
    const ctx = makeCtx(undefined);
    await populatePrdQueue(ctx);
    expect(existsSync(join(lokiDir, "queue", "pending.json"))).toBe(false);
  });

  it("is a no-op when the .prd-populated sentinel already exists", async () => {
    const prdPath = join(tmp, "PRD.md");
    writeFileSync(prdPath, SAMPLE_PRD);
    mkdirSync(join(lokiDir, "queue"), { recursive: true });
    writeFileSync(join(lokiDir, "queue", ".prd-populated"), "");
    const ctx = makeCtx(prdPath);

    await populatePrdQueue(ctx);
    expect(existsSync(join(lokiDir, "queue", "pending.json"))).toBe(false);
  });

  it("yields when an adapter populator (e.g. openspec) already ran", async () => {
    const prdPath = join(tmp, "PRD.md");
    writeFileSync(prdPath, SAMPLE_PRD);
    mkdirSync(join(lokiDir, "queue"), { recursive: true });
    writeFileSync(join(lokiDir, "queue", ".openspec-populated"), "");
    const ctx = makeCtx(prdPath);

    await populatePrdQueue(ctx);
    expect(existsSync(join(lokiDir, "queue", "pending.json"))).toBe(false);
  });
});

describe("populateBmadQueue / populateOpenspecQueue / populateMirofishQueue (Phase 5 stubs)", () => {
  it("each stub returns without throwing and writes nothing", async () => {
    const ctx = makeCtx(undefined);
    await populateBmadQueue(ctx);
    await populateOpenspecQueue(ctx);
    await populateMirofishQueue(ctx);
    // Stubs must be side-effect free.
    expect(existsSync(join(lokiDir, "queue", "pending.json"))).toBe(false);
  });
});
