// FC-23: the Wall matches the package's module system, and a type error inside a Wall file is harness-owned (no fix round).
// FireLater#17 on 10.10.5: a Wall test with import.meta failed the package's own tsc (TS1470) and burned fix round 1.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWall, buildWallBrief, WALL_OUTPUT_BUDGET, WALL_REPO_PATHS } from "../../src/engine10/stages/wall.ts";
import { verifyStage } from "../../src/engine10/stages/verify.ts";
import { conventionViolation, conventionsBrief, outOfRepoTarget, phantomReason, misplacedNamedNotes, phantomRepoPaths, readPackageConventions, taskNamedPaths, topLevelSymbols, vacuousCheck } from "../../src/project_model/conventions.ts";
import { wallOwnedFailure } from "../../src/util/wall_owned.ts";
import { withoutStaleWall } from "../../src/util/check_result.ts";
import { RealTestMapProvider } from "../../src/engine10/testmap.ts";
import type { RunContext, SessionRunOptions, StageName } from "../../src/engine10/types.ts";

const REAL_NODE_MODULES = join(import.meta.dir, "..", "..", "node_modules");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mk = (): string => { const d = mkdtempSync(join(tmpdir(), "e10-fc23-")); dirs.push(d); return d; };
const git = (cwd: string, args: string[]): string => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: process.env });

function cjsRepo(extra: Record<string, string> = {}): string {
  const dir = mk();
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cjs-pkg", version: "1.0.0", scripts: { test: "jest" } }));
  writeFileSync(join(dir, "tsconfig.json"), `{\n  // CommonJS output\n  "compilerOptions": { "target": "ES2020", "module": "commonjs", "strict": true, "noEmit": true, "skipLibCheck": true, },\n  "include": ["*.ts", "src/*.ts", "tests/*.ts"]\n}\n`);
  for (const [n, c] of Object.entries(extra)) { mkdirSync(join(dir, n, ".."), { recursive: true }); writeFileSync(join(dir, n), c); }
  return dir;
}

function wallCtx(repoDir: string, onSession: (o: SessionRunOptions) => void): RunContext {
  const runDir = join(repoDir, ".loki", "runs", "e10-fc23");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "repomap.json"), JSON.stringify({ files: ["src/a.ts"], entries: [{ path: "src/a.ts", symbols: ["foo"] }], truncated: false }));
  return {
    runId: "e10-fc23", repoDir, runDir, baseSha: "HEAD", branch: "b", provider: "claude", model: "m", deep: false, capS: 900,
    emit: () => {},
    sessions: { run: async (o: SessionRunOptions) => { onSession(o); return { exit: 0, markers: { done: true, alreadyDone: null, specConflict: null }, durationS: 0.1, killed: false }; } },
    tests: { detect: async () => ({ runners: [], tests: [] }), impacted: () => [] },
    cost: { read: () => ({ usd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }) },
    clock: { now: () => 0 },
    outputs: () => ({ intake: { task: "add x", testmap: { runners: ["jest"], tests: [] }, repomap_ref: join(runDir, "repomap.json") } }) as Partial<Record<StageName, Record<string, unknown>>>,
  } as RunContext;
}

describe("FC-23 conventions reader (parser, not a guess)", () => {
  test("commonjs from JSONC tsconfig (comments, trailing comma) and no package type", () => {
    const c = readPackageConventions(cjsRepo());
    expect(c).toMatchObject({ moduleSystem: "commonjs", packageType: null, tsModule: "commonjs" });
  });
  test("type module with nodenext is esm; a relative extends is followed", () => {
    const dir = mk();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "esm-pkg", type: "module" }));
    writeFileSync(join(dir, "tsconfig.base.json"), JSON.stringify({ compilerOptions: { module: "NodeNext" } }));
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json" }));
    expect(readPackageConventions(dir)).toMatchObject({ moduleSystem: "esm", tsModule: "nodenext" });
  });
  test("import.meta in a comment or string is not a violation; real use is", () => {
    const c = readPackageConventions(cjsRepo());
    expect(conventionViolation(c, "a.test.ts", '// import.meta\nconst s = "import.meta";\n')).toBeNull();
    expect(conventionViolation(c, "a.test.ts", "const d = import.meta.dir;\n")).toContain("TS1470");
  });
});

describe("FC-23 Wall author matches the package", () => {
  test("CommonJS brief does not instruct require() in TypeScript (the package lint forbids it)", () => {
    const b = conventionsBrief(readPackageConventions(cjsRepo()));
    expect(b).toContain("CommonJS");
    expect(b).toContain("write import statements");
    expect(b).not.toContain("require() for paths and modules");
  });
  test("a CommonJS package: the brief carries the convention, and a Wall test with import.meta is discarded, not placed in the tree", async () => {
    const repoDir = cjsRepo();
    let brief = "";
    const ctx = wallCtx(repoDir, (o) => {
      brief = o.brief;
      writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), "import { foo } from './src/a';\nconst here = import.meta.dir;\ntest('x', () => { expect(foo(here)).toBe(1); });\n");
      writeFileSync(join(o.cwd!, "loki_wall_b.test.ts"), "const { foo } = require('./src/a');\ntest('y', () => { expect(foo(__dirname)).toBe(1); });\n");
    });
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 1, fail: 0 }) } });
    expect(brief).toContain("CommonJS");
    expect(brief).toContain("Never use import.meta");
    expect(existsSync(join(repoDir, "tests", "loki_wall_a.test.ts"))).toBe(false);
    expect(existsSync(join(repoDir, "tests", "loki_wall_b.test.ts"))).toBe(true);
    expect((r.data.discarded as { file: string; reason: string }[]).map((d) => d.file)).toEqual(["loki_wall_a.test.ts"]);
    expect((r.data.discarded as { reason: string }[])[0]!.reason).toContain("wall test did not compile under the package config");
    expect((r.data.base_run as { not_run: number }).not_run).toBe(1);
    expect(r.data.already_satisfied).toBe(false);
    expect(readFileSync(join(ctx.runDir, "wall", "loki_wall_a.test.ts"), "utf8")).toContain("import.meta");
  });

  test("an ES module package gets the ESM convention and keeps its import.meta file", async () => {
    const repoDir = mk();
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "esm-pkg", type: "module" }));
    writeFileSync(join(repoDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "esnext" } }));
    let brief = "";
    const ctx = wallCtx(repoDir, (o) => { brief = o.brief; writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), "const d = import.meta.dir;\n"); });
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 1, fail: 0 }) } });
    expect(brief).toContain("ES modules");
    expect(r.data.discarded).toBeUndefined();
  });
});

describe("FC-23 a type error inside a Wall file is harness-owned", () => {
  function verifyRepo(userSrc: string): { ctx: RunContext } {
    const repoDir = cjsRepo({ "src/a.ts": "export const foo = 1;\n" });
    symlinkSync(REAL_NODE_MODULES, join(repoDir, "node_modules"));
    writeFileSync(join(repoDir, ".gitignore"), "node_modules\n.loki\n");
    git(repoDir, ["init", "-q"]); git(repoDir, ["add", "."]); git(repoDir, ["commit", "-qm", "base"]);
    const base = git(repoDir, ["rev-parse", "HEAD"]).trim();
    mkdirSync(join(repoDir, "tests"), { recursive: true });
    writeFileSync(join(repoDir, "tests", "loki_wall_a.ts"), "export const here = import.meta.dir;\n"); // TS1470 under module commonjs
    if (userSrc) writeFileSync(join(repoDir, "src", "b.ts"), userSrc);
    const ctx = wallCtx(repoDir, () => {});
    ctx.baseSha = base;
    ctx.outputs = () => ({ wall: { files: [{ path: join(repoDir, "tests", "loki_wall_a.ts") }] } }) as Partial<Record<StageName, Record<string, unknown>>>;
    return { ctx };
  }

  test("only the Wall file fails tsc: zero grouped failures (no fix round), NOT PROVEN with the reason, owner harness", async () => {
    const { ctx } = verifyRepo("");
    const r = await verifyStage.run(ctx, new AbortController().signal);
    const tsc = (r.data.checks as { name: string; result: string; reason?: string; owner?: string }[]).find((c) => c.name === "lint:tsc");
    expect(tsc).toMatchObject({ result: "not_run", reason: "wall test did not compile under the package config", owner: "harness" });
    expect(r.data.failures_grouped).toEqual([]);
    expect((r.data.not_proven as string[]).some((n) => n.includes("wall test did not compile under the package config"))).toBe(true);
  }, 60_000);

  test("control: a type error in user code still fails and gets a fix round", async () => {
    const { ctx } = verifyRepo('export const n: number = "not a number";\n');
    const r = await verifyStage.run(ctx, new AbortController().signal);
    const tsc = (r.data.checks as { name: string; result: string }[]).find((c) => c.name === "lint:tsc");
    expect(tsc?.result).toBe("fail");
    expect((r.data.failures_grouped as { signature: string }[]).some((g) => g.signature.startsWith("lint:tsc"))).toBe(true);
  }, 60_000);

  test("location parser: mixed Wall and user locations are not harness-owned; an unlocated error never is", () => {
    const wall = new Set(["tests/loki_wall_a.ts"]);
    expect(wallOwnedFailure("tests/loki_wall_a.ts(1,20): error TS1470: x", "/r", "/r", wall)).toBe(true);
    expect(wallOwnedFailure("tests/loki_wall_a.ts(1,20): error TS1470: x\nsrc/b.ts(1,1): error TS2322: y", "/r", "/r", wall)).toBe(false);
    expect(wallOwnedFailure("error TS5083: Cannot read file tsconfig.json", "/r", "/r", wall)).toBe(false);
    expect(wallOwnedFailure("/r/tests/loki_wall_a.ts\n  3:1  error  no-undef  x", "/r", "/r", wall)).toBe(true);
    expect(wallOwnedFailure("", "/r", "/r", wall)).toBe(false);
  });
});

