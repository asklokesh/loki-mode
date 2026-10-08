// ROUTER-1 R1-13: a stall on a climbable model gets one more fix round on the next rung instead of STALLED. Inert unless LOKI_ROUTER=1.
import { afterEach, describe, expect, it } from "bun:test";
import { runMachine } from "../../src/engine10/machine.ts";
import type { RunContext, Stage, StageName } from "../../src/engine10/types.ts";

const saved = process.env["LOKI_ROUTER"];
afterEach(() => { if (saved === undefined) delete process.env["LOKI_ROUTER"]; else process.env["LOKI_ROUTER"] = saved; });

type Ev = { type: string; stage: StageName | null; data: Record<string, unknown> };
const stage = (name: StageName, run: Stage["run"] = async () => ({ status: "completed", data: {} })): Stage => ({ name, targetS: 1, limitS: 5, run });

function setup(model: string, fixData?: Record<string, unknown>) {
  const events: Ev[] = [];
  const ctx: RunContext = {
    runId: "e10-t", repoDir: "/nonexistent", runDir: "/nonexistent/run", baseSha: "a", branch: "b", provider: "claude", model, deep: false, capS: 900,
    emit: (type, stage, data) => { events.push({ type, stage, data }); },
    sessions: { run: async () => { throw new Error("none"); } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() }, outputs: () => ({}),
  };
  const counts = { verifies: 0, fixes: 0 };
  const stages: Partial<Record<StageName, Stage>> = {};
  for (const n of ["intake", "plan", "wall", "implement", "commit", "seal", "pr"] as StageName[]) stages[n] = stage(n);
  stages.verify = stage("verify", async () => { counts.verifies++; return { status: "completed", data: { failures_grouped: [{ signature: "same" }] } }; });
  stages.fix = stage("fix", async (c) => { counts.fixes++; return { status: "completed", data: { ...(c.outputs().fix?.stall_escalated ? { stall_escalated: true } : {}), ...fixData } }; });
  return { ctx, events, counts, load: async (n: StageName) => stages[n] ?? null };
}

describe("R1-13 stall escalation", () => {
  it("flag on, haiku: one extra round on the next rung, then STALLED", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const t = setup("claude-haiku-5-5");
    const r = await runMachine(t.ctx, { load: t.load });
    expect(t.counts.fixes).toBe(3);
    expect(r.stopped).toBe("stalled");
    expect(t.events.find((e) => e.type === "route.escalated")?.data).toMatchObject({ trigger: "stall", unit: "run" });
  });
  it("flag on, already opus: STALLED as before (no extra round)", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const t = setup("claude-opus-5-5");
    const r = await runMachine(t.ctx, { load: t.load });
    expect(t.counts.fixes).toBe(2);
    expect(r.stopped).toBe("stalled");
  });
  it("flag off: unchanged, two fix rounds then STALLED", async () => {
    delete process.env["LOKI_ROUTER"];
    const t = setup("claude-haiku-5-5");
    const r = await runMachine(t.ctx, { load: t.load });
    expect(t.counts.fixes).toBe(2);
    expect(r.stopped).toBe("stalled");
    expect(t.events.some((e) => e.type === "route.escalated")).toBe(false);
  });
  it("flag on: a lint-only stall does not climb, grants no extra round and emits no route.escalated", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const t = setup("claude-haiku-5-5");
    const stages = { verify: stage("verify", async () => { t.counts.verifies++; return { status: "completed", data: { failures_grouped: [{ signature: "lint:eslint" }] } }; }) };
    const r = await runMachine(t.ctx, { load: async (n) => (stages as Record<string, Stage>)[n] ?? t.load(n) });
    expect(t.counts.fixes).toBe(2);
    expect(r.stopped).toBe("stalled");
    expect(t.events.some((e) => e.type === "route.escalated")).toBe(false);
  });
  it("flag on: a stall that clears after the extra round does not stop the run", async () => {
    process.env["LOKI_ROUTER"] = "1";
    const t = setup("sonnet");
    let v = 0;
    const stages = { verify: stage("verify", async () => { v++; return { status: "completed", data: v >= 4 ? {} : { failures_grouped: [{ signature: "same" }] } }; }) };
    const r = await runMachine(t.ctx, { load: async (n) => (stages as Record<string, Stage>)[n] ?? t.load(n) });
    expect(r.stopped).toBeNull();
  });
});
