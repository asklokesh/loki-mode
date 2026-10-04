// FC-21: a time limit in implement still runs verify (never straight to seal), the implement session is told
// its remaining time, and the CLI Outcome line is the receipt verdict (one source of truth).
import { describe, expect, test } from "bun:test";
import { runMachine } from "../../src/engine10/machine.ts";
import { formatSummary, outcomeOf, EXIT } from "../../src/engine10/output.ts";
import type { RunContext, Stage, StageName, Verdict } from "../../src/engine10/types.ts";

function harness(briefs: string[] = []) {
  const events: { type: string; stage: StageName | null; data: Record<string, unknown> }[] = [];
  const ctx: RunContext = {
    runId: "e10-t", repoDir: "/x", runDir: "/x/r", baseSha: "a", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: (type, stage, data) => { events.push({ type, stage, data }); },
    sessions: { run: async (o) => { briefs.push(String((o as { brief?: string }).brief ?? "")); return { exit: 0 } as never; } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() }, outputs: () => ({}),
  };
  return { events, ctx };
}
const st = (name: StageName, limitS: number, run?: Stage["run"]): Stage => ({ name, targetS: 1, limitS, run: run ?? (async () => ({ status: "completed", data: {} })) });
const sleep = (ms: number, s: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); s.addEventListener("abort", () => { clearTimeout(t); r(); }); });
const NAMES = ["intake", "plan", "wall", "verify", "fix", "commit", "seal", "pr"] as StageName[];

describe("FC-21 (a): an implement limit still verifies", () => {
  test("implement killed at its limit is followed by verify, then the tail", async () => {
    const { events, ctx } = harness();
    const stages: Partial<Record<StageName, Stage>> = {};
    for (const n of NAMES) stages[n] = st(n, 5);
    stages.implement = st("implement", 1, async (_c, signal) => { await sleep(5000, signal); return { status: "completed", data: {} }; });
    const r = await runMachine(ctx, { load: async (n) => stages[n] ?? null });
    const started = events.filter((e) => e.type === "stage.started").map((e) => e.stage);
    expect(events.find((e) => e.type === "stage.failed" && e.stage === "implement")?.data.reason).toBe("limit");
    expect(started.indexOf("verify")).toBeGreaterThan(started.indexOf("implement"));
    expect(started.indexOf("verify")).toBeLessThan(started.indexOf("seal"));
    expect(r.outputs.implement?.exit).toBe("killed"); // seal reads this: VERIFIED only when earned (FC-21b: fc21b_verdict.test.ts)
    expect(r.outputs.implement?.limit_s).toBe(1); // FC-21b: the limit is recorded so seal can set implement_limit
  });
  test("a limit in implement with failing verify still runs fix rounds", async () => {
    const { events, ctx } = harness();
    const stages: Partial<Record<StageName, Stage>> = {};
    for (const n of NAMES) stages[n] = st(n, 5);
    stages.implement = st("implement", 1, async (_c, signal) => { await sleep(5000, signal); return { status: "completed", data: {} }; });
    let v = 0;
    stages.verify = st("verify", 5, async () => ({ status: "completed", data: v++ === 0 ? { failures_grouped: [{ signature: "a" }] } : {} }));
    await runMachine(ctx, { load: async (n) => stages[n] ?? null });
    const started = events.filter((e) => e.type === "stage.started").map((e) => e.stage);
    expect(started.slice(started.indexOf("verify"), started.indexOf("verify") + 3)).toEqual(["verify", "fix", "verify"]);
  });
});

describe("FC-21 (c): implement is told its remaining time", () => {
  test("the implement session brief carries the time budget", async () => {
    const briefs: string[] = [];
    const { ctx } = harness(briefs);
    const stages: Partial<Record<StageName, Stage>> = {};
    for (const n of NAMES) stages[n] = st(n, 5);
    stages.implement = st("implement", 480, async (c) => { await c.sessions.run({ stage: "implement", brief: "BRIEF", limitS: 480 } as never); return { status: "completed", data: {} }; });
    await runMachine({ ...ctx, capS: 2700 }, { load: async (n) => stages[n] ?? null });
    expect(briefs[0]!.startsWith("BRIEF")).toBe(true);
    expect(briefs[0]).toMatch(/minutes? (left|remain)/i);
  });
});

describe("FC-21 (d): one outcome", () => {
  test("the Outcome line equals the receipt verdict for VERIFIED, PARTIAL, FAILED and BLOCKED", () => {
    const line = (verdict: Verdict) => {
      const outcome = outcomeOf(verdict, false, null);
      return { outcome, text: formatSummary({ pr: null, verdict, outcome, notProven: [], flaky: [], cost: { usd: 1, provider: "claude", tokens: 1 }, wallS: 1, stages: [] } as never) };
    };
    expect(line("VERIFIED").outcome).toBe("VERIFIED");
    expect(line("PARTIAL").outcome).toBe("PARTIAL");
    expect(line("PARTIAL").text).toContain("Outcome:    PARTIAL\n");
    expect(line("FAILED").outcome).toBe("FAILED");
    expect(line("SPEC_CONFLICT").outcome).toBe("BLOCKED");
    expect(EXIT.PARTIAL).toBe(1);
  });
  test("FC-21b (3): a cap stop with a sealed receipt keeps the receipt verdict and its exit code", () => {
    expect(outcomeOf("PARTIAL", true, null, false, true)).toBe("PARTIAL");
    expect(EXIT[outcomeOf("PARTIAL", true, null, false, true)]).toBe(EXIT.PARTIAL);
  });
});