describe("COST-14 Wall brief output budget", () => {
  test("brief carries the budget line ahead of run-specific text", () => {
    const b = buildWallBrief("add x", "src/a.ts", ["jest"], false, "", ["a1"]);
    expect(b).toContain(WALL_OUTPUT_BUDGET);
    expect(b).toContain("one test file");
    expect(b).toContain("no closing summary");
    expect(b.indexOf(WALL_OUTPUT_BUDGET)).toBeLessThan(b.indexOf("add x"));
  });
});

describe("FC-WALL-OUT-OF-REPO-TARGET", () => {
  const INSTALLED = "const t = process.env.PLUGIN_DIR ?? join(homedir(), '.claude/plugins/x/y');\ntest('a', () => { expect(t).toBeTruthy(); });\n";
  test("detector: home-derived values that locate code are rejected; repo-relative and tmpdir pass", () => {
    expect(outOfRepoTarget(INSTALLED)).not.toBeNull();
    expect(outOfRepoTarget("const p = join(process.env.HOME!, '.claude', 'x');")).not.toBeNull();
    expect(outOfRepoTarget("const m = await import(join(homedir(), 'x', 'y.ts'));")).not.toBeNull();
    expect(outOfRepoTarget("p = Path.home() / '.config' / 'x'")).not.toBeNull();
    expect(outOfRepoTarget("const p = join(import.meta.dir, '..', 'plugins', 'a', 'b');")).toBeNull();
    expect(outOfRepoTarget("const d = mkdtempSync(join(tmpdir(), 'fx-'));")).toBeNull();
    expect(outOfRepoTarget("// was homedir() before\nconst p = './src/a';")).toBeNull();
  });
  test("detector negatives: sandboxed HOME, expect/assert comparisons, shell and pytest home checks pass", () => {
    expect(outOfRepoTarget("process.env.HOME = d;\nexpect(configPath()).toBe(join(d, '.app'));")).toBeNull(); // A
    expect(outOfRepoTarget("expect(expandPath('~/foo')).toBe(join(d, 'foo'));")).toBeNull(); // C
    expect(outOfRepoTarget("expect(normalize('/home/user/x')).toBe('/home/user/x');")).toBeNull(); // D
    expect(outOfRepoTarget("def test_x(monkeypatch):\n    monkeypatch.setenv('HOME', str(tmp_path))\n    assert os.path.expanduser('~') == str(tmp_path)\n    p = os.path.join(os.path.expanduser('~'), '.config')\n")).toBeNull(); // E
    expect(outOfRepoTarget('HOME="$(mktemp -d)"; export HOME\n./bin/loki init\n[ -f "$HOME/.loki/config" ]\n')).toBeNull(); // F
  });
  test("literal import target flagged: a quoted absolute home path that is the direct import/require/source target", () => {
    expect(outOfRepoTarget('import { f } from "/Users/someone/.claude/plugins/x/f.ts";')).not.toBeNull();
    expect(outOfRepoTarget('import "/home/dev/app/setup.ts";')).not.toBeNull();
    expect(outOfRepoTarget("const m = await import('/home/dev/app/f.ts');")).not.toBeNull();
    expect(outOfRepoTarget("const m = require('/root/app/f.js');")).not.toBeNull();
    expect(outOfRepoTarget('source /home/dev/app/lib.sh')).not.toBeNull();
    expect(outOfRepoTarget('. "/home/dev/app/lib.sh"')).not.toBeNull();
    expect(outOfRepoTarget('import { f } from "C:\\Users\\dev\\f.ts";')).not.toBeNull();
    expect(outOfRepoTarget('const p = "/home/user/project/.git";')).toBeNull();
    expect(outOfRepoTarget('const d = "/Users/dev/app";\nrun(d);')).toBeNull();
    expect(outOfRepoTarget('process.env.HOME = d;\nimport { f } from "/Users/x/f.ts";')).toBeNull();
    expect(outOfRepoTarget('expect(x).toBe(require("/home/a/b"));')).toBeNull();
  });
  test("literal path not flagged: an absolute literal with no home-derived value passes; homedir joins still flag", () => {
    expect(outOfRepoTarget("const p = join('/home/user/project', '.git');")).toBeNull();
    expect(outOfRepoTarget("const g = '/Users/dev/app/.git';\nexec(g);")).toBeNull();
    expect(outOfRepoTarget("const p = join(homedir(), '.git');")).not.toBeNull();
  });
  test("home exemption scoped: homedir() joined before a HOME assignment still flags; after it passes", () => {
    expect(outOfRepoTarget("const p = join(homedir(), '.claude', 'x');\nprocess.env.HOME = d;")).not.toBeNull();
    expect(outOfRepoTarget("process.env.HOME = d;\nconst p = join(homedir(), '.claude', 'x');")).toBeNull();
  });
  test("brief tells the writer to use repo-relative paths", () => {
    const b = buildWallBrief("t"), at = b.indexOf(WALL_REPO_PATHS);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(b.indexOf("t\n") === -1 ? b.length : b.indexOf("Repository paths") === -1 ? b.length : b.indexOf("Repository paths")); // static prefix, before run-specific text
  });
  test("a Wall file targeting the home dir is re-asked once with the reason; the rewrite is kept", async () => {
    const repoDir = cjsRepo(); const briefs: string[] = [];
    const ctx = wallCtx(repoDir, (o) => {
      briefs.push(o.brief);
      writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), briefs.length === 1 ? INSTALLED : "import { foo } from '../src/a';\ntest('x', () => { expect(foo()).toBe(1); });\n");
    });
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 0, fail: 1 }) } });
    expect(briefs.length).toBe(2);
    expect(briefs[1]).toContain("loki_wall_a.test.ts");
    expect(briefs[1]).toContain("outside the repo");
    expect(r.data.discarded).toBeUndefined();
  });
  test("a file still out-of-repo after the rewrite is discarded, never installed", async () => {
    const repoDir = cjsRepo(); let n = 0;
    const ctx = wallCtx(repoDir, (o) => { n++; writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), INSTALLED); });
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 0, fail: 1 }) } });
    expect(n).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(repoDir, "tests", "loki_wall_a.test.ts"))).toBe(false);
    expect(JSON.stringify(r.data.discarded)).toContain("outside the repo");
  });
  test("a clean repo-relative file triggers no extra session", async () => {
    const repoDir = cjsRepo({ "plugins/a/x.sh": "echo\n" }); let n = 0;
    const ctx = wallCtx(repoDir, (o) => { n++; writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), "const p = join(__dirname, '..', 'plugins', 'a');\ntest('x', () => { expect(p).toBeTruthy(); });\n"); });
    await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 0, fail: 1 }) } });
    expect(n).toBe(1);
  });
  test("re-ask respects budget: no rewrite session at the cap (file discarded); still re-asked while budget remains", async () => {
    for (const over of [true, false]) {
      const repoDir = cjsRepo(); let n = 0;
      const ctx = wallCtx(repoDir, (o) => { if (o.iterationId?.endsWith("-oor")) n++; writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), INSTALLED); });
      ctx.overCap = () => over;
      const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 0, fail: 1 }) } });
      expect(n > 0).toBe(!over); // counts only the -oor rewrite sessions
      expect(JSON.stringify(r.data.discarded)).toContain("outside the repo");
    }
  });
});

