// T9 provider failover: injected sessions only, no real provider is spawned.
import { describe, expect, test } from "bun:test";
import { classifyOutage, nextProvider, NONE_AVAILABLE, withFailover, type FailoverRecord } from "../../src/runner/provider_failover.ts";
import type { SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const markers = { done: false, alreadyDone: null, specConflict: null };
const res = (exit: number | null, stderrTail = "", killed = false): SessionResult & { stderrTail: string } => ({ exit, markers, durationS: 1, killed, stderrTail });
const opts = (stage = "implement"): SessionRunOptions => ({ stage: stage as SessionRunOptions["stage"], brief: "b", tier: "development" as SessionRunOptions["tier"], iterationId: "i1", limitS: 60, signal: new AbortController().signal });
const runner = (r: SessionResult, calls: string[], name: string): SessionRunner => ({ run: async () => { calls.push(name); return r; } });
const all = (): boolean => true;

function setup(first: SessionResult, env: NodeJS.ProcessEnv = {}, installed: (p: string) => boolean = all) {
  const calls: string[] = [], recs: FailoverRecord[] = [];
  const second = res(0, "");
  const sessions = withFailover({
    provider: "claude", base: runner(first, calls, "claude"), env, installed,
    makeRunner: (p) => runner(second, calls, p), onFailover: (r) => recs.push(r),
  });
  return { sessions, calls, recs, second };
}

describe("failover", () => {
  test("a rate limit fails over once to the next provider and records it", async () => {
    const ev = "Error: 429 rate_limit_error: Number of request tokens has exceeded your per-minute rate limit";
    const { sessions, calls, recs, second } = setup(res(1, `starting\n${ev}\n`));
    const out = await sessions.run(opts());
    expect(out).toBe(second);
    expect(calls).toEqual(["claude", "cline"]);
    expect(recs).toEqual([{ stage: "implement", from: "claude", to: "cline", reason: "rate_limit", evidence: ev }]);
  });
  test("an overloaded outage fails over", async () => {
    const { calls, recs, sessions } = setup(res(1, "API Error: overloaded_error"));
    await sessions.run(opts());
    expect(calls).toEqual(["claude", "cline"]);
    expect(recs[0]!.reason).toBe("outage");
  });
  test("a code failure does not fail over", async () => {
    const { sessions, calls, recs } = setup(res(1, "TypeError: x is not a function\n3 tests failed\n"));
    await sessions.run(opts());
    expect(calls).toEqual(["claude"]);
    expect(recs).toEqual([]);
  });
  test("a verify stage, a kill and a clean exit never fail over", async () => {
    const rl = "429 rate limit";
    for (const [r, stage] of [[res(1, rl), "verify"], [res(1, rl, true), "implement"], [res(0, rl), "implement"]] as const) {
      const { sessions, calls } = setup(r);
      await sessions.run(opts(stage));
      expect(calls).toEqual(["claude"]);
    }
  });
  test("gemini is never chosen, even when listed", () => {
    expect(nextProvider("claude", { LOKI_FAILOVER_PROVIDERS: "gemini,codex" }, all)).toBe("codex");
    expect(nextProvider("claude", { LOKI_FAILOVER_PROVIDERS: "gemini" }, all)).toBeNull();
    expect(nextProvider("claude", {}, all)).not.toBe("gemini");
    expect(nextProvider("cline", { LOKI_FAILOVER_PROVIDERS: "cline, aider" }, all)).toBe("aider");
  });
  test("default list skips providers that are not installed", () => {
    expect(nextProvider("claude", {}, (p) => p === "opencode")).toBe("opencode");
  });
  test("none available records the note and returns the original failure", async () => {
    const first = res(1, "HTTP 503 service unavailable");
    const { sessions, calls, recs } = setup(first, {}, (p) => p === "claude");
    expect(await sessions.run(opts())).toBe(first);
    expect(calls).toEqual(["claude"]);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ to: null, note: NONE_AVAILABLE, reason: "outage" });
    expect(JSON.stringify(recs[0])).toContain("failover: none available");
  });
  test("LOKI_FAILOVER=0 returns the base runner itself", async () => {
    const calls: string[] = [], recs: FailoverRecord[] = [];
    const base = runner(res(1, "429 rate limit"), calls, "claude");
    const s = withFailover({ provider: "claude", base, env: { LOKI_FAILOVER: "0" }, installed: all, makeRunner: (p) => runner(res(0), calls, p), onFailover: (r) => recs.push(r) });
    expect(s).toBe(base);
    await s.run(opts());
    expect(calls).toEqual(["claude"]);
    expect(recs).toEqual([]);
  });
  test("classifier reads exit and kill state", () => {
    expect(classifyOutage("429 rate limit", 0, false)).toBeNull();
    expect(classifyOutage("429 rate limit", null, false)).toBeNull();
    expect(classifyOutage("", 1, false)).toBeNull();
  });
});
