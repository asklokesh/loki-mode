// E-45 wall check: small tasks make 2 sessions (wall on sonnet, implement), normal 3;
// the wall brief stays under a fixed size; the variant is recorded.
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMachine } from "../../src/engine10/machine.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import { readFileSync } from "node:fs";
import { planMode, sizeTask, wallModel } from "../../src/engine10/sizing.ts";
import { planStage } from "../../src/engine10/stages/plan.ts";
import { wallStage, buildWallBrief, WALL_MAP_MAX_LINES } from "../../src/engine10/stages/wall.ts";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import type { RunContext, SessionRunOptions, Stage, StageName, TestMap } from "../../src/engine10/types.ts";

const dirs: string[] = [];
const saved = { ...process.env };
afterEach(() => { for (const k of ["LOKI_E10_PLAN", "LOKI_E10_WALL", "LOKI_E10_WALL_TIER"]) delete process.env[k]; });
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); process.env = saved; });

const TM: TestMap = { runners: ["bun"], tests: [{ runner: "bun", path: "tests/a.test.ts" }] };
const files = (n: number) => Array.from({ length: n }, (_, i) => `src/mod${i}.ts`);

async function run(task: string, repoFiles: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "loki-e45-"));
  dirs.push(dir);
  const repomapRef = join(dir, "repomap.json");
  writeFileSync(repomapRef, JSON.stringify({ files: repoFiles, entries: [], truncated: false }));
  const calls: SessionRunOptions[] = [];
  const events: { type: string; stage: string | null; data: Record<string, unknown> }[] = [];
  const intake: Stage = { name: "intake", targetS: 1, limitS: 5, run: async () => ({ status: "completed", data: { task, repomap_ref: repomapRef, testmap: TM } }) };
  const stages: Partial<Record<StageName, Stage>> = { intake, plan: planStage, wall: wallStage, implement: implementStage };
  const ctx: RunContext = {
    runId: "e10-e45", repoDir: dir, runDir: dir, baseSha: "abc", branch: "loki/e10-e45", provider: "claude", model: "run-model",
    deep: false, capS: 900,
    emit: (type, stage, data) => { events.push({ type, stage, data }); },
    sessions: { run: async (o) => { calls.push(o); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } },
    tests: { detect: async () => TM, impacted: () => [] },
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
    expect(calls.find((c) => c.stage === "implement")!.model).toBeUndefined();
    expect(calls.find((c) => c.stage === "implement")!.brief).toContain("plan the change yourself");
    const skipped = events.find((e) => e.type === "stage.skipped" && e.stage === "plan");
    expect(skipped?.data.reason).toBe("small task: implementer plans");
    const v = events.find((e) => e.type === "variant")!;
    expect(v.data).toMatchObject({ size: "small", plan_skipped: true, wall_model: wallModel() });
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

  it("session.ts pins the tier model env for a session that sets model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loki-e45-s-"));
    dirs.push(dir);
    const r = createSessionRunner({ provider: "claude", childCommand: ["/bin/sh", ["-c", 'printf %s "$LOKI_CLAUDE_MODEL_DEVELOPMENT" > out.txt']] });
    await r.run({ stage: "wall", brief: "b", tier: "development", model: "claude-sonnet-x", iterationId: "i", limitS: 10, signal: new AbortController().signal, cwd: dir });
    expect(readFileSync(join(dir, "out.txt"), "utf8")).toBe("claude-sonnet-x");
  });
});