describe("TEN-MOAT-26 vacuous check", () => {
  const VACUOUS = "import { foo } from '../src/a';\ntest('x', () => { expect(true).toBe(true); });\n";
  const REAL = "import { foo } from '../src/a';\ntest('x', () => { expect(foo()).toBe(1); });\n";
  test("vacuous check rejected: detector flags assertion-free and tautological files, passes real ones", () => {
    expect(vacuousCheck("loki_wall_a.test.ts", VACUOUS)).toContain("asserts nothing");
    expect(vacuousCheck("loki_wall_a.test.ts", "test('x', () => {});\n")).toContain("asserts nothing");
    expect(vacuousCheck("loki_wall_a.test.ts", "test('x', () => { foo(); });\n")).toBeNull(); // no assertion but a real call: can be red by throwing
    expect(vacuousCheck("loki_wall_a.test.ts", "test('x', () => { assert(true); });\n")).toContain("asserts nothing");
    expect(vacuousCheck("loki_wall_a.test.ts", "// expect(foo()).toBe(1)\ntest('x', () => {});\n")).toContain("asserts nothing");
    expect(vacuousCheck("loki_wall_a.test.ts", REAL)).toBeNull();
    expect(vacuousCheck("loki_wall_a.test.ts", "test('x', () => { expect(p).toBeTruthy(); });\n")).toBeNull();
    expect(vacuousCheck("loki_wall_a.sh", "#!/bin/bash\nset -e\ntrue\nexit 0\n")).toContain("asserts nothing");
    expect(vacuousCheck("loki_wall_a.sh", "#!/bin/bash\nset -e\n[ \"$(foo)\" = 1 ] || exit 1\nexit 0\n")).toBeNull();
    expect(vacuousCheck("loki_wall_a.py", "def test_x():\n    assert True\n")).toContain("asserts nothing");
    expect(vacuousCheck("loki_wall_a.py", "def test_x():\n    assert foo() == 1\n")).toBeNull();
    expect(vacuousCheck("loki_wall_a_test.go", "func TestX(t *testing.T) {}\n")).toContain("asserts nothing");
    expect(vacuousCheck("loki_wall_a_test.go", "func TestX(t *testing.T) { if foo() != 1 { t.Errorf(\"bad\") } }\n")).toBeNull();
    expect(vacuousCheck("loki_wall_a.txt", "anything")).toBeNull();
  });
  const SH = (body: string): string | null => vacuousCheck("loki_wall_a.sh", `#!/bin/bash\nset -e\n${body}\n`);
  test("vacuous shell: always-true forms are rejected", () => {
    for (const body of ["echo ok", "echo \"all good\"", "printf 'ok\\n'", "test 1", "[ 1 ]", "[[ 1 ]]", "[ \"x\" ]", "test foo", "true && true", ": ; exit 0", "/bin/true", "/usr/bin/true", "echo ok && exit 0", "echo a\necho b"]) expect([body, SH(body)]).toEqual([body, expect.stringContaining("asserts nothing")]);
  });
  test("vacuous shell: any real command is never flagged", () => {
    for (const body of ["grep -q foo src/a.ts", "test -f src/a.ts", "test -f a && grep -q x a", "[ -d src ]", "[ \"$(foo)\" = 1 ]", "[ \"$X\" ]", "echo ok && grep -q x a", "echo ok | grep -q y", "echo ok > out.txt", "echo $(foo)", "bun test tests/a.test.ts", "diff a b", "cmp a b", "node a.js", "python a.py", "pytest t", "npm test", "curl -f http://x", "./scripts/check.sh", "true && test -f a", "test 1 -eq 2", "[ 1 -eq 2 ]", "exit 1", "false"]) expect([body, SH(body)]).toEqual([body, null]);
  });
  test("vacuous other languages: truthy-literal and trivial forms are rejected, real ones kept", () => {
    expect(vacuousCheck("a.test.ts", "test('x', () => { expect(1).toBeTruthy(); });\n")).toContain("asserts nothing");
    expect(vacuousCheck("a.test.ts", "test('x', () => { expect('ok').toBeDefined(); });\n")).toContain("asserts nothing");
    expect(vacuousCheck("a.test.ts", "test('x', () => { expect(foo()).toBeTruthy(); });\n")).toBeNull();
    expect(vacuousCheck("a.py", "def test_x():\n    assert 1 == 1\n")).toContain("asserts nothing");
    expect(vacuousCheck("a.py", "def test_x():\n    assert \"ok\"\n")).toContain("asserts nothing");
    expect(vacuousCheck("a.py", "def test_x(self):\n    self.assertEqual(1, 1)\n")).toContain("asserts nothing");
    expect(vacuousCheck("a.py", "def test_x():\n    assert foo() == 1\n")).toBeNull();
    expect(vacuousCheck("a.py", "def test_x(self):\n    self.assertEqual(foo(), 1)\n")).toBeNull();
    expect(vacuousCheck("a_test.go", "func TestX(t *testing.T) { t.Log(\"ok\") }\n")).toContain("asserts nothing");
    expect(vacuousCheck("a_test.go", "func TestX(t *testing.T) { if foo() != 1 { t.Log(\"x\") } }\n")).toBeNull();
  });
  test("vacuous go: judged per file, mixed files are kept", () => {
    expect(vacuousCheck("a_test.go", "func TestA(t *testing.T) { t.Skip(\"x\") }\nfunc TestB(t *testing.T) { if foo() != 1 { t.Fatal(\"x\") } }\n")).toBeNull();
    expect(vacuousCheck("a_test.go", "func TestA(t *testing.T) { t.Log(\"x\") }\nfunc TestB(t *testing.T) { if foo() != 1 { t.Errorf(\"x\") } }\n")).toBeNull();
    expect(vacuousCheck("a_test.go", "func TestA(t *testing.T) { t.Log(\"x\") }\nfunc TestB(t *testing.T) { t.Skip() }\n")).toContain("asserts nothing");
    expect(vacuousCheck("a_test.go", "func TestA(t *testing.T) { foo() }\n")).toBeNull();
    expect(vacuousCheck("a_test.go", "func TestA(t *testing.T) { t.Skip() }\nfunc TestB(t *testing.T) { t.Fatal(\"x\") }\n")).toBeNull(); // a brace-free failing body
    expect(vacuousCheck("a_test.go", "func helper(t *testing.T) { t.Fatal(\"x\") }\nfunc TestA(t *testing.T) { t.Log(\"x\") }\n")).toBeNull(); // a failing helper in the file keeps it
  });
  test("vacuous: pathological whitespace stays linear (64KB under 200ms)", () => {
    const sp = " ".repeat(32000);
    for (const [name, body] of [["a_test.go", `func TestA(t *testing.T) {${sp}t.Log("x")${sp}x}\n`], ["a.sh", `${sp}echo${sp}\n`], ["a.py", `def test_x():\n    assert${sp}True${sp}\n`], ["a.py", `assert 1${sp}x\n`], ["a.py", `assert 1${sp},${sp}x\n`], ["a.test.ts", `test('x', () => {${sp}expect(1)${sp}.toBe(1)${sp}});\n`]] as const) {
      const t0 = performance.now(); vacuousCheck(name, body); expect([name, performance.now() - t0 < 200]).toEqual([name, true]);
    }
  });
  test("vacuous js: tautology and real expect on one line is kept", () => {
    expect(vacuousCheck("a.test.ts", "test('x', () => { expect(true).toBe(true); expect(foo()).toBe(1); });\n")).toBeNull();
    expect(vacuousCheck("a.test.ts", "test('x', () => { expect(true).toBe(true); expect(1).toBe(1); });\n")).toContain("asserts nothing");
  });
  test("vacuous check rejected: a vacuous Wall file is re-asked once with the reason; the rewrite is kept", async () => {
    const repoDir = cjsRepo(); const briefs: string[] = [];
    const ctx = wallCtx(repoDir, (o) => { briefs.push(o.brief); writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), briefs.length === 1 ? VACUOUS : REAL); });
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 0, fail: 1 }) } });
    expect(briefs.length).toBe(2);
    expect(briefs[1]).toContain("asserts nothing");
    expect(r.data.discarded).toBeUndefined();
  });
  test("vacuous check rejected: still vacuous after the rewrite is discarded, never installed", async () => {
    const repoDir = cjsRepo();
    const ctx = wallCtx(repoDir, (o) => { writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), VACUOUS); });
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 1, fail: 0 }) } });
    expect(existsSync(join(repoDir, "tests", "loki_wall_a.test.ts"))).toBe(false);
    expect(JSON.stringify(r.data.discarded)).toContain("asserts nothing");
  });
});

