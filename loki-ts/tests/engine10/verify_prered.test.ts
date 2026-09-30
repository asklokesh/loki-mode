// A-112: baseline subtract (pre_red never blocks VERIFIED, but only on proof of progress) and A-111b (bare-filename test names).
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
const SUM_TEST = T + "const {sum}=require('./sum.js');t('sums all numbers',()=>{assert.strictEqual(sum([1,2,3]),6);});\n";
const OTHER = T + "t('unrelated',()=>{assert.strictEqual(1,2);});\n";

const git = (d: string, a: string[]): string => execFileSync("git", a, { cwd: d, encoding: "utf8" }).trim();
const node = (path: string): TestRef => ({ runner: "node", path }) as TestRef;

/** A repo committed with `base`, then `work` written on top (the implement stage's edit); `impacted` are the selected test files. */
function repoWith(base: Record<string, string>, work: Record<string, string>, impacted: TestRef[], wall: string[] = []): { ctx: RunContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "e10-prered-"));
  dirs.push(dir);
  git(dir, ["init", "-q"]); git(dir, ["config", "user.email", "t@t.test"]); git(dir, ["config", "user.name", "t"]);
  for (const [f, c] of Object.entries(base)) writeFileSync(join(dir, f), c);
  git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "-m", "base"]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]);
  for (const [f, c] of Object.entries(work)) writeFileSync(join(dir, f), c);
  const ctx = {
    repoDir: dir, runDir: join(dir, ".loki"), baseSha, emit: () => {},
    tests: { detect: async () => ({ runners: [], tests: impacted }), impacted: () => impacted.filter((t) => !wall.includes(t.path)) },
    outputs: () => ({ wall: { files: wall.map((path) => ({ path })) } }),
  } as unknown as RunContext;
  return { ctx, dir };
}
const run = (ctx: RunContext) => verifyStage.run(ctx, new AbortController().signal);
type Out = { checks: { name: string; result: string }[]; pre_red: string[]; pre_red_checks: string[]; failures_grouped: unknown[] };

describe("engine10 verify: baseline subtract (A-112)", () => {
  test("Wall test passes, unrelated test red before and after: pre_red, check stays fail, leaves the fix loop, worktree gone", async () => {
    const { ctx, dir } = repoWith({ "sum.js": SUM_BUG, "other.test.js": OTHER }, { "sum.js": SUM_OK, "wall.test.js": SUM_TEST }, [node("other.test.js"), node("wall.test.js")], ["wall.test.js"]);
    const d = (await run(ctx)).data as unknown as Out;
    expect(d.checks.map((c) => `${c.name}=${c.result}`).sort()).toEqual(["node:other.test.js=fail", "node:wall.test.js=pass"]);
    expect(d.pre_red).toEqual(["unrelated"]);
    expect(d.pre_red_checks).toEqual(["node:other.test.js"]);
    expect(d.failures_grouped).toEqual([]);
    expect(git(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
  }, 60_000);
  test("Wall test staying red: nothing subtracted, fix loop input kept", async () => {
    const { ctx } = repoWith({ "sum.js": SUM_BUG, "other.test.js": OTHER }, { "wall.test.js": SUM_TEST }, [node("other.test.js"), node("wall.test.js")], ["wall.test.js"]);
    const d = (await run(ctx)).data as unknown as Out;
    expect(d.pre_red).toEqual([]);
    expect(d.failures_grouped.length).toBe(2);
  }, 60_000);
  test("B1: no fix, only a comment appended; the target and an unrelated test stay red: nothing subtracted, failures stay", async () => {
    const { ctx } = repoWith({ "sum.js": SUM_BUG, "sum.test.js": SUM_TEST, "other.test.js": OTHER }, { "sum.js": SUM_BUG + "// nothing\n" }, [node("sum.test.js"), node("other.test.js")]);
    const d = (await run(ctx)).data as unknown as Out;
    expect(d.checks.map((c) => c.result)).toEqual(["fail", "fail"]);
    expect(d.pre_red).toEqual([]);
    expect(d.failures_grouped.length).toBe(2);
  }, 60_000);
  test("unchanged-file fix without a Wall test (red to green) does subtract the unrelated red test", async () => {
    const { ctx } = repoWith({ "sum.js": SUM_BUG, "sum.test.js": SUM_TEST, "other.test.js": OTHER }, { "sum.js": SUM_OK }, [node("sum.test.js"), node("other.test.js")]);
    const d = (await run(ctx)).data as unknown as Out;
    expect(d.pre_red).toEqual(["unrelated"]);
    expect(d.failures_grouped).toEqual([]);
  }, 60_000);
  test("B2: pytest base red test_old and test_double; head fixes double but test_make ERRORs: nothing subtracted", async () => {
    const PY = "import pytest\nfrom impl import double, make\n@pytest.fixture\ndef made():\n    return make()\ndef test_old():\n    assert False\ndef test_double():\n    assert double(2) == 4\ndef test_make(made):\n    pass\n";
    const { ctx } = repoWith({ "impl.py": "def double(x):\n    return x + 1\ndef make():\n    return 1\n", "test_x.py": PY }, { "impl.py": "def double(x):\n    return x * 2\ndef make():\n    raise RuntimeError('new')\n" }, [{ runner: "pytest", path: "test_x.py" } as TestRef]);
    const d = (await run(ctx)).data as unknown as Out;
    expect(d.checks[0]?.result).toBe("fail");
    expect(d.pre_red).toEqual([]);
    expect(d.failures_grouped.length).toBe(1);
  }, 60_000);
  test("failIds: pytest FAILED and ERROR, jest with and without the separator, node TAP and spec, vitest; partial extraction yields none", () => {
    expect(failIds("FAILED tests/t.py::test_a - assert 1 == 2\nERROR tests/t.py::test_b - RuntimeError\n2 failed, 1 passed in 0.1s")).toEqual(["tests/t.py::test_a", "tests/t.py::test_b"]);
    expect(failIds("FAILED tests/t.py::test_a - x\n1 failed, 1 error in 0.1s")).toEqual([]);
    expect(failIds("  \u25cf Suite \u203a case\n  \u25cf top level name\nTests:       2 failed, 1 passed, 3 total")).toEqual(["Suite \u203a case", "top level name"]);
    expect(failIds("  \u25cf Test suite failed to run\nCannot find module 'x'\nTests:       0 total")).toEqual([]);
    expect(failIds("not ok 2 - adds all\n# fail 1")).toEqual(["adds all"]);
    expect(failIds("\u2716 spec one (1.2ms)\n\u2716 failing tests:\n\u2139 fail 1")).toEqual(["spec one"]);
    expect(failIds(" FAIL  src/a.test.ts > s > c\n Tests  1 failed | 2 passed")).toEqual(["src/a.test.ts > s > c"]);
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
  test("B3: an npm-style command (last arg not a js file) keeps the old discount: an empty test file is not_run", async () => {
    const d = mkdtempSync(join(tmpdir(), "e10-npm-"));
    dirs.push(d);
    writeFileSync(join(d, "empty.test.js"), "// none\n");
    const r = await runCheck({ repoDir: d, emit: () => {} } as unknown as RunContext, "npm-like", "node", ["--test", "--test-reporter=spec", "./empty.test.js", "--silent"], new AbortController().signal, []);
    expect(r.result).toBe("not_run");
  }, 30_000);
});
