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
const wallBody = (expected: number) => `import { expect, test } from "bun:test";\nimport { f } from "./src/f.ts";\ntest("f", () => { expect(f()).toBe(${expected}); });\n`;
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
  test("yes: the Wall test fails on the base tree without the fix", () => {
    const f = fixture("yes", 2); const before = leftovers();
    const r = mutationProof(input(f));
    expect(r.outcome).toBe("yes"); expect(r.line).toBe("test fails without the fix: yes");
    expect(worktrees(f.repo)).toBe(1); expect(leftovers()).toBe(before);
  });
  test("no: the Wall test passes on the base tree", () => {
    const f = fixture("no", 1); const r = mutationProof(input(f));
    expect(r.outcome).toBe("no"); expect(r.line).toBe("test fails without the fix: no"); expect(worktrees(f.repo)).toBe(1);
  });
  test("NOT PROVEN: no Wall tests, no recorded command, unknown base, runner that does not execute", () => {
    const f = fixture("np", 2);
    expect(mutationProof(input(f, { wallFiles: [] })).line).toBe("test fails without the fix: NOT PROVEN (no Wall tests)");
    expect(mutationProof(input(f, { checks: [] })).outcome).toBe("not_proven");
    const bad = mutationProof(input(f, { baseSha: "0".repeat(40) }));
    expect(bad.line).toBe("test fails without the fix: NOT PROVEN (could not create the base worktree)");
    const nr = mutationProof(input(f, { runner: { run: () => ({ pass: 0, fail: 0, not_run: 1 }) } }));
    expect(nr.outcome).toBe("not_proven");
    expect(worktrees(f.repo)).toBe(1);
  });
  test("NOT PROVEN: timeout, and the worktree is still removed", () => {
    const f = fixture("to", 2);
    const r = mutationProof(input(f, { timeoutS: -1 }));
    expect(r.line).toBe("test fails without the fix: NOT PROVEN (timeout)"); expect(worktrees(f.repo)).toBe(1);
  });
  test("worktree removed when the runner throws", () => {
    const f = fixture("throw", 2); const before = leftovers();
    const r = mutationProof(input(f, { runner: { run: () => { throw new Error("boom"); } } }));
    expect(r.outcome).toBe("not_proven"); expect(r.line).toContain("boom");
    expect(worktrees(f.repo)).toBe(1); expect(leftovers()).toBe(before);
  });
  test("opt-out flag", () => {
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
    expect(r.verdict).toBe("VERIFIED"); expect(r.mutation_proof).toBe("test fails without the fix: yes");
    expect(s.data["mutation_line"]).toBe("test fails without the fix: yes");
    expect(readFileSync(join(s.data["receipt_path"] as string, "..", "receipt.md"), "utf8")).toContain("- test fails without the fix: yes");
  });
  test("no downgrades VERIFIED to PARTIAL", async () => {
    const { r } = await sealed(fixture("s-no", 1));
    expect(r.verdict).toBe("PARTIAL"); expect(r.mutation_proof).toBe("test fails without the fix: no");
    expect(r.not_proven.some((n) => n.includes("mutation proof"))).toBe(true);
  });
  test("NOT PROVEN never changes the verdict", async () => {
    const f = fixture("s-np", 2);
    const ctx = sealCtx(f); (ctx.outputs().verify as { checks: unknown[] }).checks = [{ name: "bun", cmd: "bun test", result: "pass", n: 1, duration_s: 1 }];
    const { r } = await sealed(f, ctx);
    expect(r.verdict).toBe("VERIFIED"); expect(r.mutation_proof).toBe("test fails without the fix: NOT PROVEN (no recorded Wall test command)");
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