// Header and helpers of the Wall file loki 11.17.77 wrote for anthropics/claude-code#81826 (run e10-20261019T064138Z-a7ca; base tree ef7bfdc has no plugins/ralph-loop).
const REAL_81826 = 'import { test, expect } from \'bun:test\';\\nimport { spawnSync } from \'node:child_process\';\\nimport { mkdtempSync, existsSync, readFileSync, writeFileSync } from \'node:fs\';\\nimport { tmpdir } from \'node:os\';\\nimport { join } from \'node:path\';\\n\\nconst ROOT = process.env.REPO_ROOT ?? process.cwd();\\nconst PLUGIN = join(ROOT, \'plugins\', \'ralph-loop\');\\nconst SETUP = join(PLUGIN, \'scripts\', \'setup-ralph-loop.sh\');\\nconst HOOK = join(PLUGIN, \'hooks\', \'stop-hook.sh\');\\nconst STATE = join(\'.claude\', \'ralph-loop.local.md\');\\n\\nconst env: Record<string, string> = { ...(process.env as Record<string, string>) };\\ndelete env.CLAUDE_CODE_SESSION_ID;\\n\\nfunction freshDir(): string {\\n  const dir = mkdtempSync(join(tmpdir(), \'loki-wall-ralph-\'));\\n  writeFileSync(join(dir, \'t.jsonl\'),\\n    \'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"still working"}]}}\\\n\');\\n  return dir;\\n}\\n\\nfunction setup(dir: string, value: string) {\\n  return spawnSync(\'bash\', [SETUP, \'do\', \'the\', \'task\', \'--max-iterations\', value],\\n    { cwd: dir, env, encoding: \'utf8\' });\\n}\\n\\nfunction hook(dir: string) {\\n  return spawnSync(\'bash\', [HOOK], {\\n    cwd: dir,\\n    env,\\n    encoding: \'utf8\',\\n    input: JSON.stringify({ session_id: \'s1\', transcript_path: join(dir, \'t.jsonl\') }),\\n  });\\n}\\n\\nfunction stateExists(dir: string): boolean {\\n  return existsSync(join(dir, STATE));\\n}\\n\\nfunction rounds(dir: string, n: number): void {\\n  for (let i = 0; i < n; i++) {\\n    if (!stateExists(dir)) break;\\n    hook(dir);\\n  }';
describe("Go Wall that never references the package under test", () => {
  // Every row compiles and passes under a real `go test` (GOPROXY=off, GOTOOLCHAIN=local) against a package x with Foo, Double, foo and Parse; vacuous rows are the ones a green run proves nothing for.
  const MSG = "never references the package under test";
  const rows: [string, string, boolean][] = [
    ["ext-vac", "package x_test\n\nimport (\n\t\"testing\"\n\t_ \"example.com/m/x\"\n)\n\nfunc TestA(t *testing.T) {\n\tif 1+1 != 2 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["ext-ok", "package x_test\n\nimport (\n\t\"testing\"\n\t\"example.com/m/x\"\n)\n\nfunc TestA(t *testing.T) {\n\tif x.Foo() != 2 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", false],
    ["ext-alias-ok", "package x_test\n\nimport (\n\t\"testing\"\n\talias \"example.com/m/x\"\n)\n\nfunc TestA(t *testing.T) {\n\tif alias.Foo() != 2 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", false],
    ["ext-comment", "package x_test\n\nimport (\n\t\"testing\"\n\t_ \"example.com/m/x\"\n)\n\nfunc TestA(t *testing.T) {\n\t// x.Foo()\n\ts := \"x.Foo()\"\n\tif s == \"\" {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["ext-dot-ok", "package x_test\n\nimport (\n\t\"testing\"\n\t. \"example.com/m/x\"\n)\n\nfunc TestA(t *testing.T) {\n\tif Foo() != 2 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", false],
    ["E2-rawstring", "package x_test\n\nimport (\n\t\"testing\"\n\t_ \"example.com/m/x\"\n)\n\nvar s = `\n. \"fmt\"\n`\n\nfunc TestA(t *testing.T) {\n\tif len(s) < 0 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["E2b-blockcomment", "package x_test\n\nimport (\n\t\"testing\"\n\t_ \"example.com/m/x\"\n)\n\n/*\n. \"fmt\"\n*/\n\nfunc TestA(t *testing.T) {\n\tif 1 > 2 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["int-vac", "package x\n\nimport \"testing\"\n\nconst want = 3\n\nfunc TestA(t *testing.T) {\n\tgot := 3\n\tif got != want {\n\t\tt.Fatalf(\"bad %d\", got)\n\t}\n}\n", true],
    ["int-ok", "package x\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\tif foo() != 3 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", false],
    ["int-comment", "package x\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\t// foo() is great\n\tn := 3\n\tif n != 3 {\n\t\tt.Fatal(\"foo()\")\n\t}\n}\n", true],
    ["int-table-vac", "package x\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\ttests := []struct {\n\t\tname string\n\t\tin   int\n\t}{\n\t\t{name: \"a\", in: 1},\n\t}\n\tfor _, tt := range tests {\n\t\tt.Run(tt.name, func(t *testing.T) {\n\t\t\tif tt.in+1 != 2 {\n\t\t\t\tt.Fatal(\"bad\")\n\t\t\t}\n\t\t})\n\t}\n}\n", true],
    ["int-table-ok", "package x\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\ttests := []struct {\n\t\tname string\n\t\tin   int\n\t}{\n\t\t{name: \"a\", in: 1},\n\t}\n\tfor _, tt := range tests {\n\t\tt.Run(tt.name, func(t *testing.T) {\n\t\t\tif Double(tt.in) != 2 {\n\t\t\t\tt.Fatal(\"bad\")\n\t\t\t}\n\t\t})\n\t}\n}\n", false],
    ["E1-dot-unrelated", "package x\n\nimport (\n\t\"testing\"\n\t. \"strings\"\n)\n\nfunc TestA(t *testing.T) {\n\tif ToUpper(\"a\") != \"A\" {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["dot-int-ok", "package x\n\nimport (\n\t\"testing\"\n\t. \"strings\"\n)\n\nfunc TestA(t *testing.T) {\n\tif foo(ToUpper(\"a\")) != 1 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", false],
    ["E3-shared-params", "package x\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\tf := func(a, b int) int { return a + b }\n\tif f(1, 2) != 3 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["E4-named-result", "package x\n\nimport \"testing\"\n\nfunc two() (n int) {\n\tn = 2\n\treturn\n}\n\nfunc TestA(t *testing.T) {\n\tif two() != 2 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["E5-type-param", "package x\n\nimport \"testing\"\n\nfunc id[T any](v T) T { return v }\n\nfunc TestA(t *testing.T) {\n\tif id(1) != 1 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["E5b-type-params", "package x\n\nimport \"testing\"\n\nfunc pick[K comparable, V any](k K, v V) V { return v }\n\nfunc TestA(t *testing.T) {\n\tif pick(\"a\", 1) != 1 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["E12-multi-var", "package x\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\tvar a, b = 1, 2\n\tif a+b != 3 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["E13-multi-const", "package x\n\nimport \"testing\"\n\nconst a, b = 1, 2\n\nfunc TestA(t *testing.T) {\n\tif a+b != 3 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["E13b-const-block", "package x\n\nimport \"testing\"\n\nconst (\n\ta, b = 1, 2\n\tc    = 3\n)\n\nfunc TestA(t *testing.T) {\n\tif a+b != c {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["fuzz-vac", "package x\n\nimport \"testing\"\n\nfunc FuzzA(f *testing.F) {\n\tf.Add(\"x\")\n\tf.Fuzz(func(t *testing.T, s string) {\n\t\tif len(s) < 0 {\n\t\t\tt.Fatal(\"bad\")\n\t\t}\n\t})\n}\n", true],
    ["fuzz-ok", "package x\n\nimport \"testing\"\n\nfunc FuzzA(f *testing.F) {\n\tf.Add(\"x\")\n\tf.Fuzz(func(t *testing.T, s string) {\n\t\tif Parse(s) < 0 {\n\t\t\tt.Fatal(\"bad\")\n\t\t}\n\t})\n}\n", false],
    ["R6-go-prefix-module", "package thing_test\n\nimport (\n\t\"testing\"\n\t\"example.com/go-thing\"\n)\n\nfunc TestA(t *testing.T) {\n\tif thing.Foo() != 2 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", false],
    ["R7-import-comment", "package x_test\n\nimport (\n\t\"testing\"\n\t\"example.com/m/x\" // package under test\n)\n\nfunc TestA(t *testing.T) {\n\tif x.Foo() != 2 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", false],
    ["R10-comment-in-string", "package x\n\nimport \"testing\"\n\nfunc TestA(t *testing.T) {\n\tu := \"http://a/*b\"\n\tif Parse(u) != 3 {\n\t\tt.Fatal(\"*/\")\n\t}\n}\n", false],
    ["ext-dot-unrelated", "package x_test\n\nimport (\n\t\"testing\"\n\t. \"strings\"\n\t_ \"example.com/m/x\"\n)\n\nfunc TestA(t *testing.T) {\n\tif ToUpper(\"a\") != \"A\" {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["go-prefix-pkg-only", "package config\n\nimport (\n\t\"testing\"\n\t\"github.com/goccy/go-yaml\"\n)\n\nfunc TestA(t *testing.T) {\n\tvar v int\n\tif err := yaml.Unmarshal(nil, &v); err != nil {\n\t\tt.Fatal(err)\n\t}\n}\n", true],
    ["go-prefix-pkg-calls-own", "package config\n\nimport (\n\t\"testing\"\n\t\"github.com/goccy/go-yaml\"\n)\n\nfunc TestA(t *testing.T) {\n\tvar v int\n\tif err := Decode(nil, &v); err != nil || yaml.X != 0 {\n\t\tt.Fatal(err)\n\t}\n}\n", false],
    ["suffix-go-pkg-only", "package config\n\nimport (\n\t\"testing\"\n\t\"example.com/foo-go\"\n)\n\nfunc TestA(t *testing.T) {\n\tif foo.Bar() != 1 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["major-version-pkg-only", "package config\n\nimport (\n\t\"testing\"\n\t\"example.com/x/foo/v2\"\n)\n\nfunc TestA(t *testing.T) {\n\tif foo.Bar() != 1 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true],
    ["type-param-struct", "package x\n\nimport \"testing\"\n\ntype box[T any] struct {\n\tv T\n}\n\nfunc TestA(t *testing.T) {\n\tb := box[int]{v: 1}\n\tif b.v != 1 {\n\t\tt.Fatal(\"bad\")\n\t}\n}\n", true]
  ];
  for (const [name, src, vacuous] of rows) test(`${vacuous ? "vacuous" : "real"}: ${name}`, () => {
    const r = vacuousCheck("a_test.go", src);
    if (vacuous) expect(r).toContain(MSG); else expect(r).toBeNull();
  });
  test("a file with no package clause or no Test or Fuzz func is not judged", () => {
    expect(vacuousCheck("a_test.go", `func TestA(t *testing.T) { if 1 != 2 { t.Fatal("x") } }\n`)).toBeNull();
    expect(vacuousCheck("a_test.go", `package x\n\nfunc helper() int { return 1 }\n`)).toBeNull();
  });
});

describe("FC-WALL-PHANTOM-PATH", () => {
  const PHANTOM = "const ROOT = join(__dirname, '..');\nconst PLUGIN = join(ROOT, 'plugins', 'ralph-loop');\nconst SH = join(PLUGIN, 'scripts', 'setup-ralph-loop.sh');\ntest('a', () => { expect(spawnSync('bash', [SH]).status).toBe(0); });\n";
  const FIXED = "const SH = join(__dirname, '..', 'plugins', 'ralph-wiggum', 'scripts', 'setup-ralph-loop.sh');\ntest('a', () => { expect(spawnSync('bash', [SH]).status).toBe(0); });\n";
  const repoWith = (): string => cjsRepo({ "plugins/ralph-wiggum/scripts/setup-ralph-loop.sh": "echo\n" });
  test("detector: a missing repo path is reported, an existing one passes, a path the plan creates passes", () => {
    const repo = repoWith(), td = join(repo, "tests");
    expect(phantomRepoPaths(PHANTOM, "a.test.ts", td, repo, null)).toContain("plugins/ralph-loop");
    expect(phantomRepoPaths(FIXED, "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths(PHANTOM, "a.test.ts", td, repo, "Create plugins/ralph-loop/scripts/setup-ralph-loop.sh and plugins/ralph-loop")).toEqual([]);
    expect(phantomRepoPaths("const p = join(process.cwd(), 'src', 'a.ts');", "a.test.ts", td, repo, null)).toEqual(["src/a.ts"]);
  });
  test("detector negatives: write/expect/tmp lines, the test's own dir, non-JS files and node_modules are ignored", () => {
    const repo = repoWith(), td = join(repo, "tests"); execFileSync("git", ["init", "-q"], { cwd: repo }); writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    expect(phantomRepoPaths("writeFileSync(join(__dirname, '..', 'out', 'x.txt'), 'a');", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("expect(existsSync(join(__dirname, '..', 'gone'))).toBe(false);", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const f = join(__dirname, 'fixtures', 'a.json');", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const f = join(__dirname, '..', 'node_modules', 'x');", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths(PHANTOM, "a.py", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths('const cfg = join(import.meta.dir, "config.yaml");\nBun.write(cfg, "x");', "a.test.ts", td, repo, null, "Create config.yaml")).toEqual([]);
  });
  test("task-named file beside the test file (greenfield sh-rotate Wall) is reported, at its true root path or as an unnamed fixture it is not", () => {
    const repo = cjsRepo(), td = join(repo, "tests"), task = "Write rotate.sh that rotates log files and also see docs/guide.md";
    const wall = (expr: string): string => `import { join } from "node:path";\nconst SCRIPT = ${expr};\ntest("a", () => { expect(spawnSync("bash", [SCRIPT]).status).toBe(0); });\n`;
    const name = "loki_wall_rotate.test.ts";
    expect(phantomRepoPaths(wall('join(import.meta.dir, "rotate.sh")'), name, td, repo, null, task)).toEqual(["tests/rotate.sh"]);
    expect(phantomRepoPaths(wall('join(__dirname, "docs", "guide.md")'), name, td, repo, null, task)).toEqual(["tests/docs/guide.md"]);
    expect(phantomRepoPaths(wall('join(import.meta.dir, "..", "rotate.sh")'), name, td, repo, null, task)).toEqual([]);
    expect(phantomRepoPaths(wall('join(process.cwd(), "rotate.sh")'), name, td, repo, null, task)).toEqual([]);
    expect(phantomRepoPaths(wall('join(import.meta.dir, "fixture.log")'), name, td, repo, null, task)).toEqual([]);
    expect(phantomRepoPaths(wall('join(import.meta.dir, "rotate.sh")'), name, td, repo, null, "Add a rotate script")).toEqual([]);
    expect(phantomReason(["tests/rotate.sh"], [], "tests", "", task)).toContain("task names rotate.sh");
  });
  test("taskNamedPaths ignores prose tokens (e.g, i.e, Node.js) and keeps real file names", () => {
    expect(taskNamedPaths("Use a loop (e.g. find, i.e. not ls) on Node.js to write rotate.sh and ./lib/x.py")).toEqual(["rotate.sh", "lib/x.py"]);
    expect(misplacedNamedNotes("e.g. foo, i.e. bar, Node.js", [":000000 100644 0 0 A", "tests/e.g", ":000000 100644 0 0 A", "tests/Node.js"], "/nonexistent", "HEAD")).toEqual([]);
  });
  test("misplacedNamedNotes fires only for a test-directory copy of a non-test name the task does not locate", () => {
    const add = (f: string): string[] => [":000000 100644 0 0 A", f], note = (task: string, f: string): string[] => misplacedNamedNotes(task, add(f), "/nonexistent", "HEAD");
    expect(note("Write rotate.sh", "tests/rotate.sh")).toEqual(["task names rotate.sh but it exists only at tests/rotate.sh"]);
    expect(note("Write rotate.sh", "cmd/server/rotate.sh")).toEqual([]);
    expect(note("Add test_utils.py", "tests/test_utils.py")).toEqual([]);
    expect(note("Add conftest.py", "tests/conftest.py")).toEqual([]);
    expect(note("Add util_test.go and x.test.ts", "tests/util_test.go")).toEqual([]);
    expect(note("Write rotate.sh and keep fixtures in tests/", "tests/rotate.sh")).toEqual([]);
    expect(note("Write rotate.sh inside the tests directory", "tests/rotate.sh")).toEqual([]);
    expect(note("Write rotate.sh and keep fixtures in tests", "tests/rotate.sh")).toEqual(["task names rotate.sh but it exists only at tests/rotate.sh"]);
    for (const t of ["Create calc.py with an add(a, b) function and add tests.", "Create calc.py with add(a, b), with unit tests.", "Create calc.py with add(a, b); put the tests in tests/.", "Create calc.py with add(a, b) and test it.", "Create calc.py with add(a, b), put the tests under the tests directory"]) expect(note(t, "tests/calc.py")).toEqual(["task names calc.py but it exists only at tests/calc.py"]);
    expect(note("Write calc.rb per the spec below.", "spec/calc.rb")).toEqual(["task names calc.rb but it exists only at spec/calc.rb"]);
    expect(note("Write calc.py in tests/ and put the tests in tests/", "tests/calc.py")).toEqual([]);
  });
  test("topLevelSymbols reads definitions by shape and ignores stubs, docstrings and comments", () => {
    const syms = (s: string): string[] => [...topLevelSymbols(s)].sort();
    expect(syms("def add(a, b):\n    return a + b\n")).toEqual(["add"]);
    expect(syms("pass\n")).toEqual([]);
    expect(syms('"""calc"""\n')).toEqual([]);
    expect(syms('"""calc\n\ndef add(a, b)\n"""\n')).toEqual([]);
    expect(syms("export {};\n'use strict';\n")).toEqual([]);
    expect(syms("package main\nfunc main() {}\n")).toEqual([]);
    expect(syms("package main\nfunc Add(a, b int) int { return a + b }\nfunc (c Calc) Sub() {}\n")).toEqual(["Add", "Sub"]);
    expect(syms("export function add() {}\nexport const sub = 1;\nmodule.exports = { mul, div as quot };\n")).toEqual(["add", "mul", "quot", "sub"]);
    expect(syms("  def nested():\n    pass\n# def commented():\n")).toEqual([]);
  });
  test("taskNamedPaths keeps capitalised app files and drops only framework names", () => {
    expect(taskNamedPaths("Write App.js, Server.js and Button.js at the repo root")).toEqual(["App.js", "Server.js", "Button.js"]);
    expect(taskNamedPaths("Use Node.js, Vue.js, Next.js, Nuxt.js, Express.js, Three.js, D3.js and Chart.js")).toEqual([]);
    expect(taskNamedPaths("Create socket.js that handles connections, chart.js, electron.js and express.js, no Node.js")).toEqual(["socket.js", "chart.js", "electron.js", "express.js"]);
  });
  test("taskNamedPaths: a capitalised product-shaped name is a file unless the prose evidence is direct", () => {
    for (const [t, f] of [["Fix Button.js", "Button.js"], ["Fix the crash in Server.js", "Server.js"], ["Update the handler in App.js", "App.js"], ["App.js must render the list", "App.js"], ["Move App.js to the repo root", "App.js"], ["Change App.js to export default", "App.js"], ["The entry point is App.js at the repo root", "App.js"], ["Write the tests for App.js", "App.js"], ["Refactor Server.js", "Server.js"], ["Server.js should listen on PORT", "Server.js"], ["Put the component in Button.js", "Button.js"], ["Create a counter in App.js", "App.js"], ["Debug Server.js", "Server.js"], ["Implement the API in Server.js using Express", "Server.js"], ["Use App.js as the entry point", "App.js"], ["using Server.js as the entry", "Server.js"]] as const) expect([t, taskNamedPaths(t)]).toEqual([t, [f]]);
    expect(taskNamedPaths("ThisArrOnly.js:3|literal rows assigned to this._phases\nHelperReturnThisSink.js:3|'getPhases' returns rows")).toEqual(["ThisArrOnly.js", "HelperReturnThisSink.js"]);
    for (const t of ["Build a tiny Node.js CLI named `greet`", "Write Node.js code", "Create a Node.js script", "Build a Next.js app", "Use Next.js", "using Node.js to run it", "use Express.js for routing", "PostgreSQL with Knex.js for migrations, real-time board via Socket.io", "Use Knex.js and Svelte.js with Fly.io", "Build a single Node.js file named `retry.js`"]) expect([t, taskNamedPaths(t).filter((n) => /^[A-Z]/.test(n))]).toEqual([t, []]);
    expect(taskNamedPaths("Build a single Node.js file named `retry.js` that exports one function")).toEqual(["retry.js"]);
    expect(taskNamedPaths("Create Knex.js and add Widget.js next to lib/Other.js")).toEqual(["Knex.js", "Widget.js", "lib/Other.js"]);
  });
  test("a task naming Server.js while the run only added tests/Server.js still gets the misplaced note", () => {
    expect(misplacedNamedNotes("Fix the crash in Server.js", [":000000 100644 0 0 A", "tests/Server.js"], "/nonexistent", "HEAD")).toEqual(["task names Server.js but it exists only at tests/Server.js"]);
  });
  test("a Bun.write target is still a created path through the generic write call", () => {
    const td = mkdtempSync(join(tmpdir(), "wp-bw-"));
    try { expect(phantomRepoPaths('const cfg = join(import.meta.dir, "out.yaml");\nBun.write(cfg, "x");', "a.test.ts", td, td, null)).toEqual([]); } finally { rmSync(td, { recursive: true, force: true }); }
  });
  test("monorepo: process.cwd() paths resolve against the nearest package root of the test file and the repo root", () => {
    const repo = repoWith(); mkdirSync(join(repo, "packages/a/test"), { recursive: true }); mkdirSync(join(repo, "packages/a/src"), { recursive: true });
    writeFileSync(join(repo, "packages/a/package.json"), '{"name":"a","version":"1.0.0"}'); writeFileSync(join(repo, "packages/a/src/x.ts"), "x\n");
    const td = join(repo, "packages/a/test"), code = "const f = join(process.cwd(), 'src', 'x.ts');";
    expect(phantomRepoPaths(code, "x.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const f = join(process.cwd(), 'plugins', 'ralph-wiggum');", "x.test.ts", td, repo, null)).toEqual([]); // exists under the repo root
    expect(phantomRepoPaths("const f = join(process.cwd(), 'src', 'nope.ts');", "x.test.ts", td, repo, null)).toHaveLength(1);
  });
  describe("model-known root", () => {
    const cmd = (cwd: string) => ({ cmd: "npx vitest run", cwd, cite: [`${cwd}/package.json`] });
    const mpkg = (name: string) => ({ name, root: name, runner: "vitest", cite: [`${name}/package.json`], commands: { test: cmd(name), lint: null, build: null, start: null }, ui: { present: false, boot: null, cite: [`${name}/package.json`] } });
    const savedModel = process.env["LOKI_E10_PROJECT_MODEL"];
    afterEach(() => { if (savedModel === undefined) delete process.env["LOKI_E10_PROJECT_MODEL"]; else process.env["LOKI_E10_PROJECT_MODEL"] = savedModel; });
    // packages a and b exist on disk with a manifest; the cached model lists only `listed`
    const modelRepo = (listed: string[]): string => {
      process.env["LOKI_E10_PROJECT_MODEL"] = "1";
      const repo = mk();
      for (const n of ["a", "b", "c"]) { mkdirSync(join(repo, n, "test"), { recursive: true }); writeFileSync(join(repo, n, "package.json"), `{"name":"${n}","version":"1.0.0"}`); }
      mkdirSync(join(repo, "b/src"), { recursive: true }); writeFileSync(join(repo, "b/src/y.ts"), "y\n");
      mkdirSync(join(repo, "a/src"), { recursive: true }); writeFileSync(join(repo, "a/src/x.ts"), "x\n");
      const model = { schema: "loki.v10.project/1", status: "ok", key: "k", workspaceKind: "multi-root", workspaceCite: ["a/package.json"], packages: listed.map(mpkg), fingerprintFiles: ["a/package.json"] };
      mkdirSync(join(repo, ".loki"), { recursive: true }); writeFileSync(join(repo, ".loki", "project.json"), JSON.stringify(model));
      return repo;
    };
    test("stale multi-root model omitting the test's package: verify runs at the repo root, so a path existing only under the package is reported", () => {
      const repo = modelRepo(["a", "c"]);
      expect(phantomRepoPaths("const f = join(process.cwd(), 'src', 'y.ts');", "y.test.ts", join(repo, "b/test"), repo, null)).toEqual(["src/y.ts"]);
    });
    test("multi-root model listing the test's package: the path under that package cwd is not reported", () => {
      const repo = modelRepo(["a", "b"]);
      expect(phantomRepoPaths("const f = join(process.cwd(), 'src', 'y.ts');", "y.test.ts", join(repo, "b/test"), repo, null)).toEqual([]);
    });
  });
  test("a const-bound path the test later creates is not phantom", () => {
    const repo = repoWith(), td = join(repo, "tests");
    expect(phantomRepoPaths("const OUT = join(__dirname, '..', 'build-out');\nmkdirSync(OUT, { recursive: true });\nwriteFileSync(join(OUT, 'a.txt'), 'x');", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const OUT = join(__dirname, '..', 'gen');\nawait fs.mkdir(OUT);", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const OUT = join(__dirname, '..', 'gen');\nconst DST = join(__dirname, '..', 'copy');\ncpSync(OUT, DST);", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const OUT = join(__dirname, '..', 'gen');\nexpect(OUT).toBeTruthy();", "a.test.ts", td, repo, null)).toEqual(["gen"]);
  });
  test("a path the repo git-ignores is not phantom", () => {
    const repo = repoWith(), td = join(repo, "tests");
    execFileSync("git", ["init", "-q"], { cwd: repo }); writeFileSync(join(repo, ".gitignore"), ".next/\nout/\n");
    expect(phantomRepoPaths("const f = join(__dirname, '..', '.next', 'server', 'a.js');", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const f = join(__dirname, '..', 'out', 'a.js');", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const f = join(__dirname, '..', 'src', 'a.js');", "a.test.ts", td, repo, null)).toEqual(["src/a.js"]);
  });
  test("walk-up phantom: a join on a loop base seeded from cwd or the test dir is checked against the repo (run e10-20261019T121849Z-848d)", () => {
    const WALK = (leaf: string): string => "import { existsSync, mkdtempSync } from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport { dirname, join, resolve } from 'node:path';\nfunction pluginDir(): string {\n  for (const start of [process.cwd(), import.meta.dir]) {\n    let dir = resolve(start);\n    while (true) {\n      const candidate = join(dir, 'plugins', '" + leaf + "');\n      if (existsSync(join(candidate, 'scripts', 'setup-ralph-loop.sh'))) return candidate;\n      const parent = dirname(dir);\n      if (parent === dir) break;\n      dir = parent;\n    }\n  }\n  throw new Error('plugins/ralph-loop not found at or above cwd');\n}\n";
    const repo = repoWith(), td = join(repo, "tests");
    expect(phantomRepoPaths(WALK("ralph-loop"), "w.test.ts", td, repo, null)).toEqual(["plugins/ralph-loop"]);
    expect(phantomRepoPaths(WALK("ralph-loop"), "w.test.ts", repo, repo, null)).toEqual(["plugins/ralph-loop"]);
    expect(phantomRepoPaths(WALK("ralph-loop"), "w.test.ts", td, repo, "Create plugins/ralph-loop")).toEqual([]);
    expect(phantomRepoPaths(WALK("ralph-wiggum"), "w.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths(WALK("ralph-loop").replace("'plugins'", "'nowhere'"), "w.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const d = mkdtempSync(join(tmpdir(), 'x-'));\nconst f = join(d, 'plugins', 'ralph-loop');", "w.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const base = join(tmpdir(), 'x');\nfor (const s of [base]) { let dir = resolve(s); const c = join(dir, 'plugins', 'ralph-loop'); }", "w.test.ts", td, repo, null)).toEqual([]);
  });
  test("walk-up phantom: a loop over a repo-relative string is not a walk-up (FP-A)", () => {
    const repo = repoWith(), td = join(repo, "tests"); mkdirSync(join(repo, "scripts"), { recursive: true });
    const SETUP = " {\n  const setup = join(plugin, 'scripts', 'setup-ralph-loop.sh');\n}";
    expect(phantomRepoPaths("for (const plugin of ['plugins/ralph-wiggum'])" + SETUP, "w.test.ts", td, repo, null)).toEqual([]); // FP-A
  });
  test("walk-up phantom: a loop over a join on cwd is not a walk-up (FP-B)", () => {
    const repo = repoWith(), td = join(repo, "tests"); mkdirSync(join(repo, "scripts"), { recursive: true });
    const SETUP = " {\n  const setup = join(plugin, 'scripts', 'setup-ralph-loop.sh');\n}";
    expect(phantomRepoPaths("for (const plugin of [join(process.cwd(), 'plugins', 'ralph-wiggum')])" + SETUP, "w.test.ts", td, repo, null)).toEqual([]); // FP-B
  });
  test("walk-up phantom: a loop over several joins on an unresolved root is not a walk-up (FP-C)", () => {
    const repo = repoWith(), td = join(repo, "tests"); mkdirSync(join(repo, "scripts"), { recursive: true }); mkdirSync(join(repo, "plugins/hookify"), { recursive: true });
    const SETUP = " {\n  const setup = join(plugin, 'scripts', 'setup-ralph-loop.sh');\n}";
    expect(phantomRepoPaths("const ROOT = process.cwd();\nfor (const plugin of [join(ROOT, 'plugins', 'ralph-wiggum'), join(ROOT, 'plugins', 'hookify')])" + SETUP, "w.test.ts", td, repo, null)).toEqual([]); // FP-C
  });
  test("walk-up phantom: a walk-up whose file exists at a directory on the way up is not reported (FP-D2)", () => {
    const repo = repoWith(), td = join(repo, "tests"); mkdirSync(join(repo, "scripts"), { recursive: true });
    const walk = "for (const start of [process.cwd(), import.meta.dir]) {\n  let dir = resolve(start);\n  while (true) {\n    const s = join(dir, 'scripts', 'setup-ralph-loop.sh');\n    dir = dirname(dir);\n  }\n}\n";
    expect(phantomRepoPaths(walk, "w.test.ts", join(repo, "plugins/ralph-wiggum/tests"), repo, null)).toEqual([]); // FP-D2
  });
  test("package root fallback: a named manifest above the test dir is the cwd; a fixture json in the test dir is not; the incident still reports", () => {
    const repo0 = repoWith(); execFileSync("git", ["init", "-q"], { cwd: repo0 });
    for (const [p, c] of Object.entries({ "packages/a/package.json": '{"name":"a","version":"1"}', "packages/a/src/x.ts": "x\n", "packages/a/test/user.json": '{"name":"bob","age":3}' })) { mkdirSync(join(repo0, p, ".."), { recursive: true }); writeFileSync(join(repo0, p), c); }
    expect(phantomRepoPaths("const f = join(process.cwd(), 'src', 'x.ts');", "x.test.ts", join(repo0, "packages/a/test"), repo0, null)).toEqual([]);
    const r = repoWith();
    expect(phantomRepoPaths("const p = resolve(import.meta.dir, '..', 'plugins/ralph-loop');", "x.test.ts", join(r, "tests"), r, null)).toEqual(["plugins/ralph-loop"]);
  });
  test("fallback no false root: an unrelated config file near the test never hides a real phantom", () => {
    const code = "const f = join(process.cwd(), 'fixtures/a.json');";
    const cases: Record<string, Record<string, string>> = {
      "tests/tsconfig.json": { "tests/tsconfig.json": '{"compilerOptions":{}}' },
      "tests/.eslintrc.json": { "tests/.eslintrc.json": '{"extends":"x","rules":{}}' },
      "tests/phpunit.xml": { "tests/phpunit.xml": "<phpunit/>" },
      "tests/setup.cfg": { "tests/setup.cfg": "[tool:pytest]\n" },
      "root toml + web/tsconfig.json": { "pyproject.toml": "[project]\n", "tests/web/tsconfig.json": '{"compilerOptions":{}}' },
    };
    for (const [name, files] of Object.entries(cases)) {
      const repo = repoWith(); execFileSync("git", ["init", "-q"], { cwd: repo });
      for (const [p, c] of Object.entries({ ...files, "tests/fixtures/a.json": "[]" })) { mkdirSync(join(repo, p, ".."), { recursive: true }); writeFileSync(join(repo, p), c); }
      mkdirSync(join(repo, "tests/unit"), { recursive: true });
      expect([name, phantomRepoPaths(code, "x.test.ts", join(repo, "tests/unit"), repo, null)]).toEqual([name, ["fixtures/a.json"]]);
    }
    const repo = repoWith(); execFileSync("git", ["init", "-q"], { cwd: repo });
    for (const [p, c] of Object.entries({ "src/tsconfig.json": '{"compilerOptions":{}}', "src/plugins/ralph-loop/a.sh": "x\n" })) { mkdirSync(join(repo, p, ".."), { recursive: true }); writeFileSync(join(repo, p), c); }
    mkdirSync(join(repo, "src/t"), { recursive: true });
    expect(phantomRepoPaths("const p = join(process.cwd(), 'plugins/ralph-loop');", "x.test.ts", join(repo, "src/t"), repo, null)).toEqual(["plugins/ralph-loop"]);
  });
  test("modules dir phantom: an ignored vendor dir is exempt by the ignore check alone, a look-alike source dir is still reported", () => {
    const repo = repoWith(), td = join(repo, "tests");
    execFileSync("git", ["init", "-q"], { cwd: repo }); writeFileSync(join(repo, ".gitignore"), "web_modules/\nnode_modules/\n");
    for (const s of ["my_modules", "feature_modules"]) expect(phantomRepoPaths(`const p = resolve(import.meta.dir, '..', 'src', '${s}', 'x');`, "x.test.ts", td, repo, null)).toEqual([`src/${s}/x`]);
    expect(phantomRepoPaths("const p = resolve(import.meta.dir, '..', 'node_modules', 'x');", "x.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const p = resolve(import.meta.dir, '..', 'web_modules', 'x');", "x.test.ts", td, repo, null)).toEqual([]); // git-ignored
  });
  test("a plan clears a path only when it names the path with its parent, never a bare segment or basename", () => {
    const repo = repoWith(), td = join(repo, "tests"), code = "const f = join(__dirname, '..', 'src', 'newmod', 'index.ts');";
    expect(phantomRepoPaths(code, "a.test.ts", td, repo, null)).toEqual(["src/newmod/index.ts"]);
    expect(phantomRepoPaths(code, "a.test.ts", td, repo, "Introduce src/newmod with an entry point")).toEqual([]);
    expect(phantomRepoPaths(code, "a.test.ts", td, repo, "Introduce a newmod module with an entry point")).toEqual(["src/newmod/index.ts"]);
    for (const plan of ["Fix the ralph-loop plugin's setup script", "ralph-loop: --max-iterations 08 must be decimal", "Edit setup-ralph-loop.sh under plugins/ralph-wiggum/"]) expect(phantomRepoPaths(PHANTOM, "a.test.ts", td, repo, plan)).toContain("plugins/ralph-loop");
  });
  test("monorepo: a call that exists under the repo root does not shift the pairing of a later phantom", () => {
    const repo = repoWith(); mkdirSync(join(repo, "packages/a/test"), { recursive: true }); mkdirSync(join(repo, "test/helpers"), { recursive: true });
    writeFileSync(join(repo, "packages/a/package.json"), '{"name":"a","version":"1.0.0"}');
    const td = join(repo, "packages/a/test");
    expect(phantomRepoPaths("const h = join(process.cwd(), 'test', 'helpers');\nconst p = join(__dirname, '..', '..', '..', 'plugins', 'ralph-loop');", "x.test.ts", td, repo, null)).toEqual(["plugins/ralph-loop"]);
  });
  test("the real #81826 Wall file (env override of the cwd) reports plugins/ralph-loop", () => {
    const repo = repoWith(), td = join(repo, "tests");
    const real = REAL_81826.replace(/\\n/g, "\n");
    expect(phantomRepoPaths(real, "loki_wall_ralph_max_iterations.test.ts", td, repo, null)[0]).toBe("plugins/ralph-loop");
    expect(phantomRepoPaths("const R = process.env.X || process.cwd();\nconst P = join(R, 'plugins', 'ralph-wiggum');", "a.test.ts", td, repo, null)).toEqual([]);
  });
  test("a Prettier-split join() call is caught; fileURLToPath(new URL('..', import.meta.url)) anchors like __dirname", () => {
    const repo = repoWith(), td = join(repo, "tests");
    expect(phantomRepoPaths("const f = join(\n  __dirname,\n  '..',\n  'plugins',\n  'ralph-loop',\n);", "a.test.ts", td, repo, null)).toEqual(["plugins/ralph-loop"]);
    expect(phantomRepoPaths("const f =\n  join(__dirname, '..', 'plugins', 'ralph-loop');", "a.test.ts", td, repo, null)).toEqual(["plugins/ralph-loop"]);
    expect(phantomRepoPaths("const ROOT = fileURLToPath(new URL('..', import.meta.url));\nconst f = join(ROOT, 'plugins', 'ralph-loop');", "a.test.ts", td, repo, null)).toEqual(["plugins/ralph-loop"]);
    expect(phantomRepoPaths("const ROOT = fileURLToPath(new URL('..', import.meta.url));\nconst f = join(ROOT, 'plugins', 'ralph-wiggum');", "a.test.ts", td, repo, null)).toEqual([]);
  });
  test("in-testdir phantom: a path under the test dir whose first segment only exists at the repo root is reported", () => {
    const repo = repoWith(), td = join(repo, "tests");
    mkdirSync(td, { recursive: true }); mkdirSync(join(td, "fixtures"), { recursive: true });
    const inc = "const PLUGIN = resolve(import.meta.dir, 'plugins/ralph-loop');\nconst SETUP = join(PLUGIN, 'scripts/setup-ralph-loop.sh');\n";
    expect(phantomRepoPaths(inc, "loki_wall_ralph_loop_max_iterations.test.ts", td, repo, null)[0]).toBe("tests/plugins/ralph-loop");
    expect(phantomRepoPaths(inc, "a.test.ts", td, repo, "Create tests/plugins/ralph-loop")).toEqual([]);
    expect(phantomRepoPaths("const P = resolve(import.meta.dir, 'plugins/ralph-wiggum');", "a.test.ts", td, repo, null)).toEqual(["tests/plugins/ralph-wiggum"]);
    expect(phantomRepoPaths("const P = join(import.meta.dir, 'fixtures', 'a.json');", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const P = join(import.meta.dir, 'fixtures', 'a.json');\nconst Q = join(import.meta.dir, 'plugins', 'x');\nmkdirSync(Q);", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const P = fileURLToPath(import.meta.url);\nconst Q = join(P, 'plugins');", "a.test.ts", td, repo, null)).toEqual([]);
  });
  test("same-name hint works for a missing directory", () => {
    const why = phantomReason(["plugins/ralph-loop"], ["some/other/ralph-loop/run.sh", "x/y.ts"]);
    expect(why).toContain("plugins/ralph-loop (a path named ralph-loop exists at some/other/ralph-loop)");
    expect(phantomReason([], [])).toBeNull();
  });
  test("wallAuthor wiring: a Wall resolving the task-named rotate.sh beside the test is re-asked with the named-path reason; the root-path rewrite is kept", async () => {
    const repoDir = cjsRepo(); const briefs: string[] = [];
    const ctx = wallCtx(repoDir, (o) => { briefs.push(o.brief); writeFileSync(join(o.cwd!, "loki_wall_rotate.test.ts"), `const S = join(__dirname, ${briefs.length === 1 ? "" : "'..', "}'rotate.sh');\ntest('x', () => { expect(S).toBeTruthy(); });\n`); });
    const base = ctx.outputs; ctx.outputs = () => ({ ...base(), intake: { ...(base().intake as Record<string, unknown>), task: "Write `rotate.sh DIR KEEP` in bash that keeps the KEEP newest files" } }) as never;
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 0, fail: 1 }) } });
    expect(briefs.length).toBe(2);
    expect(briefs[1]).toContain("task names rotate.sh");
    expect(r.data.discarded).toBeUndefined();
  });
  test("a phantom path is re-asked once with the reason and the nearest real file; the rewrite is kept", async () => {
    const repoDir = repoWith(); const briefs: string[] = [];
    const ctx = wallCtx(repoDir, (o) => { briefs.push(o.brief); writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), briefs.length === 1 ? PHANTOM : FIXED); });
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 0, fail: 1 }) } });
    expect(briefs.length).toBe(2);
    expect(briefs[1]).toContain("plugins/ralph-loop");
    expect(briefs[1]).toContain("do not exist in the repository");
    expect(r.data.discarded).toBeUndefined();
  });
  test("a path the plan creates is not re-asked", async () => {
    const repoDir = repoWith(); let n = 0;
    const ctx = wallCtx(repoDir, (o) => { n++; writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), PHANTOM); });
    const base = ctx.outputs;
    ctx.outputs = () => ({ ...base(), plan: { plan: "Add plugins/ralph-loop and plugins/ralph-loop/scripts/setup-ralph-loop.sh" } }) as ReturnType<typeof base>;
    await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 0, fail: 1 }) } });
    expect(n).toBe(1);
  });
  test("still phantom after the rewrite: discarded, never installed", async () => {
    const repoDir = repoWith();
    const ctx = wallCtx(repoDir, (o) => { writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), PHANTOM); });
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 0, fail: 1 }) } });
    expect(existsSync(join(repoDir, "tests", "loki_wall_a.test.ts"))).toBe(false);
    expect(JSON.stringify(r.data.discarded)).toContain("do not exist");
  });
});

