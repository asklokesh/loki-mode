// loki-ts/tests/engine10/wall.test.ts
//
// E-15 wall check (docs/v10/ENGINE.md sections 4 and 16). Depends on
// machine.ts/intake.ts/session.ts only through the RunContext/SessionRunner
// interfaces in types.ts, so every sibling here is a fake.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWallBrief,
  runWall,
  wallStage,
  type BaseTestRunner,
} from "../../src/engine10/stages/wall.ts";
import type {
  RunContext,
  SessionResult,
  SessionRunOptions,
  SessionRunner,
  StageName,
} from "../../src/engine10/types.ts";

const FIX = join(import.meta.dir, "fixtures", "wall");
const SAMPLE = readFileSync(join(FIX, "loki_wall_sample.test.ts"), "utf8");

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

class FakeSessionRunner implements SessionRunner {
  lastOpts: SessionRunOptions | null = null;
  constructor(private onRun?: (opts: SessionRunOptions) => void) {}
  async run(opts: SessionRunOptions): Promise<SessionResult> {
    this.lastOpts = opts;
    this.onRun?.(opts);
    return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false };
  }
}

class FakeBaseTestRunner implements BaseTestRunner {
  calls: unknown[] = [];
  constructor(private result: { pass: number; fail: number }) {}
  run(repoDir: string, files: unknown): { pass: number; fail: number } {
    this.calls.push(files);
    return this.result;
  }
}

/** Real repoDir/runDir on disk (wall.ts does real file I/O); everything else
 *  the machine/session/testmap would own is faked. */
function setup(testmap: { runners: string[]; tests: { runner: string; path: string }[] }) {
  const repoDir = mkdtempSync(join(tmpdir(), "loki-e15-repo-"));
  const runDir = join(repoDir, ".loki", "runs", "e10-test-1");
  mkdirSync(runDir, { recursive: true });
  const repomapRef = join(runDir, "repomap.json");
  writeFileSync(
    repomapRef,
    JSON.stringify({ files: ["src/a.ts"], entries: [{ path: "src/a.ts", symbols: ["foo"] }], truncated: false }),
    "utf8",
  );
  return { repoDir, runDir, repomapRef, testmap };
}

function fakeCtx(
  repoDir: string,
  runDir: string,
  sessions: SessionRunner,
  outputs: Partial<Record<StageName, Record<string, unknown>>>,
  events: string[],
): RunContext {
  return {
    runId: "e10-test-1",
    repoDir,
    runDir,
    baseSha: "deadbeef",
    branch: "loki/e10-test-1",
    provider: "claude",
    model: "claude-test",
    deep: false,
    capS: 900,
    emit: (type, stage) => {
      events.push(`${type}:${stage}`);
    },
    sessions,
    tests: {
      async detect() {
        return { runners: [], tests: [] };
      },
      impacted() {
        return [];
      },
    },
    cost: {
      read() {
        return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      },
    },
    clock: { now: () => 0 },
    outputs: () => outputs,
  };
}

describe("engine10 wall brief", () => {
  test("tells the session it cannot see the repo and names the loki_wall_ prefix", () => {
    const brief = buildWallBrief("add a search bar");
    expect(brief).toContain("add a search bar");
    expect(brief.toLowerCase()).toContain("cannot see the repository");
    expect(brief).toContain("loki_wall_");
  });
});

