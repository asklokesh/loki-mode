// FC-19: one LOKI_SPEC_CONFLICT correction round; no wording of the reason is inspected.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import { verdictOf } from "../../src/engine10/stages/seal.ts";
import { editScopeViolation, wallAnchor } from "../../src/util/wall_owned.ts";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import { CONFLICT_CORRECTION, adjudicateWallConflict, answerMark, answeredTask, applyArbitrations, blockedCompletion, defaultBaseTree, defaultRunCheck, effectiveEvents, type RefereeDeps } from "../../src/util/conflict_resume.ts";
import { resumeMachineOpts } from "../../src/util/run_outputs.ts";
import { FINISH_LINE } from "../../src/e10ext/context.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner, TestRef } from "../../src/engine10/types.ts";

const INCIDENT = "the task asks for all 37 route files to be migrated, but the stage rules limit me to the named files and a few tests";
class Seq implements SessionRunner {
  calls: SessionRunOptions[] = [];
  constructor(private rs: SessionResult[]) {}
  async run(o: SessionRunOptions): Promise<SessionResult> { this.calls.push(o); return this.rs[Math.min(this.calls.length - 1, this.rs.length - 1)]!; }
}
const ctxOf = (s: SessionRunner, provider = "claude"): RunContext => ({
  runId: "e10-fc19", repoDir: "/tmp/fc19-does-not-exist", runDir: "/tmp/fc19-does-not-exist/.loki/runs/e10-fc19", baseSha: "x", branch: "b", provider, model: "m", deep: false, capS: 900,
  emit: () => {}, sessions: s,
  tests: { async detect() { return { runners: [], tests: [] }; }, impacted() { return []; } },
  cost: { read() { return { usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }; } },
  clock: { now: () => 0 }, outputs: () => ({}),
} as unknown as RunContext);
const conflict = (reason: string): SessionResult => ({ exit: 0, markers: { done: false, alreadyDone: null, specConflict: reason }, durationS: 1, killed: false });
const done: SessionResult = { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 1, killed: false };

describe("FC-19 conflict resume", () => {
  test("a conflict that clears after the correction continues", async () => {
    const s = new Seq([conflict(INCIDENT), done]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(s.calls[1]!.brief).toContain(CONFLICT_CORRECTION);
    expect(r.status).toBe("completed");
    expect(r.data.exit).toBe("done");
    expect(r.data.spec_conflict_reason).toBeNull();
    expect(r.data.iteration_ids).toEqual(["e10-fc19-impl", "e10-fc19-impl-r"]);
  });
  test("a conflict that persists stays a spec conflict with its question, resumed exactly once", async () => {
    const genuine = "the task says keep the REST API unchanged and also replace it with GraphQL";
    const s = new Seq([conflict(INCIDENT), conflict(genuine)]);
    const r = await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(2);
    expect(r.status).toBe("completed");
    expect(r.data.exit).toBe("spec_conflict");
    expect(r.data.spec_conflict_reason).toBe(genuine);
    expect(r.data.harness_failure).toBeUndefined();
  });
  test("no conflict means no second session", async () => {
    const s = new Seq([done]);
    await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls.length).toBe(1);
  });
  test("without a recorded session id the retry restarts with the original brief plus the correction", async () => {
    const s = new Seq([conflict("x"), done]);
    await implementStage.run(ctxOf(s), new AbortController().signal);
    expect(s.calls[1]!.resumeSessionId).toBeUndefined();
    expect(s.calls[1]!.brief.startsWith(s.calls[0]!.brief)).toBe(true);
  });
  describe("R1: a failed resume keeps the original question", () => {
    const Q = "Which provider: Stripe or Adyen?";
    const cases: Array<[string, SessionResult]> = [
      ["resume exits 1 with no marker", { exit: 1, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 2, killed: false }],
      ["resume is killed", { exit: null, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 2, killed: true }],
      ["resume exits 0 with no marker", { exit: 0, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 2, killed: false }],
    ];
    for (const [name, second] of cases) {
      test(name, async () => {
        const s = new Seq([conflict(Q), second]);
        const r = await implementStage.run(ctxOf(s), new AbortController().signal);
        expect(s.calls.length).toBe(2);
        expect(r.status).toBe("completed");
        expect(r.data.exit).toBe("spec_conflict");
        expect(r.data.spec_conflict_reason).toBe(Q);
        expect(r.data.duration_s).toBe(3);
      });
    }
  });
});

// The Wall referee: an implementer conflict that cites a Wall file is only a trigger. A replacement is applied only when every mechanical validator passes and two referees agree with a verbatim task quote; anything else leaves the original byte-identical.
const TASK = "Parse durations such as 1h 30m into seconds. Whitespace around the input is ignored and units are case insensitive, so 1H 30M is 5400 seconds.";
const QUOTE = "Whitespace around the input is ignored and units are case insensitive";
const WALL = "tests/loki_wall_units.test.ts", WNAME = "loki_wall_units.test.ts", SENTINEL = "IMPLEMENTER-SENTINEL-4417";
const ORIG = ['import { test, expect } from "bun:test";', 'import { parse } from "../src/dur";', 'test("parses padded", () => {', '  expect(parse("  1H 30M  ")).toBe(5430);', '  expect(parse("1h 30m")).toBe(5400);', "});", 'test("rejects empty", () => {', '  expect(() => parse("")).toThrow();', "});", ""].join("\n");
const GOOD = ORIG.replace("5430", "5400");
const CLAIM = `${WALL}:4 expects 5430 but the task says 5400 ${SENTINEL}`;
const sha = (t: string): string => createHash("sha256").update(t).digest("hex");
const first = (): SessionRunOptions => ({ stage: "implement", brief: "B", tier: "development", iterationId: "it", limitS: 100, signal: new AbortController().signal });
const sess = (reason: string): SessionResult => conflict(reason);