describe("FC-WALL-LOCATION-BLIND (run e10-20261019T130749Z-f11c, FireLater#20)", () => {
  // Modelled on the run: the author thought its file sits at the repo root (root = __dirname); Loki installs it in backend/src/lib.
  const BLIND = "import { describe, test, expect } from 'vitest';\nimport * as path from 'path';\n// Repository root: this file lives at the repo root, next to backend/ and frontend/.\nconst root = __dirname;\nconst B = path.join(root, 'backend', 'src');\nconst F = path.join(root, 'frontend', 'src');\ntest('a', () => { expect(B).toBeTruthy(); expect(F).toBeTruthy(); });\n";
  const FIXED_LOC = "const root = require('path').join(__dirname, '..', '..', '..');";
  const fl = (): string => cjsRepo({ "backend/package.json": '{"name":"backend","version":"1.0.0"}', "backend/src/lib/x.test.ts": "x\n", "backend/src/index.ts": "x\n", "frontend/package.json": '{"name":"frontend","version":"1.0.0"}', "frontend/src/app.ts": "x\n" });
  const flCtx = (repoDir: string, onSession: (o: SessionRunOptions) => void): RunContext => {
    const ctx = wallCtx(repoDir, onSession); const rm = join(ctx.runDir, "repomap.json");
    writeFileSync(rm, JSON.stringify({ files: ["backend/src/lib/x.test.ts", "backend/src/index.ts", "frontend/src/app.ts"], entries: [], truncated: false }));
    ctx.outputs = () => ({ intake: { task: "add x", testmap: { runners: ["vitest"], tests: [{ runner: "vitest", path: "backend/src/lib/x.test.ts" }] }, repomap_ref: rm } }) as Partial<Record<StageName, Record<string, unknown>>>;
    return ctx;
  };
  test("(a) the brief states the destination directory and what __dirname resolves to", () => {
    const b = buildWallBrief("t", "", [], false, "", [], "backend/src/lib");
    expect(b).toContain("backend/src/lib/"); expect(b).toContain("__dirname"); expect(b).toContain("import.meta.dir");
    expect(buildWallBrief("t", "", [], false, "", [], null)).toBe(buildWallBrief("t")); // no location: byte-identical
    expect(buildWallBrief("t", "", [], false, "", [], "")).toContain("copied to the repository root");
  });
  test("(a) the first author brief carries the destination derived from the placement logic", async () => {
    const briefs: string[] = []; const repoDir = fl();
    await runWall(flCtx(repoDir, (o) => { briefs.push(o.brief); }), new AbortController().signal, { baseRunner: { run: () => ({ pass: 0, fail: 1 }) } });
    expect(briefs[0]).toContain("is copied to backend/src/lib/"); expect(briefs[0]).toContain("__dirname");
  });
  test("(b) phantomReason names the cause when the phantom is the test dir joined with a real root path", () => {
    const files = ["backend/src/lib/x.test.ts", "backend/src/index.ts", "frontend/src/app.ts"];
    const why = phantomReason(["backend/src/lib/backend/src", "backend/src/lib/frontend/src"], files, "backend/src/lib", "backend")!;
    expect(why).toContain("backend/src/lib/"); expect(why).toContain("not the repo root"); expect(why).toContain("backend/src exists relative to the repo root"); expect(why).toContain("frontend/src exists relative to the repo root");
    expect(phantomReason(["backend/src/lib/nope"], files, "backend/src/lib", "backend")).not.toContain("not the repo root"); // control: no real root path, generic text
  });
  test("(b) the re-ask for the run's file names the cause; the rewrite that fixes the location is kept", async () => {
    const briefs: string[] = []; const repoDir = fl();
    const ctx = flCtx(repoDir, (o) => { briefs.push(o.brief); writeFileSync(join(o.cwd!, "loki_wall_a.test.ts"), briefs.length === 1 ? BLIND : BLIND.replace("const root = __dirname;", FIXED_LOC)); });
    const r = await runWall(ctx, new AbortController().signal, { baseRunner: { run: () => ({ pass: 0, fail: 1 }) } });
    expect(briefs.length).toBe(2);
    expect(briefs[1]).toContain("not the repo root"); expect(briefs[1]).toContain("backend/src exists relative to the repo root");
    expect(r.data.discarded).toBeUndefined();
  });
  const baseRepo = (): string => {
    const repoDir = cjsRepo({ "src/a.ts": "export const foo = 1;\n" });
    writeFileSync(join(repoDir, ".gitignore"), "node_modules\n.loki\n");
    git(repoDir, ["init", "-q"]); git(repoDir, ["add", "."]); git(repoDir, ["commit", "-qm", "base"]);
    return repoDir;
  };
  test("(c) a stale loki_wall_* file left untracked by an earlier run is never verified or credited when this run's Wall discarded it", async () => {
    const repoDir = baseRepo();
    mkdirSync(join(repoDir, "src", "lib"), { recursive: true });
    writeFileSync(join(repoDir, "src", "lib", "loki_wall_old.test.ts"), "test('x', () => {});\n"); writeFileSync(join(repoDir, "src", "b.ts"), "export const b = 1;\n");
    const ctx = wallCtx(repoDir, () => {}); ctx.baseSha = git(repoDir, ["rev-parse", "HEAD"]).trim();
    ctx.outputs = () => ({ wall: { files: [], discarded: [{ file: "loki_wall_old.test.ts", reason: "x" }] } }) as Partial<Record<StageName, Record<string, unknown>>>;
    const r = await verifyStage.run(ctx, new AbortController().signal);
    expect(r.data.changed_files).toEqual(["src/b.ts"]);
    expect(JSON.stringify(r.data.checks)).not.toContain("loki_wall_old");
  }, 60_000);
  test("(c) this run's own installed Wall file still counts as changed", async () => {
    const repoDir = baseRepo();
    writeFileSync(join(repoDir, "src", "loki_wall_new.test.ts"), "test('x', () => {});\n");
    const ctx = wallCtx(repoDir, () => {}); ctx.baseSha = git(repoDir, ["rev-parse", "HEAD"]).trim();
    ctx.outputs = () => ({ wall: { files: [{ path: join(repoDir, "src", "loki_wall_new.test.ts") }] } }) as Partial<Record<StageName, Record<string, unknown>>>;
    const r = await verifyStage.run(ctx, new AbortController().signal);
    expect(r.data.changed_files).toEqual(["src/loki_wall_new.test.ts"]);
  }, 60_000);
});

