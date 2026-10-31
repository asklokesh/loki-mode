// A-103: real `node --test` runs on a bugrepo (off-by-one sum) through RealBaseTestRunner.
// A Wall test that is not red for the right reason is discarded, never left in the tree.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealBaseTestRunner, classify, runWall } from "../../src/engine10/stages/wall.ts";
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
  test("an ESM import of an export the task has not created yet is red and kept", async () => {
    const r = await wallWith({ "loki_wall_esmexport.test.mjs": "import test from 'node:test';\nimport assert from 'node:assert';\nimport { mean } from '../sum.mjs';\ntest('mean', () => { assert.strictEqual(mean([2, 4]), 3); });\n" }, { "sum.mjs": "export const sum = 1;\n" });
    expect(r.result.data.base_run).toEqual({ pass: 0, fail: 1, not_run: 0 });
    expect((r.result.data.files as unknown[]).length).toBe(1);
  });
  test("a missing bare package is not_run and discarded", async () => {
    const r = await wallWith({ "loki_wall_bare.test.js": "const test = require('node:test');\nconst x = require('lodash-nope');\ntest('t', () => {});\n" });
    expect(r.result.data.base_run).toEqual({ pass: 0, fail: 0, not_run: 1 });
    expect(r.result.data.files).toEqual([]);
  });
  test("nested Jest-globals subtests (TAP yaml at any indent) are not_run and discarded", async () => {
    const cjs = await wallWith({ "loki_wall_nest.test.js": "const test = require('node:test');\ntest('outer', async (t) => { await t.test('inner', () => { expect(1).toBe(1); }); });\n" });
    expect(cjs.result.data.base_run).toEqual({ pass: 0, fail: 0, not_run: 1 });
    expect(cjs.result.data.files).toEqual([]);
  });
  test("nested Jest-globals subtests in an ESM file are not_run and discarded", async () => {
    const esm = await wallWith({ "loki_wall_nest.test.mjs": "import test from 'node:test';\ntest('outer', async (t) => { await t.test('inner', () => { expect(1).toBe(1); }); });\n" });
    expect(esm.result.data.base_run).toEqual({ pass: 0, fail: 0, not_run: 1 });
    expect(esm.result.data.files).toEqual([]);
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
  test("a Wall-file ReferenceError in one subtest does not hide a real TypeError red in another", async () => {
    const r = await wallWith({ "loki_wall_two.test.js": H + "test('a', () => { nope(); });\ntest('b', () => { ({}).mean(); });\n" });
    expect(r.result.data.base_run).toEqual({ pass: 0, fail: 1, not_run: 0 });
  });
  test("classify go: a forged RUN/PASS from TestMain with os.Exit(0) (real go 1.26.3) is not_run, never pass", () => {
    const fg = "=== RUN   TestA\n--- PASS: TestA (0.00s)\nPASS\nok  \texample.com/fg\t0.189s\n";
    expect(classify({ runner: "go" as const, path: "a_test.go" }, 0, fg, "/x")).toBe("not_run");
  });
  test("classify go: a go test -json run that names a failing test is red; a go build failure is red on base; a torn stream stays not_run", () => {
    const ev = (o: Record<string, unknown>): string => JSON.stringify({ Time: "2026-10-29T00:00:00Z", ...o });
    const f = { runner: "go" as const, path: "pkg/a_test.go" };
    const red = [
      ev({ Action: "start", Package: "ex/pkg" }), ev({ Action: "run", Package: "ex/pkg", Test: "TestAdd" }),
      ev({ Action: "output", Package: "ex/pkg", Test: "TestAdd", Output: "--- FAIL: TestAdd (0.00s)\n" }),
      ev({ Action: "fail", Package: "ex/pkg", Test: "TestAdd", Elapsed: 0 }), ev({ Action: "fail", Package: "ex/pkg", Elapsed: 0.01 }),
    ].join("\n") + "\n";
    expect(classify(f, 1, red, "/x")).toBe("fail");
    const build = [ev({ Action: "start", Package: "ex/pkg" }), ev({ Action: "output", Package: "ex/pkg", Output: "FAIL\tex/pkg [build failed]\n" }), ev({ Action: "fail", Package: "ex/pkg", Elapsed: 0 })].join("\n") + "\n";
    expect(classify(f, 1, build, "/x")).toBe("fail");
    expect(classify(f, 1, "exit status 1\nFAIL\tex/pkg\t0.01s\n", "/x")).toBe("not_run");
  });
  test("classify cargo: a failed test is red when cargo's stderr lines follow the stdout trailer (the order the Wall captures)", () => {
    const f = { runner: "cargo" as const, path: "tests/itg.rs" };
    const stdout = "\nrunning 2 tests\ntest ok_one ... ok\ntest bad_one ... FAILED\n\nfailures:\n\n---- bad_one stdout ----\nthread 'bad_one' panicked at tests/itg.rs:5:5:\nassertion failed\n\nfailures:\n    bad_one\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\n";
    const stderr = "   Compiling fx v0.1.0 (/r)\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.30s\n     Running tests/itg.rs (target/debug/deps/itg-abc123)\nerror: test failed, to rerun pass `--test itg`\n";
    expect(classify(f, 101, stdout + "\n" + stderr, "/x")).toBe("fail");
    expect(classify(f, 101, stderr, "/x")).toBe("not_run"); // a compile error or empty run names no failing test
    expect(classify(f, 101, stdout.replace("test bad_one ... FAILED\n", ""), "/x")).toBe("not_run"); // trailer says failed but no id is readable
  });
  test("classify node:assertion failure is red; ReferenceError or missing module is not_run", () => {
    const f = { runner: "node" as const, path: "t.test.js" };
    expect(classify(f, 1, "# tests 1\n# pass 0\n# fail 1\n", "/x")).toBe("fail");
    expect(classify(f, 1, "\u2139 tests 1\n\u2139 pass 0\n\u2139 fail 1\n", "/x")).toBe("fail"); // node 20+ spec reporter off a TTY
    expect(classify(f, 1, "/r/t.test.js:1\ndescribe('x', () => {});\n^\n\nReferenceError: describe is not defined\n# fail 1\n", "/x")).toBe("not_run");
    expect(classify(f, 1, "Error: Cannot find module 'lodash'\n    at require (node:internal/x:1:1)\n  code: 'MODULE_NOT_FOUND'\n}\n\nNode.js v26.5.0\n# fail 1\n", "/x")).toBe("not_run");
  });
});

