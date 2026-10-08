// FC-33: the start line, the receipt route block and plan-scope.json/route.json must agree (L7). Drives the real plan
// stage with fake sessions, then derives the start line and the receipt block from the run dir the way the supervisor and seal do.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planStage } from "../../src/engine10/stages/plan.ts";
import { buildRouteBlock, routeStartLine } from "../../src/runner/router/route_block.ts";
import { loadRouteRecord } from "../../src/runner/router/route_record.ts";
import { shapeKeyForRun } from "../../src/runner/router/history.ts";
import { modelDowngrades } from "../../src/runner/model_downgrades.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const ok: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };
const KEYS = ["LOKI_MODEL_OVERRIDE", "LOKI_CLAUDE_MODEL_DEVELOPMENT", "LOKI_ROUTER", "LOKI_ROUTER_ADVISOR", "LOKI_ROUTER_EXECUTOR", "LOKI_E10_PLAN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
const dirs: string[] = [];
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Fake = (o: SessionRunOptions, dir: string) => SessionResult;
function setup(env: Record<string, string>, fake: Fake, answer?: unknown) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  const dir = mkdtempSync(join(tmpdir(), "loki-fc33-"));
  dirs.push(dir);
  if (answer !== undefined) writeFileSync(join(dir, "project-model.answer.json"), JSON.stringify(answer));
  const mapPath = join(dir, "repomap.json");
  writeFileSync(mapPath, JSON.stringify({ files: ["range.js", "package.json"], entries: [], truncated: false }));
  const calls: SessionRunOptions[] = [];
  const sessions: SessionRunner = { async run(o) { calls.push(o); return fake(o, dir); } };
  const ctx = {
    runId: "e10-fc33", repoDir: dir, runDir: dir, baseSha: "x", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: () => {}, sessions, tests: { async detect() { return { runners: [], tests: [] }; }, impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) }, clock: { now: () => 0 },
    // a repo map plus a detected runner make the task "small" (sizeTask), the fast path the router must not skip
    outputs: () => ({ intake: { task: "fix the off by one in range.js", repomap_ref: mapPath, testmap: { runners: ["node:test"], tests: [] } } }),
  } as unknown as RunContext;
  return { dir, ctx, calls };
}
const scopeWith = (units: unknown[]): Fake => (_o, dir) => { writeFileSync(join(dir, "plan-scope.json"), JSON.stringify({ files: ["a.js"], units })); return ok; };
const sig = () => new AbortController().signal;
const ON = { LOKI_ROUTER: "1" };

/** The three consumers, each reading only the run dir / stage output exactly as supervisor.ts and seal.ts do. */
function consumers(s: ReturnType<typeof setup>, planData: Record<string, unknown>) {
  const record = loadRouteRecord(s.dir);
  const start = routeStartLine(process.env, "claude", record);
  const block = buildRouteBlock(process.env, "claude", planData.route_record as Record<string, unknown> | undefined, undefined)!;
  return { record, start, block };
}

