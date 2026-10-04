// FC-21b S4: VERIFIED earned after an implement time limit, A1 (a limit that did not kill never seals VERIFIED), A2 (a resumed implement gets only the
// budget left, both briefs end with FINISH_LINE), a killed session's Wall edit restored before verify, L7 (one outcome), and the post-plan cap resize.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMachine } from "../../src/engine10/machine.ts";
import { EXIT, outcomeOf } from "../../src/engine10/output.ts";
import { sealStage, targetProofOf, verdictOf } from "../../src/engine10/stages/seal.ts";
import { FINISH_LINE } from "../../src/e10ext/context.ts";
import { CONFLICT_CORRECTION } from "../../src/util/conflict_resume.ts";
import type { Obj, ReceiptCheck, RunContext, Stage, StageName } from "../../src/engine10/types.ts";

let tmp = "";
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "fc21b-verdict-")); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

const pass: ReceiptCheck = { name: "bun:t.test.ts", cmd: "bun test", result: "pass", duration_s: 1 };
const limitOut = (extra: Obj = {}): Partial<Record<StageName, Obj>> => ({ implement: { exit: "killed", limit_s: 480, elapsed_s: 480, ...extra } });
const v = (o: Partial<Record<StageName, Obj>>, checks: ReceiptCheck[], targetProof: boolean, notProven = false, proof = true) => verdictOf(o, checks, false, notProven, false, proof, targetProof);

describe("FC-21b (1): VERIFIED after a limit is earned", () => {
  test("a limit with green checks, executed proof and a target pass is VERIFIED", () => {
    expect(v(limitOut(), [pass], true)).toBe("VERIFIED");
  });
  test("a red check is PARTIAL, not VERIFIED", () => {
    expect(v(limitOut(), [pass, { ...pass, name: "bun:u.test.ts", result: "fail" }], true)).toBe("PARTIAL");
  });
  test("an unrun check is PARTIAL", () => {
    expect(v(limitOut(), [pass, { ...pass, name: "lint:tsc", result: "not_run" }], true)).toBe("PARTIAL");
  });
  test("no target check (no Wall or task-named test passed) is PARTIAL", () => {
    expect(v(limitOut(), [pass], false)).toBe("PARTIAL");
  });
  test("no executed proof, or verify not-proven, is PARTIAL", () => {
    expect(v(limitOut(), [pass], true, false, false)).toBe("PARTIAL");
    expect(v(limitOut(), [pass], true, true)).toBe("PARTIAL");
  });
  test("a killed run that recorded no limit is PARTIAL", () => {
    expect(v({ implement: { exit: "killed" } }, [pass], true)).toBe("PARTIAL");
  });
  test("targetProofOf needs a named target check that executed (n>0) and passed", () => {
    const checks = [{ name: "bun:w.test.ts", result: "pass", n: 3 }, { name: "bun:o.test.ts", result: "pass", n: 2 }];
    expect(targetProofOf({ checks, target_checks: ["bun:w.test.ts"] })).toBe(true);
    expect(targetProofOf({ checks, target_checks: [] })).toBe(false);
    expect(targetProofOf({ checks: [{ name: "bun:w.test.ts", result: "pass", n: 0 }], target_checks: ["bun:w.test.ts"] })).toBe(false);
    expect(targetProofOf(undefined)).toBe(false);
  });
});

describe("FC-21b A1: a limit that did not kill never seals VERIFIED", () => {
  test("a limit recorded with exit error or done is PARTIAL", () => {
    expect(v({ implement: { exit: "error", limit_s: 480 } }, [pass], true)).toBe("PARTIAL");
    expect(v({ implement: { exit: "done", limit_s: 480 } }, [pass], true)).toBe("PARTIAL");
  });
  test("an implement stage that throws when the limit aborts it is recorded as killed with its limit", async () => {
    const { ctx } = harness(tmp);
    const stages = stubs();
    stages.implement = st("implement", 1, async (_c, signal) => { await new Promise<void>((r) => signal.addEventListener("abort", () => r())); throw new Error("aborted"); });
    const r = await runMachine(ctx, { load: async (n) => stages[n] ?? null });
    expect(r.outputs.implement?.exit).toBe("killed");
    expect(r.outputs.implement?.limit_s).toBe(1);
    expect(typeof r.outputs.implement?.elapsed_s).toBe("number");
  });
});

