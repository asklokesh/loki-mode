// FC-19: one LOKI_SPEC_CONFLICT correction round; no wording of the reason is inspected.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixStage } from "../../src/engine10/stages/fix.ts";
import { verdictOf } from "../../src/engine10/stages/seal.ts";
import { wallAnchor, wallDropped } from "../../src/util/wall_owned.ts";
import { implementStage } from "../../src/engine10/stages/implement.ts";
import { CONFLICT_CORRECTION, answerMark, answeredTask, blockedCompletion, effectiveEvents } from "../../src/util/conflict_resume.ts";
import { FINISH_LINE } from "../../src/e10ext/context.ts";
import type { RunContext, SessionResult, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

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

// FC-WALL-DEFECT-REPORTED-AS-SPEC-CONFLICT: a conflict anchored on a Wall file is Loki's defect.
describe("Wall-anchored conflict is a harness defect", () => {
  const WALL = "tests/loki_wall_units.test.ts", ANCHORED = `${WALL}:93 expects 4 but the task says the total is 5`, REAL = "the task says keep the REST API unchanged and also replace it with GraphQL (src/api.ts:93)";
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  class Wallish implements SessionRunner {
    calls: SessionRunOptions[] = []; n = 0;
    constructor(private impl: SessionResult[], private rewrite: string | null = "// fixed\n") {}
    async run(o: SessionRunOptions): Promise<SessionResult> {
      this.calls.push(o);
      if (o.stage === "wall") { if (this.rewrite !== null) writeFileSync(join(o.cwd!, "loki_wall_units.test.ts"), this.rewrite, "utf8"); return done; }
      return this.impl[Math.min(this.n++, this.impl.length - 1)]!;
    }
  }
  function setup(s: SessionRunner) {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-e15-wallfc-")); dirs.push(repoDir);
    mkdirSync(join(repoDir, "tests"), { recursive: true });
    const path = join(repoDir, WALL); writeFileSync(path, "// original\n", "utf8");
    const wall = { readOnlyFiles: [{ path, content: "// original\n" }], files: [{ path, sha256: "x" }] };
    const ctx = { ...ctxOf(s), repoDir, runDir: join(repoDir, ".loki"), outputs: () => ({ wall }) } as unknown as RunContext;
    return { ctx, wall, path };
  }
  test("wallAnchor reads a path with an optional :line, and only for Wall files", () => {
    expect(wallAnchor(ANCHORED, [WALL])).toEqual({ file: WALL, line: 93 });
    expect(wallAnchor(`see loki_wall_units.test.ts:12`, [WALL])).toEqual({ file: WALL, line: 12 });
    expect(wallAnchor(REAL, [WALL])).toBeNull();
    expect(wallAnchor(`the wall file ${WALL} is wrong`, [WALL])).toEqual({ file: WALL, line: null }); // RUN5-S2b: the line is optional
  });
  // RUN5-S2b: run8 markers named a Wall file with no line; the reader demanded path:line the writer was never asked for.
  const RUN8_A = "`test_without_top_prints_all_words_sorted` in `tests/loki_wall_top_test.py` asserts sorted output but the task says insertion order", RUN8_B = "`tests/loki_wall_pricing.py` expects a 10% discount but the task says 15%";
  const RUN8_WALL = ["tests/loki_wall_top_test.py", "tests/loki_wall_pricing.py"] as const;
  test("RUN5-S2b wallAnchor accepts a Wall file by path or basename with no line, never a non-Wall file", () => {
    expect(wallAnchor(RUN8_A, RUN8_WALL)).toEqual({ file: RUN8_WALL[0], line: null });
    expect(wallAnchor(RUN8_B, RUN8_WALL)).toEqual({ file: RUN8_WALL[1], line: null });
    expect(wallAnchor("loki_wall_pricing.py expects 10%", RUN8_WALL)).toEqual({ file: RUN8_WALL[1], line: null });
    expect(wallAnchor(`${WALL}:93 x`, [WALL])).toEqual({ file: WALL, line: 93 });
    expect(wallAnchor("src/pricing.py expects 10% but the task says 15%", RUN8_WALL)).toBeNull();
    expect(wallAnchor("tests/other_top_test.py and top_test.py conflict", RUN8_WALL)).toBeNull();
    expect(wallAnchor("the task says keep the API and also replace it", RUN8_WALL)).toBeNull();
  });
  test("RUN5-S2b a run8 marker with no line drives the re-author path", async () => {
    const wallRel = "tests/loki_wall_units.test.ts";
    for (const marker of [`\`test_x\` in \`${wallRel}\` contradicts the task`, `\`loki_wall_units.test.ts\` expects 4 but the task says 5`]) {
      const s = new Wallish([conflict(marker), conflict(marker), done]); const { ctx, path } = setup(s);
      const r = await implementStage.run(ctx, new AbortController().signal);
      expect(r.data.exit).toBe("done");
      expect(r.data.spec_conflict_reason).toBeNull();
      expect(r.data.wall_defect).toMatchObject({ action: "reauthored", file: wallRel, line: null });
      expect(s.calls.filter((c) => c.stage === "wall").length).toBe(1);
      expect(readFileSync(path, "utf8")).toBe("// fixed\n");
    }
    const s2 = new Wallish([conflict(`\`${wallRel}\` is wrong`)]); const c2 = setup(s2);
    const r2 = await implementStage.run(c2.ctx, new AbortController().signal);
    expect(wallDropped({ implement: { exit: "done", wall_defect: r2.data.wall_defect }, intake: {} } as never)[0]).toContain(`${wallRel}: `);
  });
  test("RUN5-S2b the conflict marker ask names path:line of the cited test", () => {
    expect(FINISH_LINE).toContain("path:line");
  });
  test("a conflict naming the Wall file is not a spec conflict; the Wall is re-authored once and the run continues", async () => {
    const s = new Wallish([conflict(ANCHORED), conflict(ANCHORED), done]); const { ctx, path } = setup(s);
    const r = await implementStage.run(ctx, new AbortController().signal);
    expect(r.data.exit).toBe("done");
    expect(r.data.spec_conflict_reason).toBeNull();
    expect((r.data.wall_defect as { action: string }).action).toBe("reauthored");
    expect(s.calls.filter((c) => c.stage === "wall").length).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("// fixed\n");
  });
  test("a persistent Wall-anchored conflict drops the assertion, never re-authors twice, and caps the verdict at PARTIAL", async () => {
    const s = new Wallish([conflict(ANCHORED)]); const { ctx, wall, path } = setup(s);
    const r = await implementStage.run(ctx, new AbortController().signal);
    expect(r.data.exit).toBe("done");
    expect(s.calls.filter((c) => c.stage === "wall").length).toBe(1);
    expect((r.data.wall_defect as { action: string }).action).toBe("dropped");
    expect(existsSync(path)).toBe(false); expect(wall.readOnlyFiles.length).toBe(0); expect(wall.files.length).toBe(0);
    const o = { implement: { exit: "done", wall_defect: r.data.wall_defect }, intake: {} } as never;
    expect(wallDropped(o)[0]).toContain(`${WALL}:93`);
    const pass = { name: "vitest:a", cmd: "x", result: "pass" as const, duration_s: 1 };
    expect(verdictOf(o, [pass], false, false, false, true)).toBe("PARTIAL");
    expect(verdictOf({ implement: { exit: "done" }, intake: {} } as never, [pass], false, false, false, true)).toBe("VERIFIED");
  });
  test("control: a real user contradiction not anchored on the Wall stays a spec conflict, resumed once, no Wall session", async () => {
    const s = new Wallish([conflict(REAL)]); const { ctx } = setup(s);
    const r = await implementStage.run(ctx, new AbortController().signal);
    expect(r.data.exit).toBe("spec_conflict");
    expect(r.data.spec_conflict_reason).toBe(REAL);
    expect(r.data.wall_defect).toBeUndefined();
    expect(s.calls.length).toBe(2);
    expect(s.calls.some((c) => c.stage === "wall")).toBe(false);
  });
  test("fix leaves Wall files read-only after the pass", async () => {
    const { path, wall, ctx: base } = setup(new Wallish([done]));
    const sess: SessionRunner = { async run() { writeFileSync(path, "// tampered\n", "utf8"); return done; } };
    const ctx = { ...base, sessions: sess } as unknown as RunContext;
    const r = await fixStage.run(ctx, new AbortController().signal);
    expect(r.status).toBe("completed");
    expect(readFileSync(path, "utf8")).toBe("// original\n");
    expect(r.data.tests_reverted).toEqual([path]);
    expect(wall.readOnlyFiles.length).toBe(1);
  });
});

// FC-WALL-DEFECT-REPORTED-AS-SPEC-CONFLICT: a drop in one fix round must survive a later round that re-authors another Wall file.
describe("Wall drops persist across fix rounds", () => {
  const A = "tests/loki_wall_a.test.ts", B = "tests/loki_wall_b.test.ts", at = (f: string) => `${f}:93 expects 4 but the task says the total is 5`;
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  class Scripted implements SessionRunner {
    constructor(private impl: SessionResult[], private rewrite: boolean) {}
    n = 0;
    async run(o: SessionRunOptions): Promise<SessionResult> {
      if (o.stage === "wall") { if (this.rewrite) for (const f of [A, B]) { const base = f.split("/").pop()!; if (existsSync(join(o.cwd!, base))) writeFileSync(join(o.cwd!, base), "// fixed\n", "utf8"); } return done; }
      return this.impl[Math.min(this.n++, this.impl.length - 1)]!;
    }
  }
  function world() {
    const repoDir = mkdtempSync(join(tmpdir(), "loki-e15-wallfc-")); dirs.push(repoDir); mkdirSync(join(repoDir, "tests"), { recursive: true });
    for (const f of [A, B]) writeFileSync(join(repoDir, f), "// original\n", "utf8");
    const wall = { readOnlyFiles: [A, B].map((f) => ({ path: join(repoDir, f), content: "// original\n" })), files: [A, B].map((f) => ({ path: join(repoDir, f), sha256: "x" })) };
    return { repoDir, wall };
  }
  const round = async (w: ReturnType<typeof world>, s: SessionRunner, fix?: Record<string, unknown>) => {
    const ctx = { ...ctxOf(s), repoDir: w.repoDir, runDir: join(w.repoDir, ".loki"), outputs: () => ({ wall: w.wall, ...(fix ? { fix } : {}) }) } as unknown as RunContext;
    return (await fixStage.run(ctx, new AbortController().signal)).data;
  };
  const pass = { name: "vitest:a", cmd: "x", result: "pass" as const, duration_s: 1 };
  const verdict = (fix: Record<string, unknown>, implement: Record<string, unknown> = { exit: "done" }) => verdictOf({ implement, fix, intake: {} } as never, [pass], false, false, false, true);

  test("round 1 drops A, round 2 re-authors B: the drop stays on record and the verdict is PARTIAL", async () => {
    const w = world();
    const r1 = await round(w, new Scripted([conflict(at(A))], false));
    expect((r1.wall_defect as { action: string }).action).toBe("dropped");
    const r2 = await round(w, new Scripted([conflict(at(B)), conflict(at(B)), done], true), r1);
    expect(r2.wall_defect as { action: string; file: string }).toMatchObject({ action: "reauthored", file: B });
    const lines = wallDropped({ implement: { exit: "done" }, fix: r2, intake: {} } as never);
    expect(lines.length).toBe(1); expect(lines[0]).toContain(`${A}:93`);
    expect(verdict(r2)).toBe("PARTIAL");
  });
  test("control: no drop in any round stays VERIFIED", async () => {
    const w = world();
    const r1 = await round(w, new Scripted([done], false));
    const r2 = await round(w, new Scripted([conflict(at(B)), conflict(at(B)), done], true), r1);
    expect(wallDropped({ implement: { exit: "done" }, fix: r2, intake: {} } as never)).toEqual([]);
    expect(verdict(r2)).toBe("VERIFIED");
  });
  test("two drops across rounds both appear, and a repeated record is deduped", async () => {
    const w = world();
    const r1 = await round(w, new Scripted([conflict(at(A))], false));
    const r2 = await round(w, new Scripted([conflict(at(B))], false), r1);
    const lines = wallDropped({ implement: { exit: "done" }, fix: r2, intake: {} } as never);
    expect(lines.length).toBe(2); expect(lines.some((l) => l.includes(`${A}:93`))).toBe(true); expect(lines.some((l) => l.includes(`${B}:93`))).toBe(true);
    const dup = wallDropped({ implement: { exit: "done", wall_defect: r1.wall_defect }, fix: { ...r2, wall_defects: [...(r2.wall_defects as unknown[]), r1.wall_defect] }, intake: {} } as never);
    expect(dup.length).toBe(2);
  });
  test("a drop at implement followed by a fix re-author still caps", async () => {
    const w = world();
    const implement = { exit: "done", wall_defect: { file: A, line: 93, reason: "x", action: "dropped" } };
    const r2 = await round(w, new Scripted([conflict(at(B)), conflict(at(B)), done], true));
    expect((r2.wall_defect as { action: string }).action).toBe("reauthored");
    expect(wallDropped({ implement, fix: r2, intake: {} } as never)[0]).toContain(`${A}:93`);
    expect(verdict(r2, implement)).toBe("PARTIAL");
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
