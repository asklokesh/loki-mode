// loki-ts/tests/engine10/implement.test.ts
//
// E-08 wall check (docs/v10/ENGINE.md section 16). Depends on E-05/E-07 only
// through the TestMapProvider/SessionRunner interfaces in types.ts, so every
// sibling here is a fake.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
): RunContext {
  return {
    runId: "e10-test-1",
    repoDir: "/tmp/does-not-matter",
    runDir: "/tmp/does-not-matter/.loki/runs/e10-test-1",
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
  test("forbids the full suite, kills, and docs; requires the exit markers", () => {
    const brief = buildImplementBrief("fix the bug", "1. patch X", ["tests/x.test.ts"]);
    expect(brief).toContain("fix the bug");
    expect(brief).toContain("1. patch X");
    expect(brief).toContain("tests/x.test.ts");
    expect(brief.toLowerCase()).toContain("read-only");
    expect(brief.toLowerCase()).toContain("never run the full");
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
    expect(sessions.lastOpts?.brief).toContain("Run only these impacted tests: calc.test.ts.");
  });
});
