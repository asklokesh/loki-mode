// A-115: a relevant check with more skipped tests than base is neither a pass nor progress; test-config edits are NOT PROVEN.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext, TestRef } from "../../src/engine10/types.ts";
import { testConfigChanged, verifyStage } from "../../src/engine10/stages/verify.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sh = (d: string, a: string[]): string => execFileSync("git", a, { cwd: d, encoding: "utf8" }).trim();
const T = "const t=require('node:test');const assert=require('node:assert');";
const node = (path: string): TestRef => ({ runner: "node", path }) as TestRef;
const py = (path: string): TestRef => ({ runner: "pytest", path }) as TestRef;
type V = { pre_red: string[]; not_proven: string[] };

function repo(base: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "e10-weak-"));
  dirs.push(dir);
  sh(dir, ["init", "-q"]); sh(dir, ["config", "user.email", "t@t.test"]); sh(dir, ["config", "user.name", "t"]);
  for (const [f, c] of Object.entries({ ...base, ".gitignore": ".venv/\n" })) writeFileSync(join(dir, f), c);
  sh(dir, ["add", "-A"]); sh(dir, ["commit", "-q", "-m", "base"]);
  // an ignored project interpreter, so verify records no "tests ran on the system interpreter" note and a clean run seals VERIFIED
  mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
  symlinkSync(Bun.which("python3")!, join(dir, ".venv", "bin", "python"));
  return dir;
}
/** `work` is written on top of the base commit; `sel(files)` answers impacted(): the named-files call gets the target only. */
async function verify(base: Record<string, string>, work: Record<string, string>, task: string, target: TestRef, other: TestRef, narrow = false): Promise<V> {
  const dir = repo(base), baseSha = sh(dir, ["rev-parse", "HEAD"]);
  for (const [f, c] of Object.entries(work)) writeFileSync(join(dir, f), c);
  mkdirSync(join(dir, ".loki"), { recursive: true });
  writeFileSync(join(dir, ".loki", "repomap.json"), JSON.stringify({ files: Object.keys(base) }));
  const ctx = {
    repoDir: dir, runDir: join(dir, ".loki"), baseSha, emit: () => {},
    tests: { detect: async () => ({ runners: [], tests: [target, other] }), impacted: (_m: unknown, f: string[]) => (f.includes(target.path) && (!narrow || f.length === 1) ? [target] : f.length ? [target, other] : []) },
    outputs: () => ({ intake: { task, repomap_ref: join(dir, ".loki", "repomap.json") }, wall: { files: [] } }),
  } as unknown as RunContext;
  return (await verifyStage.run(ctx, new AbortController().signal)).data as unknown as V;
}

