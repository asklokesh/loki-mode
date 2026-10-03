// E-45 wall check: small tasks make 2 sessions (wall on sonnet, implement), normal 3;
// the wall brief stays under a fixed size; the variant is recorded.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMachine } from "../../src/engine10/machine.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import { readFileSync } from "node:fs";
import { loadRepoMap, cascadeImplementModel, planMode, wallLimitS, resolveModelAlias, sizeTask, wallModel } from "../../src/engine10/sizing.ts";
import { planStage } from "../../src/engine10/stages/plan.ts";
import { wallStage, buildWallBrief, WALL_MAP_MAX_LINES } from "../../src/engine10/stages/wall.ts";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import type { RunContext, SessionRunOptions, Stage, StageName, TestMap, TestRef } from "../../src/engine10/types.ts";

const dirs: string[] = [];
const saved = { ...process.env };
afterEach(() => { for (const k of ["LOKI_E10_PLAN", "LOKI_E10_WALL", "LOKI_E10_WALL_TIER", "LOKI_E10_WALL_LIMIT_S", "LOKI_E10_CASCADE", "LOKI_MODEL_OVERRIDE"]) delete process.env[k]; });
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); process.env = saved; });

const TM: TestMap = { runners: ["bun"], tests: [{ runner: "bun", path: "tests/a.test.ts" }] };
const files = (n: number) => Array.from({ length: n }, (_, i) => `src/mod${i}.ts`);
// A relevant-tests fake: every changed file maps to one impacted test, so the E-64 lean path applies.
const impactedOne: (m: TestMap, f: string[]) => TestRef[] = (_m, f) => (f.length ? [{ runner: "bun", path: "tests/a.test.ts" }] : []);

async function run(task: string, repoFiles: string[], opts: { impacted?: (m: TestMap, f: string[]) => TestRef[]; model?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loki-e45-"));
  dirs.push(dir);
  const repomapRef = join(dir, "repomap.json");
  writeFileSync(repomapRef, JSON.stringify({ files: repoFiles, entries: [], truncated: false }));
  const calls: SessionRunOptions[] = [];
  const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
  const intake: Stage = { name: "intake", targetS: 1, limitS: 5, run: async () => ({ status: "completed", data: { task, repomap_ref: repomapRef, testmap: TM } }) };
  const stages: Partial<Record<StageName, Stage>> = { intake, plan: planStage, wall: wallStage, implement: implementStage };
  const ctx: RunContext = {
    runId: "e10-e45", repoDir: dir, runDir: dir, baseSha: "abc", branch: "loki/e10-e45", provider: "claude", model: opts.model ?? "run-model",
    deep: false, capS: 900,
    emit: (type, stage, data) => { events.push({ type, stage, data }); },
    sessions: { run: async (o) => { calls.push(o); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } },
    tests: { detect: async () => TM, impacted: opts.impacted ?? (() => []) },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() },
    outputs: () => ({}),
  };
  await runMachine(ctx, { load: async (n) => stages[n] ?? null });
  return { calls, events };
}