describe("FC-WALL-LOCATION-BLIND review round 2", () => {
  const fl2 = (): string => cjsRepo({ "backend/package.json": '{"name":"backend","version":"1.0.0"}', "backend/src/lib/x.ts": "x\n", "backend/src/index.ts": "x\n" });
  const FILES = ["backend/src/lib/x.ts", "backend/src/index.ts"];
  test("(b) package-root case: names the package root where the path really exists", () => {
    const why = phantomReason(["backend/src/lib/src"], ["backend/src/index.ts", "backend/src/lib/x.ts"], "backend/src/lib", "backend")!;
    expect(why).toContain("src exists relative to the package root backend/"); expect(why).not.toContain("src exists relative to the repo root");
  });
  test("(b) mixed phantoms: a location mistake and a real typo are both reported", () => {
    const why = phantomReason(["backend/src/lib/backend/src", "backend/src/lib/nope"], ["backend/src/index.ts", "backend/src/lib/x.ts"], "backend/src/lib", "")!;
    expect(why).toContain("not the repo root"); expect(why).toContain("do not exist in the repository"); expect(why).toContain("backend/src/lib/nope");
    expect(why.split("do not exist in the repository")[1]).not.toContain("backend/src/lib/backend/src");
  });
  test("(a) repo-root destination is stated; unknown destination emits nothing", () => {
    expect(buildWallBrief("t", "", [], false, "", [], "")).toContain("copied to the repository root");
    expect(buildWallBrief("t")).not.toContain("copied to");
  });
  test("(c) a repoDir with a trailing slash still keeps the run's own absolute Wall path", () => {
    expect(withoutStaleWall(["src/loki_wall_new.test.ts", "src/loki_wall_old.test.ts", "src/a.ts"], ["/r/repo/src/loki_wall_new.test.ts"], "/r/repo/")).toEqual(["src/loki_wall_new.test.ts", "src/a.ts"]);
  });
  test("(c) the test map and risk ignore a stale loki_wall_* test that imports a changed source (review repro)", async () => {
    const repoDir = mk();
    for (const [n, c] of Object.entries({ "src/ws.ts": "export const w = 1;\n", "bunfig.toml": "[test]\n", "src/real.test.ts": "import { test } from 'bun:test';\ntest('r', () => {});\n", ".gitignore": ".loki\n" })) { mkdirSync(join(repoDir, n, ".."), { recursive: true }); writeFileSync(join(repoDir, n), c); }
    git(repoDir, ["init", "-q"]); git(repoDir, ["add", "."]); git(repoDir, ["commit", "-qm", "base"]);
    writeFileSync(join(repoDir, "src", "loki_wall_old.test.ts"), "import { test, expect } from 'bun:test';\nimport { w } from './ws';\ntest('x', () => { expect(w).toBe(2); });\n");
    writeFileSync(join(repoDir, "src", "ws.ts"), "export const w = 2;\n");
    const ctx = wallCtx(repoDir, () => {}); ctx.baseSha = git(repoDir, ["rev-parse", "HEAD"]).trim();
    const real = new RealTestMapProvider(); ctx.tests = { detect: (d: string) => real.detect(d), impacted: (m, c) => real.impacted(m, c) };
    ctx.outputs = () => ({ wall: { files: [], discarded: [{ file: "loki_wall_old.test.ts", reason: "x" }] } }) as Partial<Record<StageName, Record<string, unknown>>>;
    const r = await verifyStage.run(ctx, new AbortController().signal);
    expect(JSON.stringify(r.data.checks)).not.toContain("loki_wall_old");
    expect(r.data.changed_files).toEqual(["src/ws.ts"]);
  }, 60_000);
});

