// R1-10: plan-time route by Opus. Flag on: the plan brief asks for per-unit `units`, the stage parses them with
// parseUnits and stores them on its output; flag off: brief and output are byte-identical to the pre-router path.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlanBrief, planStage } from "../../src/engine10/stages/plan.ts";
import { planFallbackModel } from "../../src/runner/router/plan_route.ts";
import { unitModel } from "../../src/runner/router/unit_model.ts";
import { modelRank } from "../../src/runner/model_rank.ts";
import { claudeModelFor } from "../../src/runner/providers.ts";
import { resolveModel } from "../../src/engine10/session.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const done: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
const KEYS = ["LOKI_MAX_TIER", "LOKI_SESSION_MODEL", "LOKI_CLAUDE_MODEL_FAST", "LOKI_MODEL_FAST", "LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_ROUTER", "LOKI_ROUTER_ADVISOR", "LOKI_E10_PLAN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

function setup(env: Record<string, string>, scope: unknown | null, provider = "claude", model = "m", failOpus = false) {
  for (const k of KEYS) delete process.env[k];
  process.env.LOKI_E10_PLAN = "always";
  Object.assign(process.env, env);
  const dir = mkdtempSync(join(tmpdir(), "loki-r110-"));
  let opts: SessionRunOptions | null = null;
  const calls: Array<string | undefined> = [];
  const sessions: SessionRunner = {
    async run(o) {
      opts = o;
      calls.push(o.model);
      if (failOpus && o.model === "opus") return { ...done, exit: 1 };
      if (scope !== null) writeFileSync(join(dir, "plan-scope.json"), typeof scope === "string" ? scope : JSON.stringify(scope));
      return done;
    },
  };
  const ctx = {
    runId: "e10-r110", repoDir: "/tmp/none", runDir: dir, baseSha: "x", branch: "b", provider, model, deep: false, capS: 900,
    emit: () => {}, sessions, tests: { async detect() { return { runners: [], tests: [] }; }, impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) }, clock: { now: () => 0 },
    outputs: () => ({ intake: { task: "fix the bug" } }),
  } as unknown as RunContext;
  return { dir, ctx, calls, opts: () => opts as SessionRunOptions | null };
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

describe("T2 behavior_change (strict only)", () => {
  test("brief asks for behavior_change only when requested; default brief unchanged", () => {
    const base = buildPlanBrief("t", ["a.ts"], "/r/plan-output.txt", "/r/plan-scope.json");
    expect(buildPlanBrief("t", ["a.ts"], "/r/plan-output.txt", "/r/plan-scope.json", false, false)).toBe(base);
    expect(base).not.toContain("behavior_change");
    expect(buildPlanBrief("t", ["a.ts"], "/r/plan-output.txt", "/r/plan-scope.json", false, false, true)).toContain("behavior_change");
  });

  test("strict intent puts the behavior_change instruction in the brief exactly once", () => {
    const brief = buildPlanBrief("t", ["a.ts"], "/r/plan-output.txt", "/r/plan-scope.json", false, false, true);
    expect(brief.split("also add \"behavior_change\"").length - 1).toBe(1);
    expect(brief.split("behavior_change").length - 1).toBe(1);
  });

  test("strict unset: brief is byte-identical to the brief without the T2 parameter", () => {
    const a = buildPlanBrief("t", ["a.ts"], "/r/plan-output.txt", "/r/plan-scope.json");
    const b = buildPlanBrief("t", ["a.ts"], "/r/plan-output.txt", "/r/plan-scope.json", false, false);
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
    expect(a).not.toContain("behavior_change");
  });
});

describe("NBR-G2 plan fallback never drops below the run model", () => {
  const run = async (model: string) => {
    const s = setup({ LOKI_ROUTER: "1", LOKI_ROUTER_ADVISOR: "off" }, { units: [unit("u1", "sonnet")] }, "claude", model, true);
    await planStage.run(s.ctx, sig());
    rmSync(s.dir, { recursive: true, force: true });
    return { calls: s.calls };
  };
  test("opus run model, opus plan fails: the fallback is opus, not sonnet", async () => {
    expect((await run("opus")).calls).toEqual(["opus", "opus"]);
    expect((await run("claude-opus-4-5")).calls).toEqual(["opus", "claude-opus-4-5"]);
  });
  test("sonnet run model: the fallback stays sonnet", async () => {
    expect((await run("sonnet")).calls).toEqual(["opus", "sonnet"]);
  });
  test("haiku run model: the fallback is still sonnet (unchanged behavior)", async () => {
    expect((await run("haiku")).calls).toEqual(["opus", "sonnet"]);
  });
  test("an unrecognized run model id keeps the sonnet fallback", async () => {
    expect((await run("m")).calls).toEqual(["opus", "sonnet"]);
  });
  test("the user model bypass sends no pin on either attempt", async () => {
    const s = setup({ LOKI_ROUTER: "1", LOKI_ROUTER_ADVISOR: "off", LOKI_MODEL_OVERRIDE: "claude-opus-4-5" }, { units: [unit("u1", "sonnet")] }, "claude", "claude-opus-4-5", true);
    await planStage.run(s.ctx, sig());
    expect(s.calls).toEqual([undefined]);
    rmSync(s.dir, { recursive: true, force: true });
  });
});

describe("D128 the run-model floor never exceeds LOKI_MAX_TIER", () => {
  const dispatched = (tier: "fast" | "development", m: string): string => {
    const k = tier === "fast" ? "LOKI_CLAUDE_MODEL_FAST" : "LOKI_CLAUDE_MODEL_DEVELOPMENT";
    const prev = process.env[k];
    process.env[k] = m;
    const r = claudeModelFor({ tier, mainLoop: false } as never);
    if (prev === undefined) delete process.env[k]; else process.env[k] = prev;
    return r;
  };
  const withEnv = (env: Record<string, string>, fn: () => void) => { for (const k of KEYS) delete process.env[k]; Object.assign(process.env, env); fn(); };
  test("an opus session pin under MAX_TIER=sonnet gives a sonnet fallback and sonnet units, as dispatched", () => {
    withEnv({ LOKI_MAX_TIER: "sonnet", LOKI_SESSION_MODEL: "opus" }, () => {
      const run = resolveModel("claude");
      expect(run).toBe("opus");
      expect(planFallbackModel(run)).toBe("sonnet");
      expect(dispatched("fast", planFallbackModel(run))).toBe("sonnet");
      expect(unitModel("sonnet", run)).toBe("sonnet");
      expect(dispatched("development", unitModel("sonnet"))).toBe("sonnet");
    });
  });
  test("MAX_TIER=haiku: the fallback and units never rank above the cap or the base value", () => {
    withEnv({ LOKI_MAX_TIER: "haiku", LOKI_SESSION_MODEL: "opus" }, () => {
      const run = resolveModel("claude");
      expect(planFallbackModel(run)).toBe("sonnet"); // the base value; no upgrade to opus
      expect(modelRank(unitModel("sonnet", run))).toBeLessThanOrEqual(modelRank("sonnet"));
      expect(unitModel("sonnet", "opus")).toBe("sonnet");
    });
  });
  test("no cap: an opus run still floors the fallback and units at opus", () => {
    withEnv({ LOKI_SESSION_MODEL: "opus" }, () => {
      expect(planFallbackModel(resolveModel("claude"))).toBe("opus");
      expect(unitModel("sonnet")).toBe("opus");
    });
  });
});