describe("engine10 E-45 sizing", () => {
  it("a small task makes exactly 2 sessions: wall pinned to sonnet, then implement", async () => {
    const { calls, events } = await run("fix the off-by-one in mod1.ts", files(10));
    expect(calls.map((c) => c.stage).sort()).toEqual(["implement", "wall"]);
    const wall = calls.find((c) => c.stage === "wall")!;
    expect(wall.model).toBe(wallModel());
    expect(wall.model).toContain("sonnet");
    // E-64: cascade pins the first implement attempt to the same sonnet alias Wall uses.
    expect(calls.find((c) => c.stage === "implement")!.model).toBe(cascadeImplementModel());
    expect(calls.find((c) => c.stage === "implement")!.brief).toContain("plan the change yourself");
    const skipped = events.find((e) => e.type === "stage.skipped" && e.stage === "plan");
    expect(skipped?.data.reason).toBe("small task: implementer plans");
    const v = events.find((e) => e.type === "variant")!;
    expect(v.data).toMatchObject({ size: "small", plan_skipped: true, wall_model: wallModel(), small_task_path: "wall", cascade: true });
  });

  it("E-64: a small task with a relevant test takes the lean path: one session, no Plan or Wall call", async () => {
    const { calls, events } = await run("fix the off-by-one in mod1.ts", files(10), { impacted: impactedOne });
    expect(calls.map((c) => c.stage)).toEqual(["implement"]);
    expect(calls[0]!.model).toBe(cascadeImplementModel());
    const wallSkip = events.find((e) => e.type === "stage.skipped" && e.stage === "wall");
    expect(wallSkip?.data).toMatchObject({ size: "small" });
    expect(events.find((e) => e.type === "variant")!.data).toMatchObject({ small_task_path: "lean" });
  });

  it("E-64: LOKI_E10_CASCADE=0 leaves implement on the run's configured model, as before E-64", async () => {
    process.env.LOKI_E10_CASCADE = "0";
    const { calls, events } = await run("fix the off-by-one in mod1.ts", files(10), { impacted: impactedOne });
    expect(calls[0]!.model).toBeUndefined();
    expect(events.find((e) => e.type === "variant")!.data).toMatchObject({ small_task_path: "lean", cascade: false });
  });

  it("E-64: a small task with no impacted test for the named file keeps the Wall (fail-safe)", async () => {
    const { calls, events } = await run("fix the off-by-one in mod1.ts", files(10), { impacted: () => [] });
    expect(calls.map((c) => c.stage).sort()).toEqual(["implement", "wall"]);
    expect(events.find((e) => e.type === "variant")!.data).toMatchObject({ small_task_path: "wall" });
  });

  it("minor: LOKI_E10_PLAN=always forces the plan on a lean-eligible small task, and Wall still runs too", async () => {
    process.env.LOKI_E10_PLAN = "always";
    const { calls, events } = await run("fix the off-by-one in mod1.ts", files(10), { impacted: impactedOne });
    expect(calls.map((c) => c.stage).sort()).toEqual(["implement", "plan", "wall"]);
    expect(events.find((e) => e.type === "variant")!.data).toMatchObject({ small_task_path: "wall" });
  });

  it("a normal task makes 3 sessions and records the variant", async () => {
    const { calls, events } = await run("x".repeat(700), files(10));
    expect(calls.map((c) => c.stage).sort()).toEqual(["implement", "plan", "wall"]);
    expect(events.find((e) => e.type === "variant")!.data).toMatchObject({ size: "normal", plan_skipped: false });
  });

  it("LOKI_E10_PLAN=1 forces the plan on a small task; =0 skips it on a normal one", async () => {
    process.env.LOKI_E10_PLAN = "1";
    expect((await run("fix mod1.ts", files(3))).calls).toHaveLength(3);
    process.env.LOKI_E10_PLAN = "0";
    expect((await run("x".repeat(700), files(3))).calls).toHaveLength(2);
    expect(planMode({ LOKI_E10_PLAN: "maybe" })).toBe("auto");
  });

  it("LOKI_E10_WALL_TIER overrides the wall model via the catalog alias", () => {
    expect(wallModel({ LOKI_E10_WALL_TIER: "haiku" })).toContain("haiku");
    expect(wallModel({ LOKI_E10_WALL_TIER: "my-model-id" })).toBe("my-model-id");
  });

  it("the wall brief is paths only, capped, and under a fixed size", async () => {
    const task = "add a search bar";
    const { calls } = await run(task, files(5000).map((f) => `${f}/${"d".repeat(20)}`));
    const brief = calls.find((c) => c.stage === "wall")!.brief;
    expect(brief.split("\n").filter((l) => l.startsWith("src/mod")).length).toBe(WALL_MAP_MAX_LINES);
    expect(brief.length).toBeLessThan(task.length + 9000);
    expect(buildWallBrief(task).length).toBeLessThan(task.length + 600);
  });

  it("missing inputs never size small", () => {
    expect(sizeTask("fix a.ts", null, TM).size).toBe("normal");
    expect(sizeTask("fix a.ts", { files: ["a.ts"], entries: [], truncated: false }, null).size).toBe("normal");
    expect(sizeTask("", { files: ["a.ts"], entries: [], truncated: false }, TM).size).toBe("normal");
    const many = sizeTask("touch a.ts b.ts c.ts", { files: ["a.ts", "b.ts", "c.ts"], entries: [], truncated: false }, TM);
    expect(many.size).toBe("normal");
    expect(many.reasons.join()).toContain("names 3 files");
  });

  it("a truncated repo map sizes normal, since buildRepoMap caps files at 2000 and the >3000 rule alone never fires", () => {
    // A repo with (say) 6000 files reaches sizeTask as only 2000 (buildRepoMap's cap) with truncated: true.
    const capped = sizeTask("fix a.ts", { files: ["a.ts"], entries: [], truncated: true }, TM);
    expect(capped.size).toBe("normal");
    expect(capped.reasons.join()).toContain("truncated");
  });

  it("the Wall session runs on the development tier, never planning (which LOKI_SESSION_MODEL=opus can override)", async () => {
    const { calls } = await run("fix the off-by-one in mod1.ts", files(10));
    expect(calls.find((c) => c.stage === "wall")!.tier).toBe("development");
  });

  it("session.ts pins the tier model env for a session that sets model, even under a run-wide LOKI_MODEL_OVERRIDE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e45-s-"));
    dirs.push(dir);
    // E-64: EV-8 sets LOKI_MODEL_OVERRIDE to the run's top model (e.g. claude-opus-5-5); the per-call pin
    // (implement's cascade, Wall's E-45 pin) must still win, since claudeTierToModel() reads the tier var first.
    process.env.LOKI_MODEL_OVERRIDE = "claude-opus-5-5";
    const r = createSessionRunner({ provider: "claude", childCommand: ["/bin/sh", ["-c", 'printf %s "$LOKI_CLAUDE_MODEL_DEVELOPMENT" > out.txt']] });
    await r.run({ stage: "wall", brief: "b", tier: "development", model: "claude-sonnet-x", iterationId: "i", limitS: 10, signal: new AbortController().signal, cwd: dir });
    expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("claude-sonnet-x");
  });

  function fixCtx(calls: SessionRunOptions[], events: { type: string; stage: string | null; data: Record<string, unknown> }[]): RunContext {
    return {
      runId: "e10-fix", repoDir: "/tmp", runDir: "/tmp", baseSha: "abc", branch: "loki/e10-fix",
      provider: "claude", model: "claude-opus-5-5", deep: false, capS: 900,
      emit: (type, stage, data) => { events.push({ type, stage, data }); },
      sessions: { run: async (o) => { calls.push(o); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } },
      tests: { detect: async () => TM, impacted: () => [] },
      cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
      clock: { now: () => Date.now() },
      outputs: () => ({ intake: { task: "t" }, verify: { failures_grouped: [{ signature: "bun:a.test.ts", count: 1, sample: "bun test a.test.ts" }] } }),
    };
  }

  it("E-64: a fix round only escalates after a fast-verify failure, to the run's configured model, with the reason event", async () => {
    const calls: SessionRunOptions[] = [];
    const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
    const result = await fixStage.run(fixCtx(calls, events), new AbortController().signal);
    expect(calls[0]!.model).toBe("claude-opus-5-5");
    expect(events.find((e) => e.type === "fix.round")!.data).toMatchObject({
      escalated: true, model: "claude-opus-5-5", escalation_reason: "bun:a.test.ts", escalation_model: "claude-opus-5-5",
    });
    expect(result.data.cascade).toBe(true);
    expect(result.data.model).toBe("claude-opus-5-5");
  });

  it("D31/blocking: LOKI_E10_CASCADE=0 leaves the fix round on the run's configured model with no escalation event", async () => {
    process.env.LOKI_E10_CASCADE = "0";
    const calls: SessionRunOptions[] = [];
    const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
    const result = await fixStage.run(fixCtx(calls, events), new AbortController().signal);
    expect(calls[0]!.model).toBeUndefined(); // cascade fully off: never pins, inherits the run's configured model
    const round = events.find((e) => e.type === "fix.round")!.data;
    expect(round.escalated).toBe(false);
    // The event must truthfully report the model the session actually runs on (the run's model, since no pin).
    expect(round.model).toBe("claude-opus-5-5");
    expect(result.data.model).toBe("claude-opus-5-5");
  });

  it("D31/blocking: a lint-only failure never escalates, and the round runs on the cheap model, never the run's top model", async () => {
    const calls: SessionRunOptions[] = [];
    const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
    const ctx = fixCtx(calls, events);
    ctx.outputs = () => ({ intake: { task: "t" }, verify: { failures_grouped: [{ signature: "lint:tsc", count: 1, sample: "npx tsc --noEmit" }] } });
    const result = await fixStage.run(ctx, new AbortController().signal);
    // Blocking defect: a round that does not escalate must still run on the cheap model (never inherit
    // ctx.model, "claude-opus-5-5" here, via LOKI_MODEL_OVERRIDE).
    expect(calls[0]!.model).toBe(cascadeImplementModel());
    const round = events.find((e) => e.type === "fix.round")!.data;
    expect(round.escalated).toBe(false);
    expect(round.model).toBe(cascadeImplementModel()); // truthfully the model the session was actually given
    expect(round.escalation_reason).toBeUndefined();
    expect(result.data.cascade).toBe(false);
    expect(result.data.model).toBe(cascadeImplementModel());
  });

  it("E-64: no phantom escalation when the run has no top model configured (ctx.model already equals the pin)", async () => {
    const calls: SessionRunOptions[] = [];
    const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
    const ctx = fixCtx(calls, events);
    ctx.model = cascadeImplementModel(); // no LOKI_MODEL_OVERRIDE: the run's model IS the cascade pin already
    const result = await fixStage.run(ctx, new AbortController().signal);
    expect(calls[0]!.model).toBe(cascadeImplementModel());
    const round = events.find((e) => e.type === "fix.round")!.data;
    expect(round.escalated).toBe(false);
    expect(round.model).toBe(cascadeImplementModel());
    expect(result.data.cascade).toBe(false);
  });

  it("minor: no phantom escalation when ctx.model is an unresolved alias of the cascade pin (\"sonnet\" vs its resolved id)", async () => {
    const calls: SessionRunOptions[] = [];
    const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
    const ctx = fixCtx(calls, events);
    ctx.model = "sonnet"; // resolveModelAlias("sonnet") === cascadeImplementModel(); a bare string compare would wrongly escalate
    expect(resolveModelAlias("sonnet")).toBe(cascadeImplementModel());
    const result = await fixStage.run(ctx, new AbortController().signal);
    expect(events.find((e) => e.type === "fix.round")!.data.escalated).toBe(false);
    expect(result.data.cascade).toBe(false);
  });

  it("E-64: the machine escalates fix only after a fast-verify failure; a pass-first run never escalates", async () => {
    let verifyCalls = 0;
    const verify: Stage = {
      name: "verify", targetS: 1, limitS: 5,
      run: async () => {
        verifyCalls++;
        const failures_grouped = verifyCalls === 1 ? [{ signature: "bun:a.test.ts", count: 1, sample: "bun test a.test.ts" }] : [];
        return { status: "completed", data: { failures_grouped } };
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "loki-e64-fix-"));
    dirs.push(dir);
    const repomapRef = join(dir, "repomap.json");
    writeFileSync(repomapRef, JSON.stringify({ files: files(10), entries: [], truncated: false }));
    const calls: SessionRunOptions[] = [];
    const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
    const intake: Stage = { name: "intake", targetS: 1, limitS: 5, run: async () => ({ status: "completed", data: { task: "fix mod1.ts", repomap_ref: repomapRef, testmap: TM } }) };
    const stages: Partial<Record<StageName, Stage>> = { intake, plan: planStage, wall: wallStage, implement: implementStage, verify, fix: fixStage };
    const ctx: RunContext = {
      runId: "e10-e64-fix", repoDir: dir, runDir: dir, baseSha: "abc", branch: "loki/e10-e64-fix", provider: "claude", model: "claude-opus-5-5",
      deep: false, capS: 900,
      emit: (type, stage, data) => { events.push({ type, stage, data }); },
      sessions: { run: async (o) => { calls.push(o); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } },
      tests: { detect: async () => TM, impacted: impactedOne },
      cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
      clock: { now: () => Date.now() },
      outputs: () => ({}),
    };
    await runMachine(ctx, { load: async (n) => stages[n] ?? null });
    expect(calls.find((c) => c.stage === "implement")!.model).toBe(cascadeImplementModel());
    expect(calls.find((c) => c.stage === "fix")!.model).toBe("claude-opus-5-5");
    expect(events.find((e) => e.type === "fix.round")!.data).toMatchObject({ escalated: true, escalation_reason: "bun:a.test.ts", escalation_model: "claude-opus-5-5" });
  });

  it("E-64: a pass-first run has zero fix sessions and no escalation event", async () => {
    const verify: Stage = { name: "verify", targetS: 1, limitS: 5, run: async () => ({ status: "completed", data: { failures_grouped: [] } }) };
    const dir = mkdtempSync(join(tmpdir(), "loki-e64-nofix-"));
    dirs.push(dir);
    const repomapRef = join(dir, "repomap.json");
    writeFileSync(repomapRef, JSON.stringify({ files: files(10), entries: [], truncated: false }));
    const calls: SessionRunOptions[] = [];
    const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
    const intake: Stage = { name: "intake", targetS: 1, limitS: 5, run: async () => ({ status: "completed", data: { task: "fix mod1.ts", repomap_ref: repomapRef, testmap: TM } }) };
    const stages: Partial<Record<StageName, Stage>> = { intake, plan: planStage, wall: wallStage, implement: implementStage, verify, fix: fixStage };
    const ctx: RunContext = {
      runId: "e10-e64-nofix", repoDir: dir, runDir: dir, baseSha: "abc", branch: "loki/e10-e64-nofix", provider: "claude", model: "claude-opus-5-5",
      deep: false, capS: 900,
      emit: (type, stage, data) => { events.push({ type, stage, data }); },
      sessions: { run: async (o) => { calls.push(o); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } },
      tests: { detect: async () => TM, impacted: impactedOne },
      cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
      clock: { now: () => Date.now() },
      outputs: () => ({}),
    };
    await runMachine(ctx, { load: async (n) => stages[n] ?? null });
    expect(calls.some((c) => c.stage === "fix")).toBe(false);
    expect(events.some((e) => e.type === "fix.round")).toBe(false);
  });
});

