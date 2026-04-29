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
import { withFileLock } from "../../src/util/atomic.ts";
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

interface QueueEntry {
  id: string;
  title: string;
  description: string;
  status: string;
  source: string;
}

function readQueue(): QueueEntry[] {
  return JSON.parse(readFileSync(join(lokiDir, "queue", "pending.json"), "utf8")) as QueueEntry[];
}

describe("populateBmadQueue", () => {
  it("populates one task per .md file in .loki/bmad/", async () => {
    const bmadDir = join(lokiDir, "bmad");
    mkdirSync(bmadDir, { recursive: true });
    writeFileSync(join(bmadDir, "a.md"), "# Story Alpha\n\nFirst story body line.\n");
    writeFileSync(join(bmadDir, "b.md"), "# Story Beta\n\nSecond story body line.\n");
    const ctx = makeCtx(undefined);

    await populateBmadQueue(ctx);

    const tasks = readQueue();
    expect(tasks.length).toBe(2);
    expect(tasks[0]?.id).toBe("bmad-001");
    expect(tasks[1]?.id).toBe("bmad-002");
    expect(tasks.map((t) => t.title)).toEqual(["Story Alpha", "Story Beta"]);
    expect(tasks.every((t) => t.source === "bmad")).toBe(true);
    expect(tasks.every((t) => t.status === "pending")).toBe(true);
    expect(existsSync(join(lokiDir, "queue", ".bmad-populated"))).toBe(true);
    // No leftover atomic-write tmp files.
    expect(existsSync(join(lokiDir, "queue", `pending.json.tmp.${process.pid}`))).toBe(false);
  });

  it("splits multi-story files on ## headings", async () => {
    const bmadDir = join(lokiDir, "bmad");
    mkdirSync(bmadDir, { recursive: true });
    writeFileSync(
      join(bmadDir, "epic.md"),
      "# Epic\n\n## First Story\n\nFirst description.\n\n## Second Story\n\nSecond description.\n",
    );
    const ctx = makeCtx(undefined);

    await populateBmadQueue(ctx);

    const tasks = readQueue();
    expect(tasks.length).toBe(2);
    expect(tasks.map((t) => t.title)).toEqual(["First Story", "Second Story"]);
  });

  it("respects the .bmad-populated sentinel on a second call", async () => {
    const bmadDir = join(lokiDir, "bmad");
    mkdirSync(bmadDir, { recursive: true });
    writeFileSync(join(bmadDir, "a.md"), "# Story Alpha\n");
    const ctx = makeCtx(undefined);

    await populateBmadQueue(ctx);
    const firstSize = readQueue().length;

    // Add a second story after the first run -- sentinel must block re-scan.
    writeFileSync(join(bmadDir, "b.md"), "# Story Beta\n");
    await populateBmadQueue(ctx);

    expect(readQueue().length).toBe(firstSize);
  });

  it("merges with existing pending.json (preserves prior tasks)", async () => {
    const queueDir = join(lokiDir, "queue");
    mkdirSync(queueDir, { recursive: true });
    const seed: QueueEntry = {
      id: "prd-001",
      title: "Existing PRD task",
      description: "Existing PRD task",
      status: "pending",
      source: "prd",
    };
    writeFileSync(join(queueDir, "pending.json"), JSON.stringify([seed]));

    const bmadDir = join(lokiDir, "bmad");
    mkdirSync(bmadDir, { recursive: true });
    writeFileSync(join(bmadDir, "a.md"), "# Story Alpha\n");
    const ctx = makeCtx(undefined);

    await populateBmadQueue(ctx);

    const tasks = readQueue();
    expect(tasks.length).toBe(2);
    expect(tasks[0]?.id).toBe("prd-001");
    expect(tasks[1]?.id).toBe("bmad-001");
    expect(tasks[1]?.title).toBe("Story Alpha");
  });

  it("is a no-op when .loki/bmad/ is missing or empty", async () => {
    const ctx = makeCtx(undefined);
    await populateBmadQueue(ctx);
    expect(existsSync(join(lokiDir, "queue", "pending.json"))).toBe(false);
    expect(existsSync(join(lokiDir, "queue", ".bmad-populated"))).toBe(false);

    // Empty directory should also be a no-op.
    mkdirSync(join(lokiDir, "bmad"), { recursive: true });
    await populateBmadQueue(ctx);
    expect(existsSync(join(lokiDir, "queue", "pending.json"))).toBe(false);
    expect(existsSync(join(lokiDir, "queue", ".bmad-populated"))).toBe(false);
  });
});

