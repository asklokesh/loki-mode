// A-112: baseline subtract (pre_red never blocks VERIFIED) and A-111b (a real test named like a bare filename passes).
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext, TestRef } from "../../src/engine10/types.ts";
import { runCheck, verifyStage } from "../../src/engine10/stages/verify.ts";
import { failIds } from "../../src/engine10/failures.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const T = "const t=require('node:test');const assert=require('node:assert');";
const SUM_BUG = "exports.sum=(a)=>a.slice(1).reduce((x,y)=>x+y,0);\n";
const SUM_OK = "exports.sum=(a)=>a.reduce((x,y)=>x+y,0);\n";
const OTHER = T + "t('unrelated',()=>{assert.strictEqual(1,2);});\n";
const WALL = T + "const {sum}=require('./sum.js');t('adds all',()=>{assert.strictEqual(sum([1,2,3]),6);});\n";

const git = (d: string, a: string[]): string => execFileSync("git", a, { cwd: d, encoding: "utf8" }).trim();

/** bugrepo at base (buggy sum.js + an unrelated red test); the working tree then gets the fix (or not) and a new Wall test. */
function bugrepo(fixed: boolean): { ctx: RunContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "e10-prered-"));
  dirs.push(dir);
  git(dir, ["init", "-q"]); git(dir, ["config", "user.email", "t@t.test"]); git(dir, ["config", "user.name", "t"]);
  writeFileSync(join(dir, "sum.js"), SUM_BUG); writeFileSync(join(dir, "other.test.js"), OTHER);
  git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "-m", "base"]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]);
  if (fixed) writeFileSync(join(dir, "sum.js"), SUM_OK);
  writeFileSync(join(dir, "wall.test.js"), WALL);
  const tests: TestRef[] = [{ runner: "node", path: "other.test.js" } as TestRef, { runner: "node", path: "wall.test.js" } as TestRef];
  const ctx = {
    repoDir: dir, runDir: join(dir, ".loki"), baseSha, emit: () => {},
    tests: { detect: async () => ({ runners: [], tests }), impacted: () => [tests[0]!] },
    outputs: () => ({ wall: { files: [{ path: "wall.test.js" }] } }),
  } as unknown as RunContext;
  return { ctx, dir };
}

describe("engine10 verify: baseline subtract (A-112)", () => {
  test("target fixed, unrelated test red before and after: pre_red, every check pass, worktree gone", async () => {
    const { ctx, dir } = bugrepo(true);
    const r = await verifyStage.run(ctx, new AbortController().signal);
    const checks = r.data.checks as { name: string; result: string }[];
    expect(checks.filter((c) => c.name.startsWith("node:")).map((c) => c.result)).toEqual(["pass", "pass"]);
    expect(r.data.pre_red).toEqual(["unrelated"]);
    expect(git(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  }, 60_000);
  test("target test staying red stays fail", async () => {
    const { ctx } = bugrepo(false);
    const r = await verifyStage.run(ctx, new AbortController().signal);
    const checks = r.data.checks as { name: string; result: string }[];
    expect(checks.find((c) => c.name === "node:wall.test.js")?.result).toBe("fail");
    expect(checks.find((c) => c.name === "node:other.test.js")?.result).toBe("pass");
    expect(r.data.pre_red).toEqual(["unrelated"]);
  }, 60_000);
  test("failIds: pytest, jest, node TAP and spec, vitest", () => {
    expect(failIds("FAILED tests/t.py::test_a - assert 1 == 2\nnot ok 2 - adds all\n# x\n  \u25cf Suite \u203a case\n\u2716 spec one (1.2ms)\n FAIL  src/a.test.ts > s > c"))
      .toEqual(["tests/t.py::test_a", "adds all", "Suite \u203a case", "spec one", "src/a.test.ts > s > c"]);
  });
});

describe("engine10 verify: bare-filename test name (A-111b)", () => {
  test("one real passing test named a.test.js passes; a testless file still reads not_run", async () => {
    const d = mkdtempSync(join(tmpdir(), "e10-bare-"));
    dirs.push(d);
    writeFileSync(join(d, "x.test.js"), T + "t('a.test.js',()=>{});\n");
    writeFileSync(join(d, "empty.test.js"), "// none\n");
    const go = (f: string) => runCheck({ repoDir: d, emit: () => {} } as unknown as RunContext, f, "node", ["--test", `./${f}`], new AbortController().signal, []);
    expect((await go("x.test.js")).result).toBe("pass");
    expect((await go("empty.test.js")).result).toBe("not_run");
  }, 30_000);
});
