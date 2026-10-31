// T2 mutation proof v1: a tiny real git repo where the Wall test genuinely fails or passes on the base (pre-fix) tree.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutationEnabled, mutationProof } from "../../src/util/mutation_proof.ts";
import { RealBaseTestRunner } from "../../src/engine10/stages/wall.ts";
import { sealStage } from "../../src/engine10/stages/seal.ts";
import type { EventType, Receipt, RunContext, StageName } from "../../src/engine10/types.ts";

let root = "";
const sh = (argv: string[], cwd: string): string => {
  const p = Bun.spawnSync({ cmd: argv, cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} -> ${p.exitCode}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};
const WALL = "loki_wall_f.test.ts";
const wallBody = (expected: number) => `import { expect, test } from "bun:test";\nimport { f } from "./src/f.ts";\ntest("f", async () => { expect(f()).toBe(${expected}); });\n`;
type Fx = { repo: string; base: string; head: string; runDir: string };
// base: f() returns 1; head (the fix): f() returns 2. The Wall test expects `expected`.
function fixture(name: string, expected: number): Fx {
  const repo = join(root, name); mkdirSync(join(repo, "src"), { recursive: true });
  sh(["git", "init", "-q", "-b", "main"], repo); sh(["git", "config", "user.name", "t"], repo); sh(["git", "config", "user.email", "t@t.invalid"], repo);
  writeFileSync(join(repo, "src/f.ts"), "export const f = () => 1;\n"); sh(["git", "add", "src/f.ts"], repo); sh(["git", "commit", "-q", "-m", "base"], repo);
  const base = sh(["git", "rev-parse", "HEAD"], repo).trim();
  writeFileSync(join(repo, "src/f.ts"), "export const f = () => 2;\n"); sh(["git", "add", "src/f.ts"], repo); sh(["git", "commit", "-q", "-m", "fix"], repo);
  const head = sh(["git", "rev-parse", "HEAD"], repo).trim();
  writeFileSync(join(repo, WALL), wallBody(expected)); // uncommitted Wall file, as in a real run
  const runDir = join(repo, ".loki/runs/r1"); mkdirSync(join(runDir, "wall"), { recursive: true });
  writeFileSync(join(runDir, "wall", WALL), wallBody(expected));
  writeFileSync(join(runDir, "events.jsonl"), JSON.stringify({ v: 1, seq: 0, ts: "2026-01-01T00:00:00.000Z", run: "r1", type: "run.started", stage: null, data: {} }) + "\n");
  return { repo, base, head, runDir };
}
const input = (f: Fx, over: Record<string, unknown> = {}) => ({
  repoDir: f.repo, baseSha: f.base, runDir: f.runDir, wallFiles: [{ path: join(f.repo, WALL) }], checks: [{ name: `bun:${WALL}` }], runner: new RealBaseTestRunner(null), ...over,
});
const worktrees = (repo: string) => sh(["git", "worktree", "list", "--porcelain"], repo).split("\n").filter((l) => l.startsWith("worktree ")).length;
const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith("loki-mutproof-") && !n.startsWith("loki-mutproof-test-")).length;

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "loki-mutproof-test-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("mutation proof outcomes", () => {
  test("yes: the Wall test fails on the base tree without the fix", async () => {
    const f = fixture("yes", 2); const before = leftovers();
    const r = await mutationProof(input(f));
    expect(r.outcome).toBe("yes"); expect(r.line).toBe("test fails without the fix: yes");
    expect(worktrees(f.repo)).toBe(1); expect(leftovers()).toBe(before);
  });
  test("no: the Wall test passes on the base tree", async () => {
    const f = fixture("no", 1); const r = await mutationProof(input(f));
    expect(r.outcome).toBe("no"); expect(r.line).toStartWith("test fails without the fix: no"); expect(worktrees(f.repo)).toBe(1);
  });
  test("inconclusive: no Wall tests, no recorded command, unknown base, runner that does not execute", async () => {
    const f = fixture("np", 2);
    expect((await mutationProof(input(f, { wallFiles: [] }))).line).toBe("test fails without the fix: inconclusive (no Wall tests)");
    expect((await mutationProof(input(f, { checks: [] }))).outcome).toBe("inconclusive");
    const bad = await mutationProof(input(f, { baseSha: "0".repeat(40) }));
    expect(bad.line).toBe("test fails without the fix: inconclusive (could not create the base worktree)");
    const nr = await mutationProof(input(f, { runner: { run: () => ({ pass: 0, fail: 0, not_run: 1 }) } }));
    expect(nr.outcome).toBe("inconclusive");
    expect(worktrees(f.repo)).toBe(1);
  });
  test("inconclusive: timeout, and the worktree is still removed", async () => {
    const f = fixture("to", 2);
    const r = await mutationProof(input(f, { timeoutS: -1 }));
    expect(r.line).toBe("test fails without the fix: inconclusive (timeout)"); expect(worktrees(f.repo)).toBe(1);
  });
  test("negative timeout env falls back to 30s, not an already-past deadline", async () => {
    for (const bad of ["-5", "0", "NaN", "Infinity", "abc"]) {
      const f = fixture(`negenv${bad.replace(/\W/g, "")}`, 2);
      const r = await mutationProof(input(f, { env: { LOKI_MUTATION_PROOF_TIMEOUT_S: bad } }));
      expect(r.outcome).toBe("yes");
    }
  });
  test("worktree removed when the runner throws", async () => {
    const f = fixture("throw", 2); const before = leftovers();
    const r = await mutationProof(input(f, { runner: { run: () => { throw new Error("boom"); } } }));
    expect(r.outcome).toBe("inconclusive"); expect(r.line).toContain("boom");
    expect(worktrees(f.repo)).toBe(1); expect(leftovers()).toBe(before);
  });
  test("B1: an ignored local package is linked into the base worktree, so a passing Wall test is never a false yes", async () => {
    const f = fixture("dep", 1);
    mkdirSync(join(f.repo, "node_modules/localpkg"), { recursive: true });
    writeFileSync(join(f.repo, "node_modules/localpkg/index.js"), "module.exports = { v: 1 };\n");
    writeFileSync(join(f.repo, "node_modules/localpkg/package.json"), '{"name":"localpkg","main":"index.js"}\n');
    const body = `import { expect, test } from "bun:test";\nimport { v } from "localpkg";\ntest("dep", async () => { expect(v).toBe(1); });\n`;
    writeFileSync(join(f.repo, WALL), body); writeFileSync(join(f.runDir, "wall", WALL), body);
    const r = await mutationProof(input(f));
    expect(r.outcome).toBe("no"); expect(worktrees(f.repo)).toBe(1);
  });
  test("B2: a slow runner is inconclusive (timeout) and the total stays under the clamp", async () => {
    const f = fixture("slow", 2); const t0 = Date.now();
    const r = await mutationProof(input(f, { timeoutS: 1, runner: () => ({ run: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300); return { pass: 0, fail: 0, not_run: 0 }; } }) }));
    expect(r.line).toBe("test fails without the fix: inconclusive (timeout)"); expect(Date.now() - t0).toBeLessThan(6000); expect(worktrees(f.repo)).toBe(1);
  });
  test("N1: a Wall file without a recorded command is inconclusive", async () => {
    const f = fixture("n1", 2);
    const r = await mutationProof(input(f, { wallFiles: [{ path: join(f.repo, WALL) }, { path: join(f.repo, "loki_wall_other.test.ts") }] }));
    expect(r.outcome).toBe("inconclusive");
  });
  test("a deleted sealed Wall copy is reported, not replaced by the working-tree file", async () => {
    const f = fixture("sealedgone", 1);
    rmSync(join(f.runDir, "wall", WALL));
    const r = await mutationProof(input(f));
    expect(r.outcome).toBe("inconclusive"); expect(r.line).toContain("sealed Wall copy missing"); expect(r.line).toContain(WALL);
    expect(worktrees(f.repo)).toBe(1);
  });
  test("the concurrent Wall run yields byte-identical proof lines to the serial run (yes, no)", async () => {
    for (const [name, expected, outcome] of [["par-yes", 2, "yes"], ["par-no", 1, "no"]] as const) {
      const f = fixture(name, expected); const extra = ["loki_wall_g.test.ts", "loki_wall_h.test.ts"];
      for (const w of extra) { writeFileSync(join(f.repo, w), wallBody(1)); writeFileSync(join(f.runDir, "wall", w), wallBody(1)); }
      const wallFiles = [WALL, ...extra].map((w) => ({ path: join(f.repo, w) })), checks = [WALL, ...extra].map((w) => ({ name: `bun:${w}` }));
      const real = new RealBaseTestRunner(null), serial = { run: (d: string, t: { runner: string; path: string }[]) => real.run(d, t as never) }; // no runEach: the serial path
      const a = await mutationProof(input(f, { wallFiles, checks, runner: serial })), b = await mutationProof(input(f, { wallFiles, checks, runner: real }));
      expect(JSON.stringify(b)).toBe(JSON.stringify(a)); expect(b.outcome).toBe(outcome); expect(b.line).toBe(`test fails without the fix: ${outcome}${outcome === "no" ? " (warning: the Wall tests also pass on the old code)" : ""}`);
    }
  });
  test("shared scratch path: two Wall files on one fixed path give the same proof serial and concurrent, never a false yes", async () => {
    const f = fixture("shared", 1); const names = ["loki_wall_s1.test.ts", "loki_wall_s2.test.ts"];
    const body = `import { expect, test } from "bun:test";\nimport { existsSync, rmSync, writeFileSync } from "node:fs";\nconst m = import.meta.dir + "/.scratch";\ntest("s", async () => { expect(existsSync(m)).toBe(false); writeFileSync(m, "1"); await Bun.sleep(500); rmSync(m); });\n`;
    for (const w of names) { writeFileSync(join(f.repo, w), body); writeFileSync(join(f.runDir, "wall", w), body); }
    const over = { wallFiles: names.map((w) => ({ path: join(f.repo, w) })), checks: names.map((w) => ({ name: `bun:${w}` })), runner: new RealBaseTestRunner(null) };
    const serial = await mutationProof(input(f, { ...over, env: { LOKI_MUTATION_PROOF_JOBS: "1" } })), conc = await mutationProof(input(f, { ...over, env: { LOKI_MUTATION_PROOF_JOBS: "4" } }));
    expect(serial.outcome).toBe("no"); expect(JSON.stringify(conc)).toBe(JSON.stringify(serial));
  });
  test("leftover files from the concurrent run do not poison the confirming re-run (no EEXIST false yes)", async () => {
    const f = fixture("leftover", 1); const tags = ["A", "B"], names = tags.map((t) => `loki_wall_l${t}.test.ts`);
    const body = (t: string) => `import { expect, test } from "bun:test";\nimport { mkdirSync, readFileSync, writeFileSync } from "node:fs";\ntest("l", async () => { mkdirSync(import.meta.dir + "/out_${t}"); writeFileSync(import.meta.dir + "/shared_state.txt", "${t}"); await Bun.sleep(500); expect(readFileSync(import.meta.dir + "/shared_state.txt", "utf8")).toBe("${t}"); });\n`;
    tags.forEach((t, k) => { writeFileSync(join(f.repo, names[k]!), body(t)); writeFileSync(join(f.runDir, "wall", names[k]!), body(t)); });
    const over = { wallFiles: names.map((w) => ({ path: join(f.repo, w) })), checks: names.map((w) => ({ name: `bun:${w}` })), runner: new RealBaseTestRunner(null) };
    const serial = await mutationProof(input(f, { ...over, env: { LOKI_MUTATION_PROOF_JOBS: "1" } })), conc = await mutationProof(input(f, { ...over, env: { LOKI_MUTATION_PROOF_JOBS: "4" } }));
    expect(serial.outcome).toBe("no"); expect(JSON.stringify(conc)).toBe(JSON.stringify(serial));
  });
  test("a concurrent-only fail never yields yes; a fail that reproduces serially does", async () => {
    const f = fixture("conc-only", 1); const names = ["loki_wall_c1.test.ts", "loki_wall_c2.test.ts"];
    const over = { wallFiles: names.map((w) => ({ path: join(f.repo, w) })), checks: names.map((w) => ({ name: `bun:${w}` })) };
    for (const w of names) { writeFileSync(join(f.repo, w), wallBody(1)); writeFileSync(join(f.runDir, "wall", w), wallBody(1)); }
    const mkr = (serialFail: number) => ({ run: () => ({ pass: 1 - serialFail, fail: serialFail }), runEach: async (_d: string, t: unknown[]) => t.map((_, k) => ({ pass: k ? 1 : 0, fail: k ? 0 : 1 })) });
    expect((await mutationProof(input(f, { ...over, runner: mkr(0) }))).outcome).toBe("no");
    expect((await mutationProof(input(f, { ...over, runner: mkr(1) }))).outcome).toBe("yes");
  });
  test("budget: the serial path builds the runner from the remaining budget per file", async () => {
    const f = fixture("budget-serial", 2); const names = ["loki_wall_b1.test.ts", "loki_wall_b2.test.ts", "loki_wall_b3.test.ts"], calls: number[] = [];
    for (const w of names) { writeFileSync(join(f.repo, w), wallBody(1)); writeFileSync(join(f.runDir, "wall", w), wallBody(1)); }
    const run = () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); return { pass: 1, fail: 0, not_run: 0 }; };
    await mutationProof(input(f, { wallFiles: names.map((w) => ({ path: join(f.repo, w) })), checks: names.map((w) => ({ name: `bun:${w}` })), timeoutS: 5, env: { LOKI_MUTATION_PROOF_JOBS: "1" }, runner: (ms: number) => { calls.push(ms); return { run }; } }));
    expect(calls.length).toBeGreaterThanOrEqual(3); expect(Math.max(...calls)).toBeLessThanOrEqual(5000); expect(calls[calls.length - 1]!).toBeLessThan(calls[0]! - 400);
  });
  test("budget: an already spent deadline is a timeout and no runner is built", async () => {
    const f = fixture("budget-pre", 2); const names = ["loki_wall_p1.test.ts", "loki_wall_p2.test.ts"]; let built = 0;
    for (const w of names) { writeFileSync(join(f.repo, w), wallBody(1)); writeFileSync(join(f.runDir, "wall", w), wallBody(1)); }
    const r = await mutationProof(input(f, { wallFiles: names.map((w) => ({ path: join(f.repo, w) })), checks: names.map((w) => ({ name: `bun:${w}` })), timeoutS: 0.001, runner: () => { built++; return { run: () => ({ pass: 0, fail: 1 }) }; } }));
    expect(r.line).toBe("test fails without the fix: inconclusive (timeout)"); expect(built).toBe(0);
  });
  test("budget: a concurrent run that outlives the budget is a timeout, never yes", async () => {
    const f = fixture("budget-conc", 2); const names = ["loki_wall_q1.test.ts", "loki_wall_q2.test.ts"];
    for (const w of names) { writeFileSync(join(f.repo, w), wallBody(1)); writeFileSync(join(f.runDir, "wall", w), wallBody(1)); }
    const slow = { run: () => ({ pass: 0, fail: 1 }), runEach: async (_d: string, t: unknown[]) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300); return t.map(() => ({ pass: 0, fail: 1 })); } };
    const r = await mutationProof(input(f, { wallFiles: names.map((w) => ({ path: join(f.repo, w) })), checks: names.map((w) => ({ name: `bun:${w}` })), timeoutS: 1, runner: slow }));
    expect(r.line).toBe("test fails without the fix: inconclusive (timeout)");
  });
  test("budget: runEach starts no new file once the budget is spent and a spent slot is a timeout", async () => {
    const f = fixture("budget-stop", 2); const names = Array.from({ length: 6 }, (_, k) => `loki_wall_r${k}.test.ts`);
    for (const w of names) { writeFileSync(join(f.repo, w), `import { test } from "bun:test";\ntest("t", async () => { await Bun.sleep(700); });\n`); writeFileSync(join(f.runDir, "wall", w), readFileSync(join(f.repo, w))); }
    const t0 = Date.now();
    const r = await mutationProof(input(f, { wallFiles: names.map((w) => ({ path: join(f.repo, w) })), checks: names.map((w) => ({ name: `bun:${w}` })), timeoutS: 1, env: { LOKI_MUTATION_PROOF_JOBS: "2" }, runner: (ms: number) => new RealBaseTestRunner(null, ms) }));
    expect(r.line).toBe("test fails without the fix: inconclusive (timeout)"); expect(Date.now() - t0).toBeLessThan(4500);
  });
  test("runEach: a spent budget starts no new file (empty slot) and clamps a running file's timeout", async () => {
    const f = fixture("runeach", 1); const ok = ["loki_wall_e1.test.ts", "loki_wall_e2.test.ts", "loki_wall_e3.test.ts"];
    for (const w of ok) writeFileSync(join(f.repo, w), wallBody(2));
    let asked = 0; const rn = new RealBaseTestRunner(null);
    const res = await rn.runEach(f.repo, ok.map((path) => ({ runner: "bun", path })) as never, 1, false, () => asked++ >= 1 ? 0 : 1000);
    expect(res[0]).toBeDefined(); expect(res[1]).toBeUndefined(); expect(res[2]).toBeUndefined();
    writeFileSync(join(f.repo, "loki_wall_slow.test.ts"), `import { test } from "bun:test";\ntest("t", async () => { await Bun.sleep(4000); });\n`);
    const t0 = Date.now(); const slow = await rn.runEach(f.repo, [{ runner: "bun", path: "loki_wall_slow.test.ts" }] as never, 1, false, () => 1000);
    expect(Date.now() - t0).toBeLessThan(3000); expect(slow[0]!.pass).toBe(0);
  });
  test("opt-out flag", async () => {
    expect(mutationEnabled({ LOKI_MUTATION_PROOF: "0" })).toBe(false);
    expect(mutationEnabled({})).toBe(true);
  });
});

