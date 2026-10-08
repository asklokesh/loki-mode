// WC-01b regression: real installWall + RealBaseTestRunner, flag off vs on must agree (B1 dropped test, B2 false already_satisfied).
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOW, runMachine } from "../../src/engine10/machine.ts";
import { installWall, type WallAuthored } from "../../src/engine10/stages/wall.ts";
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
function repo(kind: "nested" | "workspace") {
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
    mkdirSync(join(r, "node_modules"), { recursive: true }); symlinkSync("../packages/dep", join(r, "node_modules", "dep"));
  }
  git(r, "add", "-A"); git(r, "commit", "-qm", "init");
  return { r, sha: git(r, "rev-parse", "HEAD").trim() };
}
const WALL_NESTED = "const test = require('node:test'); const assert = require('node:assert'); require('dep'); const sum = require('../src/sum.js');\ntest('sum', () => { assert.equal(sum(1, 2), 3); });\n";
const WALL_WS = "const test = require('node:test'); const assert = require('node:assert'); const sum = require('dep');\ntest('sum', () => { assert.equal(sum(1, 2), 3); });\n";

async function go(kind: "nested" | "workspace", concurrent: boolean) {
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
  return { wall: res.outputs.wall, verifyRan: res.outputs.verify !== undefined, wallFileInTree: existsSync(join(targetDir, "loki_wall_a.test.js")) };
}

describe("WC-01b base-run fidelity", () => {
  for (const kind of ["nested", "workspace"] as const) {
    it(`${kind}: concurrent base run equals sequential and keeps the failing test`, async () => {
      const seq = await go(kind, false), con = await go(kind, true);
      expect(seq.wall?.base_run).toMatchObject({ pass: 0, fail: 1 });
      expect(con.wall?.base_run).toMatchObject(seq.wall?.base_run as object);
      expect(con.wallFileInTree).toBe(true);
      expect(con.wall?.already_satisfied).toBe(false);
      expect(con.verifyRan).toBe(true);
    }, 60_000);
  }
});