describe("FC-33 R-A/R-B: start line, receipt and route.json agree", () => {
  test("routed by plan: Opus plan session, units recorded, start line and receipt show the same executor", async () => {
    const s = setup(ON, scopeWith([{ id: "u1", kind: "impl", executor: "sonnet", reason: "needs care" }, { id: "wall", kind: "wall", executor: "sonnet", reason: "tests" }]));
    const r = await planStage.run(s.ctx, sig());
    expect(s.calls[0]?.model).toBe("opus");
    expect(existsSync(join(s.dir, "plan-scope.json"))).toBe(true);
    const c = consumers(s, r.data);
    expect(c.record?.routed).toBe(true);
    expect(c.block.routed).toBe(true);
    expect(c.block.executor).toBe("sonnet-5.5");
    expect(c.block.units.map((u) => u.id)).toEqual(["u1", "wall"]);
    expect(c.start).toContain("executor sonnet-5.5");
    expect(c.start).not.toContain("haiku");
    expect(c.block.plan_model).toBe("opus");
  });
  test("routed to haiku by Opus: the start line and receipt both say mixed or haiku, never a bare default", async () => {
    const s = setup(ON, scopeWith([{ id: "u1", kind: "impl", executor: "haiku", reason: "rename" }]));
    const r = await planStage.run(s.ctx, sig());
    const c = consumers(s, r.data);
    expect(c.block.executor).toBe("haiku-5.5");
    expect(c.start).toContain("executor haiku-5.5");
  });
  test("small task, nothing routed: the plan still runs, route.json says routed:false, start line says default sonnet, never haiku", async () => {
    const s = setup(ON, (_o, _d) => ok);
    const r = await planStage.run(s.ctx, sig());
    expect(r.status).toBe("completed");
    expect(s.calls.length).toBe(1);
    const c = consumers(s, r.data);
    expect(c.record?.routed).toBe(false);
    expect(c.block.routed).toBe(false);
    expect(c.block.executor).toBe("sonnet-5.5");
    expect(c.block.units).toEqual([]);
    expect(c.block.reason).toContain("no plan route");
    expect(c.start).toContain("executor sonnet-5.5 (default, no plan route)");
    expect(c.start).not.toContain("haiku");
    expect(routeStartLine(process.env, "claude")).not.toContain("haiku");
  });
  test("Opus unavailable: the plan retries on sonnet and the fallback is recorded as NOT PROVEN", async () => {
    const s = setup(ON, (o, dir) => (o.model === "opus" ? { ...ok, exit: 1 } : scopeWith([{ id: "u1", kind: "impl", executor: "sonnet", reason: "r" }])(o, dir)));
    const r = await planStage.run(s.ctx, sig());
    expect(s.calls.map((c) => c.model)).toEqual(["opus", "sonnet"]);
    const c = consumers(s, r.data);
    expect(c.block.plan_model).toBe("sonnet");
    expect(c.block.not_proven.join("\n")).toContain("Opus plan session failed");
    expect(c.record?.plan_model).toBe("sonnet");
  });
  test("LOKI_E10_PLAN=0 with the router on: skipped, but the record says why nothing routed", async () => {
    const s = setup({ ...ON, LOKI_E10_PLAN: "0" }, (_o, _d) => ok);
    const r = await planStage.run(s.ctx, sig());
    expect(r.status).toBe("skipped");
    const rec = loadRouteRecord(s.dir);
    expect(rec?.routed).toBe(false);
    expect(String(rec?.reason)).toContain("LOKI_E10_PLAN=0");
  });
  test("the router-on plan is not reported as a fast-tier downgrade", () => {
    expect(modelDowngrades("claude", { LOKI_ROUTER: "1" }).some((d) => d.stage === "plan")).toBe(false);
    expect(modelDowngrades("claude", {}).some((d) => d.stage === "plan" && d.reason === "fast tier")).toBe(true);
  });
});

describe("FC-33 R-C: shape key from project-model.answer.json", () => {
  const cmd = { cmd: "node --test", cwd: ".", cite: ["package.json"] };
  const answer = { workspaceKind: "single", workspaceCite: ["package.json"], packages: [{ name: "app", root: ".", runner: "node:test", commands: { test: cmd, lint: null, build: null, start: null }, ui: { present: false, boot: null, cite: ["package.json"] }, cite: ["package.json"] }], fingerprintFiles: ["package.json"] };
  test("shapeKeyForRun reads the run dir answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-fc33-")); dirs.push(dir);
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "project-model.answer.json"), JSON.stringify(answer));
    expect(shapeKeyForRun(dir, dir)).toBe("single:node:test");
    mkdirSync(join(dir, "empty"));
    expect(shapeKeyForRun(join(dir, "empty"), join(dir, "empty"))).toBeNull();
  });
  test("plan stage records the shape key in route.json and the receipt block", async () => {
    const s = setup(ON, scopeWith([{ id: "u1", kind: "impl", executor: "sonnet", reason: "r" }]), answer);
    writeFileSync(join(s.dir, "package.json"), "{}");
    const r = await planStage.run(s.ctx, sig());
    const c = consumers(s, r.data);
    expect(c.record?.shape_key).toBe("single:node:test");
    expect(c.block.shape_key).toBe("single:node:test");
    expect(c.block.shape_parity).toContain("single:node:test");
  });
});

describe("FC-33 router off stays byte-identical", () => {
  test("unset and 0: no route.json, no model pin, small task still skips, start line null", async () => {
    for (const env of [{} as Record<string, string>, { LOKI_ROUTER: "0" }]) {
      const s = setup(env, (_o, _d) => ok);
      const r = await planStage.run(s.ctx, sig());
      expect(r.status).toBe("skipped");
      expect(s.calls.length).toBe(0);
      expect(existsSync(join(s.dir, "route.json"))).toBe(false);
      expect(routeStartLine(process.env, "claude")).toBeNull();
      expect("route_record" in r.data).toBe(false);
    }
  });
  test("unset with LOKI_E10_PLAN=always: the plan runs with no model key and writes no route.json", async () => {
    const s = setup({ LOKI_E10_PLAN: "always" }, (_o, _d) => ok);
    const r = await planStage.run(s.ctx, sig());
    expect(s.calls.length).toBe(1);
    expect("model" in (s.calls[0] as object)).toBe(false);
    expect(existsSync(join(s.dir, "route.json"))).toBe(false);
    expect("route_record" in r.data).toBe(false);
  });
});