function sealCtx(f: Fx) {
  const outputs: Partial<Record<StageName, Record<string, unknown>>> = {
    intake: { source: "text", task_sha256: "ab".repeat(32), repo: "o/r", title: "fix f", resumed: false },
    wall: { files: [{ path: join(f.repo, WALL), sha256: "cd".repeat(32) }] },
    implement: { exit: "done", tests_reverted: [], duration_s: 3, iteration_id: "e10-r1-impl" },
    verify: { checks: [{ name: `bun:${WALL}`, cmd: `bun test ${WALL}`, result: "pass", n: 1, duration_s: 1.5 }], flaky: [], wall_passed: true, duration_s: 2 },
  };
  const ctx: RunContext = {
    runId: "r1", repoDir: f.repo, runDir: f.runDir, baseSha: f.base, branch: "loki/r1", provider: "claude", model: "m", deep: false, capS: 900,
    emit: (_t: EventType, _s: StageName | null, _d: Record<string, unknown>) => {},
    sessions: { run: async () => { throw new Error("no sessions in seal"); } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 }) },
    clock: { now: () => 0 }, outputs: () => outputs,
  };
  return ctx;
}
const sealed = async (f: Fx, ctx = sealCtx(f)) => {
  const s = await sealStage.run(ctx, new AbortController().signal);
  return { s, r: JSON.parse(readFileSync(s.data["receipt_path"] as string, "utf8")) as Receipt };
};

