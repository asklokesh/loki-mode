// E-45 wall check: small tasks make 2 sessions (wall on sonnet, implement), normal 3;
// the wall brief stays under a fixed size; the variant is recorded.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMachine } from "../../src/engine10/machine.ts";
import { childEnv, createSessionRunner } from "../../src/engine10/session.ts";
import { readFileSync } from "node:fs";
import { loadRepoMap, cascadeImplementModel, modelRank, planMode, wallLimitS, resolveModelAlias, namedFiles, sizeTask, smallMaxChars, smallTaskPath, wallConcurrent, wallFirstModel, wallMaxTokens, wallOutputCap, wallModel } from "../../src/engine10/sizing.ts";
import { readPlanScope, planOutOfRepo } from "../../src/util/run_cap.ts";
import { FIXED_RULES } from "../../src/e10ext/context.ts";
import { keepsPlanForConsentOrCap, planStage } from "../../src/engine10/stages/plan.ts";
import { discoverProjectModel } from "../../src/project_model/discover.ts";
import { wallStage, buildWallBrief, WALL_MAP_MAX_LINES } from "../../src/engine10/stages/wall.ts";
import { FOLD_PLAN_INSTRUCTION, buildImplementBrief, implementStage } from "../../src/engine10/stages/implement.ts";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import type { RunContext, SessionRunOptions, Stage, StageName, TestMap, TestRef } from "../../src/engine10/types.ts";

const dirs: string[] = [];
const saved = { ...process.env };
process.env.LOKI_E10_WALL_FIRST = "0"; // COST-11: these cases count Wall sessions against the sonnet pin; the haiku-first rung is covered in wall.test.ts and below
afterEach(() => { for (const k of ["LOKI_E10_PLAN", "LOKI_E10_WALL", "LOKI_E10_WALL_TIER", "LOKI_E10_WALL_LIMIT_S", "LOKI_E10_CASCADE", "LOKI_MODEL_OVERRIDE", "LOKI_E10_SMALL_MAX_CHARS", "LOKI_E10_SMALL_NO_RUNNER"]) delete process.env[k]; });
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); process.env = saved; });

const TM: TestMap = { runners: ["bun"], tests: [{ runner: "bun", path: "tests/a.test.ts" }] };
const files = (n: number) => Array.from({ length: n }, (_, i) => `src/mod${i}.ts`);
// A relevant-tests fake: every changed file maps to one impacted test, so the E-64 lean path applies.
const impactedOne: (m: TestMap, f: string[]) => TestRef[] = (_m, f) => (f.length ? [{ runner: "bun", path: "tests/a.test.ts" }] : []);

async function run(task: string, repoFiles: string[], opts: { impacted?: (m: TestMap, f: string[]) => TestRef[]; model?: string; testmap?: TestMap; repoDir?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "loki-e45-"));
  dirs.push(dir);
  const repomapRef = join(dir, "repomap.json");
  writeFileSync(repomapRef, JSON.stringify({ files: repoFiles, entries: [], truncated: false }));
  const calls: SessionRunOptions[] = [];
  const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
  const intake: Stage = { name: "intake", targetS: 1, limitS: 5, run: async () => ({ status: "completed", data: { task, repomap_ref: repomapRef, testmap: opts.testmap ?? TM } }) };
  const stages: Partial<Record<StageName, Stage>> = { intake, plan: planStage, wall: wallStage, implement: implementStage };
  const ctx: RunContext = {
    runId: "e10-e45", repoDir: opts.repoDir ?? dir, runDir: dir, baseSha: "abc", branch: "loki/e10-e45", provider: "claude", model: opts.model ?? "run-model",
    deep: false, capS: 900,
    emit: (type, stage, data) => { events.push({ type, stage, data }); },
    sessions: { run: async (o) => { calls.push(o); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } },
    tests: { detect: async () => TM, impacted: opts.impacted ?? (() => []) },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() },
    outputs: () => ({}),
  };
  await runMachine(ctx, { load: async (n) => stages[n] ?? null });
  return { calls, events, runDir: dir };
}