describe("populateOpenspecQueue", () => {
  it("populates one task per spec-*.md file in .loki/openspec/", async () => {
    const specDir = join(lokiDir, "openspec");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec-001-auth.md"), "# Auth Spec\n\nDetails.\n");
    writeFileSync(join(specDir, "spec-002-payments.md"), "# Payments Spec\n\nDetails.\n");
    // Non-spec markdown must be ignored.
    writeFileSync(join(specDir, "README.md"), "# Readme\n");
    const ctx = makeCtx(undefined);

    await populateOpenspecQueue(ctx);

    const tasks = readQueue();
    expect(tasks.length).toBe(2);
    expect(tasks.map((t) => t.id)).toEqual(["openspec-001", "openspec-002"]);
    expect(tasks.map((t) => t.title)).toEqual(["Auth Spec", "Payments Spec"]);
    expect(tasks.every((t) => t.source === "openspec")).toBe(true);
    expect(tasks[0]?.description).toBe("[OpenSpec] Auth Spec");
    expect(existsSync(join(lokiDir, "queue", ".openspec-populated"))).toBe(true);
  });

  it("respects the .openspec-populated sentinel on a second call", async () => {
    const specDir = join(lokiDir, "openspec");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec-001-auth.md"), "# Auth Spec\n");
    const ctx = makeCtx(undefined);

    await populateOpenspecQueue(ctx);
    const firstSize = readQueue().length;

    writeFileSync(join(specDir, "spec-002-payments.md"), "# Payments Spec\n");
    await populateOpenspecQueue(ctx);

    expect(readQueue().length).toBe(firstSize);
  });

  it("is a no-op when .loki/openspec/ is missing or empty", async () => {
    const ctx = makeCtx(undefined);
    await populateOpenspecQueue(ctx);
    expect(existsSync(join(lokiDir, "queue", "pending.json"))).toBe(false);
    expect(existsSync(join(lokiDir, "queue", ".openspec-populated"))).toBe(false);

    mkdirSync(join(lokiDir, "openspec"), { recursive: true });
    await populateOpenspecQueue(ctx);
    expect(existsSync(join(lokiDir, "queue", "pending.json"))).toBe(false);
    expect(existsSync(join(lokiDir, "queue", ".openspec-populated"))).toBe(false);
  });
});

describe("populateMirofishQueue", () => {
  it("is a no-op when .loki/mirofish-tasks.json is missing", async () => {
    const ctx = makeCtx(undefined);
    await populateMirofishQueue(ctx);
    expect(existsSync(join(lokiDir, "queue", "pending.json"))).toBe(false);
    expect(existsSync(join(lokiDir, "queue", ".mirofish-populated"))).toBe(false);
  });

  it("converts advisories into queue entries with source=mirofish", async () => {
    writeFileSync(
      join(lokiDir, "mirofish-tasks.json"),
      JSON.stringify([
        { id: "mf-001", title: "Validate ICP segment", description: "talk to 5 design partners", priority: "high", category: "discovery" },
        { title: "Build landing page", description: "static, conversion-tracked" },
        { id: "mf-003", title: "Pricing experiment", priority: "low" },
      ]),
    );
    const ctx = makeCtx(undefined);
    await populateMirofishQueue(ctx);
    const tasks = JSON.parse(readFileSync(join(lokiDir, "queue", "pending.json"), "utf8")) as Array<{
      id: string; title: string; source: string; priority: string; status: string; category?: string;
    }>;
    expect(tasks.length).toBe(3);
    expect(tasks[0]?.id).toBe("mf-001");
    expect(tasks[0]?.source).toBe("mirofish");
    expect(tasks[0]?.priority).toBe("high");
    expect(tasks[0]?.status).toBe("pending");
    expect(tasks[0]?.category).toBe("discovery");
    // Auto-generated id when none supplied.
    expect(tasks[1]?.id).toBe("mirofish-002");
    expect(tasks[1]?.priority).toBe("medium");
    // Sentinel must exist so re-runs are no-ops.
    expect(existsSync(join(lokiDir, "queue", ".mirofish-populated"))).toBe(true);
  });

  it("dedupes by id when sentinel is removed and called again", async () => {
    writeFileSync(
      join(lokiDir, "mirofish-tasks.json"),
      JSON.stringify([{ id: "mf-001", title: "First task" }]),
    );
    const ctx = makeCtx(undefined);
    await populateMirofishQueue(ctx);
    rmSync(join(lokiDir, "queue", ".mirofish-populated"));
    await populateMirofishQueue(ctx);
    const tasks = JSON.parse(readFileSync(join(lokiDir, "queue", "pending.json"), "utf8")) as Array<{ id: string }>;
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.id).toBe("mf-001");
  });

  it("merges with existing pending.json without overwriting earlier tasks", async () => {
    mkdirSync(join(lokiDir, "queue"), { recursive: true });
    writeFileSync(
      join(lokiDir, "queue", "pending.json"),
      JSON.stringify([{ id: "prd-001", title: "earlier", description: "", priority: "high", status: "pending", source: "prd" }]),
    );
    writeFileSync(
      join(lokiDir, "mirofish-tasks.json"),
      JSON.stringify([{ id: "mf-007", title: "advisory" }]),
    );
    const ctx = makeCtx(undefined);
    await populateMirofishQueue(ctx);
    const tasks = JSON.parse(readFileSync(join(lokiDir, "queue", "pending.json"), "utf8")) as Array<{ id: string; source: string }>;
    expect(tasks.length).toBe(2);
    expect(tasks[0]?.id).toBe("prd-001");
    expect(tasks[0]?.source).toBe("prd");
    expect(tasks[1]?.id).toBe("mf-007");
    expect(tasks[1]?.source).toBe("mirofish");
  });
});

