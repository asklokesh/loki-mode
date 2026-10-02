// D60-5 (INTEL-2): visible per-run cost cap. Resolution (--max-cost > loki.yaml budgets.per_run > default),
// the start line, and enforcement: cost over the cap ends the run BUDGET_STOP with exit code 3.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capNote, costMeter, DEFAULT_MAX_COST_USD, parseCapUsd, resolveCap, yamlPerRun } from "../../src/e10ext/budget_cap.ts";
import { runMachine } from "../../src/engine10/machine.ts";
import { EXIT, outcomeOf } from "../../src/engine10/output.ts";
import type { RunContext, Stage, StageName } from "../../src/engine10/types.ts";

describe("cap resolution", () => {
  test("parse accepts positive numbers only", () => {
    expect(parseCapUsd("5")).toBe(5);
    expect(parseCapUsd("2.50")).toBe(2.5);
    expect(parseCapUsd("$7")).toBe(7);
    for (const bad of ["0", "-1", "abc", "", "1e3", "NaN"]) expect(parseCapUsd(bad)).toBeNull();
  });
  test("yamlPerRun reads budgets.per_run only", () => {
    expect(yamlPerRun("budgets:\n  per_run: 3.5\n  per_day: 50\n")).toBe(3.5);
    expect(yamlPerRun("other:\n  per_run: 9\nbudgets:\n  per_day: 1\n")).toBeNull();
    expect(yamlPerRun("budgets:\n  per_run: 4 # comment\n")).toBe(4);
    expect(yamlPerRun("per_run: 8\n")).toBeNull();
  });
  test("CLI wins over yaml, yaml over default", () => {
    const d = mkdtempSync(join(tmpdir(), "loki-cap-"));
    try {
      expect(resolveCap(null, d)).toEqual({ usd: DEFAULT_MAX_COST_USD, source: "default" });
      writeFileSync(join(d, "loki.yaml"), "budgets:\n  per_run: 3\n");
      expect(resolveCap(null, d)).toEqual({ usd: 3, source: "loki.yaml" });
      expect(resolveCap("1.5", d)).toEqual({ usd: 1.5, source: "--max-cost" });
      expect("error" in resolveCap("zero", d)).toBe(true);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("start-line note names the cap", () => {
    expect(capNote(20, "default")).toBe("cap $20.00 (default)");
    expect(capNote(2.5, "--max-cost")).toBe("cap $2.50 (--max-cost)");
  });
  test("meter ignores null cost and trips at the cap", () => {
    const m = costMeter(1);
    m.add(null); m.add(0.4);
    expect(m.over()).toBe(false);
    m.add(0.6);
    expect(m.over()).toBe(true);
  });
});

describe("enforcement", () => {
  test("a cap hit maps to BUDGET_STOP and exit code 3", () => {
    expect(outcomeOf("PARTIAL", true, null)).toBe("BUDGET_STOP");
    expect(EXIT.BUDGET_STOP).toBe(3);
  });
  test("machine: cost over the cap stops the running stage, emits cap.hit, starts no more work stages", async () => {
    const events: { type: string; stage: StageName | null }[] = [];
    let spent = false;
    const ctx: RunContext = {
      runId: "e10-t", repoDir: "/x", runDir: "/x/r", baseSha: "a", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
      emit: (type, stage) => { events.push({ type, stage }); },
      sessions: { run: async () => { spent = true; return { exit: 0 } as never; } },
      tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
      cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
      clock: { now: () => Date.now() }, outputs: () => ({}), overCap: () => spent,
    };
    const st = (name: StageName, run?: Stage["run"]): Stage => ({ name, targetS: 1, limitS: 5, run: run ?? (async () => ({ status: "completed", data: {} })) });
    const sleep = (ms: number, s: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); s.addEventListener("abort", () => { clearTimeout(t); r(); }); });
    const stages: Partial<Record<StageName, Stage>> = {};
    for (const n of ["intake", "plan", "wall", "implement", "verify", "fix", "commit", "seal", "pr"] as StageName[]) stages[n] = st(n);
    stages.implement = st("implement", async (c, signal) => { await c.sessions.run({} as never); await sleep(5000, signal); return { status: "completed", data: {} }; });
    stages.verify = st("verify", async () => { throw new Error("verify must not run over the cap"); });
    const r = await runMachine(ctx, { load: async (n) => stages[n] ?? null });
    expect(r.capHit).toBe(true);
    expect(events.some((e) => e.type === "cap.hit")).toBe(true);
    expect(events.filter((e) => e.type === "stage.started").map((e) => e.stage)).not.toContain("verify");
  });
});
