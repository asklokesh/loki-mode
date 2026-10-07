// Engine Law L1 "Never below raw" (supersedes the D31 sonnet-first cascade default).
// Behavior tests plus a static guard: no stage may pass a model weaker than the run's model unless the
// LOKI_E10_CASCADE opt-in is set. The guard is a pure function over source text so a mutation test can prove it bites.
import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cascadeDowngrade, cascadeEnabled, escalationModel, modelRank } from "../../src/engine10/sizing.ts";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import type { RunContext, SessionRunOptions } from "../../src/engine10/types.ts";

const SRC = join(import.meta.dir, "../../src/engine10");
afterEach(() => { delete process.env.LOKI_E10_CASCADE; });

function ctxFor(model: string, calls: SessionRunOptions[], outputs: RunContext["outputs"] = () => ({ intake: { task: "t" } })): RunContext {
  return {
    runId: "e10-l1", repoDir: "/tmp", runDir: "/tmp", baseSha: "abc", branch: "b", provider: "claude", model, deep: false, capS: 900,
    emit: () => {},
    sessions: { run: async (o) => { calls.push(o); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0, killed: false }; } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() },
    outputs,
  };
}

describe("L1 behavior", () => {
  it("default run: implement gets the run model (no pin) and nothing is printed", async () => {
    const calls: SessionRunOptions[] = [];
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string) => { written.push(String(c)); return true; }) as typeof process.stderr.write;
    try {
      const r = await implementStage.run(ctxFor("claude-opus-5-5", calls), new AbortController().signal);
      expect(calls[0]!.model).toBeUndefined();
      expect(r.data.cascade).toBe(false);
      expect(r.data.model_downgrade).toBeUndefined();
      expect(written.join("")).not.toContain("downgraded");
    } finally { process.stderr.write = orig; }
  });

  it("opt-in: implement gets the downgraded model, the downgrade is printed and recorded", async () => {
    process.env.LOKI_E10_CASCADE = "1";
    const calls: SessionRunOptions[] = [];
    const written: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string) => { written.push(String(c)); return true; }) as typeof process.stderr.write;
    try {
      const r = await implementStage.run(ctxFor("claude-opus-5-5", calls), new AbortController().signal);
      expect(calls[0]!.model).toBe("claude-sonnet-5-5");
      const note = "model downgraded by cascade: claude-opus-5-5 -> claude-sonnet-5-5 (opt-in)";
      expect(written.join("")).toContain(note);
      expect(r.data.model_downgrade).toBe(note);
    } finally { process.stderr.write = orig; }
  });

  it("opt-in never downgrades a run that is already on the cascade model or weaker", () => {
    process.env.LOKI_E10_CASCADE = "1";
    expect(cascadeDowngrade("claude-sonnet-5")).toBeNull();
    expect(cascadeDowngrade("claude-haiku-4-5")).toBeNull();
  });

  it("repeated failure: the escalated model is at or above the run model, for every run model", async () => {
    for (const run of ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1"]) {
      expect(modelRank(escalationModel(run))).toBeGreaterThanOrEqual(modelRank(run));
      const calls: SessionRunOptions[] = [];
      const g = [{ signature: "bun:a.test.ts", count: 1, sample: "FULL OUTPUT" }];
      await fixStage.run(ctxFor(run, calls, () => ({ intake: { task: "t" }, verify: { failures_grouped: g }, fix: { round: 1, signatures: "bun:a.test.ts", diagnosis: "my diagnosis" } })), new AbortController().signal);
      expect(modelRank(calls[0]!.model ?? run)).toBeGreaterThanOrEqual(modelRank(run));
      expect(calls[0]!.brief).toContain("my diagnosis");
      expect(calls[0]!.brief).toContain("FULL OUTPUT");
    }
  });

  it("the real session runner captures the agent's final message and the escalated brief carries it", async () => {
    const stub = join(import.meta.dir, "fixtures", "session", "stub_final.sh");
    const runner = createSessionRunner({ provider: "claude", childCommand: ["bash", [stub]] });
    const res = await runner.run({ stage: "implement", brief: "b", tier: "development", iterationId: "e10-l1-sum", limitS: 30, signal: new AbortController().signal });
    expect(res.summary).toContain("DIAGNOSIS: the off-by-one is in parse()");
    const g = [{ signature: "bun:a.test.ts", count: 1, sample: "FULL OUTPUT" }];
    const calls: SessionRunOptions[] = [];
    const first = await fixStage.run({ ...ctxFor("claude-opus-5-5", calls, () => ({ intake: { task: "t" }, verify: { failures_grouped: g } })), sessions: runner }, new AbortController().signal);
    expect(first.data.diagnosis).toContain("DIAGNOSIS: the off-by-one is in parse()");
    const second = await fixStage.run(ctxFor("claude-sonnet-5", calls, () => ({ intake: { task: "t" }, verify: { failures_grouped: g }, fix: { round: 1, signatures: first.data.signatures, diagnosis: first.data.diagnosis } })), new AbortController().signal);
    expect(second.data.cascade).toBe(true);
    expect(calls[calls.length - 1]!.brief).toContain("DIAGNOSIS: the off-by-one is in parse()");
  }, 15_000);

  it("a fix round on a first failure never picks a lower model than the run model", async () => {
    const calls: SessionRunOptions[] = [];
    await fixStage.run(ctxFor("claude-opus-5-5", calls, () => ({ intake: { task: "t" }, verify: { failures_grouped: [{ signature: "bun:a", count: 1, sample: "s" }] } })), new AbortController().signal);
    expect(calls[0]!.model).toBeUndefined();
  });
});