describe("mutation proof in seal", () => {
  const key = process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"], prev = process.env["LOKI_MUTATION_PROOF"];
  beforeAll(() => { process.env["LOKI_RECEIPT_SIGNING_KEY"] = ""; process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = join(root, "nokey", "k.pem"); delete process.env["LOKI_MUTATION_PROOF"]; });
  afterAll(() => { if (key === undefined) delete process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"]; else process.env["LOKI_RECEIPT_SIGNING_KEY_FILE"] = key; if (prev !== undefined) process.env["LOKI_MUTATION_PROOF"] = prev; });

  test("yes keeps VERIFIED and records the line on the receipt and seal output", async () => {
    const { s, r } = await sealed(fixture("s-yes", 2));
    expect(r.verdict).toBe("VERIFIED"); expect(r.mutation_proof).toBe("test fails without the fix: yes"); expect(r.mutation_outcome).toBe("yes");
    expect(s.data["mutation_line"]).toBe("test fails without the fix: yes");
    expect(readFileSync(join(s.data["receipt_path"] as string, "..", "receipt.md"), "utf8")).toContain("- test fails without the fix: yes");
  });
  const withPlan = (f: Fx, bc: boolean | undefined) => { const c = sealCtx(f); if (bc !== undefined) (c.outputs() as Record<string, unknown>)["plan"] = { plan: "p", behavior_change: bc }; return c; };
  const strict = async (f: Fx, bc: boolean | undefined) => { process.env["LOKI_MUTATION_STRICT"] = "1"; try { return await sealed(f, withPlan(f, bc)); } finally { delete process.env["LOKI_MUTATION_STRICT"]; } };
  test("default: tests that pass on the old code stay VERIFIED, with the warning and the counted outcome", async () => {
    const f = fixture("s-no", 1); const { s, r } = await sealed(f, withPlan(f, true));
    expect(r.verdict).toBe("VERIFIED"); expect(r.mutation_outcome).toBe("no");
    expect(r.mutation_proof).toContain("warning"); expect(s.data["mutation_line"]).toBe(r.mutation_proof);
    expect(r.not_proven.some((n) => n.includes("Wall tests passed without the fix"))).toBe(true);
    expect(r.not_proven.some((n) => n.includes("downgraded"))).toBe(false);
  });
  test("LOKI_MUTATION_STRICT=1 with a declared behavior change: VERIFIED becomes PARTIAL", async () => {
    const { r } = await strict(fixture("s-strict-yes", 1), true);
    expect(r.verdict).toBe("PARTIAL"); expect(r.mutation_outcome).toBe("no"); expect(r.not_proven.some((n) => n.includes("downgraded to PARTIAL"))).toBe(true);
  });
  test("LOKI_MUTATION_STRICT=1 without a declaration, or declared false: stays VERIFIED", async () => {
    expect((await strict(fixture("s-strict-undecl", 1), undefined)).r.verdict).toBe("VERIFIED");
    expect((await strict(fixture("s-strict-false", 1), false)).r.verdict).toBe("VERIFIED");
  });
  test("inconclusive never changes the verdict", async () => {
    const f = fixture("s-np", 2);
    const ctx = sealCtx(f); (ctx.outputs().verify as { checks: unknown[] }).checks = [{ name: "bun", cmd: "bun test", result: "pass", n: 1, duration_s: 1 }];
    const { r } = await sealed(f, ctx);
    expect(r.verdict).toBe("VERIFIED"); expect(r.mutation_proof).toBe("test fails without the fix: inconclusive (no recorded Wall test command)");
  });
  test("LOKI_MUTATION_PROOF=0: no key on the receipt, verdict as before, no worktree touched", async () => {
    process.env["LOKI_MUTATION_PROOF"] = "0";
    try {
      const f = fixture("s-off", 1); const { s, r } = await sealed(f);
      expect(r.verdict).toBe("VERIFIED"); expect("mutation_proof" in r).toBe(false); expect("mutation_line" in s.data).toBe(false);
      expect(worktrees(f.repo)).toBe(1);
    } finally { delete process.env["LOKI_MUTATION_PROOF"]; }
  });
});