// v7.5.7: cross-process / cross-async race regression. Two parallel
// populatePrdQueue calls (e.g. from two worktrees executing
// `loki internal phase1-hooks` simultaneously) must not lose tasks via
// the read-modify-write race. The withFileLock wrapper in queues.ts
// serializes the sentinel-check + read + modify + write + sentinel-write
// sequence on the pending.json path so one writer wins cleanly and the
// second observes the sentinel and yields.
describe("populate* concurrency (race regression)", () => {
  it("two concurrent populatePrdQueue calls produce a single populated pending.json with no lost tasks", async () => {
    const prdPath = join(tmp, "PRD.md");
    writeFileSync(prdPath, SAMPLE_PRD);
    const ctx = makeCtx(prdPath);

    // Promise.all to maximise interleaving. Without the lock both would
    // pass the sentinel check, both would read the empty baseline, and
    // both would write back -- the second write would clobber the first.
    // With the lock, the loser sees the sentinel inside the lock and is
    // a clean no-op.
    const results = await Promise.all([
      populatePrdQueue(ctx),
      populatePrdQueue(ctx),
    ]);
    expect(results.length).toBe(2);

    const pendingPath = join(lokiDir, "queue", "pending.json");
    expect(existsSync(pendingPath)).toBe(true);
    const tasks = JSON.parse(readFileSync(pendingPath, "utf8")) as Array<{
      id: string;
      title: string;
      source: string;
    }>;
    // Exactly the 3 features from SAMPLE_PRD must be present, with no
    // duplicates and no lost increments.
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBe(3);
    const ids = tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toEqual(["prd-001", "prd-002", "prd-003"]);
    expect(tasks.every((t) => t.source === "prd")).toBe(true);
    // Sentinel exists and no leftover lock or tmp files.
    expect(existsSync(join(lokiDir, "queue", ".prd-populated"))).toBe(true);
    expect(existsSync(`${pendingPath}.lock`)).toBe(false);
    expect(existsSync(`${pendingPath}.tmp.${process.pid}`)).toBe(false);
  });

  it("populatePrdQueue waits for an externally-held lock on pending.json (proves cross-process serialization)", async () => {
    const prdPath = join(tmp, "PRD.md");
    writeFileSync(prdPath, SAMPLE_PRD);
    const ctx = makeCtx(prdPath);
    const queueDir = join(lokiDir, "queue");
    mkdirSync(queueDir, { recursive: true });
    const pendingPath = join(queueDir, "pending.json");

    // Hold the lock externally and concurrently try to populate. The
    // populate call must block until we release. This proves the
    // populate path actually serializes on the pending.json lock.
    let released = false;
    const externalHolder = withFileLock(
      pendingPath,
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            released = true;
            resolve();
          }, 80);
        }),
    );

    // Tiny delay so the external holder is the first to acquire.
    await new Promise((r) => setTimeout(r, 10));

    const populateP = populatePrdQueue(ctx).then(() => {
      // populate must observe `released === true` -- if it ran without
      // waiting, this would be false.
      expect(released).toBe(true);
    });

    await Promise.all([externalHolder, populateP]);

    const tasks = JSON.parse(readFileSync(pendingPath, "utf8")) as Array<{ id: string }>;
    expect(tasks.length).toBe(3);
    expect(existsSync(`${pendingPath}.lock`)).toBe(false);
  });

  it("populatePrdQueue + populateBmadQueue racing on the same pending.json do not lose tasks", async () => {
    const prdPath = join(tmp, "PRD.md");
    writeFileSync(prdPath, SAMPLE_PRD);
    const bmadDir = join(lokiDir, "bmad");
    mkdirSync(bmadDir, { recursive: true });
    writeFileSync(join(bmadDir, "story.md"), "# Story Alpha\n\nFirst story body.\n");

    const ctx = makeCtx(prdPath);

    // Both queues populate against the same pending.json. The PRD path
    // also yields-on-bmad-sentinel and vice versa, so the final state
    // depends on which wins -- but the union of guarantees is: no
    // partial / clobbered writes, no leftover lock, valid JSON.
    await Promise.all([populatePrdQueue(ctx), populateBmadQueue(ctx)]);

    const pendingPath = join(lokiDir, "queue", "pending.json");
    expect(existsSync(pendingPath)).toBe(true);
    const raw = readFileSync(pendingPath, "utf8");
    const tasks = JSON.parse(raw) as Array<{ id: string; source: string }>;
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeGreaterThan(0);
    // Every entry must be valid (no half-written records).
    for (const t of tasks) {
      expect(typeof t.id).toBe("string");
      expect(t.source === "prd" || t.source === "bmad").toBe(true);
    }
    // Lock file must not leak.
    expect(existsSync(`${pendingPath}.lock`)).toBe(false);
  });
});
