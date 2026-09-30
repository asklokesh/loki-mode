// A-103: real `node --test` runs on a bugrepo (off-by-one sum) through RealBaseTestRunner.
// A Wall test that is not red for the right reason is discarded, never left in the tree.
import { describe, expect, test } from "bun:test";
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

async function wallWith(files: Record<string, string>) {
  const repoDir = mkdtempSync(join(tmpdir(), "loki-a103-repo-"));
  const runDir = join(repoDir, ".loki", "runs", "r1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(repoDir, "sum.js"), SUM, "utf8");
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
    const { repoDir, sessions } = await wallWith({});
    expect(sessions.lastOpts!.brief).toContain("require('node:test')");
    expect(sessions.lastOpts!.brief).toContain("node --test");
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("a Jest-globals test in a node:test repo is deleted from the tree, sealed copy kept, never read-only", async () => {
    const { repoDir, runDir, result } = await wallWith({ "loki_wall_jest.test.js": JEST });
    expect(readdirSync(join(repoDir, "tests")).filter((f) => f.startsWith("loki_wall_"))).toEqual([]);
    expect(readdirSync(join(runDir, "wall"))).toEqual(["loki_wall_jest.test.js"]);
    expect(result.data.files).toEqual([]);
    expect(result.data.readOnlyFiles).toEqual([]);
    expect(result.data.base_run).toEqual({ pass: 0, fail: 0, not_run: 1 });
    expect(result.data.already_satisfied).toBe(false);
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("a correct node:test Wall test that fails on the off-by-one is kept and red", async () => {
    const { repoDir, result } = await wallWith({ "loki_wall_sum.test.js": NODE, "loki_wall_jest.test.js": JEST });
    expect(readdirSync(join(repoDir, "tests")).sort()).toEqual(["loki_wall_sum.test.js"]);
    expect((result.data.files as { path: string }[]).map((f) => f.path)).toEqual([join(repoDir, "tests", "loki_wall_sum.test.js")]);
    expect(result.data.base_run).toEqual({ pass: 0, fail: 1, not_run: 1 });
    rmSync(repoDir, { recursive: true, force: true });
  });

  test("classify node: assertion failure is red; ReferenceError or missing module is not_run", () => {
    const f = { runner: "node" as const, path: "t.test.js" };
    expect(classify(f, 1, "# tests 1\n# pass 0\n# fail 1\n", "/x")).toBe("fail");
    expect(classify(f, 1, "ℹ tests 1\nℹ pass 0\nℹ fail 1\n", "/x")).toBe("fail"); // node 20+ spec reporter off a TTY
    expect(classify(f, 1, "ReferenceError: describe is not defined\n# fail 1\n", "/x")).toBe("not_run");
    expect(classify(f, 1, "Error: Cannot find module './nope'\n# fail 1\n", "/x")).toBe("not_run");
  });
});