interface RefSpec { verdict?: unknown; file?: string | null; exit?: number; killed?: boolean }
class Referees implements SessionRunner {
  calls: SessionRunOptions[] = []; n = 0;
  constructor(public a: RefSpec | undefined, public b: RefSpec | undefined, private impl: SessionResult[] = [done]) {}
  async run(o: SessionRunOptions): Promise<SessionResult> {
    this.calls.push(o);
    if (o.stage === "wall") {
      const isA = o.iterationId.endsWith("-wa"), spec = isA ? this.a : this.b;
      if (!spec) return done;
      if (spec.killed) return { exit: null, markers: { done: false, alreadyDone: null, specConflict: null }, durationS: 1, killed: true };
      if (isA && spec.file != null) writeFileSync(join(o.cwd!, WNAME), spec.file, "utf8");
      if (spec.verdict !== undefined) writeFileSync(join(o.cwd!, "verdict.json"), typeof spec.verdict === "string" ? spec.verdict : JSON.stringify(spec.verdict), "utf8");
      return { ...done, exit: spec.exit ?? 0 };
    }
    return this.impl[Math.min(this.n++, this.impl.length - 1)]!;
  }
  walls = (): SessionRunOptions[] => this.calls.filter((c) => c.stage === "wall");
}
const A_GOOD: RefSpec = { verdict: { verdict: "fix", test: "parses padded", spec_quote: QUOTE }, file: GOOD }, B_YES: RefSpec = { verdict: { agree: true, spec_quote: QUOTE } };

