// R1-10: plan-time route by Opus. Flag on: the plan brief asks for per-unit `units`, the stage parses them with
// parseUnits and stores them on its output; flag off: brief and output are byte-identical to the pre-router path.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanBrief, planStage } from "../../src/engine10/stages/plan.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const done: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
const KEYS = ["LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_ROUTER", "LOKI_ROUTER_ADVISOR", "LOKI_E10_PLAN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function setup(env: Record<string, string>, scope: unknown | null, provider = "claude") {
  for (const k of KEYS) delete process.env[k];
  process.env.LOKI_E10_PLAN = "always";
  Object.assign(process.env, env);
  const dir = mkdtempSync(join(tmpdir(), "loki-r110-"));
  let opts: SessionRunOptions | null = null;
  const sessions: SessionRunner = {
    async run(o) {
      opts = o;
      if (scope !== null) writeFileSync(join(dir, "plan-scope.json"), typeof scope === "string" ? scope : JSON.stringify(scope));
      return done;
    },
  };
  const ctx = {
    runId: "e10-r110", repoDir: "/tmp/none", runDir: dir, baseSha: "x", branch: "b", provider, model: "m", deep: false, capS: 900,
    emit: () => {}, sessions, tests: { async detect() { return { runners: [], tests: [] }; }, impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) }, clock: { now: () => 0 },
    outputs: () => ({ intake: { task: "fix the bug" } }),
  } as unknown as RunContext;
  return { dir, ctx, opts: () => opts as SessionRunOptions | null };
}
const unit = (id: string, executor: string) => ({ id, kind: "impl", executor, reason: "r" });
const sig = () => new AbortController().signal;

describe("R1-10 plan brief", () => {
  test("router brief asks for units with executor sonnet|haiku and keeps sonnet the default", () => {
    const b = buildPlanBrief("t", [], "/r/plan-output.txt", "/r/plan-scope.json", true);
    expect(b).toContain('"units"');
    expect(b).toContain("sonnet");
    expect(b).toContain("haiku");
  });
  test("router off: brief is byte-identical to the 4-arg form", () => {
    expect(buildPlanBrief("t", ["a.ts"], "/r/plan-output.txt", "/r/plan-scope.json", false)).toBe(buildPlanBrief("t", ["a.ts"], "/r/plan-output.txt", "/r/plan-scope.json"));
    expect(buildPlanBrief("t", [], "/r/plan-output.txt")).not.toContain("units");
  });
});

describe("R1-10 plan stage routing", () => {
  test("flag on, advisor available: valid units are parsed and stored, haiku kept", async () => {
    const s = setup({ LOKI_ROUTER: "1" }, { files: ["a.ts"], units: [unit("u1", "haiku"), unit("u2", "sonnet")] });
    const r = await planStage.run(s.ctx, sig());
    expect(r.data.units).toEqual([unit("u1", "haiku"), unit("u2", "sonnet")]);
    expect(r.data.route_not_proven).toEqual([]);
    expect(s.opts()?.model).toBe("opus"); // FC-35: Opus is the router, so the router-on plan runs on Opus even with the advisor attached
    rmSync(s.dir, { recursive: true, force: true });
  });
  test("advisor unavailable: haiku is raised to sonnet and the plan session is pinned to opus", async () => {
    const s = setup({ LOKI_ROUTER: "1", LOKI_ROUTER_ADVISOR: "off" }, { units: [unit("u1", "haiku")] });
    const r = await planStage.run(s.ctx, sig());
    expect((r.data.units as Array<{ executor: string }>)[0]?.executor).toBe("sonnet");
    expect(s.opts()?.model).toBe("opus");
    rmSync(s.dir, { recursive: true, force: true });
  });
  test("missing route or invalid unit falls back to sonnet and records NOT PROVEN", async () => {
    const a = setup({ LOKI_ROUTER: "1" }, { files: [] });
    const ra = await planStage.run(a.ctx, sig());
    expect(ra.data.units).toEqual([]);
    expect((ra.data.route_not_proven as string[])[0]).toContain("NOT PROVEN");
    rmSync(a.dir, { recursive: true, force: true });
    const b = setup({ LOKI_ROUTER: "1" }, { units: [{ id: "u1", kind: "impl", executor: "gpt", reason: "x" }] });
    const rb = await planStage.run(b.ctx, sig());
    expect((rb.data.units as Array<{ executor: string }>)[0]?.executor).toBe("sonnet");
    expect((rb.data.route_not_proven as string[])[0]).toContain("NOT PROVEN");
    rmSync(b.dir, { recursive: true, force: true });
  });
  test("flag off: no units, no route_not_proven, no model pin, brief has no units", async () => {
    const s = setup({}, { units: [unit("u1", "haiku")] });
    const r = await planStage.run(s.ctx, sig());
    expect("units" in r.data).toBe(false);
    expect("route_not_proven" in r.data).toBe(false);
    expect(s.opts()).not.toBeNull();
    expect("model" in (s.opts() as object)).toBe(false);
    expect(s.opts()?.brief).not.toContain("units");
    rmSync(s.dir, { recursive: true, force: true });
  });
  test("LOKI_ROUTER=0 behaves like off", async () => {
    const s = setup({ LOKI_ROUTER: "0" }, { units: [unit("u1", "haiku")] });
    const r = await planStage.run(s.ctx, sig());
    expect("units" in r.data).toBe(false);
    rmSync(s.dir, { recursive: true, force: true });
  });
  test("B1: a non-claude provider has no advisor: haiku is raised to sonnet and no opus pin is sent", async () => {
    const s = setup({ LOKI_ROUTER: "1" }, { units: [unit("u1", "haiku")] }, "codex");
    const r = await planStage.run(s.ctx, sig());
    expect((r.data.units as Array<{ executor: string }>)[0]?.executor).toBe("sonnet");
    expect("model" in (s.opts() as object)).toBe(false);
    rmSync(s.dir, { recursive: true, force: true });
  });
  test("N2: the opus pin never overrides a user model bypass", async () => {
    for (const k of ["LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_DEVELOPMENT"]) {
      const s = setup({ LOKI_ROUTER: "1", LOKI_ROUTER_ADVISOR: "off", [k]: "claude-sonnet-5-5" }, { units: [unit("u1", "sonnet")] });
      await planStage.run(s.ctx, sig());
      expect("model" in (s.opts() as object)).toBe(false);
      rmSync(s.dir, { recursive: true, force: true });
    }
  });
  test("B3: an oversize scope file fails closed with NOT PROVEN", async () => {
    const big = JSON.stringify({ units: [unit("u1", "haiku")], pad: "x".repeat(300 * 1024) });
    const s = setup({ LOKI_ROUTER: "1" }, big);
    const r = await planStage.run(s.ctx, sig());
    expect(r.data.units).toEqual([]);
    expect((r.data.route_not_proven as string[])[0]).toContain("NOT PROVEN");
    rmSync(s.dir, { recursive: true, force: true });
  });
});

describe("R1-10 N3 plan-scope.json must be a regular file", () => {
  test("a symlink is rejected with NOT PROVEN, not read", async () => {
    const s = setup({ LOKI_ROUTER: "1" }, null);
    const target = join(s.dir, "real.json");
    writeFileSync(target, JSON.stringify({ units: [unit("u1", "haiku")] }));
    symlinkSync(target, join(s.dir, "plan-scope.json"));
    const r = await planStage.run(s.ctx, sig());
    expect(r.data.units).toEqual([]);
    expect(String((r.data.route_not_proven as string[])[0])).toContain("NOT PROVEN");
    rmSync(s.dir, { recursive: true, force: true });
  });
});