describe("W1-S3 size-tied Wall time cap", () => {
  it("small 90, normal 180, override clamps to 300, garbage falls back", () => {
    expect(wallLimitS("small", {})).toBe(90);
    expect(wallLimitS("normal", {})).toBe(180);
    expect(wallLimitS("normal", { LOKI_E10_WALL_LIMIT_S: "999" })).toBe(300);
    expect(wallLimitS("small", { LOKI_E10_WALL_LIMIT_S: "120" })).toBe(120);
    for (const g of ["abc", "-5", "", "0", "NaN"]) expect(wallLimitS("small", { LOKI_E10_WALL_LIMIT_S: g })).toBe(90);
  });

  const LONG = "refactor the module layout and keep behavior identical. ".repeat(12); // 660 chars: sizes normal
  async function wallRun(task: string) {
    const dir = mkdtempSync(join(tmpdir(), "loki-w1s3-")); dirs.push(dir);
    const ref = join(dir, "repomap.json"); writeFileSync(ref, JSON.stringify({ files: Array.from({ length: 30 }, (_, i) => `src/m${i}.ts`), entries: [], truncated: false }));
    const seen: SessionRunOptions[] = [];
    const ctx: RunContext = {
      runId: "w1s3", repoDir: dir, runDir: dir, baseSha: "abc", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
      emit: () => {},
      sessions: { run: async (o) => { seen.push(o); writeFileSync(join(o.cwd!, "loki_wall_x.test.ts"), "x"); return { exit: null, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 0, killed: true }; } },
      tests: { detect: async () => TM, impacted: () => [] }, cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
      clock: { now: () => Date.now() }, outputs: () => ({ intake: { task, repomap_ref: ref, testmap: TM } }),
    };
    const r = await wallStage.run(ctx, new AbortController().signal);
    return { r, seen, dir, size: sizeTask(task, loadRepoMap(ref), TM).size };
  }

  it("a normal task reaches the Wall session with limitS 180; a timed-out session copies nothing and is never already_satisfied", async () => {
    const { r, seen, dir, size } = await wallRun(LONG);
    expect(size).toBe("normal");
    expect(seen[0]!.limitS).toBe(180);
    expect(r.status).toBe("failed");
    expect(r.data.already_satisfied).toBeUndefined();
    expect(existsSync(join(dir, "tests", "loki_wall_x.test.ts"))).toBe(false);
  });

  it("LOKI_E10_WALL_LIMIT_S=240 reaches the Wall session as 240", async () => {
    process.env.LOKI_E10_WALL_LIMIT_S = "240";
    expect((await wallRun(LONG)).seen[0]!.limitS).toBe(240);
  });
});
