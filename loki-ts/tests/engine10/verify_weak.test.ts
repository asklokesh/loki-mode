// A-115: a relevant check with more skipped tests than base is neither a pass nor progress; test-config edits are NOT PROVEN.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { RunContext, TestRef } from "../../src/engine10/types.ts";
import { hiddenEdits, ignoreRuleChanges, ignoreSnapshot } from "../../src/util/check_result.ts";
import { testConfigChanged, verifyStage } from "../../src/engine10/stages/verify.ts";
import { hiddenConfigChanged, hiddenRunnerConfigs } from "../../src/features/runner_config.ts";
import { createHash } from "node:crypto";

const dirs: string[] = [];
let lastRepo = "";
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
/** `work` is written on top of the base commit; `sel(files)` answers impacted(): the named-files call gets the target only. `prep` runs and `pre` is written before the intake snapshot (hidden_cfg, ignore_snapshot); `during` runs after it, before the work. */
async function verify(base: Record<string, string>, work: Record<string, string>, task: string, target: TestRef, other: TestRef, narrow = false, prep?: (dir: string) => void, pre: Record<string, string> = {}, during?: (dir: string) => void): Promise<V> {
  const dir = repo(base), baseSha = sh(dir, ["rev-parse", "HEAD"]); lastRepo = dir;
  prep?.(dir);
  for (const [f, c] of Object.entries(pre)) writeFileSync(join(dir, f), c);
  const hidden_cfg = hiddenRunnerConfigs(dir);
  const ignore_snapshot = ignoreSnapshot(dir); // intake records the ignore sources after prep, before the run touches anything
  during?.(dir);
  for (const [f, c] of Object.entries(work)) writeFileSync(join(dir, f), c);
  mkdirSync(join(dir, ".loki"), { recursive: true });
  writeFileSync(join(dir, ".loki", "repomap.json"), JSON.stringify({ files: Object.keys(base) }));
  const ctx = {
    repoDir: dir, runDir: join(dir, ".loki"), baseSha, emit: () => {},
    tests: { detect: async () => ({ runners: [], tests: [target, other] }), impacted: (_m: unknown, f: string[]) => (f.includes(target.path) && (!narrow || f.length === 1) ? [target] : f.length ? [target, other] : []) },
    outputs: () => ({ intake: { task, repomap_ref: join(dir, ".loki", "repomap.json"), hidden_cfg, ignore_snapshot }, wall: { files: [] } }),
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
  // FC-IGNORE-RULE-HIDES-INPUT: a pattern the run adds to .git/info/exclude or core.excludesFile hides a planted conftest from the diff, seal, receipt and PR
  const exclNote = "ignore rules changed while the run was in progress: .git/info/exclude";
  const noAbsolute = (notes: string[]): void => { for (const n of notes) { expect(n).not.toContain(lastRepo); expect(n).not.toContain(realpathSync(lastRepo)); if (process.env["HOME"]) expect(n).not.toContain(process.env["HOME"]); } }; // notes reach receipt.json and the PR body
  test("info/exclude pattern added by the run, then a hidden forged conftest turns the target green: NOT PROVEN names the file and the hidden conftest (main: not_proven [])", async () => {
    const d = await verify(TWO, FORGED, TASK, py("test_target.py"), py("test_old.py"), false, undefined, {}, (dir) => appendFileSync(join(dir, ".git", "info", "exclude"), "conftest.py\n"));
    expect(d.target_checks).toEqual(["pytest:test_target.py"]); // the forged conftest really turned the red target green
    expect(d.not_proven.some((n) => n.startsWith(exclNote) && n.includes("info/exclude"))).toBe(true);
    expect(d.not_proven.some((n) => n.startsWith("ignored file created during the run") && n.includes("conftest.py"))).toBe(true);
    noAbsolute(d.not_proven);
  }, 60_000);
  test("core.excludesFile pointed at a new file by the run: NOT PROVEN names core.excludesFile and the new path (main: not_proven [])", async () => {
    const out = mkdtempSync(join(tmpdir(), "e10-excl-")); dirs.push(out); const g = join(out, "global-ignore"); writeFileSync(g, "conftest.py\n");
    const d = await verify(TWO, FORGED, TASK, py("test_target.py"), py("test_old.py"), false, undefined, {}, (dir) => sh(dir, ["config", "core.excludesFile", g]));
    expect(d.target_checks).toEqual(["pytest:test_target.py"]);
    expect(d.not_proven.some((n) => n.includes("core.excludesFile now resolves to") && n.includes("global-ignore"))).toBe(true);
    expect(d.not_proven.some((n) => n.startsWith("ignored file created during the run") && n.includes("conftest.py"))).toBe(true);
    noAbsolute(d.not_proven);
  }, 60_000);
  test("the run edits the tracked root .gitignore to add conftest.py, then plants a forged conftest: NOT PROVEN names .gitignore and conftest.py", async () => {
    const d = await verify({ ...TWO, ".gitignore": "*.pyc\n" }, FORGED, TASK, py("test_target.py"), py("test_old.py"), false, undefined, {}, (dir) => appendFileSync(join(dir, ".gitignore"), "conftest.py\n"));
    expect(d.target_checks).toEqual(["pytest:test_target.py"]);
    expect(d.not_proven.some((n) => n.includes(".gitignore"))).toBe(true);
    expect(d.not_proven.some((n) => n.startsWith("ignored file created during the run") && n.includes("conftest.py"))).toBe(true);
    noAbsolute(d.not_proven);
  }, 60_000);
  test("the run adds an untracked self-ignoring pkg/.gitignore and plants pkg/conftest.py: NOT PROVEN names .gitignore and conftest.py", async () => {
    const d = await verify(TWO, FORGED, TASK, py("test_target.py"), py("test_old.py"), false, undefined, {}, (dir) => { mkdirSync(join(dir, "pkg")); writeFileSync(join(dir, "pkg", ".gitignore"), "conftest.py\n.gitignore\n"); writeFileSync(join(dir, "pkg", "conftest.py"), "import impl\nimpl.double = lambda x: x * 2\n"); });
    expect(d.not_proven.some((n) => n.includes("pkg/.gitignore"))).toBe(true);
    expect(d.not_proven.some((n) => n.startsWith("ignored file created during the run") && n.includes("pkg/conftest.py"))).toBe(true);
    noAbsolute(d.not_proven);
  }, 60_000);
  // A directory verify executes from or imports from is never exempt, whatever its name or its .gitignore says.
  const hiddenNote = (d: V, f: string): boolean => d.not_proven.some((n) => n.startsWith("an ignored file that can change what verify runs or imports was added or changed during the run") && n.includes(f));
  const SHIM = "#!/bin/sh\ncase \"$*\" in *pytest*) echo '2 passed in 0.01s'; exit 0;; esac\nexec python3 \"$@\"\n";
  test("the run replaces the existing .venv/bin/python with a shim that prints 2 passed: NOT PROVEN names .venv/bin/python", async () => {
    const d = await verify(TWO, { "impl.py": "# tidy\ndef double(x):\n    return x + 1\n" }, TASK, py("test_target.py"), py("test_old.py"), false, undefined, {}, (dir) => { rmSync(join(dir, ".venv", "bin", "python")); writeFileSync(join(dir, ".venv", "bin", "python"), SHIM); chmodSync(join(dir, ".venv", "bin", "python"), 0o755); writeFileSync(join(dir, ".venv", ".gitignore"), "*\n"); });
    expect(hiddenNote(d, ".venv/bin/python")).toBe(true);
    expect(d.not_proven.some((n) => n.includes(".venv/.gitignore"))).toBe(true);
    noAbsolute(d.not_proven);
  }, 60_000);
  test("a .venv that did not exist at intake is created by the run with a shim python: NOT PROVEN names .venv/bin/python", async () => {
    const d = await verify(TWO, { "impl.py": "# tidy\ndef double(x):\n    return x + 1\n" }, TASK, py("test_target.py"), py("test_old.py"), false, (dir) => rmSync(join(dir, ".venv"), { recursive: true }), {}, (dir) => { mkdirSync(join(dir, ".venv", "bin"), { recursive: true }); writeFileSync(join(dir, ".venv", ".gitignore"), "*\n"); writeFileSync(join(dir, ".venv", "bin", "python"), SHIM); chmodSync(join(dir, ".venv", "bin", "python"), 0o755); });
    expect(hiddenNote(d, ".venv/bin/python")).toBe(true);
  }, 60_000);
  test("the run plants .pytest_cache/conftest.py beside a self-ignoring .gitignore: NOT PROVEN names the conftest and the .gitignore", async () => {
    const d = await verify(TWO, FORGED, TASK, py("test_target.py"), py("test_old.py"), false, undefined, {}, (dir) => { mkdirSync(join(dir, ".pytest_cache")); writeFileSync(join(dir, ".pytest_cache", ".gitignore"), "# Created by pytest automatically.\n*\n"); writeFileSync(join(dir, ".pytest_cache", "conftest.py"), "x = 1\n"); });
    expect(d.not_proven.some((n) => n.includes(".pytest_cache/conftest.py"))).toBe(true); // named by the runner-config check or by the ignored-file check
    expect(d.not_proven.some((n) => n.startsWith("ignore rules changed") && n.includes(".pytest_cache/.gitignore"))).toBe(true);
  }, 60_000);
  test("a nested pkg/venv with a self-ignoring .gitignore and a conftest.py: NOT PROVEN names both", async () => {
    const d = await verify(TWO, FORGED, TASK, py("test_target.py"), py("test_old.py"), false, undefined, {}, (dir) => { mkdirSync(join(dir, "pkg", "venv"), { recursive: true }); writeFileSync(join(dir, "pkg", "venv", ".gitignore"), "*\n"); writeFileSync(join(dir, "pkg", "venv", "conftest.py"), "x = 1\n"); });
    expect(d.not_proven.some((n) => n.includes("pkg/venv/conftest.py"))).toBe(true); // named by the runner-config check or by the ignored-file check
    expect(d.not_proven.some((n) => n.includes("pkg/venv/.gitignore"))).toBe(true);
  }, 60_000);
  test("tests/.tox with a bare * .gitignore and a conftest.py: NOT PROVEN names both", async () => {
    const d = await verify(TWO, FORGED, TASK, py("test_target.py"), py("test_old.py"), false, undefined, {}, (dir) => { mkdirSync(join(dir, "tests", ".tox"), { recursive: true }); writeFileSync(join(dir, "tests", ".tox", ".gitignore"), "*\n"); writeFileSync(join(dir, "tests", ".tox", "conftest.py"), "x = 1\n"); });
    expect(d.not_proven.some((n) => n.includes("tests/.tox/conftest.py"))).toBe(true); // named by the runner-config check or by the ignored-file check
    expect(d.not_proven.some((n) => n.includes("tests/.tox/.gitignore"))).toBe(true);
  }, 60_000);
  const cacheRepo = (): string => hidRepo({ "a.py": "x\n" });
  const withCache = (name: string, gi: string, extra: (cache: string) => void): string[] => {
    const dir = cacheRepo(), snap = ignoreSnapshot(dir), base = sh(dir, ["rev-parse", "HEAD"]), c = join(dir, name);
    mkdirSync(c, { recursive: true }); writeFileSync(join(c, ".gitignore"), gi); extra(c);
    return ignoreRuleChanges(dir, snap, base);
  };
  const PYTEST_GI = "# Created by pytest automatically.\n*\n";
  test("a pure .pytest_cache (pytest's own .gitignore, README, CACHEDIR.TAG, v/cache/nodeids) is silent; the same directory is noted when its .gitignore text differs, or it holds a python file, an executable, a symlink or a bin directory", () => {
    const pure = (c: string): void => { writeFileSync(join(c, "README.md"), "r\n"); writeFileSync(join(c, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n"); mkdirSync(join(c, "v", "cache"), { recursive: true }); writeFileSync(join(c, "v", "cache", "nodeids"), "[]"); };
    expect(withCache(".pytest_cache", PYTEST_GI, pure)).toEqual([]);
    expect(withCache(".pytest_cache", "*\n", pure).length).toBeGreaterThan(0);
    expect(withCache(".pytest_cache", PYTEST_GI + "!x\n", pure).length).toBeGreaterThan(0);
    expect(withCache(".pytest_cache", PYTEST_GI, (c) => writeFileSync(join(c, "helper.py"), "x = 1\n")).length).toBeGreaterThan(0);
    expect(withCache(".pytest_cache", PYTEST_GI, (c) => writeFileSync(join(c, "x.pth"), "/tmp\n")).length).toBeGreaterThan(0);
    expect(withCache(".pytest_cache", PYTEST_GI, (c) => { writeFileSync(join(c, "tool"), "#!/bin/sh\n"); chmodSync(join(c, "tool"), 0o755); }).length).toBeGreaterThan(0);
    expect(withCache(".pytest_cache", PYTEST_GI, (c) => symlinkSync("/usr/bin", join(c, "lnk"))).length).toBeGreaterThan(0);
    expect(withCache(".pytest_cache", PYTEST_GI, (c) => { mkdirSync(join(c, "bin")); writeFileSync(join(c, "bin", "x"), "x"); }).length).toBeGreaterThan(0);
    expect(withCache(".cache_other", PYTEST_GI, pure).length).toBeGreaterThan(0);
}, 60_000);
  // SEAL-ASSUME-02 r4: each exemption is the exact text a real run of that tool wrote (versions in check_result.ts), compared byte for byte.
  const REAL_GI: Record<string, string> = {
    ".pytest_cache": "# Created by pytest automatically.\n*\n",
    ".mypy_cache": "# Automatically created by mypy\n*\n",
    ".ruff_cache": "# Automatically created by ruff.\n*\n",
    ".hypothesis": "# This .gitignore file was automatically created by Hypothesis. Hypothesis gitignores\n# .hypothesis by default, because we generally recommend that .hypothesis not be checked\n# into version control.\n#\n# If you *would* like to check .hypothesis into version control, you should delete this\n# file. Hypothesis will not re-create this .gitignore unless .hypothesis is deleted (and\n# if it does, that's a bug - please report it!)\n\n*\n",
  };
  for (const [name, text] of Object.entries(REAL_GI)) {
    test(`SEAL-ASSUME-02 r4: ${name} with the tool's real .gitignore text is silent, and one changed byte is noted`, () => {
      expect(withCache(name, text, () => {})).toEqual([]);
      expect(withCache(name, text.replace("*\n", "!\n"), () => {}).length).toBeGreaterThan(0);
      expect(withCache(name, text + "\n", () => {}).length).toBeGreaterThan(0);
    }, 60_000);
  }
  test("SEAL-ASSUME-02 r4: a bare * .gitignore is never an exemption, whatever the directory is named (.hypothesis, .tox, .nox)", () => {
    for (const name of [".hypothesis", ".tox", ".nox"]) expect(withCache(name, "*\n", () => {}).length).toBeGreaterThan(0);
  }, 60_000);
  test("a failed listing refuses (git missing from PATH, then a corrupt .git/HEAD) and the intake snapshot records a failed listing as unrecorded", () => {
    const dir = hidRepo({ "a.py": "x\n" }), snap = ignoreSnapshot(dir), base = sh(dir, ["rev-parse", "HEAD"]);
    expect(ignoreRuleChanges(dir, snap, base)).toEqual([]); // control: the same call with git on PATH is silent
    const oldPath = process.env["PATH"];
    try { process.env["PATH"] = join(dir, "no-such-bin"); expect(ignoreRuleChanges(dir, snap, base).length).toBe(1); expect(ignoreSnapshot(dir).exec_files).toBeNull(); } finally { process.env["PATH"] = oldPath; }
    writeFileSync(join(dir, ".git", "HEAD"), "garbage\n");
    expect(ignoreRuleChanges(dir, snap, base).length).toBe(1);
    expect(ignoreRuleChanges(dir, { ...snap, exec_files: null }, base).length).toBe(1);
}, 60_000);
  test("info/exclude the user had before the run, untouched, honest fix: no ignore-rule note", async () => {
    const d = await verify(TWO, { "impl.py": "def double(x):\n    return x * 2\n" }, TASK, py("test_target.py"), py("test_old.py"), false, (dir) => appendFileSync(join(dir, ".git", "info", "exclude"), "scratch.txt\nconftest.py\n"));
    expect(d.not_proven.filter((n) => /ignore/.test(n))).toEqual([]);
  }, 60_000);
  test("a missing or unreadable ignore snapshot at verify refuses (fail closed); an unchanged snapshot is silent", () => {
    const dir = hidRepo({ "a.py": "x\n" });
    expect(ignoreRuleChanges(dir, ignoreSnapshot(dir))).toEqual([]);
    expect(ignoreRuleChanges(dir, undefined).length).toBe(1);
    expect(ignoreRuleChanges(dir, { at: 1, info_exclude: { path: "x", state: "unreadable" }, global_excludes: { path: "y", state: "missing" } }).length).toBe(1);
  });
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
  // SEAL-CONFTEST-01: a conftest.py listed in .git/info/exclude is invisible to the diff, yet it makes a NotImplementedError stub pass with no skip
  const STUB = { "impl.py": "def double(x):\n    raise NotImplementedError\n" }, EXCL = { ".git/info/exclude": "conftest.py\n" };
  const PATCH = "import impl\nimpl.double = lambda x: x * 2\n", STUB2 = { "impl.py": "def double(x):\n    raise NotImplementedError  # todo\n" };
  test("SEAL-CONFTEST-01: an excluded conftest.py the run creates is named, so the verdict cannot be VERIFIED", async () => {
    const d = await verify({ ...STUB, "test_target.py": TGT, "test_o.py": "def test_x():\n    assert True\n" }, { ...STUB2, "conftest.py": PATCH }, TASK, py("test_target.py"), py("test_o.py"), false, undefined, EXCL);
    expect(d.not_proven).toEqual(["test configuration changed: conftest.py"]);
  }, 60_000);
  test("SEAL-CONFTEST-01: an excluded conftest.py already present at intake and untouched is not a change", async () => {
    const d = await verify(TWO, { "impl.py": "def double(x):\n    return x * 2\n" }, TASK, py("test_target.py"), py("test_old.py"), false, undefined, { ...EXCL, "conftest.py": "import pytest\n" });
    expect(d.pre_red).toEqual(["test_old.py::test_old"]);
    expect(d.not_proven).toEqual([]);
  }, 60_000);
  // r2: what intake snapshots and verify compares; `pre` exists before the snapshot, `work` is the run. .venv/ is ignored by repo(); paths are written with their folders.
  const SP = ".venv/lib/python3.12/site-packages", rec = (c: string): string => createHash("sha256").update(c).digest("base64url");
  const hidden = (pre: Record<string, string>, work: Record<string, string>): string[] => {
    const dir = repo({ "a.py": "" }), put = (m: Record<string, string>): void => { for (const [f, c] of Object.entries(m)) { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), c); } };
    put(pre); const snap = hiddenRunnerConfigs(dir); put(work); return hiddenConfigChanged(dir, snap);
  };
  test("SEAL-CONFTEST-01: a conftest.py under a nested .gitignore or in vendor/ is a change; .loki/ and a .pth outside site-packages are not", () => {
    expect(hidden({ "sub/.gitignore": "*\n" }, { "sub/conftest.py": "x", "vendor/lib/conftest.py": "x", "model.pth": "w", ".loki/conftest.py": "" })).toEqual(["sub/conftest.py", "vendor/lib/conftest.py"]);
  });
  test("SEAL-CONFTEST-01: an npm-style install after intake (node_modules manifests, vendor/ and site-packages non-hook files) is not a change", () => {
    expect(hidden({}, { "node_modules/pkg/package.json": '{"scripts":{"test":"x"}}', "node_modules/pkg/tsconfig.json": "{}", "vendor/pkg/package.json": "{}", [`${SP}/pkg/pyproject.toml`]: "[tool.pytest.ini_options]\n", [`${SP}/pkg/sitecustomize.py`]: "" })).toEqual([]);
  });
  test("SEAL-CONFTEST-01: a pip-installed .pth whose RECORD lists its sha256 is not a change", () => {
    const pth = "/repo/src\n";
    expect(hidden({}, { [`${SP}/__editable__.pkg-0.1.pth`]: pth, [`${SP}/pkg-0.1.dist-info/RECORD`]: `pkg-0.1.dist-info/METADATA,sha256=x,1\n__editable__.pkg-0.1.pth,sha256=${rec(pth)},${pth.length}\n` })).toEqual([]);
  });
  test("SEAL-CONFTEST-01: a hand-written sitecustomize.py, or a .pth whose bytes differ from its RECORD entry, is a change", () => {
    expect(hidden({}, { [`${SP}/sitecustomize.py`]: "import impl\n" })).toEqual([`${SP}/sitecustomize.py`]);
    expect(hidden({}, { [`${SP}/__editable__.pkg-0.1.pth`]: "import evil\n", [`${SP}/pkg-0.1.dist-info/RECORD`]: `__editable__.pkg-0.1.pth,sha256=${rec("/repo/src\n")},10\n` })).toEqual([`${SP}/__editable__.pkg-0.1.pth`]);
  });
  test("SEAL-CONFTEST-01: the stock _virtualenv.pth is not a change; any other bytes in it are", () => {
    expect(hidden({}, { [`${SP}/_virtualenv.pth`]: "import _virtualenv", [`.venv/b/site-packages/_virtualenv.pth`]: "import _virtualenv\n" })).toEqual([]);
    expect(hidden({}, { [`${SP}/_virtualenv.pth`]: "import _virtualenv\nimport evil\n" })).toEqual([`${SP}/_virtualenv.pth`]);
  });
  test("SEAL-CONFTEST-01: a dist-info entry_points.txt with a [pytest11] section and no matching RECORD is a change; other entry points are not", () => {
    const ep = "[pytest11]\nplug = plug\n", f = `${SP}/plug-0.1.dist-info/entry_points.txt`;
    expect(hidden({}, { [f]: ep })).toEqual([f]);
    expect(hidden({}, { [f]: ep, [`${SP}/plug-0.1.dist-info/RECORD`]: `plug-0.1.dist-info/entry_points.txt,sha256=${rec("[console_scripts]\n")},18\n` })).toEqual([f]);
    expect(hidden({}, { [f]: ep, [`${SP}/plug-0.1.dist-info/RECORD`]: `plug-0.1.dist-info/entry_points.txt,sha256=${rec(ep)},${ep.length}\n` })).toEqual([]);
    expect(hidden({}, { [f]: "[console_scripts]\nplug = plug:main\n" })).toEqual([]);
  });
  // A real venv and pytest-plugin install during the run (offline, a wheel built here): uv when on PATH, else python3 -m venv with pip.
  test.skipIf(!Bun.which("python3"))("SEAL-CONFTEST-01: creating a venv and installing a pytest plugin wheel during the run is not a change", () => {
    const dir = repo({ "a.py": "" }), snap = hiddenRunnerConfigs(dir), env = { ...process.env, UV_CACHE_DIR: join(dir, ".venv", "uvcache"), UV_PYTHON_DOWNLOADS: "never", PIP_NO_INDEX: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
    const whl = join(dir, ".venv", "plug_x-0.1-py3-none-any.whl"), run = (c: string, a: string[]): string => execFileSync(c, a, { cwd: dir, env, encoding: "utf8" });
    run("python3", ["-I", "-c", `import base64,hashlib,sys,zipfile
fs={"plug_x/__init__.py":"def pytest_configure(config):\\n    pass\\n","plug_x-0.1.dist-info/METADATA":"Metadata-Version: 2.1\\nName: plug-x\\nVersion: 0.1\\n","plug_x-0.1.dist-info/WHEEL":"Wheel-Version: 1.0\\nGenerator: t\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n","plug_x-0.1.dist-info/entry_points.txt":"[pytest11]\\nplug_x = plug_x\\n"}
z=zipfile.ZipFile(sys.argv[1],"w");r=[n+",sha256="+base64.urlsafe_b64encode(hashlib.sha256(c.encode()).digest()).rstrip(b"=").decode()+","+str(len(c)) for n,c in fs.items()]
[z.writestr(n,c) for n,c in fs.items()];z.writestr("plug_x-0.1.dist-info/RECORD","\\n".join(r+["plug_x-0.1.dist-info/RECORD,,"])+"\\n");z.close()`, whl]);
    const uv = Bun.which("uv"), venv = join(dir, ".venv", "env");
    if (uv) { run(uv, ["venv", "-q", venv]); run(uv, ["pip", "install", "-q", "--offline", "--no-index", "--python", join(venv, "bin", "python"), whl]); }
    else { run("python3", ["-m", "venv", venv]); run(join(venv, "bin", "python"), ["-m", "pip", "install", "-q", "--no-index", whl]); }
    const files = execFileSync("git", ["ls-files", "-o"], { cwd: dir, encoding: "utf8" });
    expect(files).toContain("plug_x-0.1.dist-info/entry_points.txt");
    if (uv) expect(files).toContain("site-packages/_virtualenv.pth");
    expect(hiddenConfigChanged(dir, snap)).toEqual([]);
  }, 60_000);
  test("SEAL-CONFTEST-01: more than 5 changed hidden configs name 5, then the count", () => {
    expect(hidden({}, Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((i) => [`.venv/t${i}/conftest.py`, ""])))).toEqual([1, 2, 3, 4, 5].map((i) => `.venv/t${i}/conftest.py`).concat("(+2 more)"));
  });
});
