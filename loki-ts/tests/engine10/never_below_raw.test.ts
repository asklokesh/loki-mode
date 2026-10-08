// Engine Law L1 "Never below raw" (supersedes the D31 sonnet-first cascade default).
// Behavior tests plus a SECONDARY static guard: no stage may pass a model weaker than the run's model unless the
// LOKI_E10_CASCADE opt-in is set. The PRIMARY router guard is semantic: route_matrix.test.ts runs implement, fix, plan and the
// machine's stall path through fake sessions and route_matrix_mutation.test.ts proves it red for every bypass form. This text
// guard is a pure function over source so a mutation test can prove it bites; it also covers runner/model_rank.ts and runner/router/unit_model.ts.
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
 *    `pinnedModel`, `wallModel()` in the check-only files wall.ts and already_done.ts (plan.ts has no pin of its own: R1-10's Opus-only pin lives in plan_route.ts).
 * 3. implement.ts and fix.ts must obtain their pin only through cascadeDowngrade / escalationModel.
 */
const FIX_ROUTED_DEF = /const \{ pin: routedPin, climbed \} = routed \? routedFix\(/;
export function guardViolations(files: Record<string, string>): string[] {
  const v: string[] = [];
  const sizing = files["sizing.ts"] ?? "";
  if (!/export const cascadeEnabled = \(env = process\.env\): boolean => knob\(env\.LOKI_E10_CASCADE, \["1", "on", "true"\]\);/.test(sizing)) v.push("sizing.ts: cascadeEnabled is not the opt-in form");
  const allowed: Record<string, RegExp> = {
    "stages/implement.ts": /^downgrade \? \{ model: downgrade\.to \}/,
    "stages/fix.ts": /^pinnedModel \? \{ model: pinnedModel \}/,
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
      if (path === "stages/fix.ts" && /^routedPin \? \{ model: routedPin \} : \{\}\)/.test(expr) && FIX_ROUTED_DEF.test(src)) return; // evidence-backed router pin, checked structurally below
      if (!ok || !ok.test(expr)) v.push(`${path}:${i + 1}: unvetted session model pin: ${line.trim()}`);
    });
  }
  // ROUTER-1: a model below the run model is allowed only when a router route record exists for that unit with its evidence (source plus reason).
  for (const path of ["stages/implement.ts", "stages/fix.ts"]) {
    const lines = (files[path] ?? "").split("\n");
    lines.forEach((line, i) => {
      if (!/\b\w+\.model = /.test(line) || /^\s*\/\//.test(line)) return;
      const recorded = /ctx\.emit\("route", .*\bsource\b.*\breason\b/.test(line) || /ctx\.emit\("route\.escalated"/.test(lines[i - 1] ?? "");
      if (!recorded) v.push(`${path}:${i + 1}: model assigned with no router route record (source plus reason): ${line.trim()}`);
    });
  }
  // Secondary: a haiku model token may appear only on the vetted lines (the router's single haiku producer lives in unit_model.ts).
  const HAIKU_OK: Record<string, RegExp[]> = {
    "../runner/router/plan_route.ts": [/^export const ROUTER_UNITS_INSTRUCTION/],
    "../runner/model_rank.ts": [/^export const modelRank/, /^\s*const model = k\.includes\("haiku"\)/],
    "../runner/router/unit_model.ts": [/^const isHaiku = /, /^export function validHaikuRoute/, /r\["executor"\] !== "haiku"/, /^\s*return v \? \{ model: resolveModelAlias\("haiku"\), source: "opus-plan", reason: v\.reason, valid: true \} : \{ model: runFloor\(runModel\)/, /unitRedo\(isHaiku\(cur\) \? "haiku"/, /^\s*const v = (routerPinsAllowed\(\) \? )?validHaikuRoute\(plan\)( : null)?;$/, /^export const floorNoAdvisor/],
  };
  for (const path of ["stages/implement.ts", "stages/fix.ts", "stages/plan.ts", "machine.ts", "session.ts", "cost.ts", "../runner/model_rank.ts", "../runner/router/unit_model.ts", "../runner/router/plan_route.ts"]) {
    (files[path] ?? "").split("\n").forEach((line, i) => {
      const code = line.replace(/\s\/\/.*$/, "");
      if (/^\s*(\/\/|\*|\/\*)/.test(code) || !/haiku/i.test(code)) return;
      if (!(HAIKU_OK[path] ?? []).some((re) => re.test(code))) v.push(`${path}:${i + 1}: unvetted haiku model token: ${line.trim()}`);
    });
  }
  const fixSrc = files["stages/fix.ts"] ?? "";
  if (/routedPin/.test(fixSrc) && !FIX_ROUTED_DEF.test(fixSrc)) v.push("fix.ts: routedPin is not derived from routedFix under the router flag");
  if (!fixSrc.includes("const pinnedModel = routed && !routerPinsAllowed() ? undefined : repeated ? escalationModel(ctx.model) : downgrade && testFailures.length === 0 ? downgrade.to : undefined;")) v.push("fix.ts: pinnedModel is not computed from escalationModel/downgrade only");
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
  for (const rel of ["runner/model_rank.ts", "runner/router/unit_model.ts", "runner/router/plan_route.ts"]) out[`../${rel}`] = readFileSync(join(SRC, "..", rel), "utf8");
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

  it("mutation R1: an unconditional downgrade below the run model with no route record turns the guard red", () => {
    const f = loadFiles();
    const impl = f["stages/implement.ts"]!;
    f["stages/implement.ts"] = impl.replace(/if \(rr\) \{ if \(routerPinsAllowed\(\)\) first\.model = current; ctx\.emit\("route".*\n/, 'first.model = "claude-haiku-4-5";\n');
    expect(f["stages/implement.ts"]).not.toBe(impl);
    expect(guardViolations(f).some((x) => x.includes("no router route record"))).toBe(true);
    const g = loadFiles();
    const fix = g["stages/fix.ts"]!;
    g["stages/fix.ts"] = fix.replace(/const \{ pin: routedPin, climbed \} = routed \? routedFix\(.*\n/, 'const routedPin = "claude-haiku-4-5", climbed = null;\n');
    expect(g["stages/fix.ts"]).not.toBe(fix);
    expect(guardViolations(g).length).toBeGreaterThan(0);
    const h = loadFiles();
    const esc = h["stages/implement.ts"]!;
    h["stages/implement.ts"] = esc.replace(/ctx\.emit\("route\.escalated", "implement", \{ \.\.\.esc \}\);\n/, "");
    expect(h["stages/implement.ts"]).not.toBe(esc);
    expect(guardViolations(h).some((x) => x.includes("no router route record"))).toBe(true);
  });

  it("mutation: a haiku producer in model_rank.ts or unit_model.ts turns the secondary guard red", () => {
    const a = loadFiles();
    a["../runner/model_rank.ts"] = a["../runner/model_rank.ts"]!.replace("to: resolveModelAlias(next)", 'to: resolveModelAlias("haiku")');
    expect(guardViolations(a).some((x) => x.includes("model_rank.ts") && x.includes("haiku"))).toBe(true);
    const b = loadFiles();
    b["../runner/router/unit_model.ts"] = b["../runner/router/unit_model.ts"]!.replace("model: runFloor(runModel), source", 'model: resolveModelAlias("haiku"), source');
    expect(guardViolations(b).some((x) => x.includes("unit_model.ts") && x.includes("haiku"))).toBe(true);
    const c = loadFiles();
    c["stages/fix.ts"] = c["stages/fix.ts"]!.replace("const actualModel = routedPin ?? pinnedModel ?? ctx.model;", 'const actualModel = "claude-haiku-5-5";');
    expect(guardViolations(c).some((x) => x.includes("fix.ts") && x.includes("haiku"))).toBe(true);
  });

  it("mutation: a new stage pinning a cheap model unconditionally makes the guard fail", () => {
    const f = loadFiles();
    f["stages/implement.ts"] = f["stages/implement.ts"]!.replace("...(downgrade ? { model: downgrade.to } : {}),", "model: wallModel(),");
    expect(guardViolations(f).length).toBeGreaterThan(0);
  });

  it("mutation: a same-line extra pin in plan_route.ts is rejected by the anchored allowlist", () => {
    const f = loadFiles();
    const before = f["../runner/router/plan_route.ts"]!;
    f["../runner/router/plan_route.ts"] = before.replace("pin: pinOpus ? { model: \"opus\" } : {},", "pin: pinOpus ? { model: \"opus\" } : {}, ...(x ? {model:\"haiku\"}:{}),");
    expect(f["../runner/router/plan_route.ts"]).not.toBe(before);
    expect(guardViolations(f).length).toBeGreaterThan(0);
  });
});
