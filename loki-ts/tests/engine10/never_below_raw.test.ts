// select: walk-all-src
// Engine Law L1 "Never below raw" (supersedes the D31 sonnet-first cascade default).
// Behavior tests plus a SECONDARY static guard: no stage may pass a model weaker than the run's model unless the
// LOKI_E10_CASCADE opt-in is set. The PRIMARY router guard is semantic: route_matrix.test.ts runs implement, fix, plan and the
// machine's stall path through fake sessions and route_matrix_mutation.test.ts proves it red for every bypass form. This text
// guard is a pure function over source so a mutation test can prove it bites; it also covers runner/model_rank.ts and runner/router/unit_model.ts.
import { afterEach, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { cascadeDowngrade, cascadeEnabled, escalationModel, haikuFirstDowngrade, modelRank } from "../../src/engine10/sizing.ts";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import { createSessionRunner } from "../../src/engine10/session.ts";
import type { RunContext, SessionRunOptions } from "../../src/engine10/types.ts";

const SRC = join(import.meta.dir, "../../src/engine10");
afterEach(() => { delete process.env.LOKI_E10_CASCADE; delete process.env.LOKI_IMPLEMENT_HAIKU_FIRST; });

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

  it("TEN-COST-16 haiku-first: off by default; on pins implement to haiku; fix after failed verify runs the run model", async () => {
    const run = "claude-sonnet-5-5";
    const off: SessionRunOptions[] = [];
    await implementStage.run(ctxFor(run, off), new AbortController().signal);
    expect(off[0]!.model).toBeUndefined();
    process.env.LOKI_IMPLEMENT_HAIKU_FIRST = "1";
    try {
      expect(haikuFirstDowngrade("claude-haiku-4-5")).toBeNull();
      const on: SessionRunOptions[] = [];
      const r = await implementStage.run(ctxFor(run, on), new AbortController().signal);
      expect(modelRank(on[0]!.model ?? run)).toBeLessThan(modelRank(run));
      expect(String(r.data.model_downgrade)).toContain("haiku-first");
      const g = [{ signature: "bun:a.test.ts", count: 1, sample: "S" }];
      const fx: SessionRunOptions[] = [];
      await fixStage.run(ctxFor(run, fx, () => ({ intake: { task: "t" }, implement: { model: on[0]!.model }, verify: { failures_grouped: g } })), new AbortController().signal);
      expect(fx[0]!.model).toBeUndefined();
      const fx2: SessionRunOptions[] = [];
      await fixStage.run(ctxFor(run, fx2, () => ({ intake: { task: "t" }, verify: { failures_grouped: g }, fix: { round: 1, signatures: "bun:a.test.ts", diagnosis: "d" } })), new AbortController().signal);
      expect(modelRank(fx2[0]!.model ?? run)).toBeGreaterThanOrEqual(modelRank(run));
    } finally { delete process.env.LOKI_IMPLEMENT_HAIKU_FIRST; }
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
    // seal.ts: the receipt `model` field records the run model (or the external label); it configures no session (CW-12 B3, 9efb8eca0).
    "stages/seal.ts": /^externalRun\(o\) \? EXTERNAL_MODEL_LABEL : ctx\.model,/,
    // HV1-02: the check-only pin is capped to the run's own tier (a haiku run stays on haiku), never lowered below it.
    "already_done.ts": /^(wallModel\(\)|capToRunTier\(wallModel\(\), ctx\.model, \["LOKI_E10_WALL_TIER", "LOKI_MODEL_OVERRIDE"\]\)),/,
    // xreview: the model flag is the user-configured reviewer agent model (council/role_agents.ts), claude judge only; never a cascade or cost downgrade.
    "stages/xreview.ts": /^: \[cli, "-p", prompt, \.\.\.\(model \? \["--model", model\] : \[\]\), "--allowedTools", "Read,Grep,Glob", "--disallowedTools", "Write,Edit,NotebookEdit,Bash", \.\.\.leanReviewerFlags\(\{ env, flagSupported \}\), "--output-format", "json"\];$/,
  };
  for (const [path, src] of Object.entries(files)) {
    if (path.startsWith("dashboard/") || path === "types.ts" || path === "session.ts" || path === "cost.ts") continue;
    const ok = allowed[path];
    const sf = ts.createSourceFile(path, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const routedOk = (e: string): boolean => path === "stages/fix.ts" && /^routedPin \? \{ model: routedPin \} : \{\}$/.test(e) && FIX_ROUTED_DEF.test(src);
    const vetted = (e: string): boolean => (ok !== undefined && ok.test(e)) || routedOk(e);
    const skipParens = (n: ts.Node): ts.Node => (ts.isParenthesizedExpression(n) ? skipParens(n.expression) : n);
    const nameOf = (q: ts.ObjectLiteralElementLike): string | undefined => (q.name && (ts.isIdentifier(q.name) || ts.isStringLiteral(q.name)) ? q.name.text : undefined);
    // An object literal that is `...(cond ? { ..model.. } : {})` is judged through the spread; return that spread, if any.
    const spreadOf = (obj: ts.ObjectLiteralExpression): ts.SpreadAssignment | undefined => {
      let n: ts.Node = obj.parent;
      while (n && !ts.isSpreadAssignment(n) && (ts.isConditionalExpression(n) || ts.isParenthesizedExpression(n))) n = n.parent;
      return n && ts.isSpreadAssignment(n) ? n : undefined;
    };
    // A conditional spread hoisted to a const (`const extra = cond ? { model: x } : {}; run({ ...extra })`) is judged exactly like the inline spread.
    const spreadNames = new Set<string>();
    const collectSpreads = (n: ts.Node): void => {
      if (ts.isSpreadAssignment(n)) { const e = skipParens(n.expression); if (ts.isIdentifier(e)) spreadNames.add(e.text); }
      ts.forEachChild(n, collectSpreads);
    };
    collectSpreads(sf);
    const hoistedOf = (obj: ts.ObjectLiteralExpression): ts.VariableDeclaration | undefined => {
      let n: ts.Node = obj.parent;
      while (n && (ts.isConditionalExpression(n) || ts.isParenthesizedExpression(n))) n = n.parent;
      return n &&ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && spreadNames.has(n.name.text) && n.initializer && ts.isConditionalExpression(skipParens(n.initializer)) ? n : undefined;
    };
    // A `model` key inside an event data object (`data: { ... }` or `const data = { ... }`) describes the run; it is not a session pin.
    // Only the nearest enclosing object counts, so a pin elsewhere in the same statement or after the data object closed is still judged.
    const isData = (obj: ts.ObjectLiteralExpression): boolean => {
      const sp = spreadOf(obj);
      const par = (sp ? sp.parent : obj).parent;
      return !!par && ((ts.isPropertyAssignment(par) && nameOf(par) === "data") || (ts.isVariableDeclaration(par) && ts.isIdentifier(par.name) && par.name.text === "data"));
    };
    const condSpreads = (obj: ts.ObjectLiteralExpression): ts.ConditionalExpression[] =>
      obj.properties.flatMap((q) => { const c = ts.isSpreadAssignment(q) ? skipParens(q.expression) : undefined; return c && ts.isConditionalExpression(c) ? [c] : []; });
    const calleeOf = (obj: ts.ObjectLiteralExpression): string => (ts.isCallExpression(obj.parent) ? obj.parent.expression.getText(sf) : "");
    // An explicit `model:` key is in scope when the object has ANY conditional spread (the shape of a session options object);
    // a shorthand `model` only when a conditional spread sets effort or model, because event payloads spread unrelated keys.
    const inScope = (obj: ts.ObjectLiteralExpression, prop: ts.ObjectLiteralElementLike, init: string): boolean => {
      if (/\.(emit|append)$/.test(calleeOf(obj))) return false; // event payloads describe the run; they never configure a session
      if (spreadOf(obj) !== undefined || hoistedOf(obj) !== undefined || /sessions\.run$/.test(calleeOf(obj))) return true;
      const cs = condSpreads(obj);
      if (ts.isPropertyAssignment(prop)) return cs.length > 0 || /^(wallModel|downgrade|pinned)/.test(init);
      return cs.some((c) => [c.whenTrue, c.whenFalse].some((b) => ts.isObjectLiteralExpression(b) && b.properties.some((x) => ["effort", "model"].includes(nameOf(x) ?? ""))));
    };
    // wall.ts COST-11: the wall session's own pin is the local `model` of wallAuthor, defined once from the retry model or wallFirstModel.
    const inWallAuthor = (n: ts.Node): boolean => {
      for (let a: ts.Node | undefined = n; a; a = a.parent) if (ts.isFunctionDeclaration(a)) return a.name?.text === "wallAuthor" && a.getText(sf).includes("const model = retry?.model ?? wallFirstModel(sz.size)");
      return false;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const prop of node.properties) {
          if (!(ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) || nameOf(prop) !== "model") continue;
          const init = ts.isPropertyAssignment(prop) ? prop.initializer.getText(sf) : "model";
          if (!inScope(node, prop, init) || isData(node)) continue;
          const sp = spreadOf(node);
          const wallShorthand = path === "stages/wall.ts" && init === "model" && inWallAuthor(prop);
          const hoisted = sp ? undefined : hoistedOf(node);
          const good = sp
            ? vetted(skipParens(sp.expression).getText(sf))
            : hoisted
            ? vetted(skipParens(hoisted.initializer!).getText(sf))
            : init === "ctx.model" || (ok !== undefined && ok.test(`${init},`)) || wallShorthand;
          if (!good) v.push(`${path}:${sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1}: unvetted session model pin: ${node.getText(sf).split("\n")[0]!.trim()}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
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
  // implement_route.ts is the only other place the implement pin is set: each assignment must sit beside its route event (source plus reason) or its route.escalated event.
  const ir = (files["../runner/router/implement_route.ts"] ?? "").split("\n");
  ir.forEach((line, i) => {
    if (!/\b\w+\.model = /.test(line) || /^\s*\/\//.test(line)) return;
    const recorded = (/first\.model = rr\.model;/.test(line) && /ctx\.emit\("route", "implement", \{[^}]*\bsource\b[^}]*\breason\b/.test(ir[i + 1] ?? "")) || (/first\.model = rt\.current;/.test(line) && /ctx\.emit\("route\.escalated"/.test(ir[i - 1] ?? ""));
    if (!recorded) v.push(`implement_route.ts:${i + 1}: model assigned with no router route record (source plus reason): ${line.trim()}`);
  });
  // Secondary: a haiku model token may appear only on the vetted lines (the router's single haiku producer lives in unit_model.ts).
  const HAIKU_OK: Record<string, RegExp[]> = {
    "../runner/router/plan_route.ts": [/^export const ROUTER_UNITS_INSTRUCTION/],
    "stages/implement.ts": [/^import \{ cascadeDowngrade, haikuFirstDowngrade,/, /^\s*const downgrade = routed \? null : cascadeDowngrade\(ctx\.model\) \?\? haikuFirstDowngrade\(ctx\.model\);/],
    "../runner/model_rank.ts": [/^export const modelRank/, /^\/\*\* TEN-COST-16/, /^export const haikuFirstEnabled/, /^export function haikuFirstDowngrade/, /^\s*return haikuFirstEnabled\(env\) && modelRank\(to\) < modelRank\(runModel\)/, /^  const to = resolveModelAlias\("haiku"\);/, /^\s*const model = k\.includes\("haiku"\)/],
    "../runner/router/unit_model.ts": [/^const isHaiku = /, /^export function validHaikuRoute/, /r\["executor"\] !== "haiku"/, /^\s*return v \? \{ model: resolveModelAlias\("haiku"\), source: "opus-plan", reason: v\.reason, valid: true \} : \{ model: runFloor\(runModel\)/, /unitRedo\(isHaiku\(cur\) \? "haiku"/, /^\s*const v = validHaikuRoute\(plan\);$/, /^export const floorNoAdvisor/],
  };
  for (const path of ["stages/implement.ts", "stages/fix.ts", "stages/plan.ts", "machine.ts", "session.ts", "cost.ts", "../runner/model_rank.ts", "../runner/router/unit_model.ts", "../runner/router/plan_route.ts", "../runner/router/implement_route.ts", "../runner/router/session_route.ts"]) {
    (files[path] ?? "").split("\n").forEach((line, i) => {
      const code = line.replace(/\s\/\/.*$/, "");
      if (/^\s*(\/\/|\*|\/\*)/.test(code) || !/haiku/i.test(code)) return;
      if (!(HAIKU_OK[path] ?? []).some((re) => re.test(code))) v.push(`${path}:${i + 1}: unvetted haiku model token: ${line.trim()}`);
    });
  }
  const fixSrc = files["stages/fix.ts"] ?? "";
  if (/routedPin/.test(fixSrc) && !FIX_ROUTED_DEF.test(fixSrc)) v.push("fix.ts: routedPin is not derived from routedFix under the router flag");
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
  for (const rel of ["runner/model_rank.ts", "runner/router/unit_model.ts", "runner/router/plan_route.ts", "runner/router/implement_route.ts", "runner/router/session_route.ts"]) out[`../${rel}`] = readFileSync(join(SRC, "..", rel), "utf8");
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

  it("one-line options object: every spread pin is vetted on its own, and a data-key model is not a pin", () => {
    const f = loadFiles();
    const line = f["stages/fix.ts"]!.split("\n").find((l) => l.includes("const sessionBase = {") && l.includes("...(pinnedModel ? { model: pinnedModel } : {})"))!;
    expect(line).toBeDefined();
    expect(guardViolations(f).filter((x) => x.includes("unvetted session model pin"))).toEqual([]);
    const g = { ...f, "stages/fix.ts": f["stages/fix.ts"]!.replace(line, line.replace("...(routedPin ? { model: routedPin } : {})", '...(effort ? { model: "claude-haiku-4-5" } : {})')) };
    expect(guardViolations(g).some((x) => x.includes("unvetted session model pin"))).toBe(true);
    const h = { ...f, "stages/fix.ts": f["stages/fix.ts"]!.replace(line, line.replace("...(pinnedModel ? { model: pinnedModel } : {})", '...(pinnedModel ? { model: "claude-haiku-4-5" } : {})')) };
    expect(guardViolations(h).some((x) => x.includes("unvetted session model pin"))).toBe(true);
  });

  it("review misses F, G, E: a non-first model key, a trailing model key and a data-key outside an event object are pins", () => {
    const f = loadFiles();
    const fix = f["stages/fix.ts"]!;
    const line = fix.split("\n").find((l) => l.includes("const sessionBase = {") && l.includes("...(pinnedModel ? { model: pinnedModel } : {})"))!;
    const red = (mut: string): boolean => guardViolations({ ...f, "stages/fix.ts": mut }).some((x) => x.includes("unvetted session model pin"));
    expect(red(fix.replace(line, line.replace("...(effort ? { effort } : {})", "...(effort ? { effort, model: lowModel } : {})")))).toBe(true); // F
    expect(red(fix.replace(line, line.replace(/ \};$/, ", model: lowModel };")))).toBe(true); // G
    expect(red(`${fix}\nconst o = { ...(pinnedModel ? { model: pinnedModel } : {}), stage: "fix", model: lowModel };\n`)).toBe(true); // E, outside a data object
    expect(red(`${fix}\nconst o = { ...(effort ? { effort } : {}), model: lowModel };\n`)).toBe(true); // E, plain shape: the only spread is unrelated
    expect(red(`${fix}\nctx.emit("x", "fix", { data: { round } }); const o = { ...(effort ? { effort } : {}), model: lowModel };\n`)).toBe(true); // pin after a data object already closed
    expect(red(`${fix}\nconst data: Record<string, unknown> = {\n  ...(effort ? { effort } : {}), model: actualModel,\n};\n`)).toBe(false); // a data-named binding is an event object
    expect(red(`${fix}\n// it's fine\nconst d = { ...(effort ? { effort } : {}), model: "}" }; const data = {\n ...(effort ? { effort } : {}), model: actualModel };\n`)).toBe(true); // braces in strings and apostrophes in comments do not hide the first pin
    for (const re of ["/'/", '/"/', "/`/", "/\\/\\//"]) expect(red(`${fix}\nconst data = { re: ${re} }; const o = { ...(effort ? { effort } : {}), model: lowModel };\n`)).toBe(true); // a quote or // inside a regex literal is not a string or comment
    expect(red(`${fix}\nconst o = { ...(signal ? { signal } : {}), model: lowModel };\n`)).toBe(true); // any conditional spread puts an explicit model key in scope
    expect(red(`${fix}\nconst o = { ...(signal ? { signal } : {}), model: lowModel }; ctx.sessions.run(o);\n`)).toBe(true);
    expect(red(`${fix}\nctx.emit("x", "fix", { ...(signal ? { signal } : {}), model: actualModel });\n`)).toBe(false); // an emit payload is not a session
    expect(red(`${fix}\nconst extra = cond ? { model: weakModel } : {}; ctx.sessions.run({ stage: "fix", ...extra });\n`)).toBe(true); // a hoisted conditional spread pin is judged like an inline one
    expect(red(`${fix}\nconst extra = (cond ? { model: weakModel } : {}); const o = { ...extra, stage: "fix" };\n`)).toBe(true);
    expect(red(`${fix}\nconst extra = cond ? { model: weakModel } : {}; ctx.sessions.run({ stage: "fix" });\n`)).toBe(false); // never spread into anything: not a session option
    const wall = f["stages/wall.ts"]!;
    const sibling = `\nexport async function wallLow(ctx: RunContext) {\n  const model = "claude-haiku-4-5";\n  return ctx.sessions.run({ stage: "wall", model });\n}\n`;
    expect(guardViolations({ ...f, "stages/wall.ts": wall + sibling }).some((x) => x.includes("unvetted session model pin"))).toBe(true); // the wallAuthor shorthand vetting is per function, not per file
    expect(red(`${fix}\nctx.emit("x", "fix", { data: { round, model: actualModel } });\n`)).toBe(false); // inside a data object it stays exempt
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
    f["stages/implement.ts"] = impl.replace(/const rt = routed \? routeStart\(.*\n/, 'first.model = "claude-haiku-4-5"; const rt = null;\n');
    expect(f["stages/implement.ts"]).not.toBe(impl);
    expect(guardViolations(f).some((x) => x.includes("no router route record"))).toBe(true);
    const g = loadFiles();
    const fix = g["stages/fix.ts"]!;
    g["stages/fix.ts"] = fix.replace(/const \{ pin: routedPin, climbed \} = routed \? routedFix\(.*\n/, 'const routedPin = "claude-haiku-4-5", climbed = null;\n');
    expect(g["stages/fix.ts"]).not.toBe(fix);
    expect(guardViolations(g).length).toBeGreaterThan(0);
    const h = loadFiles();
    const esc = h["../runner/router/implement_route.ts"]!;
    h["../runner/router/implement_route.ts"] = esc.replace(/ctx\.emit\("route\.escalated", "implement", \{ \.\.\.esc \}\);\n/, "");
    expect(h["../runner/router/implement_route.ts"]).not.toBe(esc);
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
