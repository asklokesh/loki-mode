// A-103: real `node --test` runs on a bugrepo (off-by-one sum) through RealBaseTestRunner.
// A Wall test that is not red for the right reason is discarded, never left in the tree.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify, runWall } from "../../src/engine10/stages/wall.ts";
import type { RunContext, SessionRunOptions, SessionRunner } from "../../src/engine10/types.ts";

const SUM = "function sum(arr) { let t = 0; for (let i = 1; i < arr.length; i++) t += arr[i]; return t; }\nmodule.exports = { sum };\n";
const JEST = "const { sum } = require('../sum');\ndescribe('sum', () => { it('adds all', () => { expect(sum([1, 2, 3])).toBe(6); }); });\n";
const NODE = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('../sum');\ntest('adds all', () => { assert.strictEqual(sum([1, 2, 3]), 6); });\n";

class Sessions implements SessionRunner {
  lastOpts: SessionRunOptions | null = null;
  constructor(private files: Record<string, string>) {}
  async run(opts: SessionRunOptions) {
    this.lastOpts = opts;
    for (const [n, c] of Object.entries(this.files)) writeFileSync(join(opts.cwd!, n), c, "utf8");
    return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false };
  }
}

const repos: string[] = [];
afterEach(() => { for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true }); });

async function wallWith(files: Record<string, string>, repoFiles: Record<string, string> = {}) {
  const repoDir = mkdtempSync(join(tmpdir(), "loki-a103-repo-"));
  const runDir = join(repoDir, ".loki", "runs", "r1");
  repos.push(repoDir);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(repoDir, "sum.js"), SUM, "utf8");
  for (const [n, c] of Object.entries(repoFiles)) writeFileSync(join(repoDir, n), c, "utf8");
  writeFileSync(join(runDir, "repomap.json"), JSON.stringify({ files: ["sum.js"], entries: [], truncated: false }), "utf8");
  const sessions = new Sessions(files);
  const ctx = {
    runId: "r1", repoDir, runDir, baseSha: "x", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: () => {}, sessions,
    tests: { async detect() { return { runners: [], tests: [] }; }, impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => 0 },
    outputs: () => ({ intake: { task: "sum skips index 0", testmap: { runners: ["node"], tests: [] }, repomap_ref: join(runDir, "repomap.json") } }),
  } as unknown as RunContext;
  const result = await runWall(ctx, new AbortController().signal);
  return { repoDir, runDir, result, sessions };
}