describe("RealBaseTestRunner extraEnv reaches the child", () => {
  // the fixture passes only when the child sees PYTHONDONTWRITEBYTECODE=1, which the plain test env does not carry
  const PROBE = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('env', () => { assert.strictEqual(process.env.PYTHONDONTWRITEBYTECODE, '1'); });\n";
  const mk = (): string => { const d = mkdtempSync(join(tmpdir(), "loki-extraenv-")); repos.push(d); writeFileSync(join(d, "t.test.js"), PROBE, "utf8"); return d; };
  test("extraEnv is merged into the child env; without it the same file is red", () => {
    const f = { runner: "node" as const, path: "t.test.js" };
    expect(new RealBaseTestRunner(null, undefined, { PYTHONDONTWRITEBYTECODE: "1" }).run(mk(), [f])).toEqual({ pass: 1, fail: 0, not_run: 0 });
    expect(new RealBaseTestRunner(null).run(mk(), [f])).toEqual({ pass: 0, fail: 1, not_run: 0 });
  });
});

describe("TEN-SPEED-19 base jobs", () => {
  const H2 = "const test = require('node:test');\nconst assert = require('node:assert');\nconst fs = require('node:fs');\nconst { sum } = require('../sum');\n";
  const slow = (n: string) => H2 + `test('${n}', () => { const t0 = Date.now(); fs.appendFileSync(process.env.SPAN_LOG, 'S ' + t0 + '\\n'); while (Date.now() - t0 < 700) {} fs.appendFileSync(process.env.SPAN_LOG, 'E ' + Date.now() + '\\n'); assert.strictEqual(sum([1, 2, 3]), 6); });\n`;
  const files = { "loki_wall_a.test.js": slow("a"), "loki_wall_b.test.js": slow("b"), "loki_wall_c.test.js": slow("c"), "loki_wall_jest.test.js": JEST, "loki_wall_jest2.test.js": JEST.replace("adds all", "again") };
  async function run(jobs: string | undefined) {
    const logDir = mkdtempSync(join(tmpdir(), "loki-ten19-log-")), log = join(logDir, "span.log");
    repos.push(logDir);
    const saved = { j: process.env.LOKI_E10_BASE_JOBS, s: process.env.SPAN_LOG };
    if (jobs === undefined) delete process.env.LOKI_E10_BASE_JOBS; else process.env.LOKI_E10_BASE_JOBS = jobs;
    process.env.SPAN_LOG = log; writeFileSync(log, "");
    try {
      const r = await wallWith(files);
      const ev = readFileSync(log, "utf8").trim().split("\n").map((l) => l.split(" "));
      ev.sort((x, y) => Number(x[1]) - Number(y[1]) || (x[0] === "E" ? -1 : 1));
      let live = 0, peak = 0;
      for (const [k] of ev) { live += k === "S" ? 1 : -1; peak = Math.max(peak, live); }
      return { d: r.result.data, peak };
    } finally {
      if (saved.j === undefined) delete process.env.LOKI_E10_BASE_JOBS; else process.env.LOKI_E10_BASE_JOBS = saved.j;
      if (saved.s === undefined) delete process.env.SPAN_LOG; else process.env.SPAN_LOG = saved.s;
    }
  }
  test("default is sequential; jobs=3 overlaps files with identical counts, files and result", async () => {
    const seq = await run(undefined), par = await run("3"), bad = await run("abc");
    expect(seq.peak).toBe(1);
    expect(bad.peak).toBe(1);
    expect(par.peak).toBeGreaterThan(1);
    expect(seq.d.base_run).toEqual({ pass: 0, fail: 3, not_run: 1 });
    expect(par.d.base_run).toEqual(seq.d.base_run);
    const norm = (d: Record<string, unknown>) => JSON.stringify({ files: (d.files as { path: string }[]).map((f) => f.path.split("/").pop()), ro: (d.readOnlyFiles as { path: string }[]).map((f) => f.path.split("/").pop()), nr: d.not_run_files ?? d.notRunFiles ?? null, base: d.base_run, sat: d.already_satisfied });
    expect(norm(par.d)).toBe(norm(seq.d));
  }, 60_000);

  test("spawnCollect matches spawnSync for a child that reads stdin (EOF, not a hang) and splits stdout/stderr", async () => {
    const { spawnSync } = await import("node:child_process");
    const { spawnCollect } = await import("../../src/util/check_result.ts");
    const args = ["-e", "require('fs').readFileSync(0); process.stdout.write('o'); process.stderr.write('e'); process.exit(1)"];
    const sync = spawnSync("node", args, { encoding: "utf8", timeout: 10_000 });
    const t0 = Date.now(), a = await spawnCollect("node", args, { timeoutMs: 10_000 });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(a.status).toBe(sync.status);
    expect(a.output).toBe(`${sync.stdout}\n${sync.stderr}`);
  }, 30_000);
  // A child that ignores SIGTERM (as bun test does) must still stop at the timeout.
  const STUBBORN = ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"];
  test("spawnCollect stops a SIGTERM-ignoring child shortly after its timeout and reports no status", async () => {
    const { spawnCollect } = await import("../../src/util/check_result.ts");
    const t0 = Date.now(), r = await spawnCollect("node", STUBBORN, { timeoutMs: 1000 });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.status).toBeNull();
  }, 20_000);

  test("RealBaseTestRunner.run stops a SIGTERM-ignoring child at the timeout and counts it not_run", () => {
    const repo = mkdtempSync(join(tmpdir(), "loki-run.f0-")); repos.push(repo);
    mkdirSync(join(repo, ".venv", "bin"), { recursive: true });
    writeFileSync(join(repo, ".venv", "bin", "python"), `#!/bin/sh\nexec node -e "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"\n`, { mode: 0o755 });
    writeFileSync(join(repo, "test_a.py"), "def test_a():\n    pass\n");
    const t0 = Date.now(), r = new RealBaseTestRunner(null, 1000).run(repo, [{ runner: "pytest", path: "test_a.py" }]);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r).toEqual({ pass: 0, fail: 0, not_run: 1 });
  }, 20_000);
  // npx-style wrapper: the direct child is a shell, the SIGTERM-ignoring runner is its grandchild and holds the stdio pipes.
  const GRAND = `node -e "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)" & echo $! > "$PIDFILE"; wait`;
  const dead = async (pid: number) => { for (let i = 0; i < 20; i++) { try { process.kill(pid, 0); } catch { return true; } await new Promise((r) => setTimeout(r, 100)); } return false; };
  test("spawnCollect returns at the timeout and kills the whole group when a grandchild holds the pipes", async () => {
    const { spawnCollect } = await import("../../src/util/check_result.ts");
    const dir = mkdtempSync(join(tmpdir(), "loki-run.f0b-")); repos.push(dir);
    const t0 = Date.now(), r = await spawnCollect("sh", ["-c", GRAND], { timeoutMs: 1000, env: { ...process.env, PIDFILE: join(dir, "pid") } });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.status).toBeNull();
    expect(await dead(Number(readFileSync(join(dir, "pid"), "utf8")))).toBe(true);
  }, 20_000);

  test("RealBaseTestRunner.run reaps a grandchild runner that outlives the killed direct child", async () => {
    const repo = mkdtempSync(join(tmpdir(), "loki-run.f0b-")); repos.push(repo);
    mkdirSync(join(repo, ".venv", "bin"), { recursive: true });
    writeFileSync(join(repo, ".venv", "bin", "python"), `#!/bin/sh\nPIDFILE='${join(repo, "pid")}'\n${GRAND}\n`, { mode: 0o755 });
    writeFileSync(join(repo, "test_a.py"), "def test_a():\n    pass\n");
    const t0 = Date.now(), r = new RealBaseTestRunner(null, 1000).run(repo, [{ runner: "pytest", path: "test_a.py" }]);
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r).toEqual({ pass: 0, fail: 0, not_run: 1 });
    expect(await dead(Number(readFileSync(join(repo, "pid"), "utf8")))).toBe(true);
  }, 20_000);
  test("a wrapper that exits while its grandchild holds the pipes resolves after a short grace, not at the timeout", async () => {
    const { spawnCollect } = await import("../../src/util/check_result.ts");
    const dir = mkdtempSync(join(tmpdir(), "loki-run.f0b-")); repos.push(dir);
    const t0 = Date.now(), r = await spawnCollect("sh", ["-c", GRAND.replace("; wait", "")], { timeoutMs: 20_000, env: { ...process.env, PIDFILE: join(dir, "pid") } });
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(r.status).toBe(0);
    expect(await dead(Number(readFileSync(join(dir, "pid"), "utf8")))).toBe(true);
  }, 30_000);

  test("the sync runner also resolves after a short grace when the wrapper exits and a grandchild holds the pipes", () => {
    const repo = mkdtempSync(join(tmpdir(), "loki-run.f0b-")); repos.push(repo);
    mkdirSync(join(repo, ".venv", "bin"), { recursive: true });
    writeFileSync(join(repo, ".venv", "bin", "python"), `#!/bin/sh\nPIDFILE='${join(repo, "pid")}'\n${GRAND.replace("; wait", "")}\n`, { mode: 0o755 });
    writeFileSync(join(repo, "test_a.py"), "def test_a():\n    pass\n");
    const t0 = Date.now(); new RealBaseTestRunner(null, 20_000).run(repo, [{ runner: "pytest", path: "test_a.py" }]);
    expect(Date.now() - t0).toBeLessThan(4000);
  }, 30_000);
});