describe("FC-21b: a killed session's Wall edit is restored before verify", () => {
  test("verify sees the sealed content and the restore is listed", async () => {
    const wallFile = join(tmp, "wall.test.ts");
    writeFileSync(wallFile, "SEALED\n");
    const { ctx } = harness(tmp);
    const stages = stubs();
    stages.wall = st("wall", 5, async () => ({ status: "completed", data: { readOnlyFiles: [{ path: wallFile, content: "SEALED\n" }] } }));
    stages.implement = st("implement", 1, async (_c, signal) => { writeFileSync(wallFile, "EDITED\n"); await sleep(5000, signal); return { status: "completed", data: {} }; });
    let seen = "";
    stages.verify = st("verify", 5, async () => { seen = readFileSync(wallFile, "utf8"); return { status: "completed", data: {} }; });
    const r = await runMachine(ctx, { load: async (n) => stages[n] ?? null });
    expect(seen).toBe("SEALED\n");
    expect(r.outputs.implement?.tests_reverted).toEqual(["wall.test.ts"]);
  });
});

describe("FC-21b A2: a resumed implement gets the budget left and both briefs end with FINISH_LINE", () => {
  test("second session limit is at most the budget minus elapsed; the note precedes the closing FINISH_LINE", async () => {
    const calls: { limitS: number; brief: string }[] = [];
    const { ctx } = harness(tmp);
    ctx.capS = 2700;
    ctx.sessions = { run: async (o) => { calls.push({ limitS: o.limitS, brief: String((o as { brief?: string }).brief) }); return { exit: 0 } as never; } };
    const stages = stubs();
    stages.implement = st("implement", 480, async (c) => {
      await c.sessions.run({ stage: "implement", brief: `BODY\n\n${FINISH_LINE}`, limitS: 480 } as never);
      await sleep(1200, new AbortController().signal);
      await c.sessions.run({ stage: "implement", brief: CONFLICT_CORRECTION, limitS: 480 } as never);
      return { status: "completed", data: {} };
    });
    await runMachine(ctx, { load: async (n) => stages[n] ?? null });
    expect(calls.length).toBe(2);
    expect(calls[1]!.limitS).toBeLessThanOrEqual(calls[0]!.limitS - 1);
    for (const c of calls) { expect(c.brief.endsWith(FINISH_LINE)).toBe(true); expect(c.brief).toMatch(/minutes? left/); }
  });
});

describe("FC-21b (3): one outcome, the receipt verdict", () => {
  test("a sealed receipt's verdict is the outcome even after a cap stop, and the exit code follows it", () => {
    for (const verdict of ["VERIFIED", "PARTIAL", "FAILED"] as const) {
      const o = outcomeOf(verdict, true, null, false, true);
      expect(o).toBe(verdict);
      expect(EXIT[o]).toBe(EXIT[verdict]);
    }
    expect(outcomeOf("PARTIAL", true, null, false, true)).not.toBe("BUDGET_STOP");
  });
  test("with no receipt sealed a cap stop stays BUDGET_STOP", () => {
    expect(outcomeOf("FAILED", true, null)).toBe("BUDGET_STOP");
  });
});

describe("FC-21b: the post-plan resize", () => {
  test("a larger sized cap is applied once, after plan, and never shrinks", async () => {
    const { ctx, events } = harness(tmp);
    let calls = 0;
    const stages = stubs();
    await runMachine(ctx, { load: async (n) => stages[n] ?? null, resize: () => { calls++; return 1800; } });
    expect(calls).toBe(1);
    expect(ctx.capS).toBe(1800);
    expect(events.filter((e) => e.type === "cap.sized").length).toBe(1);
    const h2 = harness(tmp);
    await runMachine(h2.ctx, { load: async (n) => stages[n] ?? null, resize: () => 300 });
    expect(h2.ctx.capS).toBe(900);
  });
  test("a resize throw keeps the current cap", async () => {
    const { ctx } = harness(tmp);
    const stages = stubs();
    await runMachine(ctx, { load: async (n) => stages[n] ?? null, resize: () => { throw new Error("x"); } });
    expect(ctx.capS).toBe(900);
  });
});

