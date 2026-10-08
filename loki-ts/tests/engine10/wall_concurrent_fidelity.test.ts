// WC-01b regression: real installWall + RealBaseTestRunner, flag off vs on must agree (B1 dropped test, B2/B3 false already_satisfied incl. absolute links) and the snapshot is bounded (B4).
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOW, runMachine, snapshotTree } from "../../src/engine10/machine.ts";
import { installWall, type WallAuthored } from "../../src/engine10/stages/wall.ts";
import { alreadySatisfied } from "../../src/e10ext/discard.ts";
import { verdictOf } from "../../src/engine10/stages/seal.ts";
import type { RunContext, Stage, StageName } from "../../src/engine10/types.ts";

const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
const dirs: string[] = [];
afterEach(() => { delete process.env.LOKI_E10_WALL_CONCURRENT; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function mkctx(repoDir: string, baseSha: string, outputsRef: { o: Record<string, unknown> }): RunContext {
  return {
    runId: "rv", repoDir, runDir: join(repoDir, ".loki", "runs", "rv"), baseSha, branch: "b", provider: "claude", model: "fake", deep: false, capS: 900,
    emit: () => {}, sessions: { run: async () => { throw new Error("no sessions"); } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => Date.now() }, outputs: () => outputsRef.o as never,
  };
}

// scenario: "nested" = deps in a package-level gitignored node_modules; "workspace" = root node_modules links to a workspace package
function repo(kind: "nested" | "workspace" | "abs") {
  const r = mkdtempSync(join(tmpdir(), "loki-rv-wc01b-")); dirs.push(r);
  git(r, "init", "-q");
  writeFileSync(join(r, ".gitignore"), "node_modules\n.loki\n");
  if (kind === "nested") {
    mkdirSync(join(r, "app", "src"), { recursive: true }); mkdirSync(join(r, "app", "test"), { recursive: true });
    writeFileSync(join(r, "app", "src", "sum.js"), "module.exports = (a, b) => a - b;\n");
    writeFileSync(join(r, "app", "test", "existing.test.js"), "require('node:test')('x', () => {});\n");
    mkdirSync(join(r, "app", "node_modules", "dep"), { recursive: true });
    writeFileSync(join(r, "app", "node_modules", "dep", "index.js"), "module.exports = { ok: true };\n");
  } else {
    mkdirSync(join(r, "packages", "dep"), { recursive: true }); mkdirSync(join(r, "tests"), { recursive: true });
    writeFileSync(join(r, "packages", "dep", "index.js"), "module.exports = (a, b) => a - b;\n");
    writeFileSync(join(r, "packages", "dep", "package.json"), "{\"name\":\"dep\",\"main\":\"index.js\"}\n");
    mkdirSync(join(r, "node_modules"), { recursive: true }); symlinkSync(kind === "abs" ? join(r, "packages", "dep") : "../packages/dep", join(r, "node_modules", "dep"));
  }
  git(r, "add", "-A"); git(r, "commit", "-qm", "init");
  return { r, sha: git(r, "rev-parse", "HEAD").trim() };
}
const WALL_NESTED = "const test = require('node:test'); const assert = require('node:assert'); require('dep'); const sum = require('../src/sum.js');\ntest('sum', () => { assert.equal(sum(1, 2), 3); });\n";
const WALL_WS = "const test = require('node:test'); const assert = require('node:assert'); const sum = require('dep');\ntest('sum', () => { assert.equal(sum(1, 2), 3); });\n";

async function go(kind: "nested" | "workspace" | "abs", concurrent: boolean) {
  const { r, sha } = repo(kind);
  const ref = { o: {} as Record<string, unknown> };
  const ctx = mkctx(r, sha, ref);
  const targetDir = kind === "nested" ? join(r, "app", "test") : join(r, "tests");
  const authored: WallAuthored = { kind: "authored", task: "t", sizeName: "medium", runners: ["node"], targetDir, generated: ["loki_wall_a.test.js"], contents: new Map([["loki_wall_a.test.js", kind === "nested" ? WALL_NESTED : WALL_WS]]), discarded: [] };
  const fix = (): void => { writeFileSync(join(r, kind === "nested" ? "app/src/sum.js" : "packages/dep/index.js"), "module.exports = (a, b) => a + b;\n"); };
  const mk = (name: StageName, run?: Stage["run"]): Stage => ({ name, targetS: 1, limitS: 30, run: run ?? (async () => ({ status: "completed", data: {} })) });
  const wall = { ...mk("wall", async (c) => installWall(c, authored, r)), split: { author: async () => authored, install: installWall } } as Stage;
  const s: Partial<Record<StageName, Stage>> = { intake: mk("intake"), plan: mk("plan"), wall, implement: mk("implement", async () => { fix(); return { status: "completed", data: {} }; }), verify: mk("verify"), fix: mk("fix"), commit: mk("commit"), seal: mk("seal"), pr: mk("pr") };
  if (concurrent) process.env.LOKI_E10_WALL_CONCURRENT = "1";
  const res = await runMachine(ctx, { load: async (n) => s[n] ?? null, flow: FLOW });
  return { outs: res.outputs, wall: res.outputs.wall, verifyRan: res.outputs.verify !== undefined, wallFileInTree: existsSync(join(targetDir, "loki_wall_a.test.js")) };
}

const leaked = (): string[] => readdirSync(tmpdir()).filter((n) => n.startsWith("e10-wallbase-"));
describe("WC-01b base-run fidelity", () => {
  for (const kind of ["nested", "workspace", "abs"] as const) {
    it(`${kind}: concurrent base run is never green when it cannot be trusted; failing test kept`, async () => {
      const seq = await go(kind, false), con = await go(kind, true);
      expect(seq.wall?.base_run).toMatchObject({ pass: 0, fail: 1 });
      expect(con.wallFileInTree).toBe(true);
      expect(con.wall?.already_satisfied).toBe(false);
      expect(alreadySatisfied(con.outs as never)).toBe(false); // discard.ts consumer
      const b = (con.wall?.base_run ?? {}) as { pass?: number; fail?: number; not_run?: number };
      const green = typeof b.pass === "number" && b.pass > 0 && b.fail === 0 && (b.not_run ?? 0) === 0; // seal wallGreenOnBase
      expect(green).toBe(false);
      expect(verdictOf(con.outs as never, [{ name: "w", cmd: "x", result: "pass", duration_s: 1 }], false, false, green, true)).not.toBe("ALREADY_SATISFIED");
      if (kind !== "abs") expect(con.wall?.base_run).toMatchObject(seq.wall?.base_run as object);
      expect(con.verifyRan).toBe(true);
    }, 60_000);
  }
});
describe("WC-01b snapshot bounds", () => {
  const mkrepo = (): string => { const r = mkdtempSync(join(tmpdir(), "loki-wc01b-snap-")); dirs.push(r); mkdirSync(join(r, ".claude", "worktrees", "w1"), { recursive: true }); mkdirSync(join(r, ".loki")); writeFileSync(join(r, ".claude", "worktrees", "w1", "f"), "x"); writeFileSync(join(r, ".claude", "keep"), "k"); writeFileSync(join(r, ".loki", "l"), "l"); writeFileSync(join(r, "a.txt"), "a".repeat(2048)); return r; };
  it("copies the tree but not .loki or .claude/worktrees", async () => {
    const r = mkrepo(), d = await snapshotTree(r, new AbortController().signal);
    expect(d).not.toBeNull(); dirs.push(d!);
    expect(existsSync(join(d!, "a.txt"))).toBe(true); expect(existsSync(join(d!, ".claude", "keep"))).toBe(true);
    expect(existsSync(join(d!, ".loki"))).toBe(false); expect(existsSync(join(d!, ".claude", "worktrees"))).toBe(false);
  });
  it("a size ceiling fails closed and leaks nothing", async () => {
    const before = leaked().length, r = mkrepo();
    expect(await snapshotTree(r, new AbortController().signal, { maxMb: 0 })).toBeNull(); expect(leaked().length).toBe(before);
  });
  it("an aborted signal (cap or wall limit) fails closed and leaks nothing", async () => {
    const before = leaked().length, r = mkrepo(), c = new AbortController(); c.abort();
    expect(await snapshotTree(r, c.signal)).toBeNull(); expect(leaked().length).toBe(before);
  });
  it("a timeout fails closed and leaks nothing", async () => {
    const before = leaked().length, r = mkrepo();
    for (let i = 0; i < 4000; i++) writeFileSync(join(r, `f${i}.txt`), "x"); // enough entries that du cannot finish inside 1ms
    expect(await snapshotTree(r, new AbortController().signal, { timeoutMs: 1 })).toBeNull(); expect(leaked().length).toBe(before);
  });
});