describe("A-103 wall discards tests that are not red for the right reason", () => {
  test("brief names node:test, a runnable example, and the test command", async () => {
    const { sessions } = await wallWith({});
    expect(sessions.lastOpts!.brief).toContain("require('node:test')");
    expect(sessions.lastOpts!.brief).toContain("node --test");
  });

  test("a Jest-globals test in a node:test repo is deleted from the tree, sealed copy kept, never read-only", async () => {
    const { repoDir, runDir, result } = await wallWith({ "loki_wall_jest.test.js": JEST });
    expect(readdirSync(join(repoDir, "tests")).filter((f) => f.startsWith("loki_wall_"))).toEqual([]);
    expect(readdirSync(join(runDir, "wall"))).toEqual(["loki_wall_jest.test.js"]);
    expect(result.data.files).toEqual([]);
    expect(result.data.readOnlyFiles).toEqual([]);
    expect(result.data.base_run).toEqual({ pass: 0, fail: 0, not_run: 1 });
    expect(result.data.already_satisfied).toBe(false);
  });

  test("a correct node:test Wall test that fails on the off-by-one is kept and red", async () => {
    const { repoDir, result } = await wallWith({ "loki_wall_sum.test.js": NODE, "loki_wall_jest.test.js": JEST });
    expect(readdirSync(join(repoDir, "tests")).sort()).toEqual(["loki_wall_sum.test.js"]);
    expect((result.data.files as { path: string }[]).map((f) => f.path)).toEqual([join(repoDir, "tests", "loki_wall_sum.test.js")]);
    expect(result.data.base_run).toEqual({ pass: 0, fail: 1, not_run: 1 });
  });

  const H = "const test = require('node:test');\nconst assert = require('node:assert');\n";
  test("a test for a module the task creates (relative require, file absent) is red and kept", async () => {
    const r = await wallWith({ "loki_wall_mean.test.js": H + "const { mean } = require('../mean');\ntest('mean', () => { assert.strictEqual(mean([2, 4]), 3); });\n" });
    expect(r.result.data.base_run).toEqual({ pass: 0, fail: 1, not_run: 0 });
    expect((r.result.data.files as unknown[]).length).toBe(1);
  });
  test("a ReferenceError thrown from the code under test is red and kept", async () => {
    const r = await wallWith({ "loki_wall_ref.test.js": H + "const { bad } = require('../bad');\ntest('bad', () => { assert.strictEqual(bad(), 3); });\n" }, { "bad.js": "module.exports = { bad: () => totl + 1 };\n" });
    expect(r.result.data.base_run).toEqual({ pass: 0, fail: 1, not_run: 0 });
    expect((r.result.data.files as unknown[]).length).toBe(1);
  });
  test("a missing bare package is not_run and discarded", async () => {
    const r = await wallWith({ "loki_wall_bare.test.js": "const test = require('node:test');\nconst x = require('lodash-nope');\ntest('t', () => {});\n" });
    expect(r.result.data.base_run).toEqual({ pass: 0, fail: 0, not_run: 1 });
    expect(r.result.data.files).toEqual([]);
  });
  test("an assertion diff that mentions ReferenceError is red and kept", async () => {
    const r = await wallWith({ "loki_wall_msg.test.js": H + "test('t', () => { assert.deepStrictEqual({ a: 'ReferenceError' }, { a: 'x' }); });\n" });
    expect(r.result.data.base_run).toEqual({ pass: 0, fail: 1, not_run: 0 });
  });

  test("a caught 'Cannot find module' logged by code under test, then a real assertion failure, is red and kept", async () => {
    const r = await wallWith({ "loki_wall_opt.test.js": H + "const { sum } = require('../opt');\ntest('t', () => { assert.strictEqual(sum(1, 1), 2); });\n" }, { "opt.js": "try { require('fsevents'); } catch (e) { console.error(e); }\nmodule.exports = { sum: (a, b) => a + b + 1 };\n" });
    expect(r.result.data.base_run).toEqual({ pass: 0, fail: 1, not_run: 0 });
    expect((r.result.data.files as unknown[]).length).toBe(1);
  });
  test("a test body that logs 'Error: Cannot find module' before a real assertion failure is red and kept", async () => {
    const r = await wallWith({ "loki_wall_log.test.js": H + "test('t', () => { console.log(\"Error: Cannot find module 'lodash'\"); assert.strictEqual(1, 2); });\n" });
    expect(r.result.data.base_run).toEqual({ pass: 0, fail: 1, not_run: 0 });
  });
  test("a child node crashing on a missing bare package (inherited stdio) does not discard a real TypeError red", async () => {
    const r = await wallWith({ "loki_wall_child.test.js": H + "const { run } = require('../child');\ntest('mean', () => { run(); ({}).mean(); });\n" }, { "child.js": "module.exports = { run: () => require('node:child_process').spawnSync(process.execPath, ['-e', \"require('lodash-nope')\"], { stdio: 'inherit' }) };\n" });
    expect(r.result.data.base_run).toEqual({ pass: 0, fail: 1, not_run: 0 });
    expect((r.result.data.files as unknown[]).length).toBe(1);
  });
  test("a printed fake missing-module footer before a real TypeError is red and kept", async () => {
    const r = await wallWith({ "loki_wall_fake.test.js": H + "test('mean', () => { console.log(\"Error: Cannot find module 'lodash'\\n\\nNode.js v26.5.0\"); ({}).mean(); });\n" });
    expect(r.result.data.base_run).toEqual({ pass: 0, fail: 1, not_run: 0 });
    expect((r.result.data.files as unknown[]).length).toBe(1);
  });
  test("classify node:assertion failure is red; ReferenceError or missing module is not_run", () => {
    const f = { runner: "node" as const, path: "t.test.js" };
    expect(classify(f, 1, "# tests 1\n# pass 0\n# fail 1\n", "/x")).toBe("fail");
    expect(classify(f, 1, "\u2139 tests 1\n\u2139 pass 0\n\u2139 fail 1\n", "/x")).toBe("fail"); // node 20+ spec reporter off a TTY
    expect(classify(f, 1, "/r/t.test.js:1\ndescribe('x', () => {});\n^\n\nReferenceError: describe is not defined\n# fail 1\n", "/x")).toBe("not_run");
    expect(classify(f, 1, "Error: Cannot find module 'lodash'\n    at require (node:internal/x:1:1)\n  code: 'MODULE_NOT_FOUND'\n}\n\nNode.js v26.5.0\n# fail 1\n", "/x")).toBe("not_run");
  });
});
