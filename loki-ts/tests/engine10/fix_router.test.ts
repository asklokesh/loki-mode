// ROUTER-1 R1-12: fix-round ladder haiku -> sonnet -> opus (or sonnet -> opus). Inert unless LOKI_ROUTER=1.
import { afterEach, describe, expect, test } from "bun:test";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import { climb } from "../../src/runner/model_rank.ts";
import type { RunContext, SessionResult, SessionRunOptions, StageName } from "../../src/engine10/types.ts";

const saved = process.env["LOKI_ROUTER"];
afterEach(() => { if (saved === undefined) delete process.env["LOKI_ROUTER"]; else process.env["LOKI_ROUTER"] = saved; });

const ok: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
const groups = [{ signature: "AssertionError: x", count: 1, sample: "s" }];

async function run(outputs: Partial<Record<StageName, Record<string, unknown>>>, model = "claude (provider default)") {
  const calls: SessionRunOptions[] = [];
  const events: { type: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    runId: "e10-r12", repoDir: "/nonexistent-r12", runDir: "/nonexistent-r12/run", baseSha: "x", branch: "b", provider: "claude", model, deep: false, capS: 900,
    emit: (type: string, _s: unknown, data: Record<string, unknown>) => events.push({ type, data }),
    sessions: { async run(o: SessionRunOptions) { calls.push({ ...o }); return ok; } },
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
    cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
    clock: { now: () => 0 }, outputs: () => outputs,
  } as unknown as RunContext;
  const r = await fixStage.run(ctx, new AbortController().signal);
  return { r, calls, events };
}
const verify = { failures_grouped: groups };
const plan = { units: [{ id: "u1", kind: "impl", executor: "haiku", reason: "mechanical rename" }], route_not_proven: [] }; // a valid Opus route record
const lint = { failures_grouped: [{ signature: "lint:eslint", count: 1, sample: "s" }] };

describe("R1-12 fix ladder", () => {
  test("B4: a haiku unit with a code-owned failure is redone on sonnet in fix round 1, not retried on haiku", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const { calls, events } = await run({ verify, plan, implement: { route_model: "claude-haiku-5-5" } });
    expect(calls[0]!.model).toMatch(/sonnet/);
    expect(events.find((e) => e.type === "route.escalated")?.data).toMatchObject({ trigger: "code_fail", unit: "run" });
  });
  test("a lint-only failure on a haiku unit is not code-owned: stays on haiku, no escalation", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const { calls, events } = await run({ verify: lint, plan, implement: { route_model: "claude-haiku-5-5" } });
    expect(calls[0]!.model).toMatch(/haiku/);
    expect(events.some((e) => e.type === "route.escalated")).toBe(false);
  });
  test("a recorded haiku model with no valid route record is floored to the run model", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const { calls } = await run({ verify: lint, implement: { route_model: "claude-haiku-5-5" }, fix: { round: 1, signatures: "other", model: "claude-haiku-5-5" } }, "claude-sonnet-5-5");
    expect(calls[0]!.model ?? "claude-sonnet-5-5").toMatch(/sonnet/);
  });
  test("repeated code-owned FAIL on haiku -> sonnet; on sonnet -> opus", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const sig = "AssertionError: x";
    const a = await run({ verify, plan, implement: { route_model: "claude-haiku-5-5" }, fix: { round: 1, signatures: sig, model: "claude-haiku-5-5" } });
    expect(a.calls[0]!.model).toMatch(/sonnet/);
    expect(a.events.find((e) => e.type === "route.escalated")?.data).toMatchObject({ trigger: "code_fail" });
    const b = await run({ verify, fix: { round: 1, signatures: sig, model: "claude-sonnet-5-5" } });
    expect(b.calls[0]!.model).toMatch(/opus/);
  });
  test("a run that starts on the sonnet default goes straight to opus on a repeat", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const { calls } = await run({ verify, fix: { round: 1, signatures: "AssertionError: x" } });
    expect(calls[0]!.model).toMatch(/opus/);
  });
  test("the swapped model carries into a non-repeated later round", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const { calls } = await run({ verify, fix: { round: 1, signatures: "other", model: "claude-sonnet-5-5" } }, "claude-haiku-5-5");
    expect(calls[0]!.model).toMatch(/sonnet/);
  });
  test("a stall escalation grants a third round; without it the third round is skipped", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const on = await run({ verify, fix: { round: 2, signatures: "AssertionError: x", model: "claude-sonnet-5-5", stall_escalated: true, stall_pending: true } });
    expect(on.r.status).toBe("completed");
    expect(on.calls[0]!.model).toMatch(/opus/);
    const off = await run({ verify, fix: { round: 2, signatures: "AssertionError: x" } });
    expect(off.r.status).toBe("skipped");
  });
  test("flag off: the pre-router escalation (opus on repeat) and no route events", async () => {
    delete process.env["LOKI_ROUTER"];
    const { calls, events } = await run({ verify, fix: { round: 1, signatures: "AssertionError: x" } }, "claude-haiku-5-5");
    expect(calls[0]!.model).toMatch(/opus/);
    expect(events.some((e) => e.type === "route.escalated")).toBe(false);
  });
  test("climb never lowers", () => {
    expect(climb("run", "claude-opus-5-5", "stall", "e")).toBeNull();
  });
});