describe("engine10 verify: weakened checks (A-115)", () => {
  // c10 fixture: one relevant file with the target, an unrelated red test and two passing tests ("2 passed, 2 skipped" once conftest skips both reds)
  const ONE = "from impl import double\ndef test_double():\n    assert double(2) == 4\ndef test_old():\n    assert False\ndef test_ok1():\n    assert True\ndef test_ok2():\n    assert True\n";
  const IMPL = { "impl.py": "def double(x):\n    return x + 1\n" };
  // e9 fixture: the unrelated red test lives in its own file, so a false "progress" subtracts it as pre_red
  const TGT = "from impl import double\ndef test_double():\n    assert double(2) == 4\ndef test_ok():\n    assert True\n";
  const TWO = { ...IMPL, "test_target.py": TGT, "test_old.py": "def test_old():\n    assert False\n" };
  const TASK = "fix impl.py, see test_target.py";
  const skipConftest = (extra = "", names = ["test_double", "test_old"]): string => "import pytest\ndef pytest_collection_modifyitems(items):\n    for i in items:\n        if any(n in i.nodeid for n in " + JSON.stringify(names) + "):\n            i.add_marker(pytest.mark.skip)\n" + extra;
  const weak = (d: V): string[] => d.not_proven.filter((n) => /skipped|configuration/.test(n));
  test("c10: conftest skips the target and the unrelated red test in the relevant file: config note and skip note (main: no note, VERIFIED inputs)", async () => {
    const d = await verify({ ...IMPL, "test_target.py": ONE, "test_other.py": "def test_x():\n    assert True\n" }, { "conftest.py": skipConftest() }, TASK, py("test_target.py"), py("test_other.py"));
    expect(weak(d)).toEqual(["test configuration changed: conftest.py", "skipped or fewer tests than base: pytest:test_target.py"]);
  }, 60_000);
  test("e9: conftest skips the target and runs another test twice: same pass count, no progress, unrelated red not subtracted", async () => {
    const d = await verify(TWO, { "conftest.py": skipConftest("    if 'test_target' in items[0].nodeid:\n        items.append(items[-1])\n", ["test_double"]) }, TASK, py("test_target.py"), py("test_old.py"));
    expect(d.pre_red).toEqual([]);
    expect(weak(d)).toContain("skipped or fewer tests than base: pytest:test_target.py");
  }, 60_000);
  test("node: { skip: true } added to the target in its own test file: no progress, skip note", async () => {
    const sum = "const {sum}=require('./sum.js');";
    const d = await verify(
      { "sum.js": "exports.sum=(a)=>a.slice(1).reduce((x,y)=>x+y,0);\n", "sum.test.js": T + sum + "t('sums all',()=>{assert.strictEqual(sum([1,2,3]),6);});t('ok',()=>{});\n", "other.test.js": T + "t('unrelated',()=>{assert.strictEqual(1,2);});\n" },
      { "sum.test.js": T + sum + "t('sums all',{skip:true},()=>{assert.strictEqual(sum([1,2,3]),6);});t('ok',()=>{});\n" },
      "fix sum.js, covered by sum.test.js", node("sum.test.js"), node("other.test.js"));
    expect(d.pre_red).toEqual([]);
    expect(d.not_proven).toContain("skipped or fewer tests than base: node:sum.test.js");
  }, 60_000);
  test("xfail: the target path calls pytest.xfail: 1 passed, 1 xfailed is weak", async () => {
    const d = await verify(TWO, { "impl.py": "import pytest\ndef double(x):\n    pytest.xfail('later')\n" }, TASK, py("test_target.py"), py("test_old.py"));
    expect(d.pre_red).toEqual([]);
    expect(weak(d)).toContain("skipped or fewer tests than base: pytest:test_target.py");
  }, 60_000);
  test("exit: the target path calls pytest.exit(returncode=0) after one test: fewer tests than base is weak", async () => {
    const T2 = "from impl import double\ndef test_ok():\n    assert True\ndef test_double():\n    assert double(2) == 4\n";
    const d = await verify({ ...TWO, "test_target.py": T2 }, { "impl.py": "import pytest\ndef double(x):\n    pytest.exit('done', returncode=0)\n" }, TASK, py("test_target.py"), py("test_old.py"));
    expect(d.pre_red).toEqual([]);
    expect(weak(d)).toContain("skipped or fewer tests than base: pytest:test_target.py");
  }, 60_000);
  test("delete: the target test is deleted from the relevant node test file: weak, and the edited relevant test file is NOT PROVEN", async () => {
    const sum = "const {sum}=require('./sum.js');";
    const d = await verify(
      { "sum.js": "exports.sum=(a)=>a.slice(1).reduce((x,y)=>x+y,0);\n", "sum.test.js": T + sum + "t('sums all',()=>{assert.strictEqual(sum([1,2,3]),6);});t('ok',()=>{});\n", "other.test.js": T + "t('unrelated',()=>{assert.strictEqual(1,2);});\n" },
      { "sum.test.js": T + sum + "t('ok',()=>{});\n" },
      "fix sum.js, covered by sum.test.js", node("sum.test.js"), node("other.test.js"));
    expect(d.pre_red).toEqual([]);
    expect(d.not_proven).toContain("skipped or fewer tests than base: node:sum.test.js");
    expect(d.not_proven).toContain("weakened test: sum.test.js");
  }, 60_000);
  test("pytest.toml and .pytest.ini are test configuration", () => {
    expect(testConfigChanged(".", "HEAD", ["pytest.toml", "sub/.pytest.ini"])).toEqual(["pytest.toml", "sub/.pytest.ini"]);
  });
  test("honest fix: target really fixed, unrelated red before and after: pre_red listed, no weakened-check note", async () => {
    const d = await verify(TWO, { "impl.py": "def double(x):\n    return x * 2\n" }, TASK, py("test_target.py"), py("test_old.py"));
    expect(d.pre_red).toEqual(["test_old.py::test_old"]);
    expect(d.not_proven).toEqual([]);
  }, 60_000);
  test("A-115b: honest fix that appends a test to the relevant file, unrelated red elsewhere: red target went green, pre_red subtracted, weakened note only", async () => {
    const d = await verify(TWO, { "impl.py": "def double(x):\n    return x * 2\n", "test_target.py": TGT + "def test_new():\n    assert True\n" }, "see test_target.py", py("test_target.py"), py("test_old.py"), true);
    expect(d.pre_red).toEqual(["test_old.py::test_old"]);
    expect(d.not_proven).toEqual(["weakened test: test_target.py"]);
  }, 60_000);
  test("A-115b: a base node test printing pass/fail lines does not inflate the base count", async () => {
    const noise = "console.log('# pass 40');console.log('# fail 40');";
    const sum = "const {sum}=require('./sum.js');";
    const d = await verify(
      { "sum.js": "exports.sum=(a)=>a.slice(1).reduce((x,y)=>x+y,0);\n", "sum.test.js": T + sum + noise + "t('sums all',()=>{assert.strictEqual(sum([1,2,3]),6);});t('ok',()=>{});\n", "other.test.js": T + "t('unrelated',()=>{assert.strictEqual(1,2);});\n" },
      { "sum.js": "exports.sum=(a)=>a.reduce((x,y)=>x+y,0);\n" },
      "fix sum.js, covered by sum.test.js", node("sum.test.js"), node("other.test.js"));
    expect(d.not_proven.filter((n) => /fewer tests/.test(n))).toEqual([]);
  }, 60_000);
  test("testConfigChanged: a package.json dependency edit is not config; a scripts.test edit is; always-config names are", () => {
    const pkg = (t: string, deps: string): string => `{\n  "scripts": {\n    "test": "${t}"\n  },\n  "dependencies": {${deps}}\n}\n`;
    const dir = repo({ "package.json": pkg("node --test", "") }), base = sh(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "package.json"), pkg("node --test", '"x": "1"'));
    expect(testConfigChanged(dir, base, ["package.json"])).toEqual([]);
    writeFileSync(join(dir, "package.json"), pkg("true", ""));
    expect(testConfigChanged(dir, base, ["package.json", "jest.config.js", "src/a.ts"])).toEqual(["package.json", "jest.config.js"]);
  });
  // D50-F2-S2: humanize-174 shape. A literal swap in a parametrize row of a test calling the named symbol is worded as a spec change; never a verdict change.
  const HBASE = 'import pytest\nfrom impl import naturaldelta\n\n\n@pytest.mark.parametrize("s, e", [\n    (59, "59 seconds"),\n    (119, "a minute"),\n])\ndef test_nd(s, e):\n    assert naturaldelta(s) == e\n\n\ndef test_ok():\n    assert True\n';
  const HIMPL = (r: string): Record<string, string> => ({ "impl.py": `def naturaldelta(s):\n    return "59 seconds" if s < 60 else "${r}"\n` });
  const HTASK = "fix naturaldelta in impl.py, see test_time.py";
  test("D50-F2-S2: literal value swap in a test calling the named symbol: assertion changed per spec, not weakened test", async () => {
    const d = await verify({ ...HIMPL("a minute"), "test_time.py": HBASE, "test_o.py": "def test_x():\n    assert True\n" }, { ...HIMPL("2 minutes"), "test_time.py": HBASE.replace('(119, "a minute")', '(119, "2 minutes")') }, HTASK, py("test_time.py"), py("test_o.py"));
    expect(d.not_proven).toEqual(["assertion changed per spec: test_time.py:7 'a minute' -> '2 minutes'"]);
  }, 60_000);
  test("D50-F2-S2: the same fixture with the assert deleted stays weakened test", async () => {
    const d = await verify({ ...HIMPL("a minute"), "test_time.py": HBASE, "test_o.py": "def test_x():\n    assert True\n" }, { ...HIMPL("2 minutes"), "test_time.py": HBASE.replace("    assert naturaldelta(s) == e\n", "    pass\n") }, HTASK, py("test_time.py"), py("test_o.py"));
    expect(d.not_proven).toContain("weakened test: test_time.py");
    expect(d.not_proven.some((n) => n.startsWith("assertion changed"))).toBe(false);
  }, 60_000);
});
