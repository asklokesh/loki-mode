// A-115: a relevant check with more skipped tests than base is neither a pass nor progress; test-config edits are NOT PROVEN.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { RunContext, TestRef } from "../../src/engine10/types.ts";
import { hiddenEdits } from "../../src/util/check_result.ts";
import { testConfigChanged, verifyStage } from "../../src/engine10/stages/verify.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const sh = (d: string, a: string[]): string => execFileSync("git", a, { cwd: d, encoding: "utf8" }).trim();
const T = "const t=require('node:test');const assert=require('node:assert');";
const node = (path: string): TestRef => ({ runner: "node", path }) as TestRef;
const py = (path: string): TestRef => ({ runner: "pytest", path }) as TestRef;
type V = { pre_red: string[]; not_proven: string[]; target_checks?: string[] };

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
async function verify(base: Record<string, string>, work: Record<string, string>, task: string, target: TestRef, other: TestRef, narrow = false, prep?: (dir: string) => void): Promise<V> {
  const dir = repo(base), baseSha = sh(dir, ["rev-parse", "HEAD"]);
  prep?.(dir);
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
  // FC-GIT-HIDDEN-EDIT: a flagged tracked conftest is edited, git diff/status/commit stay silent, the forged file makes the red target pass
  const HID = { ...TWO, "conftest.py": "# shared fixtures\n", "guide.md": "guide\n" }, FORGED = { "conftest.py": "import impl\nimpl.double = lambda x: x * 2\n", "notes.md": "done\n" };
  const hidNote = "tracked file edited while assume-unchanged or skip-worktree hides it from diff and commit: conftest.py";
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) test(`${flag} on a tracked conftest, then a forged edit: NOT PROVEN names the file (main: not_proven [])`, async () => {
    const d = await verify(HID, FORGED, TASK, py("test_target.py"), py("test_old.py"), false, (dir) => sh(dir, ["update-index", flag, "conftest.py"]));
    expect(d.target_checks).toEqual(["pytest:test_target.py"]); // the forged conftest really turned the red target green
    expect(d.not_proven).toContain(hidNote);
    expect(d.not_proven).not.toContain("test configuration changed: conftest.py"); // git itself hides the edit from every diff-based note
  }, 60_000);
  test("assume-unchanged set on conftest before the run, file untouched, honest fix: no note", async () => {
    let lsv = "";
    const d = await verify(HID, { "impl.py": "def double(x):\n    return x * 2\n" }, TASK, py("test_target.py"), py("test_old.py"), false, (dir) => { sh(dir, ["update-index", "--assume-unchanged", "conftest.py"]); lsv = sh(dir, ["ls-files", "-v", "conftest.py"]); });
    expect(lsv).toBe("h conftest.py");
    expect(d.not_proven).toEqual([]);
  }, 60_000);
  test("sparse checkout: skip-worktree paths outside the cone are absent and never refuse an honest fix", async () => {
    let lsv = "";
    const d = await verify(HID, { "impl.py": "def double(x):\n    return x * 2\n" }, TASK, py("test_target.py"), py("test_old.py"), false, (dir) => { sh(dir, ["sparse-checkout", "set", "--no-cone", "/*", "!/guide.md"]); lsv = sh(dir, ["ls-files", "-v", "guide.md"]); });
    expect(lsv).toBe("S guide.md");
    expect(d.not_proven).toEqual([]);
  }, 60_000);
  // FC-GIT-HIDDEN-EDIT, round 2: git decides content equality on a copy of the index with the flag bits cleared
  const hidRepo = (files: Record<string, string>, cfg: string[][] = []): string => {
    const dir = mkdtempSync(join(tmpdir(), "e10-hid-")); dirs.push(dir);
    sh(dir, ["init", "-q"]); sh(dir, ["config", "user.email", "t@t.test"]); sh(dir, ["config", "user.name", "t"]);
    for (const [k, v] of cfg) sh(dir, ["config", k!, v!]);
    for (const [f, c] of Object.entries(files)) { writeFileSync(join(dir, f), c); utimesSync(join(dir, f), 1577836800, 1577836800); }
    sh(dir, ["-c", "core.autocrlf=false", "add", ...Object.keys(files)]); sh(dir, ["commit", "-q", "-m", "base"]); // the blobs are the bytes given, whatever core.autocrlf says
    return dir;
  };
  const note = (f: string): string => `tracked file edited while assume-unchanged or skip-worktree hides it from diff and commit: ${f}`;
  test("finding 1: a skip-worktree file deleted while sparse checkout is off is a hidden deletion (12a5094: no note)", () => {
    const dir = hidRepo({ "conftest.py": "# fixtures\n", "impl.py": "x\n" });
    sh(dir, ["update-index", "--skip-worktree", "conftest.py"]); rmSync(join(dir, "conftest.py"));
    expect(hiddenEdits(dir)).toEqual([note("conftest.py")]);
  });
  test("finding 1 control: a skip-worktree path absent under a real sparse checkout is no note", () => {
    const dir = hidRepo({ "conftest.py": "# fixtures\n", "guide.md": "g\n" });
    sh(dir, ["sparse-checkout", "set", "--no-cone", "/*", "!/guide.md"]);
    expect(sh(dir, ["ls-files", "-v", "guide.md"])).toBe("S guide.md");
    expect(hiddenEdits(dir)).toEqual([]);
  });
  test("r3 control: cone-mode sparse checkout: a skip-worktree file in an excluded directory is no note, a deleted file in an included directory is", () => {
    const dir = hidRepo({ "conftest.py": "c\n" });
    for (const d of ["keep", "drop"]) { mkdirSync(join(dir, d)); writeFileSync(join(dir, d, "f.py"), "x\n"); }
    sh(dir, ["add", "keep", "drop"]); sh(dir, ["commit", "-q", "-m", "dirs"]);
    sh(dir, ["sparse-checkout", "set", "--cone", "keep"]);
    expect(sh(dir, ["ls-files", "-v", "drop/f.py"])).toBe("S drop/f.py");
    expect(hiddenEdits(dir)).toEqual([]);
    sh(dir, ["update-index", "--skip-worktree", "keep/f.py"]); rmSync(join(dir, "keep", "f.py"));
    expect(hiddenEdits(dir)).toEqual([note("keep/f.py")]);
  });
  test("r3: core.sparseCheckout=true set by the implementer, with no sparse pattern excluding the path, does not hide a deleted skip-worktree conftest.py", () => {
    const dir = hidRepo({ "conftest.py": "# fixtures\n", "t.py": "x\n" });
    sh(dir, ["update-index", "--skip-worktree", "conftest.py"]); rmSync(join(dir, "conftest.py")); sh(dir, ["config", "core.sparseCheckout", "true"]);
    expect(hiddenEdits(dir)).toEqual([note("conftest.py")]);
  });
  test("r3: sparse config on and a pattern file that includes the path (/*): the deletion is reported", () => {
    const dir = hidRepo({ "conftest.py": "# fixtures\n", "t.py": "x\n" });
    sh(dir, ["update-index", "--skip-worktree", "conftest.py"]); rmSync(join(dir, "conftest.py")); sh(dir, ["config", "core.sparseCheckout", "true"]);
    writeFileSync(join(dir, ".git", "info", "sparse-checkout"), "/*\n");
    expect(hiddenEdits(dir)).toEqual([note("conftest.py")]);
  });
  test("finding 2: a submodule moved to another commit, then marked assume-unchanged, is named (12a5094: no note)", () => {
    const sub = hidRepo({ "a.txt": "1\n" }), dir = hidRepo({ "top.txt": "t\n" });
    sh(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor"]); sh(dir, ["commit", "-q", "-m", "sub"]);
    writeFileSync(join(sub, "a.txt"), "2\n"); sh(sub, ["commit", "-q", "-am", "next"]);
    sh(join(dir, "vendor"), ["pull", "-q", "origin", "HEAD"]); // the submodule checkout now sits on a commit the index does not record
    sh(dir, ["update-index", "--assume-unchanged", "vendor"]);
    expect(sh(dir, ["status", "--porcelain"])).toBe(""); // git itself reports nothing
    expect(hiddenEdits(dir)).toEqual([note("vendor")]);
  });
  test("finding 3: a repo with 9000 long-named files and zero flagged files gets no note (12a5094: ENOBUFS note); one flagged and edited file is named", () => {
    const dir = hidRepo({ "keep.txt": "k\n" }), d1 = "d".repeat(120), files: string[] = [];
    mkdirSync(join(dir, d1)); for (let i = 0; i < 9000; i++) { const f = `${d1}/${"f".repeat(100)}${i}.txt`; writeFileSync(join(dir, f), `${i}\n`); files.push(f); }
    sh(dir, ["add", d1]); sh(dir, ["commit", "-q", "-m", "many"]);
    expect(hiddenEdits(dir)).toEqual([]);
    sh(dir, ["update-index", "--assume-unchanged", files[4]!]); writeFileSync(join(dir, files[4]!), "edited\n");
    expect(hiddenEdits(dir)).toEqual([note(files[4]!)]);
  }, 60_000);
  test("finding 4: an untouched assume-unchanged file whose committed blob has CRLF, under core.autocrlf=true, is no note (12a5094: false note)", () => {
    const dir = hidRepo({ "crlf.txt": "a\r\nb\r\n", "x.txt": "x\n" }, [["core.autocrlf", "true"]]);
    sh(dir, ["update-index", "--assume-unchanged", "crlf.txt"]);
    expect(sh(dir, ["ls-files", "-v", "crlf.txt"])).toBe("h crlf.txt");
    expect(sh(dir, ["status", "--porcelain"])).toBe(""); // git itself calls the tree clean
    expect(hiddenEdits(dir)).toEqual([]);
    utimesSync(join(dir, "crlf.txt"), 1600000000, 1600000000); // a touched file with the same bytes is no edit either
    expect(hiddenEdits(dir)).toEqual([]);
  });
  for (const cfg of [["core.trustctime", "false"], ["core.checkStat", "minimal"]]) test(`repo ${cfg[0]}=${cfg[1]}: a same-size edit with mtime restored on a flagged file is still named (12a5094: no note)`, () => {
    const dir = hidRepo({ "conftest.py": "AAAA\n" }, [cfg as string[]]), f = join(dir, "conftest.py"), ref = join(dir, "..", `${basename(dir)}.ref`);
    sh(dir, ["update-index", "--assume-unchanged", "conftest.py"]);
    Bun.sleepSync(1100); // ctime is compared to the second, so the edit must land in a later second than the index entry
    execFileSync("touch", ["-r", f, ref]); writeFileSync(f, "BBBB\n"); execFileSync("touch", ["-r", ref, f]); rmSync(ref); // same inode, size and nanosecond mtime; only ctime moved
    expect(sh(dir, ["status", "--porcelain"])).toBe("");
    expect(hiddenEdits(dir)).toEqual([note("conftest.py")]);
  });
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
  test("FC-09s: a package.json pretest edit caps the verdict with a configuration note", async () => {
    const pj = (pre: string): string => JSON.stringify({ name: "x", scripts: { test: "pytest", pretest: pre } });
    const d = await verify({ ...TWO, "package.json": pj("echo a") }, { "impl.py": "def double(x):\n    return x * 2\n", "package.json": pj("echo b") }, TASK, py("test_target.py"), py("test_old.py"));
    expect(d.not_proven).toContain("test configuration changed: package.json");
  }, 60_000);
  // D50-F2-S2: humanize-174 shape. A literal swap in a parametrize row of a test calling the named symbol is worded as a spec change; never a verdict change.
  const HBASE = 'import pytest\nfrom impl import naturaldelta\n\n\n@pytest.mark.parametrize("s, e", [\n    (59, "59 seconds"),\n    (119, "a minute"),\n])\ndef test_nd(s, e):\n    assert naturaldelta(s) == e\n\n\ndef test_ok():\n    assert True\n';
  const HIMPL = (r: string): Record<string, string> => ({ "impl.py": `def naturaldelta(s):\n    return "59 seconds" if s < 60 else "${r}"\n` });
  const HTASK = "fix naturaldelta in impl.py, see test_time.py; 119 seconds is 2 minutes";
  test("D50-F2-S2: literal value swap in a test calling the named symbol: labelled beside weakened test", async () => {
    const d = await verify({ ...HIMPL("a minute"), "test_time.py": HBASE, "test_o.py": "def test_x():\n    assert True\n" }, { ...HIMPL("2 minutes"), "test_time.py": HBASE.replace('(119, "a minute")', '(119, "2 minutes")') }, HTASK, py("test_time.py"), py("test_o.py"));
    expect(d.not_proven).toEqual(["weakened test: test_time.py", "assertion value changed (not shown to be required by the task): test_time.py:7 'a minute' -> '2 minutes'"]);
  }, 60_000);
  test("D50-F2-S2: the same fixture with the assert deleted stays weakened test", async () => {
    const d = await verify({ ...HIMPL("a minute"), "test_time.py": HBASE, "test_o.py": "def test_x():\n    assert True\n" }, { ...HIMPL("2 minutes"), "test_time.py": HBASE.replace("    assert naturaldelta(s) == e\n", "    pass\n") }, HTASK, py("test_time.py"), py("test_o.py"));
    expect(d.not_proven).toContain("weakened test: test_time.py");
    expect(d.not_proven.some((n) => n.startsWith("assertion value changed"))).toBe(false);
  }, 60_000);
  test("D50-F2r: if True -> if False in a test is weakened test only, never the required-by-task label", async () => {
    const B = "from impl import naturaldelta\n\n\ndef test_nd():\n    if True:\n        assert naturaldelta(119) == 'a minute'\n";
    const d = await verify({ ...HIMPL("a minute"), "test_time.py": B, "test_o.py": "def test_x():\n    assert True\n" }, { ...HIMPL("2 minutes"), "test_time.py": B.replace("if True", "if False") }, HTASK + " True False", py("test_time.py"), py("test_o.py"));
    expect(d.not_proven.join("\n")).toContain("weakened test");
    expect(d.not_proven.join("\n")).not.toContain("required by the task");
  }, 60_000);
});
