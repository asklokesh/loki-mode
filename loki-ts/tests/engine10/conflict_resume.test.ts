// FC-19: one LOKI_SPEC_CONFLICT correction round; no wording of the reason is inspected.
import { describe, expect, test } from "bun:test";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import { CONFLICT_CORRECTION } from "../../src/util/conflict_resume.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const INCIDENT = "the task asks for all 37 route files to be migrated, but the stage rules limit me to the named files and a few tests";
class Seq implements SessionRunner {
  calls: SessionRunOptions[] = [];
  constructor(private rs: SessionResult[]) {}
  async run(o: SessionRunOptions): Promise<SessionResult> { this.calls.push(o); return this.rs[Math.min(this.calls.length - 1, this.rs.length - 1)]!; }
}
const ctxOf = (s: SessionRunner, provider = "claude"): RunContext => ({
  runId: "e10-fc19", repoDir: "/tmp/fc19-does-not-exist", runDir: "/tmp/fc19-does-not-exist/.loki/runs/e10-fc19", baseSha: "x", branch: "b", provider, model: "m", deep: false, capS: 900,
  emit: () => {}, sessions: s,
  tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
  cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
  clock: { now: () => 0 }, outputs: () => ({}),
} as unknown as RunContext);
const conflict = (reason: string): SessionResult => ({ exit: 0, markers: { done: false, alreadyDone: null, specConflict: reason }, durationS: 1, killed: false });
const done: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };

describe("FC-19 conflict resume", () => {
  test("a conflict that clears after the correction continues", async () => {
    const s = new Seq([conflict(INCIDENT), done]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(s.calls[1]!.brief).toContain(CONFLICT_CORRECTION);
    expect(r.status).toBe("completed");
    expect(r.data.exit).toBe("done");
    expect(r.data.spec_conflict_reason).toBeNull();
    expect(r.data.iteration_ids).toEqual(["e10-fc19-impl", "e10-fc19-impl-r"]);
  });
  test("a conflict that persists stays a spec conflict with its question, resumed exactly once", async () => {
    const genuine = "the task says keep the REST API unchanged and also replace it with GraphQL";
    const s = new Seq([conflict(INCIDENT), conflict(genuine)]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(r.status).toBe("completed");
    expect(r.data.exit).toBe("spec_conflict");
    expect(r.data.spec_conflict_reason).toBe(genuine);
    expect(r.data.harness_failure).toBeUndefined();
  });
  test("no conflict means no second session", async () => {
    const s = new Seq([done]);
    await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(1);
  });
  test("without a recorded session id the retry restarts with the original brief plus the correction", async () => {
    const s = new Seq([conflict("x"), done]);
    await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls[1]!.resumeSessionId).toBeUndefined();
    expect(s.calls[1]!.brief.startsWith(s.calls[0]!.brief)).toBe(true);
  });
  describe("R1: a failed resume keeps the original question", () => {
    const Q = "Which provider: Stripe or Adyen?";
    const cases: Array<[string, SessionResult]> = [
      ["resume exits 1 with no marker", { exit: 1, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 2, killed: false }],
      ["resume is killed", { exit: null, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 2, killed: true }],
      ["resume exits 0 with no marker", { exit: 0, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 2, killed: false }],
    ];
    for (const [name, second] of cases) {
      test(name, async () => {
        const s = new Seq([conflict(Q), second]);
        const r = await implementStage.run(ctxOf(s), new AbortController().signal);
        expect(s.calls.length).toBe(2);
        expect(r.status).toBe("completed");
        expect(r.data.exit).toBe("spec_conflict");
        expect(r.data.spec_conflict_reason).toBe(Q);
        expect(r.data.duration_s).toBe(3);
      });
    }
  });
});