/**
 * Static guard. Returns violations for a set of {path: source}. Rules:
 * 1. cascadeEnabled must be an opt-in: defined with a ["1", "on", "true"] word list and never negated.
 * 2. A session model pin (`model:` inside a sessions.run options object) may only be `downgrade.to`,
 *    `pinnedModel`, `wallModel()` in the check-only files wall.ts and already_done.ts, or plan.ts's Opus-only pin (R1-10).
 * 3. implement.ts and fix.ts must obtain their pin only through cascadeDowngrade / escalationModel.
 */
export function guardViolations(files: Record<string, string>): string[] {
  const v: string[] = [];
  const sizing = files["sizing.ts"] ?? "";
  if (!/export const cascadeEnabled = \(env = process\.env\): boolean => knob\(env\.LOKI_E10_CASCADE, \["1", "on", "true"\]\);/.test(sizing)) v.push("sizing.ts: cascadeEnabled is not the opt-in form");
  const allowed: Record<string, RegExp> = {
    "stages/implement.ts": /^downgrade \? \{ model: downgrade\.to \}/,
    "stages/fix.ts": /^pinnedModel \? \{ model: pinnedModel \}/,
    "stages/plan.ts": /^pinOpus \? \{ model: "opus" \} : \{\}\),$/, // R1-10: only ever Opus, never weaker
    "stages/wall.ts": /^wallModel\(\),/,
    "already_done.ts": /^wallModel\(\),/,
  };
  for (const [path, src] of Object.entries(files)) {
    if (path.startsWith("dashboard/") || path === "types.ts" || path === "session.ts" || path === "cost.ts") continue;
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/(?:\.\.\.\(\w+ \? \{ )?\bmodel(?:: | \?)(.*)$/);
      if (!m || /ctx\.model|^\s*(\/\/|\*)/.test(line) || !/sessions\.run|\.\.\.\(|^\s*model: (wallModel|downgrade|pinned)/.test(line)) return;
      const expr = line.slice(line.indexOf("model") === -1 ? 0 : 0).trim().replace(/^\.\.\.\(/, "").replace(/^model: /, "");
      const ok = allowed[path];
      if (!ok || !ok.test(expr)) v.push(`${path}:${i + 1}: unvetted session model pin: ${line.trim()}`);
    });
  }
  const fixSrc = files["stages/fix.ts"] ?? "";
  if (!fixSrc.includes("const pinnedModel = repeated ? escalationModel(ctx.model) : downgrade && testFailures.length === 0 ? downgrade.to : undefined;")) v.push("fix.ts: pinnedModel is not computed from escalationModel/downgrade only");
  const impl = files["stages/implement.ts"] ?? "";
  if (!impl.includes("cascadeDowngrade(ctx.model)")) v.push("implement.ts: pin does not come from cascadeDowngrade");
  const fix = files["stages/fix.ts"] ?? "";
  if (!fix.includes("escalationModel(ctx.model)") || !fix.includes("cascadeDowngrade(ctx.model)")) v.push("fix.ts: pin does not come from escalationModel/cascadeDowngrade");
  return v;
}

function loadFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, `${rel}${name}/`);
      else if (name.endsWith(".ts")) out[`${rel}${name}`] = readFileSync(full, "utf8");
    }
  };
  walk(SRC, "");
  return out;
}

describe("L1 static guard", () => {
  it("the shipped source passes: cascade is opt-in and no stage pins a weaker model unvetted", () => {
    expect(guardViolations(loadFiles())).toEqual([]);
    expect(cascadeEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(cascadeEnabled({ LOKI_E10_CASCADE: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("mutation: flipping the default to on makes the guard fail", () => {
    const f = loadFiles();
    f["sizing.ts"] = f["sizing.ts"]!.replace('knob(env.LOKI_E10_CASCADE, ["1", "on", "true"])', '!knob(env.LOKI_E10_CASCADE, ["0", "off", "false"])');
    expect(guardViolations(f).length).toBeGreaterThan(0);
  });

  it("mutation M5: pinning a non-test fix round to haiku without opt-in makes the guard fail", () => {
    const f = loadFiles();
    const before = f["stages/fix.ts"]!;
    f["stages/fix.ts"] = before.replace("downgrade && testFailures.length === 0 ? downgrade.to : undefined", 'testFailures.length === 0 ? "claude-haiku-4-5" : undefined');
    expect(f["stages/fix.ts"]).not.toBe(before);
    expect(guardViolations(f).length).toBeGreaterThan(0);
  });

  it("mutation: a new stage pinning a cheap model unconditionally makes the guard fail", () => {
    const f = loadFiles();
    f["stages/implement.ts"] = f["stages/implement.ts"]!.replace("...(downgrade ? { model: downgrade.to } : {}),", "model: wallModel(),");
    expect(guardViolations(f).length).toBeGreaterThan(0);
  });

  it("mutation: a same-line extra pin in plan.ts is rejected by the anchored allowlist", () => {
    const f = loadFiles();
    f["stages/plan.ts"] = f["stages/plan.ts"]!.replace("...(pinOpus ? { model: \"opus\" } : {}),", "...(pinOpus ? { model: \"opus\" } : {}), ...(x ? {model:\"haiku\"}:{}),");
    expect(guardViolations(f).length).toBeGreaterThan(0);
  });
});