describe("engine10 wall stage", () => {
  test("the session cwd holds only task.md and repomap.txt: never the repo", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    let seenCwdListing: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      seenCwdListing = readdirSync(opts.cwd!).sort();
    });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    await wallStage.run(ctx, new AbortController().signal);

    expect(seenCwdListing).toEqual(["repomap.txt", "task.md"]);
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("seals the generated files (sha256) and emits wall.sealed before implement's session starts", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
    });
    const baseRunner = new FakeBaseTestRunner({ pass: 1, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });
    // Simulate the machine moving on to Implement's session once Wall (and Plan) complete.
    ctx.emit("session.started", "implement", {});

    expect(result.status).toBe("completed");
    const files = result.data.files as { path: string; sha256: string }[];
    expect(files).toHaveLength(1);
    expect(files[0]!.sha256).toBe(sha256(SAMPLE));
    expect(readFileSync(files[0]!.path, "utf8")).toBe(SAMPLE);
    expect(events.indexOf("wall.sealed:wall")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("wall.sealed:wall")).toBeLessThan(events.indexOf("session.started:implement"));

    rmSync(repoDir, { recursive: true, force: true });
  });

  test("all Wall tests passing on the base tree short-circuits to already_satisfied", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
    });
    const baseRunner = new FakeBaseTestRunner({ pass: 1, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    expect(result.data.already_satisfied).toBe(true);
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("a base-tree failure never short-circuits", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
    });
    const baseRunner = new FakeBaseTestRunner({ pass: 0, fail: 1 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    expect(result.data.already_satisfied).toBe(false);
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("no generated files: empty seal, never already_satisfied, and the base runner is not asked to run", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner(); // writes nothing
    const baseRunner = new FakeBaseTestRunner({ pass: 99, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    expect(result.data.files).toEqual([]);
    expect(result.data.already_satisfied).toBe(false);
    expect(baseRunner.calls).toHaveLength(0);
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("briefs the author with intake's task (E-42: intake outputs it), never an env fallback", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    let seenTaskMd = "";
    const sessions = new FakeSessionRunner((opts) => {
      seenTaskMd = readFileSync(join(opts.cwd!, "task.md"), "utf8");
    });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add a search bar", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, []);
    const prevEnv = process.env.LOKI_E10_TASK_TEXT;
    process.env.LOKI_E10_TASK_TEXT = "not this";
    try {
      const r = await wallStage.run(ctx, new AbortController().signal);
      expect(r.data.iteration_ids).toEqual([`${ctx.runId}-wall`]);
    } finally {
      if (prevEnv === undefined) delete process.env.LOKI_E10_TASK_TEXT;
      else process.env.LOKI_E10_TASK_TEXT = prevEnv;
    }
    expect(seenTaskMd).toBe("add a search bar");
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("a sealed file whose runner cannot be guessed never counts toward already_satisfied, even if every executed test passes", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: [], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      // .py always resolves to pytest regardless of the detected runners;
      // the second file's extension matches no runner and none of
      // vitest/jest/bun are detected, so guessRunner() returns null for it.
      writeFileSync(join(opts.cwd!, "loki_wall_a.py"), "def test_a(): assert True", "utf8");
      writeFileSync(join(opts.cwd!, "loki_wall_b.rb"), "# unselectable", "utf8");
    });
    // Only the one selectable (pytest) file is ever handed to the runner,
    // and it "passes" - the old bug reported already_satisfied: true here.
    const baseRunner = new FakeBaseTestRunner({ pass: 1, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    expect((result.data.files as unknown[]).length).toBe(2); // both sealed
    expect(baseRunner.calls[0]).toHaveLength(1); // only one ever executed
    expect(result.data.already_satisfied).toBe(false);
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("places generated files alongside an existing detected test file, not tests/", async () => {
    const { repoDir, runDir, testmap: tm } = setup({
      runners: ["vitest"],
      tests: [{ runner: "vitest", path: "src/foo.test.ts" }],
    });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
    });
    const baseRunner = new FakeBaseTestRunner({ pass: 1, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    const files = result.data.files as { path: string }[];
    expect(files[0]!.path).toBe(join(repoDir, "src", "loki_wall_sample.test.ts"));
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("readOnlyFiles carries {path, content} for implement.ts to enforce", async () => {
    const { repoDir, runDir, testmap: tm } = setup({ runners: ["vitest"], tests: [] });
    const events: string[] = [];
    const sessions = new FakeSessionRunner((opts) => {
      writeFileSync(join(opts.cwd!, "loki_wall_sample.test.ts"), SAMPLE, "utf8");
    });
    const baseRunner = new FakeBaseTestRunner({ pass: 1, fail: 0 });
    const ctx = fakeCtx(repoDir, runDir, sessions, { intake: { task: "add x", testmap: tm, repomap_ref: join(runDir, "repomap.json") } }, events);

    const result = await runWall(ctx, new AbortController().signal, { baseRunner });

    const readOnly = result.data.readOnlyFiles as { path: string; content: string }[];
    expect(readOnly).toHaveLength(1);
    expect(readOnly[0]!.content).toBe(SAMPLE);
    rmSync(repoDir, { recursive: true, force: true });
  });
});