// A real git repo whose cached Project Model has 2 packages (the recorded firelater-17 answer) or 1 (frontend dropped).
async function pmRepo(multi: boolean): Promise<string> {
  const fix = join(import.meta.dir, "..", "fixtures", "project-model", "firelater-17");
  const d = mkdtempSync(join(tmpdir(), "loki-e45pm-")); dirs.push(d);
  cpSync(fix, d, { recursive: true }); rmSync(join(d, "response.json"));
  const ans = JSON.parse(readFileSync(join(fix, "response.json"), "utf8")) as Record<string, any>;
  if (!multi) { ans.packages = ans.packages.filter((p: any) => p.root === "backend"); ans.fingerprintFiles = ans.fingerprintFiles.filter((f: string) => f.startsWith("backend/")); rmSync(join(d, "frontend"), { recursive: true, force: true }); }
  execFileSync("git", ["init", "-q"], { cwd: d, stdio: "pipe" }); execFileSync("git", ["add", "-A", "-f"], { cwd: d, stdio: "pipe" });
  const runner = { run: async (o: SessionRunOptions) => { writeFileSync(/\(absolute path\): (\S+)/.exec(o.brief)![1]!, JSON.stringify(ans)); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } };
  await discoverProjectModel({ runId: "pm", repoDir: d, runDir: join(d, ".loki", "runs", "pm"), sessions: runner } as unknown as RunContext, new AbortController().signal);
  return d;
}
const withStderrTty = async (tty: boolean, fn: () => Promise<void>): Promise<void> => {
  const was = Object.getOwnPropertyDescriptor(process.stderr, "isTTY"), pm = process.env.LOKI_E10_PROJECT_MODEL;
  Object.defineProperty(process.stderr, "isTTY", { value: tty, configurable: true });
  process.env.LOKI_E10_PROJECT_MODEL = "1"; // tests/preload.ts turns the Project Model off; the cap rule reads it
  try { await fn(); } finally {
    if (pm === undefined) delete process.env.LOKI_E10_PROJECT_MODEL; else process.env.LOKI_E10_PROJECT_MODEL = pm; if (was) Object.defineProperty(process.stderr, "isTTY", was); else delete (process.stderr as { isTTY?: boolean }).isTTY; }
};

