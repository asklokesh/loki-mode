// A-112: baseline subtract (pre_red never blocks VERIFIED, but only on proof of progress) and A-111b (bare-filename test names).
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { depsSeeHead } from "../../src/util/base_guard.ts";
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
function repoWith(base: Record<string, string>, work: Record<string, string>, impacted: TestRef[], wall: string[] = [], o: { task?: string; sel?: (files: string[]) => TestRef[] } = {}): { ctx: RunContext; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "e10-prered-"));
  dirs.push(dir);
  git(dir, ["init", "-q"]); git(dir, ["config", "user.email", "t@t.test"]); git(dir, ["config", "user.name", "t"]);
  for (const [f, c] of Object.entries(base)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); }
  git(dir, ["add", "-A"]); git(dir, ["commit", "-q", "-m", "base"]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]);
  for (const [f, c] of Object.entries(work)) writeFileSync(join(dir, f), c);
  mkdirSync(join(dir, ".loki"), { recursive: true });
  writeFileSync(join(dir, ".loki", "repomap.json"), JSON.stringify({ files: Object.keys(base) }));
  const ctx = {
    repoDir: dir, runDir: join(dir, ".loki"), baseSha, emit: () => {},
    tests: { detect: async () => ({ runners: [], tests: impacted }), impacted: (_m: unknown, files: string[]) => (o.sel ?? ((f: string[]) => (f.length ? impacted.filter((t) => !wall.includes(t.path)) : [])))(files) },
    outputs: () => ({ intake: { task: o.task ?? "", repomap_ref: join(dir, ".loki", "repomap.json") }, wall: { files: wall.map((path) => ({ path })) } }),
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
  const TASK = "fix sum.js, covered by sum.test.js";
  // the named-files call carries sum.test.js and gets the relevant set; a diff-derived call gets everything selected from the diff
  const selBoth = (files: string[]): TestRef[] => (files.includes("sum.test.js") ? [node("sum.test.js")] : files.length ? [node("sum.test.js"), node("other.test.js")] : []);
  test("lean path (no Wall): the relevant test goes red to green, the unrelated red test is subtracted", async () => {
    const { ctx } = repoWith({ "sum.js": SUM_BUG, "sum.test.js": SUM_TEST, "other.test.js": OTHER }, { "sum.js": SUM_OK }, [node("sum.test.js"), node("other.test.js")], [], { task: TASK, sel: selBoth });
    const d = (await run(ctx)).data as unknown as Out;
    expect(d.pre_red).toEqual(["unrelated"]);
    expect(d.failures_grouped).toEqual([]);
  }, 60_000);
  test("e7: lean path, the agent fixes only other.js (its test goes green); the relevant target stays red: nothing subtracted", async () => {
    const OX = T + "const {x}=require('./other.js');t('unrelated',()=>{assert.strictEqual(x,2);});\n";
    const { ctx } = repoWith({ "sum.js": SUM_BUG, "sum.test.js": SUM_TEST, "other.js": "exports.x=1;\n", "other.test.js": OX }, { "other.js": "exports.x=2;\n" }, [node("sum.test.js"), node("other.test.js")], [], { task: TASK, sel: selBoth });
    const d = (await run(ctx)).data as unknown as Out;
    expect(d.checks.map((c) => `${c.name}=${c.result}`).sort()).toEqual(["node:other.test.js=pass", "node:sum.test.js=fail"]);
    expect(d.pre_red).toEqual([]);
    expect(d.failures_grouped.length).toBe(1);
  }, 60_000);
  test("m6 (A-114): the diff selects only other.test.js; the relevant target test still runs and its red is seen", async () => {
    const { ctx } = repoWith({ "sum.js": SUM_BUG, "sum.test.js": SUM_TEST, "other.js": "exports.x=1;\n", "other.test.js": OTHER }, { "other.js": "exports.x=2;\n" }, [node("sum.test.js"), node("other.test.js")], [],
      { task: TASK, sel: (files) => (files.includes("sum.test.js") ? [node("sum.test.js")] : files.includes("other.js") ? [node("other.test.js")] : []) });
    const d = (await run(ctx)).data as unknown as Out;
    expect(d.checks.find((c) => c.name === "node:sum.test.js")?.result).toBe("fail");
    expect(d.failures_grouped.length).toBe(2);
  }, 60_000);
  test("e5: only the unrelated code is fixed; the relevant target stays red, never pre_red", async () => {
    const OLD = "def test_old():\n    from old import f\n    assert f() == 1\n", TGT = "from impl import double\ndef test_double():\n    assert double(2) == 4\n";
    const { ctx } = repoWith({ "impl.py": "def double(x):\n    return x + 1\n", "old.py": "def f():\n    return 0\n", "test_old.py": OLD, "test_target.py": TGT }, { "old.py": "def f():\n    return 1\n" },
      [{ runner: "pytest", path: "test_target.py" } as TestRef, { runner: "pytest", path: "test_old.py" } as TestRef], [],
      { task: "fix impl.py, see test_target.py", sel: (files) => (files.includes("test_target.py") ? [{ runner: "pytest", path: "test_target.py" } as TestRef] : files.length ? [{ runner: "pytest", path: "test_target.py" } as TestRef, { runner: "pytest", path: "test_old.py" } as TestRef] : []) });
    const d = (await run(ctx)).data as unknown as Out;
    expect(d.checks.find((c) => c.name === "pytest:test_target.py")?.result).toBe("fail");
    expect(d.pre_red).toEqual([]);
    expect(d.failures_grouped.length).toBe(1);
  }, 60_000);
  test("e4: conftest skips the unrelated red test; the relevant target stays red, never pre_red", async () => {
    const OLD = "def test_old():\n    assert False\n", TGT = "from impl import double\ndef test_double():\n    assert double(2) == 4\n";
    const { ctx } = repoWith({ "impl.py": "def double(x):\n    return x + 1\n", "test_old.py": OLD, "test_target.py": TGT }, { "conftest.py": "import pytest\ndef pytest_collection_modifyitems(items):\n    for i in items:\n        if 'test_old' in i.nodeid:\n            i.add_marker(pytest.mark.skip)\n" },
      [{ runner: "pytest", path: "test_target.py" } as TestRef, { runner: "pytest", path: "test_old.py" } as TestRef], [],
      { task: "fix impl.py, see test_target.py", sel: (files) => (files.includes("test_target.py") ? [{ runner: "pytest", path: "test_target.py" } as TestRef] : files.length ? [{ runner: "pytest", path: "test_target.py" } as TestRef, { runner: "pytest", path: "test_old.py" } as TestRef] : []) });
    const d = (await run(ctx)).data as unknown as Out;
    expect(d.checks.find((c) => c.name === "pytest:test_target.py")?.result).toBe("fail");
    expect(d.pre_red).toEqual([]);
    expect(d.failures_grouped.length).toBe(1);
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
  test("FC-FULLSUITE-ANSI-IDS: failIds parses a colored vitest transcript exactly like the plain one", () => {
    const plain = " FAIL  src/a.test.ts > s > c\n FAIL  src/b.test.ts > s > d\n Tests  2 failed | 3 passed (5)";
    const colored = " \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m \u001b[31msrc/a.test.ts > s > c\u001b[39m\n \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m \u001b[31msrc/b.test.ts > s > d\u001b[39m\n \u001b[2m     Tests \u001b[22m \u001b[1m\u001b[31m2 failed\u001b[39m\u001b[22m | \u001b[32m3 passed\u001b[39m\u001b[90m (5)\u001b[39m";
    expect(failIds(plain)).toEqual(["src/a.test.ts > s > c", "src/b.test.ts > s > d"]);
    expect(failIds(colored)).toEqual(failIds(plain));
  });
  test("FC-BASELINE-PER-PACKAGE: vitest's per-test cross line carries its duration; ids are the same on base and head whatever the timing", () => {
    const vt = (ms: string) => ` ❯ src/a.test.ts (3 tests | 1 failed) ${ms}\n   × s > c ${ms}\n     → expected 1 to be 2\n\n FAIL  src/a.test.ts > s > c\nAssertionError: expected 1 to be 2\n Test Files  1 failed (1)\n      Tests  1 failed | 2 passed (3)`;
    expect(failIds(vt("5ms"))).toEqual(["s > c", "src/a.test.ts > s > c"]);
    expect(failIds(vt("1.2s"))).toEqual(failIds(vt("5ms")));
  });
  test("FC-BASELINE-PER-PACKAGE: a FAIL line keeps a trailing duration-like word (only the x-line is stripped)", () => {
    expect(failIds(" FAIL  src/a.test.ts > retry gives up after 10s\n Tests  1 failed | 2 passed")).toEqual(["src/a.test.ts > retry gives up after 10s"]);
    expect(failIds(" FAIL  src/a.test.ts > gives up after 10s\n Tests  1 failed")).not.toEqual(failIds(" FAIL  src/a.test.ts > gives up after 20s\n Tests  1 failed"));
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

describe("engine10 verify: zero executed on base too (FC-ZERO-ON-BASE)", () => {
  const SKIPPED = "// deliberately skipped, needs a real DB\n";
  type Z = Out & { skipped_on_base: string[] };
  test("an untouched impacted file that runs zero tests on base too is listed as skipped_on_base, with an event", async () => {
    const { ctx } = repoWith({ "sum.js": SUM_BUG, "sum.test.js": SUM_TEST, "skip.test.js": SKIPPED }, { "sum.test.js": SUM_TEST + "// c\n" }, [node("sum.test.js"), node("skip.test.js")]);
    const ev: string[] = []; (ctx as unknown as { emit: (t: string) => void }).emit = (t) => { ev.push(t); };
    const d = (await run(ctx)).data as unknown as Z;
    expect(d.checks.find((c) => c.name === "node:skip.test.js")?.result).toBe("not_run");
    expect(d.skipped_on_base).toEqual(["node:skip.test.js"]);
    expect(ev).toContain("test.skipped_on_base");
  }, 60_000);
  test("a file the run edited that executes zero tests stays fail-closed (not exempt)", async () => {
    const { ctx } = repoWith({ "sum.js": SUM_BUG, "skip.test.js": SKIPPED }, { "skip.test.js": SKIPPED + "// edited\n" }, [node("skip.test.js")]);
    const d = (await run(ctx)).data as unknown as Z;
    expect(d.skipped_on_base).toEqual([]);
  }, 60_000);
  test("a Wall test that executes zero tests is never exempt", async () => {
    const { ctx } = repoWith({ "sum.js": SUM_BUG, "skip.test.js": SKIPPED }, { "wall2.test.js": SUM_TEST }, [node("skip.test.js")], ["skip.test.js"]);
    const d = (await run(ctx)).data as unknown as Z;
    expect(d.skipped_on_base).toEqual([]);
  }, 60_000);
  test("workspace link: a source edit the base rerun would observe through node_modules/shared must not excuse a zero (reviewer repro)", async () => {
    const gated = T + "if (!require('shared').off) t('runs on base',()=>{});\n";
    const { ctx, dir } = repoWith({ ".gitignore": "node_modules\n", "shared/index.js": "exports.off=false;\n", "gated.test.js": gated }, { "shared/index.js": "exports.off=true;\n" }, [node("gated.test.js")]);
    mkdirSync(join(dir, "node_modules")); symlinkSync("../shared", join(dir, "node_modules", "shared"));
    const d = (await run(ctx)).data as unknown as Z;
    expect(d.checks.find((c) => c.name === "node:gated.test.js")?.result).toBe("not_run");
    expect(d.skipped_on_base).toEqual([]);
  }, 60_000);
  test("workspace link to a changed TEST file (reviewer repro 2): deps reach head sources, no excusal; relative require control is excused", async () => {
    const mk = (spec: string) => {
      const gated = T + `if (!require('${spec}').off) t('runs on base',()=>{});\n`;
      const r = repoWith({ ".gitignore": "node_modules\n", "shared/helper.test.js": "exports.off=false;\n", "gated.test.js": gated }, { "shared/helper.test.js": "exports.off=true;\n" }, [node("gated.test.js")]);
      mkdirSync(join(r.dir, "node_modules")); symlinkSync("../shared", join(r.dir, "node_modules", "shared"));
      return r.ctx;
    };
    const viaLink = (await run(mk("shared/helper.test.js"))).data as unknown as Z;
    expect(viaLink.checks.find((c) => c.name === "node:gated.test.js")?.result).toBe("not_run");
    expect(viaLink.skipped_on_base).toEqual([]);
    const rel = (await run(mk("./shared/helper.test.js"))).data as unknown as Z;
    expect(rel.skipped_on_base).toEqual([]); // head's off=true also hides the test via the relative path, and base has off=false: tests ran on base, so not zero there either
  }, 60_000);
  test("nested workspace link (reviewer repro 3): node_modules/foo/node_modules/shared -> ../../../shared withholds the excusal end to end", async () => {
    const gated = T + "if (!require('foo/node_modules/shared/helper.test.js').off) t('runs on base',()=>{});\n";
    const { ctx, dir } = repoWith({ ".gitignore": "node_modules\n", "shared/helper.test.js": "exports.off=false;\n", "gated.test.js": gated }, { "shared/helper.test.js": "exports.off=true;\n" }, [node("gated.test.js")]);
    mkdirSync(join(dir, "node_modules", "foo", "node_modules"), { recursive: true }); symlinkSync("../../../shared", join(dir, "node_modules", "foo", "node_modules", "shared"));
    const d = (await run(ctx)).data as unknown as Z;
    expect(d.checks.find((c) => c.name === "node:gated.test.js")?.result).toBe("not_run");
    expect(d.skipped_on_base).toEqual([]);
  }, 60_000);
  test("outside-repo hop (probe I): node_modules/shared -> .ext/shared, .ext -> outside, outside/shared -> repo/shared withholds end to end", async () => {
    const gated = T + "if (!require('shared/helper.test.js').off) t('runs on base',()=>{});\n";
    const { ctx, dir } = repoWith({ ".gitignore": "node_modules\n", "shared/helper.test.js": "exports.off=false;\n", "gated.test.js": gated }, { "shared/helper.test.js": "exports.off=true;\n" }, [node("gated.test.js")]);
    const out = mkdtempSync(join(tmpdir(), "e10-hop-")); dirs.push(out); symlinkSync(join(dir, "shared"), join(out, "shared"));
    mkdirSync(join(dir, "node_modules")); symlinkSync(out, join(dir, "node_modules", ".ext")); symlinkSync(".ext/shared", join(dir, "node_modules", "shared"));
    const d = (await run(ctx)).data as unknown as Z;
    expect(d.checks.find((c) => c.name === "node:gated.test.js")?.result).toBe("not_run");
    expect(d.skipped_on_base).toEqual([]);
  }, 60_000);
  test("zero on head but tests ran on base (file untouched): stays fail-closed", async () => {
    // head breaks what the file loads into executing nothing: the helper is replaced so the (unchanged) test file registers no test
    const gated = T + "if (!require('./gate.js').off) t('runs on base',()=>{});\n";
    const { ctx } = repoWith({ "gate.js": "exports.off=false;\n", "gated.test.js": gated }, { "gate.js": "exports.off=true;\n" }, [node("gated.test.js")]);
    const d = (await run(ctx)).data as unknown as Z;
    expect(d.checks.find((c) => c.name === "node:gated.test.js")?.result).toBe("not_run");
    expect(d.skipped_on_base).toEqual([]);
  }, 60_000);
});

describe("depsSeeHead (FC-ZERO-ON-BASE)", () => {
  const mk = (name = "r"): string => { const d = mkdtempSync(join(tmpdir(), "e10-dsh-")); dirs.push(d); const r = join(d, name); mkdirSync(r, { recursive: true }); return r; };
  const site = (r: string): string => { const s = join(r, ".venv", "lib", "python3.12", "site-packages"); mkdirSync(s, { recursive: true }); return s; };
  test("a nested link anywhere under node_modules that resolves into the repo is seen", () => {
    const r = mk(); mkdirSync(join(r, "shared")); mkdirSync(join(r, "node_modules", "foo", "node_modules"), { recursive: true });
    symlinkSync("../../../shared", join(r, "node_modules", "foo", "node_modules", "shared"));
    expect(depsSeeHead(r, r)).toBe(true);
  });
  test("a scoped link is seen; links and files that stay outside the repo are not", () => {
    const r = mk(), o = mk("outside"); mkdirSync(join(r, "node_modules", "@s"), { recursive: true }); mkdirSync(join(r, "node_modules", "plain"));
    writeFileSync(join(r, "node_modules", "plain", "index.js"), "x\n"); symlinkSync(o, join(r, "node_modules", "ext"));
    expect(depsSeeHead(r, r)).toBe(false);
    mkdirSync(join(r, "pkg")); symlinkSync("../../pkg", join(r, "node_modules", "@s", "pkg"));
    expect(depsSeeHead(r, r)).toBe(true);
  });
  test("a link that stays inside its own node_modules (.bin style) is self-contained", () => {
    const r = mk(); mkdirSync(join(r, "node_modules", "tool", "bin"), { recursive: true }); mkdirSync(join(r, "node_modules", ".bin"));
    writeFileSync(join(r, "node_modules", "tool", "bin", "t.js"), "x\n"); symlinkSync("../tool/bin/t.js", join(r, "node_modules", ".bin", "t"));
    expect(depsSeeHead(r, r)).toBe(false);
  });
  test("no dependency dirs: nothing to see", () => { expect(depsSeeHead(mk(), mk("other"))).toBe(false); });
  test("direct_url.json file:// URL with a space (%20) is decoded", () => {
    const r = mk("my repo"), s = site(r); mkdirSync(join(s, "x-1.dist-info"));
    writeFileSync(join(s, "x-1.dist-info", "direct_url.json"), JSON.stringify({ url: pathToFileURL(r).href, dir_info: { editable: true } }));
    expect(pathToFileURL(r).href).toContain("%20");
    expect(depsSeeHead(r, r)).toBe(true);
  });
  test("a remote direct_url.json does not see head", () => {
    const r = mk(), s = site(r); mkdirSync(join(s, "x-1.dist-info"));
    writeFileSync(join(s, "x-1.dist-info", "direct_url.json"), JSON.stringify({ url: "https://example.invalid/x.tar.gz" }));
    expect(depsSeeHead(r, r)).toBe(false);
  });
  test("path spelling: a symlinked repo dir is compared as given and as realpath", () => {
    const r = mk(), l = join(r, "..", "linked"); symlinkSync(r, l); mkdirSync(join(r, "shared"));
    const s = site(r); writeFileSync(join(s, "x.pth"), join(l, "shared") + "\n"); // spelled through the link, repoDir given as the real path
    expect(depsSeeHead(r, r)).toBe(true);
    rmSync(join(s, "x.pth")); writeFileSync(join(s, "y.egg-link"), join(r, "shared") + "\n\n"); // spelled real, repoDir given through the link
    expect(depsSeeHead(r, l)).toBe(true);
  });
  test("an editable finder module naming the repo is seen", () => {
    const r = mk(), s = site(r); writeFileSync(join(s, "__editable___x_1_0_finder.py"), `MAPPING = {'x': '${join(r, "src", "x")}'}\n`);
    expect(depsSeeHead(r, r)).toBe(true);
  });
  test("an unrelated .pth outside the repo does not see head", () => {
    const r = mk(), o = mk("elsewhere"), s = site(r); writeFileSync(join(s, "x.pth"), o + "\n");
    expect(depsSeeHead(r, r)).toBe(false);
  });
});
