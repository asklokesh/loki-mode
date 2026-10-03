// FC-19: a block that cites Loki's own stage rules is a harness failure, never the user's spec conflict.
import { describe, expect, test } from "bun:test";
import { harnessScopeFailure, isHarnessScopeReason } from "../../src/util/harness_scope_guard.ts";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const INCIDENT = "spec conflict: the task asks for all 37 route files to be migrated, validated and covered 100%, but the stage rules limit me to the named files and a few tests";

class Fake implements SessionRunner {
  last: SessionRunOptions | null = null;
  constructor(private r: SessionResult) {}
  async run(o: SessionRunOptions): Promise<SessionResult> { this.last = o; return this.r; }
}
const ctxOf = (s: SessionRunner): RunContext => ({
  runId: "e10-fc19", repoDir: "/tmp/fc19-does-not-exist", runDir: "/tmp/fc19-does-not-exist/.loki/runs/e10-fc19", baseSha: "x", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
  emit: () => {}, sessions: s,
  tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
  cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
  clock: { now: () => 0 }, outputs: () => ({}),
} as unknown as RunContext);
const conflict = (reason: string): SessionResult => ({ exit: 0, markers: { done: false, alreadyDone: null, specConflict: reason }, durationS: 1, killed: false });

describe("FC-19 harness scope guard", () => {
  test("the incident text is a harness failure", () => { expect(isHarnessScopeReason(INCIDENT)).toBe(true); });
  for (const r of ["the scope of this stage forbids it", "I am limited to one stage of the run", "the stage limits prevent running the full suite", "Loki's rules do not let me"]) {
    test(`classifies: ${r}`, () => { expect(isHarnessScopeReason(r)).toBe(true); });
  }
  test("a genuine task contradiction is not a harness reason", () => {
    expect(isHarnessScopeReason("the task says to keep the REST API unchanged and also to replace it with GraphQL")).toBe(false);
    expect(isHarnessScopeReason("which of the two payment providers should be used, only a human can answer")).toBe(false);
    expect(isHarnessScopeReason(null)).toBe(false);
  });
  test("implement turns the incident into a failed stage with harness_failure, not spec_conflict", async () => {
    const r = await implementStage.run(ctxOf(new Fake(conflict(INCIDENT))), new AbortController().signal);
    expect(r.status).toBe("failed");
    expect(r.data.exit).toBe("error");
    expect(r.data.harness_failure).toBe(true);
    expect(r.data.spec_conflict_reason).toBeNull();
    expect(r.reason).toBe(harnessScopeFailure(INCIDENT));
    expect(r.reason).toContain("harness failure");
  });
  test("control: a genuine contradiction stays spec_conflict", async () => {
    const reason = "the task contradicts the Wall tests";
    const r = await implementStage.run(ctxOf(new Fake(conflict(reason))), new AbortController().signal);
    expect(r.status).toBe("completed");
    expect(r.data.exit).toBe("spec_conflict");
    expect(r.data.spec_conflict_reason).toBe(reason);
    expect(r.data.harness_failure).toBeUndefined();
  });
});
