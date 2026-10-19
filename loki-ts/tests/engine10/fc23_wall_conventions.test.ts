// FC-23: the Wall matches the package's module system, and a type error inside a Wall file is harness-owned (no fix round).
// FireLater#17 on 10.10.5: a Wall test with import.meta failed the package's own tsc (TS1470) and burned fix round 1.
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWall, buildWallBrief, WALL_OUTPUT_BUDGET, WALL_REPO_PATHS } from "../../src/engine10/stages/wall.ts";
import { verifyStage } from "../../src/engine10/stages/verify.ts";
import { conventionViolation, conventionsBrief, outOfRepoTarget, phantomReason, phantomRepoPaths, readPackageConventions } from "../../src/project_model/conventions.ts";
import { wallOwnedFailure } from "../../src/util/wall_owned.ts";
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
});

// Header and helpers of the Wall file loki 11.17.77 wrote for anthropics/claude-code#81826 (run e10-20261019T064138Z-a7ca; base tree ef7bfdc has no plugins/ralph-loop).
const REAL_81826 = 'import { test, expect } from \'bun:test\';\\nimport { spawnSync } from \'node:child_process\';\\nimport { mkdtempSync, existsSync, readFileSync, writeFileSync } from \'node:fs\';\\nimport { tmpdir } from \'node:os\';\\nimport { join } from \'node:path\';\\n\\nconst ROOT = process.env.REPO_ROOT ?? process.cwd();\\nconst PLUGIN = join(ROOT, \'plugins\', \'ralph-loop\');\\nconst SETUP = join(PLUGIN, \'scripts\', \'setup-ralph-loop.sh\');\\nconst HOOK = join(PLUGIN, \'hooks\', \'stop-hook.sh\');\\nconst STATE = join(\'.claude\', \'ralph-loop.local.md\');\\n\\nconst env: Record<string, string> = { ...(process.env as Record<string, string>) };\\ndelete env.CLAUDE_CODE_SESSION_ID;\\n\\nfunction freshDir(): string {\\n  const dir = mkdtempSync(join(tmpdir(), \'loki-wall-ralph-\'));\\n  writeFileSync(join(dir, \'t.jsonl\'),\\n    \'{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"still working"}]}}\\\n\');\\n  return dir;\\n}\\n\\nfunction setup(dir: string, value: string) {\\n  return spawnSync(\'bash\', [SETUP, \'do\', \'the\', \'task\', \'--max-iterations\', value],\\n    { cwd: dir, env, encoding: \'utf8\' });\\n}\\n\\nfunction hook(dir: string) {\\n  return spawnSync(\'bash\', [HOOK], {\\n    cwd: dir,\\n    env,\\n    encoding: \'utf8\',\\n    input: JSON.stringify({ session_id: \'s1\', transcript_path: join(dir, \'t.jsonl\') }),\\n  });\\n}\\n\\nfunction stateExists(dir: string): boolean {\\n  return existsSync(join(dir, STATE));\\n}\\n\\nfunction rounds(dir: string, n: number): void {\\n  for (let i = 0; i < n; i++) {\\n    if (!stateExists(dir)) break;\\n    hook(dir);\\n  }';
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
    const repo = repoWith(), td = join(repo, "tests");
    expect(phantomRepoPaths("writeFileSync(join(__dirname, '..', 'out', 'x.txt'), 'a');", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("expect(existsSync(join(__dirname, '..', 'gone'))).toBe(false);", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const f = join(__dirname, 'fixtures', 'a.json');", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const f = join(__dirname, '..', 'node_modules', 'x');", "a.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths(PHANTOM, "a.py", td, repo, null)).toEqual([]);
  });
  test("monorepo: process.cwd() paths resolve against the nearest package root of the test file and the repo root", () => {
    const repo = repoWith(); mkdirSync(join(repo, "packages/a/test"), { recursive: true }); mkdirSync(join(repo, "packages/a/src"), { recursive: true });
    writeFileSync(join(repo, "packages/a/package.json"), "{}"); writeFileSync(join(repo, "packages/a/src/x.ts"), "x\n");
    const td = join(repo, "packages/a/test"), code = "const f = join(process.cwd(), 'src', 'x.ts');";
    expect(phantomRepoPaths(code, "x.test.ts", td, repo, null)).toEqual([]);
    expect(phantomRepoPaths("const f = join(process.cwd(), 'plugins', 'ralph-wiggum');", "x.test.ts", td, repo, null)).toEqual([]); // exists under the repo root
    expect(phantomRepoPaths("const f = join(process.cwd(), 'src', 'nope.ts');", "x.test.ts", td, repo, null)).toHaveLength(1);
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
  test("a plan clears a path only when it names the path with its parent, never a bare segment or basename", () => {
    const repo = repoWith(), td = join(repo, "tests"), code = "const f = join(__dirname, '..', 'src', 'newmod', 'index.ts');";
    expect(phantomRepoPaths(code, "a.test.ts", td, repo, null)).toEqual(["src/newmod/index.ts"]);
    expect(phantomRepoPaths(code, "a.test.ts", td, repo, "Introduce src/newmod with an entry point")).toEqual([]);
    expect(phantomRepoPaths(code, "a.test.ts", td, repo, "Introduce a newmod module with an entry point")).toEqual(["src/newmod/index.ts"]);
    for (const plan of ["Fix the ralph-loop plugin's setup script", "ralph-loop: --max-iterations 08 must be decimal", "Edit setup-ralph-loop.sh under plugins/ralph-wiggum/"]) expect(phantomRepoPaths(PHANTOM, "a.test.ts", td, repo, plan)).toContain("plugins/ralph-loop");
  });
  test("monorepo: a call that exists under the repo root does not shift the pairing of a later phantom", () => {
    const repo = repoWith(); mkdirSync(join(repo, "packages/a/test"), { recursive: true }); mkdirSync(join(repo, "test/helpers"), { recursive: true });
    writeFileSync(join(repo, "packages/a/package.json"), "{}");
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
  test("same-name hint works for a missing directory", () => {
    const why = phantomReason(["plugins/ralph-loop"], ["some/other/ralph-loop/run.sh", "x/y.ts"]);
    expect(why).toContain("plugins/ralph-loop (a path named ralph-loop exists at some/other/ralph-loop)");
    expect(phantomReason([], [])).toBeNull();
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