describe("FC-VERIFY-REDETECTS-WALL-RUNNER verify runs the runner the Wall recorded", () => {
  const hasPy = !!Bun.which("python3");
  async function pyRun() {
    const repoDir = mk();
    for (const [n, c] of Object.entries({ "app/m.py": "def f():\n    return 1\n", ".gitignore": ".loki\n" })) { mkdirSync(join(repoDir, n.includes("/") ? n.slice(0, n.lastIndexOf("/")) : "."), { recursive: true }); writeFileSync(join(repoDir, n), c); }
    git(repoDir, ["init", "-q"]); git(repoDir, ["add", "."]); git(repoDir, ["commit", "-qm", "base"]);
    // The Wall sealed a unittest file against the intake map (no runner); implement then adds app/test_m.py, so a fresh detect now reports pytest.
    mkdirSync(join(repoDir, "tests"), { recursive: true });
    writeFileSync(join(repoDir, "tests", "loki_wall_m.py"), "import unittest\nfrom app.m import f\n\nclass T(unittest.TestCase):\n    def test_f(self):\n        self.assertEqual(f(), 1)\n");
    writeFileSync(join(repoDir, "app", "test_m.py"), "def test_f():\n    assert True\n");
    const ctx = wallCtx(repoDir, () => {}); ctx.baseSha = git(repoDir, ["rev-parse", "HEAD"]).trim(); ctx.tests = new RealTestMapProvider();
    const f = { path: join(repoDir, "tests", "loki_wall_m.py"), runner: "unittest" };
    ctx.outputs = () => ({ intake: { task: "add f", repomap_ref: join(repoDir, ".loki", "runs", "e10-fc23", "repomap.json") }, wall: { files: [f] } }) as Partial<Record<StageName, Record<string, unknown>>>;
    const r = await verifyStage.run(ctx, new AbortController().signal);
    return (r.data.checks as { name: string; cmd: string; result: string }[]).find((c) => c.name.includes("loki_wall_m"));
  }
  test.skipIf(!hasPy)("a python repo with no .venv: the sealed file runs under unittest and does not read not_run", async () => {
    const c = await pyRun();
    expect(c?.name).toBe("unittest:tests/loki_wall_m.py");
    expect(c?.result).toBe("pass");
  }, 60_000);
});
