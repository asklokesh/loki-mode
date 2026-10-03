// loki-ts/tests/engine10/implement.test.ts
//
// E-08 wall check (docs/v10/ENGINE.md section 16). Depends on E-05/E-07 only
// through the TestMapProvider/SessionRunner interfaces in types.ts, so every
// sibling here is a fake.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMachine } from "../../src/engine10/machine.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import {
  buildImplementBrief,
  implementStage,
  type ReadOnlyFile,
} from "../../src/engine10/stages/implement.ts";
import type {
  RunContext,
  SessionResult,
  SessionRunOptions,
  SessionRunner,
  StageName,
} from "../../src/engine10/types.ts";

const FIX = join(import.meta.dir, "fixtures", "implement");

class FakeSessionRunner implements SessionRunner {
  lastOpts: SessionRunOptions | null = null;
  constructor(
    private result: SessionResult,
    private onRun?: (opts: SessionRunOptions) => void,
  ) {}
  async run(opts: SessionRunOptions): Promise<SessionResult> {
    this.lastOpts = opts;
    this.onRun?.(opts);
    return this.result;
  }
}

function fakeCtx(
  sessions: SessionRunner,
  outputs: Partial<Record<StageName, Record<string, unknown>>>,
  runDir = "/tmp/does-not-matter/.loki/runs/e10-test-1",
): RunContext {
  return {
    runId: "e10-test-1",
    repoDir: "/tmp/does-not-matter",
    runDir,
    baseSha: "deadbeef",
    branch: "loki/e10-test-1",
    provider: "claude",
    model: "claude-test",
    deep: false,
    capS: 900,
    emit: () => {},
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

const doneResult: SessionResult = {
  exit: 0,
  markers: { done: true, alreadyDone: null, specConflict: null },
  durationS: 1.2,
  killed: false,
};

describe("engine10 implement brief", () => {
  test("allows the full suite (FC-19), forbids kills and docs; requires the exit markers", () => {
    const brief = buildImplementBrief("fix the bug", "1. patch X", ["tests/x.test.ts"]);
    expect(brief).toContain("fix the bug");
    expect(brief).toContain("1. patch X");
    expect(brief).toContain("tests/x.test.ts");
    expect(brief.toLowerCase()).toContain("read-only");
    expect(brief.toLowerCase()).not.toContain("never run the full");
    expect(brief.toLowerCase()).toContain("never kill");
    expect(brief.toLowerCase()).toContain("no documentation");
    expect(brief).toContain("LOKI_DONE");
    expect(brief).toContain("LOKI_ALREADY_DONE");
    expect(brief).toContain("LOKI_SPEC_CONFLICT");
  });
});

describe("engine10 implement stage", () => {
  test("restores an existing test file the session edited, and lists it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e08-"));
    const target = join(dir, "existing.test.ts");
    copyFileSync(join(FIX, "existing.test.ts"), target);
    const baseContent = readFileSync(target, "utf8");
    const readOnly: ReadOnlyFile[] = [{ path: target, content: baseContent }];

    const sessions = new FakeSessionRunner(doneResult, () => {
      // Simulate the provider session editing a file it was told is read-only.
      writeFileSync(target, "test(\"tampered\", () => { expect(true).toBe(false); });\n", "utf8");
    });
    const ctx = fakeCtx(sessions, {
      intake: { task: "fix the bug", impacted_tests: ["tests/x.test.ts"] },
      wall: { readOnlyFiles: readOnly },
    });

    const result = await implementStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.tests_reverted).toEqual([target]);
    expect(readFileSync(target, "utf8")).toBe(baseContent);
    expect(result.data.exit).toBe("done");

    rmSync(dir, { recursive: true, force: true });
  });

  test("leaves an untouched read-only file out of tests_reverted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e08-"));
    const target = join(dir, "existing.test.ts");
    copyFileSync(join(FIX, "existing.test.ts"), target);
    const baseContent = readFileSync(target, "utf8");
    const readOnly: ReadOnlyFile[] = [{ path: target, content: baseContent }];

    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(sessions, { wall: { readOnlyFiles: readOnly } });

    const result = await implementStage.run(ctx, new AbortController().signal);

    expect(result.data.tests_reverted).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("parses LOKI_SPEC_CONFLICT into exit spec_conflict", async () => {
    const sessions = new FakeSessionRunner({
      exit: 0,
      markers: { done: false, alreadyDone: null, specConflict: "the task contradicts the Wall tests" },
      durationS: 2,
      killed: false,
    });
    const ctx = fakeCtx(sessions, {});

    const result = await implementStage.run(ctx, new AbortController().signal);

    expect(result.data.exit).toBe("spec_conflict");
    expect(result.data.spec_conflict_reason).toBe("the task contradicts the Wall tests");
  });

  test("parses LOKI_ALREADY_DONE into exit already_done", async () => {
    const sessions = new FakeSessionRunner({
      exit: 0,
      markers: { done: false, alreadyDone: "src/foo.ts:42 already handles this", specConflict: null },
      durationS: 2,
      killed: false,
    });
    const ctx = fakeCtx(sessions, {});

    const result = await implementStage.run(ctx, new AbortController().signal);

    expect(result.data.exit).toBe("already_done");
    expect(result.data.already_done_evidence).toBe("src/foo.ts:42 already handles this");
  });

  test("a killed session exits killed", async () => {
    const sessions = new FakeSessionRunner({
      exit: null,
      markers: { done: false, alreadyDone: null, specConflict: null },
      durationS: 480,
      killed: true,
    });
    const ctx = fakeCtx(sessions, {});

    const result = await implementStage.run(ctx, new AbortController().signal);

    expect(result.data.exit).toBe("killed");
  });

  test("E-61: a non-killed error exit fails the stage and writes the stderr tail under runDir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e08-rd-"));
    const sessions = new FakeSessionRunner({
      exit: 1,
      markers: { done: false, alreadyDone: null, specConflict: null },
      durationS: 1,
      killed: false,
      stderrTail: "boom: provider crashed",
    } as SessionResult);
    const ctx = fakeCtx(sessions, {}, dir);

    const result = await implementStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("failed");
    expect(result.data.exit).toBe("error");
    expect(typeof result.data.stderr_path).toBe("string");
    const stderrPath = result.data.stderr_path as string;
    expect(stderrPath.startsWith(dir)).toBe(true);
    expect(readFileSync(stderrPath, "utf8")).toBe("boom: provider crashed");
    expect(result.reason).toBe("exit 1 (general error)");

    rmSync(dir, { recursive: true, force: true });
  });

  test("E-61: an error exit is never reported done, even with nothing on stderr (the false-green incident)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e08-rd2-"));
    // No stderrTail at all: an error exit must still fail, even with nothing captured.
    const sessions = new FakeSessionRunner({
      exit: 1,
      markers: { done: false, alreadyDone: null, specConflict: null },
      durationS: 1,
      killed: false,
    } as SessionResult);
    const ctx = fakeCtx(sessions, {}, dir);

    const result = await implementStage.run(ctx, new AbortController().signal);

    expect(result.data.exit).not.toBe("done");
    expect(result.status).not.toBe("completed");

    rmSync(dir, { recursive: true, force: true });
  });

  test("E-61: the real session -> machine path emits stage.failed with a readable stderr_path (the literal card check)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e08-e2e-"));
    const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
    const ctx: RunContext = {
      runId: "e10-e61", repoDir: dir, runDir: dir, baseSha: "deadbeef", branch: "loki/e10-e61",
      provider: "claude", model: "claude-test", deep: false, capS: 900,
      emit: (type, stage, data) => { events.push({ type, stage, data }); },
      sessions: createSessionRunner({
        provider: "claude",
        childCommand: ["bash", ["-c", "echo boom >&2; exit 1"]],
      }),
      tests: { async detect() { return { runners: [], tests: [] }; }, impacted: () => [] },
      cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
      clock: { now: () => Date.now() },
      outputs: () => ({}),
    };

    const result = await runMachine(ctx, {
      flow: ["implement"],
      load: async (name) => (name === "implement" ? implementStage : null),
    });

    expect(result.outputs.implement).toBeUndefined(); // failed: never lands in outputs (machine.ts)
    const failed = events.find((e) => e.type === "stage.failed" && e.stage === "implement");
    expect(failed).toBeDefined();
    const stderrPath = failed?.data.stderr_path as string;
    expect(typeof stderrPath).toBe("string");
    expect(readFileSync(stderrPath, "utf8")).toContain("boom");

    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  test("E-42: impacted tests come from the intake test map (plan's files) and the Wall's readOnlyFiles", async () => {
    const sessions = new FakeSessionRunner({ exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false });
    const ctx = fakeCtx(sessions, {
      intake: { task: "t", testmap: { runners: ["bun"], tests: [{ runner: "bun", path: "calc.test.ts" }] } },
      plan: { plan: "p", relevant_files: ["calc.ts"] },
      wall: { readOnlyFiles: [] },
    });
    let asked: string[] = [];
    ctx.tests.impacted = (map, changed) => { asked = changed; return map.tests; };
    const r = await implementStage.run(ctx, new AbortController().signal);
    expect(asked).toEqual(["calc.ts"]);
    expect(r.data.impacted_tests).toEqual(["calc.test.ts"]);
    expect(r.data.iteration_ids).toEqual(["e10-test-1-impl"]);
    expect(sessions.lastOpts?.brief).toContain("Impacted tests (a starting hint, not a limit): calc.test.ts.");
  });

  test("E-98c: an empty relevant_files (not missing) still falls back to the task's named files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e98c-"));
    const repomapRef = join(dir, "repomap.json");
    writeFileSync(repomapRef, JSON.stringify({ files: ["parser.py"], entries: [], truncated: false }), "utf8");

    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(sessions, {
      intake: {
        task: "fix parser.py",
        testmap: { runners: ["pytest"], tests: [{ runner: "pytest", path: "test_parser.py" }] },
        repomap_ref: repomapRef,
      },
      plan: { plan: "p", relevant_files: [] },
      wall: { readOnlyFiles: [] },
    });
    let asked: string[] = [];
    ctx.tests.impacted = (map, changed) => { asked = changed; return map.tests; };

    const result = await implementStage.run(ctx, new AbortController().signal);

    expect(asked).toEqual(["parser.py"]);
    expect(result.data.impacted_tests).toEqual(["test_parser.py"]);

    rmSync(dir, { recursive: true, force: true });
  });
});
