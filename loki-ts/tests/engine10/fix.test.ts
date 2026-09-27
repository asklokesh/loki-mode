// loki-ts/tests/engine10/fix.test.ts
//
// E-17 wall check (docs/v10/ENGINE.md section 16): at most 2 rounds, then
// PARTIAL. Depends on E-07/E-09 only through the SessionRunner interface and
// the outputs() shapes those stages produce, so every sibling here is a fake.
import { describe, expect, test } from "bun:test";
import { buildFixBrief, fixStage } from "../../src/engine10/stages/fix.ts";
import type { FailureGroup } from "../../src/engine10/failures.ts";
import type {
  EventType,
  RunContext,
  SessionResult,
  SessionRunOptions,
  SessionRunner,
  StageName,
} from "../../src/engine10/types.ts";

class FakeSessionRunner implements SessionRunner {
  calls: SessionRunOptions[] = [];
  constructor(private result: SessionResult) {}
  async run(opts: SessionRunOptions): Promise<SessionResult> {
    this.calls.push(opts);
    return this.result;
  }
}

function fakeCtx(
  sessions: SessionRunner,
  outputs: Partial<Record<StageName, Record<string, unknown>>>,
  emitted: { type: EventType | (string & {}); stage: StageName | null; data: Record<string, unknown> }[] = [],
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
    emit: (type, stage, data) => emitted.push({ type, stage, data }),
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

const groups: FailureGroup[] = [
  { signature: "AssertionError: expected # to equal #", count: 2, sample: "AssertionError: expected 1 to equal 2" },
];

describe("buildFixBrief", () => {
  test("carries the task, plan, impacted tests and the grouped failures", () => {
    const brief = buildFixBrief("fix the bug", "1. patch X", ["tests/x.test.ts"], groups);
    expect(brief).toContain("fix the bug");
    expect(brief).toContain("1. patch X");
    expect(brief).toContain("tests/x.test.ts");
    expect(brief.toLowerCase()).toContain("read-only");
    expect(brief).toContain("Fast verify run failed");
    expect(brief).toContain("AssertionError: expected # to equal #");
    expect(brief).toContain("AssertionError: expected 1 to equal 2");
  });

  test("says so plainly when no groups were fed", () => {
    const brief = buildFixBrief("fix it", null, [], []);
    expect(brief).toContain("no grouped failures were provided");
  });
});

describe("fix stage", () => {
  test("round 1: runs a session, feeds the grouped failures, emits fix.round", async () => {
    const sessions = new FakeSessionRunner(doneResult);
    const emitted: { type: EventType | (string & {}); stage: StageName | null; data: Record<string, unknown> }[] = [];
    const ctx = fakeCtx(
      sessions,
      {
        intake: { task: "fix the bug", impacted_tests: ["tests/x.test.ts"] },
        verify: { failures_grouped: groups },
        implement: { diff_stat: "1 file changed, +3 -1" },
      },
      emitted,
    );

    const result = await fixStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.round).toBe(1);
    expect(result.data.groups_fed).toBe(1);
    expect(result.data.diff_stat).toBe("1 file changed, +3 -1");
    expect(sessions.calls).toHaveLength(1);
    expect(sessions.calls[0]!.brief).toContain("AssertionError: expected 1 to equal 2");
    expect(sessions.calls[0]!.iterationId).toBe("e10-test-1-fix1");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "fix.round", stage: "fix" });
    expect(emitted[0]!.data.round).toBe(1);
  });

  test("round 2: reads the prior round from ctx.outputs().fix and increments", async () => {
    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(sessions, { fix: { round: 1 }, verify: { failures_grouped: groups } });

    const result = await fixStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.round).toBe(2);
    expect(sessions.calls[0]!.iterationId).toBe("e10-test-1-fix2");
  });

  test("a third round is refused: no session call, status skipped", async () => {
    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(sessions, { fix: { round: 2 }, verify: { failures_grouped: groups } });

    const result = await fixStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("fix rounds exhausted");
    expect(sessions.calls).toHaveLength(0);
  });

  test("a killed session is reported but the round still completes", async () => {
    const sessions = new FakeSessionRunner({
      exit: null,
      markers: { done: false, alreadyDone: null, specConflict: null },
      durationS: 180,
      killed: true,
    });
    const ctx = fakeCtx(sessions, {});

    const result = await fixStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.killed).toBe(true);
  });

  test("with no verify output yet, feeds an empty group list rather than throwing", async () => {
    const sessions = new FakeSessionRunner(doneResult);
    const ctx = fakeCtx(sessions, {});

    const result = await fixStage.run(ctx, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(result.data.groups_fed).toBe(0);
  });
});