describe("Wall referee", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  function world(s: SessionRunner, content = ORIG, extraWall: string[] = []) {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-e15-ref-")); dirs.push(repoDir);
    const runDir = join(repoDir, ".loki", "run"); mkdirSync(join(repoDir, "tests"), { recursive: true }); mkdirSync(join(runDir, "wall"), { recursive: true });
    const path = join(repoDir, WALL); writeFileSync(path, content, "utf8"); writeFileSync(join(runDir, "wall", WNAME), content, "utf8");
    const files = [{ path, sha256: sha(content), runner: "bun" as const }], readOnlyFiles = [{ path, content }];
    for (const x of extraWall) { const q = join(repoDir, x); writeFileSync(q, content, "utf8"); files.push({ path: q, sha256: sha(content), runner: "bun" as const }); readOnlyFiles.push({ path: q, content }); }
    const wall: Record<string, unknown> = { files, readOnlyFiles };
    const ctx = { ...ctxOf(s), repoDir, runDir, baseSha: "base", outputs: () => ({ wall, intake: { task: TASK } }) } as unknown as RunContext;
    const base = mkdtempSync(join(tmpdir(), "loki-e15-refbase-")); dirs.push(base);
    // tree: red while the file still holds 5430 or BREAK; base: red unless the file holds WEAK (a replacement that passes without the code)
    const deps: RefereeDeps = { baseTree: () => base, runCheck: (dir: string, ref: TestRef) => { const c = readFileSync(join(dir, ref.path), "utf8"); return dir === repoDir ? (/5430|BREAK/.test(c) ? "fail" : "pass") : (/WEAK/.test(c) ? "pass" : "fail"); } };
    return { ctx, wall, path, sealed: join(runDir, "wall", WNAME), deps, repoDir, ro: readOnlyFiles };
  }
  const run = (w: ReturnType<typeof world>, reason = CLAIM) => adjudicateWallConflict(w.ctx, first(), sess(reason), w.ro, w.deps);
  const untouched = (w: ReturnType<typeof world>, c = ORIG): void => { expect(readFileSync(w.path, "utf8")).toBe(c); expect(readFileSync(w.sealed, "utf8")).toBe(c); expect(w.ro[0]!.content).toBe(c); expect((w.wall.files as { sha256: string }[])[0]!.sha256).toBe(sha(c)); expect(w.wall.arbitrated).toBeUndefined(); };

  test("positive: a one-test correction with a verbatim spec quote from both referees is applied and disclosed", async () => {
    const s = new Referees(A_GOOD, B_YES, [done]), w = world(s);
    const r = await run(w);
    expect(r).not.toBeNull(); expect(r!.session.markers.done).toBe(true);
    expect(readFileSync(w.path, "utf8")).toBe(GOOD);
    const arb = (w.wall.arbitrated as Record<string, string>[])[0]!;
    expect(arb).toMatchObject({ check: WALL, test: "parses padded", spec_quote: QUOTE, sha256: sha(GOOD) });
    expect(arb.old_assertion).toContain("5430"); expect(arb.new_assertion).toContain("5400");
  });
  test("sealed copy under runDir/wall, the read-only copy and the sealed sha all equal the applied file", async () => {
    const w = world(new Referees(A_GOOD, B_YES)); await run(w);
    const applied = readFileSync(w.path, "utf8");
    expect(applied).toBe(GOOD); expect(readFileSync(w.sealed, "utf8")).toBe(applied); expect(w.ro[0]!.content).toBe(applied);
    expect((w.wall.files as { sha256: string }[])[0]!.sha256).toBe(sha(applied));
  });
  test("the re-check runs against the sealed copy: a seal that cannot hold the applied file restores the original", async () => {
    const w = world(new Referees(A_GOOD, B_YES)); rmSync(join(w.repoDir, ".loki", "run", "wall"), { recursive: true, force: true });
    expect(await run(w)).toBeNull(); expect(readFileSync(w.path, "utf8")).toBe(ORIG); expect(w.wall.arbitrated).toBeUndefined();
  });
  test("verdictOf itself does not cap an arbitrated run (the cap lives in seal, see seal.test.ts)", () => {
    const pass = { name: "bun:a", cmd: "x", result: "pass" as const, duration_s: 1 };
    expect(verdictOf({ implement: { exit: "done" }, intake: {}, wall: { arbitrated: [{ check: WALL }] } } as never, [pass], false, false, false, true)).toBe("VERIFIED");
  });
  // a runner fake driven by call order: [original on tree, replacement on tree, replacement on base, sealed copy on tree]
  const seq = (w: ReturnType<typeof world>, r: Array<"pass" | "fail">): { calls: number } => { const st = { calls: 0 }; w.deps = { ...w.deps, runCheck: () => r[Math.min(st.calls++, r.length - 1)]! }; return st; };
  const GOODSEQ: Array<"pass" | "fail"> = ["fail", "pass", "fail", "pass"];
  test("fake conflict: a sha-identical file is never applied and never VERIFIED, even when every runner says green", async () => {
    for (const file of [ORIG, ORIG.replace(/\n$/, "")]) {
      const w = world(new Referees({ ...A_GOOD, file }, B_YES)); seq(w, ["fail", "pass", "fail", "pass"]);
      if (file === ORIG) { expect(await run(w)).toBeNull(); untouched(w); }
      else { const r = await run(w); if (r === null) untouched(w); }
    }
  });
  test("runner outcomes in order: the original must be red on the tree, the replacement green on the tree, red on base, and green again from the sealed copy", async () => {
    const bad: Array<Array<"pass" | "fail">> = [["pass", "pass", "fail", "pass"], ["fail", "fail", "fail", "pass"], ["fail", "pass", "pass", "pass"], ["fail", "pass", "fail", "fail"]];
    for (const r of bad) { const w = world(new Referees(A_GOOD, B_YES)); seq(w, r); expect(await run(w)).toBeNull(); untouched(w); }
    const w = world(new Referees(A_GOOD, B_YES)), st = seq(w, GOODSEQ);
    expect(await run(w)).not.toBeNull(); expect(st.calls).toBe(4);
  });
  test("a replacement that changes nothing meaningful but is green everywhere is still applied only through the full chain", async () => {
    const w = world(new Referees({ ...A_GOOD, file: GOOD.replace('parse("1h 30m")', 'parse("1h  30m")') }, B_YES)); seq(w, GOODSEQ);
    expect(await run(w)).not.toBeNull();
  });
  describe("each validator, and the mutation it guards", () => {
    const cases: Array<[string, RefSpec, RefSpec | undefined]> = [
      ["scope: the replacement also edits a second test", { ...A_GOOD, file: GOOD.replace(".toThrow()", ".not.toThrow()") }, B_YES],
      ["scope: the replacement adds a test", { ...A_GOOD, file: GOOD + 'test("extra", () => { expect(1 + 1).toBe(2); });\n' }, B_YES],
      ["scope: the replacement edits the definition line", { ...A_GOOD, file: GOOD.replace('"parses padded"', '"parses padded now"') }, B_YES],
      ["count: an assertion is deleted", { ...A_GOOD, file: GOOD.replace('  expect(parse("1h 30m")).toBe(5400);\n', "") }, B_YES],
      ["vacuous: the assertion is replaced by a tautology", { ...A_GOOD, file: ORIG.replace('expect(parse("  1H 30M  ")).toBe(5430);', "expect(true).toBe(true);") }, B_YES],
      ["red on tree: the replacement still fails on the tree", { ...A_GOOD, file: GOOD.replace("});\ntest(\"rejects", "  // BREAK\n});\ntest(\"rejects") }, B_YES],
      ["red on base: the replacement passes without the code", { ...A_GOOD, file: GOOD.replace("});\ntest(\"rejects", "  // WEAK\n});\ntest(\"rejects") }, B_YES],
      ["quote: the spec quote is not in the task", { verdict: { verdict: "fix", test: "parses padded", spec_quote: "the task obviously wants five thousand four hundred" }, file: GOOD }, B_YES],
      ["quote: the spec quote is too short", { verdict: { verdict: "fix", test: "parses padded", spec_quote: "5400" }, file: GOOD }, B_YES],
      ["referee B disagrees", A_GOOD, { verdict: { agree: false } }],
      ["referee B quote is not in the task", A_GOOD, { verdict: { agree: true, spec_quote: "something that is not in the task at all" } }],
      ["referee B writes nothing", A_GOOD, {}],
      ["referee B is killed", A_GOOD, { killed: true }],
      ["referee B exits non-zero", A_GOOD, { ...B_YES, exit: 1 }],
      ["referee A says keep", { verdict: { verdict: "keep" }, file: GOOD }, B_YES],
      ["referee A names a test that does not exist", { verdict: { verdict: "fix", test: "no such test", spec_quote: QUOTE }, file: GOOD }, B_YES],
      ["referee A writes garbage JSON", { verdict: "{not json", file: GOOD }, B_YES],
      ["referee A writes no file", { verdict: A_GOOD.verdict, file: null }, B_YES],
      ["referee A is killed", { killed: true }, B_YES],
    ];
    for (const [name, a, b] of cases) test(`declined and byte-identical: ${name}`, async () => {
      const w = world(new Referees(a, b)); const r = await run(w);
      expect(r).toBeNull(); untouched(w);
    });
  });
  test("the implementer's text never enters a referee session brief or its files", async () => {
    const s = new Referees(A_GOOD, B_YES), w = world(s); await run(w, CLAIM);
    expect(s.walls().length).toBe(2);
    for (const c of s.walls()) { expect(c.brief).not.toContain(SENTINEL); expect(c.brief).not.toContain("expects 5430"); expect(c.brief).toContain("Whitespace around the input"); }
  });
  test("referee sessions use the wall stage, the development tier and the wall model", async () => {
    const s = new Referees(A_GOOD, B_YES), w = world(s); await run(w);
    for (const c of s.walls()) { expect(c.stage).toBe("wall"); expect(c.tier).toBe("development"); expect(c.model).toBeTruthy(); }
  });
  test("budget: one round per check id and two per run; a spent round buys no second attempt", async () => {
    const s = new Referees({ verdict: { verdict: "keep" } }, B_YES), w = world(s, ORIG, ["tests/loki_wall_b.test.ts", "tests/loki_wall_c.test.ts"]);
    expect(await run(w)).toBeNull(); expect(s.walls().length).toBe(2 - 1); // keep: referee A only
    expect(await run(w)).toBeNull(); expect(s.walls().length).toBe(1);
    expect(await adjudicateWallConflict(w.ctx, first(), sess("tests/loki_wall_b.test.ts is wrong"), w.ro, w.deps)).toBeNull();
    const n = s.walls().length;
    expect(await adjudicateWallConflict(w.ctx, first(), sess("tests/loki_wall_c.test.ts is wrong"), w.ro, w.deps)).toBeNull();
    expect(s.walls().length).toBe(n);
  });
  test("a conflict not anchored on a Wall file never reaches a referee", async () => {
    const s = new Referees(A_GOOD, B_YES), w = world(s);
    expect(await run(w, "the task says keep the REST API and also replace it (src/api.ts:93)")).toBeNull(); expect(s.calls.length).toBe(0);
  });
  test("LOKI_E10_WALL_REFEREE=0: the legacy single re-author runs, nothing is validated, and nothing is ever dropped", async () => {
    const prev = process.env.LOKI_E10_WALL_REFEREE; process.env.LOKI_E10_WALL_REFEREE = "0";
    try {
      const s = new Referees({ file: "// legacy rewrite\n" }, undefined, [conflict(CLAIM)]), w = world(s);
      const evs: { type: string; data: Record<string, unknown> }[] = [];
      const ctx = { ...w.ctx, emit: (type: string, _s: unknown, data: Record<string, unknown>) => { evs.push({ type, data }); } } as unknown as RunContext;
      const r = await adjudicateWallConflict(ctx, first(), sess(CLAIM), w.ro, w.deps);
      expect(r!.session.markers.specConflict).toBe(CLAIM); // persistent: stands as a conflict
      expect(existsSync(w.path)).toBe(true); expect(w.ro.length).toBe(1); expect((w.wall.files as unknown[]).length).toBe(1);
      expect(s.walls().length).toBe(1);
      // the unvalidated rewrite is recorded (legacy marker) so seal caps it, and a durable event lets resume rebuild it
      const arb = w.wall.arbitrated as { kind?: string; sha256: string }[];
      expect(arb.length).toBe(1); expect(arb[0]!.kind).toBe("legacy");
      expect(evs.filter((e) => e.type === "wall.arbitrated").length).toBe(1);
      expect(arb[0]!.sha256).toBe(sha(readFileSync(w.path, "utf8")));
    } finally { if (prev === undefined) delete process.env.LOKI_E10_WALL_REFEREE; else process.env.LOKI_E10_WALL_REFEREE = prev; }
  });
  test("the arbitration's default check runs the Wall file with PYTHONDONTWRITEBYTECODE=1 (no stale bytecode)", () => {
    const d = mkdtempSync(join(tmpdir(), "loki-e15-bytecode-")); try {
      writeFileSync(join(d, "t.test.js"), "const test = require('node:test');\nconst assert = require('node:assert');\ntest('env', () => { assert.strictEqual(process.env.PYTHONDONTWRITEBYTECODE, '1'); });\n", "utf8");
      expect(defaultRunCheck(d, { runner: "node", path: "t.test.js" })).toBe("pass");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  test("stage level: a referee that declines leaves the run a spec conflict with the Wall file intact", async () => {
    const s = new Referees({ verdict: { verdict: "keep" } }, B_YES, [conflict(CLAIM)]), w = world(s);
    const r = await implementStage.run(w.ctx, new AbortController().signal);
    expect(r.data.exit).toBe("spec_conflict"); expect(existsSync(w.path)).toBe(true); expect(readFileSync(w.path, "utf8")).toBe(ORIG);
    expect(r.data.wall_defect).toBeUndefined();
  });
  test("no code path drops a Wall file: the drop exports are gone", async () => {
    const m = await import("../../src/util/wall_owned.ts") as Record<string, unknown>;
    expect(m.wallDropped).toBeUndefined(); expect(m.WALL_DROPPED).toBeUndefined(); expect(m.accumulateWallDefects).toBeUndefined();
  });
});

describe("Wall referee replays of the preserved RUN5-C1b Wall files (task text reconstructed from the c1e quotes)", () => {
  const fx = (n: string): string => readFileSync(join(import.meta.dir, "fixtures", "wall_referee", n), "utf8");
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  async function replay(name: string, runner: "unittest", task: string, test: string, quote: string, edit: (c: string) => string, claim: string) {
    const content = fx(name), next = edit(content); expect(next).not.toBe(content);
    const repoDir = mkdtempSync(join(tmpdir(), "loki-e15-replay-")), base = mkdtempSync(join(tmpdir(), "loki-e15-replaybase-")); dirs.push(repoDir, base);
    const rel = `tests/${name}`, path = join(repoDir, rel), runDir = join(repoDir, ".loki", "run"); mkdirSync(join(repoDir, "tests"), { recursive: true }); mkdirSync(join(runDir, "wall"), { recursive: true });
    writeFileSync(path, content, "utf8"); writeFileSync(join(runDir, "wall", name), content, "utf8");
    const wall: Record<string, unknown> = { files: [{ path, sha256: sha(content), runner }], readOnlyFiles: [{ path, content }] };
    const s: SessionRunner = { async run(o) { if (o.stage !== "wall") return done; if (o.iterationId.endsWith("-wa")) { writeFileSync(join(o.cwd!, name), next, "utf8"); writeFileSync(join(o.cwd!, "verdict.json"), JSON.stringify({ verdict: "fix", test, spec_quote: quote })); } else writeFileSync(join(o.cwd!, "verdict.json"), JSON.stringify({ agree: true, spec_quote: quote })); return done; } };
    const ctx = { ...ctxOf(s), repoDir, runDir, outputs: () => ({ wall, intake: { task } }) } as unknown as RunContext;
    const deps: RefereeDeps = { baseTree: () => base, runCheck: (dir) => (dir === repoDir ? (readFileSync(path, "utf8") === content ? "fail" : "pass") : "fail") };
    const ro = [{ path, content }], r = await adjudicateWallConflict(ctx, first(), conflict(claim), ro, deps);
    return { r, path, content, next, wall };
  }
  test("longspec-1: 5430 for '  1H 30M  ' is corrected to 5400 inside that one test", async () => {
    const t = await replay("loki_wall_units.py", "unittest", "parse_duration accepts mixed case and surrounding whitespace. Whitespace around the input is ignored and units are case insensitive, so 1H 30M equals 1h 30m.", "test_whitespace_case_and_spaces_between_components", "Whitespace around the input is ignored and units are case insensitive", (c) => c.replace('parse_duration("  1H 30M  "), 5430', 'parse_duration("  1H 30M  "), 5400'), "tests/loki_wall_units.py: test_whitespace_case_and_spaces_between_components asserts 5430");
    expect(t.r).not.toBeNull(); expect(readFileSync(t.path, "utf8")).toBe(t.next); expect((t.wall.arbitrated as unknown[]).length).toBe(1);
  });
  test("bugfix-2: the case-insensitive expectation in the non-string test is corrected within that one test", async () => {
    const t = await replay("loki_wall_dedupe.py", "unittest", "dedupe removes duplicates. With case_sensitive=False, strings that differ only by case are duplicates and the first spelling is kept.", "test_non_strings_are_compared_by_equality_not_case_folded", "strings that differ only by case are duplicates", (c) => c.replace('[1, "x", "X", None],', '[1, "x", None],').replace('self.assertNotEqual(dedupe(["x", "X"], case_sensitive=False), ["x"])', 'self.assertEqual(dedupe(["x", "X"], case_sensitive=False), ["x"])'), "loki_wall_dedupe.py expects x and X to stay distinct but the task says they are duplicates");
    expect(t.r).not.toBeNull(); expect(readFileSync(t.path, "utf8")).toBe(t.next);
  });
  test("integration-1: InventoryService() with no arguments is replaced inside the one test that builds it", async () => {
    const t = await replay("loki_wall_fetch_all.py", "unittest", "fetch_all walks the pages of an InventoryService. service.py must not be modified, and InventoryService takes its items as an argument.", "test_zero_retries_raises_immediately_without_sleeping", "service.py must not be modified, and InventoryService takes its items as an argument", (c) => c.replace("        service = InventoryService()\n        sleeps = []\n        log = _recording(service, always=True)\n\n        with self.assertRaises(ServiceUnavailable):\n            fetch_all(service, max_retries=0", "        service = InventoryService(list(range(5)))\n        sleeps = []\n        log = _recording(service, always=True)\n\n        with self.assertRaises(ServiceUnavailable):\n            fetch_all(service, max_retries=0"), "tests/loki_wall_fetch_all.py: InventoryService() needs a default for items");
    expect(t.r).not.toBeNull(); expect(readFileSync(t.path, "utf8")).toContain("InventoryService(list(range(5)))");
  });
});

describe("C1f: a whole-file import failure on base counts as red-on-base (v11.86.0, util/check_result.ts classify via moduleToBeCreated; BOARD RUN5-C1f)", () => {
  test("bugfix-2 shape: pytest exit 2 on a module the task creates is red; a module the repo already has is not", async () => {
    const { classify } = await import("../../src/util/check_result.ts");
    const repo = mkdtempSync(join(tmpdir(), "loki-e15-c1f-"));
    try {
      const out = "============================= test session starts ==============================\n_______ ERROR collecting tests/loki_wall_dedupe.py _______\nImportError while importing test module\nE   ModuleNotFoundError: No module named 'dedupe'\n=========================== short test summary info ============================\nERROR tests/loki_wall_dedupe.py\n!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!\n";
      expect(classify({ runner: "pytest", path: "tests/loki_wall_dedupe.py" }, 2, out, repo, "project")).toBe("fail");
      writeFileSync(join(repo, "dedupe.py"), "def dedupe(x): return x\n", "utf8");
      expect(classify({ runner: "pytest", path: "tests/loki_wall_dedupe.py" }, 2, out, repo, "project")).toBe("not_run");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe("Wall-anchored conflict trigger", () => {
  const ANCHORED = `${WALL}:93 expects 4 but the task says the total is 5`, REAL = "the task says keep the REST API unchanged and also replace it with GraphQL (src/api.ts:93)";
  test("wallAnchor reads a path with an optional :line, and only for Wall files", () => {
    expect(wallAnchor(ANCHORED, [WALL])).toEqual({ file: WALL, line: 93 });
    expect(wallAnchor(`see loki_wall_units.test.ts:12`, [WALL])).toEqual({ file: WALL, line: 12 });
    expect(wallAnchor(REAL, [WALL])).toBeNull();
    expect(wallAnchor(`the wall file ${WALL} is wrong`, [WALL])).toEqual({ file: WALL, line: null });
  });
  const RUN8_A = "`test_without_top_prints_all_words_sorted` in `tests/loki_wall_top_test.py` asserts sorted output but the task says insertion order", RUN8_B = "`tests/loki_wall_pricing.py` expects a 10% discount but the task says 15%";
  const RUN8_WALL = ["tests/loki_wall_top_test.py", "tests/loki_wall_pricing.py"] as const;
  test("RUN5-S2b wallAnchor accepts a Wall file by path or basename with no line, never a non-Wall file (feature-2 style markers are already handled on origin/main)", () => {
    expect(wallAnchor(RUN8_A, RUN8_WALL)).toEqual({ file: RUN8_WALL[0], line: null });
    expect(wallAnchor(RUN8_B, RUN8_WALL)).toEqual({ file: RUN8_WALL[1], line: null });
    expect(wallAnchor("loki_wall_pricing.py expects 10%", RUN8_WALL)).toEqual({ file: RUN8_WALL[1], line: null });
    expect(wallAnchor("src/pricing.py expects 10% but the task says 15%", RUN8_WALL)).toBeNull();
    expect(wallAnchor("the task says keep the API and also replace it", RUN8_WALL)).toBeNull();
  });
  test("the conflict marker ask names path:line of the cited test", () => { expect(FINISH_LINE).toContain("path:line"); });
  test("control: a real user contradiction not anchored on the Wall stays a spec conflict, resumed once, no Wall session", async () => {
    const s = new Referees(undefined, undefined, [conflict(REAL)]);
    const repoDir = mkdtempSync(join(tmpdir(), "loki-e15-ctl-"));
    try {
      mkdirSync(join(repoDir, "tests"), { recursive: true }); writeFileSync(join(repoDir, WALL), ORIG, "utf8");
      const wall = { readOnlyFiles: [{ path: join(repoDir, WALL), content: ORIG }], files: [{ path: join(repoDir, WALL), sha256: sha(ORIG), runner: "bun" }] };
      const ctx = { ...ctxOf(s), repoDir, runDir: join(repoDir, ".loki"), outputs: () => ({ wall }) } as unknown as RunContext;
      const r = await implementStage.run(ctx, new AbortController().signal);
      expect(r.data.exit).toBe("spec_conflict"); expect(r.data.spec_conflict_reason).toBe(REAL); expect(s.calls.length).toBe(2); expect(s.walls().length).toBe(0);
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });
  test("fix leaves Wall files read-only after the pass", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-e15-ro-"));
    try {
      mkdirSync(join(repoDir, "tests"), { recursive: true }); const path = join(repoDir, WALL); writeFileSync(path, ORIG, "utf8");
      const wall = { readOnlyFiles: [{ path, content: ORIG }], files: [{ path, sha256: sha(ORIG) }] };
      const sessn: SessionRunner = { async run() { writeFileSync(path, "// tampered\n", "utf8"); return done; } };
      const ctx = { ...ctxOf(sessn), repoDir, runDir: join(repoDir, ".loki"), outputs: () => ({ wall }) } as unknown as RunContext;
      const r = await fixStage.run(ctx, new AbortController().signal);
      expect(r.status).toBe("completed"); expect(readFileSync(path, "utf8")).toBe(ORIG); expect(r.data.tests_reverted).toEqual([path]);
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });
});

describe("in-place answer helpers", () => {
  const ev = (seq: number, type: string, stage: string | null, data: Record<string, unknown> = {}) => ({ v: 1, seq, ts: "t", run: "r", type, stage, data }) as never;
  const blockedLog = [ev(0, "run.started", null), ev(1, "stage.completed", "intake", { task: "t" }), ev(2, "stage.completed", "implement", { exit: "spec_conflict" }), ev(3, "stage.completed", "verify"), ev(4, "run.completed", null, { verdict: "SPEC_CONFLICT" }), ev(5, "log.sealed", null)];
  test("a pending answer hides the blocked attempt from implement on, keeping intake", () => {
    const withAnswer = [...blockedLog, ev(6, "run.resumed", null, { answered: true, answer: "a", question: "q" })];
    expect(answerMark(withAnswer)).toBe(6);
    expect(effectiveEvents(withAnswer).map((e) => e.seq)).toEqual([0, 1, 6]);
    expect(effectiveEvents(blockedLog)).toBe(blockedLog); // no answer pending: untouched
  });
  test("once the answered attempt completes, nothing is hidden", () => {
    const done = [...blockedLog, ev(6, "run.resumed", null, { answered: true, answer: "a" }), ev(7, "run.completed", null, { verdict: "VERIFIED" })];
    expect(answerMark(done)).toBe(-1);
    expect(effectiveEvents(done)).toBe(done);
    expect(blockedCompletion(done, done.length)).toBeNull(); // the last completion is VERIFIED, so there is nothing to answer
  });
  test("a plan that declared the change out of repo is re-run too", () => {
    const log = [ev(0, "run.started", null), ev(1, "stage.completed", "intake", { task: "t" }), ev(2, "stage.completed", "plan", { out_of_repo: true }), ev(3, "run.completed", null, { verdict: "SPEC_CONFLICT" }), ev(4, "run.resumed", null, { answered: true })];
    expect(effectiveEvents(log).map((e) => e.seq)).toEqual([0, 1, 4]);
  });
  test("answeredTask appends every recorded answer in order", () => {
    const t = answeredTask("do it", [ev(1, "run.resumed", null, { answered: true, answer: "one", question: "q1" }), ev(2, "run.resumed", null, { answered: true, answer: "two", question: "q2" }), ev(3, "run.resumed", null, {})]);
    expect(t).toBe('do it\n\nClarification answering "q1": one\n\nClarification answering "q2": two');
  });
});

describe("Wall referee scope: a test body, not the code beside it", () => {
  const PY = ["import os", "", "def test_hours():", "    assert parse('1h') == 3600", "", "def test_upper():", "    assert parse('1H') == 3600", ""].join("\n");
  test("control: an edit inside the named test body is in scope", () => {
    expect(editScopeViolation(PY, PY.replace("== 3600", "== 3601").replace("3601", "3600 + 0"), "test_hours")).toBeNull();
  });
  test("a decorator and import added right above the next test are not an edit of the previous test", () => {
    const evil = PY.replace("    assert parse('1h') == 3600\n\ndef test_upper", "    assert parse('1h') == 3601\nimport pytest\n@pytest.mark.skip\ndef test_upper").replace("def test_upper():\n    assert parse('1H') == 3600\n\n", "def test_upper():\n    assert parse('1H') == 3600\n\n");
    expect(editScopeViolation(PY, evil, "test_hours")).toMatch(/indentation|outside/);
    const glued = ["def test_a():", "    assert 1 == 2", "def test_b():", "    assert 2 == 2", ""].join("\n");
    expect(editScopeViolation(glued, glued.replace("def test_b", "@skip\ndef test_b"), "test_a")).toMatch(/indentation/);
  });
  test("a module-level reassignment appended after the last test is rejected", () => {
    const evil = `${PY}test_upper = lambda: None\n`;
    expect(editScopeViolation(PY, evil, "test_upper")).toMatch(/indentation|outside/);
    expect(editScopeViolation(PY.trimEnd(), `${PY.trimEnd()}\ntest_upper = lambda: None`, "test_upper")).toMatch(/indentation/);
  });
  test("an added line deeper than the definition is still allowed after the last body line", () => {
    expect(editScopeViolation(PY, PY.replace("    assert parse('1H') == 3600", "    assert parse('1H') == 3600\n    assert parse('2H') == 7200"), "test_upper")).toBeNull();
  });
});

describe("Wall arbitration survives a resume", () => {
  test("the emitted event rebuilds the arbitrated Wall hash and the disclosure on a restored wall output", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-e15-res-")); const evs: { type: string; data: Record<string, unknown> }[] = [];
    try {
      mkdirSync(join(repoDir, "tests"), { recursive: true }); mkdirSync(join(repoDir, ".loki", "run", "wall"), { recursive: true });
      const path = join(repoDir, WALL); writeFileSync(path, ORIG, "utf8"); writeFileSync(join(repoDir, ".loki", "run", "wall", WNAME), ORIG, "utf8");
      const mkWall = (): Record<string, unknown> => ({ files: [{ path, sha256: sha(ORIG), runner: "bun" }], readOnlyFiles: [{ path, content: ORIG }] });
      const live = mkWall(), s = new Referees(A_GOOD, B_YES), base = mkdtempSync(join(tmpdir(), "loki-e15-resbase-"));
      const ctx = { ...ctxOf(s), repoDir, runDir: join(repoDir, ".loki", "run"), baseSha: "base", emit: (type: string, _s: unknown, data: Record<string, unknown>) => { evs.push({ type, data }); }, outputs: () => ({ wall: live, intake: { task: TASK } }) } as unknown as RunContext;
      const deps: RefereeDeps = { baseTree: () => base, runCheck: (dir: string, ref: TestRef) => { const c = readFileSync(join(dir, ref.path), "utf8"); return dir === repoDir ? (/5430/.test(c) ? "fail" : "pass") : "fail"; } };
      expect(await adjudicateWallConflict(ctx, first(), sess(CLAIM), [{ path, content: ORIG }], deps)).not.toBeNull();
      expect(evs.filter((e) => e.type === "wall.arbitrated").length).toBe(1);
      // a resumed run restores the wall stage.completed data as it was before the arbitration, then replays the events
      const restored = mkWall(); applyArbitrations(restored, evs);
      expect((restored.files as { sha256: string }[])[0]!.sha256).toBe(sha(GOOD)); expect((restored.readOnlyFiles as { content: string }[])[0]!.content).toBe(GOOD);
      const arb = (restored.arbitrated as Record<string, string>[])[0]!; expect(arb).toMatchObject({ check: WALL, test: "parses padded", spec_quote: QUOTE, sha256: sha(GOOD) });
      applyArbitrations(restored, evs); expect((restored.arbitrated as unknown[]).length).toBe(1); // replay is idempotent
      const forged = mkWall(); applyArbitrations(forged, [{ type: "wall.arbitrated", data: { path, content: "tampered", arbitration: { ...arb } } }]);
      expect((forged.files as { sha256: string }[])[0]!.sha256).toBe(sha(ORIG)); expect(forged.arbitrated).toBeUndefined(); // content must hash to the recorded sha
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });
  test("resumeMachineOpts replays a post-stage wall.arbitrated event into the restored Wall output", () => {
    const path = "/r/tests/loki_wall_x.py", mkEv = (seq: number, type: string, stage: string | null, data: Record<string, unknown>) => ({ type, stage, data, seq, ts: "2026-01-01T00:00:00Z", run: "r" }) as never;
    const wallData = { files: [{ path, sha256: sha(ORIG), runner: "pytest" }], readOnlyFiles: [{ path, content: ORIG }] };
    const arb = { check: "pytest:tests/loki_wall_x.py", test: "t", old_assertion: "a", new_assertion: "b", spec_quote: "q", sha256: sha(GOOD) };
    const events = [mkEv(0, "run.started", null, {}), mkEv(1, "stage.completed", "intake", { base_sha: "b" }), mkEv(2, "stage.completed", "plan", {}), mkEv(3, "stage.completed", "wall", wallData), mkEv(4, "wall.arbitrated", "wall", { path, content: GOOD, arbitration: arb })];
    const r = resumeMachineOpts({}, events, undefined, ["intake", ["plan", "wall"], "implement"] as const);
    expect(r.ok).toBe(true); if (!r.ok) return;
    const w = r.restored["wall"] as { files: { sha256: string }[]; readOnlyFiles: { content: string }[]; arbitrated?: unknown[] };
    expect(w.arbitrated?.length).toBe(1); expect(w.files[0]!.sha256).toBe(sha(GOOD)); expect(w.readOnlyFiles[0]!.content).toBe(GOOD);
    expect(wallData.files[0]!.sha256).toBe(sha(ORIG)); // the stored event data is never mutated
  });
  test("a declined arbitration records why, and changes nothing on resume", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-e15-dec-")); const evs: { type: string; data: Record<string, unknown> }[] = [];
    try {
      mkdirSync(join(repoDir, "tests"), { recursive: true }); mkdirSync(join(repoDir, ".loki", "run", "wall"), { recursive: true });
      const path = join(repoDir, WALL); writeFileSync(path, ORIG, "utf8"); writeFileSync(join(repoDir, ".loki", "run", "wall", WNAME), ORIG, "utf8");
      const wall: Record<string, unknown> = { files: [{ path, sha256: sha(ORIG), runner: "pytest" }], readOnlyFiles: [{ path, content: ORIG }] };
      const base = mkdtempSync(join(tmpdir(), "loki-e15-decbase-"));
      const ctx = { ...ctxOf(new Referees(A_GOOD, B_YES)), repoDir, runDir: join(repoDir, ".loki", "run"), emit: (type: string, _s: unknown, data: Record<string, unknown>) => { evs.push({ type, data }); }, outputs: () => ({ wall, intake: { task: TASK } }) } as unknown as RunContext;
      const deps: RefereeDeps = { baseTree: () => base, runCheck: (dir: string) => (dir === repoDir ? (/5430/.test(readFileSync(path, "utf8")) ? "fail" : "pass") : "not_run") };
      expect(await adjudicateWallConflict(ctx, first(), sess(CLAIM), [{ path, content: ORIG }], deps)).toBeNull();
      expect(evs).toEqual([{ type: "wall.arbitrated", data: { path, declined: expect.stringContaining("not_run") } }] as never);
      expect(readFileSync(path, "utf8")).toBe(ORIG); applyArbitrations(wall, evs); expect(wall.arbitrated).toBeUndefined();
    } finally { rmSync(repoDir, { recursive: true, force: true }); }
  });
});

describe("base copy for red-on-base", () => {
  test("an untracked project virtualenv is linked into the base copy, not copied", () => {
    const repo = mkdtempSync(join(tmpdir(), "loki-e15-bt-")); let base: string | null = null;
    try {
      const g = (...a: string[]): void => { execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" }); };
      g("init", "-q"); writeFileSync(join(repo, "a.py"), "x = 1\n"); g("add", "a.py"); g("commit", "-q", "-m", "i");
      mkdirSync(join(repo, ".venv", "bin"), { recursive: true }); writeFileSync(join(repo, ".venv", "bin", "python"), "");
      const sha1 = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      base = defaultBaseTree({ repoDir: repo, baseSha: sha1 } as RunContext);
      expect(base).not.toBeNull(); expect(existsSync(join(base!, "a.py"))).toBe(true);
      expect(lstatSync(join(base!, ".venv")).isSymbolicLink()).toBe(true); expect(existsSync(join(base!, ".venv", "bin", "python"))).toBe(true);
    } finally { if (base) rmSync(base, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
    expect(base !== null && existsSync(join(repo, ".venv"))).toBe(false);
  });
});