function harness(dir: string) {
  const events: { type: string; data: Record<string, unknown> }[] = [];
  mkdirSync(dir, { recursive: true });
  const ctx: RunContext = {
    runId: "e10-t", repoDir: dir, runDir: join(dir, "r"), baseSha: "a", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: (type, _s, data) => { events.push({ type, data }); },
    sessions: { run: async () => ({ exit: 0 }) as never },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() }, outputs: () => ({}),
  };
  return { ctx, events };
}
const st = (name: StageName, limitS: number, run?: Stage["run"]): Stage => ({ name, targetS: 1, limitS, run: run ?? (async () => ({ status: "completed", data: {} })) });
const sleep = (ms: number, s: AbortSignal) => new Promise<void>((r) => { const t = setTimeout(r, ms); s.addEventListener("abort", () => { clearTimeout(t); r(); }); });
const stubs = (): Partial<Record<StageName, Stage>> => { const s: Partial<Record<StageName, Stage>> = {}; for (const n of ["intake", "plan", "wall", "implement", "verify", "fix", "commit", "seal", "pr"] as StageName[]) s[n] = st(n, 5); return s; };

describe("FC-21b: the sealed receipt", () => {
  const sh = (cwd: string, ...argv: string[]): string => execFileSync(argv[0]!, argv.slice(1), { cwd, encoding: "utf8" });
  async function seal(name: string, implement: Obj, verify: Obj): Promise<{ verdict: string; implement_limit?: unknown }> {
    const repo = join(tmp, name);
    mkdirSync(join(repo, ".loki/runs/r1"), { recursive: true });
    sh(repo, "git", "init", "-q", "-b", "main");
    sh(repo, "git", "config", "user.name", "t"); sh(repo, "git", "config", "user.email", "t@t.invalid");
    writeFileSync(join(repo, "a.txt"), "one\n"); sh(repo, "git", "add", "a.txt"); sh(repo, "git", "commit", "-q", "-m", "base");
    const base = sh(repo, "git", "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "a.txt"), "two\n"); sh(repo, "git", "commit", "-q", "-am", "work");
    const outputs = { intake: { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", resumed: false }, wall: { files: [] }, implement, verify } as Partial<Record<StageName, Obj>>;
    const { ctx } = harness(repo);
    const c2: RunContext = { ...ctx, runId: "r1", runDir: join(repo, ".loki/runs/r1"), baseSha: base, outputs: () => outputs };
    const r = await sealStage.run(c2, new AbortController().signal);
    return JSON.parse(readFileSync(r.data.receipt_path as string, "utf8"));
  }
  const greenVerify = (target: string[]): Obj => ({ checks: [{ name: "bun:w.test.ts", cmd: "bun test", result: "pass", n: 2, duration_s: 1 }], flaky: [], wall_passed: true, target_checks: target });
  test("a limit with a target pass seals VERIFIED with implement_limit", async () => {
    const r = await seal("rv", { exit: "killed", limit_s: 480, elapsed_s: 481 }, greenVerify(["bun:w.test.ts"]));
    expect(r.verdict).toBe("VERIFIED");
    expect(r.implement_limit).toEqual({ limit_s: 480, elapsed_s: 481 });
  });
  test("a limit with no target check seals PARTIAL; a run with no limit has no implement_limit key", async () => {
    expect((await seal("rp", { exit: "killed", limit_s: 480, elapsed_s: 481 }, greenVerify([]))).verdict).toBe("PARTIAL");
    const none = await seal("rn", { exit: "done" }, greenVerify([]));
    expect(none.verdict).toBe("VERIFIED");
    expect("implement_limit" in none).toBe(false);
  });
});
