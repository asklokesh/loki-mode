// FC-19b: a spec-conflict resume is skipped when under RESUME_MIN_LEFT_S of the implement window remains, so the run ends BLOCKED with its question.
import { describe, expect, test } from "bun:test";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const Q = "Which provider: Stripe or Adyen?";
class Seq implements SessionRunner {
  calls: SessionRunOptions[] = [];
  constructor(private rs: SessionResult[]) {}
  async run(o: SessionRunOptions): Promise<SessionResult> { this.calls.push(o); return this.rs[Math.min(this.calls.length - 1, this.rs.length - 1)]!; }
}
const ctxOf = (s: SessionRunner, leftS?: number): RunContext => ({
  runId: "e10-fc19b", repoDir: "/tmp/fc19b-does-not-exist", runDir: "/tmp/fc19b-does-not-exist/.loki/runs/e10-fc19b", baseSha: "x", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
  emit: () => {}, sessions: s,
  tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
  cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
  clock: { now: () => 0 }, outputs: () => ({}),
  ...(leftS === undefined ? {} : { implementLeftS: () => leftS }),
} as unknown as RunContext);
const conflict = (reason: string): SessionResult => ({ exit: 0, markers: { done: false, alreadyDone: null, specConflict: reason }, durationS: 1, killed: false });
const done: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };

describe("FC-19b conflict resume near the stage limit", () => {
  test("55s left: resume skipped, spec_conflict keeps the question", async () => {
    const s = new Seq([conflict(Q), done]);
    const r = await implementStage.run(ctxOf(s, 55), new AbortController().signal);
    expect(s.calls.length).toBe(1);
    expect(r.data.exit).toBe("spec_conflict");
    expect(r.data.spec_conflict_reason).toBe(Q);
    expect(r.data.harness_failure).toBeUndefined();
    expect(r.data.iteration_ids).toEqual(["e10-fc19b-impl"]);
  });
  test("120s left: resume runs as today", async () => {
    const s = new Seq([conflict(Q), done]);
    const r = await implementStage.run(ctxOf(s, 120), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(r.data.exit).toBe("done");
  });
  test("no window known: resume runs as today", async () => {
    const s = new Seq([conflict(Q), done]);
    await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
  });
  test("resume aborted mid-way keeps the first conflict", async () => {
    const s = new Seq([conflict(Q), { exit: null, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 2, killed: true }]);
    const r = await implementStage.run(ctxOf(s, 120), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(r.data.exit).toBe("spec_conflict");
    expect(r.data.spec_conflict_reason).toBe(Q);
  });
});