describe("engine10 E-45 sizing", () => {
  it("a small task makes exactly 2 sessions: wall pinned to sonnet, then implement", async () => {
    process.env.LOKI_E10_CASCADE = "1"; // L1: the downgrade is opt-in
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

  it("the variant event reports the model that authored the Wall (haiku first) and the re-author ceiling separately", async () => {
    process.env.LOKI_E10_WALL_FIRST = "1";
    try {
      const { events } = await run("fix the off-by-one in mod1.ts", files(10));
      const v = events.find((e) => e.type === "variant")!;
      expect(v.data).toMatchObject({ size: "small", wall_model: wallFirstModel("small"), wall_model_reauthor: wallModel() });
      expect(String(v.data.wall_model)).toContain("haiku");
      expect(String(v.data.wall_model_reauthor)).toContain("sonnet");
    } finally { process.env.LOKI_E10_WALL_FIRST = "0"; }
  });

  it("E-64: a small task with a relevant test takes the lean path: one session, no Plan or Wall call", async () => {
    process.env.LOKI_E10_CASCADE = "1"; // L1: the downgrade is opt-in
    const { calls, events } = await run("fix the off-by-one in mod1.ts", files(10), { impacted: impactedOne });
    expect(calls.map((c) => c.stage)).toEqual(["implement"]);
    expect(calls[0]!.model).toBe(cascadeImplementModel());
    const wallSkip = events.find((e) => e.type === "stage.skipped" && e.stage === "wall");
    expect(wallSkip?.data).toMatchObject({ size: "small" });
    expect(events.find((e) => e.type === "variant")!.data).toMatchObject({ small_task_path: "lean" });
  });

  it("L1: LOKI_E10_CASCADE=0 and the default both leave implement on the run's configured model", async () => {
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

  it("a normal (medium) task folds the plan into the implement brief: no plan session, plan_skipped true", async () => {
    const { calls, events } = await run("x".repeat(700), files(10));
    expect(calls.map((c) => c.stage).sort()).toEqual(["implement", "wall"]);
    expect(events.find((e) => e.type === "variant")!.data).toMatchObject({ size: "normal", plan_skipped: true });
    expect(events.find((e) => e.type === "stage.skipped" && e.stage === "plan")?.data.reason).toBe("normal task: implementer plans");
    expect(calls.find((c) => c.stage === "implement")!.brief).toContain(FOLD_PLAN_INSTRUCTION);
  });

  it("headless (no LOKI_CONFIRM, no terminal) a normal task still skips the plan", async () => {
    await withStderrTty(false, async () => {
      delete process.env.LOKI_CONFIRM;
      const { calls } = await run("x".repeat(700), files(10));
      expect(calls.map((c) => c.stage)).not.toContain("plan");
    });
  });

  it("LOKI_CONFIRM=1 on a normal task with LOKI_E10_PLAN unset keeps the plan session (the consent question lives there)", async () => {
    process.env.LOKI_CONFIRM = "1";
    try {
      delete process.env.LOKI_E10_PLAN;
      const { calls, events } = await run("x".repeat(700), files(10));
      expect(calls.map((c) => c.stage)).toContain("plan");
      expect(events.find((e) => e.type === "variant")!.data).toMatchObject({ size: "normal", plan_skipped: false });
    } finally { delete process.env.LOKI_CONFIRM; }
  });

  it("the intent card shown on an attached terminal keeps the plan; LOKI_INTENT_CARD=0 does not", () => {
    expect(keepsPlanForConsentOrCap({}, true, 1, 0)).toBe(true);
    expect(keepsPlanForConsentOrCap({}, false, 1, 0)).toBe(false);
    expect(keepsPlanForConsentOrCap({ LOKI_INTENT_CARD: "0" }, true, 1, 0)).toBe(false);
    expect(keepsPlanForConsentOrCap({ LOKI_CONFIRM: "1", LOKI_INTENT_CARD: "0" }, false, 1, 0)).toBe(true);
  });

  it("a normal task naming no files plans in a multi-package repo (the plan sizes the cap) and skips in a single-package repo", async () => {
    await withStderrTty(false, async () => {
      const multi = await run("x".repeat(700), files(10), { repoDir: await pmRepo(true) });
      expect(multi.calls.map((c) => c.stage)).toContain("plan");
      const single = await run("x".repeat(700), files(10), { repoDir: await pmRepo(false) });
      expect(single.calls.map((c) => c.stage)).not.toContain("plan");
      const none = await run("x".repeat(700), files(10));
      expect(none.calls.map((c) => c.stage)).not.toContain("plan");
    });
  });

  it("a normal task that names files skips even in a multi-package repo (plan-scope is seeded from them)", async () => {
    await withStderrTty(false, async () => {
      const r = await run("change mod1.ts and mod2.ts " + "x".repeat(700), files(10), { repoDir: await pmRepo(true) });
      expect(r.calls.map((c) => c.stage)).not.toContain("plan");
      expect(readPlanScope(r.runDir).sort()).toEqual(["src/mod1.ts", "src/mod2.ts"]);
    });
  });

  it("a large task keeps the plan session and its implement brief has no fold instruction", async () => {
    const task = "change " + files(9).map((f) => f.replace("src/", "")).join(" ");
    const { calls, events } = await run(task, files(10));
    expect(calls.map((c) => c.stage).sort()).toEqual(["implement", "plan", "wall"]);
    expect(events.find((e) => e.type === "variant")!.data).toMatchObject({ size: "large", plan_skipped: false });
  });

  it("the fold instruction sits right after FIXED_RULES; the bytes before the task text match the planned brief, and a planned brief has none", () => {
    const planned = buildImplementBrief("add search ranking", "step 1", [], "");
    const skipped = buildImplementBrief("add search ranking", null, [], "");
    expect(planned).not.toContain(FOLD_PLAN_INSTRUCTION);
    const at = skipped.indexOf(FOLD_PLAN_INSTRUCTION);
    const prefix = skipped.slice(0, at);
    expect(prefix.length).toBeGreaterThan(FIXED_RULES.length);
    expect(prefix.endsWith(`${FIXED_RULES}\n\n`)).toBe(true);
    expect(planned.startsWith(prefix)).toBe(true);
    expect(skipped.slice(at + FOLD_PLAN_INSTRUCTION.length + 2).startsWith(planned.slice(prefix.length, prefix.length + 20))).toBe(true);
  });

  it("LOKI_E10_PLAN=1 forces the plan on a small task; =0 skips it on a normal one", async () => {
    process.env.LOKI_E10_PLAN = "1";
    expect((await run("fix mod1.ts", files(3))).calls).toHaveLength(3);
    process.env.LOKI_E10_PLAN = "0";
    expect((await run("x".repeat(700), files(3))).calls).toHaveLength(2);
    expect(planMode({ LOKI_E10_PLAN: "maybe" })).toBe("auto");
  });

  it("LOKI_E10_WALL_TIER overrides the wall model via the catalog alias", () => {
    expect(wallFirstModel("small", {})).toContain("haiku");
    expect(wallFirstModel("normal", {})).toContain("haiku");
    expect(wallFirstModel("large", {})).toBe(wallModel({}));
    for (const env of [{ LOKI_E10_WALL_TIER: "sonnet" }, { LOKI_MODEL_OVERRIDE: "opus" }, { LOKI_E10_WALL_FIRST: "off" }, { LOKI_E10_WALL_CONCURRENT: "1" }]) expect(wallFirstModel("small", env)).toBe(wallModel(env));
    expect(wallModel({ LOKI_E10_WALL_TIER: "haiku" })).toContain("haiku");
    expect(wallModel({ LOKI_E10_WALL_TIER: "my-model-id" })).toBe("my-model-id");
  });

  it("the wall brief is paths only, capped, and under a fixed size", async () => {
    const task = "add a search bar";
    const { calls } = await run(task, files(5000).map((f) => `${f}/${"d".repeat(20)}`));
    const brief = calls.find((c) => c.stage === "wall")!.brief;
    expect(brief.split("\n").filter((l) => l.startsWith("src/mod")).length).toBe(WALL_MAP_MAX_LINES);
    expect(brief.length).toBeLessThan(task.length + 9000);
    const prevSpeed = process.env.LOKI_SPEED; process.env.LOKI_SPEED = "0"; // the speed stage prefix adds a fixed ~200 bytes; this pins the bare brief; measured fixed overhead 918 (TEN-COST-14 output budget line + TEN-QUALITY-14 negative-case sentence + FC-WALL-OUT-OF-REPO-TARGET repo-paths line + task-named-file path sentence)
    try { expect(buildWallBrief(task).length).toBeLessThan(task.length + 930); } finally { if (prevSpeed === undefined) delete process.env.LOKI_SPEED; else process.env.LOKI_SPEED = prevSpeed; }
  });

  it("missing inputs never size small", () => {
    expect(sizeTask("fix a.ts", null, TM).size).toBe("normal");
    expect(sizeTask("fix a.ts", { files: ["a.ts"], entries: [], truncated: false }, null).size).toBe("normal");
    expect(sizeTask("", { files: ["a.ts"], entries: [], truncated: false }, TM).size).toBe("normal");
    const many = sizeTask("touch a.ts b.ts c.ts", { files: ["a.ts", "b.ts", "c.ts"], entries: [], truncated: false }, TM);
    expect(many.size).toBe("normal");
    expect(many.reasons.join()).toContain("names 3 files");
  });

  it("P12-46: a task naming more than 8 files sizes large, never lean, and keeps the normal Wall cap", () => {
    const names = Array.from({ length: 9 }, (_, i) => `f${i}.ts`);
    const big = sizeTask(`touch ${names.join(" ")}`, { files: names, entries: [], truncated: false }, TM);
    expect(big.size).toBe("large");
    expect(big.reasons.join()).toContain("decompose");
    expect(smallTaskPath(big.size, true)).toBe("wall");
    expect(wallLimitS("large")).toBe(180);
    const eight = sizeTask(`touch ${names.slice(0, 8).join(" ")}`, { files: names, entries: [], truncated: false }, TM);
    expect(eight.size).toBe("normal");
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

  it("L1: a first fix round runs on the run's model (no pin); a repeated failure escalates up with the prior diagnosis", async () => {
    const calls: SessionRunOptions[] = [];
    const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
    const first = await fixStage.run(fixCtx(calls, events), new AbortController().signal);
    expect(calls[0]!.model).toBeUndefined();
    expect(events.find((e) => e.type === "fix.round")!.data).toMatchObject({ escalated: false, model: "claude-opus-5-5" });
    const ctx = fixCtx(calls, events);
    ctx.model = "claude-sonnet-5";
    const base = ctx.outputs();
    ctx.outputs = () => ({ ...base, fix: { round: 1, signatures: first.data.signatures, diagnosis: "off by one in a.ts" } });
    const second = await fixStage.run(ctx, new AbortController().signal);
    expect(calls[1]!.model).toBe("claude-opus-5-5");
    expect(modelRank(calls[1]!.model!)).toBeGreaterThanOrEqual(modelRank("claude-sonnet-5"));
    expect(calls[1]!.brief).toContain("off by one in a.ts");
    expect(second.data.cascade).toBe(true);
    expect(events.filter((e) => e.type === "fix.round")[1]!.data).toMatchObject({ escalated: true, escalation_model: "claude-opus-5-5" });
  });

  it("L1: an escalated round is never below the run model, even when the run model outranks the catalog opus", async () => {
    const calls: SessionRunOptions[] = [];
    const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
    const ctx = fixCtx(calls, events);
    ctx.model = "claude-fable-5-1";
    const base = ctx.outputs();
    ctx.outputs = () => ({ ...base, fix: { round: 1, signatures: "bun:a.test.ts" } });
    await fixStage.run(ctx, new AbortController().signal);
    expect(calls[0]!.model).toBe("claude-fable-5-1");
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
    process.env.LOKI_E10_CASCADE = "1"; // opt-in: a non-test round may use the cheap model, and says so
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
    expect(calls[0]!.model).toBeUndefined(); // L1: nothing weaker to pin, the run's model is used
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

  it("L1: the machine runs fix on the run model after a fast-verify failure; a pass-first run never escalates", async () => {
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
    expect(calls.find((c) => c.stage === "implement")!.model).toBeUndefined();
    expect(calls.find((c) => c.stage === "fix")!.model).toBeUndefined();
    expect(events.find((e) => e.type === "fix.round")!.data).toMatchObject({ escalated: false, model: "claude-opus-5-5" });
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

describe("engine10 TEN-COST-26 sizing knobs", () => {
  const map = { files: ["a.ts"], entries: [], truncated: false };
  const long = "fix a.ts " + "x".repeat(691); // 700 chars
  const noRunner: TestMap = { runners: [], tests: [] };
  it("defaults: 700 chars sizes normal; a missing runner no longer disqualifies small", () => {
    expect(sizeTask(long, map, TM).size).toBe("normal");
    expect(sizeTask("fix a.ts", map, noRunner).size).toBe("small");
    expect(sizeTask("fix a.ts " + "x".repeat(591), map, TM).size).toBe("small"); // exactly 600
  });
  it("LOKI_E10_SMALL_MAX_CHARS=800 sizes a 700-char task small; 699 keeps it normal (numeric, not string compare)", () => {
    expect(long.length).toBe(700);
    process.env.LOKI_E10_SMALL_MAX_CHARS = "800";
    expect(sizeTask(long, map, TM).size).toBe("small");
    process.env.LOKI_E10_SMALL_MAX_CHARS = "699";
    expect(sizeTask(long, map, TM).size).toBe("normal");
    process.env.LOKI_E10_SMALL_MAX_CHARS = "1000"; // a string compare would put "700" > "1000"
    expect(sizeTask(long, map, TM).size).toBe("small");
    for (const bad of ["abc", "0", "-5", ""]) { process.env.LOKI_E10_SMALL_MAX_CHARS = bad; expect(sizeTask(long, map, TM).size).toBe("normal"); }
  });
  it("LOKI_E10_SMALL_NO_RUNNER=0 opts out (no-runner is normal); a missing map is always normal", () => {
    process.env.LOKI_E10_SMALL_NO_RUNNER = "1";
    expect(sizeTask("fix a.ts", map, noRunner).size).toBe("small");
    expect(sizeTask("fix a.ts", null, noRunner).size).toBe("normal");
    process.env.LOKI_E10_SMALL_NO_RUNNER = "0";
    expect(sizeTask("fix a.ts", map, noRunner).size).toBe("normal");
  });
  it("through the machine: a no-runner one-file task skips plan and writes the plan-scope.json the guard reads; a multi-file task now skips too and seeds all its files; a large task still plans", async () => {
    const noRun: TestMap = { runners: [], tests: [] };
    const one = await run("fix the off-by-one in mod1.ts", files(10), { testmap: noRun });
    expect(one.calls.map((c) => c.stage)).not.toContain("plan");
    expect(readPlanScope(one.runDir)).toEqual(["src/mod1.ts"]);
    expect(planOutOfRepo(one.runDir)).toBeNull();
    const multi = await run("fix mod1.ts mod2.ts mod3.ts together", files(10), { testmap: noRun });
    expect(multi.calls.map((c) => c.stage)).not.toContain("plan");
    expect(readPlanScope(multi.runDir).sort()).toEqual(["src/mod1.ts", "src/mod2.ts", "src/mod3.ts"]);
    const large = await run("fix " + files(9).map((f) => f.replace("src/", "")).join(" "), files(10), { testmap: noRun });
    expect(large.calls.map((c) => c.stage)).toContain("plan");
  });
  it("a no-runner small task still routes to wall, never lean", () => {
    process.env.LOKI_E10_SMALL_NO_RUNNER = "1";
    expect(smallTaskPath(sizeTask("fix a.ts", map, noRunner).size, false)).toBe("wall");
  });
  it("through the machine: a 700-char task with the knob emits size small in the variant event", async () => {
    process.env.LOKI_E10_SMALL_MAX_CHARS = "800";
    const { events } = await run("fix the off-by-one in mod1.ts " + "x".repeat(670), files(10));
    expect(events.find((e) => e.type === "variant")!.data).toMatchObject({ size: "small" });
  });
});

describe("clamp note", () => {
  const capture = (fn: () => unknown): string => {
    const orig = process.stderr.write.bind(process.stderr); let out = "";
    (process.stderr as { write: unknown }).write = (c: string | Uint8Array) => { out += String(c); return true; };
    try { fn(); } finally { (process.stderr as { write: unknown }).write = orig; }
    return out;
  };
  it("notes a wall limit above 300 once and still returns 300", () => {
    let v = 0;
    const err = capture(() => { v = wallLimitS("normal", { LOKI_E10_WALL_LIMIT_S: "777" } as NodeJS.ProcessEnv); wallLimitS("normal", { LOKI_E10_WALL_LIMIT_S: "777" } as NodeJS.ProcessEnv); });
    expect(v).toBe(300);
    expect(err).toContain('LOKI_E10_WALL_LIMIT_S="777"');
    expect(err.match(/LOKI_E10_WALL_LIMIT_S/g)?.length).toBe(1);
  });
  it("notes an invalid small max chars and still returns 600; unset and valid are silent", () => {
    let v = 0;
    const err = capture(() => { v = smallMaxChars({ LOKI_E10_SMALL_MAX_CHARS: "zzz" } as NodeJS.ProcessEnv); });
    expect(v).toBe(600);
    expect(err).toContain('LOKI_E10_SMALL_MAX_CHARS="zzz"');
    expect(capture(() => { smallMaxChars({} as NodeJS.ProcessEnv); smallMaxChars({ LOKI_E10_SMALL_MAX_CHARS: "50" } as NodeJS.ProcessEnv); wallLimitS("small", { LOKI_E10_WALL_LIMIT_S: "120" } as NodeJS.ProcessEnv); })).toBe("");
  });
});

describe("Wall concurrency and output bound knobs", () => {
  it("unset is concurrent only where sonnet is already the Wall model; 0/off/false opt out; 1/on/true force it", () => {
    expect(wallConcurrent({})).toBe(false); // small and normal default runs keep haiku-first sequential
    for (const pin of [{ LOKI_E10_WALL_TIER: "sonnet" }, { LOKI_MODEL_OVERRIDE: "opus" }, { LOKI_E10_WALL_FIRST: "0" }]) expect(wallConcurrent(pin)).toBe(true);
    for (const v of ["0", "off", "false", "OFF"]) expect(wallConcurrent({ LOKI_E10_WALL_CONCURRENT: v, LOKI_E10_WALL_TIER: "sonnet" })).toBe(false);
    for (const v of ["1", "on", "true"]) expect(wallConcurrent({ LOKI_E10_WALL_CONCURRENT: v })).toBe(true);
  });
  it("LOKI_E10_WALL_MAX_TOKENS defaults to 16000, honors a positive integer, rejects the rest", () => {
    expect(wallMaxTokens({})).toBe(16000);
    expect(wallMaxTokens({ LOKI_E10_WALL_MAX_TOKENS: "4096" })).toBe(4096);
    for (const bad of ["x", "0", "-1", "2.5", "1e3", "0x10", "+5", " 5", "5 ", "1 000", "9007199254740992", "99999999999999999999"]) expect(wallMaxTokens({ LOKI_E10_WALL_MAX_TOKENS: bad })).toBe(16000);
    expect(wallMaxTokens({ LOKI_E10_WALL_MAX_TOKENS: "9007199254740991" })).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("a rejected value warns once", () => {
    const w = process.stderr.write.bind(process.stderr), seen: string[] = [];
    process.stderr.write = ((c: string | Uint8Array) => { seen.push(String(c)); return true; }) as typeof process.stderr.write;
    try { for (let i = 0; i < 3; i++) wallMaxTokens({ LOKI_E10_WALL_MAX_TOKENS: "0x1F" }); } finally { process.stderr.write = w; }
    expect(seen.filter((l) => l.includes("LOKI_E10_WALL_MAX_TOKENS"))).toHaveLength(1);
  });
  it("wallOutputCap: unset knob yields to an inherited user bound, a set knob wins, neither gives the default", () => {
    expect(wallOutputCap({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "5000" })).toBeUndefined();
    expect(wallOutputCap({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "5000", LOKI_E10_WALL_MAX_TOKENS: "6000" })).toBe(6000);
    expect(wallOutputCap({})).toBe(16000);
  });
  it("the session child env carries the bound only when the call sets one", () => {
    const base = { stage: "wall", brief: "b", tier: "development", iterationId: "i", limitS: 10, signal: new AbortController().signal } as SessionRunOptions;
    expect(childEnv({ ...base, maxOutputTokens: 5000 }, { provider: "claude" }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("5000");
    expect(childEnv(base, { provider: "claude" }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  });
});

describe("namedFiles exact tokens", () => {
  const m = (files: string[]) => ({ files, entries: [], truncated: false });
  it("does not match a longer name that merely contains the file name", () => {
    expect(namedFiles("edit myindex.ts", m(["src/index.ts"]))).toEqual([]);
    expect(namedFiles("edit index.tsx", m(["src/index.ts"]))).toEqual([]);
    expect(namedFiles("edit my-index.ts and index.ts.bak", m(["src/index.ts"]))).toEqual([]);
    expect(namedFiles("edit index.ts", m(["src/myindex.ts", "src/index.tsx", "src/index.ts"]))).toEqual(["src/index.ts"]);
  });
  it("matches a path named in the task", () => {
    expect(namedFiles("fix the bug in src/app.py", m(["src/app.py", "src/other.py"]))).toEqual(["src/app.py"]);
  });
  it("matches through surrounding punctuation", () => {
    for (const t of ["see `app.py`, then", "fix (app.py)", "update app.py.", "update app.py, then", "\"app.py\":"]) expect(namedFiles(t, m(["app.py"]))).toEqual(["app.py"]);
  });
  it("does not match a bare word to a file with an extension", () => {
    expect(namedFiles("refactor main", m(["cmd/main.go"]))).toEqual([]);
    expect(namedFiles("refactor the main.goal", m(["cmd/main.go"]))).toEqual([]);
    expect(namedFiles("refactor main.go", m(["cmd/main.go"]))).toEqual(["cmd/main.go"]);
  });
});
